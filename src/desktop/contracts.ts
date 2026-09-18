export interface TaskRef {
  readonly hostId: string;
  readonly threadId: string;
  readonly sourceId?: string;
  readonly rolloutPath?: string;
}

export interface DesktopTask extends TaskRef {
  readonly sourceLabel?: string;
  /** null means no project; undefined means project membership could not be read. */
  readonly projectId?: string | null;
  readonly title: string;
  readonly workspace: string;
  readonly updatedAt: number;
}

export interface DesktopProject {
  readonly id: string;
  /** Previous IDs imported by Codex; accepted only through its persisted mapping. */
  readonly legacyIds?: readonly string[];
  readonly title: string;
  readonly workspace: string;
  readonly workspaceRoots?: readonly string[];
}

export interface DesktopSource {
  /** Empty string identifies the primary CODEX_HOME without changing legacy task keys. */
  readonly id: string;
  readonly label: string;
}

export interface CreateTaskRequest {
  readonly operationId: string;
  readonly projectId: string | null;
  /** Selected CODEX_HOME. Omitted for the primary catalog. */
  readonly sourceId?: string;
  /** Required when projectId is null. */
  readonly workspace?: string;
  /** Create the bridge-selected isolated workspace instead of requiring it to exist. */
  readonly automaticWorkspace?: boolean;
  readonly title: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly environment: "local" | "worktree";
}

export interface TransferTaskRequest {
  readonly operationId: string;
  readonly startedAt: number;
  readonly task: TaskRef & { readonly title: string };
  /** Empty string identifies the primary CODEX_HOME. */
  readonly targetSourceId: string;
  /** Visible project id in the target source, or null for no project. */
  readonly projectId: string | null;
  readonly existingTarget?: DesktopTask;
  /** Persist the fork identity before attempting any follow-up metadata write. */
  readonly onForkCreated?: (target: DesktopTask) => void;
  /** Durable boundary, captured before any fork is submitted. */
  readonly checkpoint?: TransferCheckpoint;
  /** Once submitted, retries may reconcile but must never create another fork. */
  readonly forkSubmitted?: boolean;
  readonly onForkSubmitted?: () => void;
}

export interface TransferCheckpoint {
  readonly lastTurnId: string;
  readonly rolloutPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** Hash of all persisted completed turns. Older in-flight transfers lack it. */
  readonly semanticDigest?: string;
}

export interface SubmitTaskRequest {
  readonly operationId: string;
  readonly task: TaskRef;
  readonly text: string;
  readonly author?: { readonly id: number; readonly name: string };
  readonly inputFiles?: readonly LocalInputFile[];
  readonly outboxDir?: string;
  readonly beforeSend?: () => Promise<void>;
}

export interface SubmitTaskReceipt {
  readonly mode: "start" | "steer";
  readonly turnId: string | null;
}

export interface EditLastUserTurnRequest extends SubmitTaskRequest {
  readonly expectedTurnId: string;
  readonly expectedOperationId: string;
}

export interface EditLastUserTurnResult {
  /** The replacement turn is normally visible in the owner snapshot before the IPC reply. */
  readonly turnId: string | null;
  readonly operationId: string | null;
}

export interface DesktopModel {
  readonly id: string;
  readonly title: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
}

export interface TaskDetails {
  readonly title?: string | null;
  readonly failure?: "usageLimit" | "systemError";
  readonly status: "running" | "idle" | "failed" | "interrupted" | "approval" | "unavailable";
  readonly workspace: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly nextModel: string | null;
  readonly nextEffort: string | null;
  readonly context: { readonly used: number; readonly window: number; readonly percent: number } | null;
}

