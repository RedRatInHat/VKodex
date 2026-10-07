import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { promises as fsPromises, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFile, spawn } from "node:child_process";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compatibleRuntime, launchArguments, windowsRuntimePath } from "../src/desktop/runtime.js";
import { boundedArtifactBytes, deploymentDataDirectory, deploymentValidationArguments, validateDeploymentArtifact } from "../src/desktop/deployment-artifact.js";
import { BOOTSTRAP_FILES, deploymentBindingArguments, planDeploymentAction, validateDeploymentBinding } from "../src/desktop/deployment-binding.js";
import { deploymentStartupEnvironment, executeDeployment } from "../src/desktop/deployment-execution.js";
import { loadPredecessorMaintenance, predecessorMaintenanceRestorationSummary, validatePredecessorMaintenance } from "../src/desktop/predecessor-maintenance.js";
import { BridgeStore } from "../src/bridge/store.js";
import { observeMaintenancePredecessorExits, predecessorExitObservationSummary, type PredecessorExitObservationRequest } from "../src/desktop/predecessor-exit-observation.js";
import { readWindowsProcessIdentityAsync } from "../src/desktop/windows-process-identity.js";
import { isCurrentWindowsProcessCaptureTicket, type SelectedProcessIdentity } from "../src/desktop/windows-process-exit-witness.js";
import { stopPinnedPredecessor, isVerifiedKnownPredecessorStop } from "../src/desktop/predecessor-cutover-controller.js";

