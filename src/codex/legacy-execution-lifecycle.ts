import { ActionRejectedError, LegacyExecutionFencedError, TaskOwnedByClientError, type ExecutionDrainDiagnostic as CoreExecutionDrainDiagnostic,
  type ExecutionDrainResult, type TaskRef } from "../core/codex-tasks.js";
import { AppServerRejectedError, AppServerUnavailableError, type AppServerEnvelope,
  type AppServerRequestOptions, type AppServerRpc } from "./app-server-connection.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const scopeId = (value: unknown): string | null => typeof value === "string" && value.length > 0
  && value.length <= 256 && !/[\s\x00-\x1f\x7f]/u.test(value) ? value : null;
const MAX_TASK_REVISIONS = 4096;
const UNLOAD_READBACK_INTERVAL_MS = 31 * 60_000;
const MAX_PAGINATION_PAGES = 64;

export type ExecutionDrainDiagnosticReason =
  | "active-local" | "unknown-local" | "generation-mismatch" | "family-pagination-incomplete"
  | "child-active" | "goal-active" | "queue-pending" | "receipt-unknown"
  | "unload-retention-window" | "read-failure";
export type ExecutionDrainDiagnostic = CoreExecutionDrainDiagnostic & {
  readonly reason: ExecutionDrainDiagnosticReason;
  readonly elapsedMs: number;
  readonly retryAfterMs?: number;
};
type StoredExecutionDrainDiagnostic = CoreExecutionDrainDiagnostic & { readonly reason: ExecutionDrainDiagnosticReason };
class DrainDiagnosticError extends Error {
  constructor(readonly diagnosticReason: ExecutionDrainDiagnosticReason, readonly subjectThreadId?: string) {
    super("Execution drain proof unavailable."); this.name = "DrainDiagnosticError";
  }
}
interface Drain { generation: number; state: ExecutionDrainResult | "checking"; unloaded: boolean;
  release: Promise<ObjectValue> | null; restored?: true; assertRelease?: () => void;
  nextRefreshAt?: number; refresh?: Promise<ExecutionDrainResult>; family?: readonly string[] }
