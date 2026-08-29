import { APIError, VK, type MessageContext, type MessageEventContext } from "vk-io";
import type { BridgeChat, BridgeInput, HealthCheckResult, MessageHandle, View } from "../../bridge/contracts.js";
import { ChatRateLimitError, VK_MAX_INLINE_BUTTONS } from "../../bridge/contracts.js";
import type { DesktopBridgeConfig } from "../../bridge/config.js";
import { ActionRejectedError, UncertainActionError } from "../../desktop/contracts.js";
import { isObject } from "../../desktop/ipc-client.js";
import type { RemoteAttachment } from "../../domain/models.js";
import { safeFileName } from "../../lib/files.js";
import { checkVkReadiness } from "./readiness.js";

export function vkKeyboard(view: View): string {
  const buttons = (view.buttons ?? []).map(button => ({
    action: { type: "callback", label: button.label, payload: JSON.stringify({ action: button.action }) }, color: "secondary",
  }));
  if (buttons.length > VK_MAX_INLINE_BUTTONS) throw new Error("Inline keyboard exceeds ten buttons");
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return JSON.stringify({ inline: true, buttons: rows });
}

export function vkSendParams(peerId: number, view: View, randomId: number) {
  return {
    peer_ids: [peerId], random_id: randomId, message: view.text,
    ...(view.buttons ? { keyboard: vkKeyboard(view) } : {}),
    ...(view.silent ? { silent: 1 } : {}),
    ...(view.attachments?.length ? { attachment: view.attachments.join(",") } : {}),
    dont_parse_links: 1 as const, disable_mentions: 1 as const,
  };
}

export function hasVkAttachments(message: unknown): boolean {
  const pending: unknown[] = [message];
  const visited = new Set<object>();
  while (pending.length) {
    const node = pending.pop();
    if (!isObject(node) || visited.has(node)) continue;
    visited.add(node);
    if (visited.size > 100) return true;
    if (Array.isArray(node.attachments) && node.attachments.some(attachment => {
      if (!isObject(attachment) || attachment.type !== "link") return true;
      const url = typeof attachment.url === "string" ? attachment.url : isObject(attachment.link) ? attachment.link.url : undefined;
      // VK adds previews to plain URLs. The URL itself already reaches Codex
      // in the text; standalone cards and actual files need separate handling.
      return typeof url !== "string" || !url || typeof node.text !== "string" || !node.text.includes(url);
    })) return true;
    if (Array.isArray(node.forwards)) pending.push(...node.forwards);
    if (node.replyMessage) pending.push(node.replyMessage);
  }
  return false;
}

export async function collectVkFiles(message: unknown): Promise<RemoteAttachment[]> {
  const pending = [message]; const visited = new Set<object>(); const seen = new Set<string>(); const result: RemoteAttachment[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!isObject(node) || visited.has(node)) continue;
    visited.add(node);
    if (visited.size > 100) throw new ActionRejectedError("Слишком много пересланных сообщений.");
    for (const value of Array.isArray(node.attachments) ? node.attachments : []) {
      if (!isObject(value)) throw new ActionRejectedError("Не удалось прочитать вложение VK.");
      if (value.type === "link" && !hasVkAttachments({ text: node.text, attachments: [value] })) continue;
      if (!["photo", "doc", "document"].includes(String(value.type))) throw new ActionRejectedError("Поддерживаются фотографии и документы. Другие вложения пришли как файл.");
      if (typeof value.loadAttachmentPayload === "function") await value.loadAttachmentPayload();
      const payload = isObject(value.photo) ? value.photo : isObject(value.doc) ? value.doc : value;
      const sizes = (Array.isArray(payload.sizes) ? payload.sizes : []).filter(isObject).sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height));
      // vk-io's largeSizeUrl getter throws when a small photo has no y/z/w size.
      const url = value.type === "photo" ? sizes[0]?.url ?? payload.largeSizeUrl : payload.url;
      if (typeof url !== "string" || !url) throw new ActionRejectedError("VK не предоставил ссылку для загрузки вложения.");
      if (seen.has(url)) continue; seen.add(url);
      const fileName = value.type === "photo" ? `photo-${result.length + 1}.jpg` : safeFileName(String(payload.title ?? "document"), "document");
      result.push({ key: String(result.length), url, fileName,
        kind: value.type === "photo" || /\.(?:png|jpe?g|webp|gif)$/iu.test(fileName) ? "image" : "file",
        ...(typeof payload.size === "number" ? { sizeBytes: payload.size } : {}) });
      if (result.length > 10) throw new ActionRejectedError("За одно сообщение можно передать до 10 файлов.");
    }
    if (Array.isArray(node.forwards)) pending.push(...node.forwards);
    if (node.replyMessage) pending.push(node.replyMessage);
  }
  return result;
}

