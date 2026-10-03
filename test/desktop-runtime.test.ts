import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compatibleRuntime, launchArguments, windowsRuntimePath } from "../src/desktop/runtime.js";
import { boundedArtifactBytes, deploymentDataDirectory, deploymentValidationArguments, validateDeploymentArtifact } from "../src/desktop/deployment-artifact.js";

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

const artifactFixtures = await mkdtemp(path.join(tmpdir(), "vkodex-artifact-tests-"));
after(async () => {
  if (process.platform !== "win32") return; // No permanent deletion when a Recycle Bin is unavailable.
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_TARGET); $root=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\\')+'\\'; if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notlike 'vkodex-artifact-tests-*'){throw 'Unexpected recycle target'}; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)"],
  { windowsHide: true, env: { ...process.env, VKODEX_TEST_RECYCLE_TARGET: artifactFixtures } });
});
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function artifactFixture() {
  const root = await mkdtemp(path.join(artifactFixtures, "launch with spaces "));
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
