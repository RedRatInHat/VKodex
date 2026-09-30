import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { StockAddNotWritten } from "../codex/native-stock-admission.js";
import { ManagedNativeQueueRefusal } from "./managed-native-stock-queue-adapter.js";
import { DesktopRequestRejectedError, DesktopUnavailableError, UncertainActionError } from "./contracts.js";

export type IpcObject = Record<string, unknown>;
// Match the desktop IPC limit: a task snapshot includes its full loaded history.
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

function validateFrameSize(size: number): void {
  if (size === 0) throw new DesktopUnavailableError("Codex прислал некорректный размер пакета состояния.");
  if (size > MAX_FRAME_BYTES) throw new DesktopUnavailableError("Пакет состояния Codex превышает лимит подключения 256 МиБ.");
}

export function isObject(value: unknown): value is IpcObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class FrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;

  push(chunk: Buffer): IpcObject[] {
    const messages: IpcObject[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const bytes = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + bytes);
        this.headerBytes += bytes; offset += bytes;
        if (this.headerBytes < 4) break;
        const size = this.header.readUInt32LE(0);
        validateFrameSize(size);
        this.headerBytes = 0;
        // Copy each byte once, instead of repeatedly concatenating the entire
        // snapshot whenever the pipe supplies another small chunk.
        this.payload = Buffer.allocUnsafe(size);
      }
      const payload = this.payload;
      const bytes = Math.min(payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(payload, this.payloadBytes, offset, offset + bytes);
      this.payloadBytes += bytes; offset += bytes;
      if (this.payloadBytes < payload.length) break;
      this.payload = null; this.payloadBytes = 0;
      const parsed: unknown = JSON.parse(payload.toString("utf8"));
      if (!isObject(parsed)) throw new Error("Invalid IPC frame");
      messages.push(parsed);
    }
    return messages;
  }
}

export function encodeFrame(message: IpcObject): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  validateFrameSize(payload.length);
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length);
  payload.copy(frame, 4);
  return frame;
}

