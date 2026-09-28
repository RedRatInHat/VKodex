import { isDeepStrictEqual } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { approveTaskPolicy } from '../codex/managed-task-policy.js';
import { policyFromControlledStarted, type ControlledCreationIntent,
  type ControlledCreationStarted, type ControlledCreationReceipt } from './controlled-native-task-creator.js';

type State = 'intent' | 'started' | 'qualified';
interface StoredRow {
  sequence: number; operation_id: string; thread_id: string | null; state: State; revision: number;
  intent_json: string; started_json: string | null; qualified_json: string | null;
}
export interface ControlledCreationJournalRecord {
  readonly sequence: number;
  readonly state: State;
  readonly revision: number;
  readonly intent: ControlledCreationIntent;
  readonly started: ControlledCreationStarted | null;
  readonly qualified: ControlledCreationReceipt | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const legacySelectedKeys = ['model', 'modelProvider', 'reasoningEffort',
  'serviceTier', 'cwd', 'approvalPolicy', 'environments'] as const;
const fullSelectedKeys = [...legacySelectedKeys, 'runtimeWorkspaceRoots',
  'approvalsReviewer', 'activePermissionProfile', 'sandbox'] as const;
const reconcilableSelectedKeys = [...fullSelectedKeys, 'startThread', 'nativeShapeExact'] as const;
const keys = (value: unknown, expected: readonly string[]): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
const sameWindowsPath = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' &&
  path.win32.isAbsolute(a) && path.win32.isAbsolute(b) &&
  path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const fail = (): never => { throw new Error('Controlled creation journal conflict or invalid record'); };
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}
function strictJson<T>(value: T): { snapshot: T; json: string } {
  try {
    const snapshot = structuredClone(value);
    const json = JSON.stringify(snapshot, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) fail();
      return item;
    });
    if (!json || Buffer.byteLength(json, 'utf8') > 64 * 1024 ||
      !isDeepStrictEqual(snapshot, JSON.parse(json))) fail();
    return { snapshot: freezeTree(snapshot), json };
  } catch { return fail(); }
}
function validIntent(value: ControlledCreationIntent): void {
  if (!keys(value, ['operationId', 'creatorNonce', 'sourceGeneration', 'sourceId', 'requestedPolicy']) ||
    !uuid.test(value.operationId) || !uuid.test(value.creatorNonce) ||
    !uuid.test(value.sourceGeneration) || typeof value.sourceId !== 'string' ||
    !value.sourceId || value.sourceId.length > 256 || /[\x00-\x1f\x7f]/u.test(value.sourceId) ||
    !keys(value.requestedPolicy, ['model', 'modelProvider', 'effort', 'cwd',
      'runtimeWorkspaceRoots', 'approvalPolicy', 'approvalsReviewer',
      'activePermissionProfile', 'sandbox', 'allowedServiceTiers',
      'allowedEnvironments'])) fail();
  const requested = value.requestedPolicy;
  if (!Array.isArray(requested.allowedServiceTiers) ||
    requested.allowedServiceTiers.length < 1 || requested.allowedServiceTiers.length > 4 ||
    !Array.isArray(requested.allowedEnvironments) ||
    requested.allowedEnvironments.length < 1 || requested.allowedEnvironments.length > 4) fail();
  const { allowedServiceTiers: _tiers, allowedEnvironments: _environments, ...fixed } = requested;
  for (const tier of requested.allowedServiceTiers)
    for (const environment of requested.allowedEnvironments)
      approveTaskPolicy({ ...fixed, threadId: '00000000-0000-4000-8000-000000000000',
        serviceTier: tier, environments: environment });
}
function intentOf(value: ControlledCreationStarted): ControlledCreationIntent {
  return { operationId: value.operationId, creatorNonce: value.creatorNonce,
    sourceGeneration: value.sourceGeneration, sourceId: value.sourceId,
    requestedPolicy: value.requestedPolicy };
}
function startedOf(value: ControlledCreationReceipt): ControlledCreationStarted {
  return { ...intentOf(value), threadId: value.threadId, selectedEffective: value.selectedEffective };
}
function validStarted(value: ControlledCreationStarted): void {
  if (!keys(value, ['operationId', 'creatorNonce', 'sourceGeneration', 'sourceId',
    'requestedPolicy', 'threadId', 'selectedEffective']) || !uuid.test(value.threadId) ||
    !keys(value.selectedEffective, legacySelectedKeys) &&
    !keys(value.selectedEffective, fullSelectedKeys) &&
    !keys(value.selectedEffective, reconcilableSelectedKeys)) fail();
  if (keys(value.selectedEffective, reconcilableSelectedKeys) &&
    (!keys(value.selectedEffective.startThread, ['status', 'turnCount', 'model',
      'modelProvider', 'reasoningEffort', 'cwd']) ||
      typeof value.selectedEffective.nativeShapeExact !== 'boolean')) fail();
  validIntent(intentOf(value));
}
function validQualified(value: ControlledCreationReceipt): void {
  if (!keys(value, ['operationId', 'creatorNonce', 'sourceGeneration', 'sourceId',
    'requestedPolicy', 'threadId', 'selectedEffective', 'effectivePolicy',
    'rolloutPath', 'status']) || value.status !== 'qualified-zero-turn' ||
    typeof value.rolloutPath !== 'string' || !path.win32.isAbsolute(value.rolloutPath) ||
    /[\x00-\x1f\x7f]/u.test(value.rolloutPath) || value.rolloutPath.length > 4096) fail();
  validStarted(startedOf(value));
  const policy = approveTaskPolicy(value.effectivePolicy);
  const { allowedServiceTiers, allowedEnvironments, ...fixed } = value.requestedPolicy;
  const { threadId: _threadId, serviceTier: _serviceTier, environments: _selectedEnvironments,
    ...actualFixed } = policy;
  if (policy.threadId !== value.threadId || !isDeepStrictEqual(actualFixed, fixed) ||
    !allowedServiceTiers.includes(policy.serviceTier) ||
    !allowedEnvironments.some(environment => isDeepStrictEqual(environment, policy.environments)) ||
    value.selectedEffective.model !== policy.model ||
    value.selectedEffective.modelProvider !== policy.modelProvider ||
    value.selectedEffective.reasoningEffort !== policy.effort ||
    value.selectedEffective.serviceTier !== policy.serviceTier ||
    !sameWindowsPath(value.selectedEffective.cwd, policy.cwd) ||
    value.selectedEffective.approvalPolicy !== policy.approvalPolicy ||
    !isDeepStrictEqual(value.selectedEffective.environments, policy.environments)) fail();
  if ((keys(value.selectedEffective, fullSelectedKeys) ||
    keys(value.selectedEffective, reconcilableSelectedKeys)) &&
    (!isDeepStrictEqual(value.selectedEffective.runtimeWorkspaceRoots, policy.runtimeWorkspaceRoots) ||
      value.selectedEffective.approvalsReviewer !== policy.approvalsReviewer ||
      !isDeepStrictEqual(value.selectedEffective.activePermissionProfile, policy.activePermissionProfile) ||
      !isDeepStrictEqual(value.selectedEffective.sandbox, policy.sandbox))) fail();
  if (keys(value.selectedEffective, reconcilableSelectedKeys) &&
    !isDeepStrictEqual(policyFromControlledStarted(startedOf(value)), policy)) fail();
}