interface WorkReceipt { readonly turnId?: string; readonly clientId?: string }
interface AcquisitionAttempt { readonly token: symbol; readonly generation: number;
  state: "pending" | "unknown" | "abandoned" }

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
  private readonly acquisitions = new Map<string, Set<AcquisitionAttempt>>();
  private readonly diagnostics = new Map<string, StoredExecutionDrainDiagnostic>();
  private revision = 0;
  private unscopedRevision = 0;
  private readonly taskRevisions = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(private readonly original: AppServerRpc, private readonly now: () => number = () => performance.now(),
    private readonly predecessorFenced = false) {
    this.unsubscribe = original.onNotification(event => this.observe(event));
    this.rpc = {
      start: async () => { this.assertPredecessorAdmission(); await original.start(); },
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

  private assertPredecessorAdmission(): void {
    if (this.predecessorFenced)
      throw new ActionRejectedError("Прежний исполнитель ещё не проверен. Новый профильный процесс не запускается.");
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
    this.assertAdmissionExcept(task);
  }
  private assertAdmissionExcept(task: TaskRef, allowed?: AcquisitionAttempt): void {
    const drain = this.drains.get(task.threadId);
    if (drain?.state === "released" && this.current(drain.generation)) throw new TaskOwnedByClientError();
    // A restored fence still forbids this profile from acquiring a writer.
    // Distinguish its pre-dispatch refusal so an already-open native owner
    // can receive input without clearing or bypassing the profile fence.
    if (drain?.restored) throw new LegacyExecutionFencedError();
    if (drain) throw new ActionRejectedError("Освобождение прежнего исполнителя ещё не подтверждено; новый запуск не отправлен.");
    if ([...(this.acquisitions.get(task.threadId) ?? [])].some(attempt => attempt !== allowed
      && (allowed !== undefined || attempt.state !== "pending")))
      throw new ActionRejectedError("Исход подключения к задаче ещё не подтверждён; новый запуск не отправлен.");
  }
  private forgetAcquisition(threadId: string, attempt: AcquisitionAttempt): void {
    const attempts = this.acquisitions.get(threadId);
    if (attempts?.delete(attempt)) this.changedAcquisition(threadId);
    if (!attempts?.size) this.acquisitions.delete(threadId);
  }
  private changedAcquisition(threadId: string): void {
    this.changed(threadId);
  }
  private hasOtherAcquisition(threadId: string, allowed?: AcquisitionAttempt): boolean {
    return [...(this.acquisitions.get(threadId) ?? [])].some(attempt => attempt !== allowed);
  }
  private validResume(result: ObjectValue, threadId: string): boolean {
    const thread = object(result.thread) ? result.thread : null;
    return thread?.id === threadId && object(thread.status)
      && typeof thread.status.type === "string"
      && ["idle", "active", "systemError"].includes(thread.status.type);
  }
  pendingLegacyAcquisition(task: TaskRef): symbol | null {
    const attempts = [...(this.acquisitions.get(task.threadId) ?? [])];
    const attempt = attempts.length === 1 ? attempts[0] : null;
    return attempt?.state === "abandoned" && this.current(attempt.generation) ? attempt.token : null;
  }
  legacyAcquisitionState(task: TaskRef): "pending" | "unknown" | "abandoned" | null {
    const attempts = this.acquisitions.get(task.threadId);
    if (!attempts?.size) return null;
    if ([...attempts].some(attempt => attempt.state === "abandoned")) return "abandoned";
    if ([...attempts].some(attempt => attempt.state === "unknown")) return "unknown";
    return "pending";
  }
  isDraining(task: TaskRef): boolean { return this.drains.has(task.threadId); }
  diagnostic(task: TaskRef): ExecutionDrainDiagnostic | null {
    const diagnostic = this.diagnostics.get(task.threadId);
    if (!diagnostic) return null;
    const now = this.now();
    return {
      ...diagnostic,
      elapsedMs: Math.max(0, now - diagnostic.firstSeenAt),
      ...(diagnostic.nextRetryAt === undefined ? {} : { retryAfterMs: Math.max(0, diagnostic.nextRetryAt - now) }),
    };
  }
  private setDiagnostic(threadId: string, reason: ExecutionDrainDiagnosticReason,
    subjectThreadId?: string, nextRetryAt?: number): void {
    const at = this.now();
    const previous = this.diagnostics.get(threadId);
    const firstSeenAt = previous?.reason === reason && previous.subjectThreadId === subjectThreadId
      ? previous.firstSeenAt : at;
    if (!previous && this.diagnostics.size >= MAX_TASK_REVISIONS) {
      const oldest = this.diagnostics.keys().next().value;
      if (typeof oldest === "string") this.diagnostics.delete(oldest);
    }
    this.diagnostics.set(threadId, {
      reason, firstSeenAt, at,
      ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
      ...(subjectThreadId === undefined ? {} : { subjectThreadId }),
    });
  }
  private clearDiagnostic(threadId: string): void { this.diagnostics.delete(threadId); }
  private blocked(task: TaskRef, reason: ExecutionDrainDiagnosticReason, subjectThreadId?: string): ExecutionDrainResult {
    this.setDiagnostic(task.threadId, reason, subjectThreadId);
    return "blocked";
  }
  restore(task: TaskRef): void {
    if (!this.drains.has(task.threadId)) {
      this.drains.set(task.threadId, { generation: 0, state: "unavailable", unloaded: false, release: null, restored: true });
      this.setDiagnostic(task.threadId, "generation-mismatch", task.threadId);
    }
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
    // Even read-only RPC can lazily create a backend. This fence is source-wide
    // and immutable; it cannot be cleared by a task status or a new generation.
    this.assertPredecessorAdmission();
    const threadId = id(params.threadId);
    const writer = options.mutating === true || method === "thread/resume";
    let acquisition: AcquisitionAttempt | null = null;
    if (threadId && method === "thread/resume") {
      const task = { hostId: "local", threadId };
      this.assertAdmission(task);
      if (this.acquisitions.has(threadId)) throw new ActionRejectedError("Подключение к задаче уже выполняется.");
      const initial = this.original.currentInitializedSession?.();
      if (options.expectedGeneration !== undefined
        && (!initial || initial.generation !== options.expectedGeneration)) throw new AppServerUnavailableError();
      // A foreground resume may initialize its owner. Health never calls this path.
      if (!initial) await this.original.start();
      this.assertAdmission(task);
      if (this.acquisitions.has(threadId)) throw new ActionRejectedError("Подключение к задаче уже выполняется.");
      const session = this.original.currentInitializedSession?.();
      if (!session || options.expectedGeneration !== undefined && options.expectedGeneration !== session.generation)
        throw new AppServerUnavailableError();
      acquisition = { token: Symbol(threadId), generation: session.generation, state: "pending" };
      const attempts = this.acquisitions.get(threadId) ?? new Set<AcquisitionAttempt>();
      attempts.add(acquisition); this.acquisitions.set(threadId, attempts); this.changedAcquisition(threadId);
    }
    const drain = threadId ? this.drains.get(threadId) : undefined;
    const controlledRelease = method === "thread/unsubscribe" && drain?.state === "checking";
    let dispatched = false;
    let definitiveRejection = false;
    if (threadId && writer) this.changeBusy(threadId, 1);
    let generation = acquisition?.generation ?? options.expectedGeneration ?? this.original.currentInitializedSession?.()?.generation;
    const guarded = { ...options,
      ...(method === "thread/resume" ? { mutating: true } : {}),
      ...(acquisition ? { expectedGeneration: acquisition.generation } : {}),
      ...(drain ? { expectedGeneration: drain.generation } : {}),
      onResponseEnvelope: (envelope: import("./app-server-connection.js").AppServerResponseEnvelope) => {
        const error = "error" in envelope ? envelope.error : null;
        definitiveRejection = object(error) && Number.isSafeInteger(error.code) && typeof error.message === "string";
        options.onResponseEnvelope?.(envelope);
      },
      ...(acquisition ? { onLateResponseEnvelope: (envelope: import("./app-server-connection.js").AppServerResponseEnvelope) => {
        if (threadId && acquisition && this.acquisitions.get(threadId)?.has(acquisition)
          && this.current(acquisition.generation)) {
          if ("result" in envelope && this.validResume(envelope.result, threadId)) {
            acquisition.state = "abandoned"; this.changedAcquisition(threadId);
          }
          else if ("error" in envelope && object(envelope.error)
            && Number.isSafeInteger(envelope.error.code)
            && typeof envelope.error.message === "string") this.forgetAcquisition(threadId, acquisition);
        }
        options.onLateResponseEnvelope?.(envelope);
      } } : {}),
      assertBeforeWrite: () => {
        options.assertBeforeWrite?.();
        if (threadId && acquisition) {
          this.assertAdmissionExcept({ hostId: "local", threadId }, acquisition);
          if (!this.current(acquisition.generation) || !this.acquisitions.get(threadId)?.has(acquisition))
            throw new AppServerUnavailableError();
        }
        if (threadId && writer && method !== "turn/interrupt" && !acquisition
          && this.hasOtherAcquisition(threadId))
          throw new ActionRejectedError("Исход подключения к задаче ещё не подтверждён; команда не отправлена.");
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
      if (threadId && acquisition) {
        if (!this.validResume(result, threadId) || !this.current(acquisition.generation)) throw new AppServerUnavailableError();
        this.acquired.set(threadId, acquisition.generation);
        this.forgetAcquisition(threadId, acquisition);
      }
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
      if (threadId && acquisition) {
        if (!dispatched || error instanceof AppServerRejectedError && definitiveRejection)
          this.forgetAcquisition(threadId, acquisition);
        else if (acquisition.state === "pending") { acquisition.state = "unknown"; this.changedAcquisition(threadId); }
      } else if (threadId && writer && dispatched && !(error instanceof AppServerRejectedError && definitiveRejection)) this.unknown.add(threadId);
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
    if (event.method === "thread/closed" && scopeValid && drain && this.current(drain.generation)) {
      drain.unloaded = true;
      if (drain.state === "waiting-unload" || drain.state === "unavailable") drain.state = "released";
      if (drain.state === "released") this.clearDiagnostic(threadId);
    }
    if (event.method === "turn/completed" && object(event.params.turn)
      && ["completed", "failed", "interrupted"].includes(String(event.params.turn.status))) {
      const turnId = id(event.params.turn.id);
      this.receipts.set(threadId, (this.receipts.get(threadId) ?? []).filter(value => value.turnId !== turnId));
    }
  }
  private async read(method: string, params: ObjectValue, generation: number, deadline: number): Promise<ObjectValue> {
    const remaining = deadline - performance.now();
    if (!this.current(generation)) throw new DrainDiagnosticError("generation-mismatch");
    if (remaining <= 0) throw new DrainDiagnosticError("read-failure");
    let result: ObjectValue;
    try {
      result = await this.original.request(method, params, { expectedGeneration: generation, timeoutMs: Math.min(5_000, Math.ceil(remaining)) });
    } catch {
      throw new DrainDiagnosticError(this.current(generation) ? "read-failure" : "generation-mismatch");
    }
    if (!this.current(generation)) throw new DrainDiagnosticError("generation-mismatch");
    if (performance.now() >= deadline) throw new DrainDiagnosticError("read-failure");
    return result;
  }
  private async family(root: string, generation: number, deadline: number): Promise<string[]> {
    const values: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGINATION_PAGES; pageNumber++) {
      const page = await this.read("thread/list", { ancestorThreadId: root, archived: false, limit: 100,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact",
          "subAgentThreadSpawn", "subAgentOther", "unknown"], ...(cursor ? { cursor } : {}) }, generation, deadline);
      if (!Array.isArray(page.data) || page.data.length > 100)
        throw new DrainDiagnosticError("family-pagination-incomplete", root);
      for (const value of page.data) values.push(object(value) ? id(value.id) ?? "" : "");
      if (page.nextCursor === null) {
        if (values.some(value => !value || value === root) || new Set(values).size !== values.length)
          throw new DrainDiagnosticError("family-pagination-incomplete", root);
        return values.sort();
      }
      if (typeof page.nextCursor !== "string" || !page.nextCursor || seenCursors.has(page.nextCursor))
        throw new DrainDiagnosticError("family-pagination-incomplete", root);
      seenCursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new DrainDiagnosticError("family-pagination-incomplete", root);
  }
  private async terminalReceipts(threadId: string, generation: number, activeTurnId: string | null, deadline: number): Promise<boolean> {
    const receipts: WorkReceipt[] = [];
    const receiptKeys = new Set<string>();
    for (const receipt of [...(this.receipts.get(threadId) ?? []), ...(activeTurnId ? [{ turnId: activeTurnId }] : [])]) {
      const key = receipt.turnId ? `turn:${receipt.turnId}` : `client:${receipt.clientId ?? ""}`;
      if (!receiptKeys.has(key)) { receiptKeys.add(key); receipts.push(receipt); }
    }
    if (!receipts.length) return true;
    const matches = new Map<WorkReceipt, ObjectValue | null>(receipts.map(receipt => [receipt, null]));
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGINATION_PAGES; pageNumber++) {
      const page = await this.read("thread/turns/list", {
        threadId, limit: 100, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}),
      }, generation, deadline);
      if (!Array.isArray(page.data)) throw new DrainDiagnosticError("receipt-unknown", threadId);
      for (const receipt of receipts) {
        const pageMatches = (page.data as unknown[]).filter(turn => object(turn) &&
          (receipt.turnId ? turn.id === receipt.turnId : Array.isArray(turn.items) && turn.items.some(item =>
            object(item) && item.type === "userMessage" && item.clientId === receipt.clientId)));
        if (pageMatches.length > 1) throw new DrainDiagnosticError("receipt-unknown", threadId);
        if (pageMatches.length === 1) {
          if (matches.get(receipt) !== null) throw new DrainDiagnosticError("receipt-unknown", threadId);
          matches.set(receipt, pageMatches[0] as ObjectValue);
        }
      }
      const nextCursor = page.nextCursor;
      const allDirectTerminal = receipts.every(receipt => receipt.turnId
        && matches.get(receipt) !== null
        && ["completed", "failed", "interrupted"].includes(String(matches.get(receipt)?.status)));
      const hasClientReceipt = receipts.some(receipt => !receipt.turnId);
      if (nextCursor === null) {
        return receipts.every(receipt => matches.get(receipt) !== null
          && ["completed", "failed", "interrupted"].includes(String(matches.get(receipt)?.status)));
      }
      if (typeof nextCursor !== "string" || !nextCursor || seenCursors.has(nextCursor))
        throw new DrainDiagnosticError("receipt-unknown", threadId);
      if (allDirectTerminal && !hasClientReceipt) return true;
      seenCursors.add(nextCursor); cursor = nextCursor;
    }
    throw new DrainDiagnosticError("receipt-unknown", threadId);
  }
  private async refreshWaiting(task: TaskRef, drain: Drain,
    local: () => { readonly activeTurnId: string | null; readonly blocked: boolean; readonly releasePending?: boolean },
    subscription: () => { readonly count: number; readonly revision: number }): Promise<ExecutionDrainResult> {
    const generation = drain.generation;
    const scoped = subscription();
    const revision = this.revision;
    const unscopedRevision = this.unscopedRevision;
    const safe = () => this.drains.get(task.threadId) === drain && drain.state === "waiting-unload"
      && this.current(generation) && subscription().count === 0 && subscription().revision === scoped.revision
      && !local().blocked && !local().releasePending
      && !this.busy.has(task.threadId) && !this.unknown.has(task.threadId)
      && !this.busy.has("__unscoped_server_request__") && !this.unknown.has("__unscoped_server_request__")
      && !(drain.family ?? [task.threadId]).some(threadId => this.hasOtherAcquisition(threadId))
      && !this.changedSince(drain.family ?? [task.threadId], revision, unscopedRevision);
    if (!safe()) {
      if (!this.current(generation)) this.setDiagnostic(task.threadId, "generation-mismatch", task.threadId);
      return !this.current(generation) || this.drains.get(task.threadId) !== drain
        ? "unavailable" : drain.state === "released" ? "released" : "waiting-unload";
    }
    drain.nextRefreshAt = this.now() + UNLOAD_READBACK_INTERVAL_MS;
    this.setDiagnostic(task.threadId, "unload-retention-window", task.threadId, drain.nextRefreshAt);
    try {
      const response = await this.original.request("thread/read", { threadId: task.threadId, includeTurns: false },
        { expectedGeneration: generation, timeoutMs: 5_000,
          assertBeforeWrite: () => { if (!safe()) throw new AppServerUnavailableError(); } });
      const thread = object(response.thread) ? response.thread : null;
      if (safe() && thread?.id === task.threadId && object(thread.status) && thread.status.type === "notLoaded") {
        drain.unloaded = true;
        drain.state = "released";
      }
    } catch {
      this.setDiagnostic(task.threadId, "read-failure", task.threadId, drain.nextRefreshAt);
      /* A failed metadata read cannot prove unload. */
    }
    if (!this.current(generation) || this.drains.get(task.threadId) !== drain) {
      this.setDiagnostic(task.threadId, "generation-mismatch", task.threadId);
      return "unavailable";
    }
    if (drain.state === "released") { this.clearDiagnostic(task.threadId); return "released"; }
    return "waiting-unload";
  }
  async drain(task: TaskRef, beforeRelease: () => void,
    local: () => { readonly activeTurnId: string | null; readonly blocked: boolean; readonly releasePending?: boolean },
    subscription: () => { readonly count: number; readonly revision: number },
    assertScope: () => void = () => {}): Promise<ExecutionDrainResult> {
    const existing = this.drains.get(task.threadId);
    if (existing) {
      if (!this.current(existing.generation)) {
        this.setDiagnostic(task.threadId, "generation-mismatch", task.threadId);
        return "unavailable";
      }
      if (existing.state !== "waiting-unload") {
        if (existing.state === "checking") return this.blocked(task, "active-local", task.threadId);
        return existing.state;
      }
      if (existing.refresh) return existing.refresh;
      if (existing.nextRefreshAt === undefined || this.now() < existing.nextRefreshAt) {
        this.setDiagnostic(task.threadId, "unload-retention-window", task.threadId, existing.nextRefreshAt);
        return "waiting-unload";
      }
      const refresh = this.refreshWaiting(task, existing, local, subscription);
      existing.refresh = refresh;
      try { return await refresh; } finally { if (existing.refresh === refresh) delete existing.refresh; }
    }
    const session = this.original.currentInitializedSession?.();
    const attempts = [...(this.acquisitions.get(task.threadId) ?? [])];
    const orphan = attempts.length === 1 && attempts[0]?.state === "abandoned" ? attempts[0] : null;
    if (attempts.length && !orphan) return this.blocked(task, "unknown-local", task.threadId);
    if (!session || !orphan && this.acquired.get(task.threadId) !== session.generation) {
      this.setDiagnostic(task.threadId, "generation-mismatch", task.threadId);
      return "unavailable";
    }
    if (orphan && orphan.generation !== session.generation) {
      this.setDiagnostic(task.threadId, "generation-mismatch", task.threadId);
      return "unavailable";
    }
    const generation = session.generation;
    const scoped = subscription();
    const localState = local();
    if (scoped.count !== (orphan ? 0 : 1)) return this.blocked(task, "active-local", task.threadId);
    if (localState.blocked || localState.releasePending || this.busy.has(task.threadId))
      return this.blocked(task, "active-local", task.threadId);
    if (this.unknown.has(task.threadId) || this.busy.has("__unscoped_server_request__") || this.unknown.has("__unscoped_server_request__"))
      return this.blocked(task, "unknown-local", task.threadId);
    const drain: Drain = { generation, state: "checking", unloaded: false, release: null };
    this.drains.set(task.threadId, drain);
    const revision = this.revision;
    const unscopedRevision = this.unscopedRevision;
    const deadline = performance.now() + 20_000;
    let closing = false;
    try {
      const family = [task.threadId, ...await this.family(task.threadId, generation, deadline)];
      for (const threadId of family) {
        if (this.busy.has(threadId) || this.hasOtherAcquisition(threadId, threadId === task.threadId ? orphan ?? undefined : undefined))
          return this.blocked(task, threadId === task.threadId ? "active-local" : "child-active", threadId);
        if (this.unknown.has(threadId))
          return this.blocked(task, threadId === task.threadId ? "unknown-local" : "child-active", threadId);
        const response = await this.read("thread/read", { threadId, includeTurns: false }, generation, deadline);
        const thread = object(response.thread) && response.thread.id === threadId ? response.thread : null;
        if (!thread || !object(thread.status)) throw new DrainDiagnosticError("read-failure", threadId);
        // notLoaded on a separate child reader cannot prove another writer idle.
        if (thread.status.type !== "idle")
          return this.blocked(task, thread.status.type === "active"
            ? threadId === task.threadId ? "active-local" : "child-active" : "read-failure", threadId);
        const goal = await this.read("thread/goal/get", { threadId }, generation, deadline);
        if (goal.goal !== null && (!object(goal.goal) || !["paused", "complete", "blocked", "usageLimited", "budgetLimited"]
          .includes(String(goal.goal.status)))) return this.blocked(task, "goal-active", threadId);
        const queue = await this.read("thread/queue/list", { threadId }, generation, deadline);
        if (!Array.isArray(queue.data) || queue.nextCursor !== null) throw new DrainDiagnosticError("read-failure", threadId);
        if (queue.data.length) return this.blocked(task, "queue-pending", threadId);
        if (!await this.terminalReceipts(threadId, generation,
          threadId === task.threadId ? local().activeTurnId : null, deadline))
          return this.blocked(task, "receipt-unknown", threadId);
      }
      const confirmed = await this.family(task.threadId, generation, deadline);
      if (JSON.stringify(confirmed) !== JSON.stringify(family.slice(1)))
        return this.blocked(task, "family-pagination-incomplete", task.threadId);
      assertScope();
      if (performance.now() >= deadline || !this.current(generation) || this.changedSince(family, revision, unscopedRevision) || local().blocked
        || local().releasePending
        || family.some(threadId => this.busy.has(threadId) || this.unknown.has(threadId)
          || this.hasOtherAcquisition(threadId, threadId === task.threadId ? orphan ?? undefined : undefined))
        || subscription().count !== (orphan ? 0 : 1) || subscription().revision !== scoped.revision
        || orphan && this.pendingLegacyAcquisition(task) !== orphan.token) {
        this.setDiagnostic(task.threadId, !this.current(generation) ? "generation-mismatch" : "unknown-local", task.threadId);
        return "blocked";
      }
      drain.assertRelease = () => {
        assertScope();
        if (performance.now() >= deadline || !this.current(generation) || this.changedSince(family, revision, unscopedRevision)
          || local().blocked || orphan && local().releasePending || subscription().count !== 0
          || this.busy.has("__unscoped_server_request__") || this.unknown.has("__unscoped_server_request__")
          || family.some(threadId => this.busy.has(threadId) || this.unknown.has(threadId)
            || this.hasOtherAcquisition(threadId, threadId === task.threadId ? orphan ?? undefined : undefined))
          || orphan && (this.pendingLegacyAcquisition(task) !== orphan.token || subscription().revision !== scoped.revision))
          throw new AppServerUnavailableError();
      };
      drain.family = family;
      closing = true;
      beforeRelease(); // No await: exact binding/stream validation and close are atomic with admission revocation.
      if (orphan) void this.rpc.request("thread/unsubscribe", { threadId: task.threadId },
        { expectedGeneration: generation, timeoutMs: 30_000 }).catch(() => {});
      if (!drain.release || subscription().count !== 0) {
        drain.state = "unavailable"; this.setDiagnostic(task.threadId, "read-failure", task.threadId); return "unavailable";
      }
      const release = await drain.release;
      if (orphan) this.forgetAcquisition(task.threadId, orphan);
      drain.state = !this.current(generation) ? "unavailable" : drain.unloaded ? "released" : "waiting-unload";
      if (drain.state === "waiting-unload" && release.status === "unsubscribed") {
        drain.nextRefreshAt = this.now() + UNLOAD_READBACK_INTERVAL_MS;
        this.setDiagnostic(task.threadId, "unload-retention-window", task.threadId, drain.nextRefreshAt);
      } else if (drain.state === "released") this.clearDiagnostic(task.threadId);
      return drain.state;
    } catch (error) {
      if (closing && drain.unloaded && this.current(generation)) {
        drain.state = "released"; this.clearDiagnostic(task.threadId); return "released";
      }
      drain.state = "unavailable";
      const reason = error instanceof DrainDiagnosticError ? error.diagnosticReason
        : !this.current(generation) ? "generation-mismatch" : "read-failure";
      this.setDiagnostic(task.threadId, reason, error instanceof DrainDiagnosticError ? error.subjectThreadId : task.threadId);
      return drain.state;
    }
    finally { if (!closing) this.drains.delete(task.threadId); }
  }
  close(): void { this.unsubscribe(); }
}
