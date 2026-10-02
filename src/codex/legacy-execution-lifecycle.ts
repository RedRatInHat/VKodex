import { ActionRejectedError, TaskOwnedByClientError, type ExecutionDrainResult, type TaskRef } from "../core/codex-tasks.js";
import { AppServerRejectedError, AppServerUnavailableError, type AppServerEnvelope,
  type AppServerRequestOptions, type AppServerRpc } from "./app-server-connection.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const scopeId = (value: unknown): string | null => typeof value === "string" && value.length > 0
  && value.length <= 256 && !/[\s\x00-\x1f\x7f]/u.test(value) ? value : null;
const MAX_TASK_REVISIONS = 4096;
interface Drain { generation: number; state: ExecutionDrainResult | "checking"; unloaded: boolean;
  release: Promise<unknown> | null; restored?: true; assertRelease?: () => void }
interface WorkReceipt { readonly turnId?: string; readonly clientId?: string }

// Pinned native notifications with an explicit threadId and no family-topology
// effect. Unknown/unscoped notifications retain a profile-wide proof fence.
const taskNotifications = new Set([
  "thread/status/changed", "thread/reverted", "thread/name/updated", "thread/attachment/updated",
  "thread/goal/updated", "thread/goal/cleared", "thread/queue/changed", "thread/project/updated",
  "thread/settings/updated", "thread/tokenUsage/updated", "thread/compacted",
  "turn/started", "turn/completed", "turn/diff/updated", "turn/plan/updated", "hook/started", "hook/completed",
  "item/started", "item/completed", "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
  "autoApprovalReview/strictReviewRequired", "item/agentMessage/delta", "item/plan/delta",
  "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction", "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated", "item/mcpToolCall/progress", "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded", "item/reasoning/textDelta", "serverRequest/resolved",
]);

/** A legacy profile connection must stop retaining idle execution separately
 * from reconciling historical bridge receipts. No probe may start a backend. */
