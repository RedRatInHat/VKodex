import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDesktopBridgeConfig } from "../bridge/config.js";
import { formatHealthSummary } from "../bridge/health.js";
import type { BridgeHealthSnapshot, HealthState } from "../bridge/contracts.js";
import { isObject } from "./ipc-client.js";

function snapshot(value: unknown): BridgeHealthSnapshot | null {
  if (!isObject(value) || !["ok", "degraded", "failed"].includes(String(value.state)) || typeof value.checkedAt !== "number"
    || typeof value.pid !== "number" || typeof value.uptimeSeconds !== "number" || !Array.isArray(value.checks)) return null;
  const checks = value.checks.filter(isObject);
  if (checks.length !== value.checks.length || checks.some(check => typeof check.name !== "string" || typeof check.detail !== "string"
    || !["ok", "degraded", "failed"].includes(String(check.state)))) return null;
  return value as unknown as BridgeHealthSnapshot;
}

async function main(): Promise<void> {
  const config = loadDesktopBridgeConfig();
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path.join(config.dataDir, "health.json"), "utf8")); }
  catch {
    process.stderr.write("FAIL: health.json отсутствует или повреждён. Мост ещё не прошёл health check.\n");
    process.exitCode = 1; return;
  }
  const report = snapshot(parsed);
  if (!report) {
    process.stderr.write("FAIL: health.json имеет неподдерживаемый формат.\n");
    process.exitCode = 1; return;
  }
  const age = Date.now() - report.checkedAt;
  const staleAfter = Math.max(2 * config.healthIntervalMs + 15_000, 75_000);
  process.stdout.write(`${formatHealthSummary(report)}\nВозраст отчёта: ${Math.max(0, Math.round(age / 1_000))} с; предел: ${Math.round(staleAfter / 1_000)} с.\n`);
  const state = report.state as HealthState;
  if (age < 0 || age > staleAfter || state !== "ok") process.exitCode = 1;
}

await main().catch(() => {
  process.stderr.write("FAIL: локальная health-проверка не завершилась. Секреты и исходная ошибка скрыты.\n");
  process.exitCode = 1;
});
