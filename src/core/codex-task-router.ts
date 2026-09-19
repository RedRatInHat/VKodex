import type { CodexQuestions } from "./codex-questions.js";
import { ActionRejectedError, TaskOwnedByClientError, type AccountUsage, type CodexTasks, type CreateTaskRequest, type DesktopCompatibility,
  type DesktopModel, type DesktopProject, type DesktopSource, type DesktopTask, type EditLastUserTurnRequest,
  type EditLastUserTurnResult, type SubmitTaskReceipt, type SubmitTaskRequest, type TaskCreationUpdate,
  type TaskDetails, type TaskGoal, type TaskGoalUpdate, type TaskRef, type TaskRenameResult,
  type TransferCheckpoint, type TransferTaskRequest, type UsageResetOutcome } from "./codex-tasks.js";

export interface CodexTaskOwner {
  owns(task: TaskRef): boolean;
  submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt>;
  interrupt(task: TaskRef): Promise<void>;
  queue(request: SubmitTaskRequest): Promise<string>;
  selectModel(task: TaskRef, model: string, effort: string): Promise<void>;
  renameTask(task: TaskRef, title: string): Promise<TaskRenameResult>;
  moveTask(task: TaskRef, projectId: string | null): Promise<void>;
  getGoal(task: TaskRef): Promise<TaskGoal | null>;
  setGoal(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal>;
  clearGoal(task: TaskRef): Promise<boolean>;
  pendingQuestions(task: TaskRef): Promise<readonly CodexQuestions[]>;
  answerQuestions(task: TaskRef, question: CodexQuestions, answers: Readonly<Record<string, string>>,
    operationId: string, beforeSend: () => Promise<void>): Promise<void>;
  findAcceptedInput(task: TaskRef, operationId: string): Promise<string | null>;
  inspectTask(task: TaskRef): Promise<TaskDetails>;
  archiveTask(task: TaskRef): Promise<void>;
  archiveRetryReady(task: TaskRef): Promise<boolean>;
}

/** Routes execution-sensitive commands to the one configured owner of a source. */
export class RoutedCodexTasks implements CodexTasks {
  constructor(private readonly base: CodexTasks, private readonly owners: readonly CodexTaskOwner[]) {}
  private owner(task: TaskRef): CodexTaskOwner | undefined { return this.owners.find(owner => owner.owns(task)); }
  get capabilities() { return this.base.capabilities; }
  listTasks(): Promise<readonly DesktopTask[]> { return this.base.listTasks(); }
  listSources(): readonly DesktopSource[] { return this.base.listSources?.() ?? []; }
  listProjects(sourceId?: string): Promise<readonly DesktopProject[]> { return this.base.listProjects(sourceId); }
  catalogWarnings(): readonly string[] { return this.base.catalogWarnings?.() ?? []; }
  createTask(request: CreateTaskRequest): Promise<DesktopTask> { return this.base.createTask(request); }
  async submit(request: SubmitTaskRequest): Promise<void> { await this.submitWithReceipt(request); }
  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    const owner = this.owner(request.task);
    if (!owner) return this.base.submitWithReceipt?.(request) ?? this.base.submit(request).then(() => ({ mode: "start" as const, turnId: null }));
    try { return await owner.submitWithReceipt(request); }
    catch (error) {
      if (!(error instanceof TaskOwnedByClientError)) throw error;
      if (!this.base.submitConnectedWithReceipt) throw new ActionRejectedError("Задача открыта в Codex, но её активное подключение недоступно. Повтори после восстановления клиента.");
      return this.base.submitConnectedWithReceipt(request);
    }
  }
  findAcceptedInput(task: TaskRef, operationId: string): Promise<string | null> {
    return this.owner(task)?.findAcceptedInput(task, operationId) ?? this.base.findAcceptedInput?.(task, operationId) ?? Promise.resolve(null);
  }
  async editLastUserTurn(request: EditLastUserTurnRequest): Promise<EditLastUserTurnResult> {
    const owner = this.owner(request.task);
    if (owner) {
      try { await owner.inspectTask(request.task); }
      catch (error) {
        if (error instanceof TaskOwnedByClientError && this.base.editLastUserTurn) return this.base.editLastUserTurn(request);
        throw error;
      }
      throw new ActionRejectedError("Нативное редактирование последнего хода пока не включено для этого каталога Codex.");
    }
    if (!this.base.editLastUserTurn) throw new ActionRejectedError("Редактирование последнего хода недоступно.");
    return this.base.editLastUserTurn(request);
  }
  async interrupt(task: TaskRef): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.interrupt(task);
    try { return await owner.interrupt(task); }
    catch (error) { if (!(error instanceof TaskOwnedByClientError)) throw error; return this.base.interrupt(task); }
  }
  async queue(request: SubmitTaskRequest): Promise<string> {
    const owner = this.owner(request.task);
    if (owner) {
      try { return await owner.queue(request); }
      catch (error) {
        if (!(error instanceof TaskOwnedByClientError)) throw error;
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
        if (!(error instanceof TaskOwnedByClientError)) throw error;
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
        if (!(error instanceof TaskOwnedByClientError)) throw error;
        if (!this.base.answerQuestions) throw new ActionRejectedError("Ответы на вопросы активного клиента недоступны.");
        return this.base.answerQuestions(task, question, answers, operationId, beforeSend);
      }
    }
    if (!this.base.answerQuestions) throw new ActionRejectedError("Ответы на вопросы Codex недоступны.");
    return this.base.answerQuestions(task, question, answers, operationId, beforeSend);
  }
  async inspectTask(task: TaskRef): Promise<TaskDetails> {
    const owner = this.owner(task); if (!owner) return this.base.inspectTask(task);
    try { return await owner.inspectTask(task); }
    catch (error) { if (!(error instanceof TaskOwnedByClientError)) throw error; return this.base.inspectTask(task); }
  }
  async selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.selectModel(task, model, effort);
    try { return await owner.selectModel(task, model, effort); }
    catch (error) { if (!(error instanceof TaskOwnedByClientError)) throw error; return this.base.selectModel(task, model, effort); }
  }
  listModels(task?: TaskRef): Promise<readonly DesktopModel[]> { return this.base.listModels(task); }
  async moveTask(task: TaskRef, projectId: string | null): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.moveTask(task, projectId);
    try { return await owner.moveTask(task, projectId); }
    catch (error) { if (!(error instanceof TaskOwnedByClientError)) throw error; return this.base.moveTask(task, projectId); }
  }
  transferTask(request: TransferTaskRequest): Promise<DesktopTask> {
    if (!this.base.transferTask) throw new ActionRejectedError("Перенос задач недоступен."); return this.base.transferTask(request);
  }
  transferCheckpoint(task: TaskRef): Promise<TransferCheckpoint> {
    if (!this.base.transferCheckpoint) throw new ActionRejectedError("Проверка переноса недоступна."); return this.base.transferCheckpoint(task);
  }
  verifyTransferSource(task: TaskRef, checkpoint: TransferCheckpoint): Promise<void> {
    if (!this.base.verifyTransferSource) throw new ActionRejectedError("Проверка источника переноса недоступна."); return this.base.verifyTransferSource(task, checkpoint);
  }
  verifyTransferTarget(request: TransferTaskRequest, target: DesktopTask): Promise<void> {
    if (!this.base.verifyTransferTarget) throw new ActionRejectedError("Проверка назначения переноса недоступна."); return this.base.verifyTransferTarget(request, target);
  }
  verifyLegacyArchivedPair(source: TaskRef, target: DesktopTask, checkpoint: TransferCheckpoint): Promise<void> {
    if (!this.base.verifyLegacyArchivedPair) throw new ActionRejectedError("Проверка старого переноса недоступна.");
    return this.base.verifyLegacyArchivedPair(source, target, checkpoint);
  }
  isTaskArchived(task: TaskRef, checkpoint?: TransferCheckpoint): Promise<boolean> {
    return this.base.isTaskArchived?.(task, checkpoint) ?? Promise.resolve(false);
  }
  archiveRetryReady(task: TaskRef): Promise<boolean> {
    const owner = this.owner(task);
    return owner?.archiveRetryReady(task) ?? this.base.archiveRetryReady?.(task) ?? Promise.resolve(false);
  }
  ownerAdapterStatus(task: TaskRef): Promise<"ready" | "missing"> {
    if (this.owner(task)) return Promise.resolve("ready"); return this.base.ownerAdapterStatus?.(task) ?? Promise.resolve("missing");
  }
  async renameTask(task: TaskRef, title: string): Promise<TaskRenameResult> {
    const owner = this.owner(task); if (!owner) return this.base.renameTask(task, title);
    try { return await owner.renameTask(task, title); }
    catch (error) { if (!(error instanceof TaskOwnedByClientError)) throw error; return this.base.renameTask(task, title); }
  }
  async archiveTask(task: TaskRef): Promise<void> {
    const owner = this.owner(task); if (!owner) return this.base.archiveTask(task);
    try { return await owner.archiveTask(task); }
    catch (error) { if (!(error instanceof TaskOwnedByClientError)) throw error; return this.base.archiveTask(task); }
  }
  async archiveTransferredSource(task: TaskRef): Promise<void> {
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
  exportMarkdown(task: TaskRef): Promise<string> { return this.base.exportMarkdown(task); }
  accountUsage(task?: TaskRef): Promise<readonly AccountUsage[]> {
    if (!this.base.accountUsage) throw new ActionRejectedError("Лимиты аккаунта недоступны."); return this.base.accountUsage(task);
  }
  consumeUsageReset(task: TaskRef, idempotencyKey: string): Promise<UsageResetOutcome> {
    if (!this.base.consumeUsageReset) throw new ActionRejectedError("Сброс лимита недоступен."); return this.base.consumeUsageReset(task, idempotencyKey);
  }
  getGoal(task: TaskRef): Promise<TaskGoal | null> {
    const owner = this.owner(task); return owner?.getGoal(task) ?? this.base.getGoal?.(task) ?? Promise.resolve(null);
  }
  setGoal(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> {
    const owner = this.owner(task);
    if (owner) return owner.setGoal(task, update);
    if (!this.base.setGoal) throw new ActionRejectedError("Управление целью недоступно."); return this.base.setGoal(task, update);
  }
  clearGoal(task: TaskRef): Promise<boolean> {
    const owner = this.owner(task); return owner?.clearGoal(task) ?? this.base.clearGoal?.(task) ?? Promise.resolve(false);
  }
  continueGoal(task: TaskRef): Promise<void> {
    if (this.owner(task)) return Promise.resolve();
    return this.base.continueGoal?.(task) ?? Promise.resolve();
  }
  revealTask(task: TaskRef): Promise<void> { return this.base.revealTask?.(task) ?? Promise.resolve(); }
  async ensureOpen(task: TaskRef): Promise<void> {
    const owner = this.owner(task);
    if (owner) {
      try { await owner.inspectTask(task); }
      catch (error) {
        // An active-writer rejection is positive evidence that the selected
        // task is already open in another Codex client. Do not launch/focus a
        // UI and then wait for the retired follower adapter to rediscover it.
        if (!(error instanceof TaskOwnedByClientError)) throw error;
      }
      return;
    }
    return this.base.ensureOpen?.(task) ?? Promise.resolve();
  }
  isCreationActive(task: TaskRef): boolean { return this.base.isCreationActive?.(task) ?? false; }
  onCreationUpdate(listener: (update: TaskCreationUpdate) => void): () => void { return this.base.onCreationUpdate?.(listener) ?? (() => {}); }
  checkCompatibility(): Promise<DesktopCompatibility> {
    return this.base.checkCompatibility?.() ?? Promise.resolve({ state: "unverified", message: "Проверка клиента недоступна." });
  }
  compatibility(): DesktopCompatibility { return this.base.compatibility?.() ?? { state: "unverified", message: "Проверка клиента недоступна." }; }
}
