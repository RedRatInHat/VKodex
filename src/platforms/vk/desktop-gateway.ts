import { APIError, VK, type MessageContext, type MessageEventContext } from "vk-io";
import type { BridgeChat, BridgeInput, ChatMembershipChange, MessageHandle, View } from "../../bridge/contracts.js";
import type { DesktopBridgeConfig } from "../../bridge/config.js";
import { ActionRejectedError, UncertainActionError } from "../../desktop/contracts.js";
import { isObject } from "../../desktop/ipc-client.js";

export function vkKeyboard(view: View): string {
  const buttons = (view.buttons ?? []).map(button => ({
    action: { type: "callback", label: button.label, payload: JSON.stringify({ action: button.action }) }, color: "secondary",
  }));
  if (buttons.length > 12) throw new Error("Inline keyboard exceeds six rows");
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
    if (Array.isArray(node.attachments) && node.attachments.length > 0) return true;
    if (Array.isArray(node.forwards)) pending.push(...node.forwards);
    if (node.replyMessage) pending.push(node.replyMessage);
  }
  return false;
}

export class DesktopVkGateway implements BridgeChat {
  constructor(private readonly config: DesktopBridgeConfig, private readonly vk = new VK({ token: config.token, pollingGroupId: config.access.groupId, apiVersion: "5.199", apiRetryLimit: 0 })) {
    // vk-io's default middleware error handler prints the full exception.
    this.vk.updates.use(async (_context, next) => {
      try { await next(); }
      catch { process.stderr.write("VKodex could not handle an incoming VK event.\n"); }
    });
  }

  async start(onInput: (input: BridgeInput) => Promise<void>, onMembershipChange: (change: ChatMembershipChange) => Promise<void>): Promise<void> {
    // vk-io replaces message_new with chat_kick_user (etc.) for service messages.
    this.vk.updates.on("message", async (context: MessageContext) => {
      if (context.eventType) {
        const id = context.conversationMessageId;
        const validId = typeof id === "number" && Number.isSafeInteger(id) && id > 0;
        await onMembershipChange({ peerId: context.peerId,
          ...(validId ? { eventId: `membership:${id}` } : {}),
          ...(validId && context.eventType === "chat_kick_user" && Number.isSafeInteger(context.eventMemberId) ? { removedMemberId: context.eventMemberId! } : {}),
        });
        return;
      }
      if (!context.is(["message_new"]) || context.isOutbox) return;
      if (context.senderId !== this.config.access.ownerId) return;
      const id = context.conversationMessageId;
      if (!Number.isSafeInteger(id) || !id || id <= 0) return;
      await onInput({ eventId: `message:${id}`, peerId: context.peerId, senderId: context.senderId, text: context.text ?? "", hasAttachments: hasVkAttachments(context) });
    });
    this.vk.updates.on("message_event", async (context: MessageEventContext) => {
      if (context.userId !== this.config.access.ownerId) return;
      const payload: unknown = context.eventPayload;
      if (!isObject(payload) || typeof payload.action !== "string" || payload.action.length > 100) return;
      // Acknowledgment closes the VK spinner; it does not claim that the action succeeded.
      await context.answer({ type: "show_snackbar", text: "Проверяю запрос…" }).catch(() => {});
      await onInput({ eventId: `callback:${context.eventId}`, peerId: context.peerId, senderId: context.userId, text: "", action: payload.action });
    });
    await this.vk.updates.startPolling();
  }

  async stop(): Promise<void> { await this.vk.updates.stop(); }

  async members(peerId: number): Promise<readonly number[]> {
    const response = await this.vk.api.messages.getConversationMembers({ peer_id: peerId, group_id: this.config.access.groupId });
    if (response.count !== response.items.length) throw new Error("Incomplete VK membership response");
    const members = response.items.map(item => item.member_id);
    if (members.some(id => !Number.isSafeInteger(id))) throw new Error("Invalid VK membership response");
    return members;
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
    // Save the known chat even if an invitation failed. The membership gate will pause it.
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
    const response: unknown = await this.vk.api.messages.send(vkSendParams(peerId, view, randomId));
    const item: unknown = Array.isArray(response) ? response[0] : undefined;
    if (!isObject(item) || item.peer_id !== peerId || !Number.isSafeInteger(item.conversation_message_id) || (item.conversation_message_id as number) <= 0) throw new Error("Invalid VK message response");
    return { peerId, conversationMessageId: item.conversation_message_id as number };
  }

  async edit(handle: MessageHandle, view: View): Promise<void> {
    await this.vk.api.messages.edit({ peer_id: handle.peerId, cmid: handle.conversationMessageId, message: view.text, ...(view.buttons ? { keyboard: vkKeyboard(view) } : {}), ...(view.attachments?.length ? { attachment: view.attachments.join(",") } : {}), dont_parse_links: 1, disable_mentions: 1 });
  }

  async uploadDocument(peerId: number, name: string, contents: string): Promise<string> {
    const attachment = await this.vk.upload.messageDocument({ peer_id: peerId, title: name, source: { value: Buffer.from(contents, "utf8"), filename: name } });
    return attachment.toString();
  }
}
