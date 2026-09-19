import type { TaskEvent, TaskRef } from "./codex-tasks.js";
import type { TaskObservationCheckpoint } from "./task-observation.js";

export interface TaskHistoryRecoveryResult {
  readonly events: readonly TaskEvent[];
  readonly historyRebuilt: boolean;
  readonly failure: "recordTooLarge" | "readFailed" | null;
}

export interface TaskHistoryRecovery {
  enable(id: string, since: number): void;
  disable(id: string, task: TaskRef): void;
  poll(id: string, task: TaskRef, checkpoint: TaskObservationCheckpoint | null, oldestAcceptedAt: number | null,
    acceptedTurnIds: ReadonlySet<string>, now: number): Promise<TaskHistoryRecoveryResult | null>;
}
