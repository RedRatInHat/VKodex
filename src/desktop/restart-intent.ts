import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskRef } from "../core/codex-tasks.js";
import type { BridgeStore } from "../bridge/store.js";

export const RESTART_INTENT_FILE = "restart-intent.json";

export interface RestartTaskSnapshot extends TaskRef {
  readonly bindingId: string;
  readonly title: string;
  readonly generation: number;
  readonly activeTurnId: string | null;
}

export interface RestartIntent {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly sourcePid: number;
  readonly tasks: readonly RestartTaskSnapshot[];
}

const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/u.test(value);
const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]/u.test(value);

export function restartIntentPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), RESTART_INTENT_FILE);
}

export function parseRestartIntent(value: unknown): RestartIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restart intent");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !safeId(record.id) || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.sourcePid)
    || !Array.isArray(record.tasks) || record.tasks.length > 100) throw new Error("Invalid restart intent");
  const tasks = record.tasks.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restart task");
    const task = value as Record<string, unknown>;
    if (!safeId(task.bindingId) || !safeText(task.hostId, 200) || !safeText(task.threadId, 200) || !safeText(task.title, 500)
      || !Number.isSafeInteger(task.generation) || Number(task.generation) < 0
      || !(task.activeTurnId === null || safeText(task.activeTurnId, 200))
      || !(task.sourceId === undefined || safeText(task.sourceId, 500))) throw new Error("Invalid restart task");
    return {
      bindingId: task.bindingId,
      hostId: task.hostId,
      threadId: task.threadId,
      title: task.title,
      generation: task.generation,
      activeTurnId: task.activeTurnId,
      ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    } as RestartTaskSnapshot;
  });
  return { version: 1, id: record.id, createdAt: Number(record.createdAt), sourcePid: Number(record.sourcePid), tasks };
}

export async function readRestartIntent(dataDir: string): Promise<RestartIntent | null> {
  try { return parseRestartIntent(JSON.parse(await readFile(restartIntentPath(dataDir), "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function captureRestartIntent(store: BridgeStore, dataDir: string, sourcePid: number, now = Date.now()): Promise<RestartIntent> {
  const id = randomUUID();
  const tasks = store.bindings().flatMap(binding => {
    const details = store.getValue<{ status?: string }>(`task-details:${binding.id}`);
    if (!binding.attached || binding.peerId === null || details?.status !== "running") return [];
    const activity = store.getValue<{ turnId?: string | null }>(`activity:${binding.id}`);
    return [{
      bindingId: binding.id,
      hostId: binding.hostId,
      threadId: binding.threadId,
      title: binding.title,
      generation: store.streamGeneration(binding.id),
      activeTurnId: typeof activity?.turnId === "string" && activity.turnId ? activity.turnId : null,
      ...(binding.sourceId ? { sourceId: binding.sourceId } : {}),
    } satisfies RestartTaskSnapshot];
  });
  const intent: RestartIntent = { version: 1, id, createdAt: now, sourcePid, tasks };
  const destination = restartIntentPath(dataDir);
  const temporary = path.join(path.dirname(destination), `restart-intent.${id}.pending`);
  await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { await rename(temporary, destination); }
  catch (error) {
    // Preserve the complete snapshot under its unique pending name for manual
    // inspection; never overwrite an earlier unconsumed restart request.
    throw error;
  }
  return intent;
}

export async function archiveRestartIntent(dataDir: string, intent: RestartIntent): Promise<string> {
  const source = restartIntentPath(dataDir);
  const destination = path.join(path.dirname(source), `restart-intent.completed-${intent.id}.json`);
  await rename(source, destination);
  return destination;
}
