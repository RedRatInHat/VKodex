import test from "node:test";
import assert from "node:assert/strict";
import { withDiagnosticSink, type DiagnosticRecord } from "../src/bridge/diagnostics.js";
import { traceDotControl, type DotControlTrace, type DotControlStage } from "../src/dot-browser/control-diagnostics.js";
const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
test("control stages share correlation, timing and ordered sanitized journal", () => {
  const records: DiagnosticRecord[] = [];
  withDiagnosticSink(record => { records.push(record); }, () => {
    for (const stage of ["received", "qualified", "armed", "dispatch", "receipt", "finished", "disconnected"] as const)
      traceDotControl(stage, { requestId: uuid, operationId: uuid, epoch: uuid, generation: 1, elapsedMs: 23, outcome: "success" });
  });
  assert.equal(records.length, 7);
  for (const [index, record] of records.entries()) {
    assert.equal(record.attemptId, uuid); assert.equal(record.operationId, uuid);
    assert.equal(record.connectionId, uuid); assert.equal(record.elapsedMs, 23);
    assert.equal(record.route, "dot-browser"); assert.ok(Number.isFinite(Date.parse(record.at)));
    if (index > 0) assert.ok(record.seq > records[index - 1]!.seq);
  }
});
test("diagnostics exclude text, credentials, unexpected fields and raw errors", () => {
  const records: DiagnosticRecord[] = [];
  withDiagnosticSink(record => { records.push(record); }, () => {
    traceDotControl("finished", { requestId: "PRIVATE", epoch: "PRIVATE", generation: 1, elapsedMs: 0,
      outcome: "failure", reason: "PRIVATE", text: "PRIVATE", token: "PRIVATE", stack: "PRIVATE" } as unknown as DotControlTrace);
    traceDotControl("PRIVATE" as DotControlStage, {} as DotControlTrace);
  });
  assert.equal(records.length, 1);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/u);
  assert.equal(records[0]!.reason, "unknown");
});
test("logging failure cannot change command semantics", () => {
  assert.doesNotThrow(() => withDiagnosticSink(() => { throw new Error("sink unavailable"); }, () =>
    traceDotControl("armed", { requestId: uuid, epoch: uuid, generation: 1, elapsedMs: 0, outcome: "success" })));
});
