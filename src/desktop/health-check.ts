import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDesktopBridgeConfig } from "../bridge/config.js";
import { formatHealthSummary } from "../bridge/health.js";
import { healthFailure, parseHealthSnapshot, parseRuntimeProcessState } from "./health-status.js";

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function main(): Promise<void> {
  const config = loadDesktopBridgeConfig();
  let parsedHealth: unknown; let parsedRuntime: unknown;
  try {
    [parsedHealth, parsedRuntime] = await Promise.all([
      readFile(path.join(config.dataDir, "health.json"), "utf8").then(JSON.parse),
      readFile(path.join(config.dataDir, "runtime-process.json"), "utf8").then(JSON.parse),
    ]);
  }
  catch {
    process.stderr.write("FAIL: health.json или runtime-process.json отсутствует либо повреждён.\n");
    process.exitCode = 1; return;
  }
  const report = parseHealthSnapshot(parsedHealth); const runtime = parseRuntimeProcessState(parsedRuntime);
  if (!report || !runtime) {
    process.stderr.write("FAIL: локальные health-файлы имеют неподдерживаемый формат.\n");
    process.exitCode = 1; return;
  }
  const age = Date.now() - report.checkedAt;
  const staleAfter = Math.max(2 * config.healthIntervalMs + 15_000, 75_000);
  process.stdout.write(`${formatHealthSummary(report)}\nВозраст отчёта: ${Math.max(0, Math.round(age / 1_000))} с; предел: ${Math.round(staleAfter / 1_000)} с.\n`);
  const failure = healthFailure(report, runtime, Date.now(), staleAfter, processAlive);
  if (failure) { process.stderr.write(`FAIL: ${failure}\n`); process.exitCode = 1; }
}

await main().catch(() => {
  process.stderr.write("FAIL: локальная health-проверка не завершилась. Секреты и исходная ошибка скрыты.\n");
  process.exitCode = 1;
});