test("Windows production launcher builder preserves VKodex name and embedded icon", { skip: process.platform !== "win32" }, async () => {
  // Keep native build evidence outside the checkout; never overwrite a live launcher.
  const root = await mkdtemp(path.join(tmpdir(), "vkodex-branding-"));
  const executable = path.join(root, "VKodexSupervisor.exe");
  const script = fileURLToPath(new URL("../scripts/build-windows-launcher.ps1", import.meta.url));
  const powershell = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = promisify(execFile);
  await run(powershell, ["-NoProfile", "-File", script, "-Destination", executable], { windowsHide: true, timeout: 60_000 });
  const result = await run(powershell, ["-NoProfile", "-Command", `$v=[Diagnostics.FileVersionInfo]::GetVersionInfo('${executable.replaceAll("'", "''")}'); @{description=$v.FileDescription;product=$v.ProductName} | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout), { description: "VKodex Bridge", product: "VKodex" });
  const bytes = await fsPromises.readFile(executable);
  const icon = await fsPromises.readFile(fileURLToPath(new URL("../docs/logo.ico", import.meta.url)));
  const count = icon.readUInt16LE(4);
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const payload = icon.subarray(icon.readUInt32LE(offset + 12), icon.readUInt32LE(offset + 12) + icon.readUInt32LE(offset + 8));
    assert.ok(bytes.includes(payload), `embedded VKodex icon image ${index} is present`);
  }
  await assert.rejects(run(powershell, ["-NoProfile", "-File", script, "-Destination", executable], { windowsHide: true, timeout: 10_000 }), "a running/versioned launcher must never be overwritten");
});

test("Windows runtime has a stable dedicated name outside the checkout and Node version directory", () => {
  assert.equal(windowsRuntimePath("C:\\Users\\fixture\\AppData\\Local"), "C:\\Users\\fixture\\AppData\\Local\\VKodex\\runtime\\VKodex.exe");
  assert.equal(windowsRuntimePath("D:\\Local Apps"), "D:\\Local Apps\\VKodex\\runtime\\VKodex.exe");
});

test("Windows runtime requires an absolute local application data path", () => {
  for (const value of [undefined, "", "relative", "C:relative", "\\Local Apps"]) assert.throws(() => windowsRuntimePath(value));
});

test("private runtime must match the architecture and native module ABI", () => {
  const expected = { arch: "x64", modules: "fixture-abi" };
  assert.equal(compatibleRuntime({ ...expected, node: "other-patch-version" }, expected), true);
  for (const identity of [null, "node", {}, { arch: "arm64", modules: "fixture-abi" }, { arch: "x64", modules: "other-abi" }]) {
    assert.equal(compatibleRuntime(identity, expected), false);
  }
});

test("desktop and VK checks use explicit entry points and load secrets only in the child", () => {
  assert.deepEqual(launchArguments("dev"), ["--env-file=.env", "--import", "tsx", "src/desktop-main.ts"]);
  assert.deepEqual(launchArguments("start"), ["--env-file=.env", "dist/src/desktop-main.js"]);
  assert.deepEqual(launchArguments("check"), ["--env-file=.env", "--import", "tsx", "src/platforms/vk/check.ts"]);
  assert.deepEqual(launchArguments("probe", ["fixture-task"]), ["--import", "tsx", "src/desktop/probe.ts", "fixture-task"]);
});

test("launcher does not accept substitute scripts or arbitrary Node options", () => {
  assert.throws(() => launchArguments("arbitrary-script"));
  assert.throws(() => launchArguments("dev", ["--inspect"]));
  assert.throws(() => launchArguments("probe", ["one", "two"]));
});

// Windows runners can expose TEMP through an 8.3 alias (RUNNER~1). Positive
// fixture descriptors need physical canonical paths; the product still refuses
// linked/aliased input. The cleanup boundary must use the same physical parent.
const artifactTemporaryParent = await realpath(tmpdir());
const artifactFixtures = await mkdtemp(path.join(artifactTemporaryParent, "vkodex-artifact-tests-"));
test("required predecessor snapshot covers idle, running and detached bindings and stays pinned across boots", async () => {
  const directory = path.join(artifactFixtures, `predecessor-${randomUUID()}`);
  await mkdir(directory);
  const store = new BridgeStore();
  try {
    for (const [threadId, status] of [["fixture-ms", "idle"], ["fixture-android", "running"], ["fixture-detached", "idle"]]) {
      const binding = store.ensureBinding({ hostId: "local", threadId: threadId!, sourceId: "work", title: "Fixture", workspace: directory, updatedAt: 1 });
      store.setValue(`task-details:${binding.id}`, { status });
      if (threadId !== "fixture-detached") store.setChat(binding.id, 10001 + store.bindings().length, 1);
    }
    const snapshot = { version: 1, fenceId: "fixture-pending-predecessor", createdAt: 1, dataDirectory: directory,
      recoveryPolicy: "reconcile-only", legacySourceIds: ["work"],
      bindings: store.bindings().map(binding => ({ bindingId: binding.id, hostId: binding.hostId, threadId: binding.threadId,
        sourceId: binding.sourceId ?? "", generation: store.streamGeneration(binding.id) })),
      processes: [{ role: "bridge", pid: 1234, birthTicks: "12345", imagePath: process.execPath },
        { role: "legacy-backend", pid: 1235, birthTicks: "12346", imagePath: process.execPath, sourceId: "work" }] };
    const bytes = JSON.stringify(snapshot);
    const pin = createHash("sha256").update(bytes).digest("hex");
    assert.equal(await loadPredecessorMaintenance(store, directory, ["work"]), undefined, "ordinary clean startup is unchanged");
    await assert.rejects(loadPredecessorMaintenance(store, directory, ["work"], pin), /snapshot refused/u);
    await writeFile(path.join(directory, "predecessor-maintenance.json"), bytes);
    await assert.rejects(loadPredecessorMaintenance(store, directory, ["work"]), /snapshot refused/u);
    for (const invalid of [
      { ...snapshot, version: 2 }, { ...snapshot, recoveryPolicy: "resume-interrupted" },
      { ...snapshot, extra: true }, { ...snapshot, legacySourceIds: ["other"] },
      { ...snapshot, bindings: snapshot.bindings.slice(0, 2) },
      { ...snapshot, bindings: snapshot.bindings.map(binding => ({ ...binding, generation: binding.generation + 1 })) },
      { ...snapshot, processes: snapshot.processes.slice(0, 1) },
      { ...snapshot, processes: [...snapshot.processes, snapshot.processes[0]] },
      { ...snapshot, processes: [...snapshot.processes, { role: ["restart-loop"], pid: 1236,
        birthTicks: "12347", imagePath: process.execPath }] },
      { ...snapshot, processes: [...snapshot.processes, { role: "unknown", pid: 1236,
        birthTicks: "12347", imagePath: process.execPath }] },
    ]) assert.throws(() => validatePredecessorMaintenance(invalid, store, directory, ["work"], pin), /snapshot refused/u);
    const admission = await loadPredecessorMaintenance(store, directory, ["work"], pin);
    assert.deepEqual(admission, { kind: "predecessor-maintenance", fenceId: snapshot.fenceId, snapshotSha256: pin });
    assert.deepEqual(await loadPredecessorMaintenance(store, directory, ["work"]), admission,
      "removing the environment pin cannot remove the durable fence");
    await assert.rejects(loadPredecessorMaintenance(store, directory, ["work"], "b".repeat(64)), /snapshot refused/u);
    store.setValue(`stream-generation:${snapshot.bindings[0]!.bindingId}`, 99);
    await assert.rejects(loadPredecessorMaintenance(store, directory, ["work"]), /snapshot refused/u);
    assert.deepEqual(store.getValue("startup-predecessor-fence"), admission, "failed validation never clears the gate");
  } finally { store.close(); }
});

test("first predecessor installation refuses passive binding drift without a physical store pin", async () => {
  const directory = path.join(artifactFixtures, `predecessor-first-pin-${randomUUID()}`);
  await mkdir(directory);
  const store = new BridgeStore(path.join(directory, "vkodex.sqlite"));
  try {
    const binding = store.ensureBinding({ hostId: "local", threadId: "fixture-first-pin", sourceId: "work",
      title: "Fixture", workspace: directory, updatedAt: 1 });
    store.setChat(binding.id, 12001, 1);
    const snapshot = { version: 1, fenceId: "fixture-first-install", createdAt: 1, dataDirectory: directory,
      recoveryPolicy: "reconcile-only", legacySourceIds: ["work"],
      bindings: store.bindings().map(row => ({ bindingId: row.id, hostId: row.hostId, threadId: row.threadId,
        sourceId: row.sourceId ?? "", generation: store.streamGeneration(row.id) })),
      processes: [{ role: "bridge", pid: 1234, birthTicks: "12345", imagePath: process.execPath },
        { role: "legacy-backend", pid: 1235, birthTicks: "12346", imagePath: process.execPath, sourceId: "work" }] };
    const bytes = JSON.stringify(snapshot);
    await writeFile(path.join(directory, "predecessor-maintenance.json"), bytes);
    store.stopStreaming(binding.id);
    await assert.rejects(loadPredecessorMaintenance(store, directory, ["work"], digest(bytes)), /snapshot refused/u);
    assert.equal(store.getValue("startup-predecessor-fence"), null);
    assert.equal(store.getValue("startup-predecessor-store-scope"), null);
  } finally { store.close(); }
});

after(async () => {
  if (process.platform !== "win32") return; // No permanent deletion when a Recycle Bin is unavailable.
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_TARGET); $root=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_PARENT).TrimEnd('\\')+'\\'; if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notlike 'vkodex-artifact-tests-*'){throw 'Unexpected recycle target'}; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)"],
  { windowsHide: true, env: { ...process.env, VKODEX_TEST_RECYCLE_TARGET: artifactFixtures, VKODEX_TEST_RECYCLE_PARENT: artifactTemporaryParent } });
});
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function artifactFixture(temporaryRoot = artifactFixtures) {
  const root = await mkdtemp(path.join(await realpath(temporaryRoot), "launch with spaces "));
  const artifactRoot = path.join(root, "versioned artifact");
  const configurationRoot = path.join(root, "original checkout");
  await mkdir(configurationRoot);
  await writeFile(path.join(configurationRoot, ".env"), "SECRET_FIXTURE_MUST_NOT_APPEAR=do-not-print\nBOT_DATA_DIR=custom/data\n");
  const nativePackage = `@openai/codex-${process.platform}-${process.arch}`;
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix = process.platform === "win32" ? "pc-windows-msvc" : process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const nativeRelative = `node_modules/${nativePackage}/vendor/${cpu}-${suffix}/codex/${process.platform === "win32" ? "codex.exe" : "codex"}`;
  const runtimeRelative = `runtime/${process.platform === "win32" ? "VKodex.exe" : "node"}`;
  const content: Record<string, string> = {
    "package.json": JSON.stringify({ name: "vkodex", type: "module", dependencies: { "@openai/codex-sdk": "0.155.1" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {
      "": { dependencies: { "@openai/codex-sdk": "0.155.1" } },
      "node_modules/@openai/codex-sdk": { version: "0.155.1" },
      "node_modules/@openai/codex": { version: "0.155.1" },
    } }),
    "dist/src/desktop-main.js": "throw new Error('Bridge must not run during validation');\n",
    "dist/src/codex/native-cli.js": "throw new Error('Native resolver must not execute');\n",
    "scripts/run-windows-supervisor.ps1": "throw 'Supervisor must not run'\n",
    "scripts/watch-windows-bridge.ps1": "throw 'Watchdog must not run'\n",
    "scripts/VKodexSupervisor.cs": "// Fixture only; no executable launcher\n",
    "docs/logo.ico": "fixture-icon",
    "node_modules/@openai/codex-sdk/package.json": JSON.stringify({ name: "@openai/codex-sdk", version: "0.155.1", exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } } }),
    "node_modules/@openai/codex-sdk/dist/index.js": "throw new Error('SDK package must not execute');\n",
    "node_modules/@openai/codex-sdk/dist/index.d.ts": "// Fixture types only\n",
    "node_modules/@openai/codex/package.json": JSON.stringify({ name: "@openai/codex", version: "0.155.1" }),
    [`node_modules/${nativePackage}/package.json`]: JSON.stringify({ name: "@openai/codex", version: `0.155.1-${process.platform}-${process.arch}` }),
    [nativeRelative]: "not-an-executable-native-fixture",
    [runtimeRelative]: "not-an-executable-runtime-fixture",
  };
  for (const [relative, text] of Object.entries(content)) {
    const file = path.join(artifactRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  const files = Object.fromEntries(Object.entries(content).map(([relative, text]) => [relative, { size: Buffer.byteLength(text), sha256: digest(text) }]));
  const manifest = { version: 1, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
    node: { version: process.version, platform: process.platform, arch: process.arch, modules: process.versions.modules },
    sdkVersion: "0.155.1", files };
  const descriptor = { version: 1, artifactRoot, configurationRoot,
    dataDirectory: path.join(configurationRoot, "custom", "data"), manifestSha256: "" };
  const descriptorPath = path.join(root, "deployment.json");
  const repin = async () => {
    const manifestText = JSON.stringify(manifest);
    await writeFile(path.join(artifactRoot, "artifact-manifest.json"), manifestText);
    descriptor.manifestSha256 = digest(manifestText);
    const descriptorText = JSON.stringify(descriptor);
    await writeFile(descriptorPath, descriptorText);
    return digest(descriptorText);
  };
  const expectedSha256 = await repin();
  return { artifactRoot, configurationRoot, nativeRelative, runtimeRelative, manifest, descriptor, descriptorPath, expectedSha256, repin };
}

test("offline artifact plan separates exact code/dependencies from original config and data without launching them", async () => {
  const fixture = await artifactFixture();
  const before = await readFile(path.join(fixture.configurationRoot, ".env"));
  const plan = await validateDeploymentArtifact(fixture.descriptorPath, fixture.expectedSha256);
  assert.equal(plan.executable, path.join(fixture.artifactRoot, fixture.runtimeRelative));
  assert.equal(plan.entryPoint, path.join(fixture.artifactRoot, "dist/src/desktop-main.js"));
  assert.equal(plan.cwd, fixture.configurationRoot);
  assert.equal(plan.environmentFile, path.join(fixture.configurationRoot, ".env"));
  assert.deepEqual(plan.arguments, [`--env-file=${plan.environmentFile}`, plan.entryPoint]);
  assert.deepEqual(plan.environmentOverrides, { BOT_DATA_DIR: fixture.descriptor.dataDirectory, NODE_OPTIONS: "", NODE_PATH: "" });
  assert.equal(plan.dataDirectory, fixture.descriptor.dataDirectory);
  assert.equal(plan.nativeCodexPath, path.join(fixture.artifactRoot, fixture.nativeRelative));
  assert.equal(plan.descriptorSha256, fixture.expectedSha256);
  assert.equal(plan.manifestSha256, fixture.descriptor.manifestSha256);
  assert.equal(plan.sourceCommit, fixture.manifest.sourceCommit);
  assert.equal(plan.sourceTree, fixture.manifest.sourceTree);
  assert.deepEqual(await readFile(plan.environmentFile), before);
  assert.deepEqual((await readdir(fixture.configurationRoot)).sort(), [".env"]);
  assert.doesNotMatch(JSON.stringify(plan), /do-not-print|SECRET_FIXTURE/u);
});

test("data-directory selection resolves relative values against original configuration, not artifact cwd", () => {
  const root = path.resolve(artifactFixtures, "original config");
  assert.equal(deploymentDataDirectory(root), path.join(root, "data", "desktop"));
  assert.equal(deploymentDataDirectory(root, "custom/data"), path.join(root, "custom", "data"));
  const absolute = path.resolve(artifactFixtures, "separate data");
  assert.equal(deploymentDataDirectory(root, absolute), absolute);
});

test("offline validator requires an independent descriptor hash and rejects extra launch arguments", () => {
  const file = path.join(artifactFixtures, "descriptor with spaces.json");
  assert.deepEqual(deploymentValidationArguments(["--descriptor", file, "--sha256", "a".repeat(64)]), { descriptorPath: file, expectedSha256: "a".repeat(64) });
  for (const args of [[], ["--descriptor", file], ["--descriptor", file, "--sha256", "bad"],
    ["--descriptor", file, "--sha256", "a".repeat(64), "--inspect"], [file, "a".repeat(64)]]) {
    assert.throws(() => deploymentValidationArguments(args));
  }
});

test("descriptor and manifest bytes must match their independent pins", async () => {
  const fixture = await artifactFixture();
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, "0".repeat(64)));
  await writeFile(path.join(fixture.artifactRoot, "artifact-manifest.json"), "{}\n");
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, fixture.expectedSha256));
});

test("descriptor rejects script/options substitution, relative/ambiguous paths and code/data overlap", async () => {
  for (const override of [
    { entryPoint: "other.js" }, { nodeOptions: "--inspect" }, { version: 2 }, { dataDirectory: "relative/data" },
    { artifactRoot: path.join(artifactFixtures, "missing") }, { configurationRoot: 'bad"path' },
    { dataDirectory: `${artifactFixtures}${path.sep}child${path.sep}..${path.sep}data` },
  ]) {
    const fixture = await artifactFixture();
    Object.assign(fixture.descriptor, override);
    await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()), JSON.stringify(override));
  }
  const fixture = await artifactFixture();
  fixture.descriptor.dataDirectory = path.join(fixture.artifactRoot, "data");
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()));
  fixture.descriptor.dataDirectory = path.join(fixture.configurationRoot, "data");
  fixture.descriptor.configurationRoot = fixture.artifactRoot;
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()));
});

test("complete inventory rejects tampered and unlisted artifact files", async () => {
  const fixture = await artifactFixture();
  await writeFile(path.join(fixture.artifactRoot, "dist/src/desktop-main.js"), "tampered");
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, fixture.expectedSha256));
  const unlisted = await artifactFixture();
  await writeFile(path.join(unlisted.artifactRoot, "node_modules/unlisted.js"), "not listed");
  await assert.rejects(validateDeploymentArtifact(unlisted.descriptorPath, unlisted.expectedSha256));
});

test("manifest rejects path escapes, duplicate case, secret/data scopes and unrecognized metadata", async () => {
  for (const relative of ["../outside", "dist/../secret", "dist\\src\\desktop-main.js", "/absolute", "node_modules/x:stream", ".env", "data/vkodex.sqlite", "Dist/src/desktop-main.js"]) {
    const fixture = await artifactFixture();
    fixture.manifest.files[relative] = { size: 0, sha256: digest("") };
    await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()), relative);
  }
  const fixture = await artifactFixture();
  Object.assign(fixture.manifest, { entryPoint: "substitute.js" });
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()));
});

test("own dependency resolution cannot fall through to original or parent SDK", async () => {
  const fixture = await artifactFixture();
  const originalPackage = path.join(fixture.configurationRoot, "node_modules/@openai/codex/package.json");
  await mkdir(path.dirname(originalPackage), { recursive: true });
  await writeFile(originalPackage, JSON.stringify({ name: "@openai/codex", version: "0.160.0" }));
  assert.equal((await validateDeploymentArtifact(fixture.descriptorPath, fixture.expectedSha256)).nativeCodexPath,
    path.join(fixture.artifactRoot, fixture.nativeRelative));
  fixture.manifest.sdkVersion = "0.160.0";
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()));
});

test("linked dependency directory is refused even with a matching inventory", async () => {
  const fixture = await artifactFixture();
  const outside = path.join(fixture.configurationRoot, "foreign-dependency");
  await mkdir(outside);
  await writeFile(path.join(outside, "module.js"), "matching bytes");
  const relative = "node_modules/linked/module.js";
  fixture.manifest.files[relative] = { size: Buffer.byteLength("matching bytes"), sha256: digest("matching bytes") };
  await symlink(outside, path.join(fixture.artifactRoot, "node_modules/linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()));
});

test("runtime ABI and SDK/lock metadata are part of artifact qualification", async () => {
  const abi = await artifactFixture();
  abi.manifest.node.modules = "other-abi";
  await assert.rejects(validateDeploymentArtifact(abi.descriptorPath, await abi.repin()));
  const sdk = await artifactFixture();
  const relative = "node_modules/@openai/codex-sdk/package.json";
  const changed = JSON.stringify({ name: "@openai/codex-sdk", version: "0.160.0" });
  await writeFile(path.join(sdk.artifactRoot, relative), changed);
  sdk.manifest.files[relative] = { size: Buffer.byteLength(changed), sha256: digest(changed) };
  await assert.rejects(validateDeploymentArtifact(sdk.descriptorPath, await sdk.repin()));
});

test("duplicate JSON keys, invalid UTF-8 and metadata limits cannot be hidden by a matching hash", async () => {
  const fixture = await artifactFixture();
  for (const bytes of [Buffer.from(`{"version":0,${JSON.stringify(fixture.descriptor).slice(1)}`),
    Buffer.concat([Buffer.from('{"secret":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    Buffer.from(" ".repeat(32 * 1024 + 1))]) {
    await writeFile(fixture.descriptorPath, bytes);
    await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, digest(bytes)));
  }
  const partial = await artifactFixture();
  delete partial.manifest.files[partial.runtimeRelative];
  await assert.rejects(validateDeploymentArtifact(partial.descriptorPath, await partial.repin()));
});

test("artifact plan is immutable and blank poison variables override --env-file in a trusted Node fixture", async () => {
  const fixture = await artifactFixture();
  await writeFile(path.join(fixture.configurationRoot, ".env"), "BOT_DATA_DIR=wrong/relative\nNODE_OPTIONS=--definitely-invalid-fixture-option\nNODE_PATH=wrong-parent-modules\n");
  const plan = await validateDeploymentArtifact(fixture.descriptorPath, fixture.expectedSha256);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.arguments), true);
  assert.equal(Object.isFrozen(plan.environmentOverrides), true);
  // This executes the trusted test runtime only, not the artifact's fake binary
  // or any bridge/script/package code. C#/PowerShell transport remains untested.
  const { stdout } = await promisify(execFile)(process.execPath, [`--env-file=${plan.environmentFile}`, "-p",
    "JSON.stringify({BOT_DATA_DIR:process.env.BOT_DATA_DIR,NODE_OPTIONS:process.env.NODE_OPTIONS,NODE_PATH:process.env.NODE_PATH})"],
  { cwd: plan.cwd, windowsHide: true, env: { ...process.env, ...plan.environmentOverrides } });
  assert.deepEqual(JSON.parse(stdout), plan.environmentOverrides);
});

test("offline CLI validates from original cwd but never executes artifact code or emits configuration/path contents", async () => {
  const fixture = await artifactFixture();
  const validator = fileURLToPath(new URL("../src/desktop/deployment-artifact-check.ts", import.meta.url));
  const run = (args: string[]) => promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), validator, ...args], {
    cwd: fixture.configurationRoot, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  const result = await run(["--descriptor", fixture.descriptorPath, "--sha256", fixture.expectedSha256]);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { status: "validated_not_launched", descriptorSha256: fixture.expectedSha256,
    manifestSha256: fixture.descriptor.manifestSha256, sourceCommit: fixture.manifest.sourceCommit, sourceTree: fixture.manifest.sourceTree });
  assert.doesNotMatch(result.stdout, /do-not-print|SECRET_FIXTURE|original checkout|versioned artifact/u);
  await assert.rejects(run(["--descriptor", fixture.descriptorPath, "--sha256", "0".repeat(64)]), (error: unknown) => {
    const result = error as { stdout: string; stderr: string; code: number };
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "Artifact validation refused: metadata hash mismatch.");
    return true;
  });
  assert.deepEqual((await readdir(fixture.configurationRoot)).sort(), [".env"]);
});

test("inventory-listed SDK shadow packages cannot change resolution for desktop or agent importers", async () => {
  for (const prefix of ["dist/src", "dist/src/desktop", "dist/src/agents/codex"]) {
    const fixture = await artifactFixture();
    const relative = `${prefix}/node_modules/@openai/codex-sdk/package.json`;
    const text = JSON.stringify({ name: "@openai/codex-sdk", version: "0.160.0", exports: { ".": "./index.js" } });
    const file = path.join(fixture.artifactRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    fixture.manifest.files[relative] = { size: Buffer.byteLength(text), sha256: digest(text) };
    await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()), prefix);
  }
});

test("SDK ESM import mapping cannot redirect a correctly versioned package", async () => {
  const fixture = await artifactFixture();
  const relative = "node_modules/@openai/codex-sdk/package.json";
  const text = JSON.stringify({ name: "@openai/codex-sdk", version: "0.155.1", exports: { ".": { node: "../../foreign.js", import: "./dist/index.js" } } });
  await writeFile(path.join(fixture.artifactRoot, relative), text);
  fixture.manifest.files[relative] = { size: Buffer.byteLength(text), sha256: digest(text) };
  await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()));
});

test("bounded metadata and file streams stop growing input instead of reading it to EOF", async () => {
  let consumed = 0;
  let closed = false;
  const source = async function* () {
    try { for (let index = 0; index < 100; index += 1) { consumed += 1; yield Buffer.alloc(4); } }
    finally { closed = true; }
  };
  await assert.rejects(async () => { for await (const chunk of boundedArtifactBytes(source(), 4)) assert.equal(chunk.length, 4); });
  assert.equal(consumed, 2);
  assert.equal(closed, true);
});

test("Windows case variants cannot bypass application SDK shadow rejection", async () => {
  for (const folder of ["NODE_MODULES", "Node_Modules"]) {
    const fixture = await artifactFixture();
    const relative = `dist/src/desktop/${folder}/@openai/codex-sdk/package.json`;
    const text = JSON.stringify({ name: "@openai/codex-sdk", version: "0.160.0", exports: { ".": "./index.js" } });
    const file = path.join(fixture.artifactRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    fixture.manifest.files[relative] = { size: Buffer.byteLength(text), sha256: digest(text) };
    await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()), folder);
  }
});

test("SDK metadata that otherwise qualifies still rejects duplicate keys and malformed UTF-8 in ignored fields", async () => {
  for (const defect of ["duplicate", "invalid-utf8"]) {
    const fixture = await artifactFixture();
    const relative = "node_modules/@openai/codex-sdk/package.json";
    const original = await readFile(path.join(fixture.artifactRoot, relative), "utf8");
    const prefix = Buffer.from(`${original.slice(0, -1)},"description":"`);
    const bytes = defect === "duplicate" ? Buffer.from(`${original.slice(0, -1)},"description":"first","description":"second"}`) :
      Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}')]);
    await writeFile(path.join(fixture.artifactRoot, relative), bytes);
    fixture.manifest.files[relative] = { size: bytes.length, sha256: digest(bytes) };
    await assert.rejects(validateDeploymentArtifact(fixture.descriptorPath, await fixture.repin()), defect);
  }
});

test("positive fixtures canonicalize aliased temporary roots while production still refuses aliases", async () => {
  const target = path.join(artifactFixtures, "physical temporary target");
  const alias = path.join(artifactFixtures, "temporary root alias");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  const fixture = await artifactFixture(alias);
  const plan = await validateDeploymentArtifact(fixture.descriptorPath, fixture.expectedSha256);
  assert.equal(plan.cwd.startsWith(target + path.sep), true);
  const aliasedDescriptor = fixture.descriptorPath.replace(target, alias);
  await assert.rejects(validateDeploymentArtifact(aliasedDescriptor, fixture.expectedSha256), /linked or aliased/u);
});

async function bindingFixture() {
  const artifact = await artifactFixture();
  const root = path.dirname(artifact.descriptorPath);
  const bootstrapRoot = path.join(root, "trusted bootstrap");
  const stableRuntimePath = path.join(root, "stable runtime", process.platform === "win32" ? "VKodex.exe" : "node");
  await mkdir(path.dirname(stableRuntimePath));
  await writeFile(stableRuntimePath, await readFile(path.join(artifact.artifactRoot, artifact.runtimeRelative)));
  const files: Record<string, { size: number; sha256: string }> = {};
  for (const relative of BOOTSTRAP_FILES) {
    const bytes = relative === "package.json" ? JSON.stringify({ type: "module" }) : `not-executable-bootstrap-fixture:${relative}`;
    const file = path.join(bootstrapRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    files[relative] = { size: Buffer.byteLength(bytes), sha256: digest(bytes) };
  }
  const manifest = { version: 1, protocol: "deployment-plan-v1", files };
  const binding = { version: 1, descriptorPath: artifact.descriptorPath, descriptorSha256: artifact.expectedSha256,
    bootstrapRoot, bootstrapManifestSha256: "", stableRuntimePath, stableRuntimeSha256: digest(await readFile(stableRuntimePath)) };
  const bindingPath = path.join(root, "launch binding.json");
  const repin = async () => {
    const text = JSON.stringify(manifest);
    await writeFile(path.join(bootstrapRoot, "bootstrap-manifest.json"), text);
    binding.bootstrapManifestSha256 = digest(text);
    const bindingText = JSON.stringify(binding);
    await writeFile(bindingPath, bindingText);
    return digest(bindingText);
  };
  return { ...artifact, bootstrapRoot, stableRuntimePath, bindingPath, binding, manifest, repinBinding: repin, bindingSha256: await repin() };
}

async function predecessorObservationFixture(selected: readonly SelectedProcessIdentity[], reorderedBindings = false, sourceId = 'fixture-source') {
  const fixture = await bindingFixture();
  const directory = fixture.descriptor.dataDirectory;
  await mkdir(directory, { recursive: true });
  const store = new BridgeStore(path.join(directory, 'vkodex.sqlite'));
  const shapes = [{ threadId: '01a07930-dbba-77c2-8910-17bd61638e6f', status: 'idle', count: 1 },
    { threadId: '01a06325-d3d0-7052-b495-371fcb7a2887', status: 'running', count: 2 }];
  for (const shape of shapes) {
    const binding = store.ensureBinding({ hostId: 'local', sourceId, threadId: shape.threadId,
      title: 'Synthetic Publishing shape', workspace: directory, updatedAt: 1 });
    store.setValue(`task-details:${binding.id}`, { status: shape.status });
    store.setValue(`execution-lifecycle:${binding.id}`, { state: 'blocked', generation: 17 });
    for (let index = 0; index < shape.count; index++) {
      const operationId = `${shape.threadId}-original-${index}`;
      store.recordOperation(operationId, binding, `${operationId}-inbox`, binding.id, 1);
      store.finishOperation(operationId, 'accepted');
      store.rememberQueuedInput(binding.id, operationId, `${operationId}-queue`, 1);
      store.rememberAcceptedTurn(binding.id, `${operationId}-turn`, operationId);
    }
  }
  const savedInput = { peerId: 23456, senderId: 12345, eventId: 'original-unknown-input', text: 'Synthetic publishing input' };
  store.receiveInput(savedInput, 1);
  const originalInputId = JSON.stringify([savedInput.peerId, savedInput.eventId]);
  assert.equal(store.claimInput(originalInputId), true);
  store.markInputPreparing([originalInputId]);
  store.markInputSending([originalInputId]);
  store.finishInput(originalInputId, true);
  store.saveInputBatch({ id: 'original-batch', peerId: savedInput.peerId, parts: [savedInput], state: 'collecting', startedAt: 1, updatedAt: 1 });
  const snapshot = { version: 1, fenceId: 'fixture-selected-predecessor', createdAt: 1, dataDirectory: directory,
    recoveryPolicy: 'reconcile-only', legacySourceIds: [sourceId],
    bindings: store.bindings().map(binding => reorderedBindings
      ? { generation: store.streamGeneration(binding.id), threadId: binding.threadId, sourceId: binding.sourceId ?? '', hostId: binding.hostId, bindingId: binding.id }
      : { bindingId: binding.id, hostId: binding.hostId, threadId: binding.threadId, sourceId: binding.sourceId ?? '', generation: store.streamGeneration(binding.id) }),
    processes: selected.map((identity, index) => ({ role: index === 0 ? 'bridge' : 'legacy-backend', pid: identity.pid,
      birthTicks: identity.birthTicks, imagePath: identity.imagePath, ...(index === 0 ? {} : { sourceId }) })) };
  const bytes = JSON.stringify(snapshot);
  await writeFile(path.join(directory, 'predecessor-maintenance.json'), bytes);
  const request: PredecessorExitObservationRequest = { dataDirectory: directory, legacySourceIds: [sourceId],
    snapshotSha256: digest(bytes), selected, launchBindingPath: fixture.bindingPath, launchBindingSha256: fixture.bindingSha256,
    configurationSha256: digest(await readFile(path.join(fixture.configurationRoot, '.env'))), deadlineMs: 40_000 };
  const admission = await loadPredecessorMaintenance(store, directory, request.legacySourceIds, request.snapshotSha256);
  assert.ok(admission);
  const debt = () => ({ gate: store.getValue('startup-predecessor-fence'), batches: store.inputBatches(),
    input: store.inputState(JSON.stringify([savedInput.peerId, savedInput.eventId])),
    bindings: store.bindings().map(binding => ({ id: binding.id, queue: store.queuedInputs(binding.id), turns: store.acceptedTurns(binding.id),
      lifecycle: store.getValue(`execution-lifecycle:${binding.id}`), managed: store.managedOwner(binding) })) });
  return { fixture, store, request, admission, debt };
}

test('concrete cutover protocol unit boundary durably grants before actions, preserves both Publishing debts, and never replays an unknown step',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
    // Mocked Windows boundary only. The SQLite snapshots/debts here are real;
    // no Task COM setter, OS signal, original chat or native backend is invoked.
    const imagePath = await realpath(process.execPath); const imageSha256 = digest(await readFile(imagePath));
    const identities = Array.from({ length: 5 }, (_, index) => ({ pid: 991110 + index,
      birthTicks: String(639100000000000000n + BigInt(index)), imagePath, imageSha256 }));
    const originalSpawn = childProcess.spawn;
    let mode: 'complete' | 'legacy-default-source' | 'lost-first-ack' | 'changed-config' | 'caller-pin-mutated' | 'malformed-snapshot' = 'complete';
    let spawns = 0; let journal = ''; let configurationFile = '';
    childProcess.spawn = ((_: string, __: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawns++;
      const bytes = Buffer.from(options.env!.VKODEX_CUTOVER_SCOPE!, 'base64');
      const scope = JSON.parse(bytes.toString()) as { challenge: string; mode: string; processes: {
        pid: number; birthTicks: string; role: string }[] };
      assert.equal(scope.mode, 'stop');
      const scopeSha256 = digest(bytes);
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null, killed: false, pid: 991999 });
      const end = (code: number) => {
        if (child.exitCode !== null) return;
        stdout.end(); stderr.end(); Object.assign(child, { exitCode: code });
        child.emit('exit', code, null); child.emit('close', code, null);
      };
      child.kill = (() => { end(87); return true; }) as typeof child.kill;
      const send = (row: Record<string, unknown>) => stdout.write(JSON.stringify({ ...row, challenge: scope.challenge, scopeSha256 }) + '\n');
      const roles = ['supervisor', 'watchdog', 'wrapper', 'bridge', 'backend'];
      const ordered = roles.flatMap(role => scope.processes.filter(p => p.role === role));
      let sequence = 0;
      stdin.on('data', (chunk: Buffer) => {
        const action = sequence === 0 ? 'disable-task' : sequence <= ordered.length ? `stop-${ordered[sequence - 1]!.pid}` : 'final-check';
        assert.equal(chunk.toString(), `${scope.challenge}:${sequence}:${action}\n`);
        const grant = JSON.parse(readFileSync(path.join(journal, `${String(sequence).padStart(3, '0')}-grant.json`), 'utf8'));
        assert.equal(grant.action, action); assert.equal(grant.outcome, 'unknown-until-ack', 'grant is fsynced before the helper receives it');
        if (mode === 'lost-first-ack') { setImmediate(() => end(87)); return; }
        if (action === 'final-check') {
          assert.equal(JSON.parse(readFileSync(path.join(journal, 'committed-snapshot.json'), 'utf8')).kind, 'committed-predecessor-snapshot');
          send({ kind: 'verified', sequence }); setImmediate(() => end(0)); return;
        }
        const p = ordered[sequence - 1];
        send({ kind: 'step', sequence, action, ...(p ? { pid: p.pid, birthTicks: p.birthTicks, exitTicks: String(BigInt(p.birthTicks) + 1000n) } : {}) });
        sequence++;
        if (sequence === ordered.length + 1) send({ kind: 'stopped', sequence });
      });
      setImmediate(() => {
        if (mode === 'changed-config') writeFileSync(configurationFile, 'fixture-mutated-after-capture=1');
        send({ kind: 'ready', processCount: scope.processes.length });
      });
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    try {
      for (const requestedMode of ['malformed-snapshot', 'complete', 'legacy-default-source', 'caller-pin-mutated', 'changed-config', 'lost-first-ack'] as const) {
        mode = requestedMode;
        const s = await predecessorObservationFixture(identities, false, mode === 'legacy-default-source' ? '' : 'fixture-source');
        try {
          const before = s.debt();
          const root = path.dirname(s.fixture.descriptorPath); const privateJournalDirectory = path.join(root, 'private cutover journal');
          configurationFile = path.join(s.fixture.configurationRoot, '.env');
          await mkdir(privateJournalDirectory);
          const actionProcesses = [{ ...identities[0]!, role: 'bridge', parentPid: identities[3]!.pid },
            { ...identities[1]!, role: 'backend', parentPid: identities[0]!.pid },
            { ...identities[2]!, role: 'wrapper', parentPid: 4567 },
            { ...identities[3]!, role: 'supervisor', parentPid: identities[2]!.pid },
            { ...identities[4]!, role: 'watchdog', parentPid: identities[3]!.pid }];
          const operationId = randomUUID(); journal = path.join(privateJournalDirectory, operationId);
          const snapshotFile = path.join(s.request.dataDirectory, 'predecessor-maintenance.json');
          const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
          snapshot.processes = actionProcesses.map(p => ({ role: p.role === 'bridge' ? 'bridge' : p.role === 'backend' ? 'legacy-backend' : 'restart-loop',
            pid: p.pid, birthTicks: p.birthTicks, imagePath: p.imagePath, ...(p.role === 'backend' ? { sourceId: s.request.legacySourceIds[0] } : {}) }));
          if (mode === 'malformed-snapshot') snapshot.bindings = null;
          const snapshotText = JSON.stringify(snapshot); await writeFile(snapshotFile, snapshotText);
          const request = { version: 1, operationId, dataDirectory: s.request.dataDirectory,
            legacyRoot: s.fixture.configurationRoot, privateJournalDirectory, expectedFileIdentity: s.store.databaseFileIdentity,
            legacySourceIds: s.request.legacySourceIds, snapshotSha256: digest(snapshotText),
            launchBindingPath: s.request.launchBindingPath, launchBindingSha256: s.request.launchBindingSha256,
            configurationSha256: s.request.configurationSha256, deadlineMs: 10_000,
            task: { path: '\\Synthetic-VKodex-Controller', definitionSha256: 'b'.repeat(64),
              instances: [{ instanceGuid: '{00000000-0000-0000-0000-000000000001}', enginePid: identities[2]!.pid }] }, processes: actionProcesses };
          const requestPath = path.join(root, 'cutover request.json'); const requestText = JSON.stringify(request); await writeFile(requestPath, requestText);
          const invocation = { requestPath, requestSha256: digest(requestText), operatorApproval: 'stop-selected-legacy-runtime-no-replay' };
          if (mode === 'malformed-snapshot') {
            const count = spawns; await assert.rejects(stopPinnedPredecessor(invocation));
            assert.equal(spawns, count, 'a pinned but malformed historical snapshot is refused before capture or irreversible actions');
            assert.deepEqual(s.debt(), before); continue;
          }
          const pendingStop = stopPinnedPredecessor(invocation);
          if (mode === 'caller-pin-mutated') invocation.requestSha256 = '0'.repeat(64);
          const result = await pendingStop;
          assert.deepEqual(s.debt(), before, 'neither the idle MS nor running Android ACK/unknown/batch debt is settled');
          if (mode === 'complete' || mode === 'legacy-default-source' || mode === 'caller-pin-mutated') {
            assert.equal(result.kind, 'known-predecessor-stopped'); assert.equal(isVerifiedKnownPredecessorStop(result), true);
            assert.equal(isVerifiedKnownPredecessorStop(JSON.parse(JSON.stringify(result))), false);
            if (result.kind === 'known-predecessor-stopped') {
              assert.equal(result.exits.length, 5); assert.equal(result.finalSnapshot.bindingVector.length, 2);
              assert.deepEqual(result.finalSnapshot.bindingVector.map(binding => binding.sourceId),
                [s.request.legacySourceIds[0], s.request.legacySourceIds[0]]);
              assert.equal(result.finalSnapshot.backupSha256, digest(await readFile(result.finalSnapshot.backupPath)));
            }
          } else {
            assert.deepEqual(result, { kind: 'unknown', operationId });
            assert.equal(isVerifiedKnownPredecessorStop(result), false);
            const count = spawns;
            await assert.rejects(stopPinnedPredecessor(invocation));
            assert.equal(spawns, count, 'a durable unknown grant never recreates a controller or replays the step');
            assert.deepEqual((await readdir(journal)).sort(), mode === 'lost-first-ack'
              ? ['000-grant.json', 'action-scope.json'] : ['action-scope.json'], 'changed pins suppress even the first mutating grant');
          }
        } finally { s.store.close(); }
      }
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
  });

test('persisted predecessor quarantine restores degraded after passive generation drift while action checks stay strict', async () => {
  const selected = [{ pid: 1234, birthTicks: '639100000000000000', imagePath: process.execPath, imageSha256: 'a'.repeat(64) },
    { pid: 1235, birthTicks: '639100000000000001', imagePath: process.execPath, imageSha256: 'a'.repeat(64) }];
  const s = await predecessorObservationFixture(selected);
  const databasePath = path.join(s.request.dataDirectory, 'vkodex.sqlite');
  const debt = (store: BridgeStore) => ({ gate: store.getValue('startup-predecessor-fence'), batches: store.inputBatches(),
    input: store.inputState(JSON.stringify([23456, 'original-unknown-input'])),
    bindings: store.bindings().map(binding => ({ id: binding.id, queue: store.queuedInputs(binding.id), turns: store.acceptedTurns(binding.id),
      lifecycle: store.getValue(`execution-lifecycle:${binding.id}`), managed: store.managedOwner(binding) })) });
  const before = debt(s.store);
  s.store.close();
  let reopened: BridgeStore | undefined;
  try {
    reopened = new BridgeStore(databasePath);
    const bindingId = reopened.bindings()[0]!.id;
    reopened.stopStreaming(bindingId); // ordinary passive stream closure advances this binding generation
    const afterPassiveDrift = debt(reopened);
    assert.deepEqual(afterPassiveDrift, before, 'passive generation drift must not settle or rewrite predecessor debt');

    const restored = await loadPredecessorMaintenance(reopened, s.request.dataDirectory, s.request.legacySourceIds);
    assert.deepEqual(restored, s.admission,
      'an exact persisted physical store pin restores the source-wide no-execution quarantine after passive binding drift');
    assert.deepEqual(predecessorMaintenanceRestorationSummary(reopened, restored!), { state: "binding-scope-changed" });

    const bytes = await readFile(path.join(s.request.dataDirectory, 'predecessor-maintenance.json'));
    const snapshot = JSON.parse(bytes.toString('utf8')) as unknown;
    assert.throws(() => validatePredecessorMaintenance(snapshot, reopened!, s.request.dataDirectory,
      s.request.legacySourceIds, s.request.snapshotSha256), /snapshot refused/u,
    'the original action authority remains pinned to its pre-drift binding vector');
    let controllerCalls = 0;
    await assert.rejects(observeMaintenancePredecessorExits(reopened, s.request, () => { controllerCalls++; }));
    assert.equal(controllerCalls, 0, 'restoration is not a controller ticket or action authorization');
    await assert.rejects(loadPredecessorMaintenance(reopened, s.request.dataDirectory, ["wrong-source"]), /snapshot refused/u);
    assert.deepEqual(debt(reopened), before, 'restoration and rejected action qualification preserve debts');

    const wrongStore = new BridgeStore(path.join(s.request.dataDirectory, "other.sqlite"));
    try {
      wrongStore.setValue("startup-predecessor-fence", reopened.getValue("startup-predecessor-fence"));
      wrongStore.setValue("startup-predecessor-store-scope", reopened.getValue("startup-predecessor-store-scope"));
      await assert.rejects(loadPredecessorMaintenance(wrongStore, s.request.dataDirectory, s.request.legacySourceIds), /snapshot refused/u);
      assert.deepEqual(wrongStore.getValue("startup-predecessor-fence"), s.admission,
        'a copied fence cannot restore quarantine from another physical store');
    } finally { wrongStore.close(); }

    reopened.setValue("startup-predecessor-store-scope", null);
    assert.deepEqual(predecessorMaintenanceRestorationSummary(reopened, restored!), { state: "unavailable" });
    await assert.rejects(loadPredecessorMaintenance(reopened, s.request.dataDirectory, s.request.legacySourceIds), /snapshot refused/u);
    assert.deepEqual(reopened.getValue("startup-predecessor-fence"), s.admission,
      "missing physical scope pin cannot clear or broaden the existing quarantine");
  } finally {
    reopened?.close();
  }
});

test('corrupted predecessor restoration diagnostic is unavailable rather than normalized to unchanged', async () => {
  const selected = [{ pid: 1234, birthTicks: '639100000000000000', imagePath: process.execPath, imageSha256: 'a'.repeat(64) },
    { pid: 1235, birthTicks: '639100000000000001', imagePath: process.execPath, imageSha256: 'a'.repeat(64) }];
  const s = await predecessorObservationFixture(selected);
  try {
    const prior = s.store.getValue<Record<string, unknown>>('startup-predecessor-restoration-diagnostic');
    s.store.setValue('startup-predecessor-restoration-diagnostic', { ...prior, state: ['bindingScopeChanged'] });
    assert.deepEqual(predecessorMaintenanceRestorationSummary(s.store, s.admission), { state: 'unavailable' });
  } finally { s.store.close(); }
});

test('predecessor coordination checks independent pins and complete inventory before a controller receives a ticket', async () => {
  const selected = [{ pid: 1234, birthTicks: '639100000000000000', imagePath: process.execPath, imageSha256: 'a'.repeat(64) },
    { pid: 1235, birthTicks: '639100000000000001', imagePath: process.execPath, imageSha256: 'a'.repeat(64) }];
  const s = await predecessorObservationFixture(selected);
  const before = s.debt(); let controllerCalls = 0;
  try {
    for (const request of [{ ...s.request, selected: selected.slice(0, 1) }, { ...s.request, configurationSha256: '0'.repeat(64) },
      { ...s.request, launchBindingSha256: '0'.repeat(64) }, { ...s.request, snapshotSha256: '0'.repeat(64) },
      { ...s.request, dataDirectory: s.fixture.configurationRoot }]) {
      await assert.rejects(observeMaintenancePredecessorExits(s.store, request, () => { controllerCalls++; }));
    }
    assert.equal(controllerCalls, 0);
    assert.equal(s.store.getValue('predecessor-exit-observation-lease'), null);
    assert.deepEqual(s.debt(), before);
  } finally { s.store.close(); }
});

test('predecessor coordination never rebases pinned original generations during asynchronous deployment validation', async () => {
  const selected = [{ pid: 1234, birthTicks: '639100000000000000', imagePath: process.execPath, imageSha256: 'a'.repeat(64) },
    { pid: 1235, birthTicks: '639100000000000001', imagePath: process.execPath, imageSha256: 'a'.repeat(64) }];
  const s = await predecessorObservationFixture(selected);
  const before = s.debt(); let controllers = 0; let changed = false;
  const original = fsPromises.lstat;
  fsPromises.lstat = (async (file: Parameters<typeof original>[0], ...args: unknown[]) => {
    if (String(file) === s.request.launchBindingPath && !changed) {
      changed = true;
      s.store.setValue(`stream-generation:${s.store.bindings()[0]!.id}`, 99);
    }
    return (original as (...values: unknown[]) => Promise<unknown>)(file, ...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(observeMaintenancePredecessorExits(s.store, s.request, () => { controllers++; }), /observation refused/);
    assert.equal(changed, true, 'the generation changes after snapshot validation, before initial operation CAS');
    assert.equal(controllers, 0);
    assert.equal(s.store.getValue('predecessor-exit-observation-lease'), null);
    assert.deepEqual(s.debt(), before);
  } finally { fsPromises.lstat = original; syncBuiltinESMExports(); s.store.close(); }
});

test('predecessor observation requires an already installed maintenance gate and never installs it as a side effect', async () => {
  const selected = [{ pid: 1234, birthTicks: '639100000000000000', imagePath: process.execPath, imageSha256: 'a'.repeat(64) },
    { pid: 1235, birthTicks: '639100000000000001', imagePath: process.execPath, imageSha256: 'a'.repeat(64) }];
  const s = await predecessorObservationFixture(selected);
  try {
    s.store.setValue('startup-predecessor-fence', null);
    await assert.rejects(observeMaintenancePredecessorExits(s.store, { ...s.request, selected: selected.slice(0, 1) }));
    assert.equal(s.store.getValue('startup-predecessor-fence'), null);
    assert.equal(s.store.getValue('predecessor-exit-observation-lease'), null);
  } finally { s.store.close(); }
});

test('stored selected-exit states without complete physical evidence never produce a confirmed health diagnostic', async () => {
  const selected = [{ pid: 1234, birthTicks: '639100000000000000', imagePath: process.execPath, imageSha256: 'a'.repeat(64) },
    { pid: 1235, birthTicks: '639100000000000001', imagePath: process.execPath, imageSha256: 'a'.repeat(64) }];
  const s = await predecessorObservationFixture(selected);
  try {
    const scope = { storeIdentity: { path: s.store.databasePath, ...s.store.databaseFileIdentity! }, maintenance: s.admission,
      sources: s.request.legacySourceIds, bindings: s.store.bindings().map(binding => ({ bindingId: binding.id, hostId: binding.hostId,
        threadId: binding.threadId, sourceId: binding.sourceId ?? '', generation: s.store.streamGeneration(binding.id) }))
        .sort((a, b) => a.bindingId.localeCompare(b.bindingId)), selected, deployment: {} };
    const operationId = 'historical-json-is-not-a-capture';
    const validPhysical = { identitySha256: 'a'.repeat(64), exits: selected.map(value => ({ pid: value.pid,
      birthTicks: value.birthTicks, exitTicks: String(BigInt(value.birthTicks) + 1n) })) };
    for (const defect of [{ physical: undefined }, { physical: { identitySha256: 'a'.repeat(64), exits: [] } },
      { physical: { identitySha256: 'a'.repeat(64), exits: selected.map(value => ({ pid: value.pid, birthTicks: value.birthTicks, exitTicks: value.birthTicks })) } },
      { physical: { ...validPhysical, identitySha256: ['a'.repeat(64)] } },
      { selected: selected.map(value => ({ ...value, birthTicks: Number(value.birthTicks) })),
        physical: { ...validPhysical, exits: validPhysical.exits.map(value => ({ ...value, birthTicks: Number(value.birthTicks) })) } },
      { selected: [selected[0], selected[0]], physical: { ...validPhysical, exits: [validPhysical.exits[0], validPhysical.exits[0]] } }]) {
      const observedScope = { ...scope, selected: defect.selected ?? selected };
      const scopeSha256 = digest(JSON.stringify(observedScope));
      s.store.setValue('predecessor-exit-observation-last', { operationId, scopeSha256 });
      s.store.setValue(`predecessor-exit-observation:${operationId}`, { version: 1, operationId, scopeSha256, scope: observedScope,
        state: 'selected-exit-scoped', startedAt: 1, observedAt: 2, controllerStarted: false, ...(defect.physical ? { physical: defect.physical } : {}) });
      assert.deepEqual(predecessorExitObservationSummary(s.store, s.admission), { state: 'pending' });
    }
    assert.equal(isCurrentWindowsProcessCaptureTicket({ kind: 'captured', identitySha256: 'a'.repeat(64) }), false);
  } finally { s.store.close(); }
});

test('real selected-exit coordination preserves both Publishing debts; changed generations prevent scoped promotion',
  { skip: process.platform !== 'win32', timeout: 80_000 }, async () => {
    // These are harmless private Node processes, not either original model task.
    // All terminate themselves naturally; no signal, controller or Scheduler mutation.
    const children = [30_000, 31_000].map(ms => spawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), Number(process.argv[1]))', String(ms)], { windowsHide: true, stdio: 'ignore' }));
    const exits = children.map(child => new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture failed')));
    }));
    const stores: BridgeStore[] = [];
    try {
      const imagePath = await realpath(process.execPath);
      const imageSha256 = digest(await readFile(imagePath));
      const selected = await Promise.all(children.map(async child => {
        const identity = await readWindowsProcessIdentityAsync(child.pid!);
        assert.ok(identity);
        return { ...identity, imagePath, imageSha256 };
      }));
      const cases = await Promise.all([predecessorObservationFixture(selected, true), predecessorObservationFixture(selected)]);
      stores.push(...cases.map(s => s.store));
      const before = cases.map(s => s.debt());
      const calls = [0, 0];
      const results = await Promise.all(cases.map((s, index) => observeMaintenancePredecessorExits(s.store, s.request, guard => {
        calls[index] = (calls[index] ?? 0) + 1;
        guard.assertCurrent();
        assert.equal(isCurrentWindowsProcessCaptureTicket(guard.ticket), true);
        assert.equal(isCurrentWindowsProcessCaptureTicket(JSON.parse(JSON.stringify(guard.ticket))), false);
        const lease = s.store.getValue<{ operationId: string }>('predecessor-exit-observation-lease')!;
        assert.equal(lease.operationId, guard.operationId);
        assert.equal(s.store.getValue<{ state: string }>(`predecessor-exit-observation:${guard.operationId}`)!.state, 'captured');
        if (index === 1) s.store.setValue(`stream-generation:${s.store.bindings()[0]!.id}`, 1);
      })));
      assert.deepEqual(calls, [1, 1]);
      assert.deepEqual(results.map(result => result.state), ['selected-exit-scoped', 'original-exit-observed']);
      for (const [index, s] of cases.entries()) {
        assert.deepEqual(s.debt(), before[index], 'physical evidence never settles ACKs, unknown inputs, batches or owner lifecycle');
        assert.equal(predecessorExitObservationSummary(s.store, s.admission).state, index === 0 ? 'selected-exit-scoped' : 'scope-changed');
        const row = s.store.getValue<{ physical: { exits: unknown[] } }>(`predecessor-exit-observation:${results[index]!.operationId}`)!;
        assert.equal(row.physical.exits.length, 2, 'original physical evidence survives the rejected promotion');
        const fact = s.store.getValue<{ state: string; physical: unknown }>(`predecessor-exit-original-fact:${results[index]!.operationId}`)!;
        assert.equal(fact.state, 'original-exit-observed');
        assert.deepEqual(fact.physical, row.physical, 'immutable original evidence is retained independently of promotion');
        assert.equal(s.store.getValue('predecessor-exit-observation-lease'), null);
        s.store.close();
        const reopened = new BridgeStore(path.join(s.request.dataDirectory, 'vkodex.sqlite'));
        stores.push(reopened);
        assert.equal(predecessorExitObservationSummary(reopened, s.admission).state, index === 0 ? 'selected-exit-scoped' : 'scope-changed');
        assert.deepEqual(reopened.getValue('startup-predecessor-fence'), s.admission, 'reopening never lifts the profile fence or restores a capture ticket');
      }
      assert.deepEqual(calls, [1, 1], 'reading/reopening a diagnostic cannot invoke a controller');
    } finally {
      for (const store of stores) { try { store.close(); } catch { /* already closed in restart check */ } }
      await Promise.all(exits);
    }
  });

test("versioned binding keeps stable runtime path and fixed bootstrap separate from artifact and original nested data", async () => {
  const fixture = await bindingFixture();
  const plan = await validateDeploymentBinding(fixture.bindingPath, fixture.bindingSha256);
  assert.equal(plan.executable, fixture.stableRuntimePath);
  assert.notEqual(plan.executable, path.join(fixture.artifactRoot, fixture.runtimeRelative));
  assert.equal(plan.runtimeSha256, fixture.binding.stableRuntimeSha256);
  assert.equal(plan.bindingSha256, fixture.bindingSha256);
  assert.equal(plan.bootstrapManifestSha256, fixture.binding.bootstrapManifestSha256);
  assert.equal(plan.descriptorSha256, fixture.expectedSha256);
  assert.equal(plan.cwd, fixture.configurationRoot);
  assert.equal(plan.dataDirectory, fixture.descriptor.dataDirectory);
  assert.equal(plan.launcherPath, path.join(fixture.bootstrapRoot, "launcher/VKodexSupervisor.exe"));
  assert.equal(plan.launcherSha256, fixture.manifest.files["launcher/VKodexSupervisor.exe"]!.sha256);
  assert.equal(plan.supervisorPath, path.join(fixture.bootstrapRoot, "scripts/run-windows-supervisor.ps1"));
  assert.equal(plan.watchdogPath, path.join(fixture.bootstrapRoot, "scripts/watch-windows-bridge.ps1"));
  assert.equal(plan.protocol, "deployment-plan-v1");
  assert.equal(plan.status, "validated_not_launched");
  assert.deepEqual(plan.arguments, [`--env-file=${plan.environmentFile}`, plan.entryPoint]);
  assert.deepEqual(plan.environmentOverrides, { BOT_DATA_DIR: plan.dataDirectory, NODE_OPTIONS: "", NODE_PATH: "" });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.arguments), true);
  assert.equal(Object.isFrozen(plan.environmentOverrides), true);
  assert.doesNotMatch(JSON.stringify(plan), /SECRET_FIXTURE|do-not-print/u);
  assert.deepEqual(await readdir(fixture.configurationRoot), [".env"]);
});