export type TaskGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface TaskGoal {
  readonly threadId: string;
  readonly objective: string;
  readonly status: TaskGoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TaskGoalUpdate {
  readonly objective?: string;
  readonly status?: TaskGoalStatus;
  readonly tokenBudget?: number | null;
}

export interface DesktopGoals {
  get(task: TaskRef): Promise<TaskGoal | null>;
  set(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal>;
  clear(task: TaskRef): Promise<boolean>;
}

export interface AccountRateLimitWindow {
  readonly usedPercent: number;
  readonly windowMinutes: number;
  readonly resetsAt: number;
}

export interface AccountRateLimit {
  readonly id: string;
  readonly name: string | null;
  readonly primary: AccountRateLimitWindow | null;
  readonly secondary: AccountRateLimitWindow | null;
}

export interface AccountUsage {
  /** Human-readable account identity only; never an access token or account ID. */
  readonly accountLabel: string | null;
  /** Basename of the configured CODEX_HOME that supplied these limits. */
  readonly sourceLabel: string | null;
  readonly planType: string | null;
  readonly limits: readonly AccountRateLimit[];
  readonly credits: { readonly hasCredits: boolean; readonly unlimited: boolean; readonly balance: string | null } | null;
  readonly resetCredits: number | null;
  /** Stable configured source ID used for account-scoped actions. */
  readonly sourceId?: string;
}

export type UsageResetOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface AccountUsageProvider {
  read(task?: TaskRef): Promise<readonly AccountUsage[]>;
  consumeReset?(task: TaskRef, idempotencyKey: string): Promise<UsageResetOutcome>;
}

export interface DesktopMetadata {
  queue?(request: SubmitTaskRequest, input: readonly Record<string, unknown>[]): Promise<string>;
  findAcceptedInput?(task: TaskRef, operationId: string): Promise<string | null>;
  rename(task: TaskRef, title: string): Promise<void>;
  archive(task: TaskRef): Promise<void>;
  markdown(task: TaskRef): Promise<string>;
  assignProject(task: TaskRef, projectId: string | null): Promise<void>;
  /** Native persisted state, not a project inferred by the display catalog. */
  read?(task: TaskRef): Promise<{ readonly title: string | null; readonly projectId: string | null }>;
  isArchived?(task: TaskRef, checkpoint?: TransferCheckpoint): Promise<boolean>;
  /** Read-only check before retrying a previously rejected source archive. */
  archiveRetryReady?(task: TaskRef): Promise<boolean>;
  /** Read-only native owner probe for transfer readiness. */
  ownerAdapterStatus?(task: TaskRef): Promise<"ready" | "missing">;
}

export interface TaskRenameResult {
  /** The catalog is already confirmed; the open desktop window is checked separately. */
  readonly liveTitleUpdated: boolean;
}

export type TaskEvent =
  // Only visible agent commentary; commands, tool output and file changes are excluded.
  | { readonly type: "progress"; readonly id: string; readonly turnId: string; readonly text: string }
  | { readonly type: "final"; readonly id: string; readonly turnId: string; readonly text: string }
  | { readonly type: "user"; readonly id: string; readonly turnId: string; readonly text: string; readonly operationId?: string }
  | { readonly type: "status"; readonly id: string; readonly turnId: string; readonly status: "running" | "completed" | "failed" | "interrupted" | "approval" };

export interface DesktopCapabilities {
  readonly createTask: boolean;
  readonly startTurn: boolean;
  readonly steerTurn: boolean;
  readonly interruptTurn: boolean;
  readonly selectModel: boolean;
  readonly renameTask?: boolean;
  readonly archiveTask?: boolean;
  readonly exportMarkdown?: boolean;
  readonly moveTask?: boolean;
  readonly transferTask?: boolean;
  readonly accountUsage?: boolean;
  readonly usageReset?: boolean;
  readonly goals?: boolean;
  readonly editLastUserTurn?: boolean;
}

export interface DesktopTaskCreator {
  createTask(request: CreateTaskRequest): Promise<DesktopTask>;
  interrupt(task: TaskRef): Promise<boolean>;
  details(task: TaskRef): TaskDetails | null;
  isActive(task: TaskRef): boolean;
  onUpdate(listener: (update: TaskCreationUpdate) => void): () => void;
}

export interface DesktopTaskTransfer {
  fork(request: TransferTaskRequest): Promise<DesktopTask>;
  checkpoint?(task: TaskRef): Promise<TransferCheckpoint>;
  verifySource?(task: TaskRef, checkpoint: TransferCheckpoint): Promise<void>;
  verifyTarget?(request: TransferTaskRequest, target: DesktopTask): Promise<void>;
  /** Reconcile a legacy archived source against the exact copied history prefix. */
  verifyLegacyArchivedPair?(source: TaskRef, target: DesktopTask, checkpoint: TransferCheckpoint): Promise<void>;
}

/** Events from the atomic first turn that materializes a new Codex task. */
export interface TaskCreationUpdate {
  readonly task: TaskRef;
  readonly event: TaskEvent;
  readonly details: TaskDetails;
}

export interface DesktopTaskLauncher {
  open(task: TaskRef): Promise<void>;
}

export interface DesktopCompatibility {
  readonly state: "checking" | "ok" | "unverified" | "failed";
  readonly message: string;
}

export interface DesktopTasks {
  pendingQuestions?(task: TaskRef): Promise<readonly import("./questions.js").CodexQuestions[]>;
  answerQuestions?(task: TaskRef, question: import("./questions.js").CodexQuestions, answers: Readonly<Record<string, string>>, operationId: string, beforeSend: () => Promise<void>): Promise<void>;
  queue?(request: SubmitTaskRequest): Promise<string>;
  readonly capabilities: DesktopCapabilities;
  listTasks(): Promise<readonly DesktopTask[]>;
  listSources?(): readonly DesktopSource[];
  listProjects(sourceId?: string): Promise<readonly DesktopProject[]>;
  catalogWarnings?(): readonly string[];
  createTask(request: CreateTaskRequest): Promise<DesktopTask>;
  submit(request: SubmitTaskRequest): Promise<void>;
  submitWithReceipt?(request: SubmitTaskRequest): Promise<SubmitTaskReceipt>;
  findAcceptedInput?(task: TaskRef, operationId: string): Promise<string | null>;
  editLastUserTurn?(request: EditLastUserTurnRequest): Promise<EditLastUserTurnResult>;
  interrupt(task: TaskRef): Promise<void>;
  moveTask(task: TaskRef, projectId: string | null): Promise<void>;
  transferTask?(request: TransferTaskRequest): Promise<DesktopTask>;
  transferCheckpoint?(task: TaskRef): Promise<TransferCheckpoint>;
  verifyTransferSource?(task: TaskRef, checkpoint: TransferCheckpoint): Promise<void>;
  verifyTransferTarget?(request: TransferTaskRequest, target: DesktopTask): Promise<void>;
  verifyLegacyArchivedPair?(source: TaskRef, target: DesktopTask, checkpoint: TransferCheckpoint): Promise<void>;
  isTaskArchived?(task: TaskRef, checkpoint?: TransferCheckpoint): Promise<boolean>;
  /** Read-only check used to resume a previously rejected archive. */
  archiveRetryReady?(task: TaskRef): Promise<boolean>;
  ownerAdapterStatus?(task: TaskRef): Promise<"ready" | "missing">;
  inspectTask(task: TaskRef): Promise<TaskDetails>;
  listModels(task?: TaskRef): Promise<readonly DesktopModel[]>;
  selectModel(task: TaskRef, model: string, effort: string): Promise<void>;
  renameTask(task: TaskRef, title: string): Promise<TaskRenameResult>;
  archiveTask(task: TaskRef): Promise<void>;
  /** Archive a transfer source that was already verified idle before the fork. */
  archiveTransferredSource?(task: TaskRef): Promise<void>;
  exportMarkdown(task: TaskRef): Promise<string>;
  accountUsage?(task?: TaskRef): Promise<readonly AccountUsage[]>;
  consumeUsageReset?(task: TaskRef, idempotencyKey: string): Promise<UsageResetOutcome>;
  getGoal?(task: TaskRef): Promise<TaskGoal | null>;
  setGoal?(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal>;
  clearGoal?(task: TaskRef): Promise<boolean>;
  continueGoal?(task: TaskRef): Promise<void>;
  /** Bring the configured Codex client to the foreground after an explicit user action. */
  revealTask?(task: TaskRef): Promise<void>;
  /** One-time handoff used after a task or transfer is first linked to VK. */
  ensureOpen?(task: TaskRef): Promise<void>;
  isCreationActive?(task: TaskRef): boolean;
  onCreationUpdate?(listener: (update: TaskCreationUpdate) => void): () => void;
  checkCompatibility?(): Promise<DesktopCompatibility>;
  compatibility?(): DesktopCompatibility;
}

export function taskKey(task: TaskRef): string {
  return JSON.stringify(task.sourceId ? [task.hostId, task.threadId, task.sourceId] : [task.hostId, task.threadId]);
}

export function sameTask(left: TaskRef, right: TaskRef): boolean { return taskKey(left) === taskKey(right); }

export class DesktopUnavailableError extends Error {
  constructor(message = "Подключение к десктопу Codex недоступно.") {
    super(message);
    this.name = "DesktopUnavailableError";
  }
}

/** A transient subscription loss; retrying is safe only before any task input is sent. */
export class TaskConnectionLostError extends DesktopUnavailableError {
  constructor(message = "Соединение с Codex прервалось до отправки сообщения.") {
    super(message);
    this.name = "TaskConnectionLostError";
  }
}

/** Read rejection, or an explicit protocol-version rejection before dispatch. */
export class DesktopRequestRejectedError extends DesktopUnavailableError {
  constructor(readonly reason: "no-client-found" | "request-rejected" | "request-version-mismatch" = "request-rejected") {
    super("Десктоп отклонил запрос.");
    this.name = "DesktopRequestRejectedError";
  }
}

/** Discovery confirmed that no desktop client currently owns this task. */
export class TaskNotOpenError extends DesktopUnavailableError {
  constructor() {
    super("У задачи нет активного подключения в Codex. Автоматически восстановить его не удалось. Владельцу VKodex нужно проверить клиент выбранного каталога и открыть задачу через /open, затем повторить сообщение.");
    this.name = "TaskNotOpenError";
  }
}

/** A rejection known to have happened before the requested action was applied. */
export class ActionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionRejectedError";
  }
}

/** A transfer snapshot conflict cannot be resolved by retrying the same write. */
export class TransferConflictError extends ActionRejectedError {}

/** The owning native client must release/archive its writer; repeating an
 * external archive request cannot resolve this condition. */
export class ArchiveOwnerRequiredError extends TransferConflictError {
  constructor() {
    super("Задача открыта другим процессом Codex, который удерживает её историю для записи. Архивируй её в приложении соответствующего каталога. VKodex автоматически проверит результат; принудительно закрывать Codex или снимать блокировку не нужно.");
    this.name = "ArchiveOwnerRequiredError";
  }
}

export class UncertainActionError extends Error {
  constructor() {
    super("Результат операции неизвестен. Автоматический повтор отключён, чтобы не создать дубликат.");
    this.name = "UncertainActionError";
  }
}

export class ProjectAssignmentUnconfirmedError extends UncertainActionError {
  constructor() {
    super();
    this.name = "ProjectAssignmentUnconfirmedError";
    this.message = "API Codex принял запись проекта, но его назначение в приложении не подтверждено. Выбери нужный проект через меню задачи в Codex. Новую задачу создавать не нужно.";
  }
}
import type { LocalInputFile } from "../domain/models.js";
