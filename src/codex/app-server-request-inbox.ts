import { isDeepStrictEqual } from "node:util";
import { AppServerFrontendResponseError } from "./app-server-connection.js";
import type { AppServerServerRequest,
  AppServerServerRequestContext } from "./app-server-connection.js";

type JsonObject = Record<string, unknown>;
export type RequestFrame = Readonly<{ id: string | number; method: string; params: JsonObject }>;
export interface PendingRequestResponder {
  detach(): void;
  answer(id: string | number, result: JsonObject): boolean;
  reject(id: string | number, error: JsonObject): boolean;
}
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
  /** Explicit opt-in to native JSON-RPC errors; never inferred from allowAnswer. */
  readonly allowError?: (request: AppServerServerRequest, error: JsonObject) => boolean;
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
  settling: boolean;
}
interface PendingObserver {
  readonly listener: (frame: RequestFrame) => void;
  readonly onFailure: (reason: string) => void;
  active: boolean;
}

/** A worker-scoped inbox. The caller must explicitly compose its one App Server
 * request handler; constructing an inbox does not change the existing executor. */
export class AppServerRequestInbox {
  private readonly identity: Readonly<{ threadId: string; generation: number }>;
  private readonly pending = new Map<string, Pending>();
  private readonly options: RequestInboxOptions;
  private readonly maxPending: number;
  private epoch = 0;
  private attachment: { readonly epoch: number; readonly send: (frame: RequestFrame) => void } | null = null;
  private readonly observers = new Set<PendingObserver>();

