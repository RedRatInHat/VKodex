import type { CodexQuestions } from "./codex-questions.js";
import { ActionRejectedError, DesktopUnavailableError, NativeGoalReceiptUnavailableError, TaskOwnedByClientError, type AccountUsage, type CodexTasks, type CreateTaskRequest, type DesktopCompatibility,
  type DesktopModel, type DesktopProject, type DesktopSource, type DesktopTask, type EditLastUserTurnRequest,
  type EditLastUserTurnResult, type QueuedSubmissionOutcome, type SubmitTaskReceipt, type SubmitTaskRequest, type TaskCreationUpdate,
  type TaskDetails, type TaskGoal, type TaskGoalUpdate, type TaskRef, type TaskRenameResult,
  type TransferCheckpoint, type TransferTaskRequest, type UsageResetOutcome, type GoalContinuationReceipt,
  type NativeGoalActivation, type ExecutionDrainResult } from "./codex-tasks.js";

export interface CodexTaskOwner {
  /** An exclusive claim is independent of transient adapter readiness. */
  readonly routingPolicy?: "exclusive";
  /** Health evidence only; never used to select or authorize a command route. */
  isReady?(task: TaskRef): boolean;
  ownerAdapterStatus?(task: TaskRef): Promise<"ready" | "missing" | "unknown">;
  drainIdleExecution?(task: TaskRef, beforeRelease: () => void): Promise<ExecutionDrainResult>;
  restoreExecutionDrain?(task: TaskRef): void;
  owns(task: TaskRef): boolean;
  /** Original immutable operation route, independent of fresh command ownership. */
  ownsOperation?(task: TaskRef, operationId: string): boolean;
  /** Ensure this owner's route is ready without starting a turn. */
  ensureOpen?(task: TaskRef): Promise<void>;
  submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt>;
  interrupt(task: TaskRef): Promise<void>;
  queue(request: SubmitTaskRequest): Promise<string>;
  selectModel(task: TaskRef, model: string, effort: string): Promise<void>;
  renameTask(task: TaskRef, title: string): Promise<TaskRenameResult>;
  moveTask(task: TaskRef, projectId: string | null): Promise<void>;
  getGoal(task: TaskRef): Promise<TaskGoal | null>;
  setGoal(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal>;
  clearGoal(task: TaskRef): Promise<boolean>;
  /** Same-owner native goal activation with a goal-turn receipt. */
  activateGoalWithReceipt?(task: TaskRef, operationId: string): Promise<NativeGoalActivation>;
  /** Must confirm a continuation turn or an already running turn. */
  continueGoal?(task: TaskRef, operationId: string): Promise<GoalContinuationReceipt>;
  pendingQuestions(task: TaskRef): Promise<readonly CodexQuestions[]>;
  answerQuestions(task: TaskRef, question: CodexQuestions, answers: Readonly<Record<string, string>>,
    operationId: string, beforeSend: () => Promise<void>): Promise<void>;
  findAcceptedInput(task: TaskRef, operationId: string): Promise<string | null>;
  scanTerminalQueuedInput?(task: TaskRef, clientId: string,
    cursor: import("./codex-tasks.js").QueuedInputHistoryCursor | null):
    Promise<import("./codex-tasks.js").QueuedInputHistoryScan>;
  findQueuedSubmission?(task: TaskRef, operationId: string): Promise<string | null>;
  findQueuedSubmissionOutcome?(task: TaskRef, operationId: string): Promise<QueuedSubmissionOutcome | null>;
  inspectTask(task: TaskRef): Promise<TaskDetails>;
  archiveTask(task: TaskRef): Promise<void>;
  archiveRetryReady(task: TaskRef): Promise<boolean>;
}

/** Routes execution-sensitive commands to the one configured owner of a source. */
export class RoutedCodexTasks implements CodexTasks {
  constructor(private readonly base: CodexTasks, private readonly owners: readonly CodexTaskOwner[]) {}
  private owner(task: TaskRef): CodexTaskOwner | undefined {
    const exclusive = this.owners.filter(owner => owner.routingPolicy === "exclusive" && owner.owns(task));
    if (exclusive.length > 1) throw new ActionRejectedError("Для задачи найдено несколько исключительных владельцев.");
    return exclusive[0] ?? this.owners.find(owner => owner.routingPolicy !== "exclusive" && owner.owns(task));
  }
  private operationOwner(task: TaskRef, operationId: string): CodexTaskOwner | undefined {
    const original = this.owners.filter(owner => owner.ownsOperation?.(task, operationId) === true);
    if (original.length > 1) throw new ActionRejectedError("Неоднозначный исходный исполнитель операции.");
    return original[0] ?? this.owner(task);
  }
  private refuseExclusive(task: TaskRef): void {
    if (this.owner(task)?.routingPolicy === "exclusive")
      this.unsupportedExclusive();
  }
  private unsupportedExclusive(): never {
    throw new ActionRejectedError("Этот маршрут пока не поддерживается исключительным владельцем задачи.");
  }
  get capabilities() { return this.base.capabilities; }
  listTasks(): Promise<readonly DesktopTask[]> { return this.base.listTasks(); }
  listSources(): readonly DesktopSource[] { return this.base.listSources?.() ?? []; }
  listProjects(sourceId?: string): Promise<readonly DesktopProject[]> { return this.base.listProjects(sourceId); }
  catalogWarnings(): readonly string[] { return this.base.catalogWarnings?.() ?? []; }
  createProject(sourceId: string, name: string, roots: readonly string[], idempotencyKey: string): Promise<DesktopProject> {
    if (!this.base.createProject) throw new ActionRejectedError("Создание проекта недоступно в этом подключении.");
    return this.base.createProject(sourceId, name, roots, idempotencyKey);
  }
  createTask(request: CreateTaskRequest): Promise<DesktopTask> { return this.base.createTask(request); }
  async submit(request: SubmitTaskRequest): Promise<void> { await this.submitWithReceipt(request); }
  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    const owner = this.owner(request.task);
    if (!owner) return this.base.submitWithReceipt?.(request) ?? this.base.submit(request).then(() => ({ mode: "start" as const, turnId: null }));
    try { return await owner.submitWithReceipt(request); }
    catch (error) {
      if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error;
      if (!this.base.submitConnectedWithReceipt) throw new ActionRejectedError("Задача открыта в Codex, но её активное подключение недоступно. Повтори после восстановления клиента.");
      return this.base.submitConnectedWithReceipt(request);
    }
  }
  async findAcceptedInput(task: TaskRef, operationId: string): Promise<string | null> {
    const owner = this.operationOwner(task, operationId);
    if (owner) {
      try {
        const accepted = await owner.findAcceptedInput(task, operationId);
        if (owner.routingPolicy === "exclusive" || accepted) return accepted;
      } catch (error) {
        if (owner.routingPolicy === "exclusive") throw error;
      }
    }
    return this.base.findAcceptedInput?.(task, operationId) ?? null;
  }
  async scanTerminalQueuedInput(task: TaskRef, clientId: string,
    cursor: import("./codex-tasks.js").QueuedInputHistoryCursor | null):
    Promise<import("./codex-tasks.js").QueuedInputHistoryScan> {
    const owner = this.operationOwner(task, clientId);
    if (owner?.routingPolicy === "exclusive" && !owner.scanTerminalQueuedInput)
      throw new DesktopUnavailableError("Сверка терминальной истории недоступна для этого исполнителя.");
    if (owner?.scanTerminalQueuedInput) return owner.scanTerminalQueuedInput(task, clientId, cursor);
    if (!this.base.scanTerminalQueuedInput)
      throw new DesktopUnavailableError("Сверка терминальной истории недоступна для этого исполнителя.");
    return this.base.scanTerminalQueuedInput(task, clientId, cursor);
  }
  async findQueuedSubmission(task: TaskRef, operationId: string): Promise<string | null> {
    const owner = this.operationOwner(task, operationId);
    if (owner) {
      const queued = await owner.findQueuedSubmission?.(task, operationId) ?? null;
      if (owner.routingPolicy === "exclusive" || queued) return queued;
    }
    return this.base.findQueuedSubmission?.(task, operationId) ?? null;
  }
  async findQueuedSubmissionOutcome(task: TaskRef, operationId: string): Promise<QueuedSubmissionOutcome | null> {
    const owner = this.operationOwner(task, operationId);
    if (owner) {
      const outcome = await owner.findQueuedSubmissionOutcome?.(task, operationId) ?? null;
      if (owner.routingPolicy === "exclusive" || outcome) return outcome;
    }
    return this.base.findQueuedSubmissionOutcome?.(task, operationId) ?? null;
  }
  async editLastUserTurn(request: EditLastUserTurnRequest): Promise<EditLastUserTurnResult> {
    const owner = this.owner(request.task);
    if (owner?.routingPolicy === "exclusive") this.unsupportedExclusive();
    if (!this.base.editLastUserTurn) throw new ActionRejectedError("Редактирование последнего хода недоступно.");
    // This path attaches only to an already-open native UI owner and validates
    // the exact latest turn/operation before its targeted edit. A read-only
    // profile-owner inspect is not proof that such a UI owner is absent.
    return this.base.editLastUserTurn(request);
  }
  async interrupt(task: TaskRef): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.interrupt(task);
    try { return await owner.interrupt(task); }
    catch (error) { if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error; return this.base.interrupt(task); }
  }
  async queue(request: SubmitTaskRequest): Promise<string> {
    const owner = this.owner(request.task);
    if (owner) {
      try { return await owner.queue(request); }
      catch (error) {
        if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error;
        if (!this.base.queue) throw new ActionRejectedError("Штатная очередь активного клиента недоступна.");
        return this.base.queue(request);
      }
    }
    if (!this.base.queue) throw new ActionRejectedError("Штатная очередь недоступна."); return this.base.queue(request);
  }
  async pendingQuestions(task: TaskRef): Promise<readonly CodexQuestions[]> {
    const owner = this.owner(task);
    if (owner) {
      try { await owner.inspectTask(task); return owner.pendingQuestions(task); }
      catch (error) {
        if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error;
        return this.base.pendingQuestions?.(task) ?? [];
      }
    }
    return this.base.pendingQuestions?.(task) ?? Promise.resolve([]);
  }
  async answerQuestions(task: TaskRef, question: CodexQuestions, answers: Readonly<Record<string, string>>,
    operationId: string, beforeSend: () => Promise<void>): Promise<void> {
    const owner = this.owner(task);
    if (owner) {
      try { await owner.inspectTask(task); return owner.answerQuestions(task, question, answers, operationId, beforeSend); }
      catch (error) {
        if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error;
        if (!this.base.answerQuestions) throw new ActionRejectedError("Ответы на вопросы активного клиента недоступны.");
        return this.base.answerQuestions(task, question, answers, operationId, beforeSend);
      }
    }
    if (!this.base.answerQuestions) throw new ActionRejectedError("Ответы на вопросы Codex недоступны.");
    return this.base.answerQuestions(task, question, answers, operationId, beforeSend);
  }
  async inspectTask(task: TaskRef): Promise<TaskDetails> {
    const owner = this.owner(task); if (!owner) return this.base.inspectTask(task);
    try {
      const details = await owner.inspectTask(task);
      // `notLoaded` from the configured profile connection does not make an
      // externally open task unavailable. The connected desktop adapter can
      // still read the active client's authoritative state without taking its
      // writer, which is exactly the fallback used for an ownership rejection.
      return owner.routingPolicy !== "exclusive" && details.status === "unavailable" ? this.base.inspectTask(task) : details;
    }
    catch (error) { if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error; return this.base.inspectTask(task); }
  }
  async selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.selectModel(task, model, effort);
    try { return await owner.selectModel(task, model, effort); }
    catch (error) { if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error; return this.base.selectModel(task, model, effort); }
  }
  listModels(task?: TaskRef): Promise<readonly DesktopModel[]> { return this.base.listModels(task); }
  async moveTask(task: TaskRef, projectId: string | null): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.moveTask(task, projectId);
    try { return await owner.moveTask(task, projectId); }
    catch (error) { if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error; return this.base.moveTask(task, projectId); }
  }
  async transferTask(request: TransferTaskRequest): Promise<DesktopTask> {
    this.refuseExclusive(request.task);
    if (request.existingTarget) this.refuseExclusive(request.existingTarget);
    if (!this.base.transferTask) throw new ActionRejectedError("Перенос задач недоступен."); return this.base.transferTask(request);
  }
  async transferCheckpoint(task: TaskRef): Promise<TransferCheckpoint> {
    this.refuseExclusive(task);
    if (!this.base.transferCheckpoint) throw new ActionRejectedError("Проверка переноса недоступна."); return this.base.transferCheckpoint(task);
  }
  async verifyTransferSource(task: TaskRef, checkpoint: TransferCheckpoint): Promise<void> {
    this.refuseExclusive(task);
    if (!this.base.verifyTransferSource) throw new ActionRejectedError("Проверка источника переноса недоступна."); return this.base.verifyTransferSource(task, checkpoint);
  }
  async verifyTransferTarget(request: TransferTaskRequest, target: DesktopTask): Promise<void> {
    this.refuseExclusive(request.task); this.refuseExclusive(target);
    if (!this.base.verifyTransferTarget) throw new ActionRejectedError("Проверка назначения переноса недоступна."); return this.base.verifyTransferTarget(request, target);
  }
  async verifyArchivedPair(source: TaskRef, target: DesktopTask, checkpoint: TransferCheckpoint): Promise<void> {
    this.refuseExclusive(source); this.refuseExclusive(target);
    if (!this.base.verifyArchivedPair) throw new ActionRejectedError("Проверка архивного переноса недоступна.");
    return this.base.verifyArchivedPair(source, target, checkpoint);
  }
  async isTaskArchived(task: TaskRef, checkpoint?: TransferCheckpoint): Promise<boolean> {
    this.refuseExclusive(task);
    return this.base.isTaskArchived?.(task, checkpoint) ?? Promise.resolve(false);
  }
  async archiveRetryReady(task: TaskRef): Promise<boolean> {
    const owner = this.owner(task);
    return owner?.archiveRetryReady(task) ?? this.base.archiveRetryReady?.(task) ?? Promise.resolve(false);
  }
  async ownerAdapterStatus(task: TaskRef): Promise<"ready" | "missing" | "unknown"> {
    const owner = this.owner(task);
    if (owner?.routingPolicy === "exclusive") {
      try { return Promise.resolve(owner.isReady?.(task) === true ? "ready" : "missing"); }
      catch { return Promise.resolve("missing"); }
    }
    if (owner) return owner.ownerAdapterStatus?.(task) ?? "unknown";
    return this.base.ownerAdapterStatus?.(task) ?? "missing";
  }
  async drainIdleExecution(task: TaskRef, beforeRelease: () => void): Promise<ExecutionDrainResult> {
    // A metadata reader or another client cannot attest the original writer.
    return this.owner(task)?.drainIdleExecution?.(task, beforeRelease) ?? "unavailable";
  }
  executionDrainSupported(task: TaskRef): boolean {
    const owner = this.owner(task);
    return !!owner?.drainIdleExecution && owner.routingPolicy !== "exclusive";
  }
  restoreExecutionDrain(task: TaskRef): void {
    const owner = this.owner(task);
    if (owner?.routingPolicy !== "exclusive") owner?.restoreExecutionDrain?.(task);
  }
  async renameTask(task: TaskRef, title: string): Promise<TaskRenameResult> {
    const owner = this.owner(task); if (!owner) return this.base.renameTask(task, title);
    try { return await owner.renameTask(task, title); }
    catch (error) { if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error; return this.base.renameTask(task, title); }
  }
  async archiveTask(task: TaskRef): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.archiveTask(task);
    try { return await owner.archiveTask(task); }
    catch (error) { if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error; return this.base.archiveTask(task); }
  }
  async archiveTransferredSource(task: TaskRef): Promise<void> {
    this.refuseExclusive(task);
    const owner = this.owner(task);
    if (owner) {
      try { return await owner.archiveTask(task); }
      catch (error) {
        if (!(error instanceof TaskOwnedByClientError)) throw error;
      }
    }
    if (!this.base.archiveTransferredSource) throw new ActionRejectedError("Архивация источника переноса недоступна.");
    return this.base.archiveTransferredSource(task);
  }
  async exportMarkdown(task: TaskRef): Promise<string> { this.refuseExclusive(task); return this.base.exportMarkdown(task); }
  accountUsage(task?: TaskRef): Promise<readonly AccountUsage[]> {
    if (!this.base.accountUsage) throw new ActionRejectedError("Лимиты аккаунта недоступны."); return this.base.accountUsage(task);
  }
  consumeUsageReset(task: TaskRef, idempotencyKey: string): Promise<UsageResetOutcome> {
    if (!this.base.consumeUsageReset) throw new ActionRejectedError("Сброс лимита недоступен."); return this.base.consumeUsageReset(task, idempotencyKey);
  }
  async getGoal(task: TaskRef): Promise<TaskGoal | null> {
    const owner = this.owner(task);
    if (!owner) return this.base.getGoal?.(task) ?? null;
    try { return await owner.getGoal(task); }
    catch (error) {
      // Some native versions reject goal/get for an archived thread. Only an
      // exact archived state authorizes the base adapter's read-only goal DB
      // fallback; never mask an error for a live task.
      if (owner.routingPolicy === "exclusive" || !(error instanceof ActionRejectedError) || !this.base.getGoal || !this.base.isTaskArchived
        || !await this.base.isTaskArchived(task)) throw error;
      return this.base.getGoal(task);
    }
  }
  async healthGoal(task: TaskRef): Promise<TaskGoal | null> {
    const owner = this.owner(task);
    if (owner?.routingPolicy === "exclusive") return owner.getGoal(task);
    // Health probes run in the base adapter's short-lived read-only process.
    // They must never stall or reset the long-lived profile writer used by VK.
    return this.base.healthGoal?.(task) ?? this.base.getGoal?.(task) ?? Promise.resolve(null);
  }
  async setGoal(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> {
    const owner = this.owner(task);
    if (owner) return owner.setGoal(task, update);
    if (!this.base.setGoal) throw new ActionRejectedError("Управление целью недоступно."); return this.base.setGoal(task, update);
  }
  async clearGoal(task: TaskRef): Promise<boolean> {
    const owner = this.owner(task); return owner?.clearGoal(task) ?? this.base.clearGoal?.(task) ?? Promise.resolve(false);
  }
  async prepareGoalRuntime(task: TaskRef): Promise<void> {
    const owner = this.owner(task);
    // The base metadata adapter launches a short-lived App Server. Its
    // thread/goal/set response can persist `active`, but that process closes
    // before the best-effort native goal loop can run. Never advertise a
    // resumable goal without a persistent selected runtime.
    if (!owner) throw new ActionRejectedError("Для задачи не назначен постоянный исполнитель цели; продолжи её в открытом Codex.");
    if (owner.routingPolicy === "exclusive") this.unsupportedExclusive();
    if (!owner.ensureOpen) throw new ActionRejectedError("Нативный исполнитель цели недоступен в этом подключении.");
    try { await owner.ensureOpen(task); }
    catch (error) {
      // A different UI host owns the live goal runtime. Updating profile
      // SQLite here would show an active goal without triggering that host.
      if (error instanceof TaskOwnedByClientError)
        throw new ActionRejectedError("Задача открыта в другом клиенте Codex; продолжи цель в нём или дождись освобождения задачи.");
      throw error;
    }
  }
  async activateGoalWithReceipt(task: TaskRef, operationId: string): Promise<NativeGoalActivation> {
    const owner = this.owner(task);
    if (!owner) throw new ActionRejectedError("Для задачи не назначен постоянный исполнитель цели; продолжи её в открытом Codex.");
    if (owner?.routingPolicy === "exclusive") this.unsupportedExclusive();
    if (!owner.activateGoalWithReceipt) throw new NativeGoalReceiptUnavailableError();
    return owner.activateGoalWithReceipt(task, operationId);
  }
  async continueGoal(task: TaskRef, operationId: string): Promise<GoalContinuationReceipt> {
    const owner = this.owner(task);
    if (owner?.routingPolicy === "exclusive") this.unsupportedExclusive();
    if (owner) {
      if (!owner.continueGoal) throw new ActionRejectedError("Автоматическое продолжение цели недоступно для этого владельца задачи.");
      return owner.continueGoal(task, operationId);
    }
    if (!this.base.continueGoal) throw new ActionRejectedError("Автоматическое продолжение цели недоступно в этом подключении.");
    return this.base.continueGoal(task, operationId);
  }
  async revealTask(task: TaskRef): Promise<void> { this.refuseExclusive(task); return this.base.revealTask?.(task) ?? Promise.resolve(); }
  async ensureOpen(task: TaskRef): Promise<void> {
    const owner = this.owner(task);
    if (owner) {
      if (owner.routingPolicy === "exclusive") {
        if (!owner.ensureOpen) this.unsupportedExclusive();
        return owner.ensureOpen(task);
      }
      try {
        // A stored task reports `notLoaded` until this profile App Server
        // resumes it. Transfer targets need that ownership before their idle
        // state can be verified; a read-only inspection can never make the
        // target ready on a later retry.
        if (owner.ensureOpen) await owner.ensureOpen(task);
        else await owner.inspectTask(task);
      }
      catch (error) {
        // An active-writer rejection is positive evidence that the selected
        // task is already open in another Codex client. Do not launch/focus a
        // UI and then wait for the retired follower adapter to rediscover it.
        if (owner.routingPolicy === "exclusive" || !(error instanceof TaskOwnedByClientError)) throw error;
      }
      return;
    }
    return this.base.ensureOpen?.(task) ?? Promise.resolve();
  }
  isCreationActive(task: TaskRef): boolean { if (this.owner(task)?.routingPolicy === "exclusive") return false; return this.base.isCreationActive?.(task) ?? false; }
  onCreationUpdate(listener: (update: TaskCreationUpdate) => void): () => void { return this.base.onCreationUpdate?.(listener) ?? (() => {}); }
  checkCompatibility(): Promise<DesktopCompatibility> {
    return this.base.checkCompatibility?.() ?? Promise.resolve({ state: "unverified", message: "Проверка клиента недоступна." });
  }
  compatibility(): DesktopCompatibility { return this.base.compatibility?.() ?? { state: "unverified", message: "Проверка клиента недоступна." }; }
}
