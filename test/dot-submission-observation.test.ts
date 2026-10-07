import test from "node:test";
import assert from "node:assert/strict";
import { DotSubmissionObservation, type SubmissionObservationEvent } from "../src/dot-browser/submission-observation.js";

const roomId = "a".repeat(32), epoch = "observer-1";
const pendingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const messageId = `${roomId}~${roomId}~CalpicoMessage~Sentinel_${"b".repeat(32)}`;
const binding = { roomId, observerEpoch: epoch, operationId: "vk-input-1", baselineMessageIds: [] };
const pending: SubmissionObservationEvent = { type: "pending", observerEpoch: epoch, nodeId: "physical-article-1", pendingId, ownerLayout: true, exactText: true };
const confirmed: SubmissionObservationEvent = { type: "canonical", observerEpoch: epoch, nodeId: "physical-article-1", previousId: pendingId, messageId, ownerLayout: true, exactText: true };
const tracker = () => new DotSubmissionObservation(binding, "new-fenced-attempt");

test("a complete same-node transition produces only DOM observation evidence", () => {
  const t = tracker();
  assert.equal(t.observe(pending).phase, "awaiting-canonical");
  assert.equal(t.observe(pending).phase, "awaiting-canonical");
  assert.deepEqual(t.observe(confirmed), { phase: "observed", messageId, evidence: "same-node-dom-transition" });
});
test("matching final text without a pending transition is not acceptance", () => {
  assert.equal(tracker().observe(confirmed).phase, "uncertain");
});
test("a remounted article cannot be correlated by text or message position", () => {
  const t = tracker(); t.observe(pending);
  assert.equal(t.observe({ ...confirmed, nodeId: "physical-article-2" }).phase, "uncertain");
});
test("different pending identities or simultaneous pending articles are ambiguous", () => {
  for (const patch of [{ nodeId: "other" }, { pendingId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }]) {
    const t = tracker(); t.observe(pending);
    assert.equal(t.observe({ ...pending, ...patch }).phase, "uncertain");
  }
});
test("wrong room, old canonical ID, wrong old ID and non-owner layout fail closed", () => {
  for (const patch of [{ messageId: messageId.replaceAll(roomId, "c".repeat(32)) },
    { previousId: "other" }, { ownerLayout: false }, { exactText: false }, { messageId: "not-canonical" }]) {
    const t = tracker(); t.observe(pending);
    assert.equal(t.observe({ ...confirmed, ...patch }).phase, "uncertain");
  }
  const t = new DotSubmissionObservation({ ...binding, baselineMessageIds: [messageId] }, "new-fenced-attempt");
  t.observe(pending); assert.equal(t.observe(confirmed).phase, "uncertain");
});
test("unqualified pending identity or text cannot arm a confirmation", () => {
  for (const patch of [{ pendingId: messageId }, { nodeId: "" }, { ownerLayout: false }, { exactText: false }])
    assert.equal(tracker().observe({ ...pending, ...patch }).phase, "uncertain");
});
test("navigation, disconnect, interference and observer gaps permanently retain uncertainty", () => {
  for (const type of ["navigation", "disconnect", "interference", "gap", "timeout"] as const) {
    const t = tracker(); t.observe(pending);
    assert.equal(t.observe({ type, observerEpoch: epoch }).phase, "uncertain");
    assert.equal(t.observe(confirmed).phase, "uncertain");
  }
});
test("an observer epoch cannot be reused after reconnection", () => {
  const t = tracker(); t.observe(pending);
  assert.equal(t.observe({ ...confirmed, observerEpoch: "observer-2" }).phase, "uncertain");
});
test("recovered uncertainty never becomes acceptance from a late DOM match", () => {
  const t = new DotSubmissionObservation(binding, "uncertain-after-restart");
  assert.equal(t.observe(pending).phase, "uncertain");
  assert.equal(t.observe(confirmed).phase, "uncertain");
});
test("state copies and caller-owned baseline changes cannot mutate the tracker", () => {
  const baseline: string[] = [];
  const t = new DotSubmissionObservation({ ...binding, baselineMessageIds: baseline }, "new-fenced-attempt");
  baseline.push(messageId);
  t.observe(pending);
  const snapshot = t.state as { phase: string; nodeId?: string };
  snapshot.nodeId = "forged";
  assert.equal(t.observe(confirmed).phase, "observed");
});
test("observed state stays evidence of this attempt, never a command to retry", () => {
  const t = tracker(); t.observe(pending); t.observe(confirmed);
  assert.equal(t.observe({ type: "disconnect", observerEpoch: epoch }).phase, "observed");
  assert.equal(t.operationId, "vk-input-1");
});