interface PendingRequest {
  readonly method: string;
  readonly targetClientId?: string;
  readonly resolve: (value: IpcObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly mutating: boolean;
}

export interface IpcRequestOptions {
  readonly targetClientId?: string;
  readonly mutating?: boolean;
  readonly timeoutMs?: number;
}

export interface IpcIncomingRequest {
  readonly requestId: string;
  readonly sourceClientId: string;
  readonly hostId?: string;
  readonly method: string;
  readonly version: number;
  readonly params: IpcObject;
}

/** Opaque routing identity for one live IPC connection. It is neither an
 * authentication credential nor proof that this client owns a task. */
export interface DesktopIpcConnectionIdentity {
  readonly clientId: string;
  readonly connectionEpoch: number;
}

/** Explicit opt-in for a native owner endpoint. Scope/version checks belong to
 * canHandle and are repeated on dispatch; discovery alone never grants access.
 * Mutating handlers must reconcile operations in their own durable ledger.
 * The signal cancels this connection's response delivery, not a Codex turn:
 * handlers must not interrupt accepted work merely because the UI detached.
 * sourceClientId is routing data supplied by the broker, not an authenticated
 * identity. Host/task/owner-epoch authorization belongs to the handler. */
export interface IpcRequestHandler {
  canHandle(request: IpcIncomingRequest): boolean;
  handle(request: IpcIncomingRequest, signal: AbortSignal): Promise<IpcObject>;
  /** Fixed diagnostic category only; never receives an exception or request data. */
  onRequestFailure?(category: IpcRequestFailureCategory): void;
  /** Content-free first Composer ingress diagnostics. This is observation only:
   * it grants no route and cannot turn a refusal into an accepted write. */
  onComposerIngress?(method: IpcComposerIngressMethod, outcome: IpcComposerIngressOutcome): void;
}

export type IpcComposerIngressMethod = 'thread-follower-start-turn' |
  'thread-follower-set-queued-follow-ups-state';
export type IpcComposerIngressOutcome = 'seen' | 'handled' | 'refused';

export type IpcRequestFailureCategory = 'owner-refused' | 'queue-gate-refused' |
  'queue-shape-refused' | 'queue-baseline-refused' |
  'settings-refused' | 'queue-state-refused' | 'entry-refused' |
  'worker-not-written' | 'unclassified';

/** Compare only exact internal literals. Arbitrary exception text is neither
 * logged nor forwarded over IPC, even when an exception carries private data. */
function incomingFailureCategory(error: unknown): IpcRequestFailureCategory {
  if (error instanceof StockAddNotWritten) return 'worker-not-written';
  if (error instanceof ManagedNativeQueueRefusal) {
    switch (error.code) {
      case 'request-shape': return 'queue-shape-refused';
      case 'baseline': return 'queue-baseline-refused';
      case 'owner-fence': return 'owner-refused';
      default: return 'queue-gate-refused';
    }
  }
  if (!(error instanceof Error)) return 'unclassified';
  switch (error.message) {
    case 'Native owner route unavailable':
    case 'Native repeated admission refused: owner not confirmed':
    case 'Native repeated admission refused: owner source changed':
    case 'Native repeated admission refused: owner epoch mismatch':
    case 'Native repeated admission refused: request ingress changed':
      return 'owner-refused';
    case 'Managed native stock queue request refused':
      return 'queue-gate-refused';
    case 'Native repeated admission refused: effective settings changed':
    case 'Native repeated admission refused: in-flight effective settings changed':
    case 'Native repeated admission refused: post-reserve effective settings changed':
    case 'Native repeated admission refused: unconfirmed homogeneous qualification':
      return 'settings-refused';
    case 'Native repeated admission refused: non-JSON qualification or native entry':
    case 'Native repeated admission refused: native entry preparation incomplete':
      return 'entry-refused';
    case 'Native repeated admission refused: pending snapshot changed':
    case 'Native repeated admission refused: identity snapshot changed':
    case 'Native repeated admission refused: classification snapshot changed':
    case 'Native repeated admission refused: another stock add is unresolved':
    case 'Native repeated admission refused: dispatch fence changed':
      return 'queue-state-refused';
    default:
      return 'unclassified';
  }
}

function incomingRequest(value: unknown): IpcIncomingRequest | null {
  if (!isObject(value) || value.type !== "request" || typeof value.requestId !== "string" || !value.requestId
    || typeof value.sourceClientId !== "string" || !value.sourceClientId
    || (value.hostId !== undefined && (typeof value.hostId !== "string" || !value.hostId))
    || typeof value.method !== "string" || !value.method || !Number.isSafeInteger(value.version)
    || (value.version as number) < 0 || !isObject(value.params)) return null;
  return { requestId: value.requestId, sourceClientId: value.sourceClientId,
    ...(typeof value.hostId === "string" ? { hostId: value.hostId } : {}),
    method: value.method, version: value.version as number, params: value.params };
}

export class DesktopIpcClient {
  private stream: Duplex | null = null;
  private clientId: string | null = null;
  private connectionEpoch = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(message: IpcObject) => void>();
  private readonly disconnectListeners = new Set<(error: DesktopUnavailableError) => void>();
  private connecting: Promise<void> | null = null;
  private incomingAbort = new AbortController();

  constructor(
    private readonly connectStream: () => Duplex = () => createConnection("\\\\.\\pipe\\codex-ipc"),
    private readonly requestTimeoutMs = 5_000,
    private readonly requestHandler: IpcRequestHandler | null = null,
  ) {}

