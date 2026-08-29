import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { DesktopUnavailableError, UncertainActionError } from "./contracts.js";

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

export class DesktopIpcClient {
  private stream: Duplex | null = null;
  private clientId: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(message: IpcObject) => void>();
  private readonly disconnectListeners = new Set<(error: DesktopUnavailableError) => void>();
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly connectStream: () => Duplex = () => createConnection("\\\\.\\pipe\\codex-ipc"),
    private readonly requestTimeoutMs = 5_000,
  ) {}

  async connect(): Promise<void> {
    if (this.clientId) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  private async initialize(): Promise<void> {
    const stream = this.connectStream();
    this.stream = stream;
    const decoder = new FrameDecoder();
    stream.on("data", (chunk: Buffer) => {
      try { for (const message of decoder.push(chunk)) this.receive(message); }
      catch (error) {
        // JSON parser errors can quote private task content. Expose only our
        // own fixed diagnostics, never the raw parser or socket exception.
        this.close(error instanceof DesktopUnavailableError ? error : new DesktopUnavailableError("Не удалось прочитать состояние Codex: несовместимый или повреждённый пакет IPC."));
      }
    });
    stream.once("error", () => this.close());
    stream.once("close", () => this.disconnected(stream));
    try {
      const reply = await this.request("initialize", 0, { clientType: "vkodex" });
      if (!isObject(reply.result) || typeof reply.result.clientId !== "string") {
        throw new DesktopUnavailableError("Десктоп вернул несовместимый ответ подключения.");
      }
      this.clientId = reply.result.clientId;
    } catch (error) {
      this.close();
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
      this.pending.set(requestId, { resolve, reject, timer, mutating: options.mutating ?? false });
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
      this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.resultType === "success") pending.resolve(message);
      // Internal protocol errors are not a reliable proof that a write did not happen.
      else pending.reject(pending.mutating ? new UncertainActionError() : new DesktopUnavailableError("Десктоп отклонил запрос."));
      return;
    }
    if (message.type === "broadcast" && Array.isArray(message.targetClientIds) && message.targetClientIds.includes(this.clientId)) {
      for (const listener of this.listeners) listener(message);
    }
  }

  close(error = new DesktopUnavailableError()): void {
    const stream = this.stream;
    if (!stream) return;
    this.disconnected(stream, error);
    stream.destroy();
  }

  private disconnected(stream: Duplex, error = new DesktopUnavailableError()): void {
    if (this.stream !== stream) return;
    this.stream = null;
    this.clientId = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(request.mutating ? new UncertainActionError() : error);
    }
    this.pending.clear();
    for (const listener of this.disconnectListeners) listener(error);
  }
}
