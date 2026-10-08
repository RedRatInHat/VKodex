import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { BridgeStore } from "../src/bridge/store.js";
import { DotRoomInputJournal } from "../src/dot-browser/input-journal.js";
import { DotBrowserConnectionGate } from "../src/dot-browser/connection-gate.js";
import { DotNativeControlPeer } from "../src/dot-browser/native-control-peer.js";
import { NativeMessageDecoder, encodeNativeMessage } from "../src/dot-browser/native-message-framing.js";
import { parseDotControlRequest, type DotControlRequest } from "../src/dot-browser/control-protocol.js";
import { DotCanaryCoordinator } from "../src/dot-browser/canary-coordinator.js";
import { canaryInput, canaryMarker, parseDotCanaryConfig, type DotCanaryConfig } from "../src/dot-browser/canary-config.js";
import { runDotCanaryCli } from "../src/dot-browser/canary-cli.js";
import { withDiagnosticSink, type DiagnosticRecord } from "../src/bridge/diagnostics.js";

const requestId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const text = canaryMarker(requestId) + "\nPRIVATE_CANARY_FIXTURE";
const room = "a".repeat(32);
const messageId = `${room}~${room}~CalpicoMessage~Sentinel_${"b".repeat(32)}`;
function configuration(): DotCanaryConfig {
  return { version: 1, mode: "diagnostic-canary", databasePath: path.join(mkdtempSync(path.join(tmpdir(), "dot-canary-test-")), "dot-control-canary.sqlite"),
    peerId: 2_000_000_032, ownerId: 42, roomId: room, generation: 1,
    pageUrl: "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
}
function fixture(t: { after(fn: () => void): void }, statusMs = 100, submitMs = 100) {
  const config = configuration(), store = new BridgeStore(config.databasePath);
  const journal = new DotRoomInputJournal(store, config);
  const gate = new DotBrowserConnectionGate(config); gate.setEnabled(true);
  const lease = gate.connect(20_000)!;
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeMessageDecoder();
  const requests: DotControlRequest[] = [];
  let handler: (request: DotControlRequest) => void = () => {};
  const peer = new DotNativeControlPeer(input, output, () => gate.disconnect(lease));
  output.on("data", bytes => { for (const value of decoder.push(bytes as Uint8Array)) {
    const request = parseDotControlRequest(value); requests.push(request); handler(request);
  } });
  t.after(() => { peer.close(); store.close(); });
  const coordinator = new DotCanaryCoordinator(config, store, gate, peer, () => 20_001, statusMs, submitMs);
  const respond = (request: DotControlRequest, body: object) => input.write(encodeNativeMessage({
    version: 1, requestId: request.requestId, scope: request.scope, ...body,
  }));
  const ready = (request: DotControlRequest) => respond(request, { kind: "status", state: "ready" });
  const terminal = (request: DotControlRequest, phase = "observed") => {
    assert.equal(request.method, "observe-and-submit");
    if (request.method !== "observe-and-submit") throw new Error("Wrong method");
    respond(request, { kind: "result", operationId: request.operationId,
      result: phase === "observed" ? { phase, messageId, evidence: "same-node-dom-transition" } : { phase: "uncertain", reason: "disconnect" } });
  };
  const queued = canaryInput(config, requestId, text), key = JSON.stringify([config.peerId, queued.eventId]);
  const enqueue = () => journal.receive(queued, 0);
  return { config, store, journal, gate, lease, peer, coordinator, requests, queued, key, ready, terminal, respond, enqueue,
    handler: (fn: (request: DotControlRequest) => void) => { handler = fn; } };
}

test("CLI duplicate UUID is no-op; changed payload refuses and preserves original", t => {
  const config = configuration(), configPath = path.join(path.dirname(config.databasePath), "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const first = runDotCanaryCli(["enqueue", configPath, requestId, text]);
  assert.deepEqual(first, { enqueued: true, state: "received", operationId: null, messageId: null });
  assert.deepEqual(runDotCanaryCli(["enqueue", configPath, requestId, text]), { ...first as object, enqueued: false });
  assert.throws(() => runDotCanaryCli(["enqueue", configPath, requestId, text + " changed"]), /conflicting/u);
  const store = new BridgeStore(config.databasePath); t.after(() => store.close());
  assert.equal(store.reserveReplayableInputs(Date.now() + 11_000, 1)[0]?.text, text);
});

test("CLI status and eventStatus are read-only and return no payload", t => {
  const h = fixture(t); h.enqueue();
  const configPath = path.join(path.dirname(h.config.databasePath), "config.json"); writeFileSync(configPath, JSON.stringify(h.config));
  const before = Buffer.concat([readFileSync(h.config.databasePath), readFileSync(h.config.databasePath + "-wal")]);
  assert.deepEqual(runDotCanaryCli(["status", configPath, requestId]), { state: "received", operationId: null, messageId: null });
  assert.deepEqual(h.journal.eventStatus(h.queued.eventId), { state: "received", operationId: null, messageId: null });
  assert.equal(h.journal.eventStatus("canary:ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"), null);
  assert.deepEqual(Buffer.concat([readFileSync(h.config.databasePath), readFileSync(h.config.databasePath + "-wal")]), before);
  assert.equal(h.store.inputState(h.key), "received");
  const readOnly = new BridgeStore(h.config.databasePath, { readOnly: true });
  try { assert.throws(() => readOnly.setValue("cannot-write", 1)); } finally { readOnly.close(); }
  assert.throws(() => new BridgeStore(h.config.databasePath, { readOnly: true, existingTransferSchemaSha256: "a".repeat(64) }));
  assert.throws(() => new BridgeStore(":memory:", { readOnly: true }));
  assert.throws(() => new BridgeStore("relative.sqlite", { readOnly: true }));
});

test("event lookup is pinned to peer and never recovers an attempted event", t => {
  const h = fixture(t); h.enqueue();
  const other = new DotRoomInputJournal(h.store, { ...h.config, peerId: h.config.peerId + 1 });
  assert.equal(other.eventStatus(h.queued.eventId), null);
  const attempt = h.journal.dispatch(h.queued, h.lease.epoch)!;
  h.store.recover = () => { throw new Error("Read lookup cannot recover"); };
  assert.deepEqual(h.journal.eventStatus(h.queued.eventId), { state: "attempted", operationId: attempt.operationId, messageId: null });
  assert.equal(h.store.inputState(h.key), "sending");
});

test("offline queue stays received without status request or dispatch", async t => {
  const h = fixture(t); h.enqueue(); h.gate.disconnect(h.lease);
  assert.deepEqual(await h.coordinator.tick(h.lease), { phase: "queued" });
  assert.equal(h.requests.length, 0); assert.equal(h.store.inputState(h.key), "received");
  assert.equal(h.store.reserveReplayableInputs(20_001, 1).length, 1);
});

test("status timeout never reserves or dispatches queued input", async t => {
  const h = fixture(t, 5); h.enqueue();
  assert.deepEqual(await h.coordinator.tick(h.lease), { phase: "queued" });
  assert.deepEqual(h.requests.map(request => request.method), ["status"]);
  assert.equal(h.store.inputState(h.key), "received");
  assert.equal(h.store.reserveReplayableInputs(20_001, 1).length, 1);
});

test("bounded readiness failure is logged without reserving or dispatching input", async t => {
  const h = fixture(t); h.enqueue();
  h.handler(request => h.respond(request, { kind: "status", state: "qualifying", reason: "anchors-not-visible" }));
  const records: DiagnosticRecord[] = [];
  assert.deepEqual(await withDiagnosticSink(record => { records.push(record); }, () => h.coordinator.tick(h.lease)), { phase: "queued" });
  assert.deepEqual(h.requests.map(request => request.method), ["status"]);
  assert.equal(h.journal.eventStatus(h.queued.eventId)?.operationId, null);
  assert.equal(h.store.inputState(h.key), "received");
  assert.ok(records.some(record => record.reason === "anchors-not-visible"));
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_CANARY_FIXTURE|VKODEX-DOT-CONTROL-CANARY/u);
});

test("only exactly scoped ready status admits one durable submission", async t => {
  const h = fixture(t); h.enqueue();
  h.handler(request => {
    if (request.method === "status") h.ready(request);
    else { assert.equal(h.store.inputState(h.key), "sending"); h.terminal(request); }
  });
  const records: DiagnosticRecord[] = [];
  const result = await withDiagnosticSink(record => { records.push(record); }, () => h.coordinator.tick(h.lease));
  assert.equal(result.phase, "observed");
  assert.deepEqual(h.requests.map(request => request.method), ["status", "observe-and-submit"]);
  for (const request of h.requests) assert.deepEqual(request.scope, { roomId: room, generation: 1, epoch: h.lease.epoch });
  assert.ok("operationId" in result);
  assert.deepEqual(h.journal.eventStatus(h.queued.eventId), { state: "observed", operationId: result.operationId, messageId });
  assert.deepEqual(h.journal.operationStatus(result.operationId), { phase: "observed", operationId: result.operationId, messageId });
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_CANARY_FIXTURE|VKODEX-DOT-CONTROL-CANARY/u);
  assert.ok(records.some(record => record.operationId === result.operationId));
});

