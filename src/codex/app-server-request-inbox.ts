import { isDeepStrictEqual } from "node:util";
import type { AppServerServerRequest,
  AppServerServerRequestContext } from "./app-server-connection.js";

type JsonObject = Record<string, unknown>;
type RequestFrame = Readonly<{ id: string | number; method: string; params: JsonObject }>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (id: unknown): id is string | number =>
  typeof id === "string" && id.length > 0 ||
  typeof id === "number" && Number.isSafeInteger(id);
function jsonClone(value: JsonObject): JsonObject {
  const snapshot = structuredClone(value);
  const encoded = JSON.stringify(snapshot, (_key, item: unknown) => {
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
      typeof item === "bigint" || typeof item === "number" && !Number.isFinite(item))
      throw new TypeError("Non-JSON server request answer");
    return item;
  });
  const decoded: unknown = JSON.parse(encoded);
  if (!object(decoded) || !isDeepStrictEqual(snapshot, decoded))
    throw new TypeError("Invalid server request answer");
  return decoded;
}

export interface RequestInboxOptions {
  readonly threadId: string;
  readonly generation: number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly allowRequest: (request: AppServerServerRequest) => boolean;
  readonly allowAnswer: (request: AppServerServerRequest, result: JsonObject) => boolean;
  readonly maxPending?: number;
}

interface Pending {
  readonly request: AppServerServerRequest;
  readonly context: AppServerServerRequestContext;
  readonly promise: Promise<JsonObject>;
  readonly resolve: (result: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
  answered: boolean;
}

/** A worker-scoped inbox. The caller must explicitly compose its one App Server
 * request handler; constructing an inbox does not change the existing executor. */
export class AppServerRequestInbox {
  private readonly pending = new Map<string, Pending>();
  private readonly options: RequestInboxOptions;
  private readonly maxPending: number;
  private epoch = 0;
  private attachment: { readonly epoch: number; readonly send: (frame: RequestFrame) => void } | null = null;

  constructor(options: RequestInboxOptions) {
    if (!options.threadId || !Number.isSafeInteger(options.generation) || options.generation < 1 ||
      typeof options.isGenerationCurrent !== "function" || typeof options.allowRequest !== "function" ||
      typeof options.allowAnswer !== "function") throw new TypeError("Invalid request inbox owner");
    this.maxPending = options.maxPending ?? 64;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 1024)
      throw new TypeError("Invalid request inbox capacity");
    this.options = Object.freeze({
      threadId: options.threadId, generation: options.generation,
      isGenerationCurrent: options.isGenerationCurrent,
      allowRequest: options.allowRequest, allowAnswer: options.allowAnswer,
    });
  }

  private key(id: string | number): string { return `${typeof id}:${String(id)}`; }
  private current(): boolean { return this.options.isGenerationCurrent(this.options.generation); }
  private frame(request: AppServerServerRequest): RequestFrame { return structuredClone(request); }

  private deliver(pending: Pending): void {
    const attachment = this.attachment;
    if (!attachment || pending.answered || pending.context.signal.aborted || !this.current()) return;
    try { attachment.send(this.frame(pending.request)); }
    catch { if (this.attachment === attachment) this.attachment = null; }
  }

  attach(send: (frame: RequestFrame) => void): {
    readonly epoch: number;
    detach(): void;
    answer(id: string | number, result: JsonObject): boolean;
  } {
    if (typeof send !== "function") throw new TypeError("Frontend writer required");
    const attachment = { epoch: ++this.epoch, send };
    this.attachment = attachment;
    for (const pending of this.pending.values()) {
      if (this.attachment !== attachment) break;
      this.deliver(pending);
    }
    return {
      epoch: attachment.epoch,
      detach: () => { if (this.attachment === attachment) this.attachment = null; },
      answer: (id, result) => this.answer(attachment, id, result),
    };
  }

  private answer(attachment: { readonly epoch: number }, id: string | number, result: JsonObject): boolean {
    if (this.attachment !== attachment || !this.current() || !validId(id) || !object(result)) return false;
    const pending = this.pending.get(this.key(id));
    if (!pending || pending.answered || pending.context.signal.aborted ||
      pending.request.params.threadId !== this.options.threadId) return false;
    let answer: JsonObject;
    try {
      answer = jsonClone(result);
      if (!this.options.allowAnswer(structuredClone(pending.request), structuredClone(answer))) return false;
    } catch { return false; }
    if (this.attachment !== attachment || !this.current() ||
      this.pending.get(this.key(id)) !== pending || pending.answered ||
      pending.context.signal.aborted) return false;
    pending.answered = true;
    pending.resolve(answer);
    // This receipt confirms only a local write attempt, never worker acceptance.
    void pending.context.responseWritten.then(() => this.retire(id, pending), () => this.retire(id, pending));
    return true;
  }

  handle(request: AppServerServerRequest, context: AppServerServerRequestContext): Promise<JsonObject> {
    if (!this.current() || context.signal.aborted || !validId(request.id) ||
      typeof request.method !== "string" || !object(request.params) ||
      request.params.threadId !== this.options.threadId)
      return Promise.reject(new Error("Server request outside inbox policy"));
    let approved: boolean;
    try { approved = this.options.allowRequest(structuredClone(request)); }
    catch { approved = false; }
    if (!approved || !this.current() || context.signal.aborted)
      return Promise.reject(new Error("Server request outside inbox policy"));
    const key = this.key(request.id);
    const prior = this.pending.get(key);
    if (prior) return isDeepStrictEqual(prior.request, request) && !prior.answered
      ? prior.promise : Promise.reject(new Error("Conflicting server request id"));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error("Server request inbox full"));
    let resolve!: (result: JsonObject) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<JsonObject>((yes, no) => { resolve = yes; reject = no; });
    const pending: Pending = {
      request: structuredClone(request), context, promise, resolve, reject,
      abort: () => this.retire(request.id, pending, new Error("Server request resolved or connection lost")),
      answered: false,
    };
    this.pending.set(key, pending);
    context.signal.addEventListener("abort", pending.abort, { once: true });
    if (context.signal.aborted) pending.abort();
    else this.deliver(pending);
    return promise;
  }

  private retire(id: string | number, pending: Pending, error?: Error): void {
    const key = this.key(id);
    if (this.pending.get(key) !== pending) return;
    this.pending.delete(key);
    pending.context.signal.removeEventListener("abort", pending.abort);
    if (error && !pending.answered) pending.reject(error);
  }
}
