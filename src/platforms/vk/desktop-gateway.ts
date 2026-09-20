import { APIError, VK, MessageContext, UpdateSource, DocumentAttachment, type MessageEventContext } from "vk-io";
import { BridgeStore } from "../../bridge/store.js";
import type { Logger } from "pino";
import type { BridgeChat, BridgeInput, HealthCheckResult, MessageHandle, View } from "../../bridge/contracts.js";
import { ChatRateLimitError, FileUploadRejectedError, VK_MAX_INLINE_BUTTONS } from "../../bridge/contracts.js";
import type { DesktopBridgeConfig } from "../../bridge/config.js";
import { ActionRejectedError, UncertainActionError } from "../../core/codex-tasks.js";
import { isObject } from "../../desktop/ipc-client.js";
import type { RemoteAttachment } from "../../domain/models.js";
import { safeFileName } from "../../lib/files.js";
import { checkVkReadiness } from "./readiness.js";
import { createHash } from "node:crypto";

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
  private receiveMessage?: (context: MessageContext) => Promise<void>;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private reconcileBusy = false;
  private reconcileCheckedAt = 0;
  private reconcileError = false;
  private recoveredAt = 0;

  startReconciliation(store: BridgeStore): void {
    if (this.reconcileTimer) return;
    const run = async () => {
      if (this.reconcileBusy || !this.receiveMessage) return;
      this.reconcileBusy = true;
      let failed = false;
      try {
        for (const binding of store.bindings()) {
          if (!binding.attached || binding.peerId === null) continue;
          const peer = binding.peerId;
          const key = `vk-inbound-cursor:${peer}`;
          const baseline = store.getValue<number>(key) ?? store.latestPeerMessage(peer);
          const retryable = store.oldestRetryableMessage(peer);
          const cursor = retryable === null ? baseline : baseline > 0 ? Math.min(baseline, retryable - 1) : retryable - 1;
          // A newly linked chat has no trusted baseline. Never import its old history.
          if (!cursor && retryable === null) continue;
          store.setValue(key, cursor);
          try {
            const result = await this.vk.api.messages.getByConversationMessageId({ peer_id: peer, conversation_message_ids: Array.from({ length: 50 }, (_, index) => cursor + index + 1) });
            for (const message of result.items.sort((a, b) => a.conversation_message_id! - b.conversation_message_id!)) {
              const id = message.conversation_message_id;
              if (!id || id <= cursor || message.peer_id !== peer) continue;
              // Allow in-flight Long Poll events to enter the same deduplication gate first.
              if (message.date * 1_000 > Date.now() - 5_000) break;
              const current = store.getBinding(binding.id);
              if (!current?.attached || current.peerId !== peer) break;
              const inboxKey = JSON.stringify([peer, `message:${id}`]);
              if (message.from_id > 0 && !message.action && !message.out && !store.hasInput(inboxKey)) {
                const payload = { client_info: {}, message: { ...message, out: 0, important: Boolean(message.important) } } as unknown as ConstructorParameters<typeof MessageContext>[0]["payload"];
                const context = new MessageContext({ api: this.vk.api, upload: this.vk.upload, source: UpdateSource.WEBHOOK, updateType: "message_new", groupId: this.config.access.groupId, payload });
                await this.receiveMessage(context);
                if (!store.inputSettled(inboxKey)) break;
                this.recoveredAt = Date.now();
                this.logger?.warn({ peerId: peer, messageId: id }, "Recovered missing VK incoming message");
              }
              // A Long Poll handler may still be preparing an attachment or
              // waiting for Codex. Do not checkpoint past that VK message yet.
              if (message.from_id > 0 && !message.action && !message.out && !store.inputSettled(inboxKey)) break;
              store.setValue(key, id);
            }
          } catch { failed = true; }
        }
        this.reconcileCheckedAt = Date.now(); this.reconcileError = failed;
      } finally { this.reconcileBusy = false; }
    };
    this.reconcileTimer = setInterval(() => { void run().catch(() => { this.reconcileError = true; }); }, 15_000);
    this.reconcileTimer.unref();
    void run().catch(() => { this.reconcileError = true; });
  }
  private writeTail: Promise<void> = Promise.resolve();
  private nextWriteAt = 0;
  private queuedWrites = 0;
  private writeStartedAt = 0;
  private lastWriteSuccessAt = 0;
  private lastWriteFailureAt = 0;
  private pollingStarted = false;
  private readonly senderNames = new Map<number, string>();

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
  constructor(private readonly config: DesktopBridgeConfig, private readonly vk = new VK({ token: config.token, pollingGroupId: config.access.groupId, apiVersion: "5.199", apiRetryLimit: 0 }), private readonly writeIntervalMs = 2_000, private readonly logger?: Logger,
    private readonly senderNameLookup?: (senderId: number) => Promise<string>) {
    // vk-io's default middleware error handler prints the full exception.
    this.vk.updates.use(async (context, next) => {
      // Record metadata before message filters; never log text, attachments or tokens.
      const event = context as unknown as { peerId?: number; conversationMessageId?: number; senderId?: number; type?: string; subTypes?: string[] };
      const receipt = { peerId: event.peerId, messageId: event.conversationMessageId, senderId: event.senderId, type: event.type, subTypes: event.subTypes };
      this.logger?.info(receipt, "VK ingress received");
      try { await next(); }
      catch {
        if (this.logger) this.logger.error(receipt, "VKodex could not handle an incoming VK event");
        else process.stderr.write("VKodex could not handle an incoming VK event.\n");
      }
    });
  }

  private async senderName(senderId: number): Promise<string> {
    const cached = this.senderNames.get(senderId);
    if (cached) return cached;
    const fallback = senderId > 0 ? "Пользователь VK" : "Сообщество VK";
    let timer: NodeJS.Timeout | undefined;
    try {
      const lookup = this.senderNameLookup ? this.senderNameLookup(senderId) : this.fetchSenderName(senderId);
      const value = await Promise.race([lookup, new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(fallback), 5_000); timer.unref();
      })]);
      const safe = value.replace(/[\x00-\x1f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120) || fallback;
      this.senderNames.set(senderId, safe); return safe;
    } catch {
      this.senderNames.set(senderId, fallback); return fallback;
    } finally { if (timer) clearTimeout(timer); }
  }

  private async fetchSenderName(senderId: number): Promise<string> {
    if (senderId > 0) {
      const users = await this.vk.api.users.get({ user_ids: [senderId] });
      const user = users[0];
      return user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() : "";
    }
    const response = await this.vk.api.groups.getById({ group_ids: [-senderId] });
    return response.groups[0]?.name ?? "";
  }

  async start(onInput: (input: BridgeInput) => Promise<void>): Promise<void> {
    // Membership service messages are irrelevant: a linked task chat accepts
    // prompts from every sender except the community itself.
    this.receiveMessage = async (context: MessageContext) => {
      if (context.eventType === "chat_title_update") {
        const title = context.eventText?.replace(/[\x00-\x1f]+/gu, " ").replace(/\s+/gu, " ").trim();
        if (!title) return;
        const eventId = context.conversationMessageId ?? context.id ?? 0;
        const digest = createHash("sha256").update(JSON.stringify([eventId, context.updatedAt ?? 0, title])).digest("hex").slice(0, 16);
        await onInput({ eventId: `chat-title:${context.peerId}:${eventId}:${digest}`, peerId: context.peerId, senderId: context.senderId, text: "", conversationTitle: title });
        return;
      }
      if (context.eventType) return;
      if (!context.is(["message_new", "message_edit"]) || context.isOutbox) return;
      if ([this.config.access.groupId, -this.config.access.groupId].includes(context.senderId)) return;
      const id = context.conversationMessageId;
      if (!Number.isSafeInteger(id) || !id || id <= 0) return;
      const senderName = await this.senderName(context.senderId);
      const edited = context.is(["message_edit"]);
      if (edited) {
        const text = context.text ?? "";
        const digest = createHash("sha256").update(JSON.stringify([id, context.updatedAt ?? 0, text])).digest("hex").slice(0, 16);
        await onInput({ eventId: `message-edit:${id}:${digest}`, peerId: context.peerId, senderId: context.senderId, senderName, text,
          ...(context.replyMessage?.conversationMessageId ? { replyToMessageId: context.replyMessage.conversationMessageId } : {}),
          editOfMessageId: id, ...(hasVkAttachments(context) ? { hasAttachments: true } : {}) });
        return;
      }
      let attachments: RemoteAttachment[] = []; let attachmentError: string | undefined;
      try { attachments = await collectVkFiles(context); }
      catch (error) { attachmentError = error instanceof ActionRejectedError ? error.message : "Не удалось получить вложения из VK. Сообщение не отправлено."; }
      await onInput({ eventId: `message:${id}`, peerId: context.peerId, senderId: context.senderId, senderName, text: context.text ?? "", attachments,
        ...(context.replyMessage?.conversationMessageId ? { replyToMessageId: context.replyMessage.conversationMessageId } : {}),
        ...(attachmentError ? { hasAttachments: true, attachmentError } : {}) });
      this.logger?.info({ peerId: context.peerId, messageId: id }, "VK ingress handler completed");
    };
    this.vk.updates.on("message", this.receiveMessage);
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
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
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
      { name: "vk_inbound_reconciliation", state: this.reconcileError || (this.reconcileCheckedAt > 0 && Date.now() - this.reconcileCheckedAt > 120_000) ? "degraded" : this.recoveredAt && Date.now() - this.recoveredAt < 15 * 60_000 ? "degraded" : "ok", detail: this.reconcileError ? "Не удалось сверить входящие сообщения с VK." : this.recoveredAt && Date.now() - this.recoveredAt < 15 * 60_000 ? "Обнаружены и восстановлены сообщения, пропущенные Long Poll." : `Последняя сверка входящих: ${this.reconcileCheckedAt ? new Date(this.reconcileCheckedAt).toISOString() : "ещё не выполнена"}.` },
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

  async delete(handle: MessageHandle): Promise<void> {
    await this.write(() => this.vk.api.messages.delete({ peer_id: handle.peerId, cmids: handle.conversationMessageId, delete_for_all: 1, group_id: this.config.access.groupId }));
  }

  async uploadDocument(peerId: number, name: string, contents: string): Promise<string> {
    return this.uploadFile(peerId, name, Buffer.from(contents, "utf8"), "file");
  }

  async uploadFile(peerId: number, name: string, contents: Buffer, kind: "image" | "file"): Promise<string> {
    const source = { values: [{ value: contents, filename: name, contentLength: contents.length,
      ...(/\.mp4$/iu.test(name) ? { contentType: "video/mp4" } : {}) }], timeout: 600_000 };
    let attachment: string | undefined;
    if (kind === "image") {
      try { attachment = (await this.vk.upload.messagePhoto({ peer_id: peerId, source })).toString(); }
      catch { /* Preserve unsupported image formats as documents. */ }
    }
    if (!attachment) {
      // vk-io forwards upload-server errors to docs.save as if they were a
      // successful upload. Preserve the actual failure before it is masked by
      // API error 100 ("file is undefined"). Never log upload tokens or URLs.
      const saved = await this.vk.upload.conduct({
        field: "file", params: { peer_id: peerId, title: name, type: "doc", source },
        getServer: this.vk.api.docs.getMessagesUploadServer, serverParams: ["type", "peer_id"],
        saveParams: ["title", "tags"], maxFiles: 1, attachmentType: "doc",
        saveFiles: async uploaded => {
          const storageFull = isObject(uploaded) && typeof uploaded.error === "string" && /^no_free_space(?:\/|$)/u.test(uploaded.error);
          if (isObject(uploaded) && uploaded.error === "wrong_file") {
            this.logger?.warn({ peerId, bytes: contents.length, reason: "wrong_file" }, "VK document upload rejected");
            throw new FileUploadRejectedError("VK отклонил файл: wrong_file. Это отказ принять формат или содержимое, а не лимит размера VKodex. Автоматические повторы этого файла остановлены.");
          }
          if (!isObject(uploaded) || uploaded.error !== undefined || typeof uploaded.file !== "string" || !uploaded.file.trim()) {
            this.logger?.warn({ peerId, bytes: contents.length, reason: storageFull ? "upload_storage_full" : "invalid_upload_response" }, "VK document upload rejected");
            throw new ActionRejectedError(storageFull
              ? "На сервере загрузки VK закончилось свободное место. Файл не отправлен; лимит размера VKodex здесь ни при чём. Повтори /files позже."
              : "Сервер загрузки VK не подтвердил приём файла. Файл не отправлен; повтори /files позже.");
          }
          return this.vk.api.docs.save({ file: uploaded.file, title: name });
        },
      });
      if (!isObject(saved) || saved.type !== "doc" || !isObject(saved.doc) || typeof saved.doc.id !== "number" || typeof saved.doc.owner_id !== "number") throw new ActionRejectedError("VK не подтвердил сохранение документа. Повтори /files позже.");
      attachment = new DocumentAttachment({ api: this.vk.api, payload: { ...saved.doc, id: saved.doc.id, owner_id: saved.doc.owner_id } }).toString();
    }
    if (!/^(?:photo|doc)-?\d+_\d+(?:_[a-zA-Z0-9_-]+)?$/u.test(attachment)) throw new ActionRejectedError("VK не подтвердил загрузку файла. Повтори /files позже.");
    return attachment;
  }
}
