import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateWindowsNativeLauncherSource, prepareWindowsNativeLauncher, type WindowsNativeLauncherOptions } from "../src/dot-browser/native-launcher-preparation.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const origin = `chrome-extension://${extensionId}/`;
const sourceOptions: WindowsNativeLauncherOptions = {
  runtimePath: "C:\\fixture\\runtime.exe", entryPath: "C:\\fixture\\entry.cjs", configPath: "C:\\fixture\\config.json",
  runtimeSha256: "a".repeat(64), entrySha256: "b".repeat(64), configSha256: "c".repeat(64),
  extensionId, outputNewDirectory: "C:\\fixture\\new staging",
};
const hash = (filename: string) => createHash("sha256").update(readFileSync(filename)).digest("hex");

test("source generation pins exact files/origin and uses byte streams and own-child shutdown", () => {
  const source = generateWindowsNativeLauncherSource(sourceOptions);
  for (const value of [sourceOptions.runtimePath, sourceOptions.entryPath, sourceOptions.configPath, extensionId,
    sourceOptions.runtimeSha256, sourceOptions.entrySha256, sourceOptions.configSha256]) assert.ok(source.includes(value));
  assert.match(source, /StringComparison.Ordinal/u);
  assert.match(source, /UseShellExecute = false/u); assert.match(source, /CreateNoWindow = true/u);
  assert.match(source, /OpenStandardInput\(\)\.CopyTo\(child.StandardInput.BaseStream\)/u);
  assert.match(source, /child.StandardOutput.BaseStream.CopyTo\(browser\)/u);
  assert.match(source, /child.StandardError.BaseStream.CopyTo\(Stream.Null\)/u);
  assert.match(source, /EnvironmentVariables\["NODE_OPTIONS"\] = ""/u);
  assert.match(source, /EnvironmentVariables\["NODE_PATH"\] = ""/u);
  assert.doesNotMatch(source, /Console\.(Write|Error)|GetProcesses|Kill\(true\)|cmd.exe|powershell|Registry/u);
});

test("source generation escapes embedded C# verbatim literals without interpreting backslashes", () => {
  const entryPath = 'C:\\fixture\\"quoted"\\entry.cjs';
  const source = generateWindowsNativeLauncherSource({ ...sourceOptions, entryPath });
  assert.ok(source.includes('private const string Entry = @"C:\\fixture\\""quoted""\\entry.cjs";'));
});

test("validation refuses relative/control-character paths, invalid pins and invalid extension IDs", () => {
  for (const key of ["runtimePath", "entryPath", "configPath", "outputNewDirectory"] as const)
    for (const value of ["relative", "", "C:relative", "\\root-relative", "/root-relative", "C:\\fixture\\bad\npath", "C:\\fixture\\bad\0path"])
      assert.throws(() => generateWindowsNativeLauncherSource({ ...sourceOptions, [key]: value }));
  for (const key of ["runtimeSha256", "entrySha256", "configSha256"] as const)
    for (const value of ["a".repeat(63), "g".repeat(64), "A".repeat(64)])
      assert.throws(() => generateWindowsNativeLauncherSource({ ...sourceOptions, [key]: value }));
  for (const extensionId of ["a".repeat(31), "q".repeat(32), "A".repeat(32), "a".repeat(32) + "/"])
    assert.throws(() => generateWindowsNativeLauncherSource({ ...sourceOptions, extensionId }));
});

test("non-Windows preparation refuses without executing a compiler", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(prepareWindowsNativeLauncher(sourceOptions), /Windows compiler required/u);
});

