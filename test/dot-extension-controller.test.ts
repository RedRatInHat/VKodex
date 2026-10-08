import test from "node:test";
import assert from "node:assert/strict";
import { DotExtensionController } from "../src/dot-browser/extension-controller.js";
import type { DotSubmissionCommandOptions, DotSubmissionCommandResult } from "../src/dot-browser/submission-command.js";
import type { DotControlResponse } from "../src/dot-browser/control-protocol.js";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", other = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const roomId = "a".repeat(32), mid = `${roomId}~${roomId}~CalpicoMessage~Sentinel_${"b".repeat(32)}`;
const binding = { roomId, pageUrl: "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ownerAnchorId: mid,
  dotAnchorId: mid.replace(/b{32}$/u, "c".repeat(32)) };
const base = { version: 1, requestId: id, scope: { roomId, generation: 1, epoch: id } };
const request = { ...base, method: "observe-and-submit", operationId: id, text: "test" };
const observed: DotSubmissionCommandResult = { phase: "observed", messageId: mid, evidence: "same-node-dom-transition" };
test("one command runs automatically, emits bounded stages, and duplicate calls only query", async () => {
  const events: DotControlResponse[] = []; let calls = 0;
  const controller = new DotExtensionController({} as Document, binding, 1, id, e => events.push(e), async options => {
    calls++; options.onStage("armed"); options.onStage("write-attempt"); options.onStage("write-returned"); return observed;
  }, () => true);
  const result = await controller.handle(request);
  assert.equal(result.kind, "result");
  assert.deepEqual(events.map(event => event.kind), ["result", "stage", "stage", "stage"]);
  assert.deepEqual(await controller.handle(request), result); assert.equal(calls, 1);
  const conflict = await controller.handle({ ...request, text: "different" });
  assert.equal(conflict.kind === "error" && conflict.reason, "operation-conflict");
  assert.equal((await controller.handle({ ...base, method: "result", operationId: id })).kind, "result");
});
test("concurrent commands do not overwrite the active operation", async () => {
  let resolve!: (result: DotSubmissionCommandResult) => void;
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => {}, () => new Promise(done => { resolve = done; }), () => true);
  const running = controller.handle(request);
  const duplicate = await controller.handle(request);
  assert.equal(duplicate.kind === "result" && duplicate.result.phase, "accepted");
  const concurrent = await controller.handle({ ...request, operationId: other });
  assert.equal(concurrent.kind === "error" && concurrent.reason, "operation-conflict");
  assert.equal((await controller.handle({ ...base, method: "status" })).kind, "status");
  resolve(observed); await running;
});
test("disconnect and failed stage delivery abort the active command without retry", async () => {
  let calls = 0, captured!: DotSubmissionCommandOptions;
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => { throw new Error("port closed"); }, async options => {
    calls++; captured = options;
    return { phase: "uncertain", reason: "aborted" };
  }, () => true);
  const response = await controller.handle(request);
  assert.equal(captured.signal.aborted, true);
  assert.equal(response.kind === "result" && response.result.phase, "uncertain");
  assert.equal((await controller.handle(request)).kind, "error"); assert.equal(calls, 1);
});
test("wrong scope, foreign command and unqualified page never reach the runner", async () => {
  let calls = 0;
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => {}, async () => { calls++; return observed; }, () => false);
  for (const scope of [{ ...base.scope, epoch: other }, { ...base.scope, generation: 2 }, { ...base.scope, roomId: "b".repeat(32) }])
    assert.equal((await controller.handle({ ...request, scope })).kind, "error");
  await assert.rejects(controller.handle({ ...request, method: "eval", script: "PRIVATE" }), /Invalid dot control request/u);
  assert.equal((await controller.handle(request)).kind, "error"); assert.equal(calls, 0);
});
test("unknown results remain unknown and runner errors become fixed uncertainty", async () => {
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => {}, async () => { throw new Error("PRIVATE"); }, () => true);
  assert.equal((await controller.handle({ ...base, method: "result", operationId: other })).kind, "error");
  const result = await controller.handle(request);
  assert.equal(result.kind === "result" && result.result.phase, "uncertain");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
});
