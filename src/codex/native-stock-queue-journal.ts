// Isolated normalized repeated-admission journal. No RPC, native IPC, scheduler.
// Runtime reads are indexed or paged. `read` and `publication` are diagnostics only.
// The caller MUST serialize external native publications with one writer: a
// versioned ACK fences the outbox but cannot reorder sends already in flight.
import DatabaseConstructor, { type Database, type Statement } from 'better-sqlite3';
import type { JsonValue, JsonObject } from './homogeneous-queue-policy.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface StockQueueOperation {
  opId: string; seq: number; fingerprint: string; nativeEntry: JsonObject;
  effectiveSettings: JsonObject; admissionEvidence: JsonObject;
  stockInput: readonly JsonValue[]; forwardedUpstream: JsonObject;
  phase: 'reserved' | 'accepted' | 'unknown'; stockId: string | null;
  acceptedTurnId: string | null; consumed: boolean;
}
interface TaskRow { task_id: string; owner_epoch: string; source_generation: string; version: number; settings_json: string | null;
  publication_version: number; publication_acked_version: number }
interface OpRow { task_id: string; op_id: string; seq: number; fingerprint: string;
  native_entry_json: string; admission_evidence_json: string;
  stock_input_json: string; forwarded_json: string;
  phase: StockQueueOperation['phase']; stock_id: string | null;
  accepted_turn_id: string | null; consumed: number }
type IdentityRow = Pick<OpRow, 'op_id' | 'seq' | 'fingerprint' | 'phase' | 'consumed'>;
interface TaskView { taskId: string; ownerEpoch: string; sourceGeneration: string; version: number;
  effectiveSettings: JsonObject | null; publicationVersion: number; publicationAckedVersion: number }
export interface Page<T> { taskVersion: number; items: T[]; hasMore: boolean; nextCursor: number }
type InputIdentity = { id: string; seq: number; fingerprint: string;
  phase: StockQueueOperation['phase']; consumed: boolean };
export interface PublicationItem { seq: number; opId: string; fingerprint: string; nativeEntry: JsonObject }
/** Metadata-only drain evidence. Publication delivery is not an acceptance gate. */
export interface NativeStockQueueQuiescence {
  readonly taskVersion: number;
  readonly unresolved: number;
  readonly unconsumed: number;
}
type PageArgs = { afterSeq?: number; limit?: number };
type PublicationPageArgs = PageArgs & { version: number };
type CurrentQueuePageArgs = PageArgs & { expectedVersion: number };
export interface StockQueueIntent { expectedVersion: number; opId: string; fingerprint: string;
  nativeEntry: JsonObject; effectiveSettings: JsonObject; admissionEvidence: JsonObject;
  stockInput: readonly JsonValue[];
  forwardedUpstream: JsonObject }
interface PositiveProofBase {
  readonly taskId: string; readonly ownerEpoch: string; readonly sourceGeneration: string;
  readonly sourceRevision: number; readonly complete: true; readonly clientUserMessageId: string;
  readonly input: readonly JsonValue[]; readonly admissionEvidence: JsonObject;
  readonly effectiveSettings: JsonObject;
}
export type PositiveReconciliationProof =
  | (PositiveProofBase & { readonly kind: 'queued'; readonly stockId: string })
  | (PositiveProofBase & { readonly kind: 'started'; readonly turnId: string });
export type ReconciliationEvidence =
  | { readonly kind: 'queued' | 'started'; readonly proof: PositiveReconciliationProof }
  | { readonly kind: 'late-stock'; readonly proof: { readonly sourceGeneration: string;
      readonly stockId: string; readonly inputHash: string } };

const fail = (reason: string): never => { throw new Error(`Native repeated stock journal refused: ${reason}`); };
const plain = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const copy = <T>(value: T): T => structuredClone(value);
const maxPageSize = 500;
const hashJson = (value: readonly JsonValue[]): string =>
  createHash('sha256').update(json(value)).digest('hex');

