import { mkdirSync } from 'node:fs';
import path from 'node:path';
import DatabaseConstructor, { type Database } from 'better-sqlite3';

type State = 'thread-reserved' | 'thread-accepted' | 'turn-reserved' | 'turn-unknown' | 'turn-accepted';
interface Row {
  operation_id: string; source_id: string; source_generation: string; owner_epoch: string;
  start_fingerprint: string;
  backend_identity: string; state: State; revision: number; thread_id: string | null;
  client_user_message_id: string | null; keyed_fingerprint: string | null; turn_id: string | null;
}
export interface NativeFirstTurnBootstrapRecord {
  readonly operationId: string;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly ownerEpoch: string;
  /** Caller-derived keyed digest of immutable thread/start params. */
  readonly threadStartFingerprint: string;
  /** Pinned 64-hex backend identity digest, never a mutable display generation. */
  readonly backendIdentity: string;
  readonly state: State;
  readonly revision: number;
  readonly threadId: string | null;
  readonly clientUserMessageId: string | null;
  /** Caller-derived keyed 64-hex digest; prompt and bearer values are never accepted here. */
  readonly keyedFingerprint: string | null;
  readonly turnId: string | null;
}
export interface NativeFirstTurnBootstrapIdentity {
  readonly operationId: string;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly ownerEpoch: string;
  readonly threadStartFingerprint: string;
  readonly backendIdentity: string;
}

// Codex thread IDs may be UUIDv7; creator/owner IDs are currently UUIDv4.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const identifier = (value: unknown, limit = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/u.test(value);
const fail = (): never => { throw new Error('First-turn bootstrap journal conflict or invalid record'); };
function validIdentity(value: NativeFirstTurnBootstrapIdentity): void {
  if (!UUID.test(value.operationId) || !identifier(value.sourceId) || !UUID.test(value.sourceGeneration) ||
  !UUID.test(value.ownerEpoch) || !FINGERPRINT.test(value.threadStartFingerprint) ||
  !FINGERPRINT.test(value.backendIdentity)) fail();
}
function validRow(row: Row): NativeFirstTurnBootstrapRecord {
  const record: NativeFirstTurnBootstrapRecord = { operationId: row.operation_id, sourceId: row.source_id,
    sourceGeneration: row.source_generation, ownerEpoch: row.owner_epoch,
    threadStartFingerprint: row.start_fingerprint, backendIdentity: row.backend_identity,
    state: row.state, revision: row.revision, threadId: row.thread_id,
    clientUserMessageId: row.client_user_message_id, keyedFingerprint: row.keyed_fingerprint, turnId: row.turn_id };
  validIdentity(record);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > 5) fail();
  const none = record.threadId === null && record.clientUserMessageId === null &&
    record.keyedFingerprint === null && record.turnId === null;
  const acceptedThread = UUID.test(record.threadId ?? '');
  const reservedTurn = acceptedThread && identifier(record.clientUserMessageId) &&
    FINGERPRINT.test(record.keyedFingerprint ?? '') && record.turnId === null;
  const acceptedTurn = reservedTurn === false && acceptedThread && identifier(record.clientUserMessageId) &&
    FINGERPRINT.test(record.keyedFingerprint ?? '') && identifier(record.turnId);
  if (!(record.state === 'thread-reserved' && record.revision === 1 && none) &&
    !(record.state === 'thread-accepted' && record.revision === 2 && acceptedThread &&
      record.clientUserMessageId === null && record.keyedFingerprint === null && record.turnId === null) &&
    !(record.state === 'turn-reserved' && record.revision === 3 && reservedTurn) &&
    !(record.state === 'turn-unknown' && record.revision === 4 && reservedTurn) &&
    !(record.state === 'turn-accepted' && (record.revision === 4 || record.revision === 5) && acceptedTurn)) fail();
  return Object.freeze(record);
}

/** One bootstrap operation per database. Deliberately independent from the
 * controlled zero-turn journal: an unknown start blocks replay after reopen. */