test("offline action planning emits fixed pinned arguments without launching or installing the fixture", async () => {
  const fixture = await bindingFixture();
  const action = await planDeploymentAction(fixture.bindingPath, fixture.bindingSha256);
  assert.deepEqual(action, { status: "proposed_action_not_installed", executable: path.join(fixture.bootstrapRoot, "launcher/VKodexSupervisor.exe"),
    cwd: fixture.configurationRoot, arguments: ["--launch-binding", fixture.bindingPath, "--launch-binding-sha256", fixture.bindingSha256, "--operation", "supervise"] });
  assert.equal(Object.isFrozen(action), true);
  assert.equal(Object.isFrozen(action.arguments), true);
  assert.deepEqual(await readdir(fixture.configurationRoot), [".env"]);
});

test("deployment parent clears case-insensitive Node and CLR startup hooks without changing unrelated environment", () => {
  const original = { PATH: "fixture-path", BOT_DATA_DIR: "fixture-data", Node_Options: "preload-sentinel", node_path: "module-sentinel",
    COR_ENABLE_PROFILING: "1", Cor_Profiler: "profiler-sentinel", COR_PROFILER_PATH_64: "profiler-path", APPDOMAIN_MANAGER_ASM: "assembly-sentinel" };
  const result = deploymentStartupEnvironment(original);
  assert.equal(result.Node_Options, undefined);
  assert.equal(result.node_path, undefined);
  assert.equal(result.Cor_Profiler, undefined);
  assert.equal(result.NODE_OPTIONS, "");
  assert.equal(result.NODE_PATH, "");
  assert.equal(result.COR_ENABLE_PROFILING, "0");
  assert.equal(result.COR_PROFILER, "");
  assert.equal(result.COR_PROFILER_PATH_64, "");
  assert.equal(result.APPDOMAIN_MANAGER_ASM, "");
  assert.equal(result.PATH, original.PATH);
  assert.equal(result.BOT_DATA_DIR, original.BOT_DATA_DIR);
  assert.equal(original.COR_ENABLE_PROFILING, "1");
});

