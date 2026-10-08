import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { BridgeStore } from "../src/bridge/store.js";
import { DotRoomInputJournal } from "../src/dot-browser/input-journal.js";
import { canaryInput, canaryMarker, type DotCanaryConfig } from "../src/dot-browser/canary-config.js";
import { acquireDotCanaryHostSingleton, runDotCanaryNativeHost } from "../src/dot-browser/canary-host.js";
import { NativeMessageDecoder, encodeNativeMessage } from "../src/dot-browser/native-message-framing.js";
import { parseDotControlRequest } from "../src/dot-browser/control-protocol.js";
const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", roomId = "a".repeat(32), extensionId = "b".repeat(32);
async function fixture() {
  const directory = await realpath(mkdtempSync(path.join(await realpath(tmpdir()), "vkodex-host-test-")));
  const config: DotCanaryConfig = { version: 1, mode: "diagnostic-canary", databasePath: path.join(directory, "dot-control-canary.sqlite"),
    peerId: 2_000_000_123, ownerId: 42, roomId, generation: 1, pageUrl: "https://chatgpt.com/dots/" + uuid };
  const configFile = path.join(directory, "config.json"); writeFileSync(configFile, JSON.stringify(config));
  const args = ["--config", configFile, "--extension-id", extensionId, `chrome-extension://${extensionId}/`];
  return { directory, config, configFile, args };
}
test("host uses the common journal and bounded logs for one automatic canary", { timeout: 60_000 }, async () => {
  const f = await fixture(), text = canaryMarker(uuid) + "\nPRIVATE_HOST_FIXTURE";
  const initial = new BridgeStore(f.config.databasePath);
  new DotRoomInputJournal(initial, f.config).receive(canaryInput(f.config, uuid, text)); initial.close();
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeMessageDecoder();
  const methods: string[] = []; let releases = 0;
  output.on("data", bytes => {
    for (const raw of decoder.push(bytes)) {
      const request = parseDotControlRequest(raw); methods.push(request.method);
      const base = { version: 1, requestId: request.requestId, scope: request.scope };
      if (request.method === "status") input.write(encodeNativeMessage({ ...base, kind: "status", state: "ready" }));
      else if (request.method === "observe-and-submit") input.write(encodeNativeMessage({ ...base, kind: "result", operationId: request.operationId,
        result: { phase: "observed", evidence: "same-node-dom-transition", messageId: `${roomId}~${roomId}~CalpicoMessage~Sentinel_${"c".repeat(32)}` } }));
    }
  });
  await runDotCanaryNativeHost(f.args, input, output, async database => {
    assert.equal(database, f.config.databasePath); return async () => { releases++; };
  });
  assert.deepEqual(methods, ["status", "observe-and-submit"]); assert.equal(releases, 1);
  const store = new BridgeStore(f.config.databasePath, { readOnly: true });
  try { assert.equal(new DotRoomInputJournal(store, f.config).eventStatus("canary:" + uuid)?.state, "observed"); }
  finally { store.close(); }
  const logs = readdirSync(path.join(f.directory, "diagnostics")).filter(name => name.endsWith(".jsonl"))
    .map(name => readFileSync(path.join(f.directory, "diagnostics", name), "utf8")).join("");
  assert.match(logs, /input.finished/u); assert.doesNotMatch(logs, /PRIVATE_HOST_FIXTURE|VKODEX-DOT-CONTROL-CANARY/u);
});

