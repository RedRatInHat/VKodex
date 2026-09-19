import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { SourceTaskLauncher } from "../src/desktop/launcher.js";

class Spawned extends EventEmitter { unrefCalls = 0; unref(): void { this.unrefCalls++; } }

test("source launcher opens the selected VS Code profile without inheriting bridge secrets", async t => {
  const previous = process.env.VK_GROUP_TOKEN;
  process.env.VK_GROUP_TOKEN = "FIXTURE_VK_SECRET";
  t.after(() => { if (previous === undefined) delete process.env.VK_GROUP_TOKEN; else process.env.VK_GROUP_TOKEN = previous; });
  const home = path.resolve("fixture-codex-work"); const executable = process.execPath; const userDataDir = path.resolve("fixture-code-profile");
  let call: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv } | null = null;
  const child = new Spawned();
  const launcher = new SourceTaskLauncher([{ home, launcher: { type: "vscode", executable, userDataDir, arguments: ["--reuse-window"] } }], () => home,
    (file, args, options) => { call = { executable: file, args, env: options.env }; queueMicrotask(() => child.emit("spawn")); return child; });
  await launcher.open({ hostId: "local", threadId: "thread/with spaces", sourceId: "work" });
  assert.equal(call!.executable, executable);
  assert.deepEqual(call!.args, [`--user-data-dir=${userDataDir}`, "--reuse-window", "--open-url", "vscode://openai.chatgpt/local/thread%2Fwith%20spaces"]);
  assert.equal(call!.env.CODEX_HOME, home); assert.equal(child.unrefCalls, 1);
  assert.equal(call!.env.VK_GROUP_TOKEN, undefined);
});

test("custom launcher expands only documented placeholders and keeps the source environment", async () => {
  const home = path.resolve("fixture-custom-home"); const executable = process.execPath; const child = new Spawned();
  let args: readonly string[] = []; let env: NodeJS.ProcessEnv = {};
  const launcher = new SourceTaskLauncher([{ home, launcher: { type: "command", executable,
    arguments: ["--thread", "{threadId}", "--home", "{codexHome}"], environment: { VKODEX_TARGET_HOME: "{codexHome}", CODEX_CLI_PATH: path.resolve("fixture-owner-launcher.exe") } } }], () => home,
    (_file, actualArgs, options) => { args = actualArgs; env = options.env; queueMicrotask(() => child.emit("spawn")); return child; });
  await launcher.open({ hostId: "local", threadId: "fixture-thread" });
  assert.deepEqual(args, ["--thread", "fixture-thread", "--home", home]);
  assert.equal(env.CODEX_HOME, home); assert.equal(env.VKODEX_TARGET_HOME, home);
  assert.equal(env.CODEX_CLI_PATH, path.resolve("fixture-owner-launcher.exe"));
});

test("Windows Desktop opens the current AppX with its supported open-url contract", async () => {
  const home = path.resolve("fixture-desktop-home"); const executable = process.execPath; const child = new Spawned();
  let call: { executable: string; args: readonly string[] } | null = null;
  const launcher = new SourceTaskLauncher([{ home, launcher: { type: "desktop" } }], () => home,
    (file, args) => { call = { executable: file, args }; queueMicrotask(() => child.emit("spawn")); return child; }, async () => executable);
  await launcher.open({ hostId: "local", threadId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(call!.executable, executable);
  assert.deepEqual(call!.args, ["--open-url", "codex://threads/11111111-1111-4111-8111-111111111111"]);
});
