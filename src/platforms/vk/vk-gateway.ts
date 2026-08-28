import path from "node:path";
import { VK, getRandomId, type MessageContext } from "vk-io";
import type { Logger } from "pino";
import type { AppConfig } from "../../config.js";
import type { IncomingMessage, OutboundFile, RemoteAttachment } from "../../domain/models.js";
import type {
  ChatGateway,
  CreatedConversation,
  IncomingMessageHandler,
} from "../../core/ports/chat-gateway.js";
import { safeFileName } from "../../lib/files.js";
import { normalizeCreatedConversation } from "./vk-chat.js";

interface AttachmentLike {
  readonly type?: string;
  readonly id?: number;
  readonly ownerId?: number;
  readonly accessKey?: string;
  readonly title?: string;
  readonly extension?: string;
  readonly size?: number;
  readonly url?: string;
  readonly largeSizeUrl?: string;
  readonly sizes?: readonly { readonly url?: string; readonly width?: number; readonly height?: number }[];
  loadAttachmentPayload?(): Promise<void>;
  toString?(): string;
}

interface MessageLike {
  readonly attachments?: readonly AttachmentLike[];
  readonly forwards?: readonly MessageLike[];
  readonly replyMessage?: MessageLike;
}

export class VkGateway implements ChatGateway {
  private readonly vk: VK;
  private handler: IncomingMessageHandler | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.vk = new VK({
      token: config.vk.token,
      pollingGroupId: config.vk.groupId,
    });
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) throw new Error("VK incoming-message handler is not configured");
    this.vk.updates.on("message_new", async (context: MessageContext) => {
      const metadata = context as unknown as { readonly isOutbox?: boolean; readonly action?: unknown };
      if (metadata.isOutbox || metadata.action) return;

      // Reject before loading attachment payloads. The controller repeats the
      // check so the authorization boundary is not platform-dependent.
      if (!this.config.vk.allowedUserIds.has(context.senderId)) {
        this.logger.warn({ peerId: context.peerId, senderId: context.senderId }, "Denied VK user at gateway");
        return;
      }

      try {
        const incoming: IncomingMessage = {
          peerId: context.peerId,
          senderId: context.senderId,
          isChat: context.isChat,
          text: context.text ?? "",
          attachments: await this.collectAttachments(context as unknown as MessageLike),
        };
        await this.handler?.(incoming);
      } catch (error) {
        this.logger.error(
          { err: error, peerId: context.peerId, senderId: context.senderId },
          "VK update handling failed before controller",
        );
        await this.sendText(context.peerId, "Не удалось прочитать сообщение или вложения. Подробности в журнале бота.")
          .catch((sendError) => this.logger.error({ err: sendError, peerId: context.peerId }, "VK error reply failed"));
      }
    });
    await this.vk.updates.startPolling();
  }

  async stop(): Promise<void> {
    await this.vk.updates.stop();
  }

  async sendText(peerId: number, text: string): Promise<void> {
    await this.vk.api.messages.send({
      peer_id: peerId,
      random_id: getRandomId(),
      message: text,
    });
  }

  async sendFiles(peerId: number, files: readonly OutboundFile[]): Promise<void> {
    for (const file of files) {
      const uploaded = await this.uploadFile(peerId, file);
      await this.vk.api.messages.send({
        peer_id: peerId,
        random_id: getRandomId(),
        message: file.name,
        attachment: String(uploaded),
      });
    }
  }

  async createConversation(title: string, userIds: readonly number[]): Promise<CreatedConversation> {
    const requestedUserIds = [...new Set(userIds)];
    if (requestedUserIds.length === 0) throw new Error("A VK conversation requires at least one user");

    const response = await this.vk.api.messages.createChat({
      user_ids: requestedUserIds,
      title: title.slice(0, 200),
      group_id: this.config.vk.groupId,
    }) as unknown;

    return normalizeCreatedConversation(response, requestedUserIds);
  }

  private async uploadFile(peerId: number, file: OutboundFile): Promise<unknown> {
    if (file.kind === "image") {
      try {
        return await this.vk.upload.messagePhoto({
          peer_id: peerId,
          source: { value: file.path, filename: file.name },
        });
      } catch {
        // Some image containers/codecs are not accepted by VK's photo endpoint.
        // Sending them as documents is preferable to losing the artifact.
      }
    }

    return this.vk.upload.messageDocument({
      peer_id: peerId,
      title: file.name,
      source: { value: file.path, filename: file.name },
    });
  }

  private async collectAttachments(message: MessageLike): Promise<readonly RemoteAttachment[]> {
    const result: RemoteAttachment[] = [];
    const seen = new Set<string>();

    const visit = async (node: MessageLike | undefined): Promise<void> => {
      if (!node) return;
      for (const attachment of node.attachments ?? []) {
        await attachment.loadAttachmentPayload?.();
        const remote = this.toRemoteAttachment(attachment);
        if (remote && !seen.has(remote.key)) {
          seen.add(remote.key);
          result.push(remote);
        }
      }
      await visit(node.replyMessage);
      for (const forwarded of node.forwards ?? []) await visit(forwarded);
    };

    await visit(message);
    return result;
  }

  private toRemoteAttachment(attachment: AttachmentLike): RemoteAttachment | null {
    const type = attachment.type?.toLowerCase();
    const key = attachment.toString?.() || `${type ?? "unknown"}:${attachment.ownerId ?? 0}:${attachment.id ?? 0}`;

    if (type === "photo") {
      const bestSize = [...(attachment.sizes ?? [])]
        .filter((size) => Boolean(size.url))
        .sort((left, right) => (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0))[0];
      const url = attachment.largeSizeUrl ?? bestSize?.url;
      if (!url) return null;
      const fileName = safeFileName(`vk-photo-${attachment.ownerId ?? 0}-${attachment.id ?? Date.now()}.jpg`, "vk-photo.jpg");
      return { key, kind: "image", fileName, url };
    }

    if (type === "doc" || type === "document") {
      if (!attachment.url) return null;
      const extension = attachment.extension ? `.${attachment.extension.replace(/^\./u, "")}` : "";
      const rawTitle = attachment.title || `vk-document-${attachment.id ?? Date.now()}${extension}`;
      const titleHasExtension = path.extname(rawTitle).length > 0;
      const fileName = safeFileName(titleHasExtension ? rawTitle : `${rawTitle}${extension}`, "vk-document");
      return {
        key,
        kind: IMAGE_EXTENSIONS_FOR_VK.has(path.extname(fileName).toLowerCase()) ? "image" : "file",
        fileName,
        url: attachment.url,
        ...(attachment.size === undefined ? {} : { sizeBytes: attachment.size }),
      };
    }

    return null;
  }
}

const IMAGE_EXTENSIONS_FOR_VK = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