test("prolonged not-ready keeps one port epoch and capped backoff until one fresh ready dispatch", { timeout: 60_000 }, async () => {
  const f = await fixture(), initial = new BridgeStore(f.config.databasePath);
  new DotRoomInputJournal(initial, f.config).receive(canaryInput(f.config, uuid, canaryMarker(uuid) + "\nPRIVATE_WAIT_FIXTURE"), 0);
  initial.close();
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeMessageDecoder();
  const methods: string[] = [], epochs: string[] = [], waits: number[] = [], statusTimes: number[] = [];
  let now = 0, acquisitions = 0, releases = 0, dispatches = 0;
  output.on("data", bytes => {
    for (const raw of decoder.push(bytes)) {
      const request = parseDotControlRequest(raw); methods.push(request.method); epochs.push(request.scope.epoch);
      const base = { version: 1, requestId: request.requestId, scope: request.scope };
      if (request.method === "status") {
        statusTimes.push(now);
        input.write(encodeNativeMessage({ ...base, kind: "status", state: now < 28_000 ? "qualifying" : "ready",
          ...(now < 28_000 ? { reason: "anchors-not-visible" } : {}) }));
      } else if (request.method === "observe-and-submit") {
        assert.equal(now, 28_000); dispatches++;
        input.write(encodeNativeMessage({ ...base, kind: "result", operationId: request.operationId,
          result: { phase: "observed", evidence: "same-node-dom-transition", messageId: `${roomId}~${roomId}~CalpicoMessage~Sentinel_${"c".repeat(32)}` } }));
      }
    }
  });
  await runDotCanaryNativeHost(f.args, input, output, async () => {
    acquisitions++; return async () => { releases++; };
  }, { now: () => now, wait: async milliseconds => {
    assert.equal(dispatches, 0); assert.equal(input.destroyed, false); assert.equal(output.destroyed, false);
    waits.push(milliseconds); now += milliseconds;
  } });
  assert.deepEqual(waits, [1000, 2000, 5000, 10000, 10000]);
  assert.deepEqual(statusTimes, [0, 1000, 3000, 8000, 18000, 28000]);
  assert.equal(new Set(epochs).size, 1); assert.equal(dispatches, 1);
  assert.deepEqual(methods, [...Array<string>(6).fill("status"), "observe-and-submit"]);
  assert.equal(acquisitions, 1); assert.equal(releases, 1);
  const store = new BridgeStore(f.config.databasePath, { readOnly: true });
  try { assert.equal(new DotRoomInputJournal(store, f.config).eventStatus("canary:" + uuid)?.state, "observed"); }
  finally { store.close(); }
});

test("empty queue does not poll the page and disconnect ends only the existing host", { timeout: 60_000 }, async () => {
  const f = await fixture(), input = new PassThrough(), output = new PassThrough();
  let writes = 0, releases = 0, waits = 0; output.on("data", () => { writes++; });
  await runDotCanaryNativeHost(f.args, input, output, async () => async () => { releases++; }, {
    now: () => 0, wait: async milliseconds => {
      assert.equal(milliseconds, 1000); assert.equal(++waits, 1);
      input.end(); await new Promise<void>(resolve => setImmediate(resolve));
    },
  });
  assert.equal(writes, 0); assert.equal(releases, 1);
});

test("disconnect after prolonged not-ready preserves received input without dispatch or reconnect", { timeout: 60_000 }, async () => {
  const f = await fixture(), initial = new BridgeStore(f.config.databasePath);
  new DotRoomInputJournal(initial, f.config).receive(canaryInput(f.config, uuid, canaryMarker(uuid) + "\nPRIVATE_DISCONNECT_FIXTURE"), 0);
  initial.close();
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeMessageDecoder();
  const methods: string[] = []; let now = 0, acquisitions = 0;
  output.on("data", bytes => {
    for (const raw of decoder.push(bytes)) {
      const request = parseDotControlRequest(raw); methods.push(request.method);
      input.write(encodeNativeMessage({ version: 1, requestId: request.requestId, scope: request.scope,
        kind: "status", state: "qualifying", reason: "anchors-not-visible" }));
    }
  });
  await runDotCanaryNativeHost(f.args, input, output, async () => {
    acquisitions++; return async () => {};
  }, { now: () => now, wait: async milliseconds => {
    now += milliseconds;
    if (now >= 18_000) { input.end(); await new Promise<void>(resolve => setImmediate(resolve)); }
  } });
  assert.equal(acquisitions, 1); assert.deepEqual(methods, Array<string>(4).fill("status"));
  const store = new BridgeStore(f.config.databasePath, { readOnly: true });
  try {
    assert.deepEqual(new DotRoomInputJournal(store, f.config).eventStatus("canary:" + uuid),
      { state: "received", operationId: null, messageId: null });
  } finally { store.close(); }
});

