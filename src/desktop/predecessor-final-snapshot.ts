import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import DatabaseConstructor, { type Database } from "better-sqlite3";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_IDS = 64;
const MAX_OPERATION_ID = 100;
const DEFAULT_DEADLINE_MS = 30_000;
const MAX_DEADLINE_MS = 120_000;
const DEFAULT_MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_BYTES = 4 * 1024 * 1024 * 1024;

export interface PredecessorFinalSnapshotRequest {
  readonly sourceDatabasePath: string;
  readonly privateBackupRoot: string;
  readonly expectedFileIdentity: Readonly<{ dev: string; ino: string }>;
  readonly legacySourceIds: readonly string[];
  readonly operationId: string;
  readonly actionScopeSha256: string;
  readonly deadlineMs?: number;
  readonly maxBackupBytes?: number;
}

export interface PredecessorFinalBindingGeneration {
  readonly bindingId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly sourceId: string;
  readonly generation: number;
}

export interface CommittedPredecessorSnapshot {
  readonly kind: "committed-predecessor-snapshot";
  readonly operationId: string;
  readonly actionScopeSha256: string;
  readonly sourceDatabasePath: string;
  readonly sourceFileIdentity: Readonly<{ dev: string; ino: string }>;
  readonly backupPath: string;
  readonly backupSha256: string;
  readonly backupSizeBytes: number;
  readonly capturedAtUtc: string;
  readonly bindingVector: readonly PredecessorFinalBindingGeneration[];
}

interface FileIdentity { readonly dev: string; readonly ino: string; readonly nlink: bigint; readonly size: bigint; readonly mtimeNs: bigint; }
interface BindingRow { id: string; host_id: string; thread_id: string; source_id: string; generation_value: string | null; }

function refuse(): never { throw new Error("Committed predecessor snapshot refused."); }

function exactObject(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(row, key))) refuse();
  return row;
}

function safeText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length < 1) || value.length > maximum || /[\x00-\x1f\x7f]/u.test(value)) refuse();
  return value;
}

function samePath(first: string, second: string): boolean {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.nlink === 1n && second.nlink === 1n
    && first.size === second.size && first.mtimeNs === second.mtimeNs;
}

async function canonicalRegularFile(filePath: string): Promise<{ path: string; identity: FileIdentity }> {
  const resolved = path.resolve(filePath);
  if (!samePath(filePath, resolved)) refuse();
  const [linkInfo, currentPath, fileInfo] = await Promise.all([
    lstat(resolved, { bigint: true }), realpath(resolved), stat(resolved, { bigint: true }),
  ]);
  if (!samePath(currentPath, resolved) || linkInfo.isSymbolicLink() || !linkInfo.isFile() || !fileInfo.isFile()
    || linkInfo.nlink !== 1n || fileInfo.nlink !== 1n || linkInfo.dev !== fileInfo.dev || linkInfo.ino !== fileInfo.ino) refuse();
  return { path: resolved, identity: Object.freeze({ dev: String(fileInfo.dev), ino: String(fileInfo.ino),
    nlink: fileInfo.nlink, size: fileInfo.size, mtimeNs: fileInfo.mtimeNs }) };
}

async function canonicalDirectory(directoryPath: string): Promise<string> {
  const resolved = path.resolve(directoryPath);
  if (!samePath(directoryPath, resolved)) refuse();
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const [linkInfo, currentPath, directoryInfo] = await Promise.all([
    lstat(resolved, { bigint: true }), realpath(resolved), stat(resolved, { bigint: true }),
  ]);
  if (!samePath(currentPath, resolved) || linkInfo.isSymbolicLink() || !linkInfo.isDirectory() || !directoryInfo.isDirectory()) refuse();
  return resolved;
}

