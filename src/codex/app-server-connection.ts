import type { ChildProcessWithoutNullStreams } from "node:child_process";
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

export interface AppServerRequestOptions {
  /** A dispatched mutation must never be replayed after timeout or disconnect. */
  readonly mutating?: boolean;
  readonly timeoutMs?: number;
}

export interface AppServerEnvelope {
  readonly method: string;
  readonly params: JsonObject;
}

export type AppServerServerRequestHandler = (request: AppServerEnvelope) => Promise<JsonObject> | JsonObject;

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
}

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** One restartable JSONL App Server connection owned by a single Codex profile. */
export class AppServerConnection implements AppServerRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private generation = 0;
  private nextId = 1;
  private fragments: string[] = [];
  private fragmentBytes = 0;
  private starting: Promise<void> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly pending = new Map<number, PendingRequest>();
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

  async start(): Promise<void> {
    if (this.stopped) throw new AppServerUnavailableError("Подключение Codex App Server уже остановлено.");
    if (this.child) return;
    if (this.starting) return this.starting;
    const work = this.open();
    this.starting = work;
    try { await work; } finally { if (this.starting === work) this.starting = null; }
  }

  async request(method: string, params: JsonObject = {}, options: AppServerRequestOptions = {}): Promise<JsonObject> {
    if (!method || /[\x00-\x20]/u.test(method)) throw new AppServerRejectedError();
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
      await this.sendRequest("initialize", this.initializeParams, { timeoutMs: this.defaultTimeoutMs });
      if (this.child !== child || generation !== this.generation) throw new AppServerUnavailableError();
      this.write(child, { method: "initialized", params: {} });
    } catch (error) {
      this.failConnection(child, generation, error instanceof Error ? error : new AppServerUnavailableError());
      throw error;
    }
  }

  private sendRequest(method: string, params: JsonObject, options: AppServerRequestOptions): Promise<JsonObject> {
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
      this.pending.set(id, { mutating: options.mutating === true, resolve, reject, timer });
      try { this.write(child, { id, method, params }); }
      catch {
        clearTimeout(timer); this.pending.delete(id);
        reject(options.mutating ? new AppServerUncertainError() : new AppServerUnavailableError());
        this.failConnection(child, this.generation, new AppServerUnavailableError(), id);
      }
    });
  }

  private write(child: ChildProcessWithoutNullStreams, value: JsonObject): void {
    if (this.child !== child || child.stdin.destroyed) throw new AppServerUnavailableError();
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
    if (value.error !== undefined) {
      const error = isObject(value.error) ? value.error : {};
      const code = typeof error.code === "number" || typeof error.code === "string" ? error.code : null;
      const reason = typeof error.message === "string" && /already has an active writer/iu.test(error.message)
        ? "active-writer" as const : null;
      pending.reject(new AppServerRejectedError(code, reason)); return;
    }
    if (!isObject(value.result)) { pending.reject(new AppServerUnavailableError("Codex App Server вернул некорректный ответ.")); return; }
    pending.resolve(value.result);
  }

  private async acceptServerRequest(child: ChildProcessWithoutNullStreams, generation: number, id: string | number,
    request: AppServerEnvelope): Promise<void> {
    if (!this.serverRequestHandler) {
      if (this.child === child && this.generation === generation) this.write(child, { id, error: { code: -32601, message: "Unsupported server request" } });
      return;
    }
    try {
      const result = await this.serverRequestHandler(request);
      if (this.child === child && this.generation === generation) this.write(child, { id, result });
    } catch {
      if (this.child === child && this.generation === generation) this.write(child, { id, error: { code: -32000, message: "Server request rejected" } });
    }
  }

  private connectionFailed(child: ChildProcessWithoutNullStreams, generation: number): void {
    this.failConnection(child, generation, new AppServerUnavailableError());
  }

  private failConnection(child: ChildProcessWithoutNullStreams, generation: number, fallback: Error, skipId?: number): void {
    if (this.child !== child || this.generation !== generation) return;
    this.child = null; this.fragments = []; this.fragmentBytes = 0;
    for (const [id, pending] of this.pending) {
      if (id === skipId) continue;
      this.pending.delete(id); clearTimeout(pending.timer);
      pending.reject(pending.mutating ? new AppServerUncertainError() : fallback);
    }
    this.closing = this.closing.then(() => closeAppServer(child)).catch(() => {});
    for (const listener of this.disconnectListeners) {
      try { listener(fallback); } catch { /* One observer cannot break recovery. */ }
    }
  }

  async close(): Promise<void> {
    this.stopped = true; this.starting = null;
    const child = this.child; this.child = null; this.fragments = []; this.fragmentBytes = 0; this.generation++;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.mutating ? new AppServerUncertainError() : new AppServerUnavailableError());
    }
    this.pending.clear();
    await this.closing;
    if (child) await closeAppServer(child);
  }
}