test("status timeout closes the port without dispatch or retry", { timeout: 60_000 }, async () => {
  const f = await fixture(), initial = new BridgeStore(f.config.databasePath);
  new DotRoomInputJournal(initial, f.config).receive(canaryInput(f.config, uuid, canaryMarker(uuid) + "\nPRIVATE_TIMEOUT_FIXTURE"));
  initial.close();
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeMessageDecoder();
  const methods: string[] = [];
  output.on("data", bytes => { for (const raw of decoder.push(bytes)) methods.push(parseDotControlRequest(raw).method); });
  await runDotCanaryNativeHost(f.args, input, output, async () => async () => {});
  assert.deepEqual(methods, ["status"]); assert.equal(input.destroyed, true);
  const store = new BridgeStore(f.config.databasePath, { readOnly: true });
  try {
    assert.deepEqual(new DotRoomInputJournal(store, f.config).eventStatus("canary:" + uuid),
      { state: "received", operationId: null, messageId: null });
  } finally { store.close(); }
});

test("disconnect interrupts the capped wait without another page request", { timeout: 60_000 }, async () => {
  const f = await fixture(), initial = new BridgeStore(f.config.databasePath);
  new DotRoomInputJournal(initial, f.config).receive(canaryInput(f.config, uuid, canaryMarker(uuid) + "\nPRIVATE_CANCEL_FIXTURE"), 0);
  initial.close();
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeMessageDecoder();
  const methods: string[] = []; let now = 0, cancelled = false;
  output.on("data", bytes => {
    for (const raw of decoder.push(bytes)) {
      const request = parseDotControlRequest(raw); methods.push(request.method);
      input.write(encodeNativeMessage({ version: 1, requestId: request.requestId, scope: request.scope,
        kind: "status", state: "qualifying", reason: "anchors-not-visible" }));
    }
  });
  await runDotCanaryNativeHost(f.args, input, output, async () => async () => {}, {
    now: () => now, wait: async (milliseconds, signal) => {
      if (milliseconds < 10_000) { now += milliseconds; return; }
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true });
        input.end();
      });
    },
  });
  assert.equal(cancelled, true); assert.deepEqual(methods, Array<string>(4).fill("status"));
  const store = new BridgeStore(f.config.databasePath, { readOnly: true });
  try { assert.equal(new DotRoomInputJournal(store, f.config).eventStatus("canary:" + uuid)?.state, "received"); }
  finally { store.close(); }
});
test("invalid origin and production DB names refuse before acquiring runtime resources", async () => {
  const f = await fixture(); let acquired = 0;
  const acquire = async () => { acquired++; return async () => {}; };
  await assert.rejects(runDotCanaryNativeHost([...f.args.slice(0, -1), "chrome-extension://" + "c".repeat(32) + "/"], new PassThrough(), new PassThrough(), acquire));
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, databasePath: path.join(f.directory, "vkodex.sqlite") }));
  await assert.rejects(runDotCanaryNativeHost(f.args, new PassThrough(), new PassThrough(), acquire));
  assert.equal(acquired, 0);
});
test("singleton acquisition failure cannot create a journal or dispatch", async () => {
  const f = await fixture();
  await assert.rejects(runDotCanaryNativeHost(f.args, new PassThrough(), new PassThrough(), async () => { throw new Error("already owned"); }));
  assert.deepEqual(readdirSync(f.directory), ["config.json"]);
});

test("host reports only bounded private diagnostic failure and releases ownership before dispatch", async () => {
  const f = await fixture(); writeFileSync(path.join(f.directory, "diagnostics"), "PRIVATE_FAILURE_PAYLOAD");
  const input = new PassThrough(), output = new PassThrough(); let writes = 0, releases = 0;
  output.on("data", () => { writes++; });
  await assert.rejects(runDotCanaryNativeHost(f.args, input, output, async () => async () => { releases++; }),
    error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Private diagnostics unavailable: linked-leaf");
      assert.doesNotMatch(error.message, /PRIVATE_FAILURE_PAYLOAD|config.json|diagnostics[\\/]/u);
      return true;
    });
  assert.equal(releases, 1); assert.equal(writes, 0);
  assert.equal(readdirSync(f.directory).includes("dot-control-canary.sqlite"), false);
});
test("Windows OS singleton refuses a second host and releases without stale lock files", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture();
  const release = await acquireDotCanaryHostSingleton(f.config.databasePath);
  try { await assert.rejects(acquireDotCanaryHostSingleton(f.config.databasePath)); }
  finally { await release(); }
  const releaseAgain = await acquireDotCanaryHostSingleton(f.config.databasePath); await releaseAgain();
  assert.deepEqual(readdirSync(f.directory), ["config.json"]);
});
