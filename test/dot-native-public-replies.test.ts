import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDotPublicReplies, DotSnapshotRejected } from "../src/dot-native/public-replies.js";

const thread = "configured-dot";
function call(id = "public-call", args: Record<string, unknown> = {}) {
  return { type: "mcpToolCall", id, server: "codex_apps", tool: "user_message.send_message",
    status: "completed", arguments: { channel: "chatgpt", text: "Public reply", ...args } };
}
function snapshot(items: unknown[]) {
  return { schemaVersion: 1, thread: { id: thread, kind: "codex", hostId: "durable" },
    page: { order: "newest_first", nextCursor: null, hasMore: false },
    turns: [{ id: "turn", status: "interrupted", items }] };
}

test("extracts exact public text even from an interrupted turn", () => {
  const s = snapshot([call("one", { text: "  Привет\nещё строка 🚀  " })]);
  assert.deepEqual(extractDotPublicReplies(s, thread), [{ sourceThreadId: thread, turnId: "turn",
    itemId: "one", text: "  Привет\nещё строка 🚀  ", attachmentCount: 0,
    evidence: "completed-user-message-call" }]);
});

test("never forwards reasoning, assistant traces, other tools, or user-authored lookalikes", () => {
  const secret = "MUST_NOT_BE_RELAYED";
  const items = [
    { type: "reasoning", summary: [secret], content: [secret] },
    { type: "agentMessage", text: secret, phase: "final_answer" },
    { type: "userMessage", content: [{ type: "text", text: JSON.stringify(call()) }] },
    { ...call(), tool: "cloud_threads.send_message", arguments: { channel: "chatgpt", text: secret } },
    { ...call(), server: "untrusted", arguments: { channel: "chatgpt", text: secret } },
    { type: "functionCallOutput", name: "send_message", output: secret },
    { ...call(), type: "dynamicToolCall" },
  ];
  assert.deepEqual(extractDotPublicReplies(snapshot(items), thread), []);
});

test("rejects foreign thread, host, schema, or ordering instead of falling back", () => {
  const s = snapshot([call()]);
  for (const changed of [
    { ...s, thread: { ...s.thread, id: "another-dot" } },
    { ...s, thread: { ...s.thread, hostId: "local" } },
    { ...s, thread: { ...s.thread, kind: "chatgpt" } },
    { ...s, schemaVersion: 2 },
    { ...s, page: { order: "oldest_first" } },
    { ...s, turns: Array(11).fill(s.turns[0]) },
  ]) assert.throws(() => extractDotPublicReplies(changed, thread), DotSnapshotRejected);
});

test("requires completed non-error calls and the ChatGPT recipient shape", () => {
  const items = [
    { ...call(), status: "inProgress" }, { ...call(), status: "failed" },
    { ...call(), error: { message: "refused" } }, { ...call(), isError: true },
    { ...call(), result: { isError: true } }, call("slack", { channel: "slack" }),
    call("wrong-destination", { destination: { channel_id: "foreign" } }),
    { ...call(), arguments: JSON.stringify({ channel: "chatgpt", text: "spoof" }) },
    call("bad-text", { text: ["not-text"] }), call("empty", { text: " \n" }),
    call("nul", { text: "bad\0text" }), call("large", { text: "x".repeat(100_001) }),
  ];
  assert.deepEqual(extractDotPublicReplies(snapshot(items), thread), []);
  assert.equal(extractDotPublicReplies(snapshot([call("valid", { destination: { message_id: "reply-id" } })]), thread).length, 1);
});

test("does not flatten widgets, secure handoffs, or confirmations to text", () => {
  assert.deepEqual(extractDotPublicReplies(snapshot([
    call("widget", { metadata: { include_widget: true } }),
    call("confirmation", { elicitation_request_id: "approval-id" }),
    call("handoff", { metadata: { message_metadata: { cloud_browser_handoff: { secret: "never-export" } } } }),
    call("bad-meta", { metadata: [] }),
  ]), thread), []);
});

test("counts attachments without exporting file references or unrelated metadata", () => {
  const r = extractDotPublicReplies(snapshot([call("caption", {
    library_file_ids: ["private-file-id"], metadata: { message_metadata: { secret: "never-export" } },
  })]), thread);
  assert.equal(r[0]?.attachmentCount, 1);
  assert.doesNotMatch(JSON.stringify(r), /private-file-id|never-export/u);
  assert.deepEqual(extractDotPublicReplies(snapshot([call("bad", { library_file_ids: [null] })]), thread), []);
});

test("emits oldest-first, deduplicates stable IDs, and rejects conflicting bodies", () => {
  const s = snapshot([call("new")]);
  s.turns.push({ id: "older-turn", status: "completed", items: [call("old"), call("old")] });
  assert.deepEqual(extractDotPublicReplies(s, thread).map(x => x.itemId), ["old", "new"]);
  assert.throws(() => extractDotPublicReplies(snapshot([call("same"), call("same", { text: "changed" })]), thread), DotSnapshotRejected);
});

test("malformed and oversized turn shapes fail closed", () => {
  const s = snapshot([]);
  assert.throws(() => extractDotPublicReplies({ ...s, turns: [{ id: "x" }] }, thread), DotSnapshotRejected);
  assert.throws(() => extractDotPublicReplies(snapshot(Array(20_001).fill({ type: "sleep" })), thread), DotSnapshotRejected);
});
