import type { TaskEvent, TaskRef } from "./contracts.js";
import { comparablePath } from "./paths.js";
import type { ProjectionCheckpoint } from "./projector.js";
import { RolloutRecordTooLargeError, RolloutTailer } from "./rollout-tailer.js";

export interface TaskHistoryRecoveryResult {
  readonly events: readonly TaskEvent[];
  readonly historyRebuilt: boolean;
  readonly failure: "recordTooLarge" | "readFailed" | null;
}

export interface TaskHistoryRecovery {
  enable(id: string, since: number): void;
  disable(id: string, task: TaskRef): void;
  poll(id: string, task: TaskRef, checkpoint: ProjectionCheckpoint | null, oldestAcceptedAt: number | null,
    acceptedTurnIds: ReadonlySet<string>, now: number): Promise<TaskHistoryRecoveryResult | null>;
}

/** Recovery-only transport for visible events missed by the live task owner. */
export class RolloutTaskHistoryRecovery implements TaskHistoryRecovery {
  private readonly enabled = new Map<string, number>();
  private readonly pollAfter = new Map<string, number>();

  constructor(private readonly tailer = new RolloutTailer()) {}

  enable(id: string, since: number): void {
    this.enabled.set(id, Math.min(this.enabled.get(id) ?? since, since));
    this.pollAfter.delete(id);
  }

  disable(id: string, task: TaskRef): void {
    this.enabled.delete(id);
    this.pollAfter.delete(id);
    this.tailer.clear(task);
  }

  async poll(id: string, task: TaskRef, checkpoint: ProjectionCheckpoint | null, oldestAcceptedAt: number | null,
    acceptedTurnIds: ReadonlySet<string>, now: number): Promise<TaskHistoryRecoveryResult | null> {
    const enabledSince = this.enabled.get(id);
    if (enabledSince === undefined || now < (this.pollAfter.get(id) ?? 0)) return null;
    this.pollAfter.set(id, now + 1_000);
    const historyRebuilt = !!checkpoint?.rolloutPath && !!task.rolloutPath
      && comparablePath(checkpoint.rolloutPath) !== comparablePath(task.rolloutPath);
    const since = Math.min(checkpoint?.lastObservedAt ?? checkpoint?.since ?? Infinity,
      oldestAcceptedAt ?? Infinity, enabledSince);
    try {
      const events = await this.tailer.poll(task, since);
      return { events: historyRebuilt ? events.filter(event => acceptedTurnIds.has(event.turnId)) : events,
        historyRebuilt, failure: null };
    } catch (error) {
      return { events: [], historyRebuilt, failure: error instanceof RolloutRecordTooLargeError ? "recordTooLarge" : "readFailed" };
    }
  }
}