function json(value: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { fail('non-JSON intent'); }
  if (encoded === undefined || !isDeepStrictEqual(value, JSON.parse(encoded))) fail('non-JSON intent');
  return encoded ?? fail('non-JSON intent');
}
function pageArgs(afterSeq: number, limit: number): void {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) {
    fail(`page cursor and limit 1..${maxPageSize} required`);
  }
}
const taskView = (row: TaskRow | undefined, taskId: string, ownerEpoch: string, sourceGeneration: string): TaskView => row ? {
  taskId, ownerEpoch, sourceGeneration, version: row.version,
  effectiveSettings: row.settings_json === null ? null : JSON.parse(row.settings_json) as JsonObject,
  publicationVersion: row.publication_version,
  publicationAckedVersion: row.publication_acked_version,
} : { taskId, ownerEpoch, sourceGeneration, version: 0, effectiveSettings: null,
  publicationVersion: 0, publicationAckedVersion: 0 };
const opView = (row: OpRow, effectiveSettings: JsonObject | null): StockQueueOperation => ({
  opId: row.op_id, seq: row.seq, fingerprint: row.fingerprint,
  nativeEntry: JSON.parse(row.native_entry_json) as JsonObject, effectiveSettings: copy(effectiveSettings ?? fail('missing settings')),
  admissionEvidence: JSON.parse(row.admission_evidence_json) as JsonObject,
  stockInput: JSON.parse(row.stock_input_json) as JsonValue[],
  forwardedUpstream: JSON.parse(row.forwarded_json) as JsonObject, phase: row.phase,
  stockId: row.stock_id, acceptedTurnId: row.accepted_turn_id, consumed: row.consumed === 1,
});

export class NativeStockQueueJournal {
  private readonly db: Database;
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly sourceGeneration: string;
  private txKind: 'read' | 'write' | null = null;
  private readonly selectTask: Statement<[string], TaskRow>;
  private readonly selectOp: Statement<[string, string], OpRow>;
  private readonly selectIdentity: Statement<[string, string], IdentityRow>;
  private readonly selectUnresolved: Statement<[string], Pick<OpRow, 'phase'>>;
  private readonly selectQuiescence: Statement<[string], { unresolved: number; unconsumed: number }>;
  private readonly selectNextSeq: Statement<[string], { next_seq: number }>;
  private readonly selectPage: Statement<[string, number, number, number], OpRow>;
  private readonly selectPublicationPage: Statement<[string, number, number], OpRow>;
  private readonly selectAll: Statement<[string], OpRow>;
  private readonly insertTask: Statement<[string, string, string, number, string, number, number]>;
  private readonly bumpTask: Statement<[string, number]>;
  private readonly bumpPublication: Statement<[string, number]>;
  private readonly insertOp: Statement<[string, string, number, string, string, string, string, string,
    StockQueueOperation['phase'], string | null, string | null, number]>;
  private readonly acceptOp: Statement<[string, string, string]>;
  private readonly unknownOp: Statement<[string, string]>;
  private readonly consumeOp: Statement<[string, string, string]>;
  private readonly ackPublication: Statement<[number, string, number, number]>;
  private readonly insertEvidence: Statement<[string, string, ReconciliationEvidence['kind'], string]>;
  private readonly selectEvidence: Statement<[string, string], { kind: ReconciliationEvidence['kind']; proof_json: string }>;
  private readonly acceptReconciled: Statement<[string | null, string | null, number, string, string]>;
  private readonly fillLateStock: Statement<[string, string, string]>;

