import assert from "node:assert/strict";
import test from "node:test";
import { qualifyDotRoomRows, readDotRoomDocument, type DotRoomBinding, type DotRoomRow } from "../src/dot-browser/room-observation.js";

const room = "a".repeat(32);
const id = (n: number, roomId = room) => `${roomId}~${roomId}~CalpicoMessage~Sentinel_${n.toString(16).padStart(32, "0")}`;
const binding: DotRoomBinding = { pageUrl: "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  roomId: room, ownerAnchorId: id(1), dotAnchorId: id(2) };
function row(n: number, owner: boolean, text = "same text"): DotRoomRow {
  return { tagName: "ARTICLE", classes: ["message-row", ...(owner ? ["self"] : [])],
    messageId: id(n), bodyIds: [id(n)], textBlocks: [text], unsupportedContent: false };
}
const initial = () => [row(1, true), row(2, false)];
const qualify = (rows = initial(), pageUrl = binding.pageUrl) => qualifyDotRoomRows(pageUrl, rows, binding);

test("room observation preserves full IDs, DOM order and duplicate text without inventing authority", () => {
  const result = qualify([...initial(), row(3, true)]);
  assert.deepEqual(result.messages.map(m => m.messageId), [id(1), id(2), id(3)]);
  assert.deepEqual(result.messages.map(m => m.displayRole), ["owner", "dot", "owner"]);
  assert.deepEqual(result.messages.map(m => m.text), ["same text", "same text", "same text"]);
  assert.equal(result.completeHistory, false);
  assert.equal(result.authoritativeAuthors, false);
  assert.equal(result.kind, "partial-room-observation");
});

test("only the exact configured dot page qualifies", () => {
  for (const url of [binding.pageUrl + "?prompt=x", binding.pageUrl + "#other", binding.pageUrl + "/",
    binding.pageUrl.replace("chatgpt.com", "chatgpt.com.evil.example"), "https://chatgpt.com/"]) {
    assert.throws(() => qualify(initial(), url), /room binding/);
  }
  assert.throws(() => qualifyDotRoomRows(binding.pageUrl, initial(), { ...binding, dotAnchorId: id(1) }), /room binding/);
});

test("observed grouping classes do not change the display author", () => {
  const result = qualify(initial().map(r => ({ ...r, classes: [...r.classes, "grouped-previous", "grouped-next"] })));
  assert.deepEqual(result.messages.map(m => m.displayRole), ["owner", "dot"]);
});

test("room identities and nested body identities must agree", () => {
  for (const bad of [
    { ...row(3, true), messageId: id(3, "b".repeat(32)) },
    { ...row(3, true), messageId: "Sentinel_" + "3".repeat(32) },
    { ...row(3, true), bodyIds: [id(4)] },
    { ...row(3, true), bodyIds: [id(3), id(3)] },
    { ...row(3, true), bodyIds: [] },
    { ...row(3, true), tagName: "DIV" },
    { ...row(3, true), classes: ["message-row", "new-unknown-author"] },
  ]) assert.throws(() => qualify([...initial(), bad]), /room row/);
});

test("both independently verified role anchors are required in every window", () => {
  for (const rows of [[row(1, true)], [row(2, false)], [row(1, false), row(2, false)],
    [row(1, true), row(2, true)], [row(1, true, " "), row(2, false)]]) assert.throws(() => qualify(rows));
  assert.throws(() => qualify([]), /room window/);
});

test("repeated IDs reject the whole observation, including equal text", () => {
  assert.throws(() => qualify([...initial(), row(2, false)]), /room row/);
  assert.throws(() => qualify([...initial(), row(2, false, "changed")]), /room row/);
});

test("unknown content is explicit and never flattened into a complete message", () => {
  const result = qualify([...initial(), { ...row(3, false), unsupportedContent: true },
    { ...row(4, true), textBlocks: [] }]);
  assert.deepEqual(result.unsupportedMessageIds, [id(3), id(4)]);
  assert.deepEqual(result.messages.map(m => m.messageId), [id(1), id(2)]);
  assert.throws(() => qualify([{ ...row(1, true), unsupportedContent: true }, row(2, false)]), /anchor/);
  assert.throws(() => qualify([...initial(), { ...row(3, true), textBlocks: ["a", "b"] }]), /room row/);
});

test("row and text limits fail closed without returning partial accepted output", () => {
  assert.throws(() => qualify([...initial(), row(3, true, "a".repeat(100_001))]), /room text/);
  assert.throws(() => qualify([...initial(), row(3, true, "a\0b")]), /room text/);
  assert.throws(() => qualify([...initial(), ...Array.from({ length: 499 }, (_, i) => row(i + 3, true))]), /room window/);
  assert.throws(() => qualify([...initial(), ...Array.from({ length: 21 }, (_, i) => row(i + 3, true, "a".repeat(100_000)))]), /text limit/);
});

/** Minimal synthetic DOM boundary, not a browser integration test. */
function documentFixture(unsupported = false): Document {
  const classes = (values: readonly string[]) => ({ contains: (name: string) => values.includes(name), [Symbol.iterator]: () => values[Symbol.iterator]() });
  const articles = initial().map(r => {
    const text = { tagName: "P", hasAttribute: () => false };
    const block = { classList: classes(["message-text"]), innerText: "same text" };
    const bubble = { classList: classes(["message-bubble"]), children: [block] };
    const surface = { classList: classes(["message-surface"]), children: [bubble] };
    const body = { children: [surface], getAttribute: () => r.messageId };
    return { tagName: "ARTICLE", classList: classes(r.classes), getAttribute: () => r.messageId,
      querySelectorAll(selector: string) {
        if (selector === ".message-body") return [body];
        if (selector === ".message-body .message-text") return [block];
        if (selector === ".message-surface") return [surface];
        if (selector === ".message-bubble") return [bubble];
        if (selector === ".message-surface *") return [text, ...(unsupported ? [{ tagName: "IFRAME" }] : [])];
        throw new Error(`Unexpected DOM read: ${selector}`);
      } };
  });
  return { querySelectorAll(selector: string) {
    assert.equal(selector, "article[data-message-id]"); return articles;
  } } as unknown as Document;
}

test("collector scopes identity to articles and text to the message text block", () => {
  const result = readDotRoomDocument(documentFixture(), binding.pageUrl, binding);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map(m => m.displayRole), ["owner", "dot"]);
  assert.throws(() => readDotRoomDocument(documentFixture(true), binding.pageUrl, binding), /anchor/);
});
