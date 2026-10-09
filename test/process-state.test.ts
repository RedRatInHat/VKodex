import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { healthFailure, parseRuntimeProcessState } from "../src/desktop/health-status.js";
import { createDesktopLogger, desktopLogPath } from "../src/desktop/logging.js";
import { writeRuntimeProcessState } from "../src/desktop/process-state.js";
import { acquireRuntimeLease, RuntimeAlreadyRunningError } from "../src/desktop/runtime-lease.js";

test("runtime lease blocks a second process, closes idempotently, then releases", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vkodex-runtime-lease-"));
  const first = acquireRuntimeLease(dataDir);
  t.after(() => first.close());
  assert.throws(() => acquireRuntimeLease(dataDir), RuntimeAlreadyRunningError);
  first.close(); first.close();
  const next = acquireRuntimeLease(dataDir);
  assert.doesNotThrow(() => next.close());
});

test("runtime leases in unrelated data directories do not conflict", async t => {
  const firstDir = await mkdtemp(path.join(os.tmpdir(), "vkodex-runtime-lease-a-"));
  const secondDir = await mkdtemp(path.join(os.tmpdir(), "vkodex-runtime-lease-b-"));
  const first = acquireRuntimeLease(firstDir); const second = acquireRuntimeLease(secondDir);
  t.after(() => { first.close(); second.close(); });
  assert.throws(() => acquireRuntimeLease(firstDir), RuntimeAlreadyRunningError);
  assert.throws(() => acquireRuntimeLease(secondDir), RuntimeAlreadyRunningError);
});

test("runtime lease uses its own database without changing main database or active turn rows", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vkodex-runtime-lease-db-"));
  const main = new Database(path.join(dataDir, "state_5.sqlite"));
  t.after(() => main.close());
  main.exec("CREATE TABLE turns (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO turns VALUES ('active-turn', 'inProgress'); BEGIN IMMEDIATE;");
  const lease = acquireRuntimeLease(dataDir);
  t.after(() => lease.close());
  assert.deepEqual(main.prepare("SELECT id,status FROM turns").all(), [{ id: "active-turn", status: "inProgress" }]);
  assert.deepEqual((await readdir(dataDir)).sort(), ["runtime-lease.sqlite", "runtime-lease.sqlite-journal", "state_5.sqlite"]);
  lease.close();
  main.exec("ROLLBACK");
});

test("forced runtime process termination releases its OS-held lease", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vkodex-runtime-lease-child-"));
  const moduleUrl = pathToFileURL(path.resolve("src/desktop/runtime-lease.ts")).href;
  const childCode = `import { acquireRuntimeLease } from ${JSON.stringify(moduleUrl)}; acquireRuntimeLease(${JSON.stringify(dataDir)}); console.log("lease-ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Runtime lease child did not become ready")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.includes("lease-ready")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      if (!output.includes("lease-ready")) { clearTimeout(timer); reject(new Error(`Runtime lease child exited before ready (${code})`)); }
    });
  });
  assert.throws(() => acquireRuntimeLease(dataDir), RuntimeAlreadyRunningError);
  assert.equal(child.kill(), true);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Runtime lease child did not terminate")), 10_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  const afterExit = acquireRuntimeLease(dataDir);
  afterExit.close();
});

test("runtime process state contains no configuration or exception payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-process-state-"));
  writeRuntimeProcessState(root, {
    status: "stopped",
    pid: 42,
    at: 200,
    startedAt: 100,
    exitCode: 1,
    reason: "unhandled_rejection",
  });
  const value = JSON.parse(await readFile(path.join(root, "runtime-process.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(value, {
    status: "stopped",
    pid: 42,
    at: 200,
    startedAt: 100,
    exitCode: 1,
    reason: "unhandled_rejection",
  });
});

const report = { state: "ok" as const, checkedAt: 200, pid: 42, uptimeSeconds: 100, checks: [] };

test("health status rejects a dead, stopped, stale or replaced runtime", () => {
  const running = { status: "running" as const, pid: 42, at: 100, startedAt: 100 };
  assert.equal(healthFailure(report, running, 250, 100, () => true), null);
  assert.match(healthFailure(report, { ...running, status: "stopped" }, 250, 100, () => true)!, /остановлен/u);
  assert.match(healthFailure(report, { ...running, pid: 43 }, 250, 100, () => true)!, /предыдущему процессу/u);
  assert.match(healthFailure(report, running, 250, 100, () => false)!, /не существует/u);
  assert.match(healthFailure(report, running, 301, 100, () => true)!, /устарел/u);
});

test("runtime process parser rejects malformed and impossible process identities", () => {
  assert.deepEqual(parseRuntimeProcessState({ status: "running", pid: 42, at: 200, startedAt: 100 }),
    { status: "running", pid: 42, at: 200, startedAt: 100 });
  assert.equal(parseRuntimeProcessState({ status: "running", pid: 0, at: 200, startedAt: 100 }), null);
  assert.equal(parseRuntimeProcessState({ status: "unknown", pid: 42, at: 200, startedAt: 100 }), null);
});

test("desktop runtime logger duplicates structured output to the console and its private run file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-runtime-log-"));
  const env = { VKODEX_RUN_ID: "20260831-193556183-ebdca976", LOG_LEVEL: "info" };
  const consoleStream = new PassThrough();
  let consoleOutput = "";
  consoleStream.setEncoding("utf8");
  consoleStream.on("data", chunk => { consoleOutput += String(chunk); });
  const logger = createDesktopLogger(root, env, consoleStream);
  logger.info({ check: "dual-output" }, "bridge ready");
  const fileOutput = await readFile(desktopLogPath(root, env), "utf8");
  assert.equal(fileOutput, consoleOutput);
  assert.deepEqual(JSON.parse(fileOutput), {
    level: 30, time: JSON.parse(fileOutput).time, pid: process.pid, check: "dual-output", msg: "bridge ready",
  });
  assert.equal(path.basename(desktopLogPath(root, { VKODEX_RUN_ID: "../escape" })), "vkodex.log");
});