  constructor(options: RequestInboxOptions) {
    if (!options.threadId || !Number.isSafeInteger(options.generation) || options.generation < 1 ||
      typeof options.isGenerationCurrent !== "function" || typeof options.allowRequest !== "function" ||
      typeof options.allowAnswer !== "function" ||
      options.allowError !== undefined && typeof options.allowError !== "function")
      throw new TypeError("Invalid request inbox owner");
    this.identity = Object.freeze({ threadId: options.threadId, generation: options.generation });
    this.maxPending = options.maxPending ?? 64;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 1024)
      throw new TypeError("Invalid request inbox capacity");
    this.options = Object.freeze({
      threadId: options.threadId, generation: options.generation,
      isGenerationCurrent: options.isGenerationCurrent,
      allowRequest: options.allowRequest, allowAnswer: options.allowAnswer,
      ...(options.allowError ? { allowError: options.allowError } : {}),
    });
  }

  /** Attachment authority comes from construction, never a frontend frame. */
  get owner(): Readonly<{ threadId: string; generation: number }> { return this.identity; }

  /** Includes answered requests until the worker response is written (or the
   * request is aborted). Observer replay intentionally exposes fewer entries. */
  unresolvedCount(): number { return this.pending.size; }

  private key(id: string | number): string { return `${typeof id}:${String(id)}`; }
  private current(): boolean { return this.options.isGenerationCurrent(this.options.generation); }
  private frame(request: AppServerServerRequest): RequestFrame { return structuredClone(request); }

  private deliver(pending: Pending): void {
    const attachment = this.attachment;
    if (!attachment || pending.answered || pending.context.signal.aborted || !this.current()) return;
    try { attachment.send(this.frame(pending.request)); }
    catch { if (this.attachment === attachment) this.attachment = null; }
  }

  private observerFailure(observer: PendingObserver): void {
    if (!observer.active) return;
    observer.active = false;
    this.observers.delete(observer);
    try { void Promise.resolve(observer.onFailure("observer-faulted")).catch(() => {}); }
    catch { /* A faulty failure reporter cannot affect the pending worker request. */ }
  }

  private notify(observer: PendingObserver, pending: Pending): void {
    if (!observer.active || pending.answered || pending.context.signal.aborted || !this.current()) return;
    try {
      const returned: unknown = observer.listener(this.frame(pending.request));
      if (returned !== null && (typeof returned === "object" || typeof returned === "function") &&
          typeof (returned as { then?: unknown }).then === "function") {
        void Promise.resolve(returned).catch(() => {});
        this.observerFailure(observer);
      }
    } catch { this.observerFailure(observer); }
  }

  /** Independent read-only pending-request feed; never installs a backend handler. */
  observePending(listener: (frame: RequestFrame) => void,
    onFailure: (reason: string) => void): () => void {
    if (typeof listener !== "function" || typeof onFailure !== "function")
      throw new TypeError("Pending observer callbacks required");
    const observer: PendingObserver = { listener, onFailure, active: true };
    this.observers.add(observer);
    for (const pending of [...this.pending.values()]) {
      if (!observer.active) break;
      if (this.pending.get(this.key(pending.request.id)) === pending) this.notify(observer, pending);
    }
    return () => { observer.active = false; this.observers.delete(observer); };
  }

  /** Separate response capability; attachment and responder use the same one-winner settlement. */
  createResponder(isAuthorized: () => boolean): PendingRequestResponder {
    if (typeof isAuthorized !== "function") throw new TypeError("Responder authority required");
    let active = true;
    const eligible = () => {
      if (!active) return false;
      const approved = isAuthorized() === true;
      return approved && active;
    };
    return { detach: () => { active = false; },
      answer: (id, result) => this.answer(eligible, id, result),
      reject: (id, error) => this.answer(eligible, id, error, true) };
  }

  attach(send: (frame: RequestFrame) => void): {
    readonly epoch: number;
    detach(): void;
    answer(id: string | number, result: JsonObject): boolean;
    reject(id: string | number, error: JsonObject): boolean;
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
      answer: (id, result) => this.answer(() => this.attachment === attachment, id, result),
      reject: (id, error) => this.answer(() => this.attachment === attachment, id, error, true),
    };
  }

  private answer(eligible: () => boolean, id: string | number, result: JsonObject,
    negative = false): boolean {
    if (!validId(id) || !object(result)) return false;
    const pending = this.pending.get(this.key(id));
    if (!pending || pending.answered || pending.settling || pending.context.signal.aborted ||
      pending.request.params.threadId !== this.options.threadId) return false;
    pending.settling = true;
    try {
      if (!eligible() || !this.current()) return false;
      const answer = jsonClone(result);
      let error: AppServerFrontendResponseError | undefined;
      if (negative) {
        error = new AppServerFrontendResponseError(answer);
        if (this.options.allowError?.(structuredClone(pending.request), error.wireError) !== true) return false;
      } else if (this.options.allowAnswer(structuredClone(pending.request), structuredClone(answer)) !== true) return false;
      if (!eligible() || !this.current() || this.pending.get(this.key(id)) !== pending ||
        pending.answered || pending.context.signal.aborted) return false;
      pending.answered = true;
      if (error) pending.reject(error);
      else pending.resolve(answer);
      // This receipt confirms only a local write attempt, never worker acceptance.
      void pending.context.responseWritten.then(() => this.retire(id, pending), () => this.retire(id, pending));
      return true;
    } catch { return false; }
    finally { pending.settling = false; }
  }

  handle(request: AppServerServerRequest, context: AppServerServerRequestContext): Promise<JsonObject> {
    if (!this.current() || context.signal.aborted || !validId(request.id) ||
      typeof request.method !== "string" || !object(request.params) ||
      request.params.threadId !== this.options.threadId)
      return Promise.reject(new Error("Server request outside inbox policy"));
    let approved: boolean;
    try { approved = this.options.allowRequest(structuredClone(request)); }
    catch { approved = false; }
    if (approved !== true || !this.current() || context.signal.aborted)
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
      answered: false, settling: false,
    };
    this.pending.set(key, pending);
    context.signal.addEventListener("abort", pending.abort, { once: true });
    if (context.signal.aborted) pending.abort();
    else {
      for (const observer of [...this.observers]) this.notify(observer, pending);
      this.deliver(pending);
    }
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
