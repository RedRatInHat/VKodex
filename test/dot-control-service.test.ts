import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeStore } from "../src/bridge/store.js";
import { DotRoomInputJournal } from "../src/dot-browser/input-journal.js";
import { DotBrowserConnectionGate } from "../src/dot-browser/connection-gate.js";
import { DotRoomControlService, type DotControlTransport } from "../src/dot-browser/control-service.js";
import type { DotControlRequest } from "../src/dot-browser/control-protocol.js";
import { withDiagnosticSink, type DiagnosticRecord } from "../src/bridge/diagnostics.js";

const scope = { peerId: 2_000_000_032, ownerId: 42, roomId: "a".repeat(32), generation: 1 };
const pageUrl = "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const input = { peerId: scope.peerId, senderId: scope.ownerId, eventId: "message:4", text: "PRIVATE_TEST_TEXT" };
const key = JSON.stringify([input.peerId, input.eventId]);
const messageId = `${scope.roomId}~${scope.roomId}~CalpicoMessage~Sentinel_${"b".repeat(32)}`;
function receipt(request: DotControlRequest, phase = "observed") {
  assert.equal(request.method, "observe-and-submit");
  if (request.method !== "observe-and-submit") throw new Error("Unexpected command");
  return { version: 1, requestId: request.requestId, scope: request.scope, kind: "result", operationId: request.operationId,
    result: phase === "observed" ? { phase, messageId, evidence: "same-node-dom-transition" } : { phase } };
}
function fixture(t: { after(fn: () => void): void }, transport: DotControlTransport, timeoutMs = 100) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "vkodex-control-test-")), "fixture.sqlite");
  const store = new BridgeStore(file); t.after(() => store.close());
  const journal = new DotRoomInputJournal(store, scope), gate = new DotBrowserConnectionGate({ ...scope, pageUrl });
  gate.setEnabled(true); const lease = gate.connect(0)!;
  gate.qualify(lease, { roomId: scope.roomId, pageUrl, qualified: true }, 0);
  const service = new DotRoomControlService(journal, gate, transport, () => 1, timeoutMs);
  return { store, journal, gate, lease, service };
}
test("one API operation fences first, calls the transport once and saves a queryable receipt", async t => {
  let calls = 0;
  const f = fixture(t, { async submitAndObserve(request) {
    calls++; assert.equal(f.store.inputState(key), "sending"); return receipt(request);
  } });
  const records: DiagnosticRecord[] = [];
  const result = await withDiagnosticSink(record => { records.push(record); }, () => f.service.run(input, f.lease));
  assert.equal(result.phase, "observed"); assert.equal(calls, 1);
  if (!("operationId" in result)) throw new Error("Missing operation");
  assert.deepEqual(f.journal.operationStatus(result.operationId), { operationId: result.operationId, phase: "observed", messageId });
  assert.equal(f.journal.isOwnVisibleMessage(messageId), true);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_TEST_TEXT/u);
  assert.equal(records.at(-1)?.stage, "finished");
  assert.deepEqual(await f.service.run(input, f.lease), { phase: "not-dispatched" }); assert.equal(calls, 1);
});
test("disconnected inputs remain queued and never call the browser", async t => {
  let calls = 0;
  const f = fixture(t, { async submitAndObserve() { calls++; throw new Error("Must not run"); } });
  f.gate.disconnect(f.lease);
  assert.deepEqual(await f.service.run(input, f.lease), { phase: "queued" });
  assert.equal(f.store.inputState(key), "received"); assert.equal(calls, 0);
});
test("timeout and late success retain uncertainty without replay", async t => {
  let resolve!: (value: unknown) => void, captured!: DotControlRequest, signal!: AbortSignal, calls = 0;
  const f = fixture(t, { submitAndObserve(request, abort) { calls++; captured = request; signal = abort;
    return new Promise(done => { resolve = done; }); } }, 5);
  const result = await f.service.run(input, f.lease);
  assert.equal(result.phase, "uncertain"); assert.equal(signal.aborted, true);
  resolve(receipt(captured)); await Promise.resolve();
  assert.equal(f.store.inputState(key), "uncertain"); assert.equal(f.journal.isOwnVisibleMessage(messageId), false);
  assert.deepEqual(await f.service.run(input, f.lease), { phase: "not-dispatched" }); assert.equal(calls, 1);
});
test("transport failure, acknowledgement alone and foreign receipts are uncertain", async t => {
  for (const mode of ["throw", "accepted", "foreign"] as const) {
    const f = fixture(t, { async submitAndObserve(request) {
      if (mode === "throw") throw new Error("PRIVATE transport payload");
      const response = receipt(request, mode === "accepted" ? "accepted" : "observed");
      return mode === "foreign" ? { ...response, requestId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee" } : response;
    } });
    assert.equal((await f.service.run(input, f.lease)).phase, "uncertain");
    assert.equal(f.store.inputState(key), "uncertain");
  }
});
test("concurrent invocation cannot create a second submission", async t => {
  let resolve!: (value: unknown) => void, captured!: DotControlRequest, calls = 0;
  const f = fixture(t, { submitAndObserve(request) { calls++; captured = request; return new Promise(done => { resolve = done; }); } });
  const running = f.service.run(input, f.lease);
  assert.deepEqual(await f.service.run(input, f.lease), { phase: "not-dispatched" });
  resolve(receipt(captured)); assert.equal((await running).phase, "observed"); assert.equal(calls, 1);
});
test("caller text mutation during the operation cannot change the dispatched command", async t => {
  let captured!: DotControlRequest, resolve!: (value: unknown) => void;
  const f = fixture(t, { submitAndObserve(request) { captured = request; return new Promise(done => { resolve = done; }); } });
  const mutable = { ...input }, running = f.service.run(mutable, f.lease); mutable.text = "changed";
  assert.equal(captured.method === "observe-and-submit" && captured.text, input.text);
  resolve(receipt(captured)); assert.equal((await running).phase, "observed");
});
test("unknown operation IDs never cause recovery or dispatch", t => {
  const f = fixture(t, { async submitAndObserve() { throw new Error("Must not run"); } });
  assert.equal(f.journal.operationStatus("ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"), null);
  assert.throws(() => f.journal.operationStatus("invalid"));
  assert.equal(f.store.inputState(key), null);
});
