import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeStore } from "../src/bridge/store.js";
import { AccessGate, DeliveryWorker } from "../src/bridge/delivery.js";
import type { BridgeChat, View, MessageHandle } from "../src/bridge/contracts.js";
import { DotRoomInputJournal } from "../src/dot-browser/input-journal.js";
import { DotRoomOutbox, DotRoomDeliveryAccess } from "../src/dot-browser/room-outbox.js";
import type { DotRoomObservation, DotRoomTextObservation } from "../src/dot-browser/room-observation.js";

const room = "a".repeat(32), peerId = 2_000_000_032;
const id = (n: number) => `${room}~${room}~CalpicoMessage~Sentinel_${n.toString(16).padStart(32, "0")}`;
const message = (n: number, displayRole: "owner" | "dot", text = "same text"): DotRoomTextObservation =>
  ({ messageId: id(n), text, displayRole, evidence: "rendered-room" });
const old = [message(1, "owner"), message(2, "dot")];
const observation = (messages: readonly DotRoomTextObservation[], unsupported: number[] = []): DotRoomObservation => ({
  kind: "partial-room-observation", completeHistory: false, authoritativeAuthors: false,
  orderedMessageIds: [...messages.map(m => m.messageId), ...unsupported.map(id)], messages, unsupportedMessageIds: unsupported.map(id),
});
function fixture(t: { after(fn: () => void): void }, chunkSize = 3_500) {
  const store = new BridgeStore(path.join(mkdtempSync(path.join(tmpdir(), "vkodex-room-outbox-test-")), "fixture.sqlite"));
  t.after(() => store.close());
  const ingress = new DotRoomInputJournal(store, { peerId, ownerId: 42, roomId: room, generation: 1 });
  const outbox = new DotRoomOutbox(store, ingress, chunkSize);
  const access = new DotRoomDeliveryAccess(new AccessGate({ ownerId: 42, groupId: 88 }, store), [outbox]);
  const sends: { peerId: number; view: View; randomId: number }[] = [], edits: { handle: MessageHandle; view: View }[] = [];
  const chat: BridgeChat = {
    async createConversation() { throw new Error("unexpected create"); }, async renameConversation() { throw new Error("unexpected rename"); },
    async inviteLink() { throw new Error("unexpected invite"); }, async uploadDocument() { throw new Error("unexpected upload"); },
    async delete() { throw new Error("unexpected delete"); },
    async send(peerId, view, randomId) { sends.push({ peerId, view, randomId }); return { peerId, conversationMessageId: sends.length }; },
    async edit(handle, view) { edits.push({ handle, view }); },
  };
  const worker = new DeliveryWorker(chat, store, access, 0);
  outbox.baseline(observation(old)); outbox.setEnabled(true);
  return { store, ingress, outbox, access, sends, edits, worker, chat };
}

