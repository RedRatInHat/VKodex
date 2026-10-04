import assert from "node:assert/strict";
import test from "node:test";
import { captureDiagnostic, diagnosticEvent, diagnosticError, diagnosticId, diagnosticScope, withDiagnosticSink,
  type DiagnosticRecord } from "../src/bridge/diagnostics.js";

test("diagnostic allowlist excludes payloads, secret-bearing errors and arbitrary scalars", () => {
  const secret = "vk1.a.private-token-and-user-text";
  const records: DiagnosticRecord[] = [];
  withDiagnosticSink(record => { records.push(record); }, () => {
    diagnosticEvent("input.result", { ...diagnosticError(Object.assign(new Error(secret), { reason: secret, code: secret })),
      threadId: secret, eventId: secret, method: secret, outcome: secret,
      ...({ text: secret, params: { token: secret }, error: new Error(secret), stack: secret } as object) });
    diagnosticEvent(secret, { threadId: secret });
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.threadId, diagnosticId(secret));
  assert.equal(records[0]?.method, "other");
  assert.equal(JSON.stringify(records).includes(secret), false);
  assert.equal(Object.hasOwn(records[0]!, "params"), false);
  const evil = new Error(); Object.defineProperty(evil, "name", { get() { throw new Error(secret); } });
  assert.deepEqual(diagnosticError(evil), { errorType: "Error" });
});

test("captured diagnostics keep original context across interleaved callbacks", async () => {
  const records: DiagnosticRecord[] = [];
  const first = "10000000-0000-0000-0000-000000000001";
  const second = "10000000-0000-0000-0000-000000000002";
  await withDiagnosticSink(record => { records.push(record); }, async () => {
    const empty = captureDiagnostic();
    const captured = diagnosticScope({ attemptId: first }, () => captureDiagnostic());
    await diagnosticScope({ attemptId: second }, async () => {
      await Promise.resolve(); captured("rpc.stage", { stage: "response" }); empty("rpc.stage", { stage: "response" });
    });
  });
  assert.equal(records[0]?.attemptId, first);
  assert.equal(records[1]?.attemptId, undefined);
});

test("async diagnostic failure does not reject the application operation", async () => {
  const result = await withDiagnosticSink(async () => { throw new Error("write fault"); }, async () => {
    diagnosticEvent("input.started"); await Promise.resolve(); return "accepted by fixture";
  });
  assert.equal(result, "accepted by fixture");
});