test("Windows harmless fixture launcher qualification", { skip: process.platform !== "win32" }, async t => {
  const folder = mkdtempSync(path.join(tmpdir(), "dot-launcher-fixture-"));
  const runtimePath = path.join(folder, "fixture node.exe"), entryPath = path.join(folder, "fixture entry.cjs");
  const configPath = path.join(folder, "fixture config.json"), startedPath = path.join(folder, "started.json");
  copyFileSync(process.execPath, runtimePath);
  writeFileSync(configPath, '{"fixture":true}\n');
  const entry = `const fs = require('node:fs');
const path = require('node:path');
if (process.env.NODE_OPTIONS || process.env.NODE_PATH) process.exit(62);
fs.writeFileSync(path.join(__dirname, 'started.json'), JSON.stringify(process.argv.slice(2)));
process.stderr.write('PRIVATE_FIXTURE_STDERR');
process.stdin.on('data', bytes => process.stdout.write(bytes));
process.stdin.on('end', () => process.stdout.write(Buffer.alloc(0), () => process.exit(23)));
`;
  writeFileSync(entryPath, entry);
  const options: WindowsNativeLauncherOptions = { runtimePath, entryPath, configPath,
    runtimeSha256: hash(runtimePath), entrySha256: hash(entryPath), configSha256: hash(configPath), extensionId,
    outputNewDirectory: path.join(folder, "new staging") };
  const prepared = await prepareWindowsNativeLauncher(options);
  assert.equal(hash(prepared.launcherPath), prepared.launcherSha256);

  const run = (args: string[], bytes = Buffer.alloc(0), closeInput = true): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> =>
    new Promise((resolve, reject) => {
      const child = spawn(prepared.launcherPath, args, { windowsHide: true, stdio: "pipe",
        env: { ...process.env, NODE_OPTIONS: "--require=missing_fixture_poison.cjs", NODE_PATH: "fixture-poison" } });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Fixture launcher deadline")); }, 12_000);
      child.stdout.on("data", value => stdout.push(Buffer.from(value)));
      child.stderr.on("data", value => stderr.push(Buffer.from(value)));
      child.stdin.on("error", () => { /* Refusal may close input before fixture bytes. */ });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
      if (closeInput) child.stdin.end(bytes); else child.stdin.write(bytes);
    });

  await t.test("origin and arbitrary arguments are refused before fixture child starts", async () => {
    for (const args of [["chrome-extension://" + "p".repeat(32) + "/"], [origin + "extra"], [origin, "--other=1"],
      [origin, "--parent-window=-1"], [origin, "--parent-window=1\n"], [origin, "--parent-window=1", "extra"], []]) {
      const result = await run(args);
      assert.equal(result.code, 64); assert.equal(result.stdout.length + result.stderr.length, 0);
      assert.equal(existsSync(startedPath), false);
    }
  });

  await t.test("tampering any pinned input prevents child start without leaking diagnostics", async () => {
    for (const filename of [entryPath, configPath, runtimePath]) {
      const original = readFileSync(filename);
      try {
        writeFileSync(filename, Buffer.concat([original, Buffer.from("tampered")]));
        const result = await run([origin]);
        assert.equal(result.code, 78); assert.equal(result.stdout.length + result.stderr.length, 0);
        assert.equal(existsSync(startedPath), false);
      } finally { writeFileSync(filename, original); }
    }
  });

  await t.test("binary framed bytes survive stdin/stdout; EOF and child exit code are preserved", async () => {
    const payload = Buffer.from([0, 255, 128, 13, 10, 0, 1, 2, 3, 254]);
    const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
    const result = await run([origin, "--parent-window=123"], frame);
    assert.equal(result.code, 23); assert.deepEqual(result.stdout, frame); assert.equal(result.stderr.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(startedPath, "utf8")), ["--config", configPath, "--extension-id", extensionId, origin, "--parent-window=123"]);
  });

  await t.test("child can exit while browser stdin remains open", async () => {
    // A separate harmless entry and wrapper preserve the previous prepared pins.
    const exitEntry = path.join(folder, "exit.cjs"); writeFileSync(exitEntry, "process.exit(17);\n");
    const exitLauncher = await prepareWindowsNativeLauncher({ ...options, entryPath: exitEntry,
      entrySha256: hash(exitEntry), outputNewDirectory: path.join(folder, "exit staging") });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exitLauncher.launcherPath, [origin], { windowsHide: true, stdio: "pipe" });
      const deadline = setTimeout(() => { child.kill(); reject(new Error("Fixture exit deadline")); }, 5_000);
      child.on("error", error => { clearTimeout(deadline); reject(error); });
      child.on("close", code => { clearTimeout(deadline); assert.equal(code, 17); resolve(); });
    });
  });

  await t.test("prepare refuses overwrite and input pin mismatch", async () => {
    const sourceBefore = readFileSync(prepared.sourcePath), exeBefore = readFileSync(prepared.launcherPath);
    await assert.rejects(prepareWindowsNativeLauncher(options));
    assert.deepEqual(readFileSync(prepared.sourcePath), sourceBefore); assert.deepEqual(readFileSync(prepared.launcherPath), exeBefore);
    const badOutput = path.join(folder, "bad staging");
    await assert.rejects(prepareWindowsNativeLauncher({ ...options, runtimeSha256: "0".repeat(64), outputNewDirectory: badOutput }), /pin mismatch/u);
    assert.equal(existsSync(badOutput), false);
  });

  await t.test("verified entry/config remain locked against child writes throughout execution", async () => {
    const lockedEntry = path.join(folder, "locked.cjs");
    const lockedText = `const fs = require('node:fs');
const config = process.argv[process.argv.indexOf('--config') + 1];
const results = [__filename, config].map(filename => {
  try { fs.writeFileSync(filename, 'tampered by fixture child'); return false; } catch { return true; }
});
process.stdout.write(JSON.stringify(results), () => process.exit(results.every(Boolean) ? 19 : 63));
`;
    writeFileSync(lockedEntry, lockedText);
    const configBefore = readFileSync(configPath);
    const lockedLauncher = await prepareWindowsNativeLauncher({ ...options, entryPath: lockedEntry,
      entrySha256: hash(lockedEntry), outputNewDirectory: path.join(folder, "locked staging") });
    const result = await new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const child = spawn(lockedLauncher.launcherPath, [origin], { windowsHide: true, stdio: "pipe" });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const deadline = setTimeout(() => { child.kill(); reject(new Error("Fixture lock deadline")); }, 5_000);
      child.stdout.on("data", value => stdout.push(Buffer.from(value)));
      child.stderr.on("data", value => stderr.push(Buffer.from(value)));
      child.on("error", error => { clearTimeout(deadline); reject(error); });
      child.on("close", code => { clearTimeout(deadline); resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
      child.stdin.end();
    });
    assert.equal(result.code, 19); assert.deepEqual(JSON.parse(result.stdout.toString()), [true, true]);
    assert.equal(result.stderr.length, 0); assert.equal(readFileSync(lockedEntry, "utf8"), lockedText);
    assert.deepEqual(readFileSync(configPath), configBefore);
  });

  await t.test("browser EOF bounds shutdown of a fixture child that refuses to exit", async () => {
    const hangingEntry = path.join(folder, "hanging.cjs");
    writeFileSync(hangingEntry, "process.stdin.resume(); process.stdin.on('end', () => setInterval(() => {}, 1000));\n");
    const hangingLauncher = await prepareWindowsNativeLauncher({ ...options, entryPath: hangingEntry,
      entrySha256: hash(hangingEntry), outputNewDirectory: path.join(folder, "hanging staging") });
    const start = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(hangingLauncher.launcherPath, [origin], { windowsHide: true, stdio: "pipe" });
      const deadline = setTimeout(() => { child.kill(); reject(new Error("Fixture EOF deadline")); }, 10_000);
      child.on("error", error => { clearTimeout(deadline); reject(error); });
      child.on("close", code => { clearTimeout(deadline); assert.notEqual(code, 0); resolve(); });
      child.stdin.end();
    });
    assert.ok(performance.now() - start < 10_000);
  });

  await t.test("undrained stdout returns transport failure instead of child success", async () => {
    const outputEntry = path.join(folder, "output.cjs");
    writeFileSync(outputEntry, "process.stdout.write(Buffer.alloc(16 * 1024 * 1024)); process.exit(0);\n");
    const outputLauncher = await prepareWindowsNativeLauncher({ ...options, entryPath: outputEntry,
      entrySha256: hash(outputEntry), outputNewDirectory: path.join(folder, "output staging") });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(outputLauncher.launcherPath, [origin], { windowsHide: true, stdio: "pipe" });
      const deadline = setTimeout(() => { child.kill(); reject(new Error("Fixture output deadline")); }, 10_000);
      child.on("error", error => { clearTimeout(deadline); reject(error); });
      // Keep the browser-side pipe backpressured until the wrapper exits.
      child.on("exit", () => child.stdout.resume());
      child.on("close", code => { clearTimeout(deadline); assert.equal(code, 70); resolve(); });
      child.stderr.resume(); child.stdin.end();
    });
  });
});