test("explicit Windows deployment verifies before spawn and uses only fixed pinned arguments", { skip: process.platform !== "win32" }, async () => {
  const fixture = await bindingFixture();
  const originalSpawn = childProcess.spawn;
  const launches: unknown[][] = [];
  try {
    childProcess.spawn = ((...args: unknown[]) => {
      launches.push(args);
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0));
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    await assert.rejects(executeDeployment(fixture.bindingPath, "0".repeat(64), "supervise"));
    assert.equal(launches.length, 0);
    assert.equal(await executeDeployment(fixture.bindingPath, fixture.bindingSha256, "supervise"), 0);
    assert.equal(launches.length, 1);
    const [executable, args, options] = launches[0]!;
    assert.equal(executable, path.join(fixture.bootstrapRoot, "launcher/VKodexSupervisor.exe"));
    assert.deepEqual(args, ["--launch-binding", fixture.bindingPath, "--launch-binding-sha256", fixture.bindingSha256, "--operation", "supervise"]);
    const selected = options as { cwd: string; shell: boolean; windowsHide: boolean; env: NodeJS.ProcessEnv };
    assert.equal(selected.cwd, fixture.configurationRoot);
    assert.equal(selected.shell, false);
    assert.equal(selected.windowsHide, true);
    assert.equal(selected.env.NODE_OPTIONS, "");
    assert.equal(selected.env.COR_ENABLE_PROFILING, "0");
    await writeFile(path.join(fixture.bootstrapRoot, "launcher/VKodexSupervisor.exe"), "changed-launcher");
    await assert.rejects(executeDeployment(fixture.bindingPath, fixture.bindingSha256, "run-once"));
    assert.equal(launches.length, 1);
  } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
});

