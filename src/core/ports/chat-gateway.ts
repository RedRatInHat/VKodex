import type { IncomingMessage, OutboundFile } from "../../domain/models.js";

export interface CreatedConversation {
  readonly chatId: number;
  readonly peerId: number;
}

export type IncomingMessageHandler = (message: IncomingMessage) => Promise<void>;

export interface ChatGateway {
  onMessage(handler: IncomingMessageHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(peerId: number, text: string): Promise<void>;
  sendFiles(peerId: number, files: readonly OutboundFile[]): Promise<void>;
  createConversation(title: string, userIds: readonly number[]): Promise<CreatedConversation>;
}
