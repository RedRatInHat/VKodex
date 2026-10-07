import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { BridgeStore } from "../src/bridge/store.js";
import { DotRoomInputJournal } from "../src/dot-browser/input-journal.js";
import type { Database } from "better-sqlite3";
import type { BridgeInput } from "../src/bridge/contracts.js";

const scope = { peerId: 2_000_000_032, ownerId: 42, roomId: "a".repeat(32), generation: 1 };
const input: BridgeInput = { peerId: scope.peerId, senderId: scope.ownerId, eventId: "message:4", text: "hello" };
const key = JSON.stringify([input.peerId, input.eventId]);
const messageId = `${scope.roomId}~${scope.roomId}~CalpicoMessage~Sentinel_${"b".repeat(32)}`;
const observed = { phase: "observed" as const, messageId, evidence: "same-node-dom-transition" as const };
function fixture(t: { after(fn: () => void): void }) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "vkodex-room-journal-test-")), "fixture.sqlite");
  const store = new BridgeStore(file); t.after(() => store.close());
  return { store, journal: new DotRoomInputJournal(store, scope) };
}

test("room input reuses common inbox, fences before dispatch and commits exact echo identity", t => {
  const { store, journal } = fixture(t);
  assert.equal(journal.receive(input, 0), true); assert.equal(store.inputState(key), "received");
  assert.deepEqual(store.reserveReplayableInputs(10_000), [input]);
  const attempt = journal.dispatch(input, "observer-1")!;
  assert.equal(store.inputState(key), "sending"); assert.equal(journal.dispatch(input, "observer-1"), null);
  assert.equal(journal.isOwnVisibleMessage(messageId), false);
  assert.equal(journal.settle(attempt, observed), "observed");
  assert.equal(store.inputState(key), "done"); assert.equal(journal.isOwnVisibleMessage(messageId), true);
  assert.equal(journal.settle(attempt, observed), "observed");
  assert.equal(journal.receive(input), false); assert.equal(journal.dispatch(input, "new-observer"), null);
});
test("same input identity with different text cannot overwrite the original queue payload", t => {
  const { store, journal } = fixture(t); journal.receive(input, 0);
  assert.throws(() => journal.receive({ ...input, text: "changed" }), /conflicting contents/u);
  assert.throws(() => journal.dispatch({ ...input, text: "changed" }, "epoch"), /not journaled/u);
  assert.deepEqual(store.reserveReplayableInputs(10_000), [input]);
});
test("different event identities with identical text remain separate, serialized inputs", t => {
  const { journal } = fixture(t); const second = { ...input, eventId: "message:5" };
  journal.receive(input); journal.receive(second);
  const firstAttempt = journal.dispatch(input, "epoch")!;
  assert.equal(journal.dispatch(second, "epoch"), null);
  journal.settle(firstAttempt, observed);
  const secondAttempt = journal.dispatch(second, "epoch")!;
  assert.notEqual(firstAttempt.operationId, secondAttempt.operationId);
  assert.throws(() => journal.settle(secondAttempt, observed), /already belongs/u);
  journal.settle(secondAttempt, { phase: "uncertain" });
});
test("normal shared recovery prevents replay and ignores late DOM success", t => {
  const { store, journal } = fixture(t); journal.receive(input);
  const attempt = journal.dispatch(input, "old-epoch")!;
  assert.equal(journal.recoverInterrupted(), false);
  store.recover(); assert.equal(store.inputState(key), "uncertain");
  const restarted = new DotRoomInputJournal(store, scope);
  assert.equal(restarted.recoverInterrupted(), true); assert.equal(restarted.recoverInterrupted(), false);
  assert.equal(restarted.dispatch(input, "new-epoch"), null);
  assert.equal(restarted.settle(attempt, observed), "uncertain");
  assert.equal(restarted.isOwnVisibleMessage(messageId), false);
});
test("late observation cannot clear shared uncertainty even before explicit room recovery", t => {
  const { store, journal } = fixture(t); journal.receive(input); const attempt = journal.dispatch(input, "epoch")!;
  store.recover(); assert.equal(journal.settle(attempt, observed), "uncertain");
  assert.equal(store.inputState(key), "uncertain"); assert.equal(journal.isOwnVisibleMessage(messageId), false);
});
test("a received but undispatched input remains available after shared recovery", t => {
  const { store, journal } = fixture(t); journal.receive(input, 0); store.recover();
  assert.equal(journal.recoverInterrupted(), false); assert.equal(store.inputState(key), "received");
  assert.ok(journal.dispatch(input, "epoch"));
});
test("receipt room, observer and operation must match exactly", t => {
  const { store, journal } = fixture(t); journal.receive(input); const attempt = journal.dispatch(input, "epoch")!;
  for (const patch of [{ observerEpoch: "other" }, { operationId: "other" }, { roomId: "c".repeat(32) }])
    assert.throws(() => journal.settle({ ...attempt, ...patch }, observed), /does not match/u);
  assert.throws(() => journal.settle(attempt, { ...observed, messageId: messageId.replaceAll(scope.roomId, "c".repeat(32)) }), /Invalid visible/u);
  assert.equal(store.inputState(key), "sending"); assert.equal(journal.isOwnVisibleMessage(messageId), false);
});
test("unbound, edited, reply, merged and attachment inputs are rejected before persistence", t => {
  const { store, journal } = fixture(t);
  for (const patch of [{ senderId: 43 }, { peerId: scope.peerId + 1 }, { action: "stop" }, { hasAttachments: true },
    { editOfMessageId: 4 }, { replyToMessageId: 3 }, { mergedEventIds: ["message:3"] }, { text: "" }])
    assert.throws(() => journal.receive({ ...input, ...patch }), /Unsupported/u);
  assert.equal(store.inputState(key), null);
});
test("another generation or room cannot silently acquire the same peer", t => {
  const { store, journal } = fixture(t); journal.receive(input);
  for (const patch of [{ generation: 2 }, { roomId: "c".repeat(32) }, { ownerId: 43 }]) {
    const other = new DotRoomInputJournal(store, { ...scope, ...patch });
    assert.throws(() => other.receive({ ...input, senderId: patch.ownerId ?? scope.ownerId, eventId: "message:5" }), /different journal scope/u);
  }
});
test("scope property order does not change journal identity", t => {
  const { store, journal } = fixture(t); journal.receive(input);
  const reordered = new DotRoomInputJournal(store, { generation: 1, roomId: scope.roomId, ownerId: 42, peerId: scope.peerId });
  assert.equal(reordered.receive(input), false); assert.ok(reordered.dispatch(input, "epoch"));
});
test("preexisting common inbox event without a room record is not adopted", t => {
  const { store, journal } = fixture(t); store.receiveInput(input);
  assert.throws(() => journal.receive(input), /another journal scope/u);
  assert.throws(() => journal.dispatch(input, "epoch"), /not journaled/u);
  assert.equal(store.inputState(key), "received");
});
test("a Codex chat binding blocks room ingress without touching the inbox", t => {
  const { store, journal } = fixture(t);
  const binding = store.ensureBinding({ hostId: "local", threadId: "codex-thread", title: "existing", workspace: "/fixture", updatedAt: 0 });
  store.setChat(binding.id, scope.peerId, 32);
  assert.throws(() => journal.receive(input), /Codex binding/u);
  assert.equal(store.inputState(key), null);
});
test("a failure inside dispatch rolls back shared state and its operation fence together", t => {
  const { store, journal } = fixture(t); journal.receive(input);
  const original = store.setValue.bind(store);
  store.setValue = (name, value) => { if (name.endsWith(":active")) throw new Error("fixture commit failure"); original(name, value); };
  assert.throws(() => journal.dispatch(input, "epoch"), /fixture commit failure/u);
  store.setValue = original;
  assert.equal(store.inputState(key), "received"); assert.ok(journal.dispatch(input, "epoch"));
});
test("uncertain settlement permits the next distinct input but never the uncertain one", t => {
  const { journal } = fixture(t); const next = { ...input, eventId: "message:5" };
  journal.receive(input); journal.receive(next); const attempt = journal.dispatch(input, "epoch")!;
  assert.equal(journal.settle(attempt, { phase: "uncertain" }), "uncertain");
  assert.equal(journal.dispatch(input, "later"), null); assert.ok(journal.dispatch(next, "later"));
  assert.equal(journal.isOwnVisibleMessage(messageId), false);
});