test("wrong room, generation, epoch or request ID and non-ready status cannot dispatch", async t => {
  for (const mode of ["room", "generation", "epoch", "request", "busy"] as const) {
    const h = fixture(t); h.enqueue();
    h.handler(request => h.respond(request, { kind: "status", state: mode === "busy" ? "busy" : "ready",
      ...(mode === "request" ? { requestId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee" } : {}),
      scope: { ...request.scope, ...(mode === "room" ? { roomId: "c".repeat(32) } : {}),
        ...(mode === "generation" ? { generation: 2 } : {}), ...(mode === "epoch" ? { epoch: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee" } : {}) } }));
    assert.deepEqual(await h.coordinator.tick(h.lease), { phase: "queued" });
    assert.equal(h.requests.length, 1); assert.equal(h.store.reserveReplayableInputs(20_001, 1).length, 1);
  }
});

test("concurrent ticks, including another coordinator on the store, produce one send", async t => {
  const h = fixture(t); h.enqueue();
  let status!: DotControlRequest, submit!: DotControlRequest;
  h.handler(request => { if (request.method === "status") status = request; else submit = request; });
  const running = h.coordinator.tick(h.lease);
  assert.deepEqual(await h.coordinator.tick(h.lease), { phase: "busy" });
  const second = new DotCanaryCoordinator(h.config, h.store, h.gate, h.peer, () => 20_001);
  assert.deepEqual(await second.tick(h.lease), { phase: "busy" });
  h.ready(status); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  h.terminal(submit); assert.equal((await running).phase, "observed");
  assert.equal(h.requests.filter(request => request.method === "observe-and-submit").length, 1);
});

test("unknown send and submit timeout keep uncertainty with no recovery or replay", async t => {
  for (const mode of ["uncertain", "timeout"] as const) {
    const h = fixture(t, 100, 5); h.enqueue();
    h.store.recover = () => { throw new Error("Recovery forbidden during live operation"); };
    h.handler(request => { if (request.method === "status") h.ready(request); else if (mode === "uncertain") h.terminal(request, "uncertain"); });
    assert.equal((await h.coordinator.tick(h.lease)).phase, "uncertain");
    assert.equal(h.store.inputState(h.key), "uncertain");
    assert.equal(h.journal.eventStatus(h.queued.eventId)?.state, "uncertain");
    assert.equal(h.store.reserveReplayableInputs(100_000, 1).length, 0);
    const next = await h.coordinator.tick(h.lease);
    assert.ok(next.phase === "blocked" || next.phase === "queued");
    assert.equal(h.requests.filter(request => request.method === "observe-and-submit").length, 1);
  }
});

test("reserved foreign inputs and unmarked canary payloads are never submitted", async t => {
  for (const mode of ["peer", "owner", "prefix", "marker", "unjournaled"] as const) {
    const h = fixture(t);
    const bad = { ...h.queued, ...(mode === "peer" ? { peerId: h.config.peerId + 1 } : {}),
      ...(mode === "owner" ? { senderId: 99 } : {}), ...(mode === "prefix" ? { eventId: "message:7" } : {}),
      ...(mode === "marker" ? { text: "unmarked" } : {}) };
    h.store.receiveInput(bad, 0); h.handler(request => h.ready(request));
    assert.deepEqual(await h.coordinator.tick(h.lease), { phase: "rejected" });
    assert.equal(h.requests.length, 1); assert.equal(h.store.inputState(JSON.stringify([bad.peerId, bad.eventId])), "received");
  }
});

test("production paths, unversioned mode, mismatched store/gate and arbitrary CLI methods refuse", t => {
  const h = fixture(t), folder = path.dirname(h.config.databasePath);
  for (const basename of ["vkodex.sqlite", "dot-native.sqlite", "VKODEX.SQLITE", "other.sqlite"])
    assert.throws(() => parseDotCanaryConfig({ ...h.config, databasePath: path.join(folder, basename) }));
  assert.throws(() => parseDotCanaryConfig({ ...h.config, mode: "production" }));
  assert.throws(() => parseDotCanaryConfig({ ...h.config, version: 2 }));
  assert.throws(() => new DotCanaryCoordinator({ ...h.config, databasePath: path.join(folder, "vkodex.sqlite") }, h.store, h.gate, h.peer));
  const foreign = configuration(); assert.throws(() => new DotCanaryCoordinator(foreign, h.store, h.gate, h.peer));
  const foreignGate = new DotBrowserConnectionGate({ ...h.config, generation: 2 });
  assert.throws(() => new DotCanaryCoordinator(h.config, h.store, foreignGate, h.peer));
  assert.throws(() => canaryInput(h.config, requestId, text + "x".repeat(2000)));
  assert.throws(() => canaryInput(h.config, requestId, "arbitrary prompt"));
  assert.throws(() => runDotCanaryCli(["recover", "unused", requestId]));
});

test("terminal journal write failure after transport call returns unknown and preserves the fence", async t => {
  const h = fixture(t); h.enqueue();
  let sends = 0;
  const original = h.store.setValue.bind(h.store);
  h.store.setValue = (key, value) => {
    if (sends > 0) throw new Error("PRIVATE_SETTLE_FAILURE");
    original(key, value);
  };
  h.handler(request => {
    if (request.method === "status") h.ready(request);
    else { sends++; h.terminal(request); }
  });
  const records: DiagnosticRecord[] = [];
  const result = await withDiagnosticSink(record => { records.push(record); }, () => h.coordinator.tick(h.lease));
  assert.deepEqual(result, { phase: "unknown" }); assert.equal(sends, 1);
  assert.equal(h.store.inputState(h.key), "sending");
  assert.equal(h.journal.eventStatus(h.queued.eventId)?.state, "attempted");
  assert.equal(h.store.reserveReplayableInputs(100_000, 1).length, 0);
  assert.ok(records.some(record => record.stage === "finished" && record.outcome === "unknown"));
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_SETTLE_FAILURE|PRIVATE_CANARY_FIXTURE/u);
  assert.deepEqual(await h.coordinator.tick(h.lease), { phase: "queued" }); assert.equal(sends, 1);
});

test("scoped tab-missing and non-ready status emit bounded qualification failure without dispatch", async t => {
  for (const mode of ["tab-missing", "not-ready"] as const) {
    const h = fixture(t); h.enqueue();
    h.handler(request => h.respond(request, mode === "tab-missing" ? { kind: "error", reason: mode } : { kind: "status", state: "qualifying" }));
    const records: DiagnosticRecord[] = [];
    assert.deepEqual(await withDiagnosticSink(record => { records.push(record); }, () => h.coordinator.tick(h.lease)), { phase: "queued" });
    assert.equal(h.requests.length, 1); assert.equal(h.store.inputState(h.key), "received");
    assert.ok(records.some(record => record.outcome === "failure" && record.reason === mode));
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_CANARY_FIXTURE/u);
  }
});