  async connect(): Promise<void> {
    if (this.clientId) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  /** Snapshot-only identity for the currently connected broker session.
   * Reconnecting increments the epoch even if the broker happens to reuse an ID. */
  get connectionIdentity(): Readonly<DesktopIpcConnectionIdentity> | null {
    return this.clientId === null || this.stream === null || this.stream.destroyed ? null : Object.freeze({ clientId: this.clientId,
      connectionEpoch: this.connectionEpoch });
  }

  private async initialize(): Promise<void> {
    const stream = this.connectStream();
    this.stream = stream;
    this.incomingAbort = new AbortController();
    const decoder = new FrameDecoder();
    stream.on("data", (chunk: Buffer) => {
      if (this.stream !== stream) return;
      try { for (const message of decoder.push(chunk)) this.receive(message); }
      catch (error) {
        // JSON parser errors can quote private task content. Expose only our
        // own fixed diagnostics, never the raw parser or socket exception.
        this.close(error instanceof DesktopUnavailableError ? error : new DesktopUnavailableError("Не удалось прочитать состояние Codex: несовместимый или повреждённый пакет IPC."));
      }
    });
    stream.once("error", () => { if (this.stream === stream) this.close(); });
    stream.once("close", () => this.disconnected(stream));
    try {
      const reply = await this.request("initialize", 0, { clientType: "vkodex" });
      if (this.stream !== stream || stream.destroyed) throw new DesktopUnavailableError();
      if (!isObject(reply.result) || typeof reply.result.clientId !== "string" || !reply.result.clientId) {
        throw new DesktopUnavailableError("Десктоп вернул несовместимый ответ подключения.");
      }
      this.clientId = reply.result.clientId;
      this.connectionEpoch++;
    } catch (error) {
      if (this.stream === stream) this.close();
      throw error;
    }
  }

  onBroadcast(listener: (message: IpcObject) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onDisconnect(listener: (error: DesktopUnavailableError) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }

  request(method: string, version: number, params: IpcObject, options: IpcRequestOptions = {}): Promise<IpcObject> {
    if (!this.stream || (method !== "initialize" && !this.clientId)) {
      return Promise.reject(new DesktopUnavailableError());
    }
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(options.mutating ? new UncertainActionError() : new DesktopUnavailableError("Десктоп не ответил вовремя."));
      }, timeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timer, mutating: options.mutating ?? false,
        ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}) });
      try {
        this.write({
          type: "request", requestId, method, version, params, timeoutMs,
          sourceClientId: this.clientId ?? "initializing-client",
          ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}),
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(options.mutating ? new UncertainActionError() : new DesktopUnavailableError());
      }
    });
  }

  broadcast(method: string, version: number, params: IpcObject, targetClientId: string): void {
    if (!this.clientId) throw new DesktopUnavailableError();
    this.write({ type: "broadcast", method, version, params, sourceClientId: this.clientId, targetClientIds: [targetClientId] });
  }

  private write(message: IpcObject): void {
    if (!this.stream || this.stream.destroyed) throw new DesktopUnavailableError();
    this.stream.write(encodeFrame(message));
  }

  private receive(message: IpcObject): void {
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      const request = incomingRequest(message.request);
      this.write({ type: "client-discovery-response", requestId: message.requestId,
        response: { canHandle: request !== null && this.acceptsIncoming(request) } });
      return;
    }
    if (message.type === "request" && typeof message.requestId === "string") {
      void this.handleIncoming(message);
      return;
    }
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      // A successful targeted reply must come from the addressed owner. Do not
      // consume the pending request: its real reply may still arrive. Otherwise
      // the existing deadline reports an unknown write, without retrying it or
      // closing the shared pipe. This checks routing, not actor authentication.
      if (message.resultType === "success" && pending.targetClientId !== undefined
        && message.handledByClientId !== pending.targetClientId) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.resultType === "success") pending.resolve(message);
      else if (message.error === "request-version-mismatch") pending.reject(new DesktopRequestRejectedError("request-version-mismatch"));
      else if (message.error === "no-client-found" && pending.method === "thread-follower-update-thread-settings") pending.reject(new DesktopRequestRejectedError("no-client-found"));
      // Internal protocol errors are not a reliable proof that a write did not happen.
      else pending.reject(pending.mutating ? new UncertainActionError()
        : new DesktopRequestRejectedError(message.error === "no-client-found" ? "no-client-found" : "request-rejected"));
      return;
    }
    const targets = message.targetClientIds;
    // The native router leaves the first open/follow broadcast untargeted.
    const addressedHere = targets === undefined || targets === null
      || (Array.isArray(targets) && targets.every(target => typeof target === "string" && target.length > 0) && targets.includes(this.clientId));
    if (message.type === "broadcast" && addressedHere) {
      for (const listener of this.listeners) {
        try { listener(message); } catch { /* One consumer must not close the shared broker connection. */ }
      }
    }
  }

  private acceptsIncoming(request: IpcIncomingRequest): boolean {
    if (!this.clientId || !this.requestHandler) return false;
    try { return this.requestHandler.canHandle(request) === true; }
    catch { return false; }
  }

  private async handleIncoming(message: IpcObject): Promise<void> {
    const stream = this.stream; const clientId = this.clientId;
    const signal = this.incomingAbort.signal;
    const request = incomingRequest(message);
    const targetMatches = message.targetClientId === undefined || message.targetClientId === clientId;
    const composerMethod: IpcComposerIngressMethod | null = request && targetMatches &&
      (request.method === 'thread-follower-start-turn' ||
        request.method === 'thread-follower-set-queued-follow-ups-state') ? request.method : null;
    const observeComposer = (outcome: IpcComposerIngressOutcome) => {
      if (!composerMethod) return;
      try { this.requestHandler?.onComposerIngress?.(composerMethod, outcome); }
      catch { /* Observation must never change native IPC routing. */ }
    };
    observeComposer('seen');
    let composerHandled = false;
    let response: IpcObject = { type: "response", requestId: message.requestId,
      resultType: "error", error: "no-handler-for-request" };
    try {
      if (request && targetMatches && this.acceptsIncoming(request) && this.requestHandler) {
        const result = await this.requestHandler.handle(request, signal);
        if (!isObject(result)) throw new Error("Invalid owner response");
        composerHandled = true;
        response = { type: "response", requestId: request.requestId, resultType: "success",
          method: request.method, handledByClientId: clientId, result };
      }
    } catch (error) {
      // Never forward raw backend errors: these can contain private task text.
      try { this.requestHandler?.onRequestFailure?.(incomingFailureCategory(error)); }
      catch { /* Diagnostics must not alter the generic IPC refusal. */ }
      response = { type: "response", requestId: message.requestId, resultType: "error", error: "error-handling-request" };
    }
    observeComposer(composerHandled ? 'handled' : 'refused');
    // A result from the old owner session must never reach a replacement pipe.
    if (signal.aborted || this.stream !== stream || this.clientId !== clientId || !clientId) return;
    try { this.write(response); } catch { /* The requester will reconcile its unknown outcome. */ }
  }

  close(error = new DesktopUnavailableError()): void {
    const stream = this.stream;
    if (!stream) return;
    this.disconnected(stream, error);
    stream.destroy();
  }

  private disconnected(stream: Duplex, error = new DesktopUnavailableError()): void {
    if (this.stream !== stream) return;
    const incomingAbort = this.incomingAbort;
    const pending = [...this.pending.values()];
    const listeners = [...this.disconnectListeners];
    // Abort handlers run synchronously and may reconnect. Retire the old
    // session before notifying them; its cleanup must not clear a new
    // connection's initialization request or expose a closing writer.
    this.stream = null;
    this.clientId = null;
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(request.mutating ? new UncertainActionError() : error);
    }
    incomingAbort.abort();
    for (const listener of listeners) {
      try { listener(error); } catch { /* Other consumers still need their disconnect notification. */ }
    }
  }
}
