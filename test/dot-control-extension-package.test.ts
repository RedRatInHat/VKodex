import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
const execFile = promisify(execCallback);
const roomId = "a".repeat(32), id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const config = { pageUrl: "https://chatgpt.com/dots/" + id, roomId, generation: 1, nativeHost: "com.vkodex.dot_control", enabled: true,
  ownerAnchorId: `${roomId}~${roomId}~CalpicoMessage~Sentinel_${"b".repeat(32)}`,
  dotAnchorId: `${roomId}~${roomId}~CalpicoMessage~Sentinel_${"c".repeat(32)}` };
const base = { version: 1, requestId: id, scope: { roomId, generation: 1, epoch: id } };
const status = { ...base, method: "status" };
const root = await mkdtemp(path.join(tmpdir(), "vkodex-control-package-"));
const configFile = path.join(root, "config.json"), output = path.join(root, "package");
await writeFile(configFile, JSON.stringify(config));
const args = ["scripts/build-dot-control-extension.mjs", "--config", configFile, "--output", output];
await execFile(process.execPath, args);
const backgroundSource = await readFile(path.join(output, "background.bundle.js"), "utf8");

function background(options: { query?: () => Promise<unknown[]>; reply?: unknown } = {}) {
  let runtimeListener: any, connects = 0, injections = 0, alarms = 0, messages = 0;
  const ports: { listener: any; disconnectListener: any; sent: unknown[]; disconnects: number }[] = [];
  const chrome = {
    runtime: { id: "fixture", connectNative: () => {
      connects++;
      const record = { listener: null as any, disconnectListener: null as any, sent: [] as unknown[], disconnects: 0 }; ports.push(record);
      return { onMessage: { addListener: (fn: any) => { record.listener = fn; } },
        onDisconnect: { addListener: (fn: any) => { record.disconnectListener = fn; } },
        postMessage: (value: unknown) => record.sent.push(value), disconnect: () => { record.disconnects++; } };
    }, onMessage: { addListener: (fn: any) => { runtimeListener = fn; } },
    onStartup: { addListener: () => {} }, onInstalled: { addListener: () => {} } },
    alarms: { create: () => { alarms++; }, onAlarm: { addListener: () => {} } },
    tabs: { query: options.query ?? (async () => [{ id: 7, url: config.pageUrl }]),
      sendMessage: async (_id: number, message: any) => { messages++; return message.disconnect ? {} : options.reply ?? { ...base, kind: "status", state: "ready" }; } },
    scripting: { executeScript: async () => { injections++; } },
  };
  runInNewContext(backgroundSource, { chrome, console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder });
  const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
  return { ports, flush, send: (value: unknown) => ports[0]!.listener(value),
    message: (value: unknown, sender: unknown) => runtimeListener(value, sender, () => {}),
    counts: () => ({ connects, injections, alarms, messages }) };
}
test("build creates explicit scoped permissions and pinned bundles without installation", async () => {
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["nativeMessaging", "scripting", "alarms"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.equal(manifest.externally_connectable, undefined); assert.equal(manifest.web_accessible_resources, undefined);
  const receipt = JSON.parse(await readFile(path.join(output, "package-receipt.json"), "utf8"));
  assert.equal(receipt.installed, false);
  for (const [name, item] of Object.entries(receipt.files) as [string, { sha256: string; bytes: number }][]) {
    const bytes = await readFile(path.join(output, name));
    assert.equal(bytes.length, item.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  }
  await assert.rejects(execFile(process.execPath, args));
});
test("background qualifies only one exact target tab before relaying commands", async () => {
  const h = background(); h.send(status); await h.flush();
  assert.equal(h.counts().injections, 1); assert.equal(h.ports[0]!.sent.length, 1);
  assert.equal((h.ports[0]!.sent[0] as any).state, "ready");
});
test("missing or duplicate tabs cannot trigger injection", async () => {
  for (const tabs of [[], [{ id: 7, url: config.pageUrl }, { id: 8, url: config.pageUrl }]]) {
    const h = background({ query: async () => tabs }); h.send(status); await h.flush();
    assert.equal(h.counts().injections, 0); assert.equal((h.ports[0]!.sent[0] as any).reason, tabs.length ? "tab-ambiguous" : "tab-missing");
  }
});
test("commands racing during asynchronous tab lookup cannot create two writers", async () => {
  let resolve!: (tabs: unknown[]) => void;
  const h = background({ query: () => new Promise(done => { resolve = done; }) });
  h.send(status); h.send(status); resolve([{ id: 7, url: config.pageUrl }]); await h.flush();
  assert.equal(h.counts().injections, 0); assert.equal(h.ports[0]!.disconnects, 1);
  assert.equal(h.counts().alarms, 1);
});
test("first command must qualify status, and malformed messages close the port", async () => {
  const h = background(); h.send({ ...base, method: "observe-and-submit", operationId: id, text: "test" }); await h.flush();
  assert.equal(h.counts().injections, 0);
  h.send({ ...status, script: "PRIVATE" }); await h.flush(); assert.equal(h.ports[0]!.disconnects, 1);
});
test("configuration rejects unrelated hosts and unexpected credential fields", async () => {
  for (const patch of [{ nativeHost: "other.host" }, { token: "PRIVATE" }, { pageUrl: "https://example.com/" }]) {
    const bad = path.join(root, "bad.json"); await writeFile(bad, JSON.stringify({ ...config, ...patch }));
    await assert.rejects(execFile(process.execPath, [args[0]!, "--config", bad, "--output", path.join(root, "bad-output")]));
  }
});
