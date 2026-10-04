import { open, mkdir, appendFile as fsAppendFile } from "node:fs/promises";
import path from "node:path";
import type { DiagnosticRecord, DiagnosticSink } from "../bridge/diagnostics.js";

const SEGMENT_COUNT = 16;
const SEGMENT_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_QUEUE_RECORDS = 512;

type AppendFile = (filePath: string, data: string, options: { encoding: "utf8" }) => Promise<void>;

/** The append hook makes slow and failing filesystems deterministic in tests. */
export interface DiagnosticLogOptions {
  appendFile?: AppendFile;
}

export interface DiagnosticLogStatus {
  state: "ready" | "disabled" | "full";
  written: number;
  dropped: number;
  failed: number;
}

export interface DiagnosticLog {
  write: DiagnosticSink;
  flush(): Promise<void>;
  status(): DiagnosticLogStatus;
}

interface QueueEntry {
  line: string;
  bytes: number;
  resolve: () => void;
}

function segmentName(index: number): string {
  return `trace-${String(index).padStart(3, "0")}.jsonl`;
}

/**
 * Creates a private, bounded JSONL sink. Initialization and writes are best effort:
 * filesystem faults disable the sink and never escape to diagnostic callers.
 */
export async function createDiagnosticLog(directory: string, options: DiagnosticLogOptions = {}): Promise<DiagnosticLog> {
  const queue: QueueEntry[] = [];
  let queuedBytes = 0;
  let active = false;
  let pumpTask: Promise<void> | undefined;
  let state: DiagnosticLogStatus["state"] = "ready";
  let segmentPath: string | undefined;
  let segmentBytes = 0;
  let written = 0;
  let dropped = 0;
  let failed = 0;
  const append = options.appendFile ?? fsAppendFile;

  const finishEntry = (entry: QueueEntry): void => {
    queuedBytes -= entry.bytes;
    entry.resolve();
  };

  let pump: () => Promise<void>;
  const flush = async (): Promise<void> => {
    try {
      while (active || queue.length > 0) {
        const pending = pumpTask ?? pump();
        await pending;
      }
    } catch {
      // Keep flush observational, including unexpected filesystem errors.
    }
  };

  pump = (): Promise<void> => {
    if (pumpTask) return pumpTask;
    active = true;
    const task = (async (): Promise<void> => {
      try {
        while (queue.length > 0 && state === "ready") {
          const entry = queue[0]!;
          try {
            if (segmentPath === undefined || segmentBytes + entry.bytes > SEGMENT_BYTES) {
              const next = await allocateSegment(directory);
              if (next === undefined) {
                state = "full";
                break;
              }
              segmentPath = next;
              segmentBytes = 0;
            }
            await append(segmentPath, entry.line, { encoding: "utf8" });
            segmentBytes += entry.bytes;
            written += 1;
          } catch {
            failed += 1;
            state = "disabled";
          }
          queue.shift();
          finishEntry(entry);
        }
      } finally {
        active = false;
        if (state !== "ready") {
          for (const entry of queue.splice(0)) {
            dropped += 1;
            finishEntry(entry);
          }
        }
      }
    })();
    pumpTask = task.finally(() => {
      pumpTask = undefined;
      // A write can enqueue after the pump loop sees an empty queue but before
      // this finalizer clears pumpTask. Restart here so that entry is not stranded.
      if (state === "ready" && queue.length > 0) void pump();
    });
    return pumpTask;
  };

  const write: DiagnosticSink = (record: DiagnosticRecord): Promise<void> => {
    try {
      if (state !== "ready") {
        dropped += 1;
        return Promise.resolve();
      }
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > MAX_RECORD_BYTES || queue.length >= MAX_QUEUE_RECORDS || queuedBytes + bytes > MAX_QUEUE_BYTES) {
        dropped += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const entry = { line, bytes, resolve };
        queue.push(entry);
        queuedBytes += bytes;
        void pump();
      });
    } catch {
      dropped += 1;
      return Promise.resolve();
    }
  };

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Each process/run owns the segment it creates. Existing segments, even
    // partially filled ones, are never appended by a later process.
    segmentPath = await allocateSegment(directory);
    if (segmentPath === undefined) state = "full";
  } catch {
    state = "disabled";
  }

  return {
    write,
    flush,
    status: () => ({ state, written, dropped, failed }),
  };
}

async function allocateSegment(directory: string): Promise<string | undefined> {
  for (let index = 0; index < SEGMENT_COUNT; index += 1) {
    const filePath = path.join(directory, segmentName(index));
    try {
      const handle = await open(filePath, "wx", 0o600);
      await handle.close();
      return filePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return undefined;
}