export class DesktopVkGateway implements BridgeChat {
  private writeTail: Promise<void> = Promise.resolve();
  private nextWriteAt = 0;
  private queuedWrites = 0;
  private writeStartedAt = 0;
  private lastWriteSuccessAt = 0;
  private lastWriteFailureAt = 0;
  private pollingStarted = false;

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.writeTail;
    this.writeTail = new Promise<void>(resolve => { release = resolve; });
    this.queuedWrites++;
    await previous;
    this.writeStartedAt = Date.now();
    try {
      const delay = Math.max(0, this.nextWriteAt - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const result = await operation();
        this.lastWriteSuccessAt = Date.now();
        return result;
      }
      catch (error) {
        this.lastWriteFailureAt = Date.now();
        if (error instanceof APIError && [6, 9, 29].includes(Number(error.code))) throw new ChatRateLimitError(Number(error.code) === 6 ? 1_000 : 120_000);
        throw error;
      }
    } finally {
      this.nextWriteAt = Date.now() + this.writeIntervalMs;
      this.writeStartedAt = 0;
      this.queuedWrites--;
      release();
    }
  }
  constructor(private readonly config: DesktopBridgeConfig, private readonly vk = new VK({ token: config.token, pollingGroupId: config.access.groupId, apiVersion: "5.199", apiRetryLimit: 0 }), private readonly writeIntervalMs = 2_000) {
    // vk-io's default middleware error handler prints the full exception.
    this.vk.updates.use(async (_context, next) => {
      try { await next(); }
      catch { process.stderr.write("VKodex could not handle an incoming VK event.\n"); }
    });
  }

  async start(onInput: (input: BridgeInput) => Promise<void>): Promise<void> {
    // Membership service messages are irrelevant: a linked task chat accepts
    // prompts from every sender except the community itself.
    this.vk.updates.on("message", async (context: MessageContext) => {
      if (context.eventType) return;
      if (!context.is(["message_new"]) || context.isOutbox) return;
      if ([this.config.access.groupId, -this.config.access.groupId].includes(context.senderId)) return;
      const id = context.conversationMessageId;
      if (!Number.isSafeInteger(id) || !id || id <= 0) return;
      let attachments: RemoteAttachment[] = []; let attachmentError: string | undefined;
      try { attachments = await collectVkFiles(context); }
      catch (error) { attachmentError = error instanceof ActionRejectedError ? error.message : "Не удалось получить вложения из VK. Сообщение не отправлено."; }
      await onInput({ eventId: `message:${id}`, peerId: context.peerId, senderId: context.senderId, text: context.text ?? "", attachments,
        ...(attachmentError ? { hasAttachments: true, attachmentError } : {}) });
    });
    this.vk.updates.on("message_event", async (context: MessageEventContext) => {
      if (context.userId !== this.config.access.ownerId) return;
      const payload: unknown = context.eventPayload;
      if (!isObject(payload) || typeof payload.action !== "string" || payload.action.length > 100) return;
      // Acknowledgment closes the VK spinner; it does not claim that the action succeeded.
      await context.answer({ type: "show_snackbar", text: "Проверяю запрос…" }).catch(() => {});
      await onInput({ eventId: `callback:${context.eventId}`, peerId: context.peerId, senderId: context.userId, text: "", action: payload.action });
    });
    try {
      await this.vk.updates.startPolling();
      this.pollingStarted = true;
    } catch (error) {
      this.pollingStarted = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.pollingStarted = false;
    await this.vk.updates.stop();
  }

  async health(): Promise<readonly HealthCheckResult[]> {
    const readiness = await checkVkReadiness({
      tokenPermissions: () => this.write(() => this.vk.api.groups.getTokenPermissions({})),
      longPollSettings: () => this.write(() => this.vk.api.groups.getLongPollSettings({ group_id: this.config.access.groupId })),
      longPollServer: () => this.write(() => this.vk.api.groups.getLongPollServer({ group_id: this.config.access.groupId })),
    });
    const failed = readiness.filter(check => !check.ok);
    const writeAge = this.writeStartedAt ? Date.now() - this.writeStartedAt : 0;
    const writesState = writeAge > 30_000 ? "failed" : this.queuedWrites > 10 || this.lastWriteFailureAt > this.lastWriteSuccessAt ? "degraded" : "ok";
    const pollingActive = this.pollingStarted && this.vk.updates.isStarted;
    return [
      { name: "vk_long_poll", state: pollingActive ? "ok" : "failed", detail: pollingActive ? "Локальный Bots Long Poll запущен." : "Внутренний polling-цикл vk-io не работает." },
      { name: "vk_api", state: failed.length ? "failed" : "ok", detail: failed.length ? failed.map(check => check.detail).join(" ").slice(0, 500) : "Токен, сообщения, события и Long Poll server подтверждены VK." },
      { name: "vk_writes", state: writesState, detail: `Запросов на запись в очереди: ${this.queuedWrites}${writeAge ? `; текущий выполняется ${Math.round(writeAge / 1_000)} с` : ""}.` },
    ];
  }

  async createConversation(title: string): Promise<{ peerId: number; chatId: number }> {
    let response: unknown;
    try {
      response = await this.vk.api.messages.createChat({ title, user_ids: [this.config.access.ownerId], group_id: this.config.access.groupId });
    } catch (error) {
      if (error instanceof APIError && typeof error.code === "number" && [5, 7, 14, 15, 27, 28, 100].includes(error.code)) throw new ActionRejectedError("VK отклонил создание беседы. Проверь права сообщества и возможность приглашения владельца.");
      throw error;
    }
    const chatId = typeof response === "number" ? response : isObject(response) ? response.chat_id : undefined;
    if (!Number.isSafeInteger(chatId) || (chatId as number) <= 0) throw new Error("Invalid VK chat response");
    // The invite link is returned separately; VK may or may not add the owner automatically.
    return { chatId: chatId as number, peerId: 2_000_000_000 + (chatId as number) };
  }

  async inviteLink(peerId: number): Promise<string> {
    const response = await this.vk.api.messages.getInviteLink({ peer_id: peerId, group_id: this.config.access.groupId, reset: 0 });
    const url = new URL(response.link);
    if (url.protocol !== "https:" || !["vk.com", "vk.ru", "vk.me"].includes(url.hostname)) throw new Error("Unexpected VK invitation URL");
    return url.href;
  }

  async renameConversation(peerId: number, title: string, beforeWrite: () => Promise<void>): Promise<void> {
    const chatId = peerId - 2_000_000_000;
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || chatId > 100_000_000 || !title.trim() || title.length > 200 || /[\r\n\x00-\x1f]/u.test(title)) {
      throw new ActionRejectedError("Недопустимая беседа или название VK.");
    }
    const readTitle = async (): Promise<string> => {
      const response = await this.vk.api.messages.getConversationsById({ peer_ids: [peerId], group_id: this.config.access.groupId });
      const conversation = response.items.find(item => item.peer.id === peerId && item.peer.type === "chat");
      if (typeof conversation?.chat_settings?.title !== "string") throw new UncertainActionError();
      return conversation.chat_settings.title;
    };
    try {
      // An explicit retry after a lost response must not rename an already updated chat again.
      if (await readTitle() === title) return;
      await beforeWrite();
      const result = await this.vk.api.messages.editChat({ chat_id: chatId, title });
      if (result !== 1 || await readTitle() !== title) throw new UncertainActionError();
    } catch {
      // VK errors may include request parameters. Never expose them to the chat or logs.
      throw new UncertainActionError();
    }
  }

  async send(peerId: number, view: View, randomId: number): Promise<MessageHandle> {
    const response: unknown = await this.write(() => this.vk.api.messages.send(vkSendParams(peerId, view, randomId)));
    const item: unknown = Array.isArray(response) ? response[0] : undefined;
    if (!isObject(item) || item.peer_id !== peerId || !Number.isSafeInteger(item.conversation_message_id) || (item.conversation_message_id as number) <= 0) throw new Error("Invalid VK message response");
    return { peerId, conversationMessageId: item.conversation_message_id as number };
  }

  async edit(handle: MessageHandle, view: View): Promise<void> {
    await this.write(() => this.vk.api.messages.edit({ peer_id: handle.peerId, cmid: handle.conversationMessageId, message: view.text, ...(view.buttons ? { keyboard: vkKeyboard(view) } : {}), ...(view.attachments?.length ? { attachment: view.attachments.join(",") } : {}), dont_parse_links: 1, disable_mentions: 1 }));
  }

  async uploadDocument(peerId: number, name: string, contents: string): Promise<string> {
    const attachment = await this.vk.upload.messageDocument({ peer_id: peerId, title: name, source: { value: Buffer.from(contents, "utf8"), filename: name } });
    return attachment.toString();
  }

  async uploadFile(peerId: number, name: string, contents: Buffer, kind: "image" | "file"): Promise<string> {
    const source = { value: contents, filename: name };
    let attachment: string | undefined;
    if (kind === "image") {
      try { attachment = (await this.vk.upload.messagePhoto({ peer_id: peerId, source })).toString(); }
      catch { /* Preserve unsupported image formats as documents. */ }
    }
    attachment ??= (await this.vk.upload.messageDocument({ peer_id: peerId, title: name, source })).toString();
    if (!/^(?:photo|doc)-?\d+_\d+(?:_[a-zA-Z0-9_-]+)?$/u.test(attachment)) throw new ActionRejectedError("VK не подтвердил загрузку файла. Повтори /files позже.");
    return attachment;
  }
}
