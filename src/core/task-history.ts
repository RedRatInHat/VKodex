import type { TaskEvent, TaskRef } from "./codex-tasks.js";
import type { TaskObservationCheckpoint } from "./task-observation.js";

export interface TaskHistoryRecoveryResult {
  readonly events: readonly TaskEvent[];
  readonly historyRebuilt: boolean;
  /**
   * Durable observation boundary after a successful recovery poll.  The
   * bridge persists it only after projecting the returned events, so a
   * restart resumes after the exact point that was observed.
   */
  readonly checkpoint?: TaskObservationCheckpoint;
  readonly failure: "recordTooLarge" | "readFailed" | null;
}

export interface TaskHistoryRecovery {
  enable(id: string, since: number): void;
  disable(id: string, task: TaskRef): void;
  poll(id: string, task: TaskRef, checkpoint: TaskObservationCheckpoint | null, oldestAcceptedAt: number | null,
    acceptedTurnIds: ReadonlySet<string>, now: number): Promise<TaskHistoryRecoveryResult | null>;
}