function bindingVector(db: Database, sources: readonly string[]): readonly PredecessorFinalBindingGeneration[] {
  const placeholders = sources.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT b.id, b.host_id, b.thread_id, b.source_id, v.value AS generation_value
    FROM bridge_bindings AS b
    LEFT JOIN bridge_values AS v ON v.key = 'stream-generation:' || b.id
    WHERE b.source_id IN (${placeholders})
    ORDER BY b.id
  `).all(...sources) as BindingRow[];
  return Object.freeze(rows.map(row => {
    let generation = 0;
    if (row.generation_value !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.generation_value); } catch { return refuse(); }
      if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) refuse();
      generation = parsed;
    }
    return Object.freeze({ bindingId: safeText(row.id, 100), hostId: safeText(row.host_id, 200),
      threadId: safeText(row.thread_id, 200), sourceId: safeText(row.source_id, 500, true), generation });
  }));
}

function verifyIntegrity(db: Database): void {
  const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") refuse();
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeys.length !== 0) refuse();
}

async function fileSha256(filePath: string, deadline: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (performance.now() > deadline) refuse();
    hash.update(chunk as Buffer);
  }
  if (performance.now() > deadline) refuse();
  return hash.digest("hex");
}

/**
 * Makes a read-only, consistent SQLite backup for a trusted post-exit caller.
 * This utility verifies data and metadata only; it proves neither writer exit
 * nor restart exclusion and grants no cutover/controller authority.
 */
export async function captureCommittedPredecessorSnapshot(
  request: PredecessorFinalSnapshotRequest,
): Promise<CommittedPredecessorSnapshot> {
  let source: Database | null = null;
  const started = performance.now();
  let backupPath: string | null = null;
  try {
    const input = exactObject(request, ["sourceDatabasePath", "privateBackupRoot", "expectedFileIdentity", "legacySourceIds",
      "operationId", "actionScopeSha256", "deadlineMs", "maxBackupBytes"],
    ["sourceDatabasePath", "privateBackupRoot", "expectedFileIdentity", "legacySourceIds", "operationId", "actionScopeSha256"]);
    const sourceDatabasePath = safeText(input.sourceDatabasePath, 4096);
    const backupRootInput = safeText(input.privateBackupRoot, 4096);
    if (!path.isAbsolute(sourceDatabasePath) && !path.win32.isAbsolute(sourceDatabasePath)) refuse();
    if (!path.isAbsolute(backupRootInput) && !path.win32.isAbsolute(backupRootInput)) refuse();

    const identityInput = exactObject(input.expectedFileIdentity, ["dev", "ino"], ["dev", "ino"]);
    const expectedIdentity = { dev: safeText(identityInput.dev, 64), ino: safeText(identityInput.ino, 64) };
    if (!/^\d+$/u.test(expectedIdentity.dev) || !/^\d+$/u.test(expectedIdentity.ino)) refuse();
    const operationId = safeText(input.operationId, MAX_OPERATION_ID);
    if (!/^[a-zA-Z0-9_-]+$/u.test(operationId)) refuse();
    const actionScopeSha256 = safeText(input.actionScopeSha256, 64);
    if (!HASH.test(actionScopeSha256)) refuse();

    const requestedSources = input.legacySourceIds;
    if (!Array.isArray(requestedSources) || requestedSources.length < 1 || requestedSources.length > MAX_SOURCE_IDS) refuse();
    // The legacy default catalog has the valid persisted identity source_id = ''.
    // Only source IDs may be empty; paths, operation/binding IDs and pins may not.
    const sources = requestedSources.map(value => safeText(value, 500, true)).sort();
    if (new Set(sources).size !== sources.length) refuse();

    const deadlineMs = input.deadlineMs === undefined ? DEFAULT_DEADLINE_MS : input.deadlineMs;
    const maxBackupBytes = input.maxBackupBytes === undefined ? DEFAULT_MAX_BACKUP_BYTES : input.maxBackupBytes;
    if (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > MAX_DEADLINE_MS
      || typeof maxBackupBytes !== "number" || !Number.isSafeInteger(maxBackupBytes) || maxBackupBytes < 4096
      || maxBackupBytes > MAX_BACKUP_BYTES) refuse();
    const deadline = started + deadlineMs;
    const assertWithinDeadline = (): void => { if (performance.now() > deadline) refuse(); };

    const sourceFile = await canonicalRegularFile(sourceDatabasePath);
    if (sourceFile.identity.dev !== expectedIdentity.dev || sourceFile.identity.ino !== expectedIdentity.ino) refuse();
    const backupRoot = await canonicalDirectory(backupRootInput);
    assertWithinDeadline();

    // Minimal read-only connection: do not construct BridgeStore here because
    // its normal constructor may migrate the database before capture.
    source = new DatabaseConstructor(sourceFile.path, { readonly: true, fileMustExist: true, timeout: 1000 });
    source.pragma("query_only = ON");
    const dataVersionBefore = source.pragma("data_version", { simple: true });
    if (typeof dataVersionBefore !== "number" || !Number.isSafeInteger(dataVersionBefore)) refuse();

    // Keep the leaf short: Windows SQLite paths can otherwise hit MAX_PATH
    // because the controller's private journal already contains two scoped IDs.
    backupPath = path.join(backupRoot, `predecessor-final-${randomUUID()}.sqlite`);
    await access(backupRoot, fsConstants.W_OK);
    const pageSize = source.pragma("page_size", { simple: true });
    if (typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 512) refuse();
    await source.backup(backupPath, { progress: progress => {
      assertWithinDeadline();
      const estimatedBytes = progress.totalPages * pageSize;
      if (!Number.isSafeInteger(progress.totalPages) || progress.totalPages < 0 || !Number.isSafeInteger(estimatedBytes)
        || estimatedBytes > maxBackupBytes) refuse();
      if (!Number.isSafeInteger(progress.remainingPages) || progress.remainingPages < 0) refuse();
      return Math.min(100, Math.max(1, progress.remainingPages));
    } });
    assertWithinDeadline();

    const sourceAfter = await canonicalRegularFile(sourceFile.path);
    if (!samePath(sourceAfter.path, sourceFile.path) || !sameIdentity(sourceFile.identity, sourceAfter.identity)
      || sourceAfter.identity.dev !== expectedIdentity.dev || sourceAfter.identity.ino !== expectedIdentity.ino) refuse();
    const dataVersionAfter = source.pragma("data_version", { simple: true });
    if (dataVersionAfter !== dataVersionBefore) refuse();

    const backupFile = await canonicalRegularFile(backupPath);
    if (backupFile.identity.size <= 0n || backupFile.identity.size > BigInt(maxBackupBytes)) refuse();
    const sizeNumber = Number(backupFile.identity.size);
    if (!Number.isSafeInteger(sizeNumber)) refuse();

    const snapshotDb = new DatabaseConstructor(backupFile.path, { readonly: true, fileMustExist: true, timeout: 1000 });
    let vector: readonly PredecessorFinalBindingGeneration[];
    try {
      snapshotDb.pragma("query_only = ON");
      verifyIntegrity(snapshotDb);
      vector = bindingVector(snapshotDb, sources);
    } finally { snapshotDb.close(); }
    const backupSha256 = await fileSha256(backupFile.path, deadline);
    assertWithinDeadline();
    const backupAfterHash = await canonicalRegularFile(backupFile.path);
    if (!samePath(backupAfterHash.path, backupFile.path) || !sameIdentity(backupFile.identity, backupAfterHash.identity)) refuse();
    const capturedAtUtc = new Date().toISOString();
    if (performance.now() > deadline) refuse();

    return Object.freeze({ kind: "committed-predecessor-snapshot", operationId, actionScopeSha256,
      sourceDatabasePath: sourceFile.path, sourceFileIdentity: Object.freeze({ dev: expectedIdentity.dev, ino: expectedIdentity.ino }),
      backupPath: backupFile.path, backupSha256, backupSizeBytes: sizeNumber, capturedAtUtc, bindingVector: vector });
  } catch {
    // The random destination may remain as an incomplete fixture/backup for
    // forensic inspection. Nothing in this path deletes or finalizes it.
    throw new Error("Committed predecessor snapshot refused.");
  } finally {
    source?.close();
  }
}
