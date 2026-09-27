import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { closeAppServer } from "./app-server-process.js";

type JsonObject = Record<string, unknown>;

export class AppServerUnavailableError extends Error {
  constructor(message = "Codex App Server недоступен.") { super(message); this.name = "AppServerUnavailableError"; }
}

export class AppServerRejectedError extends Error {
  constructor(readonly code: number | string | null = null,
    readonly reason: "active-writer" | null = null) {
    super("Codex App Server отклонил запрос."); this.name = "AppServerRejectedError";
  }
}

export class AppServerUncertainError extends Error {
  constructor() { super("Результат операции Codex неизвестен."); this.name = "AppServerUncertainError"; }
}

/** Explicit native frontend denial. Ordinary handler failures keep the generic
 * protocol error; only this validated type preserves a frontend error body. */
export class AppServerFrontendResponseError extends Error {
  readonly #nativeError: JsonObject;

  constructor(error: JsonObject) {
    super("Native frontend rejected a server request.");
    this.name = "AppServerFrontendResponseError";
    if (error === null || typeof error !== "object" || Array.isArray(error) ||
      !Object.hasOwn(error, "code") || !Number.isSafeInteger(error.code) ||
      !Object.hasOwn(error, "message") || typeof error.message !== "string" ||
      Object.keys(error).some(key => key !== "code" && key !== "message" && key !== "data"))
      throw new TypeError("Invalid native frontend error");
    let decoded: unknown;
    try {
      const copy = structuredClone(error);
      const encoded = JSON.stringify(copy, (_key, item: unknown) => {
        if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
          typeof item === "bigint" || typeof item === "number" && !Number.isFinite(item))
          throw new TypeError("Non-JSON native frontend error");
        return item;
      });
      decoded = JSON.parse(encoded);
    } catch { throw new TypeError("Invalid native frontend error"); }
    if (!isDeepStrictEqual(error, decoded)) throw new TypeError("Invalid native frontend error");
    this.#nativeError = decoded as JsonObject;
  }

  get wireError(): JsonObject { return structuredClone(this.#nativeError); }
}

/** ID-free native response for an opt-in synchronous frontend wire writer. */
export type AppServerResponseEnvelope = Readonly<{ result: JsonObject }> | Readonly<{ error: JsonObject }>;

export interface AppServerRequestOptions {
  /** A dispatched mutation must never be replayed after timeout or disconnect. */
  readonly mutating?: boolean;
  readonly timeoutMs?: number;
  /** Refuse to launch or dispatch on a different initialized connection. */
  readonly expectedGeneration?: number;
  /** Called before the next inbound frame; never await or log native error details. */
  readonly onResponseEnvelope?: (envelope: AppServerResponseEnvelope) => void;
}

export interface AppServerEnvelope {
  readonly method: string;
  readonly params: JsonObject;
}

/** Actual backend handshake for one process/connection generation. This is not
 * a frontend compatibility decision or authorization to send native commands. */
export interface AppServerInitializedSession {
  readonly generation: number;
  readonly initializeResult: JsonObject;
}

export interface AppServerServerRequest extends AppServerEnvelope {
  /** Original worker request identity; numeric and string IDs are distinct. */
  readonly id: string | number;
}

export interface AppServerServerRequestContext {
  /** Cancelled when this pending request loses its live connection or conflicts. */
  readonly signal: AbortSignal;
  /** Result bytes queued locally on this connection, NOT worker acceptance. */
  readonly responseWritten: Promise<void>;
}

export type AppServerServerRequestHandler = (request: AppServerServerRequest,
  context: AppServerServerRequestContext) => Promise<JsonObject> | JsonObject;

export interface AppServerRpc {
  start(): Promise<void>;
  request(method: string, params?: JsonObject, options?: AppServerRequestOptions): Promise<JsonObject>;
  onNotification(listener: (notification: AppServerEnvelope) => void): () => void;
  onDisconnect?(listener: (error: Error) => void): () => void;
  onServerRequest(handler: AppServerServerRequestHandler | null): void;
  close(): Promise<void>;
}

interface PendingRequest {
  readonly mutating: boolean;
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onResponseEnvelope: ((envelope: AppServerResponseEnvelope) => void) | undefined;
}

interface PendingServerRequest {
  readonly request: AppServerEnvelope;
  readonly controller: AbortController;
  readonly rejectWritten: (error: Error) => void;
  invalidated: boolean;
}

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** One restartable JSONL App Server connection owned by a single Codex profile. */
export class AppServerConnection implements AppServerRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private generation = 0;
  private initialized: AppServerInitializedSession | null = null;
  private nextId = 1;
  private fragments: string[] = [];
  private fragmentBytes = 0;
  private starting: Promise<void> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingServerRequests = new Map<string | number, PendingServerRequest>();
  private readonly notificationListeners = new Set<(notification: AppServerEnvelope) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private serverRequestHandler: AppServerServerRequestHandler | null = null;

  constructor(private readonly launch: () => ChildProcessWithoutNullStreams,
    private readonly initializeParams: JsonObject = {
      clientInfo: { name: "vkodex", title: "VKodex", version: "0.1.0" }, capabilities: { experimentalApi: true },
    }, private readonly defaultTimeoutMs = 30_000) {}

  onNotification(listener: (notification: AppServerEnvelope) => void): () => void {
    this.notificationListeners.add(listener);
    return () => { this.notificationListeners.delete(listener); };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }

  onServerRequest(handler: AppServerServerRequestHandler | null): void { this.serverRequestHandler = handler; }

  /** Share the real handshake instead of reinitializing an already-live worker.
   * Callers must qualify frontend capabilities separately and fence subsequent
   * work with isSessionCurrent; a receipt is not a durable worker identity. */
  async initializedSession(): Promise<AppServerInitializedSession> {
    await this.start();
    const session = this.initialized;
    if (!session || !this.isSessionCurrent(session.generation)) throw new AppServerUnavailableError();
    return structuredClone(session);
  }

  isSessionCurrent(generation: number): boolean {
    return !this.stopped && this.child !== null && this.generation === generation
      && this.initialized?.generation === generation;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new AppServerUnavailableError("Подключение Codex App Server уже остановлено.");
    // open() installs the child before initialize has been acknowledged. Every
    // concurrent caller must join that handshake, including its rejection,
    // rather than dispatching a command onto a merely spawned process.
    if (this.starting) return this.starting;
    if (this.child) return;
    const work = this.open();
    this.starting = work;
    try { await work; } finally { if (this.starting === work) this.starting = null; }
  }

  async request(method: string, params: JsonObject = {}, options: AppServerRequestOptions = {}): Promise<JsonObject> {
    if (!method || /[\x00-\x20]/u.test(method)) throw new AppServerRejectedError();
    if (options.expectedGeneration !== undefined && !this.isSessionCurrent(options.expectedGeneration))
      throw new AppServerUnavailableError();
    await this.start();
    return this.sendRequest(method, params, options);
  }

  private async open(): Promise<void> {
    await this.closing;
    if (this.stopped) throw new AppServerUnavailableError("Подключение Codex App Server уже остановлено.");
    let child: ChildProcessWithoutNullStreams;
    try { child = this.launch(); } catch { throw new AppServerUnavailableError(); }
    const generation = ++this.generation;
    this.child = child; this.fragments = []; this.fragmentBytes = 0; this.nextId = 1;
    child.stdout.setEncoding("utf8"); child.stderr.resume();
    child.stdout.on("data", (chunk: string) => this.receive(child, generation, chunk));
    const failed = () => this.connectionFailed(child, generation);
    child.once("error", failed); child.once("close", failed); child.stdin.once("error", failed);
    try {
      const initializeResult = await this.sendRequest("initialize", this.initializeParams, { timeoutMs: this.defaultTimeoutMs });
      if (this.child !== child || generation !== this.generation) throw new AppServerUnavailableError();
      this.write(child, { method: "initialized", params: {} });
      if (this.child !== child || generation !== this.generation) throw new AppServerUnavailableError();
      this.initialized = { generation, initializeResult };
    } catch (error) {
      this.failConnection(child, generation, error instanceof Error ? error : new AppServerUnavailableError());
      throw error;
    }
  }

  private sendRequest(method: string, params: JsonObject, options: AppServerRequestOptions): Promise<JsonObject> {
    if (options.expectedGeneration !== undefined && !this.isSessionCurrent(options.expectedGeneration))
      return Promise.reject(new AppServerUnavailableError());
    const child = this.child;
    if (!child) return Promise.reject(new AppServerUnavailableError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = pending.mutating ? new AppServerUncertainError() : new AppServerUnavailableError("Codex App Server не ответил вовремя.");
        pending.reject(error);
        // A timeout describes this operation, not the health of the writer.
        // A mutation may already be running: keep its notifications and other
        // tasks alive, and let the caller reconcile the uncertain outcome.
        // A late response for this retired request is ignored by acceptResponse.
      }, options.timeoutMs ?? this.defaultTimeoutMs);
      timer.unref();
      this.pending.set(id, { mutating: options.mutating === true, resolve, reject, timer,
        onResponseEnvelope: options.onResponseEnvelope });
      try { this.write(child, { id, method, params }); }
      catch {
        clearTimeout(timer); this.pending.delete(id);
        reject(options.mutating ? new AppServerUncertainError() : new AppServerUnavailableError());
        this.failConnection(child, this.generation, new AppServerUnavailableError(), id);
      }
    });
  }

  private write(child: ChildProcessWithoutNullStreams, value: JsonObject): void {
    if (this.child !== child || child.stdin.destroyed || child.stdin.writableEnded || !child.stdin.writable) throw new AppServerUnavailableError();
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(child: ChildProcessWithoutNullStreams, generation: number, chunk: string): void {
    if (this.child !== child || this.generation !== generation) return;
    let start = 0;
    while (start < chunk.length && this.child === child && this.generation === generation) {
      const end = chunk.indexOf("\n", start);
      const fragment = chunk.slice(start, end < 0 ? undefined : end);
      this.fragmentBytes += Buffer.byteLength(fragment, "utf8");
      if (this.fragmentBytes > MAX_BUFFER_BYTES) {
        this.failConnection(child, generation, new AppServerUnavailableError("Codex App Server прислал слишком большой пакет.")); return;
      }
      if (fragment) this.fragments.push(fragment);
      if (end < 0) return;
      const line = this.fragments.join("");
      this.fragments = []; this.fragmentBytes = 0; start = end + 1;
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch {
        this.failConnection(child, generation, new AppServerUnavailableError("Codex App Server нарушил формат протокола.")); return;
      }
      if (!isObject(value)) continue;
      if ((typeof value.id === "number") && (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))) {
        this.acceptResponse(value.id, value); continue;
      }
      if (typeof value.method !== "string" || !isObject(value.params)) continue;
      if (value.id !== undefined && (typeof value.id === "number" || typeof value.id === "string")) {
        void this.acceptServerRequest(child, generation, value.id, { method: value.method, params: value.params });
      } else {
        const notification = { method: value.method, params: value.params };
        // Resolution may come from auto-resolution or another native actor.
        // Retire the exact pending callback before observers can submit a stale
        // answer. This is cancellation, never a positive response-write receipt.
        if (value.method === "serverRequest/resolved" && typeof value.params.threadId === "string"
          && (typeof value.params.requestId === "string" || typeof value.params.requestId === "number")) {
          const id = value.params.requestId;
          const pending = this.pendingServerRequests.get(id);
          if (pending?.request.params.threadId === value.params.threadId) {
            this.pendingServerRequests.delete(id);
            this.invalidateServerRequest(pending);
          }
        }
        for (const listener of this.notificationListeners) {
          try { listener(notification); } catch { /* One observer cannot break the profile connection. */ }
        }
      }
    }
  }

  private acceptResponse(id: number, value: JsonObject): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    const deliver = (envelope: AppServerResponseEnvelope): void => {
      if (!pending.onResponseEnvelope) return;
      try { pending.onResponseEnvelope(structuredClone(envelope)); }
      catch { /* A frontend writer cannot abort the shared worker. */ }
    };
    if (value.error !== undefined) {
      const error = isObject(value.error) ? value.error : {};
      if (isObject(value.error)) deliver({ error: value.error });
      const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : null;
      const reason = typeof error.message === "string" && /already has an active writer/iu.test(error.message)
        ? "active-writer" as const : null;
      pending.reject(new AppServerRejectedError(code, reason)); return;
    }
    if (!isObject(value.result)) { pending.reject(new AppServerUnavailableError("Codex App Server вернул некорректный ответ.")); return; }
    deliver({ result: value.result });
    pending.resolve(value.result);
  }

  private async acceptServerRequest(child: ChildProcessWithoutNullStreams, generation: number, id: string | number,
    request: AppServerEnvelope): Promise<void> {
    const previous = this.pendingServerRequests.get(id);
    if (previous) {
      // Resume can redeliver the same unresolved RPC. Do not replace a pending
      // question or execute an in-flight tool twice. Keep typed IDs distinct.
      if (!previous.invalidated && !isDeepStrictEqual(previous.request, request)) {
        this.invalidateServerRequest(previous);
        this.replyToServer(child, generation, { id, error: { code: -32600, message: "Conflicting pending server request" } });
      }
      return;
    }
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.replyToServer(child, generation, { id, error: { code: -32601, message: "Unsupported server request" } });
      return;
    }
    // The handler owns its argument; retain an independent comparison snapshot.
    const controller = new AbortController();
    let resolveWritten!: () => void;
    let rejectWritten!: (error: Error) => void;
    const responseWritten = new Promise<void>((resolve, reject) => { resolveWritten = resolve; rejectWritten = reject; });
    // Existing handlers need not observe this additive transport receipt.
    void responseWritten.catch(() => {});
    const pending: PendingServerRequest = { request: structuredClone(request), controller, rejectWritten, invalidated: false };
    this.pendingServerRequests.set(id, pending);
    const current = () => this.pendingServerRequests.get(id) === pending && !pending.invalidated;
    try {
      const result = await handler({ ...request, id }, { signal: controller.signal, responseWritten });
      if (current() && this.replyToServer(child, generation, { id, result })) resolveWritten();
      else this.invalidateServerRequest(pending);
    } catch (error) {
      if (current() && error instanceof AppServerFrontendResponseError &&
        this.replyToServer(child, generation, { id, error: error.wireError })) resolveWritten();
      else {
        if (current()) this.replyToServer(child, generation,
          { id, error: { code: -32000, message: "Server request rejected" } });
        this.invalidateServerRequest(pending);
      }
    } finally {
      if (this.pendingServerRequests.get(id) === pending) this.pendingServerRequests.delete(id);
    }
  }

  private invalidateServerRequest(pending: PendingServerRequest): void {
    pending.invalidated = true;
    const error = new AppServerUnavailableError();
    pending.rejectWritten(error);
    if (!pending.controller.signal.aborted) pending.controller.abort(error);
  }

  private clearServerRequests(): void {
    const requests = [...this.pendingServerRequests.values()];
    this.pendingServerRequests.clear();
    for (const pending of requests) this.invalidateServerRequest(pending);
  }

  private replyToServer(child: ChildProcessWithoutNullStreams, generation: number, reply: JsonObject): boolean {
    if (this.child !== child || this.generation !== generation) return false;
    try { this.write(child, reply); return this.child === child && this.generation === generation; }
    catch { this.connectionFailed(child, generation); return false; }
  }

  private connectionFailed(child: ChildProcessWithoutNullStreams, generation: number): void {
    this.failConnection(child, generation, new AppServerUnavailableError());
  }

  private failConnection(child: ChildProcessWithoutNullStreams, generation: number, fallback: Error, skipId?: number): void {
    if (this.child !== child || this.generation !== generation) return;
    this.child = null; this.initialized = null; this.fragments = []; this.fragmentBytes = 0;
    // Abort listeners can synchronously request a reconnect. Install the
    // teardown barrier before notifying them so open() cannot overtake it.
    this.closing = this.closing.then(() => closeAppServer(child)).catch(() => {});
    this.clearServerRequests();
    for (const [id, pending] of this.pending) {
      if (id === skipId) continue;
      this.pending.delete(id); clearTimeout(pending.timer);
      pending.reject(pending.mutating ? new AppServerUncertainError() : fallback);
    }
    for (const listener of this.disconnectListeners) {
      try { listener(fallback); } catch { /* One observer cannot break recovery. */ }
    }
  }

  async close(): Promise<void> {
    this.stopped = true; this.starting = null;
    const child = this.child; this.child = null; this.initialized = null;
    this.fragments = []; this.fragmentBytes = 0; this.generation++;
    this.clearServerRequests();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.mutating ? new AppServerUncertainError() : new AppServerUnavailableError());
    }
    this.pending.clear();
    await this.closing;
    if (child) await closeAppServer(child);
  }
}
