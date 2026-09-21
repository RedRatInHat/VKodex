import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { loadDesktopBridgeConfig } from "../bridge/config.js";
import { BridgeStore } from "../bridge/store.js";
import { captureRestartIntent, restartIntentPath } from "./restart-intent.js";

interface RuntimeState { readonly status?: string; readonly pid?: number; readonly startedAt?: number }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statePath = (dataDir: string) => `${dataDir.replace(/[\\/]$/u, "")}/runtime-process.json`;
const readState = async (path: string): Promise<RuntimeState | null> => {
  try { return JSON.parse(await readFile(path, "utf8")) as RuntimeState; } catch { return null; }
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main(): Promise<void> {
  const config = loadDesktopBridgeConfig();
  const runtimeStatePath = statePath(config.dataDir);
  const current = await readState(runtimeStatePath);
  const pid = current?.pid;
  if (current?.status !== "running" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("VKodex bridge is not running; no controlled restart was attempted.");
  }
  const oldPid: number = pid;
  const store = new BridgeStore(`${config.dataDir.replace(/[\\/]$/u, "")}/vkodex.sqlite`);
  let intent;
  try { intent = await captureRestartIntent(store, config.dataDir, oldPid); }
  finally { store.close(); }
  process.stdout.write(`Captured ${intent.tasks.length} active task(s) in ${restartIntentPath(config.dataDir)}.\n`);
  process.kill(oldPid, "SIGTERM");
  const deadline = Date.now() + 120_000;
  let replacement: RuntimeState | null = null;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const state = await readState(runtimeStatePath);
    if (state?.status === "running" && state.pid !== oldPid && (state.startedAt ?? 0) >= intent.createdAt) { replacement = state; break; }
    if (!alive(oldPid) && !existsSync(restartIntentPath(config.dataDir))) break;
  }
  if (!replacement) throw new Error("VKodex supervisor did not bring up a replacement bridge within 120 seconds.");
  const recoveryDeadline = Date.now() + 120_000;
  while (Date.now() < recoveryDeadline) {
    if (!existsSync(restartIntentPath(config.dataDir))) {
      process.stdout.write(`VKodex restarted with PID ${replacement.pid}; active tasks were handed to restart recovery.\n`);
      return;
    }
    await sleep(1_000);
  }
  await writeFile(`${config.dataDir.replace(/[\\/]$/u, "")}/controlled-restart-status.json`, `${JSON.stringify({
    status: "started_recovery_pending", at: Date.now(), oldPid, newPid: replacement.pid, intentId: intent.id,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  throw new Error("VKodex restarted, but restart recovery has not finished yet; the intent was kept for an idempotent retry.");
}

await main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Controlled restart failed"}\n`); process.exitCode = 1; });
