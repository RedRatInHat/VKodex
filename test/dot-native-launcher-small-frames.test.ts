import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareWindowsNativeLauncher } from "../src/dot-browser/native-launcher-preparation.js";

test("Windows launcher forwards small binary frames in both directions before stdin EOF",
  { skip: process.platform !== "win32" }, async t => {
    const folder = mkdtempSync(path.join(tmpdir(), "dot-launcher-small-frames-"));
    const runtimePath = path.join(folder, "fixture node.exe");
    const entryPath = path.join(folder, "small frames.cjs"), configPath = path.join(folder, "config.json");
    copyFileSync(process.execPath, runtimePath);
    writeFileSync(configPath, '{"fixture":true}\n');
    const greeting = Buffer.from([4, 0, 0, 0, 0, 255, 128, 13]);
    const reply = Buffer.from([3, 0, 0, 0, 254, 0, 10]);
    const ack = Buffer.from([2, 0, 0, 0, 255, 0]);
    writeFileSync(entryPath, `const greeting = Buffer.from(${JSON.stringify([...greeting])});
const expected = Buffer.from(${JSON.stringify([...reply])});
const ack = Buffer.from(${JSON.stringify([...ack])});
const timer = setTimeout(() => process.exit(61), 12000);
let bytes = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  if (bytes.length < expected.length) return;
  if (!bytes.equals(expected)) process.exit(62);
  clearTimeout(timer);
  process.stdout.write(ack, () => process.exit(17));
});
process.stdout.write(greeting);
`);
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const prepared = await prepareWindowsNativeLauncher({ runtimePath, entryPath, configPath,
      runtimeSha256: hash(runtimePath), entrySha256: hash(entryPath), configSha256: hash(configPath),
      extensionId, outputNewDirectory: path.join(folder, "launcher") });

    const run = (command: string, args: string[]) => new Promise<{
      code: number | null; bytes: Buffer; stderr: Buffer; firstFrameMs: number | null;
      ackMs: number | null; firstFrameBeforeEof: boolean; ackBeforeEof: boolean; deadlineReached: boolean;
    }>((resolve, reject) => {
      const start = performance.now(), child = spawn(command, args, { windowsHide: true, stdio: "pipe" });
      let bytes = Buffer.alloc(0), firstFrameMs: number | null = null, ackMs: number | null = null;
      let firstFrameBeforeEof = false, ackBeforeEof = false, deadlineReached = false;
      const stderr: Buffer[] = [];
      // Closing only fixture stdin on deadline distinguishes EOF-dependent delivery.
      const deadline = setTimeout(() => { deadlineReached = true; child.stdin.end(); }, 3000);
      const cleanup = setTimeout(() => { child.kill(); reject(new Error("Small-frame fixture cleanup deadline")); }, 9000);
      child.stdin.on("error", () => {});
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      child.stdout.on("data", chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (firstFrameMs === null && bytes.length >= greeting.length) {
          firstFrameMs = performance.now() - start; firstFrameBeforeEof = !child.stdin.writableEnded;
          if (!child.stdin.writableEnded) child.stdin.write(reply);
        }
        if (ackMs === null && bytes.length >= greeting.length + ack.length) {
          ackMs = performance.now() - start; ackBeforeEof = !child.stdin.writableEnded;
        }
      });
      child.on("error", error => { clearTimeout(deadline); clearTimeout(cleanup); reject(error); });
      child.on("close", code => {
        clearTimeout(deadline); clearTimeout(cleanup);
        resolve({ code, bytes, stderr: Buffer.concat(stderr), firstFrameMs, ackMs,
          firstFrameBeforeEof, ackBeforeEof, deadlineReached });
      });
    });
    for (const [name, command, args] of [
      ["direct child", runtimePath, [entryPath]],
      ["compiled launcher", prepared.launcherPath, [`chrome-extension://${extensionId}/`]],
    ] as const) {
      const result = await run(command, [...args]);
      t.diagnostic(JSON.stringify({ name, ...result, bytes: result.bytes.toString("hex"), stderr: result.stderr.toString("hex") }));
      assert.equal(result.code, 17);
      assert.deepEqual(result.bytes, Buffer.concat([greeting, ack]));
      assert.equal(result.stderr.length, 0);
      assert.equal(result.deadlineReached, false, `${name}: small-frame roundtrip waited for stdin EOF`);
      assert.equal(result.firstFrameBeforeEof, true);
      assert.equal(result.ackBeforeEof, true);
    }
  });