export class LegacyExecutionLifecycle {
  readonly rpc: AppServerRpc;
  private readonly acquired = new Map<string, number>();
  private readonly drains = new Map<string, Drain>();
  private readonly busy = new Map<string, number>();
  private readonly unknown = new Set<string>();
  private readonly receipts = new Map<string, WorkReceipt[]>();
  private revision = 0;
  private unscopedRevision = 0;
  private readonly taskRevisions = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private readonly original: AppServerRpc) {
    this.unsubscribe = original.onNotification(event => this.observe(event));
    this.rpc = {
      start: () => original.start(),
      currentInitializedSession: () => original.currentInitializedSession?.() ?? null,
      request: (method, params, options) => this.request(method, params, options),
      onNotification: listener => original.onNotification(listener),
      onDisconnect: listener => original.onDisconnect?.(listener) ?? (() => {}),
      onServerRequest: handler => original.onServerRequest(handler ? (request, context) => {
        const threadId = scopeId(request.params.threadId) ?? "__unscoped_server_request__";
        this.changeBusy(threadId, 1);
        // Removing a displayed question is not evidence that its reply was written.
        void context.responseWritten.then(() => {}, () => {
          this.unknown.add(threadId);
        }).finally(() => { this.changeBusy(threadId, -1); });
        return handler(request, context);
      } : null),
      close: () => original.close(),
    };
  }

  private changeBusy(threadId: string, amount: number): void {
    const count = (this.busy.get(threadId) ?? 0) + amount;
    if (count > 0) this.busy.set(threadId, count); else this.busy.delete(threadId);
    this.changed(threadId === "__unscoped_server_request__" ? null : threadId);
  }
  private changed(threadId: string | null): void {
    const revision = ++this.revision;
    const scoped = scopeId(threadId);
    if (scoped === null) this.unscopedRevision = revision;
    else {
      if (!this.taskRevisions.has(scoped) && this.taskRevisions.size >= MAX_TASK_REVISIONS) {
        // Eviction cannot erase changes underneath an in-flight family proof.
        this.unscopedRevision = revision;
        this.taskRevisions.clear();
      }
      this.taskRevisions.set(scoped, revision);
    }
  }
  private changedSince(family: readonly string[], revision: number, unscopedRevision: number): boolean {
    return this.unscopedRevision !== unscopedRevision
      || family.some(threadId => (this.taskRevisions.get(threadId) ?? 0) > revision);
  }
  assertAdmission(task: TaskRef): void {
    const drain = this.drains.get(task.threadId);
    if (drain?.state === "released" && this.current(drain.generation)) throw new TaskOwnedByClientError();
    if (drain) throw new ActionRejectedError("Освобождение прежнего исполнителя ещё не подтверждено; новый запуск не отправлен.");
  }
  isDraining(task: TaskRef): boolean { return this.drains.has(task.threadId); }
  restore(task: TaskRef): void {
    if (!this.drains.has(task.threadId)) this.drains.set(task.threadId,
      { generation: 0, state: "unavailable", unloaded: false, release: null, restored: true });
  }
  /** Spans preparation, beforeSend and idempotent-setting retry gaps. */
  beginCommand(task: TaskRef, currentWorkControl = false): () => void {
    if (!currentWorkControl || this.drains.get(task.threadId)?.restored) this.assertAdmission(task);
    this.changeBusy(task.threadId, 1);
    return () => this.changeBusy(task.threadId, -1);
  }
  private current(generation: number): boolean {
    return Number.isSafeInteger(generation) && generation > 0
      && this.original.currentInitializedSession?.()?.generation === generation;
  }
  private async request(method: string, params: ObjectValue = {}, options: AppServerRequestOptions = {}): Promise<ObjectValue> {
    const threadId = id(params.threadId);
    const writer = options.mutating === true || method === "thread/resume";
    const drain = threadId ? this.drains.get(threadId) : undefined;
    const controlledRelease = method === "thread/unsubscribe" && drain?.state === "checking";
    let dispatched = false;
    let definitiveRejection = false;
    if (threadId && writer) this.changeBusy(threadId, 1);
    let generation = options.expectedGeneration ?? this.original.currentInitializedSession?.()?.generation;
    const guarded = { ...options,
      ...(method === "thread/resume" ? { mutating: true } : {}),
      ...(drain ? { expectedGeneration: drain.generation } : {}),
      onResponseEnvelope: (envelope: import("./app-server-connection.js").AppServerResponseEnvelope) => {
        const error = "error" in envelope ? envelope.error : null;
        definitiveRejection = object(error) && Number.isSafeInteger(error.code) && typeof error.message === "string";
        options.onResponseEnvelope?.(envelope);
      },
      assertBeforeWrite: () => {
        options.assertBeforeWrite?.();
        if (threadId && writer && this.drains.has(threadId) && method !== "turn/interrupt")
          this.assertAdmission({ hostId: "local", threadId });
        if (controlledRelease && (!this.current(drain.generation) || drain.unloaded))
          throw new AppServerUnavailableError();
        if (controlledRelease) drain.assertRelease?.();
        generation ??= this.original.currentInitializedSession?.()?.generation;
        dispatched = true;
      },
    };
    const work = this.original.request(method, params, guarded).then(result => {
      if (threadId && method === "thread/resume" && generation !== undefined && this.current(generation))
        this.acquired.set(threadId, generation);
      if (threadId && writer && method === "turn/start") {
        const turnId = object(result.turn) ? id(result.turn.id) : null;
        if (turnId) this.remember(threadId, { turnId }); else this.unknown.add(threadId);
      } else if (threadId && writer && method === "turn/steer") {
        const turnId = id(result.turnId);
        if (turnId && turnId === params.expectedTurnId) this.remember(threadId, { turnId });
        else this.unknown.add(threadId);
      } else if (threadId && writer && method === "thread/queue/add") {
        const queued = result.queuedSubmission;
        const clientId = object(queued) && id(queued.id) && queued.clientUserMessageId === params.clientUserMessageId
          ? id(queued.clientUserMessageId) : null;
        if (clientId) this.remember(threadId, { clientId }); else this.unknown.add(threadId);
      }
      if (controlledRelease && result.status !== "unsubscribed" && result.status !== "notLoaded")
        throw new AppServerUnavailableError();
      if (controlledRelease && result.status === "notLoaded" && this.current(drain.generation)) drain.unloaded = true;
      return result;
    }).catch(error => {
      // A final wire guard proves refusal. A written timeout, malformed ACK or
      // disconnect does not; retain uncertainty until explicit outcome proof.
      if (threadId && writer && dispatched && !(error instanceof AppServerRejectedError && definitiveRejection)) this.unknown.add(threadId);
      throw error;
    }).finally(() => { if (threadId && writer) this.changeBusy(threadId, -1); });
    if (controlledRelease) drain.release = work;
    return work;
  }
  private remember(threadId: string, receipt: WorkReceipt): void {
    const entries = this.receipts.get(threadId) ?? [];
    if (!entries.some(value => value.turnId === receipt.turnId && value.clientId === receipt.clientId)) entries.push(receipt);
    this.receipts.set(threadId, entries);
  }
  private observe(event: AppServerEnvelope): void {
    const threadId = scopeId(event.params.threadId);
    const nested = event.params.thread;
    const scopeValid = nested === undefined || object(nested) && scopeId(nested.id) === threadId;
    this.changed(threadId && scopeValid && taskNotifications.has(event.method) ? threadId : null);
    if (!threadId) return;
    const drain = this.drains.get(threadId);
    if (event.method === "thread/closed" && drain && this.current(drain.generation)) {
      drain.unloaded = true;
      if (drain.state === "waiting-unload" || drain.state === "unavailable") drain.state = "released";
    }
    if (event.method === "turn/completed" && object(event.params.turn)
      && ["completed", "failed", "interrupted"].includes(String(event.params.turn.status))) {
      const turnId = id(event.params.turn.id);
      this.receipts.set(threadId, (this.receipts.get(threadId) ?? []).filter(value => value.turnId !== turnId));
    }
  }
  private async read(method: string, params: ObjectValue, generation: number, deadline: number): Promise<ObjectValue> {
    const remaining = deadline - performance.now();
    if (!this.current(generation) || remaining <= 0) throw new AppServerUnavailableError();
    const result = await this.original.request(method, params, { expectedGeneration: generation, timeoutMs: Math.min(5_000, Math.ceil(remaining)) });
    if (!this.current(generation) || performance.now() >= deadline) throw new AppServerUnavailableError();
    return result;
  }
  private async family(root: string, generation: number, deadline: number): Promise<string[]> {
    const page = await this.read("thread/list", { ancestorThreadId: root, archived: false, limit: 100,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact",
        "subAgentThreadSpawn", "subAgentOther", "unknown"] }, generation, deadline);
    if (!Array.isArray(page.data) || page.data.length > 100 || page.nextCursor !== null) throw new AppServerUnavailableError();
    const values = page.data.map(value => object(value) ? id(value.id) : null);
    if (values.some(value => !value || value === root) || new Set(values).size !== values.length) throw new AppServerUnavailableError();
    return (values as string[]).sort();
  }
  private async terminalReceipts(threadId: string, generation: number, activeTurnId: string | null, deadline: number): Promise<boolean> {
    const receipts = [...(this.receipts.get(threadId) ?? []), ...(activeTurnId ? [{ turnId: activeTurnId }] : [])];
    if (!receipts.length) return true;
    const page = await this.read("thread/turns/list", { threadId, limit: 100, sortDirection: "desc", itemsView: "full" }, generation, deadline);
    if (!Array.isArray(page.data)) throw new AppServerUnavailableError();
    return receipts.every(receipt => {
      const matches = (page.data as unknown[]).filter(turn => object(turn) &&
        (receipt.turnId ? turn.id === receipt.turnId : Array.isArray(turn.items) && turn.items.some(item =>
          object(item) && item.type === "userMessage" && item.clientId === receipt.clientId)));
      return matches.length === 1 && object(matches[0]) && ["completed", "failed", "interrupted"].includes(String(matches[0].status));
    });
  }
  async drain(task: TaskRef, beforeRelease: () => void,
    local: () => { readonly activeTurnId: string | null; readonly blocked: boolean; readonly releasePending?: boolean },
    subscription: () => { readonly count: number; readonly revision: number }): Promise<ExecutionDrainResult> {
    const existing = this.drains.get(task.threadId);
    if (existing) return !this.current(existing.generation) ? "unavailable"
      : existing.state === "checking" ? "blocked" : existing.state;
    const session = this.original.currentInitializedSession?.();
    if (!session || this.acquired.get(task.threadId) !== session.generation) return "unavailable";
    const generation = session.generation;
    const scoped = subscription();
    if (scoped.count !== 1 || local().blocked || local().releasePending || this.busy.has(task.threadId) || this.unknown.has(task.threadId)
      || this.busy.has("__unscoped_server_request__") || this.unknown.has("__unscoped_server_request__")) return "blocked";
    const drain: Drain = { generation, state: "checking", unloaded: false, release: null };
    this.drains.set(task.threadId, drain);
    const revision = this.revision;
    const unscopedRevision = this.unscopedRevision;
    const deadline = performance.now() + 20_000;
    let closing = false;
    try {
      const family = [task.threadId, ...await this.family(task.threadId, generation, deadline)];
      for (const threadId of family) {
        if (this.busy.has(threadId) || this.unknown.has(threadId)) return "blocked";
        const response = await this.read("thread/read", { threadId, includeTurns: false }, generation, deadline);
        const thread = object(response.thread) && response.thread.id === threadId ? response.thread : null;
        if (!thread || !object(thread.status)) throw new AppServerUnavailableError();
        // notLoaded on a separate child reader cannot prove another writer idle.
        if (thread.status.type !== "idle") return "blocked";
        const goal = await this.read("thread/goal/get", { threadId }, generation, deadline);
        if (goal.goal !== null && (!object(goal.goal) || !["paused", "complete", "blocked", "usageLimited", "budgetLimited"]
          .includes(String(goal.goal.status)))) return "blocked";
        const queue = await this.read("thread/queue/list", { threadId }, generation, deadline);
        if (!Array.isArray(queue.data) || queue.nextCursor !== null) throw new AppServerUnavailableError();
        if (queue.data.length || !await this.terminalReceipts(threadId, generation,
          threadId === task.threadId ? local().activeTurnId : null, deadline)) return "blocked";
      }
      const confirmed = await this.family(task.threadId, generation, deadline);
      if (JSON.stringify(confirmed) !== JSON.stringify(family.slice(1))) return "blocked";
      if (performance.now() >= deadline || !this.current(generation) || this.changedSince(family, revision, unscopedRevision) || local().blocked
        || family.some(threadId => this.busy.has(threadId) || this.unknown.has(threadId))
        || subscription().count !== 1 || subscription().revision !== scoped.revision) return "blocked";
      drain.assertRelease = () => {
        if (performance.now() >= deadline || !this.current(generation) || this.changedSince(family, revision, unscopedRevision) || local().blocked || subscription().count !== 0
          || this.busy.has("__unscoped_server_request__") || this.unknown.has("__unscoped_server_request__")
          || family.some(threadId => this.busy.has(threadId) || this.unknown.has(threadId)))
          throw new AppServerUnavailableError();
      };
      closing = true;
      beforeRelease(); // No await: exact binding/stream validation and close are atomic with admission revocation.
      if (!drain.release || subscription().count !== 0) { drain.state = "unavailable"; return "unavailable"; }
      await drain.release;
      drain.state = !this.current(generation) ? "unavailable" : drain.unloaded ? "released" : "waiting-unload";
      return drain.state;
    } catch { drain.state = closing && drain.unloaded && this.current(generation) ? "released" : "unavailable"; return drain.state; }
    finally { if (!closing) this.drains.delete(task.threadId); }
  }
  close(): void { this.unsubscribe(); }
}
