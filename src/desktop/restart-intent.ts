import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type { TaskRef } from "../core/codex-tasks.js";
import type { BridgeStore } from "../bridge/store.js";

export const RESTART_INTENT_FILE = "restart-intent.json";

export interface RestartTaskSnapshot extends TaskRef {
  readonly bindingId: string;
  readonly title: string;
  readonly generation: number;
  readonly activeTurnId: string | null;
  /** Exact managed owner at capture time; absent for native-owned tasks. */
  readonly ownerEpoch?: string;
  readonly ownerClaimId?: string;
  readonly ownerClaimRevision?: number;
}

interface RestartIntentMetadata {
  readonly id: string;
  readonly createdAt: number;
  readonly sourcePid: number;
  readonly tasks: readonly RestartTaskSnapshot[];
}

export type RestartRecoveryPolicy = "resume-interrupted" | "reconcile-only";
export type RestartIntent = RestartIntentMetadata & (
  { readonly version: 1 } |
  { readonly version: 2; readonly recoveryPolicy: "reconcile-only" }
);

/** Validate before reading configuration, capturing a snapshot or signalling a process. */
export function parseRestartRecoveryPolicy(args: readonly string[]): RestartRecoveryPolicy {
  if (args.length === 0) return "resume-interrupted";
  if (args.length === 2 && args[0] === "--recovery-policy" &&
    (args[1] === "resume-interrupted" || args[1] === "reconcile-only")) return args[1];
  throw new Error("Invalid restart recovery policy arguments");
}

const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/u.test(value);
const safeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]/u.test(value);

export function restartIntentPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), RESTART_INTENT_FILE);
}

export function parseRestartIntent(value: unknown): RestartIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restart intent");
  const record = value as Record<string, unknown>;
  const keys = ["version", "id", "createdAt", "sourcePid", "tasks", ...(record.version === 2 ? ["recoveryPolicy"] : [])];
  if (Object.keys(record).some(key => !keys.includes(key))) throw new Error("Invalid restart intent");
  if (!(record.version === 1 && record.recoveryPolicy === undefined ||
      record.version === 2 && record.recoveryPolicy === "reconcile-only")
    || !safeId(record.id) || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.sourcePid)
    || !Array.isArray(record.tasks) || record.tasks.length > 100) throw new Error("Invalid restart intent");
  const tasks = record.tasks.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restart task");
    const task = value as Record<string, unknown>;
    if (!safeId(task.bindingId) || !safeText(task.hostId, 200) || !safeText(task.threadId, 200) || !safeText(task.title, 500)
      || !Number.isSafeInteger(task.generation) || Number(task.generation) < 0
      || !(task.activeTurnId === null || safeText(task.activeTurnId, 200))
      || !(task.sourceId === undefined || safeText(task.sourceId, 500))
      || !(task.ownerEpoch === undefined && task.ownerClaimId === undefined && task.ownerClaimRevision === undefined ||
        safeId(task.ownerEpoch) && safeId(task.ownerClaimId) &&
        Number.isSafeInteger(task.ownerClaimRevision) && Number(task.ownerClaimRevision) >= 0))
      throw new Error("Invalid restart task");
    return {
      bindingId: task.bindingId,
      hostId: task.hostId,
      threadId: task.threadId,
      title: task.title,
      generation: task.generation,
      activeTurnId: task.activeTurnId,
      ...(task.ownerEpoch ? { ownerEpoch: task.ownerEpoch } : {}),
      ...(task.ownerClaimId ? { ownerClaimId: task.ownerClaimId,
        ownerClaimRevision: Number(task.ownerClaimRevision) } : {}),
      ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    } as RestartTaskSnapshot;
  });
  const metadata = { id: record.id, createdAt: Number(record.createdAt), sourcePid: Number(record.sourcePid), tasks };
  return record.version === 2 ? { ...metadata, version: 2, recoveryPolicy: "reconcile-only" }
    : { ...metadata, version: 1 };
}

