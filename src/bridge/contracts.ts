import type { DesktopTask, TaskRef } from "../desktop/contracts.js";

export interface MessageHandle { readonly peerId: number; readonly conversationMessageId: number }
export interface Button { readonly label: string; readonly action: string }
export interface View { readonly text: string; readonly buttons?: readonly Button[]; readonly silent?: boolean; readonly attachments?: readonly string[] }

export const taskChatTitle = (title: string): string => `[VKodex] ${title}`.slice(0, 200);

export interface BridgeChat {
  members(peerId: number): Promise<readonly number[]>;
  createConversation(title: string): Promise<{ readonly peerId: number; readonly chatId: number }>;
  renameConversation(peerId: number, title: string, beforeWrite: () => Promise<void>): Promise<void>;
  inviteLink(peerId: number): Promise<string>;
  send(peerId: number, view: View, randomId: number): Promise<MessageHandle>;
  edit(handle: MessageHandle, view: View): Promise<void>;
  uploadDocument(peerId: number, name: string, contents: string): Promise<string>;
}

export interface OwnerAccess { readonly ownerId: number; readonly groupId: number }

export interface ChatMembershipChange {
  readonly peerId: number;
  readonly eventId?: string;
  readonly removedMemberId?: number;
}

export interface BridgeInput {
  readonly eventId: string;
  readonly peerId: number;
  readonly senderId: number;
  readonly text: string;
  readonly action?: string;
  readonly hasAttachments?: boolean;
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
  | { readonly type: "create"; readonly draftId: string }
  | { readonly type: "cancel" }
  | { readonly type: "resume"; readonly bindingId: string }
  | { readonly type: "detach"; readonly bindingId: string };

export interface PanelAction {
  readonly type: "panel";
  readonly screenId: string;
  readonly bindingId?: string;
  readonly command: "home" | "projects" | "moveProject" | "models" | "efforts" | "select" | "rename" | "renameApply" | "renameVk" | "archive" | "archiveApply" | "share" | "path" | "link" | "export";
  readonly page?: number;
  readonly model?: string;
  readonly effort?: string;
  readonly title?: string;
}

export interface NewTaskDraft {
  readonly id: string;
  readonly stage: "project" | "title" | "prompt" | "confirm" | "creating" | "uncertain" | "created";
  readonly projectId?: string;
  readonly projectTitle?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly task?: DesktopTask;
}

export interface Delivery {
  readonly id: number;
  readonly key: string;
  readonly bindingId: string | null;
  readonly peerId: number;
  readonly kind: "send" | "commentary" | "panel";
  readonly view: View;
  readonly firstView: View | null;
  readonly handle: MessageHandle | null;
  readonly revision: number;
  readonly deliveredRevision: number;
}
