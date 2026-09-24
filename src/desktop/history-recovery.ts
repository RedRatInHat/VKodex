import { createHash } from "node:crypto";
import type { TaskEvent, TaskRef } from "./contracts.js";
import type { TaskHistoryRecovery, TaskHistoryRecoveryResult } from "../core/task-history.js";
import type { TaskObservationCheckpoint } from "../core/task-observation.js";
import { comparablePath } from "./paths.js";
import { RolloutRecordTooLargeError, RolloutTailer } from "./rollout-tailer.js";

export type { TaskHistoryRecovery, TaskHistoryRecoveryResult } from "../core/task-history.js";

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

  async poll(id: string, task: TaskRef, checkpoint: TaskObservationCheckpoint | null, oldestAcceptedAt: number | null,
    acceptedTurnIds: ReadonlySet<string>, now: number): Promise<TaskHistoryRecoveryResult | null> {
    const enabledSince = this.enabled.get(id);
    if (enabledSince === undefined || now < (this.pollAfter.get(id) ?? 0)) return null;
    this.pollAfter.set(id, now + 1_000);
    const historyRebuilt = !!checkpoint?.rolloutPath && !!task.rolloutPath
      && comparablePath(checkpoint.rolloutPath) !== comparablePath(task.rolloutPath);
    // A transfer keeps the VK binding ID but advances its observation epoch.
    // Do not let the source task's in-memory fallback boundary pull the target
    // fork back into its freshly timestamped inherited history.
    const currentEpoch = checkpoint?.since ?? -Infinity;
    const since = Math.min(checkpoint?.lastObservedAt ?? checkpoint?.since ?? Infinity,
      oldestAcceptedAt ?? Infinity, Math.max(enabledSince, currentEpoch));
    try {
      const events = await this.tailer.poll(task, since);
      // A rebuilt rollout contains both the old branch and anything that was
      // written directly in Codex while VKodex was detached.  The old code
      // allowed only accepted VK turns through the first poll, which silently
      // discarded direct-app turns until the next VK message reacquired the
      // live stream.  Keep known history out by identity and semantic content,
      // while allowing new turns from either source through immediately.
      const visible = historyRebuilt ? newRolloutEvents(events, checkpoint, acceptedTurnIds) : events;
      const nextCheckpoint: TaskObservationCheckpoint = {
        since: checkpoint?.since ?? (Number.isFinite(enabledSince) ? enabledSince : now),
        lastObservedAt: now,
        activeAtAttach: checkpoint?.activeAtAttach ?? [],
        active: checkpoint?.active ?? [],
        seen: checkpoint?.seen ?? {},
        semanticByIdentity: checkpoint?.semanticByIdentity ?? {},
        ...(task.rolloutPath ? { rolloutPath: comparablePath(task.rolloutPath) } : {}),
      };
      return { events: visible, historyRebuilt, checkpoint: nextCheckpoint, failure: null };
    } catch (error) {
      return { events: [], historyRebuilt, failure: error instanceof RolloutRecordTooLargeError ? "recordTooLarge" : "readFailed" };
    }
  }
}

function newRolloutEvents(events: readonly TaskEvent[], checkpoint: TaskObservationCheckpoint | null,
  acceptedTurnIds: ReadonlySet<string>): TaskEvent[] {
  const seen = new Set(Object.keys(checkpoint?.seen ?? {}));
  const semanticCounts = new Map<string, number>();
  for (const semantic of Object.values(checkpoint?.semanticByIdentity ?? {})) semanticCounts.set(semantic, (semanticCounts.get(semantic) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return events.filter(event => {
    if (acceptedTurnIds.has(event.turnId)) return true;
    const identity = JSON.stringify([event.turnId, event.type, event.id]);
    if (seen.has(identity)) return false;
    if (event.type === "status") return true;
    const semantic = digest(JSON.stringify([event.type, event.text.replace(/\r\n?/gu, "\n").trimEnd()]));
    const occurrence = occurrences.get(semantic) ?? 0;
    occurrences.set(semantic, occurrence + 1);
    return occurrence >= (semanticCounts.get(semantic) ?? 0);
  });
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