  constructor({ filePath, taskId, ownerEpoch, sourceGeneration }: {
    filePath: string; taskId: string; ownerEpoch: string; sourceGeneration: string }) {
    if (!nonempty(filePath) || !path.isAbsolute(filePath) ||
        !nonempty(taskId) || !nonempty(ownerEpoch) || !nonempty(sourceGeneration)) {
      fail('absolute path, task, owner epoch, source generation required');
    }
    this.taskId = taskId;
    this.ownerEpoch = ownerEpoch;
    this.sourceGeneration = sourceGeneration;
    this.db = new DatabaseConstructor(filePath);
    try {
      const oldSchema = this.db.prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='native_repeated_op'").get();
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (oldSchema && version !== 2) fail('outcome-v2 requires new database; explicit migration required');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.db.exec(`CREATE TABLE IF NOT EXISTS native_repeated_task (
        task_id TEXT PRIMARY KEY NOT NULL,
        owner_epoch TEXT NOT NULL,
        source_generation TEXT NOT NULL,
        version INTEGER NOT NULL,
        settings_json TEXT,
        publication_version INTEGER NOT NULL,
        publication_acked_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_repeated_op (
        task_id TEXT NOT NULL,
        op_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        native_entry_json TEXT NOT NULL,
        admission_evidence_json TEXT NOT NULL,
        stock_input_json TEXT NOT NULL,
        forwarded_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('reserved','accepted','unknown')),
        stock_id TEXT,
        accepted_turn_id TEXT,
        consumed INTEGER NOT NULL CHECK (consumed IN (0,1)),
        PRIMARY KEY(task_id,op_id),
        UNIQUE(task_id,seq),
        FOREIGN KEY(task_id) REFERENCES native_repeated_task(task_id)
      );
      CREATE INDEX IF NOT EXISTS native_repeated_pending_idx ON native_repeated_op(task_id,consumed,seq);
      CREATE INDEX IF NOT EXISTS native_repeated_phase_idx ON native_repeated_op(task_id,phase);
      CREATE UNIQUE INDEX IF NOT EXISTS native_repeated_stock_idx ON native_repeated_op(task_id,stock_id) WHERE stock_id IS NOT NULL;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS native_stock_reconciliation_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        op_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('queued','started','late-stock')),
        proof_json TEXT NOT NULL,
        FOREIGN KEY(task_id,op_id) REFERENCES native_repeated_op(task_id,op_id)
      );
      CREATE INDEX IF NOT EXISTS native_stock_reconciliation_by_op
        ON native_stock_reconciliation_evidence(task_id,op_id,id);`);
      const columns = this.db.pragma('table_info(native_repeated_op)') as { name: string }[];
      const taskColumns = this.db.pragma('table_info(native_repeated_task)') as { name: string }[];
      if (!columns.some(row => row.name === 'admission_evidence_json') ||
          !taskColumns.some(row => row.name === 'source_generation')) {
        fail('incompatible journal schema; explicit migration required');
      }
      this.db.pragma('user_version = 2');
      this.selectTask = this.db.prepare<[string], TaskRow>('SELECT * FROM native_repeated_task WHERE task_id=?');
      this.selectOp = this.db.prepare<[string, string], OpRow>('SELECT * FROM native_repeated_op WHERE task_id=? AND op_id=?');
      this.selectIdentity = this.db.prepare<[string, string], IdentityRow>('SELECT op_id,seq,fingerprint,phase,consumed FROM native_repeated_op WHERE task_id=? AND op_id=?');
      this.selectUnresolved = this.db.prepare<[string], Pick<OpRow, 'phase'>>("SELECT phase FROM native_repeated_op WHERE task_id=? AND phase IN ('reserved','unknown') LIMIT 1");
      this.selectQuiescence = this.db.prepare<[string], { unresolved: number; unconsumed: number }>(
        "SELECT COUNT(CASE WHEN phase IN ('reserved','unknown') THEN 1 END) AS unresolved, " +
        'COUNT(CASE WHEN consumed=0 THEN 1 END) AS unconsumed FROM native_repeated_op WHERE task_id=?');
      this.selectNextSeq = this.db.prepare<[string], { next_seq: number }>('SELECT COALESCE(MAX(seq),0)+1 AS next_seq FROM native_repeated_op WHERE task_id=?');
      this.selectPage = this.db.prepare<[string, number, number, number], OpRow>('SELECT * FROM native_repeated_op WHERE task_id=? AND consumed=? AND seq>? ORDER BY seq LIMIT ?');
      this.selectPublicationPage = this.db.prepare<[string, number, number], OpRow>("SELECT * FROM native_repeated_op WHERE task_id=? AND phase='accepted' AND consumed=0 AND seq>? ORDER BY seq LIMIT ?");
      this.selectAll = this.db.prepare<[string], OpRow>('SELECT * FROM native_repeated_op WHERE task_id=? ORDER BY seq');
      this.insertTask = this.db.prepare<[string, string, string, number, string, number, number]>('INSERT INTO native_repeated_task VALUES(?,?,?,?,?,?,?)');
      this.bumpTask = this.db.prepare<[string, number]>('UPDATE native_repeated_task SET version=version+1 WHERE task_id=? AND version=?');
      this.bumpPublication = this.db.prepare<[string, number]>('UPDATE native_repeated_task SET version=version+1,publication_version=publication_version+1 WHERE task_id=? AND version=?');
      this.insertOp = this.db.prepare<[string, string, number, string, string, string, string, string,
        StockQueueOperation['phase'], string | null, string | null, number]>('INSERT INTO native_repeated_op VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      this.acceptOp = this.db.prepare<[string, string, string]>("UPDATE native_repeated_op SET phase='accepted',stock_id=? WHERE task_id=? AND op_id=? AND phase='reserved'");
      this.unknownOp = this.db.prepare<[string, string]>("UPDATE native_repeated_op SET phase='unknown' WHERE task_id=? AND op_id=? AND phase='reserved'");
      this.consumeOp = this.db.prepare<[string, string, string]>('UPDATE native_repeated_op SET accepted_turn_id=?,consumed=1 WHERE task_id=? AND op_id=? AND accepted_turn_id IS NULL');
      this.ackPublication = this.db.prepare<[number, string, number, number]>('UPDATE native_repeated_task SET publication_acked_version=?,version=version+1 WHERE task_id=? AND version=? AND publication_version=?');
      this.insertEvidence = this.db.prepare<[string, string, ReconciliationEvidence['kind'], string]>(
        'INSERT INTO native_stock_reconciliation_evidence(task_id,op_id,kind,proof_json) VALUES(?,?,?,?)');
      this.selectEvidence = this.db.prepare<[string, string], { kind: ReconciliationEvidence['kind']; proof_json: string }>(
        'SELECT kind,proof_json FROM native_stock_reconciliation_evidence WHERE task_id=? AND op_id=? ORDER BY id');
      this.acceptReconciled = this.db.prepare<[string | null, string | null, number, string, string]>(
        "UPDATE native_repeated_op SET phase='accepted',stock_id=?,accepted_turn_id=?,consumed=? WHERE task_id=? AND op_id=? AND phase IN ('reserved','unknown')");
      this.fillLateStock = this.db.prepare<[string, string, string]>(
        "UPDATE native_repeated_op SET stock_id=? WHERE task_id=? AND op_id=? AND phase='accepted' AND stock_id IS NULL AND consumed=1");
    } catch (error) { this.db.close(); throw error; }
  }

  taskRow(): TaskRow | undefined {
    const row = this.selectTask.get(this.taskId);
    if (row && row.owner_epoch !== this.ownerEpoch) fail('owner epoch mismatch');
    if (row && row.source_generation !== this.sourceGeneration) fail('source generation mismatch');
    return row;
  }
  readTask(): TaskView { return taskView(this.taskRow(), this.taskId, this.ownerEpoch, this.sourceGeneration); }
  quiescence(): NativeStockQueueQuiescence {
    return this.snapshot(() => {
      const taskVersion = this.taskRow()?.version ?? 0;
      const counts = this.selectQuiescence.get(this.taskId);
      if (!Number.isSafeInteger(taskVersion) || taskVersion < 0 || !counts ||
          !Number.isSafeInteger(counts.unresolved) || counts.unresolved < 0 ||
          !Number.isSafeInteger(counts.unconsumed) || counts.unconsumed < 0) {
        return fail('invalid scoped quiescence');
      }
      return Object.freeze({ taskVersion, unresolved: counts.unresolved, unconsumed: counts.unconsumed });
    });
  }
  readOperation(opId: string): StockQueueOperation | null {
    if (!nonempty(opId)) fail('operation ID required');
    return this.snapshot(() => {
      const task = this.readTask();
      const row = this.selectOp.get(this.taskId, opId);
      return row ? opView(row, task.effectiveSettings) : null;
    });
  }
  private page(consumed: boolean, { afterSeq = 0, limit = 100 }: PageArgs = {}): Page<StockQueueOperation> {
    pageArgs(afterSeq, limit);
    return this.snapshot(() => {
      const task = this.readTask();
      const rows = this.selectPage.all(this.taskId, consumed ? 1 : 0, afterSeq, limit + 1);
      const items = rows.slice(0, limit).map(row => opView(row, task.effectiveSettings));
      return { taskVersion: task.version, items, hasMore: rows.length > limit,
        nextCursor: items.at(-1)?.seq ?? afterSeq };
    });
  }
  pendingPage(args: PageArgs = {}): Page<StockQueueOperation> { return this.page(false, args); }
  consumedPage(args: PageArgs = {}): Page<StockQueueOperation> { return this.page(true, args); }
  lookupIncomingIdentities({ ids }: { ids: string[] }): { taskVersion: number; items: (InputIdentity | null)[] } {
    if (!Array.isArray(ids) || ids.length > maxPageSize ||
        ids.some(id => !nonempty(id)) || new Set(ids).size !== ids.length) {
      fail(`incoming identity batch of at most ${maxPageSize} unique IDs required`);
    }
    return this.snapshot(() => {
      const task = this.readTask();
      const items = ids.map(id => {
        const row = this.selectIdentity.get(this.taskId, id);
        return row ? { id: row.op_id, seq: row.seq, fingerprint: row.fingerprint,
          phase: row.phase, consumed: row.consumed === 1 } : null;
      });
      return { taskVersion: task.version, items };
    });
  }
  publicationStatus(): { version: number; acknowledgedVersion: number; pending: boolean } {
    const task = this.readTask();
    return { version: task.publicationVersion, acknowledgedVersion: task.publicationAckedVersion,
      pending: task.publicationVersion > task.publicationAckedVersion };
  }
  publicationPage({ version, afterSeq = 0, limit = 100 }: PublicationPageArgs): Omit<Page<PublicationItem>, 'taskVersion'> & { version: number } {
    pageArgs(afterSeq, limit);
    return this.snapshot(() => {
      const status = this.publicationStatus();
      if (!status.pending || version !== status.version) fail('stale publication snapshot');
      const rows = this.selectPublicationPage.all(this.taskId, afterSeq, limit + 1);
      const items = rows.slice(0, limit).map(row => ({ seq: row.seq, opId: row.op_id,
        fingerprint: row.fingerprint, nativeEntry: JSON.parse(row.native_entry_json) as JsonObject }));
      return { version, items, hasMore: rows.length > limit,
        nextCursor: items.at(-1)?.seq ?? afterSeq };
    });
  }
  currentQueuePage({ expectedVersion, afterSeq = 0, limit = 100 }: CurrentQueuePageArgs): Page<PublicationItem> {
    pageArgs(afterSeq, limit);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('expected task version required');
    return this.snapshot(() => {
      const task = this.readTask();
      if (task.version !== expectedVersion) fail('stale task version');
      const rows = this.selectPublicationPage.all(this.taskId, afterSeq, limit + 1);
      const items = rows.slice(0, limit).map(row => ({ seq: row.seq, opId: row.op_id,
        fingerprint: row.fingerprint, nativeEntry: JSON.parse(row.native_entry_json) as JsonObject }));
      return { taskVersion: task.version, items, hasMore: rows.length > limit,
        nextCursor: items.at(-1)?.seq ?? afterSeq };
    });
  }

  // Diagnostic/test convenience only: walks every operation and is not a runtime API.
  read(): TaskView & { operations: StockQueueOperation[]; pendingIds: string[]; publicationIds: string[] } {
    return this.snapshot(() => {
      const task = this.readTask();
      const operations = this.selectAll.all(this.taskId).map(row => opView(row, task.effectiveSettings));
      return { ...task, operations, pendingIds: operations.filter(op => !op.consumed).map(op => op.opId),
        publicationIds: operations.filter(op => op.phase === 'accepted' && !op.consumed).map(op => op.opId) };
    });
  }
  // Diagnostic/test convenience only; runtime must use publicationPage under one writer.
  publication(): { version: number; pendingIds: string[]; messages: JsonObject[] } | null {
    return this.snapshot(() => {
      const status = this.publicationStatus();
      if (!status.pending) return null;
      const rows = this.selectPublicationPage.all(this.taskId, 0, -1);
      return { version: status.version, pendingIds: rows.map(row => row.op_id),
        messages: rows.map(row => JSON.parse(row.native_entry_json) as JsonObject) };
    });
  }

  private snapshot<T>(fn: () => T): T {
    if (this.txKind) return fn(); // Includes reads made by this connection's write transaction.
    this.db.exec('BEGIN'); // Deferred read transaction: first SELECT pins one WAL snapshot.
    this.txKind = 'read';
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.txKind = null; }
  }
  private transaction<T>(fn: () => T): T {
    if (this.txKind) fail('nested write transaction');
    this.db.exec('BEGIN IMMEDIATE');
    this.txKind = 'write';
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.txKind = null; }
  }
  confirmReplay({ expectedVersion, ownerEpoch }: { expectedVersion: number; ownerEpoch: string }): { confirmed: true; version: number } {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        ownerEpoch !== this.ownerEpoch) fail('owner epoch mismatch or invalid expected version');
    return this.transaction(() => {
      const row = this.taskRow();
      const version = row?.version ?? 0;
      if (version !== expectedVersion) fail('stale expected version');
      if (this.selectUnresolved.get(this.taskId)) fail('unresolved stock add prevents replay confirmation');
      return { confirmed: true, version };
    });
  }
  private bump(row: TaskRow, publication: boolean): void {
    const result = publication
      ? this.bumpPublication.run(this.taskId, row.version)
      : this.bumpTask.run(this.taskId, row.version);
    if (result.changes !== 1) fail('concurrent task update');
  }

  reserve({ expectedVersion, opId, fingerprint: hash, nativeEntry, effectiveSettings,
    admissionEvidence, stockInput, forwardedUpstream }: StockQueueIntent): StockQueueOperation {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        !nonempty(opId) || !fingerprint(hash) || !plain(nativeEntry) || nativeEntry.id !== opId ||
        !plain(effectiveSettings) || !plain(admissionEvidence) ||
        Object.keys(admissionEvidence).length === 0 || !Array.isArray(stockInput) ||
        !plain(forwardedUpstream)) fail('incomplete immutable intent');
    const nativeJson = json(nativeEntry), settingsJson = json(effectiveSettings);
    const evidenceJson = json(admissionEvidence);
    const inputJson = json(stockInput), forwardedJson = json(forwardedUpstream);
    return this.transaction(() => {
      let row = this.taskRow();
      if ((row?.version ?? 0) !== expectedVersion) fail('stale expected version');
      if (this.selectOp.get(this.taskId, opId)) fail('reused immutable operation ID');
      const unresolved = this.selectUnresolved.get(this.taskId)?.phase;
      if (unresolved === 'unknown') fail('unknown outcome freezes admissions');
      if (unresolved === 'reserved') fail('prior stock add is still unresolved');
      if (row?.settings_json !== null && row?.settings_json !== undefined &&
          !isDeepStrictEqual(JSON.parse(row.settings_json), effectiveSettings)) fail('effective settings changed');
      if (!row) {
        this.insertTask.run(this.taskId, this.ownerEpoch, this.sourceGeneration, 0, settingsJson, 0, 0);
        row = this.taskRow();
      } else if (row.settings_json === null) fail('missing immutable settings');
      const seq = this.selectNextSeq.get(this.taskId)?.next_seq ?? fail('next sequence absent');
      this.insertOp.run(this.taskId, opId, seq, hash, nativeJson, evidenceJson, inputJson,
        forwardedJson, 'reserved', null, null, 0);
      this.bump(row ?? fail('task row absent after reservation'), false);
      return this.readOperation(opId) ?? fail('reserved operation absent');
    });
  }

  markAccepted({ opId, fingerprint: hash, stockId, input, sourceGeneration,
    clientUserMessageId, threadId, assertSourceCurrent }: {
    opId: string; fingerprint: string; stockId: string; input?: readonly JsonValue[];
    sourceGeneration?: string; clientUserMessageId?: string; threadId?: string;
    assertSourceCurrent?: () => boolean }): StockQueueOperation {
    if (!nonempty(opId) || !fingerprint(hash) || !nonempty(stockId)) fail('accepted receipt incomplete');
    return this.transaction(() => {
      const task = this.taskRow(); const op = this.selectOp.get(this.taskId, opId);
      if (!task || !op) return fail('operation identity conflict');
      if (op.fingerprint !== hash) return fail('operation identity conflict');
      if (op.phase === 'unknown') fail('unknown requires explicit authoritative reconciliation');
      if (op.phase === 'accepted') {
        if (op.stock_id === null && op.consumed === 1) {
          if (sourceGeneration !== this.sourceGeneration ||
              clientUserMessageId !== opId || threadId !== this.taskId ||
              typeof assertSourceCurrent !== 'function' || assertSourceCurrent() !== true ||
              !Array.isArray(input) ||
              !isDeepStrictEqual(input, JSON.parse(op.stock_input_json))) {
            fail('late stock receipt lacks exact source and input proof');
          }
          if (this.fillLateStock.run(stockId, this.taskId, opId).changes !== 1) fail('late stock receipt conflict');
          this.insertEvidence.run(this.taskId, opId, 'late-stock', json({
            sourceGeneration: this.sourceGeneration, stockId, inputHash: hashJson(input as JsonValue[]),
          }));
          this.bump(task, false); // Consumed entries never reappear in the native publication.
          return this.readOperation(opId) ?? fail('accepted operation absent');
        }
        if (op.stock_id !== stockId) fail('stock receipt conflict');
        return this.readOperation(opId) ?? fail('accepted operation absent');
      }
      const changed = this.acceptOp.run(stockId, this.taskId, opId);
      if (changed.changes !== 1) fail('accepted phase conflict');
      this.bump(task, true); // Emits [] too when authoritative consume preceded the ACK.
      return this.readOperation(opId) ?? fail('accepted operation absent');
    });
  }

  reconciliationEvidence(opId: string): ReconciliationEvidence[] {
    if (!nonempty(opId)) fail('operation ID required');
    return this.snapshot(() => {
      this.taskRow(); // Even evidence reads must match both owner epoch and source generation.
      return this.selectEvidence.all(this.taskId, opId).map(row => ({
        kind: row.kind, proof: JSON.parse(row.proof_json) as ReconciliationEvidence['proof'],
      })) as ReconciliationEvidence[];
    });
  }

  reconcilePositive({ expectedVersion, proof, assertSourceCurrent }: {
    expectedVersion: number; proof: PositiveReconciliationProof; assertSourceCurrent: () => boolean
  }): StockQueueOperation {
    const expectedKeys = proof?.kind === 'queued'
      ? ['admissionEvidence','clientUserMessageId','complete','effectiveSettings','input','kind',
        'ownerEpoch','sourceGeneration','sourceRevision','stockId','taskId']
      : ['admissionEvidence','clientUserMessageId','complete','effectiveSettings','input','kind',
        'ownerEpoch','sourceGeneration','sourceRevision','taskId','turnId'];
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        !plain(proof) || (proof.kind !== 'queued' && proof.kind !== 'started') ||
        Reflect.ownKeys(proof).some(key => typeof key !== 'string') ||
        Object.keys(proof).sort().join('|') !== expectedKeys.sort().join('|') ||
        proof.taskId !== this.taskId || proof.ownerEpoch !== this.ownerEpoch ||
        proof.sourceGeneration !== this.sourceGeneration || proof.complete !== true ||
        !Number.isSafeInteger(proof.sourceRevision) || proof.sourceRevision < 0 ||
        !nonempty(proof.clientUserMessageId) || !Array.isArray(proof.input) ||
        !plain(proof.admissionEvidence) || !plain(proof.effectiveSettings) ||
        typeof assertSourceCurrent !== 'function' ||
        (proof.kind === 'queued' && !nonempty(proof.stockId)) ||
        (proof.kind === 'started' && !nonempty(proof.turnId))) {
      fail('incomplete positive reconciliation proof');
    }
    const proofJson = json(proof);
    return this.transaction(() => {
      if (assertSourceCurrent() !== true) fail('reconciliation source changed');
      const task = this.taskRow();
      const op = this.selectOp.get(this.taskId, proof.clientUserMessageId);
      if (!task || !op) return fail('reconciliation operation absent');
      if (task.version !== expectedVersion) fail('stale reconciliation version');
      if (!isDeepStrictEqual(proof.input, JSON.parse(op.stock_input_json)) ||
          !isDeepStrictEqual(proof.admissionEvidence, JSON.parse(op.admission_evidence_json)) ||
          !isDeepStrictEqual(proof.effectiveSettings, JSON.parse(task.settings_json ?? 'null'))) {
        fail('reconciliation intent, settings or input conflict');
      }
      const stockId = proof.kind === 'queued' ? proof.stockId : op.stock_id;
      const turnId = proof.kind === 'started' ? proof.turnId : op.accepted_turn_id;
      const consumed = proof.kind === 'started' ? 1 : op.consumed;
      if (op.stock_id !== null && stockId !== null && op.stock_id !== stockId) fail('stock ID conflict');
      if (op.accepted_turn_id !== null && turnId !== null && op.accepted_turn_id !== turnId) {
        fail('turn ID conflict');
      }
      if (op.phase === 'accepted') {
        const seen = this.selectEvidence.all(this.taskId, op.op_id).some(row =>
          row.kind === proof.kind && isDeepStrictEqual(JSON.parse(row.proof_json), proof));
        if (!seen) fail('already accepted with different reconciliation proof');
        return this.readOperation(op.op_id) ?? fail('accepted operation absent');
      }
      const changed = this.acceptReconciled.run(stockId, turnId, consumed, this.taskId, op.op_id);
      if (changed.changes !== 1) fail('reconciliation phase conflict');
      this.insertEvidence.run(this.taskId, op.op_id, proof.kind, proofJson);
      this.bump(task, true); // Includes an empty publication for an already started turn.
      return this.readOperation(op.op_id) ?? fail('reconciled operation absent');
    });
  }

  markUnknown({ opId, fingerprint: hash }: { opId: string; fingerprint: string }): StockQueueOperation {
    if (!nonempty(opId) || !fingerprint(hash)) fail('unknown receipt incomplete');
    return this.transaction(() => {
      const task = this.taskRow(); const op = this.selectOp.get(this.taskId, opId);
      if (!task || !op) return fail('operation identity conflict');
      if (op.fingerprint !== hash) return fail('operation identity conflict');
      if (op.phase === 'accepted') fail('accepted result cannot downgrade');
      if (op.phase === 'unknown') return this.readOperation(opId) ?? fail('unknown operation absent');
      const changed = this.unknownOp.run(this.taskId, opId);
      if (changed.changes !== 1) fail('unknown phase conflict');
      this.bump(task, false);
      return this.readOperation(opId) ?? fail('unknown operation absent');
    });
  }

  consume({ opId, fingerprint: hash, turnId, authoritative }: { opId: string; fingerprint: string;
    turnId: string; authoritative: boolean }): StockQueueOperation {
    if (!nonempty(opId) || !fingerprint(hash) || !nonempty(turnId) || authoritative !== true) {
      fail('authoritative turn identity required');
    }
    return this.transaction(() => {
      const task = this.taskRow(); const op = this.selectOp.get(this.taskId, opId);
      if (!task || !op) return fail('operation identity conflict');
      if (op.fingerprint !== hash) return fail('operation identity conflict');
      if (op.accepted_turn_id !== null) {
        if (op.accepted_turn_id !== turnId) fail('turn identity conflict');
        return this.readOperation(opId) ?? fail('consumed operation absent');
      }
      const changed = this.consumeOp.run(turnId, this.taskId, opId);
      if (changed.changes !== 1) fail('consume conflict');
      this.bump(task, op.phase === 'accepted');
      return this.readOperation(opId) ?? fail('consumed operation absent');
    });
  }

  acknowledgePublication({ version }: { version: number }): { acknowledged: boolean; currentVersion: number } {
    if (!Number.isSafeInteger(version) || version < 1) fail('publication version required');
    return this.transaction(() => {
      const task = this.taskRow();
      if (!task) return { acknowledged: false, currentVersion: 0 };
      if (version !== task.publication_version || version <= task.publication_acked_version) {
        return { acknowledged: false, currentVersion: task.publication_version };
      }
      const changed = this.ackPublication.run(version, this.taskId, task.version, version);
      if (changed.changes !== 1) fail('concurrent publication update');
      return { acknowledged: true, currentVersion: version };
    });
  }
  close() { this.db.close(); }
}
