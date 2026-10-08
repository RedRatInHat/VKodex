import test from "node:test";
import assert from "node:assert/strict";
import { parseDotControlRequest, parseDotControlResponse, matchDotControlResponse } from "../src/dot-browser/control-protocol.js";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", other = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const scope = { roomId: "a".repeat(32), generation: 1, epoch: id };
const base = { version: 1, requestId: id, scope };
const command = { ...base, method: "observe-and-submit", operationId: id, text: "Тестовое сообщение" };
const observed = { ...base, kind: "result", operationId: id, result: { phase: "observed",
  messageId: `${scope.roomId}~${scope.roomId}~CalpicoMessage~Sentinel_${"b".repeat(32)}`, evidence: "same-node-dom-transition" } };
test("fixed control methods roundtrip without arbitrary code or selectors", () => {
  for (const value of [{ ...base, method: "status" }, { ...base, method: "result", operationId: id }, command])
    assert.deepEqual(parseDotControlRequest(value), value);
  for (const value of [{ ...command, evaluate: "PRIVATE" }, { ...command, method: "eval" },
    { ...command, scope: { ...scope, token: "PRIVATE" } }, { ...command, method: "arm" }])
    assert.throws(() => parseDotControlRequest(value), /^Error: Invalid dot control request$/u);
});
test("invalid and excessive content receives only a fixed error", () => {
  for (const text of ["", "  ", "\0", "a".repeat(100_001), null, {}])
    assert.throws(() => parseDotControlRequest({ ...command, text }), /^Error: Invalid dot control request$/u);
});
test("received acknowledgement and visible acceptance are distinct", () => {
  assert.equal(parseDotControlResponse({ ...observed, result: { phase: "accepted" } }).kind, "result");
  assert.deepEqual(matchDotControlResponse(parseDotControlRequest(command), observed), observed);
  assert.throws(() => parseDotControlResponse({ ...observed, result: { phase: "observed" } }));
});
test("receipts cannot cross rooms, requests, operations, epochs or generations", () => {
  const request = parseDotControlRequest(command);
  for (const patch of [{ requestId: other }, { operationId: other }, { scope: { ...scope, epoch: other } },
    { scope: { ...scope, generation: 2 } }, { scope: { ...scope, roomId: "b".repeat(32) } },
    { kind: "status", state: "ready", operationId: undefined, result: undefined }])
    assert.throws(() => matchDotControlResponse(request, { ...observed, ...patch }));
});
test("uncertainty and errors permit only redacted categories", () => {
  assert.equal(parseDotControlResponse({ ...observed, result: { phase: "uncertain", reason: "interference" } }).kind, "result");
  for (const value of [{ ...base, kind: "error", reason: "PRIVATE" },
    { ...base, kind: "error", reason: "other", stack: "PRIVATE" },
    { ...observed, result: { phase: "uncertain", reason: "other", text: "PRIVATE" } }])
    assert.throws(() => parseDotControlResponse(value), /^Error: Invalid dot control response$/u);
});
test("status cannot be mistaken for a submission result", () => {
  assert.throws(() => matchDotControlResponse(parseDotControlRequest({ ...base, method: "status" }), observed));
  const response = { ...base, kind: "error", reason: "not-ready" };
  assert.deepEqual(matchDotControlResponse(parseDotControlRequest(command), response), response);
});
