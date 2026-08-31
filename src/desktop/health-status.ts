import type { BridgeHealthSnapshot } from "../bridge/contracts.js";
import { isObject } from "./ipc-client.js";
import type { RuntimeProcessState } from "./process-state.js";

export function parseHealthSnapshot(value: unknown): BridgeHealthSnapshot | null {
  if (!isObject(value) || !["ok", "degraded", "failed"].includes(String(value.state)) || typeof value.checkedAt !== "number"
    || typeof value.pid !== "number" || typeof value.uptimeSeconds !== "number" || !Array.isArray(value.checks)) return null;
  const checks = value.checks.filter(isObject);
  if (checks.length !== value.checks.length || checks.some(check => typeof check.name !== "string" || typeof check.detail !== "string"
    || !["ok", "degraded", "failed"].includes(String(check.state)))) return null;
  return value as unknown as BridgeHealthSnapshot;
}

export function parseRuntimeProcessState(value: unknown): RuntimeProcessState | null {
  if (!isObject(value) || !["running", "stopped"].includes(String(value.status))
    || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.at !== "number" || typeof value.startedAt !== "number") return null;
  return value as unknown as RuntimeProcessState;
}

export function healthFailure(
  report: BridgeHealthSnapshot,
  runtime: RuntimeProcessState,
  now: number,
  staleAfter: number,
  processAlive: (pid: number) => boolean,
): string | null {
  const age = now - report.checkedAt;
  if (runtime.status !== "running") return "runtime-process.json сообщает, что мост остановлен.";
  if (runtime.pid !== report.pid || report.checkedAt < runtime.startedAt) return "health.json относится к предыдущему процессу VKodex.";
  if (!processAlive(runtime.pid)) return "Процесс из runtime-process.json больше не существует.";
  if (age < 0 || age > staleAfter) return "health.json устарел.";
  if (report.state !== "ok") return `Состояние моста: ${report.state.toUpperCase()}.`;
  return null;
}

