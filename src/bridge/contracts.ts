import type { DesktopTask, TaskRef, TaskGoal, TransferCheckpoint } from "../core/codex-tasks.js";
import type { RemoteAttachment } from "../domain/models.js";

export interface MessageHandle { readonly peerId: number; readonly conversationMessageId: number }
export interface Button { readonly label: string; readonly action: string }
export interface View { readonly text: string; readonly buttons?: readonly Button[]; readonly silent?: boolean; readonly attachments?: readonly string[] }

export const VK_MAX_INLINE_BUTTONS = 10;
export const MENU_BUTTON: Button = { label: "Меню", action: "menu" };
/** A file-specific VK rejection: automatic retries of identical bytes cannot help. */
export class FileUploadRejectedError extends Error {}
export class ChatRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) { super("VK временно ограничил частоту запросов. Отправка продолжится после паузы."); }
}

export type HealthState = "ok" | "degraded" | "failed";
export interface HealthCheckResult {
  readonly name: string;
  readonly state: HealthState;
  readonly detail: string;
}
export interface BridgeHealthSnapshot {
  readonly state: HealthState;
  readonly checkedAt: number;
  readonly pid: number;
  readonly uptimeSeconds: number;
  readonly checks: readonly HealthCheckResult[];
}

export const taskChatTitle = (title: string): string => `[VKodex] ${title}`.slice(0, 200);

export interface BridgeChat {
  createConversation(title: string): Promise<{ readonly peerId: number; readonly chatId: number }>;
  renameConversation(peerId: number, title: string, beforeWrite: () => Promise<void>): Promise<void>;
  inviteLink(peerId: number): Promise<string>;
  send(peerId: number, view: View, randomId: number): Promise<MessageHandle>;
  edit(handle: MessageHandle, view: View): Promise<void>;
  delete(handle: MessageHandle): Promise<void>;
  uploadDocument(peerId: number, name: string, contents: string): Promise<string>;
  uploadFile?(peerId: number, name: string, contents: Buffer, kind: "image" | "file"): Promise<string>;
  /** Read-only operational checks. Implementations must never expose credentials in details. */
  health?(): Promise<readonly HealthCheckResult[]>;
}

export interface OwnerAccess { readonly ownerId: number; readonly groupId: number }

export interface BridgeInput {
  readonly mergedEventIds?: readonly string[];
  readonly eventId: string;
  readonly peerId: number;
  readonly senderId: number;
  /** Display name resolved by the transport. Never trusted as an instruction. */
  readonly senderName?: string;
  readonly text: string;
  readonly action?: string;
  readonly hasAttachments?: boolean;
  readonly attachments?: readonly RemoteAttachment[];
  readonly attachmentError?: string;
  /** Present only for an incoming VK message_edit event. */
  readonly editOfMessageId?: number;
  readonly replyToMessageId?: number;
}

export interface Binding extends TaskRef {
  readonly sourceLabel?: string;
  readonly id: string;
  readonly title: string;
  readonly peerId: number | null;
  readonly chatId: number | null;
  readonly chatState: "planned" | "creating" | "ready" | "uncertain";
  readonly attached: boolean;
  readonly paused: boolean;
}

export interface TaskTransferRecord {
  readonly id: string;
  readonly bindingId: string;
  readonly startedAt: number;
  readonly source: TaskRef & { readonly title: string };
  readonly targetSourceId: string;
  readonly targetProjectId: string | null;
  readonly phase: "forking" | "preparingTarget" | "targetCreated" | "switched" | "complete" | "cancelled" | "failed" | "uncertain";
  readonly target?: DesktopTask;
  readonly detail?: string;
  /** Legacy records are read-only until explicitly resumed by the owner. */
  readonly version?: 2;
  readonly revision?: number;
  readonly updatedAt?: number;
  readonly attempt?: number;
  readonly retryAt?: number;
  readonly blocked?: boolean;
  readonly blockedReason?: "archiveOwner" | "archiveUnknown" | "sourceChanged" | null;
  /** Explicit owner decision after both source and target acquired unique work. */
  readonly conflictResolution?: "keptBoth";
  /** A historical record closed from native archive + exact binding evidence,
   * not a claim that a missing legacy history checkpoint was reconstructed. */
  readonly legacyReconciled?: boolean;
  readonly checkpoint?: TransferCheckpoint;
  readonly forkSubmitted?: boolean;
  readonly goal?: TaskGoal | null;
  readonly goalPrepared?: boolean;
  readonly step?: "snapshot" | "fork" | "metadata" | "open" | "goal" | "verify" | "archive";
  readonly launchAttempted?: boolean;
  /** Executor that last attempted the idempotent target connection. A new
   * executor may retry after first checking whether the target is live. */
  readonly launchOwner?: string;
  readonly lease?: { readonly owner: string; readonly pid: number } | null;
}

