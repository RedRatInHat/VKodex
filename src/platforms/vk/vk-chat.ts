import type { CreatedConversation } from "../../core/ports/chat-gateway.js";

interface CreateChatPayload {
  readonly chat_id?: number;
  readonly peer_ids?: readonly number[];
}

/**
 * Normalizes both the current object response and the historical numeric
 * response used by older VK API wrappers.
 */
export function normalizeCreatedConversation(
  rawResponse: unknown,
  requestedUserIds: readonly number[],
): CreatedConversation {
  const outer = rawResponse as { readonly response?: unknown };
  const response = outer && typeof outer === "object" && "response" in outer
    ? outer.response
    : rawResponse;
  const payload = response as CreateChatPayload;
  const chatId = typeof response === "number" ? response : payload?.chat_id;

  if (typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new Error(`Unexpected messages.createChat response: ${JSON.stringify(rawResponse)}`);
  }

  if (typeof response !== "number" && payload.peer_ids) {
    const added = new Set(payload.peer_ids);
    const missing = requestedUserIds.filter((userId) => !added.has(userId));
    if (missing.length > 0) {
      throw new Error(`VK did not add requested users to the chat: ${missing.join(", ")}`);
    }
  }

  return {
    chatId,
    peerId: 2_000_000_000 + chatId,
  };
}