export async function readRestartIntent(dataDir: string): Promise<RestartIntent | null> {
  try { return parseRestartIntent(JSON.parse(await readFile(restartIntentPath(dataDir), "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Serializes cooperating current-version journal writers across processes.
 * Only bounded local file operations run in this transaction, never RPC/await.
 * Old helpers and external file edits are not covered by this protocol. */
function withRestartIntentLock<T>(dataDir: string, work: () => T): T {
  const db = new DatabaseConstructor(path.join(path.resolve(dataDir), "restart-intent-lock.sqlite"), { timeout: 100 });
  try { return db.transaction(work).immediate(); }
  finally { db.close(); }
}

async function writeRestartIntent(tasks: readonly RestartTaskSnapshot[], dataDir: string, sourcePid: number, now: number,
  recoveryPolicy: RestartRecoveryPolicy): Promise<RestartIntent> {
  if (recoveryPolicy !== "resume-interrupted" && recoveryPolicy !== "reconcile-only") throw new Error("Invalid restart recovery policy");
  const id = randomUUID();
  const intent = parseRestartIntent({ id, createdAt: now, sourcePid, tasks,
    ...(recoveryPolicy === "reconcile-only" ? { version: 2, recoveryPolicy } : { version: 1 }) });
  const destination = restartIntentPath(dataDir);
  const temporary = path.join(path.dirname(destination), `restart-intent.${id}.pending`);
  await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    withRestartIntentLock(dataDir, () => {
      if (existsSync(destination)) throw new Error("An unconsumed restart intent already exists");
      renameSync(temporary, destination);
    });
  }
  catch (error) {
    // Preserve the complete snapshot under its unique pending name for manual
    // inspection; never overwrite an earlier unconsumed restart request.
    throw error;
  }
  return intent;
}

export async function captureRestartIntent(store: BridgeStore, dataDir: string, sourcePid: number, now = Date.now(),
  recoveryPolicy: RestartRecoveryPolicy = "resume-interrupted"): Promise<RestartIntent> {
  const tasks = store.bindings().flatMap(binding => {
    const details = store.getValue<{ status?: string }>(`task-details:${binding.id}`);
    if (!binding.attached || binding.peerId === null || details?.status !== "running") return [];
    const activity = store.getValue<{ turnId?: string | null }>(`activity:${binding.id}`);
    const owner = store.managedOwner(binding);
    return [{
      bindingId: binding.id,
      hostId: binding.hostId,
      threadId: binding.threadId,
      title: binding.title,
      generation: store.streamGeneration(binding.id),
      activeTurnId: typeof activity?.turnId === "string" && activity.turnId ? activity.turnId : null,
      ...(owner ? { ownerEpoch: owner.ownerEpoch, ownerClaimId: owner.id,
        ownerClaimRevision: owner.revision } : {}),
      ...(binding.sourceId ? { sourceId: binding.sourceId } : {}),
    } satisfies RestartTaskSnapshot];
  });
  return writeRestartIntent(tasks, dataDir, sourcePid, now, recoveryPolicy);
}

interface RestartSnapshotRow {
  id: string;
  host_id: string;
  thread_id: string;
  title: string;
  source_id: string;
  details: string | null;
  activity: string | null;
  generation: string | null;
  owner_epoch: string | null;
  owner_claim_id: string | null;
  owner_claim_revision: number | null;
}

/** Read one committed SQLite snapshot without opening BridgeStore or running migrations. */
export async function captureRestartIntentFromDatabase(filename: string, dataDir: string, sourcePid: number, now = Date.now(),
  recoveryPolicy: RestartRecoveryPolicy = "resume-interrupted"): Promise<RestartIntent> {
  const db = new DatabaseConstructor(filename, { readonly: true, fileMustExist: true, timeout: 5_000 });
  let tasks: RestartTaskSnapshot[];
  try {
    tasks = db.transaction(() => {
      const rows = db.prepare(`SELECT b.id, b.host_id, b.thread_id, b.title, b.source_id,
          details.value AS details, activity.value AS activity, generation.value AS generation,
          owner.owner_epoch AS owner_epoch, owner.id AS owner_claim_id,
          owner.revision AS owner_claim_revision
        FROM bridge_bindings AS b
        LEFT JOIN bridge_values AS details ON details.key = 'task-details:' || b.id
        LEFT JOIN bridge_values AS activity ON activity.key = 'activity:' || b.id
        LEFT JOIN bridge_values AS generation ON generation.key = 'stream-generation:' || b.id
        LEFT JOIN managed_owner_bindings AS owner ON owner.binding_id = b.id AND owner.state <> 'retired'
        WHERE b.attached = 1 AND b.peer_id IS NOT NULL ORDER BY b.id`).all() as RestartSnapshotRow[];
      return rows.flatMap(row => {
        const details = row.details === null ? null : JSON.parse(row.details) as { status?: string } | null;
        if (details?.status !== "running") return [];
        const activity = row.activity === null ? null : JSON.parse(row.activity) as { turnId?: string | null } | null;
        const generation = row.generation === null ? null : JSON.parse(row.generation) as number | null;
        return [{
          bindingId: row.id,
          hostId: row.host_id,
          threadId: row.thread_id,
          title: row.title,
          generation: generation ?? 0,
          activeTurnId: typeof activity?.turnId === "string" && activity.turnId ? activity.turnId : null,
          ...(row.owner_epoch && row.owner_claim_id && row.owner_claim_revision !== null
            ? { ownerEpoch: row.owner_epoch, ownerClaimId: row.owner_claim_id,
              ownerClaimRevision: row.owner_claim_revision } : {}),
          ...(row.source_id ? { sourceId: row.source_id } : {}),
        } satisfies RestartTaskSnapshot];
      });
    }).deferred();
  } finally { db.close(); }
  return writeRestartIntent(tasks, dataDir, sourcePid, now, recoveryPolicy);
}

export function archiveRestartIntentSync(dataDir: string, intent: RestartIntent): string {
  const source = restartIntentPath(dataDir);
  const destination = path.join(path.dirname(source), `restart-intent.completed-${intent.id}.json`);
  withRestartIntentLock(dataDir, () => {
    const current = parseRestartIntent(JSON.parse(readFileSync(source, "utf8")) as unknown);
    if (JSON.stringify(current) !== JSON.stringify(intent)) throw new Error("Restart intent changed during recovery");
    if (existsSync(destination)) throw new Error("Restart intent archive already exists");
    renameSync(source, destination);
  });
  return destination;
}

export async function archiveRestartIntent(dataDir: string, intent: RestartIntent): Promise<string> {
  return archiveRestartIntentSync(dataDir, intent);
}
