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

interface ScopeRow { owner_epoch: string; backend_generation: number; thread_id: string }
interface OperationRow {
  operation_id: string; client_user_message_id: string; method: WorkerMutationMethod; fingerprint: string;
  revision: number; state: WorkerOperationState; receipt_id: string | null; rejection_code: number | null;
}

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
        WHERE state IN ('dispatching','unknown');`);
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
    return this.db.prepare("SELECT 1 FROM managed_worker_operations WHERE state IN ('dispatching','unknown') LIMIT 1")
      .get() !== undefined;
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

  get(operationId: string): WorkerOperation | null {
    const id = validUuid(operationId, "operation ID");
    const row = this.db.prepare("SELECT * FROM managed_worker_operations WHERE operation_id=?").get(id) as OperationRow | undefined;
    return row ? this.view(row) : null;
  }

  reserve(intent: WorkerOperationIntent): { created: boolean; operation: WorkerOperation } {
    validateIntent(intent);
    return this.db.transaction(() => {
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
      if (this.db.prepare("SELECT 1 FROM managed_worker_operations WHERE state IN ('dispatching','unknown') LIMIT 1").get()) {
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
