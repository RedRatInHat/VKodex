import path from "node:path";
import pino, { type DestinationStream, type Logger } from "pino";

const RUN_ID = /^\d{8}-\d{9}-[a-f0-9]{8}$/u;
const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function desktopLogPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const runId = env.VKODEX_RUN_ID?.trim();
  return path.join(dataDir, "logs", runId && RUN_ID.test(runId) ? `vkodex-${runId}.log` : "vkodex.log");
}

export function createDesktopLogger(dataDir: string, env: NodeJS.ProcessEnv = process.env, consoleStream: DestinationStream = process.stdout): Logger {
  const requestedLevel = env.LOG_LEVEL?.trim().toLowerCase();
  const level = requestedLevel && LOG_LEVELS.has(requestedLevel) ? requestedLevel : "info";
  const file = pino.destination({ dest: desktopLogPath(dataDir, env), mkdir: true, sync: true });
  return pino({ level, base: { pid: process.pid }, timestamp: pino.stdTimeFunctions.isoTime }, pino.multistream([
    { level: "trace", stream: consoleStream },
    { level: "trace", stream: file },
  ]));
}
