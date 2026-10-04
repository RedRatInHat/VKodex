import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { diagnosticId, readDiagnosticRecord, type DiagnosticRecord } from "../bridge/diagnostics.js";

export interface DiagnosticFilter {
  threadId?: string;
  attemptId?: string;
  operationId?: string;
  connectionAttemptId?: string;
  eventId?: string;
  peerId?: number;
  after?: string;
  before?: string;
  limit?: number;
}
/** Reads only bounded fixed segments. It never opens SQLite or connects to Codex. */
export async function diagnosticReport(directory: string, filter: DiagnosticFilter = {}) {
  const limit = filter.limit ?? 200;
  if (!path.isAbsolute(directory) || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
    throw new TypeError("Invalid diagnostic report bounds");
  const records: DiagnosticRecord[] = [];
  let filesRead = 0, invalidRecords = 0, unavailableFiles = 0, matched = 0;
  const wanted = { threadId: filter.threadId && diagnosticId(filter.threadId),
    attemptId: filter.attemptId && diagnosticId(filter.attemptId), operationId: filter.operationId && diagnosticId(filter.operationId),
    connectionAttemptId: filter.connectionAttemptId && diagnosticId(filter.connectionAttemptId) };
  for (let segment = 0; segment < 16; segment++) {
    const filename = path.join(directory, `trace-${String(segment).padStart(3, "0")}.jsonl`);
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) { unavailableFiles++; continue; }
      const handle = await open(filename, "r");
      let contents: string;
      try {
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1024 * 1024) { unavailableFiles++; continue; }
        contents = buffer.subarray(0, bytesRead).toString("utf8");
      } finally { await handle.close(); }
      filesRead++;
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let record: DiagnosticRecord | null;
        try { record = line.length <= 4096 ? readDiagnosticRecord(JSON.parse(line)) : null; } catch { record = null; }
        if (!record) { invalidRecords++; continue; }
        if (Object.entries(wanted).some(([key, value]) => value && record![key as keyof DiagnosticRecord] !== value)
            || filter.peerId !== undefined && record.peerId !== filter.peerId
            || filter.eventId !== undefined && record.eventId !== (/^message:\d{1,20}$/u.test(filter.eventId) ? filter.eventId : diagnosticId(filter.eventId))
            || filter.after !== undefined && record.at < filter.after
            || filter.before !== undefined && record.at > filter.before) continue;
        matched++; records.push(record);
        records.sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId) || a.seq - b.seq);
        if (records.length > limit) records.shift();
      }
    } catch { unavailableFiles++; }
  }
  return { schema: "vkodex.diagnostic-report.v1", readOnly: true, filesRead, invalidRecords, unavailableFiles,
    matched, truncated: matched > records.length, records };
}
