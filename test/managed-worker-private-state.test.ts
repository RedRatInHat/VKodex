import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagedWorkerPrivateState, loadManagedWorkerPrivateState, type ManagedWorkerPrivateManifest, type ManagedWorkerPrivateStateFilesystem, type ManagedWorkerPrivateStateProtector, type ManagedWorkerPrivateStatePowerShellRunner } from "../src/desktop/managed-worker-private-state.js";
import { approveTaskPolicy } from "../src/codex/managed-task-policy.js";

const epoch = "11111111-1111-4111-8111-111111111111";
const fixturePath = (...parts: string[]): string => process.platform === "win32" ? path.win32.join("C:\\fixture", ...parts) : path.join("/fixture", ...parts);
const manifest = (): ManagedWorkerPrivateManifest => ({
  schemaVersion: 1, epoch, taskId: "task-1", familyRoot: "task-1", home: fixturePath("home"), cwd: fixturePath("workspace"),
  cliPath: fixturePath("bin", "codex"), cliSha256: "a".repeat(64),
  initializeRequest: { clientInfo: { name: "Codex", version: "1" }, capabilities: {} },
  resumeParams: { threadId: "task-1", settings: { model: "gpt-5.6-sol" } }, registryPath: fixturePath("private", "registry.sqlite"),
});

function currentUserDpapiUnavailablePhase(): "protect" | "unprotect" | null {
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) return "protect";
  const executable = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const invoke = (script: string, input: string) => spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    input, encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, PSModulePath: path.win32.join(path.dirname(executable), "Modules") },
  });
  const protect = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd().Trim();$data=[Convert]::FromBase64String($raw);$out=[Security.Cryptography.ProtectedData]::Protect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))";
  const unprotect = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd().Trim();$data=[Convert]::FromBase64String($raw);$out=[Security.Cryptography.ProtectedData]::Unprotect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))";
  const input = Buffer.alloc(2_048, 0x61).toString("base64");
  const protectedResult = invoke(protect, input);
  if (protectedResult.error || protectedResult.status !== 0 || !protectedResult.stdout.trim()) return "protect";
  const unprotectedResult = invoke(unprotect, protectedResult.stdout.trim());
  return unprotectedResult.error || unprotectedResult.status !== 0 || unprotectedResult.stdout.trim() !== input ? "unprotect" : null;
}

function productDpapiFailurePhase(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!(current instanceof Error)) break;
    const cause: unknown = current.cause;
    if (cause && typeof cause === "object" && "phase" in cause &&
      typeof cause.phase === "string" && /^(?:timeout|spawn-throw|process-error|output-limit|invalid-input|input-mismatch|command-mismatch|input-length|stdin-end|output-format|exit-(?:null|\d+)(?:-(?:empty|parser(?:-l\d{1,4}c\d{1,5})?|runtime|other))?|helper-exit-\d+)$/u.test(cause.phase))
      return cause.phase;
    current = cause;
  }
  return "unclassified";
}

class IdentityProtector implements ManagedWorkerPrivateStateProtector {
  async protect(value: Uint8Array): Promise<Uint8Array> { return Uint8Array.from(value); }
  async unprotect(value: Uint8Array): Promise<Uint8Array> { return Uint8Array.from(value); }
}
class MemoryFilesystem implements ManagedWorkerPrivateStateFilesystem {
  readonly actions: string[] = [];
  readonly values = new Map<string, Uint8Array>();
  async ensureProtectedDirectory(directory: string): Promise<void> { this.actions.push(`dir:${directory}`); }
  async writeExclusive(filePath: string, data: Uint8Array): Promise<void> {
    this.actions.push(`write:${filePath}`); if (this.values.has(filePath)) throw new Error("exists"); this.values.set(filePath, Uint8Array.from(data));
  }
  async readProtectedFile(filePath: string): Promise<Uint8Array> {
    this.actions.push(`read:${filePath}`); const value = this.values.get(filePath); if (!value) throw new Error("missing"); return Uint8Array.from(value);
  }
}