test("binding CLI argument contract accepts exactly the independent binding pin", () => {
  const file = path.join(artifactFixtures, "binding with spaces.json");
  assert.deepEqual(deploymentBindingArguments(["--launch-binding", file, "--launch-binding-sha256", "a".repeat(64)]),
    { bindingPath: file, expectedSha256: "a".repeat(64) });
  for (const args of [[], [file, "a".repeat(64)], ["--launch-binding", file, "--launch-binding-sha256", "bad"],
    ["--launch-binding", file, "--launch-binding-sha256", "a".repeat(64), "--inspect"]]) {
    assert.throws(() => deploymentBindingArguments(args));
  }
});

test("binding pins reject changed binding, bootstrap or stable runtime without repair or fallback", async () => {
  const fixture = await bindingFixture();
  await assert.rejects(validateDeploymentBinding(fixture.bindingPath, "0".repeat(64)));
  await writeFile(path.join(fixture.bootstrapRoot, "scripts/run-windows-supervisor.ps1"), "substitute-script");
  await assert.rejects(validateDeploymentBinding(fixture.bindingPath, fixture.bindingSha256));
  const runtime = await bindingFixture();
  await writeFile(runtime.stableRuntimePath, "different-runtime");
  await assert.rejects(validateDeploymentBinding(runtime.bindingPath, runtime.bindingSha256));
  assert.equal(await readFile(runtime.stableRuntimePath, "utf8"), "different-runtime");
});

