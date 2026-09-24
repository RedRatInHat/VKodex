import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { TransferConflictError } from "./contracts.js";
import { isObject } from "./ipc-client.js";
import { comparablePath } from "./paths.js";

interface Segment {
  readonly path: string;
  readonly threadId: string;
  readonly parentId?: string;
  readonly firstOrdinal?: number;
}

export interface RolloutSlice {
  readonly path: string;
  readonly from: number;
  readonly until: number;
}

async function firstRecord(file: string): Promise<Segment> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record: unknown;
      try { record = JSON.parse(line); } catch { break; }
      if (!isObject(record) || record.type !== "session_meta" || !isObject(record.payload)) break;
      const threadId = record.payload.id ?? record.payload.session_id;
      if (typeof threadId !== "string" || !threadId) break;
      return {
        path: file, threadId,
        ...(typeof record.payload.forked_from_id === "string" ? { parentId: record.payload.forked_from_id } : {}),
        ...(typeof record.ordinal === "number" ? { firstOrdinal: record.ordinal } : {}),
      };
    }
  } finally { lines.close(); input.destroy(); }
  throw new TransferConflictError("Сегмент истории Codex не содержит корректного заголовка. Копия не создана.");
}

async function candidates(home: string, threadId: string): Promise<Segment[]> {
  const result: Segment[] = [];
  const pending = [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (isObject(error) && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        try {
          const segment = await firstRecord(file);
          if (segment.threadId === threadId) result.push(segment);
        } catch (error) {
          if (error instanceof TransferConflictError) throw error;
          throw new TransferConflictError("Один из сегментов истории Codex не читается. Копия не создана.");
        }
      }
    }
  }
  return result;
}

/** A resumed paginated thread may have several rollouts. A fork may contain no
 * turns in its own leaf file, so follow the persisted ancestor prefix as well. */
export async function transferRolloutSlices(sourcePath: string, sourceHome: string): Promise<RolloutSlice[]> {
  const source = await firstRecord(sourcePath);
  if (source.firstOrdinal === undefined) return [{ path: sourcePath, from: 0, until: Infinity }];
  const visited = new Set<string>();
  const prefix = async (threadId: string, cutoff: number, required?: Segment): Promise<RolloutSlice[]> => {
    if (visited.has(threadId) || visited.size >= 16) {
      throw new TransferConflictError("Цепочка наследования истории Codex циклична или слишком длинна. Копия не создана.");
    }
    visited.add(threadId);
    const found = await candidates(sourceHome, threadId);
    if (required && !found.some(item => comparablePath(item.path) === comparablePath(required.path))) found.push(required);
    const segments = found.filter(item => item.firstOrdinal !== undefined && item.firstOrdinal < cutoff
      && (!required || item.firstOrdinal! <= required.firstOrdinal!))
      .sort((left, right) => left.firstOrdinal! - right.firstOrdinal!);
    if (!segments.length || required && comparablePath(segments.at(-1)!.path) !== comparablePath(required.path)) {
      throw new TransferConflictError("Не найдена полная цепочка журналов исходной задачи. Копия не создана.");
    }
    for (let i = 1; i < segments.length; i++) {
      if (segments[i]!.firstOrdinal === segments[i - 1]!.firstOrdinal) {
        throw new TransferConflictError("У истории Codex есть неоднозначные пересекающиеся сегменты. Копия не создана.");
      }
    }
    const first = segments[0]!;
    const inherited = first.firstOrdinal === 0 ? [] : first.parentId && first.parentId !== threadId
      ? await prefix(first.parentId, first.firstOrdinal!)
      : [];
    if (first.firstOrdinal !== 0 && !inherited.length) {
      throw new TransferConflictError("Начало истории задачи отсутствует в исходном каталоге. Копия не создана.");
    }
    return [...inherited, ...segments.map((item, index) => ({ path: item.path, from: item.firstOrdinal!,
      until: Math.min(cutoff, segments[index + 1]?.firstOrdinal ?? cutoff) }))];
  };
  return prefix(source.threadId, Infinity, source);
}
