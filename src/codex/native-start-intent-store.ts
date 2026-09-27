import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import DatabaseConstructor, { type Database } from 'better-sqlite3';
import type { WorkerCommand } from './managed-worker-command-dispatcher.js';

type Row = Record<string, unknown>;
export interface NativeStartIntent {
  readonly envelope: Row;
  readonly command: WorkerCommand;
  readonly uiParams: Row | null;
  readonly localMetadata: Row | null;
  /** Captured pre-dispatch authority. A reopened NEW write must fence this against live authority. */
  readonly admission: Row;
}
export interface NativeStartIntentRecord {
  readonly operationId: string;
  readonly clientUserMessageId: string;
  readonly intent: NativeStartIntent;
}
export interface NativeStartIntentStoreOptions {
  readonly filePath: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly threadId: string;
  /** Fresh caller-managed 32-byte key; never generated, persisted, or logged here. */
  readonly encryptionKey: Uint8Array;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}
interface ScopeRow {
  owner_epoch: string; backend_generation: number; thread_id: string;
  nonce: Buffer; tag: Buffer; seal: Buffer;
}
interface IntentRow {
  operation_id: string; client_user_message_id: string;
  nonce: Buffer; tag: Buffer; ciphertext: Buffer; bytes: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const schema = 'native-start-intent-v1';
const marker = Buffer.from('native-start-intent-key-check-v1');
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new Error('Native start intent unavailable or invalid'); }
function bounded(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function identity(value: unknown): string {
  const result = bounded(value, 36);
  if (!uuid.test(result)) fail();
  return result;
}
function exact(value: unknown, keys: readonly string[]): asserts value is Row {
  if (!object(value) || Reflect.ownKeys(value).sort().join('|') !== [...keys].sort().join('|')) fail();
}
function strictJson<T>(value: T, maxBytes: number): { value: T; encoded: Buffer } {
  try {
    const snapshot = structuredClone(value);
    const encoded = JSON.stringify(snapshot, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
          typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) fail();
      return item;
    });
    if (!encoded) fail();
    const bytes = Buffer.from(encoded, 'utf8');
    if (bytes.length > maxBytes || !isDeepStrictEqual(snapshot, JSON.parse(encoded))) fail();
    return { value: snapshot, encoded: bytes };
  } catch { return fail(); }
}
function validateIntent(value: unknown, operationId: string, clientId: string, threadId: string,
  ownerEpoch: string, backendGeneration: number): asserts value is NativeStartIntent {
  exact(value, ['envelope', 'command', 'uiParams', 'localMetadata', 'admission']);
  exact(value.command, ['operationId', 'method', 'params']);
  if (value.command.operationId !== operationId || value.command.method !== 'turn/start' ||
      !object(value.command.params) || value.command.params.threadId !== threadId ||
      value.command.params.clientUserMessageId !== clientId ||
      !Array.isArray(value.command.params.input) || value.command.params.input.length === 0) fail();
  if (!object(value.envelope) || value.envelope.conversationId !== threadId ||
      !object(value.envelope.turnStart) || !object(value.envelope.turnStart.request) ||
      value.envelope.turnStart.request.threadId !== threadId ||
      value.envelope.turnStart.request.clientUserMessageId !== clientId ||
      value.uiParams !== null && !object(value.uiParams) ||
      value.localMetadata !== null && !object(value.localMetadata)) fail();
  if (!object(value.admission) || value.admission.ownerEpoch !== ownerEpoch ||
      value.admission.backendGeneration !== backendGeneration ||
      !object(value.admission.snapshot) || value.admission.snapshot.id !== threadId) fail();
}

/** Encrypted immutable intent only. The operation journal still owns acceptance/receipts. */
export class NativeStartIntentStore {
  readonly owner: Readonly<{ ownerEpoch: string; backendGeneration: number; threadId: string }>;
  readonly #db!: Database;
  readonly #key: Buffer;
  readonly #maxRows: number;
  readonly #maxBytes: number;
  #closed = false;