test("owner and dot rows use the common outbox and edits keep the existing handle", async t => {
  const h = fixture(t), snapshot = observation([...old, message(3, "owner", "question"), message(4, "dot", "answer")]);
  assert.equal(h.store.pendingDeliveries().length, 0); assert.equal(h.outbox.project(snapshot), "projected");
  await h.worker.flush(); assert.deepEqual(h.sends.map(s => s.view.text), ["Вы (из приложения):\nquestion", "answer"]);
  h.outbox.project(snapshot); await h.worker.flush(); assert.equal(h.sends.length, 2);
  h.outbox.project(observation([...old, message(3, "owner", "question"), message(4, "dot", "updated")]));
  await h.worker.flush(); assert.equal(h.sends.length, 2); assert.equal(h.edits.at(-1)?.view.text, "updated");
});
test("distinct equal-text messages are delivered separately", async t => {
  const h = fixture(t); h.outbox.project(observation([...old, message(3, "dot"), message(4, "dot")])); await h.worker.flush();
  assert.equal(h.sends.length, 2); assert.notEqual(h.sends[0]!.randomId, h.sends[1]!.randomId);
});
test("pending submission blocks projection until the exact VK-origin echo can be suppressed", async t => {
  const h = fixture(t), input = { peerId, senderId: 42, eventId: "message:4", text: "question" };
  h.ingress.receive(input); const attempt = h.ingress.dispatch(input, "epoch")!;
  const snapshot = observation([...old, message(3, "owner", "question"), message(4, "dot", "answer")]);
  assert.equal(h.outbox.project(snapshot), "submission-blocked"); assert.equal(h.store.pendingDeliveries().length, 0);
  h.ingress.settle(attempt, { phase: "observed", messageId: id(3), evidence: "same-node-dom-transition" });
  h.outbox.project(snapshot); await h.worker.flush(); assert.deepEqual(h.sends.map(s => s.view.text), ["answer"]);
});
test("uncertain submission remains a projection barrier after a later successful input", t => {
  const h = fixture(t), first = { peerId, senderId: 42, eventId: "message:4", text: "first" }, second = { ...first, eventId: "message:5" };
  h.ingress.receive(first); h.ingress.settle(h.ingress.dispatch(first, "epoch")!, { phase: "uncertain" });
  h.ingress.receive(second); h.ingress.settle(h.ingress.dispatch(second, "epoch")!, { phase: "observed", messageId: id(4), evidence: "same-node-dom-transition" });
  assert.equal(h.outbox.project(observation([...old, message(3, "owner"), message(4, "owner")])), "submission-blocked");
});
test("missing anchors and unknown old insertions roll back without rebaselining", t => {
  const h = fixture(t);
  assert.throws(() => h.outbox.project(observation([message(3, "dot")])), /history gap/u);
  assert.throws(() => h.outbox.project(observation([old[0]!, message(3, "owner"), old[1]!, message(4, "dot")])), /Unknown insertion/u);
  assert.equal(h.store.pendingDeliveries().length, 0);
  assert.throws(() => h.outbox.baseline(observation(old)), /already fixed/u);
  assert.equal(h.outbox.project(observation([...old, message(3, "dot")])), "projected");
});
test("disabled and unregistered room routes never fall through to ordinary access", async t => {
  const h = fixture(t); h.outbox.project(observation([...old, message(3, "dot")])); h.outbox.setEnabled(false);
  await h.worker.flush(); assert.equal(h.sends.length, 0);
  const withoutRoute = new DeliveryWorker(h.chat, h.store, new DotRoomDeliveryAccess({ check: async () => true }, []));
  await withoutRoute.flush(); assert.equal(h.sends.length, 0);
  h.outbox.setEnabled(true); await h.worker.flush(); assert.equal(h.sends.length, 1);
});
test("unrelated messages cannot use a room recipient but ordinary Codex/owner delivery is unchanged", async t => {
  const h = fixture(t); h.store.enqueue("ordinary-owner", 42, { text: "normal" }); h.store.enqueue("foreign-room", peerId, { text: "foreign" });
  h.store.enqueue("dot-room-outbox:unknown:message:1", peerId, { text: "unknown route" });
  await h.worker.flush(); assert.deepEqual(h.sends.map(s => s.view.text), ["normal"]);
});
test("recipient revocation during async access checking prevents the send", async t => {
  const h = fixture(t); h.outbox.project(observation([...old, message(3, "dot")]));
  const original = h.access.check.bind(h.access);
  h.access.check = async peer => { const allowed = await original(peer); h.outbox.setEnabled(false); return allowed; };
  await h.worker.flush(); assert.equal(h.sends.length, 0);
});
test("chunk shrink uses existing withdrawal behavior without creating duplicate messages", async t => {
  const h = fixture(t, 128); h.outbox.project(observation([...old, message(3, "dot", "x".repeat(300))])); await h.worker.flush();
  assert.equal(h.sends.length, 3);
  h.outbox.project(observation([...old, message(3, "dot", "short")])); await h.worker.flush();
  assert.equal(h.sends.length, 3); assert.equal(h.edits.filter(e => e.view.text.includes("фрагмент")).length, 2);
});
test("unsupported rows retain order and can later become supported text with the same delivery", async t => {
  const h = fixture(t); h.outbox.project(observation(old, [3])); await h.worker.flush();
  assert.equal(h.sends.length, 1); assert.match(h.sends[0]!.view.text, /неподдерживаемое/u);
  h.outbox.project(observation([...old, message(3, "dot", "now supported")])); await h.worker.flush();
  assert.equal(h.sends.length, 1); assert.equal(h.edits.at(-1)?.view.text, "now supported");
});
test("cross-room IDs, duplicate IDs and author changes fail without mutating queued content", t => {
  const h = fixture(t); const valid = observation([...old, message(3, "dot", "original")]); h.outbox.project(valid);
  const before = h.store.pendingDeliveries();
  assert.throws(() => h.outbox.project(observation([...old, message(3, "owner")])), /author changed/u);
  assert.throws(() => h.outbox.project({ ...valid, orderedMessageIds: [...valid.orderedMessageIds, id(3)] }), /identities/u);
  assert.throws(() => h.outbox.project({ ...valid, orderedMessageIds: valid.orderedMessageIds.map(s => s.replaceAll(room, "b".repeat(32))) }), /identities/u);
  assert.deepEqual(h.store.pendingDeliveries(), before);
});
test("a projection cannot reserve another store or duplicate recipient route", t => {
  const h = fixture(t), other = new BridgeStore(); t.after(() => other.close());
  assert.throws(() => new DotRoomOutbox(other, h.ingress), /same bridge store/u);
  assert.throws(() => new DotRoomDeliveryAccess(h.access, [h.outbox, h.outbox]), /Duplicate room recipient/u);
});
test("a later Codex binding revokes room delivery without falling through", async t => {
  const h = fixture(t); h.outbox.project(observation([...old, message(3, "dot")]));
  const binding = h.store.ensureBinding({ hostId: "local", threadId: "other", title: "other", workspace: "/fixture", updatedAt: 0 });
  h.store.setChat(binding.id, peerId, 32);
  await h.worker.flush(); assert.equal(h.sends.length, 0); assert.equal(h.outbox.active(), false);
});
test("restart uncertainty keeps source mirroring blocked until explicit reconciliation exists", t => {
  const h = fixture(t), input = { peerId, senderId: 42, eventId: "message:6", text: "question" };
  h.ingress.receive(input); h.ingress.dispatch(input, "epoch"); h.store.recover(); h.ingress.recoverInterrupted();
  assert.equal(h.outbox.project(observation([...old, message(3, "owner")])), "submission-blocked");
  assert.equal(h.store.pendingDeliveries().length, 0);
});