test("individually pinned stable runtime must also match the validated artifact inventory", async () => {
  const fixture = await bindingFixture();
  await writeFile(fixture.stableRuntimePath, "independently-pinned-but-different");
  fixture.binding.stableRuntimeSha256 = digest("independently-pinned-but-different");
  await assert.rejects(validateDeploymentBinding(fixture.bindingPath, await fixture.repinBinding()));
});

test("bootstrap requires fixed complete inventory and ESM package metadata, no extras or dependency shadows", async () => {
  for (const defect of ["missing", "extra", "unlisted", "package-type", "protocol", "case-shadow", "empty-directory"]) {
    const fixture = await bindingFixture();
    if (defect === "missing") delete fixture.manifest.files["launcher/VKodexSupervisor.exe"];
    else if (defect === "protocol") fixture.manifest.protocol = "other-protocol";
    else if (defect === "empty-directory") await mkdir(path.join(fixture.bootstrapRoot, "unlisted directory"));
    else {
      const relative = defect === "package-type" ? "package.json" : defect === "case-shadow" ? "dist/Node_Modules/shadow.js" : "extra.js";
      const bytes = defect === "package-type" ? JSON.stringify({ type: "commonjs" }) : "must-not-execute";
      await mkdir(path.dirname(path.join(fixture.bootstrapRoot, relative)), { recursive: true });
      await writeFile(path.join(fixture.bootstrapRoot, relative), bytes);
      if (defect !== "unlisted") fixture.manifest.files[relative] = { size: Buffer.byteLength(bytes), sha256: digest(bytes) };
    }
    await assert.rejects(validateDeploymentBinding(fixture.bindingPath, await fixture.repinBinding()), defect);
  }
});