export type TaskListFilter =
  | { readonly kind: "all" }
  | { readonly kind: "unassigned" }
  | { readonly kind: "project"; readonly projectId: string };

export type ManagerAction =
  | PanelAction
  | { readonly type: "question"; readonly bindingId: string; readonly key: string; readonly fingerprint: string; readonly index: number; readonly option: number }
  | { readonly type: "browseProjects"; readonly page: number }
  | { readonly type: "list"; readonly page: number; readonly filter?: TaskListFilter }
  | { readonly type: "open"; readonly task: DesktopTask }
  | { readonly type: "new" }
  | { readonly type: "newSources"; readonly page: number }
  | { readonly type: "newSource"; readonly sourceId: string }
  | { readonly type: "newProjects"; readonly page: number }
  | { readonly type: "project"; readonly id: string; readonly title: string }
  | { readonly type: "newProjectless" }
  | { readonly type: "newWorkspaces"; readonly page: number }
  | { readonly type: "newWorkspace"; readonly workspace: string }
  | { readonly type: "newWorkspaceAuto" }
  /** Legacy buttons from the path-only wizard now open the workspace picker. */
  | { readonly type: "newWorkspaceManual" }
  | { readonly type: "newWorkspacePath" }
  | { readonly type: "newEnvironment"; readonly environment: "local" | "worktree" }
  | { readonly type: "newModels"; readonly page: number }
  | { readonly type: "newModel"; readonly model: string }
  | { readonly type: "newEffort"; readonly model: string; readonly effort: string }
  | { readonly type: "create"; readonly draftId: string }
  | { readonly type: "cancel" }
  | { readonly type: "resume"; readonly bindingId: string }
  | { readonly type: "detach"; readonly bindingId: string };

export interface PanelAction {
  readonly type: "panel";
  readonly screenId: string;
  readonly bindingId?: string;
  readonly command: "home" | "health" | "limits" | "limitsReset" | "limitsResetApply" | "projects" | "openDesktop" | "move" | "moveProject" | "moveProjectApply" | "moveSource" | "moveSourceSelect" | "moveSourceProject" | "moveSourceConfirm" | "moveSourceApply" | "moveSourceResume" | "moveSourceCancel" | "moveSourceConflict" | "moveSourceConflictApply" | "models" | "efforts" | "select" | "goal" | "goalObjective" | "goalBudget" | "goalBudgetInput" | "goalApply" | "goalPause" | "goalResume" | "goalClear" | "goalClearApply" | "rename" | "renameApply" | "renameVk" | "archive" | "archiveApply" | "share" | "path" | "link" | "export";
  readonly page?: number;
  readonly model?: string;
  readonly effort?: string;
  readonly title?: string;
  readonly projectId?: string | null;
  readonly sourceId?: string;
  readonly tokenBudget?: number | null;
}

export interface NewTaskDraft {
  readonly id: string;
  readonly stage: "source" | "project" | "workspace" | "environment" | "title" | "prompt" | "model" | "effort" | "confirm" | "creating" | "uncertain" | "created";
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly projectId?: string | null;
  readonly projectTitle?: string;
  readonly workspace?: string;
  readonly automaticWorkspace?: boolean;
  readonly title?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly environment?: "local" | "worktree";
  readonly task?: DesktopTask;
}

export interface Delivery {
  readonly id: number;
  readonly key: string;
  readonly bindingId: string | null;
  readonly peerId: number;
  readonly kind: "send" | "commentary" | "panel" | "activity" | "delete";
  readonly view: View;
  readonly firstView: View | null;
  readonly handle: MessageHandle | null;
  readonly revision: number;
  readonly deliveredRevision: number;
}
