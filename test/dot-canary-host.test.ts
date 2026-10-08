import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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
function fixture() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "vkodex-host-test-"));
  const config: DotCanaryConfig = { version: 1, mode: "diagnostic-canary", databasePath: path.join(directory, "dot-control-canary.sqlite"),
    peerId: 2_000_000_032, ownerId: 42, roomId, generation: 1, pageUrl: "https://chatgpt.com/dots/" + uuid };
  const configFile = path.join(directory, "config.json"); writeFileSync(configFile, JSON.stringify(config));
  const args = ["--config", configFile, "--extension-id", extensionId, `chrome-extension://${extensionId}/`];
  return { directory, config, configFile, args };
}
test("host uses the common journal and bounded logs for one automatic canary", { timeout: 60_000 }, async () => {
  const f = fixture(), text = canaryMarker(uuid) + "\nPRIVATE_HOST_FIXTURE";
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
test("invalid origin and production DB names refuse before acquiring runtime resources", async () => {
  const f = fixture(); let acquired = 0;
  const acquire = async () => { acquired++; return async () => {}; };
  await assert.rejects(runDotCanaryNativeHost([...f.args.slice(0, -1), "chrome-extension://" + "c".repeat(32) + "/"], new PassThrough(), new PassThrough(), acquire));
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, databasePath: path.join(f.directory, "vkodex.sqlite") }));
  await assert.rejects(runDotCanaryNativeHost(f.args, new PassThrough(), new PassThrough(), acquire));
  assert.equal(acquired, 0);
});
test("singleton acquisition failure cannot create a journal or dispatch", async () => {
  const f = fixture();
  await assert.rejects(runDotCanaryNativeHost(f.args, new PassThrough(), new PassThrough(), async () => { throw new Error("already owned"); }));
  assert.deepEqual(readdirSync(f.directory), ["config.json"]);
});

test("host reports only bounded private diagnostic failure and releases ownership before dispatch", async () => {
  const f = fixture(); writeFileSync(path.join(f.directory, "diagnostics"), "PRIVATE_FAILURE_PAYLOAD");
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
  const f = fixture();
  const release = await acquireDotCanaryHostSingleton(f.config.databasePath);
  try { await assert.rejects(acquireDotCanaryHostSingleton(f.config.databasePath)); }
  finally { await release(); }
  const releaseAgain = await acquireDotCanaryHostSingleton(f.config.databasePath); await releaseAgain();
  assert.deepEqual(readdirSync(f.directory), ["config.json"]);
});