export class NativeFirstTurnBootstrapJournal {
  readonly #db: Database;
  #closed = false;
  constructor(filePath: string) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail();
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.#db = new DatabaseConstructor(filePath);
    try {
      this.#db.pragma('busy_timeout = 5000'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('synchronous = FULL');
      this.#db.exec(`CREATE TABLE IF NOT EXISTS native_first_turn_bootstraps (
        operation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_generation TEXT NOT NULL,
        owner_epoch TEXT NOT NULL, start_fingerprint TEXT NOT NULL, backend_identity TEXT NOT NULL, state TEXT NOT NULL
          CHECK(state IN ('thread-reserved','thread-accepted','turn-reserved','turn-unknown','turn-accepted')),
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 5), thread_id TEXT UNIQUE,
        client_user_message_id TEXT UNIQUE, keyed_fingerprint TEXT, turn_id TEXT,
        CHECK((state='thread-reserved' AND revision=1 AND thread_id IS NULL AND client_user_message_id IS NULL AND keyed_fingerprint IS NULL AND turn_id IS NULL)
          OR (state='thread-accepted' AND revision=2 AND thread_id IS NOT NULL AND client_user_message_id IS NULL AND keyed_fingerprint IS NULL AND turn_id IS NULL)
          OR (state IN ('turn-reserved','turn-unknown') AND revision IN (3,4) AND thread_id IS NOT NULL AND client_user_message_id IS NOT NULL AND keyed_fingerprint IS NOT NULL AND turn_id IS NULL)
          OR (state='turn-accepted' AND revision IN (4,5) AND thread_id IS NOT NULL AND client_user_message_id IS NOT NULL AND keyed_fingerprint IS NOT NULL AND turn_id IS NOT NULL))
      )`);
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
  synchronousMode(): number { this.#open(); return this.#db.pragma('synchronous', { simple: true }) as number; }
  #open(): void { if (this.#closed) fail(); }
  get(operationId: string): NativeFirstTurnBootstrapRecord | null {
    this.#open(); if (!UUID.test(operationId)) fail();
    const row = this.#db.prepare('SELECT * FROM native_first_turn_bootstraps WHERE operation_id=?').get(operationId) as Row | undefined;
    return row ? validRow(row) : null;
  }
  persistThreadStartIntent(intent: NativeFirstTurnBootstrapIdentity): void {
    this.#open(); validIdentity(intent);
    try { this.#db.transaction(() => {
      // A new operation ID must not bypass an uncertain earlier start after a
      // process restart. Other tasks use a different protected journal file.
      if (this.#db.prepare('SELECT 1 FROM native_first_turn_bootstraps LIMIT 1').get()) fail();
      this.#db.prepare(`INSERT INTO native_first_turn_bootstraps
        (operation_id,source_id,source_generation,owner_epoch,start_fingerprint,backend_identity,state,revision)
        VALUES (?,?,?,?,?,?,'thread-reserved',1)`).run(intent.operationId, intent.sourceId,
        intent.sourceGeneration, intent.ownerEpoch, intent.threadStartFingerprint, intent.backendIdentity);
    }).immediate(); } catch { fail(); }
  }
  persistThreadAccepted({ operationId, expectedRevision, threadId }: {
    readonly operationId: string; readonly expectedRevision: number; readonly threadId: string;
  }): void { this.#transition({ operationId, expectedRevision, state: 'thread-reserved', next: 'thread-accepted',
    nextRevision: 2, changes: ['thread_id=?'], values: [threadId], validate: () => { if (!UUID.test(threadId)) fail(); } }); }
  reserveFirstTurn({ operationId, expectedRevision, clientUserMessageId, keyedFingerprint }: {
    readonly operationId: string; readonly expectedRevision: number; readonly clientUserMessageId: string; readonly keyedFingerprint: string;
  }): void { this.#transition({ operationId, expectedRevision, state: 'thread-accepted', next: 'turn-reserved',
    nextRevision: 3, changes: ['client_user_message_id=?', 'keyed_fingerprint=?'], values: [clientUserMessageId, keyedFingerprint],
    validate: () => { if (!identifier(clientUserMessageId) || !FINGERPRINT.test(keyedFingerprint)) fail(); } }); }
  markFirstTurnUnknown({ operationId, expectedRevision }: { readonly operationId: string; readonly expectedRevision: number }): void {
    this.#transition({ operationId, expectedRevision, state: 'turn-reserved', next: 'turn-unknown', nextRevision: 4,
      changes: [], values: [], validate: () => {} });
  }
  markFirstTurnAccepted({ operationId, expectedRevision, turnId }: {
    readonly operationId: string; readonly expectedRevision: number; readonly turnId: string;
  }): void {
    const prior = this.get(operationId);
    if (!prior) fail();
    const current = prior as NativeFirstTurnBootstrapRecord;
    if (current.revision !== expectedRevision) fail();
    if (current.state === 'turn-reserved') this.#transition({ operationId, expectedRevision, state: 'turn-reserved', next: 'turn-accepted', nextRevision: 4,
      changes: ['turn_id=?'], values: [turnId], validate: () => { if (!identifier(turnId)) fail(); } });
    else if (current.state === 'turn-unknown') this.#transition({ operationId, expectedRevision, state: 'turn-unknown', next: 'turn-accepted', nextRevision: 5,
      changes: ['turn_id=?'], values: [turnId], validate: () => { if (!identifier(turnId)) fail(); } });
    else fail();
  }
  #transition(input: { operationId: string; expectedRevision: number; state: State; next: State; nextRevision: number;
    changes: readonly string[]; values: readonly string[]; validate(): void }): void {
    this.#open(); if (!UUID.test(input.operationId) || !Number.isSafeInteger(input.expectedRevision)) fail(); input.validate();
    try { this.#db.transaction(() => {
      const set = ['state=?', 'revision=?', ...input.changes].join(',');
      const changed = this.#db.prepare(`UPDATE native_first_turn_bootstraps SET ${set}
        WHERE operation_id=? AND state=? AND revision=?`).run(input.next, input.nextRevision, ...input.values,
        input.operationId, input.state, input.expectedRevision);
      if (changed.changes !== 1) fail();
    }).immediate(); } catch { fail(); }
  }
}
