import { open, stat } from "node:fs/promises";
import { normalize } from "node:path";
import type { TaskEvent, TaskRef } from "./contracts.js";

interface Cursor { readonly offset: number; readonly pending: Buffer; readonly anchor: Buffer; }

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

  constructor(private readonly initialWindowBytes = 8 * 1024 * 1024, private readonly maxReadBytes = 16 * 1024 * 1024,
    private readonly maxRecordBytes = 32 * 1024 * 1024) {
    if (!Number.isInteger(initialWindowBytes) || initialWindowBytes <= 0) throw new RangeError("Initial rollout window must be positive");
    if (!Number.isInteger(maxReadBytes) || maxReadBytes <= 0) throw new RangeError("Maximum rollout read must be positive");
    if (!Number.isInteger(maxRecordBytes) || maxRecordBytes <= 0) throw new RangeError("Maximum rollout record must be positive");
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
    const fresh = !saved || saved.offset > info.size || !await this.matchesAnchor(path, saved);
    const start = fresh ? await this.initialOffset(path, info.size, since) : saved.offset;
    if (start >= info.size) return [];
    const length = Math.min(this.maxReadBytes, info.size - start);
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(path, "r");
    let bytesRead = 0;
    try { ({ bytesRead } = await handle.read(buffer, 0, length, start)); } finally { await handle.close(); }
    if (bytesRead === 0) return [];
    const data = saved && !fresh && saved.pending.length
      ? Buffer.concat([saved.pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);

    // A single tool record may span multiple bounded reads. Keep its bytes
    // until LF rather than repeatedly reading the same first block forever.
    const last = data.lastIndexOf(0x0a);
    const pending = last < 0 ? data : data.subarray(last + 1);
    if (pending.length > this.maxRecordBytes) throw new RolloutRecordTooLargeError();
    const complete = last < 0 ? Buffer.alloc(0) : data.subarray(0, last);
    if (complete.length > this.maxRecordBytes && !complete.includes(0x0a)) throw new RolloutRecordTooLargeError();
    if (last < 0) {
      this.cursors.set(key, { offset: start + bytesRead, pending: Buffer.from(pending), anchor: this.anchor(buffer, bytesRead) });
      return [];
    }
    const lines = complete.toString("utf8").split("\n");
    const records: RolloutRecord[] = [];
    for (const line of lines) {
      if (Buffer.byteLength(line) > this.maxRecordBytes) throw new RolloutRecordTooLargeError();
      const record = parseRecord(line);
      if (record && record.timestamp >= since) records.push(record);
    }
    this.cursors.set(key, { offset: start + bytesRead, pending: Buffer.from(pending), anchor: this.anchor(buffer, bytesRead) });
    return records.map(record => record.event);
  }

  private anchor(buffer: Buffer, length: number): Buffer { return Buffer.from(buffer.subarray(Math.max(0, length - 64), length)); }

  private async matchesAnchor(path: string, cursor: Cursor): Promise<boolean> {
    if (cursor.anchor.length === 0 || cursor.offset < cursor.anchor.length) return false;
    const buffer = Buffer.allocUnsafe(cursor.anchor.length);
    const handle = await open(path, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset - buffer.length);
      return bytesRead === buffer.length && buffer.equals(cursor.anchor);
    } finally { await handle.close(); }
  }

  private async initialOffset(path: string, size: number, since: number): Promise<number> {
    // A fixed tail window can silently skip a final when a busy task appends
    // more than that window during an outage. Expand backwards until the first
    // complete record predates the recovery boundary. Codex rollouts are
    // chronological append-only logs; if a probe cannot be parsed, scan from
    // the beginning instead of guessing a safe offset.
    let window = Math.min(this.initialWindowBytes, size);
    const handle = await open(path, "r");
    try {
      while (window < size) {
        const start = size - window;
        const length = Math.min(this.maxReadBytes, window);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const data = buffer.subarray(0, bytesRead);
        const first = data.indexOf(0x0a) + 1;
        const last = first > 0 ? data.indexOf(0x0a, first) : -1;
        if (last < first) return 0;
        try {
          const record = JSON.parse(data.subarray(first, last).toString("utf8")) as { timestamp?: unknown };
          const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
          if (!Number.isFinite(timestamp)) return 0;
          if (timestamp < since) return start + first;
        } catch { return 0; }
        window = Math.min(size, window * 2);
      }
      return 0;
    } finally { await handle.close(); }
  }

  private key(task: TaskRef): string { return JSON.stringify([task.sourceId ?? "", task.threadId, task.rolloutPath ?? ""]); }
}

export class RolloutRecordTooLargeError extends Error {
  constructor() { super("Codex rollout record exceeds the bounded recovery reader"); this.name = "RolloutRecordTooLargeError"; }
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