/** Durable, single-operation evidence. An intent or started row after restart is
 * reconciliation-only; this journal never authorizes replaying thread/start. */
export class ControlledNativeCreationJournal {
  readonly #db: Database;
  #closed = false;

  constructor(filePath: string) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail();
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.#db = new DatabaseConstructor(filePath);
    try {
      this.#db.pragma('busy_timeout = 5000');
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = FULL');
      this.#db.exec(`CREATE TABLE IF NOT EXISTS controlled_native_creations (
        operation_id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, state TEXT NOT NULL
          CHECK(state IN ('intent','started','qualified')),
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 3),
        intent_json TEXT NOT NULL, started_json TEXT, qualified_json TEXT,
        CHECK((state='intent' AND revision=1 AND thread_id IS NULL AND started_json IS NULL AND qualified_json IS NULL)
          OR (state='started' AND revision=2 AND thread_id IS NOT NULL AND started_json IS NOT NULL AND qualified_json IS NULL)
          OR (state='qualified' AND revision=3 AND thread_id IS NOT NULL AND started_json IS NOT NULL AND qualified_json IS NOT NULL))
      )`);
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#db.close(); }
  synchronousMode(): number { this.#open(); return this.#db.pragma('synchronous', { simple: true }) as number; }
  #open(): void { if (this.#closed) fail(); }
  #decode(row: StoredRow): ControlledCreationJournalRecord {
    const intent = JSON.parse(row.intent_json) as ControlledCreationIntent;
    validIntent(intent);
    if (intent.operationId !== row.operation_id) fail();
    const started = row.started_json === null ? null : JSON.parse(row.started_json) as ControlledCreationStarted;
    if (started) {
      validStarted(started);
      if (started.threadId !== row.thread_id || !isDeepStrictEqual(intent, intentOf(started))) fail();
    }
    const qualified = row.qualified_json === null ? null : JSON.parse(row.qualified_json) as ControlledCreationReceipt;
    if (qualified) {
      validQualified(qualified);
      if (!started || !isDeepStrictEqual(started, startedOf(qualified))) fail();
    }
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) fail();
    return freezeTree({ sequence: row.sequence, state: row.state,
      revision: row.revision, intent, started, qualified });
  }
  get(operationId: string): ControlledCreationJournalRecord | null {
    this.#open(); if (!uuid.test(operationId)) fail();
    const row = this.#db.prepare('SELECT rowid AS sequence,* FROM controlled_native_creations WHERE operation_id=?')
      .get(operationId) as StoredRow | undefined;
    return row ? this.#decode(row) : null;
  }
  listUncertainPage({ afterSequence = 0, limit }: {
    readonly afterSequence?: number; readonly limit: number;
  }): Readonly<{ items: readonly ControlledCreationJournalRecord[]; nextCursor: number | null }> {
    this.#open();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail();
    // This journal is append-only: no method deletes rows, so SQLite rowid is
    // a stable forward cursor without changing the published table schema.
    const rows = this.#db.prepare(`SELECT rowid AS sequence,* FROM controlled_native_creations
      WHERE rowid > ? AND state IN ('intent','started') ORDER BY rowid LIMIT ?`)
      .all(afterSequence, limit + 1) as StoredRow[];
    const items = Object.freeze(rows.slice(0, limit).map(row => this.#decode(row)));
    return Object.freeze({ items, nextCursor: rows.length > limit ? items[items.length - 1]!.sequence : null });
  }
  async persistIntent(intent: ControlledCreationIntent): Promise<Readonly<{ isCurrent(): boolean }>> {
    this.#open();
    const copy = strictJson(intent); validIntent(copy.snapshot);
    this.#db.transaction(() => {
      if (this.get(intent.operationId)) fail();
      this.#db.prepare(`INSERT INTO controlled_native_creations
        (operation_id,state,revision,intent_json) VALUES (?,'intent',1,?)`)
        .run(intent.operationId, copy.json);
    }).immediate();
    const operationId = intent.operationId;
    return Object.freeze({ isCurrent: () => {
      if (this.#closed) return false;
      const current = this.get(operationId);
      return current !== null && isDeepStrictEqual(current.intent, copy.snapshot);
    } });
  }
  async persistStarted(started: ControlledCreationStarted): Promise<void> {
    this.#open(); const copy = strictJson(started); validStarted(copy.snapshot);
    this.#db.transaction(() => {
      const prior = this.get(started.operationId);
      if (!prior || prior.state !== 'intent' || !isDeepStrictEqual(prior.intent, intentOf(copy.snapshot))) fail();
      const updated = this.#db.prepare(`UPDATE controlled_native_creations SET state='started',revision=2,
        thread_id=?,started_json=? WHERE operation_id=? AND state='intent' AND revision=1`)
        .run(started.threadId, copy.json, started.operationId);
      if (updated.changes !== 1) fail();
    }).immediate();
  }
  async persistQualified(qualified: ControlledCreationReceipt): Promise<void> {
    this.#open(); const copy = strictJson(qualified); validQualified(copy.snapshot);
    this.#db.transaction(() => {
      const prior = this.get(qualified.operationId);
      if (!prior || prior.state !== 'started' ||
        !isDeepStrictEqual(prior.started, startedOf(copy.snapshot))) fail();
      const updated = this.#db.prepare(`UPDATE controlled_native_creations SET state='qualified',revision=3,
        qualified_json=? WHERE operation_id=? AND state='started' AND revision=2`)
        .run(copy.json, qualified.operationId);
      if (updated.changes !== 1) fail();
    }).immediate();
  }
}