  constructor(options: NativeStartIntentStoreOptions) {
    if (!options || typeof options.filePath !== 'string' || !path.isAbsolute(options.filePath) ||
        !(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32 ||
        !Number.isSafeInteger(options.backendGeneration) || options.backendGeneration < 1) fail();
    this.owner = Object.freeze({ ownerEpoch: identity(options.ownerEpoch),
      backendGeneration: options.backendGeneration, threadId: bounded(options.threadId, 256) });
    this.#maxRows = options.maxRows ?? 1024;
    this.#maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxRows) || this.#maxRows < 1 || this.#maxRows > 1024 ||
        !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 || this.#maxBytes > 128 * 1024 * 1024) fail();
    this.#key = Buffer.from(options.encryptionKey);
    try {
      // Parent directory must already exist under a caller-approved private ACL.
      this.#db = new DatabaseConstructor(options.filePath);
      this.#db.pragma('busy_timeout = 5000');
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = FULL');
      this.#db.exec(`CREATE TABLE IF NOT EXISTS native_start_intent_scope (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_epoch TEXT NOT NULL,
        backend_generation INTEGER NOT NULL, thread_id TEXT NOT NULL,
        nonce BLOB NOT NULL, tag BLOB NOT NULL, seal BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_start_intents (
        operation_id TEXT PRIMARY KEY, client_user_message_id TEXT NOT NULL UNIQUE,
        nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes > 0)
      );`);
      this.#db.transaction(() => {
        const existing = this.#db.prepare('SELECT * FROM native_start_intent_scope WHERE singleton=1').get() as ScopeRow | undefined;
        if (existing) {
          if (existing.owner_epoch !== this.owner.ownerEpoch ||
              existing.backend_generation !== this.owner.backendGeneration ||
              existing.thread_id !== this.owner.threadId ||
              !this.#decrypt(existing, this.#aad('scope')).equals(marker)) fail();
        } else {
          const sealed = this.#encrypt(marker, this.#aad('scope'));
          this.#db.prepare('INSERT INTO native_start_intent_scope VALUES (1,?,?,?,?,?,?)').run(
            this.owner.ownerEpoch, this.owner.backendGeneration, this.owner.threadId,
            sealed.nonce, sealed.tag, sealed.ciphertext);
        }
        const totals = this.#db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(bytes),0) AS bytes FROM native_start_intents')
          .get() as { rows: number; bytes: number };
        if (totals.rows > this.#maxRows || totals.bytes > this.#maxBytes) fail();
      }).immediate();
    } catch (error) {
      this.#db?.close(); this.#key.fill(0);
      throw error;
    }
  }

  #aad(...parts: (string | number)[]): Buffer {
    return Buffer.from(JSON.stringify([schema, this.owner.ownerEpoch,
      this.owner.backendGeneration, this.owner.threadId, ...parts]), 'utf8');
  }
  #encrypt(value: Buffer, aad: Buffer): { nonce: Buffer; tag: Buffer; ciphertext: Buffer } {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return { nonce, tag: cipher.getAuthTag(), ciphertext };
  }
  #decrypt(row: { nonce: Buffer; tag: Buffer; ciphertext?: Buffer; seal?: Buffer }, aad: Buffer): Buffer {
    try {
      if (!Buffer.isBuffer(row.nonce) || row.nonce.length !== 12 ||
          !Buffer.isBuffer(row.tag) || row.tag.length !== 16) fail();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, row.nonce);
      decipher.setAAD(aad); decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext ?? row.seal ?? Buffer.alloc(0)), decipher.final()]);
    } catch { return fail(); }
  }
  #open(): void { if (this.#closed) fail(); }
  #record(row: IntentRow): NativeStartIntentRecord {
    const plaintext = this.#decrypt(row, this.#aad(row.operation_id, row.client_user_message_id));
    if (plaintext.length !== row.bytes) fail();
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    validateIntent(parsed, row.operation_id, row.client_user_message_id, this.owner.threadId,
      this.owner.ownerEpoch, this.owner.backendGeneration);
    return { operationId: row.operation_id, clientUserMessageId: row.client_user_message_id,
      intent: parsed };
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } finally { this.#key.fill(0); }
  }
  get(operationId: string): NativeStartIntentRecord | null {
    this.#open(); const id = identity(operationId);
    const row = this.#db.prepare('SELECT * FROM native_start_intents WHERE operation_id=?').get(id) as IntentRow | undefined;
    return row ? this.#record(row) : null;
  }
  getByClientUserMessageId(clientId: string): NativeStartIntentRecord | null {
    this.#open(); const id = bounded(clientId, 128);
    const row = this.#db.prepare('SELECT * FROM native_start_intents WHERE client_user_message_id=?').get(id) as IntentRow | undefined;
    return row ? this.#record(row) : null;
  }
  list(): NativeStartIntentRecord[] {
    this.#open();
    return (this.#db.prepare('SELECT * FROM native_start_intents ORDER BY rowid').all() as IntentRow[])
      .map(row => this.#record(row));
  }
  reserve(operationId: string, clientUserMessageId: string, intent: NativeStartIntent):
    { created: boolean; record: NativeStartIntentRecord } {
    this.#open(); const op = identity(operationId), client = bounded(clientUserMessageId, 128);
    const copied = strictJson(intent, 32 * 1024 * 1024);
    validateIntent(copied.value, op, client, this.owner.threadId,
      this.owner.ownerEpoch, this.owner.backendGeneration);
    return this.#db.transaction(() => {
      const prior = this.get(op);
      if (prior) {
        if (prior.clientUserMessageId !== client || !isDeepStrictEqual(prior.intent, copied.value)) fail();
        return { created: false, record: prior };
      }
      if (this.getByClientUserMessageId(client)) fail();
      const totals = this.#db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(bytes),0) AS bytes FROM native_start_intents')
        .get() as { rows: number; bytes: number };
      if (totals.rows >= this.#maxRows || totals.bytes + copied.encoded.length > this.#maxBytes) fail();
      const encrypted = this.#encrypt(copied.encoded, this.#aad(op, client));
      this.#db.prepare('INSERT INTO native_start_intents VALUES (?,?,?,?,?,?)').run(
        op, client, encrypted.nonce, encrypted.tag, encrypted.ciphertext, copied.encoded.length);
      return { created: true, record: this.get(op)! };
    }).immediate();
  }
}
