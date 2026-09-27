import test from "node:test";
import assert from "node:assert/strict";
import { classifyNativeQueueState, type NativeQueueState, type QueueEntryIdentity } from "../src/codex/native-queue-state.js";

const row = (id: string, hex = id.charCodeAt(0).toString(16)): QueueEntryIdentity => ({ id, fingerprint: hex.padStart(64, "0") });
const A = row("A");
const B = row("B");
const C = row("C");
const changed = (value: QueueEntryIdentity): QueueEntryIdentity => ({ ...value, fingerprint: "f".repeat(64) });
const run = (currentPending: unknown, consumed: unknown, incoming: unknown) => classifyNativeQueueState({ currentPending, consumed, incoming } as NativeQueueState);

test("empty, exact pending replay and one new append", () => {
  assert.deepEqual(run([], [], []), { kind: "replay", canonicalPendingIds: [], strippedConsumedIds: [] });
  assert.deepEqual(run([A], [], [{ ...A }]), { kind: "replay", canonicalPendingIds: ["A"], strippedConsumedIds: [] });
  assert.deepEqual(run([A], [], [A, B]), { kind: "append", canonicalPendingIds: ["A", "B"], strippedConsumedIds: [], newId: "B" });
});

test("leading consumed tombstone may precede replay or one new append", () => {
  assert.deepEqual(run([], [A], [A]), { kind: "replay", canonicalPendingIds: [], strippedConsumedIds: ["A"] });
  assert.deepEqual(run([], [A], [A, B]), { kind: "append", canonicalPendingIds: ["B"], strippedConsumedIds: ["A"], newId: "B" });
  assert.deepEqual(run([B], [A], [A, B]), { kind: "replay", canonicalPendingIds: ["B"], strippedConsumedIds: ["A"] });
});

test("pending omission, stale consumed-only state, and reorder reject", () => {
  assert.throws(() => run([A], [], []), /pending omission/);
  assert.throws(() => run([B], [A], [A]), /pending omission/);
  assert.throws(() => run([A, B], [], [B, A]), /pending omission or reorder/);
  assert.throws(() => run([B], [A], [B, A]), /reused or out-of-order/);
  assert.throws(() => run([], [A, B], [B, A]), /consumed tombstone reorder/);
  assert.deepEqual(run([], [A, B], [B]), { kind: "replay", canonicalPendingIds: [], strippedConsumedIds: ["B"] });
});

test("same ID with changed body or status fingerprint rejects, pending and consumed", () => {
  assert.throws(() => run([A], [], [changed(A)]), /changed-body/);
  assert.throws(() => run([], [A], [changed(A)]), /changed-body/);
  assert.throws(() => run([A], [], [A, changed(A)]), /duplicate incoming ID/);
});

test("at most one new entry and durable ID uniqueness", () => {
  assert.throws(() => run([], [], [A, B]), /multiple new/);
  assert.throws(() => run([A], [], [A, B, C]), /multiple new/);
  assert.throws(() => run([A], [A], [A]), /duplicate durable/);
});

test("identity shape must already contain exact canonical fingerprint", () => {
  assert.throws(() => run([], [], [{ id: "A", fingerprint: "not-a-hash" }]), /invalid incoming identity/);
  assert.throws(() => run([], [], [{ ...A, arbitrary: true }]), /invalid incoming identity/);
  assert.throws(() => run([], [], [{ id: "A", fingerprint: undefined }]), /invalid incoming identity/);
});