test("dispatch establishes FULL SQLite synchronization before committing the fence", t => {
  const { store, journal } = fixture(t); const db = (store as unknown as { db: Database }).db;
  db.pragma("synchronous = NORMAL"); journal.receive(input);
  assert.equal(db.pragma("synchronous", { simple: true }), 1);
  assert.ok(journal.dispatch(input, "epoch"));
  assert.equal(db.pragma("synchronous", { simple: true }), 2);
});
test("durability preflight preserves EXTRA and refuses an enclosing transaction", t => {
  const { store, journal } = fixture(t); const db = (store as unknown as { db: Database }).db;
  db.pragma("synchronous = EXTRA"); store.requireDurableWrites();
  assert.equal(db.pragma("synchronous", { simple: true }), 3);
  journal.receive(input);
  assert.throws(() => store.atomic(() => journal.dispatch(input, "epoch")), /before the dispatch transaction/u);
  assert.equal(store.inputState(key), "received");
});

test("file-backed reopen retains the fence and recovers without replay", t => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "vkodex-room-journal-fixture-")), "fixture.sqlite");
  const first = new BridgeStore(file), before = new DotRoomInputJournal(first, scope);
  before.receive(input); const attempt = before.dispatch(input, "old-epoch")!;
  const db = (first as unknown as { db: Database }).db;
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("synchronous", { simple: true }), 2);
  first.close();
  const second = new BridgeStore(file); t.after(() => second.close()); second.recover();
  const after = new DotRoomInputJournal(second, scope);
  assert.equal(after.recoverInterrupted(), true);
  assert.equal(after.dispatch(input, "new-epoch"), null);
  assert.equal(after.settle(attempt, observed), "uncertain");
  assert.equal(second.inputState(key), "uncertain");
});

test("an in-memory store cannot authorize external room dispatch", t => {
  const store = new BridgeStore(); t.after(() => store.close());
  assert.throws(() => new DotRoomInputJournal(store, scope), /file-backed bridge journal/u);
});