const options = (filesystem: MemoryFilesystem) => ({ baseDirectory: fixturePath("private", "managed"), protector: new IdentityProtector(), filesystem });

test("optional approved policy roundtrips immutably; unknown and mismatched policy fields fail closed", async () => {
  const filesystem = new MemoryFilesystem();
  const taskId = "01a0e498-4fa0-74c0-a795-c5047a06d21c";
  const base = { ...manifest(), taskId, familyRoot: taskId,
    resumeParams: { threadId: taskId, cwd: fixturePath("workspace"), model: "gpt-6-luna",
      permissions: ":danger-full-access", approvalPolicy: "never",
      runtimeWorkspaceRoots: [fixturePath("workspace")], config: { model_reasoning_effort: "high" } } };
  const policy = approveTaskPolicy({ threadId: taskId, model: "gpt-6-luna", modelProvider: "openai",
    effort: "high", cwd: base.cwd, runtimeWorkspaceRoots: [base.cwd], environments: [],
    approvalPolicy: "never", approvalsReviewer: "user",
    activePermissionProfile: { id: ":danger-full-access", extends: null },
    sandbox: { type: "dangerFullAccess" }, serviceTier: null });
  const created = await createManagedWorkerPrivateState({ ...base, approvedTaskPolicy: policy }, options(filesystem));
  assert.equal(Object.isFrozen(created.manifest.approvedTaskPolicy?.sandbox), true);
  const loaded = await loadManagedWorkerPrivateState({ ...options(filesystem), epoch });
  assert.deepEqual(loaded.manifest.approvedTaskPolicy, policy);
  const [filePath, encoded] = [...filesystem.values.entries()][0]!;
  const payload = JSON.parse(Buffer.from(encoded).toString("utf8")) as { manifest: Record<string, unknown> };
  payload.manifest.approvedTaskPolicy = { ...policy, model: "different" };
  filesystem.values.set(filePath, Buffer.from(JSON.stringify(payload)));
  await assert.rejects(loadManagedWorkerPrivateState({ ...options(filesystem), epoch }), /Invalid managed worker private state/u);
  payload.manifest.approvedTaskPolicy = policy;
  payload.manifest.unreviewed = true;
  filesystem.values.set(filePath, Buffer.from(JSON.stringify(payload)));
  await assert.rejects(loadManagedWorkerPrivateState({ ...options(filesystem), epoch }), /Invalid managed worker private state/u);
});

test("private state is scoped, immutable, and directory protection precedes exclusive write", async () => {
  const filesystem = new MemoryFilesystem();
  const created = await createManagedWorkerPrivateState(manifest(), options(filesystem));
  assert.equal(created.privateDirectory, path.join(fixturePath("private", "managed"), epoch));
  assert.equal(Object.isFrozen(created.manifest), true); assert.equal(Object.isFrozen(created.keys), true);
  assert.equal(Buffer.from(created.keys.controlToken, "base64").byteLength, 32);
  assert.equal(filesystem.actions.length, 2); assert.match(filesystem.actions[0]!, /^dir:/u); assert.match(filesystem.actions[1]!, /^write:/u);
  const loaded = await loadManagedWorkerPrivateState({ ...options(filesystem), epoch });
  assert.deepEqual(loaded.manifest, created.manifest); assert.deepEqual(loaded.keys, created.keys);
  await assert.rejects(createManagedWorkerPrivateState(manifest(), options(filesystem)), /exists/u);
});

