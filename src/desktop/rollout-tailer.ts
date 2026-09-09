import { open, stat } from "node:fs/promises";
import { normalize } from "node:path";
import type { TaskEvent, TaskRef } from "./contracts.js";

interface Cursor { readonly offset: number; }

interface RolloutRecord {
  readonly timestamp: number;
  readonly event: TaskEvent;
}

/**
 * Incremental reader for the append-only Codex rollout. It is deliberately a
 * recovery transport: live IPC remains the primary source. When a renderer
 * reports an owner but never publishes a stream snapshot, this lets the bridge
 * mirror new visible assistant messages without replaying old conversation.
 */
export class RolloutTailer {
  private readonly cursors = new Map<string, Cursor>();

  constructor(private readonly initialWindowBytes = 8 * 1024 * 1024, private readonly maxReadBytes = 16 * 1024 * 1024) {
    if (!Number.isInteger(initialWindowBytes) || initialWindowBytes <= 0) throw new RangeError("Initial rollout window must be positive");
    if (!Number.isInteger(maxReadBytes) || maxReadBytes <= 0) throw new RangeError("Maximum rollout read must be positive");
  }

  clear(task: TaskRef): void { this.cursors.delete(this.key(task)); }

  async poll(task: TaskRef, since: number): Promise<readonly TaskEvent[]> {
    if (!task.rolloutPath || !Number.isFinite(since)) return [];
    const path = rolloutPath(task.rolloutPath);
    let info;
    try { info = await stat(path); } catch { return []; }
    if (!info.isFile() || info.size <= 0) return [];

    const key = this.key(task);
    const saved = this.cursors.get(key);
    const fresh = !saved || saved.offset > info.size;
    const start = fresh ? Math.max(0, info.size - this.initialWindowBytes) : saved.offset;
    if (start >= info.size) return [];
    const length = Math.min(this.maxReadBytes, info.size - start);
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(path, "r");
    try { await handle.read(buffer, 0, length, start); } finally { await handle.close(); }

    // A read can begin in the middle of a JSONL record. Do not parse that
    // fragment; subsequent reads always resume after a complete LF-delimited
    // record. Codex rollouts use UTF-8, and LF is an ASCII byte.
    const first = fresh && start > 0 ? buffer.indexOf(0x0a) + 1 : 0;
    const last = buffer.lastIndexOf(0x0a);
    if (last < first) return [];
    this.cursors.set(key, { offset: start + last + 1 });
    const lines = buffer.subarray(first, last).toString("utf8").split("\n");
    const records: RolloutRecord[] = [];
    for (const line of lines) {
      const record = parseRecord(line);
      if (record && record.timestamp >= since) records.push(record);
    }
    return records.map(record => record.event);
  }

  private key(task: TaskRef): string { return JSON.stringify([task.sourceId ?? "", task.threadId, task.rolloutPath ?? ""]); }
}

function rolloutPath(value: string): string {
  // Win32 extended-length paths work for the app but Node's fs promises is more
  // reliable with the ordinary absolute spelling when this process is started
  // from a scheduled task.
  return normalize(value.replace(/^\\\\\?\\/u, ""));
}

function parseRecord(line: string): RolloutRecord | null {
  let record: unknown;
  try { record = JSON.parse(line) as unknown; } catch { return null; }
  if (!isObject(record) || typeof record.timestamp !== "string" || !isObject(record.payload) || typeof record.type !== "string") return null;
  const timestamp = Date.parse(record.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  const payload = record.payload;
  if (record.type === "response_item") {
    const item = payload;
    if (item.type !== "message" || item.role !== "assistant" || typeof item.id !== "string") return null;
    const phase = typeof item.phase === "string" ? item.phase : undefined;
    const text = outputText(item.content);
    const turnId = turnIdFrom(item);
    if (!text || !turnId) return null;
    if (phase === "commentary") return { timestamp, event: { type: "progress", id: item.id, turnId, text } };
    if (phase === "final" || phase === "final_answer") return { timestamp, event: { type: "final", id: item.id, turnId, text } };
    return null;
  }
  if (record.type === "event_msg") {
    const event = payload;
    if (event.type !== "task_complete" || typeof event.turn_id !== "string") return null;
    const id = `status:${event.turn_id}`;
    return { timestamp, event: { type: "status", id, turnId: event.turn_id, status: "completed" } };
  }
  return null;
}

function turnIdFrom(item: Record<string, unknown>): string | null {
  if (isObject(item.internal_chat_message_metadata_passthrough) && typeof item.internal_chat_message_metadata_passthrough.turn_id === "string") {
    return item.internal_chat_message_metadata_passthrough.turn_id;
  }
  return typeof item.turn_id === "string" ? item.turn_id : null;
}

function outputText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value.filter(isObject).filter(part => part.type === "output_text" && typeof part.text === "string")
    .map(part => part.text as string).join("\n");
  return text || null;
}

function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
