import assert from "node:assert/strict";
import test from "node:test";
import { InputBatcher } from "../src/bridge/input-batcher.js";
import type { BridgeInput } from "../src/bridge/contracts.js";
import { BridgeStore } from "../src/bridge/store.js";

const part = (id: number, text: string, senderId = 7): BridgeInput => ({ eventId: `message:${id}`, text, senderId, peerId: 2000000001 });

test("long VK burst becomes one request; duplicate parts and short trailing parts are handled", async () => {
  const sent: BridgeInput[] = [];
  const batch = new InputBatcher(async input => { sent.push(input); }, () => true, 10, 4);
  await Promise.all([batch.handle(part(1, "long")), batch.handle(part(1, "long")), batch.handle(part(2, "text")), batch.handle(part(3, "!"))]);
  assert.equal(sent.length, 1); assert.equal(sent[0]?.text, "long\ntext\n!");
  assert.deepEqual(sent[0]?.mergedEventIds, ["message:1", "message:2", "message:3"]);
});

test("commands, attachments, authors and conversations separate bursts", async () => {
  for (const boundary of [part(2, "/stop"), part(2, "x", 8), { ...part(2, "x"), hasAttachments: true }]) {
    const sent: BridgeInput[] = [];
    const batch = new InputBatcher(async input => { sent.push(input); }, () => true, 50, 4);
    await Promise.all([batch.handle(part(1, "long")), batch.handle(boundary)]);
    assert.deepEqual(sent.map(p => p.eventId), ["message:1", "message:2"]);
  }
  const sent: BridgeInput[] = [];
  const batch = new InputBatcher(async input => { sent.push(input); }, () => true, 50, 4);
  const first = batch.handle(part(1, "long"));
  await batch.handle({ ...part(2, "x"), peerId: 2000000002 });
  await batch.idle(); await first;
  assert.equal(sent.length, 2); assert.ok(sent.every(input => !input.mergedEventIds));
});

test("ordinary short text is immediate and shutdown flushes a single long part unchanged", async () => {
  const sent: BridgeInput[] = [];
  const batch = new InputBatcher(async input => { sent.push(input); }, () => true, 500, 4);
  await batch.handle(part(1, "hi")); assert.equal(sent.length, 1);
  const pending = batch.handle(part(2, "long"));
  await batch.idle(); await pending;
  assert.equal(sent[1]?.eventId, "message:2");
});

test("a crashed burst restores every saved part as one Codex request", async () => {
  const store = new BridgeStore();
  const original = new InputBatcher(async () => { assert.fail("crashed process must not send"); }, () => true, 1000, 4, store);
  void original.handle(part(10, "long"));
  void original.handle(part(11, "tail"));
  assert.deepEqual(store.inputBatches()[0]?.parts.map(item => item.eventId), ["message:10", "message:11"]);
  original.abandon(); store.recover();
  const sent: BridgeInput[] = [];
  const restored = new InputBatcher(async input => { sent.push(input); }, () => true, 1000, 4, store);
  restored.restore();
  // Replayed VK Long Poll event cannot append the same fragment twice.
  const duplicate = restored.handle(part(10, "long"));
  await restored.idle(); await duplicate;
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, "long\ntail");
  assert.deepEqual(store.inputBatches(), []);
  store.close();
});

test("recovery never resends a batch that might already have reached Codex", async () => {
  const store = new BridgeStore();
  const batch = new InputBatcher(async () => {}, () => true, 1000, 4, store);
  void batch.handle(part(20, "long"));
  const saved = store.inputBatches()[0]!;
  store.saveInputBatch({ ...saved, state: "dispatching" });
  const key = JSON.stringify([saved.peerId, "message:20"]);
  assert.equal(store.claimInput(key), true);
  store.markInputPreparing([key]); store.markInputSending([key]);
  batch.abandon(); store.recover();
  const sent: BridgeInput[] = [];
  const restored = new InputBatcher(async input => { sent.push(input); }, () => true, 1000, 4, store);
  restored.restore(); await restored.idle();
  assert.deepEqual(sent, []);
  assert.deepEqual(store.inputBatches(), []);
  store.close();
});

test("a batch still preparing before Codex dispatch is replayable after recovery", async () => {
  const store = new BridgeStore();
  const original = new InputBatcher(async () => {}, () => true, 1000, 4, store);
  void original.handle(part(30, "long"));
  const saved = store.inputBatches()[0]!;
  store.saveInputBatch({ ...saved, state: "dispatching" });
  const key = JSON.stringify([saved.peerId, "message:30"]);
  assert.equal(store.claimInput(key), true);
  store.markInputPreparing([key]);
  original.abandon(); store.recover();
  const sent: BridgeInput[] = [];
  const restored = new InputBatcher(async input => { sent.push(input); }, () => true, 1000, 4, store);
  restored.restore(); await restored.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, "long");
  assert.deepEqual(store.inputBatches(), []);
  store.close();
});

test("completion of an earlier batch cannot delete a newer batch for the same conversation", async () => {
  const store = new BridgeStore();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const batch = new InputBatcher(async () => { await waiting; }, () => true, 1000, 4, store);
  void batch.handle(part(40, "long"));
  const first = store.inputBatches()[0]!.id;
  const sending = batch.flush(part(40, "long").peerId);
  void batch.handle(part(41, "next long"));
  const second = store.inputBatches()[0]!.id;
  assert.notEqual(first, second);
  release(); await sending;
  assert.equal(store.inputBatches()[0]?.id, second);
  batch.abandon(); store.close();
});
