import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { copyReleaseInventory, prepareRelease, type ReleasePreparationOptions } from "../src/desktop/release-preparation.js";
import { validateDeploymentBinding } from "../src/desktop/deployment-binding.js";

const execFile = promisify(execFileCallback);
const parent = await realpath(tmpdir());
const root = await mkdtemp(path.join(parent, "vkodex-release-preparation-fixture-"));
const noopBuild = async () => {};

after(async () => {
  if (process.platform !== "win32") return; // Preserve files when no Recycle Bin exists.
  await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_TARGET); $parent=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_PARENT).TrimEnd([char]92)+[char]92; if(-not $target.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notlike 'vkodex-release-preparation-fixture-*'){throw 'Unexpected recycle target'}; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)"],
  { windowsHide: true, env: { ...process.env, VKODEX_TEST_RECYCLE_TARGET: root, VKODEX_TEST_RECYCLE_PARENT: parent } });
});

async function fixture(name: string, sdkVersion = "0.160.0", externalDependencies = false,
  omitNative = false): Promise<ReleasePreparationOptions> {
  const home = path.join(root, name);
  const source = path.join(home, "source");
  const configurationRoot = path.join(home, "config");
  const dataDirectory = path.join(home, "data");
  const output = path.join(home, "release");
  const stableRuntimePath = path.join(home, "runtime.exe");
  const launcherPath = path.join(home, "launcher.exe");
  const dependenciesRoot = externalDependencies ? path.join(home, "independent-dependencies") : path.join(source, "node_modules");
  await mkdir(source, { recursive: true });
  await mkdir(configurationRoot);
  await mkdir(dataDirectory);
  await writeFile(path.join(configurationRoot, ".env"), "SECRET_FIXTURE_DO_NOT_COPY=yes\n");
  await writeFile(stableRuntimePath, "fixture-runtime");
  await writeFile(launcherPath, "fixture-launcher");
  const nativePackage = `@openai/codex-${process.platform}-${process.arch}`;
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix = process.platform === "win32" ? "pc-windows-msvc" : process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  const nativeRelative = `node_modules/${nativePackage}/vendor/${cpu}-${suffix}/codex/${process.platform === "win32" ? "codex.exe" : "codex"}`;
  const packageFile = { name: "fixture", type: "module", dependencies: { "@openai/codex-sdk": sdkVersion } };
  const lockFile = { lockfileVersion: 3, packages: {
    "": { dependencies: { "@openai/codex-sdk": sdkVersion } },
    "node_modules/@openai/codex-sdk": { version: sdkVersion },
    "node_modules/@openai/codex": { version: sdkVersion },
    [`node_modules/${nativePackage}`]: { version: `${sdkVersion}-${process.platform}-${process.arch}`, optional: true },
  } };
  const content: Record<string, string> = {
    "package.json": JSON.stringify(packageFile), "package-lock.json": JSON.stringify(lockFile),
    "docs/logo.ico": "fixture-logo", "scripts/run-windows-supervisor.ps1": "throw 'fixture'\n",
    "scripts/watch-windows-bridge.ps1": "throw 'fixture'\n", "scripts/VKodexSupervisor.cs": "// fixture\n",
    "scripts/read-vk-document-token.ps1": "throw 'fixture'\n",
    "dist/src/desktop-main.js": "throw new Error('fixture must not run')\n",
    "dist/src/codex/native-cli.js": "throw new Error('fixture must not run')\n",
    "dist/src/desktop/deployment-plan-private.js": "export {}\n",
    "dist/src/desktop/deployment-binding.js": "export {}\n",
    "dist/src/desktop/deployment-artifact.js": "export {}\n",
    "dist/src/desktop/runtime.js": "export {}\n",
    "node_modules/@openai/codex-sdk/package.json": JSON.stringify({ name: "@openai/codex-sdk", version: sdkVersion,
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } } }),
    "node_modules/@openai/codex-sdk/dist/index.js": "export {}\n",
    "node_modules/@openai/codex-sdk/dist/index.d.ts": "export {}\n",
    "node_modules/@openai/codex/package.json": JSON.stringify({ name: "@openai/codex", version: sdkVersion }),
    [`node_modules/${nativePackage}/package.json`]: JSON.stringify({ name: nativePackage,
      version: `${sdkVersion}-${process.platform}-${process.arch}` }),
    [nativeRelative]: "fixture-native-cli",
  };
  for (const [relative, bytes] of Object.entries(content)) {
    if (omitNative && relative.startsWith(`node_modules/${nativePackage}/`)) continue;
    const file = relative.startsWith("node_modules/")
      ? path.join(dependenciesRoot, relative.slice("node_modules/".length)) : path.join(source, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await execFile("git", ["init", source], { windowsHide: true });
  await execFile("git", ["-C", source, "add", "--", "."], { windowsHide: true });
  await execFile("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-m", "fixture"], { windowsHide: true });
  return { source, configurationRoot, dataDirectory, output, stableRuntimePath, launcherPath,
    dependenciesRoot, mode: "prepare" };
}

