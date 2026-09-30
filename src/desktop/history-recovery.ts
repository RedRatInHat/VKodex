import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
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
  private readonly restoredPath = new Map<string, string>();

  constructor(private readonly tailer = new RolloutTailer()) {}

  enable(id: string, since: number): void {
    const previous = this.enabled.get(id);
    this.enabled.set(id, Math.min(previous ?? since, since));
    // The bridge reasserts detached observation on every tick. Clearing the
    // deadline for an already enabled observer turns its bounded recovery
    // reader into an unthrottled filesystem poll.
    if (previous === undefined) this.pollAfter.delete(id);
  }

  disable(id: string, task: TaskRef): void {
    this.enabled.delete(id);
    this.pollAfter.delete(id);
    this.restoredPath.delete(id);
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
      // Native edit/revert can create a paginated overlay whose inherited base
      // predates the durable boundary we already projected. Its later records
      // replace part of the old branch, not merely extend it. Until the old
      // source boundary is proven, neither deliver nor persist a new cursor.
      if (historyRebuilt && checkpoint && !await safePaginatedRotation(task, checkpoint)) {
        return { events: [], historyRebuilt, failure: "lineageUnverified" };
      }
      const path = task.rolloutPath ? comparablePath(task.rolloutPath) : "";
      if (this.restoredPath.get(id) !== path) {
        this.restoredPath.set(id, path);
        if (path && checkpoint?.rolloutCursor && checkpoint.rolloutPath
          && comparablePath(checkpoint.rolloutPath) === path) await this.tailer.restore(task, checkpoint.rolloutCursor);
      }
      const events = await this.tailer.poll(task, since, checkpoint?.quietTurnIds);
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
        ...(this.tailer.quietTurnIds(task).length ? { quietTurnIds: this.tailer.quietTurnIds(task) } : {}),
        ...(task.rolloutPath ? { rolloutPath: comparablePath(task.rolloutPath) } : {}),
        ...(task.rolloutPath && this.tailer.durableCursor(task)
          ? { rolloutCursor: this.tailer.durableCursor(task)! } : {}),
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

interface HistoryBase { readonly thread_id: string; readonly end_ordinal_exclusive: number; readonly end_byte_offset: number; }

async function safePaginatedRotation(task: TaskRef, checkpoint: TaskObservationCheckpoint): Promise<boolean> {
  if (!task.rolloutPath || !checkpoint.rolloutPath) return false;
  const header = await firstRolloutRecord(task.rolloutPath);
  if (!isObject(header)) return false;
  if (header.type !== "session_meta") return true;
  if (!isObject(header.payload)) return false;
  const payload = header.payload;
  // A rotated paginated segment without its base cannot establish whether it
  // appends to, replaces, or predates the already projected source history.
  if (payload.history_mode === "paginated" && !Object.hasOwn(payload, "history_base")) return false;
  if (!Object.hasOwn(payload, "history_base")) return true;
  if (payload.history_mode !== "paginated") return false;
  const base = payload.history_base;
  if (!isObject(base) || !validHistoryBase(base) || payload.id !== task.threadId
    || base.thread_id !== task.threadId || header.ordinal !== base.end_ordinal_exclusive) return false;
  const cursor = checkpoint.rolloutCursor;
  if (!cursor || cursor.version !== 1 || base.end_byte_offset !== cursor.offset
    || !Number.isSafeInteger(cursor.anchorLength) || cursor.anchorLength < 1 || cursor.anchorLength > 64
    || cursor.anchorLength > cursor.offset || !/^[a-f0-9]{64}$/u.test(cursor.anchorSha256)) return false;
  try {
    const oldHeader = await firstRolloutRecord(checkpoint.rolloutPath);
    if (!isObject(oldHeader) || oldHeader.type !== "session_meta" || !isObject(oldHeader.payload)
      || oldHeader.payload.id !== task.threadId) return false;
    const handle = await open(checkpoint.rolloutPath, "r");
    try {
      if ((await handle.stat()).size < cursor.offset) return false;
      const anchor = Buffer.alloc(cursor.anchorLength);
      const { bytesRead } = await handle.read(anchor, 0, anchor.length, cursor.offset - anchor.length);
      return bytesRead === anchor.length && anchor.at(-1) === 0x0a
        && createHash("sha256").update(anchor).digest("hex") === cursor.anchorSha256;
    } finally { await handle.close(); }
  } catch { return false; }
}

async function firstRolloutRecord(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return null;
    try { return JSON.parse(buffer.subarray(0, newline).toString("utf8")) as unknown; }
    catch { return null; }
  } finally { await handle.close(); }
}

function validHistoryBase(value: Record<string, unknown>): value is Record<string, unknown> & HistoryBase {
  return typeof value.thread_id === "string" && value.thread_id.length > 0
    && Number.isSafeInteger(value.end_ordinal_exclusive) && Number(value.end_ordinal_exclusive) >= 0
    && Number.isSafeInteger(value.end_byte_offset) && Number(value.end_byte_offset) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