test("strict JSON preserves an own __proto__ field through protected roundtrip", async () => {
  const filesystem = new MemoryFilesystem();
  const base = manifest();
  const input: ManagedWorkerPrivateManifest = { ...base,
    initializeRequest: JSON.parse('{"clientInfo":{"name":"Codex"},"capabilities":{},"__proto__":{"safe":true}}') as typeof base.initializeRequest };
  const created = await createManagedWorkerPrivateState(input, options(filesystem));
  const loaded = await loadManagedWorkerPrivateState({ ...options(filesystem), epoch });
  assert.equal(Object.hasOwn(created.manifest.initializeRequest, "__proto__"), true);
  assert.deepEqual(created.manifest.initializeRequest, loaded.manifest.initializeRequest);
  assert.deepEqual(created.manifest.initializeRequest.__proto__, { safe: true });
});

test("injectable PowerShell runner keeps DPAPI payloads in memory", { skip: process.platform !== "win32" }, async () => {
  const filesystem = new MemoryFilesystem(); let calls = 0;
  const runner: ManagedWorkerPrivateStatePowerShellRunner = { async run(script, input) {
    calls++; assert.match(script, /\$raw\.Length -ne \$expected/u); return Uint8Array.from(input);
  } };
  const created = await createManagedWorkerPrivateState(manifest(), { baseDirectory: fixturePath("private", "managed"), filesystem, powerShellRunner: runner });
  const loaded = await loadManagedWorkerPrivateState({ baseDirectory: fixturePath("private", "managed"), epoch, filesystem, powerShellRunner: runner });
  assert.equal(calls, 2); assert.deepEqual(loaded.keys, created.keys);
});

test("protector failure and malformed or oversized strict JSON never reach filesystem writes", async () => {
  const failureFilesystem = new MemoryFilesystem();
  const failingProtector: ManagedWorkerPrivateStateProtector = {
    async protect(): Promise<Uint8Array> { throw new Error("fixture-secret-must-not-escape"); },
    async unprotect(): Promise<Uint8Array> { throw new Error("fixture-secret-must-not-escape"); },
  };
  await assert.rejects(createManagedWorkerPrivateState(manifest(), { ...options(failureFilesystem), protector: failingProtector }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Managed worker private state protection failed");
    assert.deepEqual(error.cause, { phase: "unclassified" });
    return true;
  });
  assert.deepEqual(failureFilesystem.actions, []);

  const malformedOutputFilesystem = new MemoryFilesystem();
  const malformedOutputRunner: ManagedWorkerPrivateStatePowerShellRunner = { async run() { return Buffer.from("not base64!"); } };
  await assert.rejects(createManagedWorkerPrivateState(manifest(), { baseDirectory: fixturePath("private", "managed"), filesystem: malformedOutputFilesystem, powerShellRunner: malformedOutputRunner }), /protection failed/u);
  assert.deepEqual(malformedOutputFilesystem.actions, []);

  const malformedFilesystem = new MemoryFilesystem();
  const malformed = { ...manifest(), initializeRequest: new Date() as unknown as ManagedWorkerPrivateManifest["initializeRequest"] };
  await assert.rejects(createManagedWorkerPrivateState(malformed, options(malformedFilesystem)), /Invalid managed worker private state/u);
  assert.deepEqual(malformedFilesystem.actions, []);

  const oversizedFilesystem = new MemoryFilesystem();
  const oversized = { ...manifest(), initializeRequest: { clientInfo: { name: "Codex" }, capabilities: {}, padding: "x".repeat(70_000) } };
  await assert.rejects(createManagedWorkerPrivateState(oversized, options(oversizedFilesystem)), /Invalid managed worker private state/u);
  assert.deepEqual(oversizedFilesystem.actions, []);
});

