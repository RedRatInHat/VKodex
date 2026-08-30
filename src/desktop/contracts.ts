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
  readonly title: string;
  readonly workspace: string;
  readonly workspaceRoots?: readonly string[];
}

export interface CreateTaskRequest {
  readonly operationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly environment: "local" | "worktree";
}

export interface SubmitTaskRequest {
  readonly operationId: string;
  readonly task: TaskRef;
  readonly text: string;
  readonly inputFiles?: readonly LocalInputFile[];
  readonly outboxDir?: string;
  readonly beforeSend?: () => Promise<void>;
}

export interface DesktopModel {
  readonly id: string;
  readonly title: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
}

export interface TaskDetails {
  readonly title?: string | null;
  readonly status: "running" | "idle" | "failed" | "interrupted" | "approval" | "unavailable";
  readonly workspace: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly nextModel: string | null;
  readonly nextEffort: string | null;
  readonly context: { readonly used: number; readonly window: number; readonly percent: number } | null;
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
}

export interface AccountUsageProvider {
  read(task?: TaskRef): Promise<readonly AccountUsage[]>;
}

export interface DesktopMetadata {
  rename(task: TaskRef, title: string): Promise<void>;
  archive(task: TaskRef): Promise<void>;
  markdown(task: TaskRef): Promise<string>;
  assignProject(task: TaskRef, projectId: string | null): Promise<void>;
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
  readonly accountUsage?: boolean;
}

export interface DirectTaskUpdate {
  readonly task: TaskRef;
  readonly event: TaskEvent;
  readonly details: TaskDetails;
}

export interface DirectTaskExecutor {
  createTask(request: CreateTaskRequest): Promise<DesktopTask>;
  submit(request: SubmitTaskRequest): Promise<void>;
  interrupt(task: TaskRef): Promise<boolean>;
  details(task: TaskRef): TaskDetails | null;
  isRunning(task: TaskRef): boolean;
  onUpdate(listener: (update: DirectTaskUpdate) => void): () => void;
}

export interface DesktopCompatibility {
  readonly state: "checking" | "ok" | "unverified" | "failed";
  readonly message: string;
}

export interface DesktopTasks {
  readonly capabilities: DesktopCapabilities;
  listTasks(): Promise<readonly DesktopTask[]>;
  listProjects(): Promise<readonly DesktopProject[]>;
  catalogWarnings?(): readonly string[];
  createTask(request: CreateTaskRequest): Promise<DesktopTask>;
  submit(request: SubmitTaskRequest): Promise<void>;
  interrupt(task: TaskRef): Promise<void>;
  moveTask(task: TaskRef, projectId: string | null): Promise<void>;
  inspectTask(task: TaskRef): Promise<TaskDetails>;
  listModels(task?: TaskRef): Promise<readonly DesktopModel[]>;
  selectModel(task: TaskRef, model: string, effort: string): Promise<void>;
  renameTask(task: TaskRef, title: string): Promise<TaskRenameResult>;
  archiveTask(task: TaskRef): Promise<void>;
  exportMarkdown(task: TaskRef): Promise<string>;
  accountUsage?(task?: TaskRef): Promise<readonly AccountUsage[]>;
  isDirectlyManaged?(task: TaskRef): boolean;
  onDirectUpdate?(listener: (update: DirectTaskUpdate) => void): () => void;
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

/** Discovery confirmed that no desktop client currently owns this task. */
export class TaskNotOpenError extends DesktopUnavailableError {
  constructor() {
    super("Задача не открыта в десктопе Codex. Продолжаю её через локальный Codex SDK.");
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

export class UncertainActionError extends Error {
  constructor() {
    super("Результат операции неизвестен. Автоматический повтор отключён, чтобы не создать дубликат.");
    this.name = "UncertainActionError";
  }
}
import type { LocalInputFile } from "../domain/models.js";