test("binding rejects duplicate/unknown JSON fields and malformed UTF-8 despite matching hash", async () => {
  const fixture = await bindingFixture();
  const text = JSON.stringify(fixture.binding);
  for (const bytes of [Buffer.from(`{"version":0,${text.slice(1)}`), Buffer.from(`${text.slice(0, -1)},"nodeOptions":"--inspect"}`),
    Buffer.concat([Buffer.from('{"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')])]) {
    await writeFile(fixture.bindingPath, bytes);
    await assert.rejects(validateDeploymentBinding(fixture.bindingPath, digest(bytes)));
  }
});

test("bootstrap and runtime aliases are refused rather than inferred from environment", async () => {
  const fixture = await bindingFixture();
  const alias = path.join(path.dirname(fixture.bindingPath), "bootstrap alias");
  await symlink(fixture.bootstrapRoot, alias, process.platform === "win32" ? "junction" : "dir");
  fixture.binding.bootstrapRoot = alias;
  await assert.rejects(validateDeploymentBinding(fixture.bindingPath, await fixture.repinBinding()));
  const runtime = await bindingFixture();
  const linked = path.join(path.dirname(runtime.stableRuntimePath), "linked runtime");
  await link(runtime.stableRuntimePath, linked);
  runtime.binding.stableRuntimePath = linked;
  await assert.rejects(validateDeploymentBinding(runtime.bindingPath, await runtime.repinBinding()));
});