test("release preparation validates a pinned, secret-free release and refuses overwrite", async () => {
  const options = await fixture("success");
  const dry = await prepareRelease({ ...options, mode: "dry-run" }, noopBuild);
  assert.equal(dry.status, "ready_to_prepare");
  assert.deepEqual(dry.omittedOptionalPackages, []);
  await assert.rejects(readFile(path.join(options.output, "binding.json")), { code: "ENOENT" });
  const result = await prepareRelease(options, noopBuild);
  assert.equal(result.status, "validated_not_launched");
  const plan = await validateDeploymentBinding(result.bindingPath!, result.bindingSha256!);
  assert.equal(plan.sourceCommit, result.sourceCommit);
  assert.equal(plan.sourceTree, result.sourceTree);
  assert.equal(plan.cwd, options.configurationRoot);
  await assert.rejects(readFile(path.join(options.output, "artifact", ".env")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(options.output, "bootstrap", ".env")), { code: "ENOENT" });
  await assert.rejects(prepareRelease(options, noopBuild), /output already exists/u);
  await writeFile(path.join(options.output, "binding.json"), "tampered", { flag: "a" });
  await assert.rejects(validateDeploymentBinding(result.bindingPath!, result.bindingSha256!), /hash mismatch/u);
});

test("release preparation rejects mismatched SDK before creating output", async () => {
  const options = await fixture("sdk-mismatch", "0.159.0");
  await assert.rejects(prepareRelease(options, noopBuild), /production dependency pin unavailable/u);
  await assert.rejects(readFile(path.join(options.output, "binding.json")), { code: "ENOENT" });
});

test("release preparation rejects a hard-linked runtime before creating output", async () => {
  const options = await fixture("linked-input");
  const linked = path.join(path.dirname(options.stableRuntimePath), "runtime-linked.exe");
  await link(options.stableRuntimePath, linked);
  await assert.rejects(prepareRelease(options, noopBuild), /linked or non-regular input/u);
  await assert.rejects(readFile(path.join(options.output, "binding.json")), { code: "ENOENT" });
});

test("release preparation refuses secret-like compiled output before copying it", async () => {
  const options = await fixture("compiled-secret");
  await writeFile(path.join(options.source, "dist", ".env"), "SECRET_FIXTURE_DO_NOT_COPY=yes\n");
  await assert.rejects(prepareRelease(options, noopBuild), /unexpected compiled output/u);
  await assert.rejects(readFile(path.join(options.output, "artifact", "dist", ".env")), { code: "ENOENT" });
});

test("release preparation rejects an untracked TypeScript build input", async () => {
  const options = await fixture("untracked-build-input");
  await mkdir(path.join(options.source, "src"));
  await writeFile(path.join(options.source, "src", "untracked.ts"), "export const surprise = true;\n");
  await assert.rejects(prepareRelease(options, noopBuild), /untracked build input/u);
  await assert.rejects(readFile(path.join(options.output, "binding.json")), { code: "ENOENT" });
});

test("release preparation requires an explicitly canonical dependencies root", async () => {
  const options = await fixture("linked-dependencies-root");
  const alias = path.join(path.dirname(options.source), "linked-node-modules");
  await symlink(options.dependenciesRoot, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareRelease({ ...options, dependenciesRoot: alias }, noopBuild), /linked or aliased local path/u);
});

test("release preparation uses an external canonical dependency root and checks installed versions", async () => {
  const options = await fixture("external-dependencies", "0.160.0", true);
  const dry = await prepareRelease({ ...options, mode: "dry-run" }, noopBuild);
  assert.equal(dry.status, "ready_to_prepare");
  const sdkPackage = path.join(options.dependenciesRoot, "@openai", "codex-sdk", "package.json");
  const metadata = JSON.parse(await readFile(sdkPackage, "utf8")) as { version: string };
  metadata.version = "0.159.0";
  await writeFile(sdkPackage, JSON.stringify(metadata));
  await assert.rejects(prepareRelease(options, noopBuild), /installed production dependency version differs from lock/u);
});

test("release preparation refuses a missing current-platform native optional package", async () => {
  const options = await fixture("missing-current-native", "0.160.0", true, true);
  await assert.rejects(prepareRelease(options, noopBuild), /current-platform native CLI dependency missing/u);
});

test("exclusive inventory copy preserves an existing target byte-for-byte", async () => {
  const options = await fixture("existing-inventory-target");
  const destination = path.join(path.dirname(options.source), "preexisting-destination");
  await mkdir(destination);
  const target = path.join(destination, "marker.txt");
  await writeFile(target, "original-target");
  await assert.rejects(copyReleaseInventory(new Map([["marker.txt", options.stableRuntimePath]]), destination), { code: "EEXIST" });
  assert.equal(await readFile(target, "utf8"), "original-target");
});
