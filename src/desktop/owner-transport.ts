import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

type Message = Record<string, unknown>;
const object = (value: unknown): value is Message => !!value && typeof value === "object" && !Array.isArray(value);
const owns = (value: Message, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export class OwnerTransportError extends Error {
  constructor(
    readonly outcome: "unavailable" | "outdated" | "rejected" | "unknown",
    message: string,
    readonly reason?: "endpointMissing",
  ) { super(message); }
}

/** Experimental transport, not installed into production clients automatically.
 * One native connection and initialization. Extra requests never impersonate a second client. */
export class OwnerTransport {
  private readonly prefix = `vkodex-${randomUUID()}-`;
  private sequence = 0;
  private initialized = false;
  private initializeAccepted = false;
  private stopped = false;
  private readonly pending = new Map<string, {
    clientId?: unknown;
    initialize?: boolean;
    resolve?: (result: Message) => void;
    reject?: (error: OwnerTransportError) => void;
    timer?: ReturnType<typeof setTimeout>;
    mutating?: boolean;
  }>();
  private readonly archiving = new Set<string>();
  private readonly archiveGroups = new Map<string, Set<string>>();

  constructor(
    private readonly nativeInput: Writable,
    private readonly nativeOutput: Readable,
    private readonly clientInput: Readable,
    private readonly clientOutput: Writable,
    private readonly timeoutMs = 30_000,
  ) {
    this.lines(clientInput, message => this.fromClient(message));
    this.lines(nativeOutput, message => this.fromNative(message));
    nativeInput.on("drain", () => clientInput.resume());
    clientOutput.on("drain", () => nativeOutput.resume());
    for (const stream of [nativeInput, nativeOutput, clientInput, clientOutput]) stream.on("error", () => this.close());
    nativeOutput.once("end", () => this.close());
    clientInput.once("end", () => { this.close(); nativeInput.end(); });
  }

  private lines(stream: Readable, receive: (message: Message) => void): void {
    // A decoder must keep split UTF-8 code points intact; no payloads are logged.
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk: string) => {
      if (this.stopped) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { const value: unknown = JSON.parse(line); if (!object(value)) throw new Error(); receive(value); }
        catch { this.close(); return; }
      }
    });
  }

  private send(stream: Writable, message: Message): void {
    if (this.stopped) throw new OwnerTransportError("unavailable", "Owner transport is closed.");
    if (!stream.write(`${JSON.stringify(message)}\n`)) {
      (stream === this.nativeInput ? this.clientInput : this.nativeOutput).pause();
    }
  }

  private fromClient(message: Message): void {
    if (typeof message.method === "string" && owns(message, "id")) {
      const threadId = object(message.params) ? message.params.threadId : undefined;
      if (typeof threadId === "string" && this.archiving.has(threadId)
        && !["thread/read", "thread/goal/get", "thread/items/list", "thread/turns/list"].includes(message.method)) {
        this.send(this.clientOutput, { id: message.id, error: { code: -32000, message: "VKodex is checking archival of this thread; retry after it finishes." } });
        return;
      }
      const id = this.prefix + ++this.sequence;
      this.pending.set(id, { clientId: message.id, initialize: message.method === "initialize" });
      this.send(this.nativeInput, { ...message, id });
    } else {
      // Server-initiated approvals and notifications retain the native IDs.
      if (message.method === "initialized" && this.initializeAccepted) this.initialized = true;
      this.send(this.nativeInput, message);
    }
  }

  private fromNative(message: Message): void {
    if (message.method === "thread/archived" && object(message.params) && typeof message.params.threadId === "string") {
      const group = this.archiveGroups.get(message.params.threadId);
      for (const id of group ?? [message.params.threadId]) this.archiving.delete(id);
      this.archiveGroups.delete(message.params.threadId);
    }
    if (!owns(message, "method") && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (owns(pending, "clientId")) {
          if (pending.initialize && !message.error) this.initializeAccepted = true;
          // VS Code does not send the optional initialized notification. A
          // successful subsequent IDE request proves the native session is ready.
          if (!pending.initialize && this.initializeAccepted && !message.error) this.initialized = true;
          this.send(this.clientOutput, { ...message, id: pending.clientId });
        } else if (message.error) pending.reject?.(new OwnerTransportError(pending.mutating ? "unknown" : "rejected", "Native owner reported an error; a mutation may have partially completed."));
        else if (!object(message.result)) pending.reject?.(new OwnerTransportError(pending.mutating ? "unknown" : "unavailable", "Invalid owner response."));
        else pending.resolve?.(message.result);
        return;
      }
      // A timed-out control response must not leak into the UI as a foreign request.
      if (message.id.startsWith(this.prefix)) return;
    }
    this.send(this.clientOutput, message);
  }

  private request(method: string, params: Message, mutating = false): Promise<Message> {
    if (!this.initialized || this.stopped) return Promise.reject(new OwnerTransportError("unavailable", "Native client is not initialized."));
    return new Promise((resolve, reject) => {
      const id = this.prefix + ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OwnerTransportError(mutating ? "unknown" : "unavailable", "Native owner timed out; no automatic retry."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, mutating });
      try { this.send(this.nativeInput, { id, method, params }); }
      catch { this.close(); }
    });
  }

  /** Probe never resumes a task or opens a window. */
  async ownsTask(threadId: string): Promise<boolean> {
    const loaded = await this.request("thread/loaded/list", {});
    if (!Array.isArray(loaded.data)) throw new OwnerTransportError("unavailable", "Invalid loaded task response.");
    return loaded.data.includes(threadId);
  }

  /** Read the native owner's state without resuming a task or opening its UI. */
  async inspectTask(threadId: string): Promise<"idle" | "active" | "systemError"> {
    if (!await this.ownsTask(threadId)) throw new OwnerTransportError("rejected", "This native process does not own the task.");
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    const thread = result.thread;
    if (!object(thread) || thread.id !== threadId || !object(thread.status)
      || !["idle", "active", "systemError"].includes(String(thread.status.type))) {
      throw new OwnerTransportError("unavailable", "Owner returned an invalid task state.");
    }
    return thread.status.type as "idle" | "active" | "systemError";
  }

  async archiveIdle(threadId: string): Promise<void> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(threadId) || this.archiving.has(threadId)) throw new OwnerTransportError("rejected", "Invalid or busy archive request.");
    this.archiving.add(threadId);
    const group = new Set([threadId]);
    this.archiveGroups.set(threadId, group);
    const deadline = Date.now() + 25_000;
    const checkDeadline = () => { if (Date.now() >= deadline) throw new OwnerTransportError("unavailable", "Archive preflight expired before mutation."); };
    let unknown = false;
    try {
      const loaded = await this.request("thread/loaded/list", {});
      if (!Array.isArray(loaded.data) || !loaded.data.includes(threadId)) throw new OwnerTransportError("rejected", "This native process does not own the task.");
      const listDescendants = async (): Promise<Set<string>> => {
        const ids = new Set<string>(), cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          checkDeadline();
          const descendants = await this.request("thread/list", {
            ancestorThreadId: threadId, archived: false, limit: 100, ...(cursor ? { cursor } : {}),
            // Omitting sourceKinds defaults to interactive tasks and hides subagents.
            sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
          });
          if (!Array.isArray(descendants.data)) throw new OwnerTransportError("unavailable", "Invalid descendant list.");
          for (const child of descendants.data) {
            if (!object(child) || typeof child.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(child.id) || child.id === threadId || ids.has(child.id)) throw new OwnerTransportError("unavailable", "Invalid or unstable descendant list.");
            ids.add(child.id);
          }
          if (descendants.nextCursor == null) break;
          if (typeof descendants.nextCursor !== "string" || !descendants.nextCursor || cursors.has(descendants.nextCursor)) throw new OwnerTransportError("unavailable", "Invalid descendant cursor.");
          cursor = descendants.nextCursor; cursors.add(cursor);
        } while (true);
        return ids;
      };
      const descendants = await listDescendants();
      for (const id of descendants) {
        if (this.archiving.has(id)) throw new OwnerTransportError("rejected", "A descendant is already being archived.");
        this.archiving.add(id); group.add(id);
      }
      // Gate the entire tree before checking it. Never resume an unloaded child:
      // it might belong to another client and its idle state is not established.
      for (const id of group) {
        checkDeadline();
        const result = await this.request("thread/read", { threadId: id, includeTurns: false });
        const thread = result.thread;
        // `systemError` is terminal and has no running turn. Requiring only
        // `idle` left a safely verified failed source impossible to archive.
        if (!object(thread) || thread.id !== id || !object(thread.status)
          || !["idle", "systemError"].includes(String(thread.status.type))) {
          throw new OwnerTransportError("rejected", "Source and descendants must be confirmed terminal before archival.");
        }
        const goal = await this.request("thread/goal/get", { threadId: id });
        if (goal.goal !== null && (!object(goal.goal) || !["paused", "complete", "blocked", "usageLimited", "budgetLimited"].includes(String(goal.goal.status)))) throw new OwnerTransportError("rejected", "Pause source and descendant goals before archival.");
      }
      const confirmed = await listDescendants();
      if (confirmed.size !== descendants.size || [...confirmed].some(id => !descendants.has(id))) throw new OwnerTransportError("rejected", "Descendant tree changed during archive preflight.");
      checkDeadline();
      await this.request("thread/archive", { threadId }, true);
    } catch (error) {
      unknown = error instanceof OwnerTransportError && error.outcome === "unknown";
      throw error;
    } finally {
      // An uncertain archive cannot silently unlock source writes. A genuine native
      // thread/archived notification can settle it; never synthesize that event.
      if (!unknown) {
        for (const id of group) this.archiving.delete(id);
        this.archiveGroups.delete(threadId);
      }
    }
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject?.(new OwnerTransportError(pending.mutating ? "unknown" : "unavailable", "Owner disconnected; no automatic retry."));
    }
    this.pending.clear();
  }
}