test("binding final fences catch runtime, binding and bootstrap replacement during awaited artifact reads", async (context) => {
  for (const target of ["runtime", "binding", "bootstrap"]) {
    const fixture = await bindingFixture();
    const originalLstat = fsPromises.lstat;
    let changed = false;
    // Test-only interception of the builtin, not a production validation bypass
    // or sleep-based race. Restore ESM exports before any later test executes.
    context.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof originalLstat>) => {
      if (!changed && String(args[0]) === path.join(fixture.artifactRoot, "dist/src/desktop-main.js")) {
        changed = true;
        const file = target === "runtime" ? fixture.stableRuntimePath : target === "binding" ? fixture.bindingPath :
          path.join(fixture.bootstrapRoot, "scripts/run-windows-supervisor.ps1");
        await writeFile(file, "changed-during-artifact-observation");
      }
      return Reflect.apply(originalLstat, fsPromises, args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(validateDeploymentBinding(fixture.bindingPath, fixture.bindingSha256), target);
      assert.equal(changed, true);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test("private plan CLI emits one bounded record while public CLI remains identity-only", async () => {
  const fixture = await bindingFixture();
  const privateEntry = fileURLToPath(new URL("../src/desktop/deployment-plan-private.ts", import.meta.url));
  const args = ["--import", "tsx", privateEntry, "--launch-binding", fixture.bindingPath, "--launch-binding-sha256", fixture.bindingSha256];
  const privateResult = await promisify(execFile)(process.execPath, args, { windowsHide: true, maxBuffer: 32 * 1024 });
  const lines = privateResult.stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1);
  assert.equal(privateResult.stderr, "");
  assert.equal(Buffer.byteLength(privateResult.stdout) <= 16 * 1024, true);
  const plan = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(plan.status, "validated_not_launched");
  assert.equal(plan.executable, fixture.stableRuntimePath);
  assert.equal(plan.bindingSha256, fixture.bindingSha256);
  assert.doesNotMatch(privateResult.stdout, /SECRET_FIXTURE|do-not-print/u);
  for (const extra of [[], ["--inspect"], ["--plan-only"]]) {
    const wrong = extra.length ? [...args, ...extra] : args.slice(0, -2);
    await assert.rejects(promisify(execFile)(process.execPath, wrong, { windowsHide: true, maxBuffer: 32 * 1024 }), (error: unknown) => {
      const failure = error as { stdout: string; stderr: string };
      assert.equal(failure.stdout, "");
      assert.doesNotMatch(failure.stderr, /SECRET_FIXTURE|do-not-print|launch with spaces/u);
      return true;
    });
  }
  const publicEntry = fileURLToPath(new URL("../src/desktop/deployment-artifact-check.ts", import.meta.url));
  const publicResult = await promisify(execFile)(process.execPath, ["--import", "tsx", publicEntry, "--descriptor", fixture.descriptorPath,
    "--sha256", fixture.expectedSha256], { windowsHide: true, maxBuffer: 32 * 1024 });
  assert.deepEqual(Object.keys(JSON.parse(publicResult.stdout) as Record<string, unknown>).sort(),
    ["status", "descriptorSha256", "manifestSha256", "sourceCommit", "sourceTree"].sort());
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", publicEntry, ...args.slice(3)], { windowsHide: true }));
});
