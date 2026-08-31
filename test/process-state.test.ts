import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { healthFailure, parseRuntimeProcessState } from "../src/desktop/health-status.js";
import { writeRuntimeProcessState } from "../src/desktop/process-state.js";

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
