export type ConversationMode = "managed" | "single" | "auto";
export type SessionMemberMode = "requester" | "main-users";
export type SessionStatus = "ready" | "busy" | "archived" | "error";

export interface RemoteAttachment {
  readonly key: string;
  readonly kind: "image" | "file";
  readonly fileName: string;
  readonly url: string;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
}

export interface IncomingMessage {
  readonly peerId: number;
  readonly senderId: number;
  readonly isChat: boolean;
  readonly text: string;
  readonly attachments: readonly RemoteAttachment[];
}

export interface LocalInputFile {
  readonly path: string;
  readonly originalName: string;
  readonly kind: "image" | "file";
  readonly sizeBytes: number;
  readonly mimeType?: string;
}

export interface OutboundFile {
  readonly path: string;
  readonly name: string;
  readonly kind: "image" | "file";
  readonly sizeBytes: number;
}

export interface Session {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly workspace: string;
  readonly agentKind: string;
  readonly agentThreadId: string | null;
  readonly dedicatedPeerId: number | null;
  readonly dedicatedChatId: number | null;
  readonly createdByVkUserId: number;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewSession {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly workspace: string;
  readonly agentKind: string;
  readonly dedicatedPeerId: number | null;
  readonly dedicatedChatId: number | null;
  readonly createdByVkUserId: number;
}