test("private state rejects tampering, mismatched scope, and noncanonical secret encodings", async () => {
  const filesystem = new MemoryFilesystem();
  await createManagedWorkerPrivateState(manifest(), options(filesystem));
  const [filePath, encoded] = [...filesystem.values.entries()][0]!;
  const decoded = JSON.parse(Buffer.from(encoded).toString("utf8")) as { manifest: { epoch: string }; keys: { controlToken: string } };
  decoded.manifest.epoch = "22222222-2222-4222-8222-222222222222";
  filesystem.values.set(filePath, Buffer.from(JSON.stringify(decoded)));
  await assert.rejects(loadManagedWorkerPrivateState({ ...options(filesystem), epoch }), /Invalid managed worker private state/u);
  decoded.manifest.epoch = epoch; decoded.keys.controlToken = Buffer.alloc(32).toString("base64").replace(/=$/u, "");
  filesystem.values.set(filePath, Buffer.from(JSON.stringify(decoded)));
  await assert.rejects(loadManagedWorkerPrivateState({ ...options(filesystem), epoch }), /Invalid managed worker private state/u);
  await assert.rejects(loadManagedWorkerPrivateState({ ...options(filesystem), epoch: "33333333-3333-4333-8333-333333333333" }), /missing/u);
});

test("Windows DPAPI smoke keeps a random sentinel out of the persisted blob", { skip: process.platform !== "win32" }, async t => {
  const unavailablePhase = currentUserDpapiUnavailablePhase();
  if (unavailablePhase) { t.skip(`CurrentUser DPAPI ${unavailablePhase} is unavailable in this Windows execution context`); return; }
  const sentinel = randomUUID(); const input = { ...manifest(), taskId: sentinel, familyRoot: sentinel,
    resumeParams: { threadId: sentinel, settings: { model: "gpt-5.6-sol" } } };
  const root = process.env.SystemRoot!;
  const executable = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const syncProductRunner: ManagedWorkerPrivateStatePowerShellRunner = { async run(script, bytes) {
    const payload = Buffer.from(bytes);
    try {
      const command = `$expected=${payload.byteLength};${script}`;
      const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
        input: payload, windowsHide: true, timeout: 10_000,
        env: { ...process.env, PSModulePath: path.win32.join(path.dirname(executable), "Modules") },
      });
      if (result.error || result.status !== 0) assert.fail(`Product script sync preflight failed at exit-${result.status}`);
      return Uint8Array.from(result.stdout);
    } finally { payload.fill(0); bytes.fill(0); }
  } };
  await createManagedWorkerPrivateState(input, {
    baseDirectory: fixturePath("private", "sync-dpapi-preflight"),
    filesystem: new MemoryFilesystem(), powerShellRunner: syncProductRunner,
  });
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "vkodex-managed-private-state-"));
  let created;
  try { created = await createManagedWorkerPrivateState(input, { baseDirectory }); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "Managed worker private state protection failed") throw error;
    assert.fail(`Product DPAPI create failed at ${productDpapiFailurePhase(error)} after the fixed 2 KiB cross-process preflight`);
  }
  const statePath = path.join(created.privateDirectory, "state.v1.dpapi");
  const stored = await readFile(statePath);
  assert.equal(stored.includes(Buffer.from(sentinel, "utf8")), false);
  await assert.rejects(createManagedWorkerPrivateState(input, { baseDirectory }), /Managed worker private state/u);
  assert.deepEqual(await readFile(statePath), stored);
  let loaded;
  try { loaded = await loadManagedWorkerPrivateState({ baseDirectory, epoch }); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "Managed worker private state protection failed") throw error;
    assert.fail(`Product DPAPI load failed at ${productDpapiFailurePhase(error)} after the fixed 2 KiB cross-process preflight`);
  }
  assert.deepEqual(loaded.manifest, created.manifest); assert.deepEqual(loaded.keys, created.keys);
});

test("default filesystem refuses a reparse-like epoch directory before any state file write", { skip: process.platform !== "win32" }, async () => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "vkodex-managed-private-state-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "vkodex-managed-private-outside-"));
  await mkdir(baseDirectory, { recursive: true }); await symlink(outside, path.join(baseDirectory, epoch));
  await assert.rejects(createManagedWorkerPrivateState(manifest(), { baseDirectory }), /directory is unsafe/u);
});
