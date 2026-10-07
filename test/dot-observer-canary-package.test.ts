import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script, createContext } from "node:vm";
import { createHash } from "node:crypto";

const execFile = promisify(execFileCallback);
const room = "a".repeat(32), mid = (n: string) => `${room}~${room}~CalpicoMessage~Sentinel_${n.repeat(32)}`;
const config = { pageUrl: "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", roomId: room,
  ownerAnchorId: mid("b"), dotAnchorId: mid("c"), operationId: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb",
  expectedText: "[VKODEX-FIXTURE-ONLY] Do not send this fixture." };
const builder = path.resolve("scripts/build-dot-observer-canary.mjs");
async function fixture(value: unknown = config) {
  const root = await mkdtemp(path.join(tmpdir(), "vkodex-observer-package-fixture-"));
  const configPath = path.join(root, "config.json"), output = path.join(root, "package");
  await writeFile(configPath, JSON.stringify(value));
  return { output, run: () => execFile(process.execPath, [builder, "--config", configPath, "--output", output], { windowsHide: true }) };
}

test("canary builder emits a pinned limited-permission package without installing it", async () => {
  const f = await fixture(), run = await f.run();
  const receipt = JSON.parse(run.stdout) as { installed: boolean; network: boolean; files: Record<string, { bytes: number; sha256: string }> };
  assert.equal(receipt.installed, false); assert.equal(receipt.network, false);
  for (const [name, metadata] of Object.entries(receipt.files)) {
    const bytes = await readFile(path.join(f.output, name));
    assert.equal(bytes.length, metadata.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.sha256);
  }
  const manifest = JSON.parse(await readFile(path.join(f.output, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage"]);
  assert.equal(manifest.host_permissions, undefined); assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  const bundle = await readFile(path.join(f.output, "observer.bundle.js"), "utf8");
  let listeners = 0;
  new Script(bundle).runInNewContext({ chrome: { runtime: { onMessage: { addListener: () => listeners++ } } } });
  assert.equal(listeners, 1);
  assert.doesNotMatch(bundle, /\bfetch\s*\(|XMLHttpRequest|\.click\s*\(|\.execCommand\s*\(|\.fill\s*\(/u);
  const original = await readFile(path.join(f.output, "package-receipt.json"), "utf8");
  await assert.rejects(f.run(), /EEXIST/u);
  assert.equal(await readFile(path.join(f.output, "package-receipt.json"), "utf8"), original);
});
test("configuration refuses extra fields, foreign anchors and unmarked payloads before output exists", async () => {
  for (const value of [{ ...config, token: "fixture-never-copy" }, { ...config, pageUrl: config.pageUrl + "?other=1" },
    { ...config, ownerAnchorId: mid("b").replaceAll(room, "d".repeat(32)) }, { ...config, dotAnchorId: config.ownerAnchorId },
    { ...config, expectedText: "ordinary prompt" }]) {
    const f = await fixture(value); await assert.rejects(f.run());
    await assert.rejects(readFile(path.join(f.output, "manifest.json")), { code: "ENOENT" });
  }
});

type State = { phase: string; [key: string]: unknown };
async function background() {
  let listener!: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean;
  let stored: State | undefined, injections = 0, messages = 0;
  const tab = { id: 7, url: config.pageUrl };
  const context = createContext({
    VKODEX_CANARY_CONFIG: config, importScripts: () => {},
    chrome: {
      runtime: { id: "fixture", getURL: (file: string) => `chrome-extension://fixture/${file}`,
        onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
      storage: { session: { get: async () => ({ canary: stored }), set: async (value: { canary: State }) => { stored = value.canary; } } },
      tabs: { query: async () => [tab], sendMessage: async () => { messages++; return { phase: "awaiting-pending" }; } },
      scripting: { executeScript: async () => { injections++; } },
    },
  });
  new Script(await readFile("extensions/dot-observer-canary/background.js", "utf8")).runInContext(context);
  const popup = { id: "fixture", url: "chrome-extension://fixture/popup.html" };
  const content = { id: "fixture", url: config.pageUrl, tab: { id: 7 }, frameId: 0 };
  const request = (message: unknown, sender: unknown = popup) => new Promise<{ ok: boolean; state: State }>(resolve => {
    listener(message, sender, value => resolve(value as { ok: boolean; state: State }));
  });
  return { tab, content, request, stored: () => stored, counts: () => ({ injections, messages }) };
}
test("only the popup can arm once on the exact selected tab", async () => {
  const h = await background();
  assert.equal((await h.request({ type: "arm" }, h.content)).ok, false);
  h.tab.url = "https://chatgpt.com/";
  assert.equal((await h.request({ type: "arm" })).ok, false); assert.equal(h.counts().injections, 0);
  h.tab.url = config.pageUrl;
  assert.equal((await h.request({ type: "arm" })).state.phase, "armed");
  assert.equal((await h.request({ type: "arm" })).ok, false);
  assert.deepEqual(h.counts(), { injections: 1, messages: 1 });
});
test("receipt needs the bound operation, tab, top frame and canonical room ID", async () => {
  const h = await background(); await h.request({ type: "arm" });
  const receipt = { type: "receipt", operationId: config.operationId, phase: "observed", messageId: mid("d") };
  for (const sender of [{ ...h.content, tab: { id: 8 } }, { ...h.content, frameId: 1 }, { ...h.content, url: "https://chatgpt.com/" }])
    assert.equal((await h.request(receipt, sender)).ok, false);
  assert.equal((await h.request({ ...receipt, operationId: "other" }, h.content)).ok, false);
  assert.equal((await h.request({ ...receipt, messageId: "other" }, h.content)).ok, false);
  assert.equal((await h.request(receipt, h.content)).state.phase, "observed");
  assert.equal((await h.request(receipt, h.content)).ok, false);
  assert.equal(h.stored()?.messageId, mid("d"));
});
test("stop retains uncertainty and does not offer an automatic rearm", async () => {
  const h = await background(); await h.request({ type: "arm" });
  assert.equal((await h.request({ type: "stop" })).state.phase, "uncertain");
  assert.equal((await h.request({ type: "arm" })).ok, false);
  assert.equal(h.counts().injections, 1);
});
