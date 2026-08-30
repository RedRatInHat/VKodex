import type { DesktopTask, TaskRef } from "../desktop/contracts.js";
import type { RemoteAttachment } from "../domain/models.js";

export interface MessageHandle { readonly peerId: number; readonly conversationMessageId: number }
export interface Button { readonly label: string; readonly action: string }
export interface View { readonly text: string; readonly buttons?: readonly Button[]; readonly silent?: boolean; readonly attachments?: readonly string[] }

export const VK_MAX_INLINE_BUTTONS = 10;
export const MENU_BUTTON: Button = { label: "Меню", action: "menu" };
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
  uploadDocument(peerId: number, name: string, contents: string): Promise<string>;
  uploadFile?(peerId: number, name: string, contents: Buffer, kind: "image" | "file"): Promise<string>;
  /** Read-only operational checks. Implementations must never expose credentials in details. */
  health?(): Promise<readonly HealthCheckResult[]>;
}

export interface OwnerAccess { readonly ownerId: number; readonly groupId: number }

export interface BridgeInput {
  readonly eventId: string;
  readonly peerId: number;
  readonly senderId: number;
  readonly text: string;
  readonly action?: string;
  readonly hasAttachments?: boolean;
  readonly attachments?: readonly RemoteAttachment[];
  readonly attachmentError?: string;
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

export type TaskListFilter =
  | { readonly kind: "all" }
  | { readonly kind: "unassigned" }
  | { readonly kind: "project"; readonly projectId: string };

export type ManagerAction =
  | PanelAction
  | { readonly type: "browseProjects"; readonly page: number }
  | { readonly type: "list"; readonly page: number; readonly filter?: TaskListFilter }
  | { readonly type: "open"; readonly task: DesktopTask }
  | { readonly type: "new" }
  | { readonly type: "project"; readonly id: string; readonly title: string }
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
  readonly command: "home" | "health" | "limits" | "projects" | "moveProject" | "moveProjectApply" | "models" | "efforts" | "select" | "goal" | "goalObjective" | "goalBudget" | "goalBudgetInput" | "goalApply" | "goalPause" | "goalResume" | "goalClear" | "goalClearApply" | "rename" | "renameApply" | "renameVk" | "archive" | "archiveApply" | "share" | "path" | "link" | "export";
  readonly page?: number;
  readonly model?: string;
  readonly effort?: string;
  readonly title?: string;
  readonly projectId?: string | null;
  readonly tokenBudget?: number | null;
}

export interface NewTaskDraft {
  readonly id: string;
  readonly stage: "project" | "environment" | "title" | "prompt" | "model" | "effort" | "confirm" | "creating" | "uncertain" | "created";
  readonly projectId?: string;
  readonly projectTitle?: string;
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
  readonly kind: "send" | "commentary" | "panel" | "activity";
  readonly view: View;
  readonly firstView: View | null;
  readonly handle: MessageHandle | null;
  readonly revision: number;
  readonly deliveredRevision: number;
}
