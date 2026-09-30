import { mkdirSync } from "node:fs";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";

export type WorkerMutationMethod = "turn/start" | "thread/queue/add";
export type WorkerOperationState = "dispatching" | "unknown" | "accepted" | "rejected";
export interface WorkerOperationIntent {
  readonly operationId: string;
  readonly clientUserMessageId: string;
  readonly method: WorkerMutationMethod;
  /** Caller-supplied keyed HMAC of the immutable RPC intent; never raw input. */
  readonly fingerprint: string;
}
export interface WorkerOperation extends WorkerOperationIntent {
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly threadId: string;
  readonly revision: number;
  readonly state: WorkerOperationState;
  readonly receiptId: string | null;
  readonly rejectionCode: number | null;
}
/** Separate effect identity: a settings ACK has no native receipt ID. */
export interface SettingsOperationIntent {
  readonly operationId: string;
  readonly fingerprint: string;
}
export interface SettingsOperation extends SettingsOperationIntent {
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly threadId: string;
  readonly revision: number;
  readonly state: "dispatching" | "unknown" | "confirmed";
  readonly rpcAck: boolean;
  readonly effectiveFingerprint: string | null;
}

interface ScopeRow { owner_epoch: string; backend_generation: number; thread_id: string }
interface OperationRow {
  operation_id: string; client_user_message_id: string; method: WorkerMutationMethod; fingerprint: string;
  revision: number; state: WorkerOperationState; receipt_id: string | null; rejection_code: number | null;
}
interface SettingsRow { operation_id: string; fingerprint: string; revision: number;
  state: "dispatching" | "unknown"; rpc_ack: number; effective_fingerprint: string | null }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const hmac = /^[0-9a-f]{64}$/u;
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function validUuid(value: unknown, name: string): string {
  const text = bounded(value, name, 36);
  if (!uuid.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
function validateIntent(intent: WorkerOperationIntent): void {
  if (intent === null || typeof intent !== "object" || Array.isArray(intent) ||
      Object.getPrototypeOf(intent) !== Object.prototype ||
      Reflect.ownKeys(intent).sort().join("|") !== "clientUserMessageId|fingerprint|method|operationId") {
    throw new Error("Invalid intent fields");
  }
  validUuid(intent.operationId, "operation ID");
  bounded(intent.clientUserMessageId, "client user message ID", 128);
  if (intent.method !== "turn/start" && intent.method !== "thread/queue/add") throw new Error("Invalid mutation method");
  if (typeof intent.fingerprint !== "string" || !hmac.test(intent.fingerprint)) throw new Error("Invalid fingerprint");
}
function validateSettingsIntent(intent: SettingsOperationIntent): void {
  if (intent === null || typeof intent !== "object" || Array.isArray(intent) ||
      Object.getPrototypeOf(intent) !== Object.prototype ||
      Reflect.ownKeys(intent).sort().join("|") !== "fingerprint|operationId")
    throw new Error("Invalid settings intent fields");
  validUuid(intent.operationId, "operation ID");
  if (typeof intent.fingerprint !== "string" || !hmac.test(intent.fingerprint))
    throw new Error("Invalid settings fingerprint");
}

/** Metadata-only owner journal. The caller proves live ownership and computes the keyed HMAC. */
export class ManagedWorkerOperationJournal {
  private readonly db: Database;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly threadId: string;

  constructor({ filePath, ownerEpoch, backendGeneration, threadId }: {
    filePath: string; ownerEpoch: string; backendGeneration: number; threadId: string;
  }) {
    if (!path.isAbsolute(filePath)) throw new Error("Operation database path must be absolute");
    this.ownerEpoch = validUuid(ownerEpoch, "owner epoch");
    this.backendGeneration = positiveInteger(backendGeneration, "backend generation");
    this.threadId = bounded(threadId, "thread ID", 256);
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseConstructor(filePath);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS managed_worker_operation_scope (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_epoch TEXT NOT NULL,
        backend_generation INTEGER NOT NULL, thread_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_worker_operations (
        operation_id TEXT PRIMARY KEY, client_user_message_id TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL CHECK(method IN ('turn/start','thread/queue/add')),
        fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('dispatching','unknown','accepted','rejected')),
        receipt_id TEXT, rejection_code INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_worker_unsettled ON managed_worker_operations(state)
        WHERE state IN ('dispatching','unknown');
      CREATE TABLE IF NOT EXISTS managed_worker_settings_operations (
        operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('dispatching','unknown')),
        rpc_ack INTEGER NOT NULL CHECK(rpc_ack IN (0,1)), effective_fingerprint TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );`);
      // Legacy databases have a two-state CHECK; nullable proof metadata is a
      // backward-safe extension and keeps every old unresolved row blocking.
      const columns = this.db.pragma('table_info(managed_worker_settings_operations)') as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'effective_fingerprint'))
        this.db.exec('ALTER TABLE managed_worker_settings_operations ADD COLUMN effective_fingerprint TEXT');
      this.db.transaction(() => {
        const current = this.db.prepare("SELECT owner_epoch,backend_generation,thread_id FROM managed_worker_operation_scope WHERE singleton=1").get() as ScopeRow | undefined;
        if (current) {
          if (current.owner_epoch !== this.ownerEpoch || current.backend_generation !== this.backendGeneration || current.thread_id !== this.threadId) {
            throw new Error("Operation journal scope mismatch");
          }
        } else {
          this.db.prepare("INSERT INTO managed_worker_operation_scope VALUES (1,?,?,?)")
            .run(this.ownerEpoch, this.backendGeneration, this.threadId);
        }
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }
  journalMode(): string { return this.db.pragma("journal_mode", { simple: true }) as string; }
  synchronousMode(): number { return this.db.pragma("synchronous", { simple: true }) as number; }

  /** Scoped durable evidence only; no reservation or backend request. */
  hasUnconfirmed(): boolean {
    return this.db.prepare(`SELECT 1 FROM managed_worker_operations WHERE state IN ('dispatching','unknown')
      UNION ALL SELECT 1 FROM managed_worker_settings_operations WHERE effective_fingerprint IS NULL LIMIT 1`)
      .get() !== undefined;
  }

  /** Count all durable mutation rows, including settled rows. A zero count
   * proves this journal never reserved a command or settings mutation. */
  operationCounts(): Readonly<{ operations: number; settings: number }> {
    const operations = this.db.prepare('SELECT COUNT(*) AS count FROM managed_worker_operations')
      .get() as { count: number };
    const settings = this.db.prepare('SELECT COUNT(*) AS count FROM managed_worker_settings_operations')
      .get() as { count: number };
    return Object.freeze({ operations: operations.count, settings: settings.count });
  }

  /** Scoped metadata only; callers must compare these receipts with terminal
   * full history before treating an idle thread as safe to stop. */
  acceptedReceipts(): ReadonlyArray<Readonly<{ method: WorkerMutationMethod; receiptId: string }>> {
    const rows = this.db.prepare("SELECT method, receipt_id FROM managed_worker_operations WHERE state='accepted' ORDER BY rowid")
      .all() as Array<{ method: WorkerMutationMethod; receipt_id: string | null }>;
    if (rows.some(row => typeof row.receipt_id !== 'string' || row.receipt_id.length === 0))
      throw new Error('Accepted worker receipt unavailable');
    return Object.freeze(rows.map(row => Object.freeze({ method: row.method, receiptId: row.receipt_id! })));
  }

  /** Accepted queue submissions require a separate terminal-history join on
   * client identity. A submission ID is never a turn ID or a drain proof. */
  acceptedQueueInputs(): ReadonlyArray<Readonly<{ clientUserMessageId: string; submissionId: string }>> {
    const rows = this.db.prepare(`SELECT client_user_message_id,receipt_id
      FROM managed_worker_operations WHERE state='accepted' AND method='thread/queue/add' ORDER BY rowid`)
      .all() as Array<{ client_user_message_id: string; receipt_id: string | null }>;
    if (rows.some(row => typeof row.client_user_message_id !== 'string' || !row.client_user_message_id ||
        typeof row.receipt_id !== 'string' || !row.receipt_id))
      throw new Error('Accepted queue identity unavailable');
    return Object.freeze(rows.map(row => Object.freeze({ clientUserMessageId: row.client_user_message_id,
      submissionId: row.receipt_id! })));
  }

  get(operationId: string): WorkerOperation | null {
    const id = validUuid(operationId, "operation ID");
    const row = this.db.prepare("SELECT * FROM managed_worker_operations WHERE operation_id=?").get(id) as OperationRow | undefined;
    return row ? this.view(row) : null;
  }
  getSettings(operationId: string): SettingsOperation | null {
    const id = validUuid(operationId, "operation ID");
    const row = this.db.prepare("SELECT * FROM managed_worker_settings_operations WHERE operation_id=?")
      .get(id) as SettingsRow | undefined;
    return row ? this.settingsView(row) : null;
  }

  reserveSettings(intent: SettingsOperationIntent): { created: boolean; operation: SettingsOperation } {
    validateSettingsIntent(intent);
    return this.db.transaction(() => {
      if (this.get(intent.operationId)) throw new Error("Settings operation ID conflict");
      const existing = this.getSettings(intent.operationId);
      if (existing) {
        if (existing.fingerprint !== intent.fingerprint) throw new Error("Settings intent conflict");
        return { created: false, operation: existing };
      }
      if (this.hasUnconfirmed()) throw new Error("Unsettled operation blocks admission");
      const now = Date.now();
      this.db.prepare(`INSERT INTO managed_worker_settings_operations
        (operation_id,fingerprint,revision,state,rpc_ack,created_at,updated_at)
        VALUES (?,?,0,'dispatching',0,?,?)`)
        .run(intent.operationId, intent.fingerprint, now, now);
      return { created: true, operation: this.getSettings(intent.operationId)! };
    }).immediate();
  }

  markSettingsUnknown(expected: SettingsOperation): SettingsOperation {
    return this.settingsTransition(expected, false);
  }

  /** Native `{}` ACK is recorded separately from any effective-settings proof. */
  noteSettingsAck(expected: SettingsOperation): SettingsOperation {
    return this.settingsTransition(expected, true);
  }

  /** A qualified same-generation effect, never a native receipt. */
  confirmSettings(expected: SettingsOperation, effectiveFingerprint: string): SettingsOperation {
    if (typeof effectiveFingerprint !== 'string' || !hmac.test(effectiveFingerprint))
      throw new Error('Invalid effective settings fingerprint');
    return this.db.transaction(() => {
      if (!expected || expected.ownerEpoch !== this.ownerEpoch ||
          expected.backendGeneration !== this.backendGeneration || expected.threadId !== this.threadId)
        throw new Error('Settings operation scope mismatch');
      const current = this.getSettings(expected.operationId);
      if (!current || current.fingerprint !== expected.fingerprint) throw new Error('Settings intent conflict');
      if (current.revision !== expected.revision || current.state !== expected.state ||
          current.rpcAck !== expected.rpcAck || current.effectiveFingerprint !== expected.effectiveFingerprint)
        throw new Error('Stale settings operation revision');
      if (current.state !== 'unknown' || !current.rpcAck) throw new Error('Settings ACK and unknown required');
      const updated = this.db.prepare(`UPDATE managed_worker_settings_operations
        SET effective_fingerprint=?,revision=revision+1,updated_at=?
        WHERE operation_id=? AND revision=? AND state='unknown' AND rpc_ack=1 AND effective_fingerprint IS NULL`)
        .run(effectiveFingerprint, Date.now(), current.operationId, current.revision);
      if (updated.changes !== 1) throw new Error('Stale settings operation revision');
      return this.getSettings(current.operationId)!;
    }).immediate();
  }

  reserve(intent: WorkerOperationIntent): { created: boolean; operation: WorkerOperation } {
    validateIntent(intent);
    return this.db.transaction(() => {
      if (this.getSettings(intent.operationId)) throw new Error("Worker operation ID conflict");
      const existing = this.get(intent.operationId);
      if (existing) {
        if (existing.clientUserMessageId !== intent.clientUserMessageId || existing.method !== intent.method || existing.fingerprint !== intent.fingerprint) {
          throw new Error("Operation intent conflict");
        }
        return { created: false, operation: existing };
      }
      if (this.db.prepare("SELECT 1 FROM managed_worker_operations WHERE client_user_message_id=?").get(intent.clientUserMessageId)) {
        throw new Error("Client user message ID conflict");
      }
      if (this.hasUnconfirmed()) {
        throw new Error("Unsettled operation blocks admission");
      }
      const now = Date.now();
      this.db.prepare(`INSERT INTO managed_worker_operations
        (operation_id,client_user_message_id,method,fingerprint,revision,state,created_at,updated_at)
        VALUES (?,?,?,?,0,'dispatching',?,?)`)
        .run(intent.operationId, intent.clientUserMessageId, intent.method, intent.fingerprint, now, now);
      return { created: true, operation: this.get(intent.operationId)! };
    }).immediate();
  }

  markUnknown(expected: WorkerOperation): WorkerOperation {
    return this.transition(expected, "unknown");
  }

  /** A final transport fence proved that no ID, pending request or write was
   * attempted. This is a local rejection, so it has no native error code. */
  rejectBeforeWrite(expected: WorkerOperation): WorkerOperation {
    if (expected.state !== "dispatching") throw new Error("Pre-write refusal requires dispatching operation");
    return this.transition(expected, "rejected");
  }

  accept(expected: WorkerOperation, receiptId: string): WorkerOperation {
    const receipt = bounded(receiptId, "receipt ID", 256);
    return this.transition(expected, "accepted", receipt);
  }

  reject(expected: WorkerOperation, numericCode: number): WorkerOperation {
    if (!Number.isSafeInteger(numericCode)) throw new Error("Invalid rejection code");
    return this.transition(expected, "rejected", undefined, numericCode);
  }

  private view(row: OperationRow): WorkerOperation {
    return { ownerEpoch: this.ownerEpoch, backendGeneration: this.backendGeneration, threadId: this.threadId,
      operationId: row.operation_id, clientUserMessageId: row.client_user_message_id,
      method: row.method, fingerprint: row.fingerprint, revision: row.revision,
      state: row.state, receiptId: row.receipt_id, rejectionCode: row.rejection_code };
  }
  private settingsView(row: SettingsRow): SettingsOperation {
    return { ownerEpoch: this.ownerEpoch, backendGeneration: this.backendGeneration,
      threadId: this.threadId, operationId: row.operation_id, fingerprint: row.fingerprint,
      revision: row.revision, state: row.effective_fingerprint === null ? row.state : 'confirmed',
      rpcAck: row.rpc_ack === 1, effectiveFingerprint: row.effective_fingerprint };
  }

  private settingsTransition(expected: SettingsOperation, ack: boolean): SettingsOperation {
    return this.db.transaction(() => {
      if (!expected || expected.ownerEpoch !== this.ownerEpoch ||
          expected.backendGeneration !== this.backendGeneration || expected.threadId !== this.threadId)
        throw new Error("Settings operation scope mismatch");
      const current = this.getSettings(expected.operationId);
      if (!current || current.fingerprint !== expected.fingerprint)
        throw new Error("Stale settings operation identity");
      if (current.state === 'confirmed') {
        if (ack && current.rpcAck) return current;
        throw new Error('Confirmed settings outcome conflict');
      }
      if (current.revision !== expected.revision || current.state !== expected.state ||
          current.rpcAck !== expected.rpcAck) {
        if (ack && current.revision === expected.revision + 1 && current.rpcAck &&
            current.fingerprint === expected.fingerprint) return current;
        throw new Error("Stale settings operation revision");
      }
      if (current.state === 'unknown' && (!ack || current.rpcAck)) return current;
      const updated = this.db.prepare(`UPDATE managed_worker_settings_operations SET state='unknown',
        rpc_ack=?,revision=revision+1,updated_at=? WHERE operation_id=? AND revision=?`)
        .run(ack || current.rpcAck ? 1 : 0, Date.now(), current.operationId, current.revision);
      if (updated.changes !== 1) throw new Error("Stale settings operation revision");
      return this.getSettings(current.operationId)!;
    }).immediate();
  }

  private transition(expected: WorkerOperation, next: WorkerOperationState,
    receiptId?: string, rejectionCode?: number): WorkerOperation {
    return this.db.transaction(() => {
      if (!expected || expected.ownerEpoch !== this.ownerEpoch || expected.backendGeneration !== this.backendGeneration ||
          expected.threadId !== this.threadId) throw new Error("Operation scope mismatch");
      const current = this.get(expected.operationId);
      if (!current || current.clientUserMessageId !== expected.clientUserMessageId ||
          current.method !== expected.method || current.fingerprint !== expected.fingerprint) throw new Error("Stale operation identity");
      if (current.state === "accepted" || current.state === "rejected") {
        const exactCurrent = current.revision === expected.revision && current.state === expected.state;
        const justSettled = current.revision === expected.revision + 1 &&
          (expected.state === "dispatching" || expected.state === "unknown");
        if (!exactCurrent && !justSettled) throw new Error("Stale operation revision");
        if (current.state === next && current.receiptId === (receiptId ?? null) &&
            current.rejectionCode === (rejectionCode ?? null)) return current;
        throw new Error("Settled outcome conflict");
      }
      if (current.revision !== expected.revision || current.state !== expected.state) throw new Error("Stale operation revision");
      if (next === "unknown" && current.state !== "dispatching") throw new Error("Invalid unknown transition");
      const updated = this.db.prepare(`UPDATE managed_worker_operations SET state=?, revision=revision+1,
        receipt_id=?, rejection_code=?, updated_at=? WHERE operation_id=? AND revision=? AND state=?`)
        .run(next, receiptId ?? null, rejectionCode ?? null, Date.now(), current.operationId, current.revision, current.state);
      if (updated.changes !== 1) throw new Error("Stale operation revision");
      return this.get(current.operationId)!;
    }).immediate();
  }
}
