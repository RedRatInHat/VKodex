import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RuntimeProcessStatus = "running" | "stopped";

export interface RuntimeProcessState {
  readonly status: RuntimeProcessStatus;
  readonly pid: number;
  readonly at: number;
  readonly startedAt: number;
  readonly exitCode?: number;
  readonly reason?: string;
}

/** Best-effort operational metadata. Never include configuration or exception text. */
export function writeRuntimeProcessState(dataDir: string, state: RuntimeProcessState): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, "runtime-process.json"), `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // A diagnostic write must never prevent startup or shutdown.
  }
}
