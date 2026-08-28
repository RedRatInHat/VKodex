import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreatedConversation } from "../src/platforms/vk/vk-chat.js";

test("VK chat peer id is derived from chat_id, not invited peer_ids", () => {
  assert.deepEqual(
    normalizeCreatedConversation({ chat_id: 42, peer_ids: [123] }, [123]),
    { chatId: 42, peerId: 2_000_000_042 },
  );
});

test("VK chat creation fails when a requested user was not added", () => {
  assert.throws(
    () => normalizeCreatedConversation({ chat_id: 42, peer_ids: [123] }, [123, 456]),
    /did not add requested users/u,
  );
});