import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { DotNativeControlPeer } from "../src/dot-browser/native-control-peer.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/dot-browser/native-message-framing.js";
import type { DotControlRequest } from "../src/dot-browser/control-protocol.js";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const request: DotControlRequest = { version: 1, requestId: id, scope: { roomId: "a".repeat(32), generation: 1, epoch: id },
  method: "observe-and-submit", operationId: id, text: "fixture only" };
const response = { version: 1, requestId: id, scope: request.scope, kind: "result", operationId: id,
  result: { phase: "observed", messageId: `${"a".repeat(32)}~${"a".repeat(32)}~CalpicoMessage~Sentinel_${"b".repeat(32)}`, evidence: "same-node-dom-transition" } };
function fixture(t: { after(fn: () => void): void }) {
  const input = new PassThrough(), output = new PassThrough(); let disconnects = 0;
  const writes: Buffer[] = []; output.on("data", bytes => writes.push(Buffer.from(bytes)));
  const peer = new DotNativeControlPeer(input, output, () => { disconnects++; }); t.after(() => peer.close());
  return { peer, input, output, writes, disconnects: () => disconnects };
}
test("peer sends once and waits beyond acknowledgement for the visible receipt", async t => {
  const h = fixture(t), abort = new AbortController(); let settled = false;
  const running = h.peer.submitAndObserve(request, abort.signal).then(value => { settled = true; return value; });
  assert.deepEqual(new NativeMessageDecoder().push(Buffer.concat(h.writes)), [request]);
  h.input.write(encodeNativeMessage({ ...response, result: { phase: "accepted" } }));
  await Promise.resolve(); assert.equal(settled, false);
  h.input.write(encodeNativeMessage({ version: 1, requestId: id, scope: request.scope, kind: "stage", operationId: id, stage: "armed" }));
  await Promise.resolve(); assert.equal(settled, false);
  h.input.write(encodeNativeMessage(response)); assert.deepEqual(await running, response);
  abort.abort(); assert.equal(h.disconnects(), 0);
});
test("abort closes once and never writes a retry", async t => {
  const h = fixture(t), abort = new AbortController();
  const running = h.peer.submitAndObserve(request, abort.signal);
  abort.abort(); await assert.rejects(running, /disconnected/u);
  assert.equal(h.disconnects(), 1); assert.equal(h.writes.length, 1);
  await assert.rejects(h.peer.submitAndObserve(request, new AbortController().signal), /unavailable/u);
});
test("concurrent commands are rejected instead of overwriting receipt correlation", async t => {
  const h = fixture(t), abort = new AbortController(); const running = h.peer.submitAndObserve(request, abort.signal);
  await assert.rejects(h.peer.submitAndObserve(request, abort.signal), /busy/u);
  h.input.write(encodeNativeMessage(response)); await running; assert.equal(h.writes.length, 1);
});
test("wrong receipt and malformed framing permanently close the peer", async t => {
  for (const bytes of [encodeNativeMessage({ ...response, requestId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" }), Buffer.alloc(4)]) {
    const h = fixture(t), running = h.peer.submitAndObserve(request, new AbortController().signal);
    h.input.write(bytes); await assert.rejects(running, /disconnected/u); assert.equal(h.disconnects(), 1);
  }
});
test("EOF while awaiting a receipt rejects without an automatic resend", async t => {
  const h = fixture(t), running = h.peer.submitAndObserve(request, new AbortController().signal);
  h.input.end(); await assert.rejects(running, /disconnected/u); assert.equal(h.writes.length, 1);
});
