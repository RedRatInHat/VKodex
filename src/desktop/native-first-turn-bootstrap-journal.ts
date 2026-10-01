import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import DatabaseConstructor, { type Database } from 'better-sqlite3';
import { comparablePath } from '../core/paths.js';
import { pinnedDetachedProfileBackendHome, pinnedDetachedProfileBackendIdentity,
  pinnedDetachedProfilePrivateDirectory,
  type PinnedDetachedProfileRpc } from '../codex/detached-profile-capability.js';
import { assertAuthenticatedProfileSourcePreflightForWrite,
  assertAuthenticatedProfileSourceReceiptForWrite,
  type AuthenticatedProfileSourcePreflight } from './controlled-native-source-proof.js';
import { readAndQualifyFreshFirstTurnIdleState } from './native-first-turn-idle-state.js';

type State = 'thread-reserved' | 'thread-accepted' | 'turn-reserved' | 'turn-unknown' | 'turn-accepted';
interface Row {
  operation_id: string; source_id: string; source_generation: string; owner_epoch: string;
  start_fingerprint: string;
  backend_identity: string; state: State; revision: number; thread_id: string | null;
  client_user_message_id: string | null; keyed_fingerprint: string | null; turn_id: string | null;
}
interface IngressRow {
  operation_id: string; thread_id: string; source_id: string; source_generation: string;
  owner_epoch: string; backend_identity: string; backend_generation: number;
  profile_identity: string; lease_id: string; status: 'held' | 'uncertain' | 'revoked';
}
/** Durable admission for VKodex's one isolated first-turn path. This only
 * excludes a second VKodex ingress through the same private journal. It is
 * NOT an exclusive lease over external Desktop, VS Code or CLI native writers. */
export interface NativeFirstTurnIngressLeaseScope {
  readonly operationId: string;
  readonly threadId: string;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly ownerEpoch: string;
  readonly backendIdentity: string;
  readonly backendGeneration: number;
  /** SHA-256 of the verified physical profile identity; never a raw path. */
  readonly profileIdentity: string;
  readonly leaseId: string;
}
interface IngressAuthority {
  readonly filePath: string;
  readonly rpc: PinnedDetachedProfileRpc;
  readonly preflight: AuthenticatedProfileSourcePreflight;
  readonly backendGeneration: number;
  readonly threadStartFingerprint: string;
}
// Object identity matters: copying the public scalar fields cannot mint a
// dispatch authority, even if the copied values match a durable SQLite row.
const ingressAuthorities = new WeakMap<NativeFirstTurnIngressLeaseScope, IngressAuthority>();
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
export type NativeFirstThreadStartFenceStatus = 'not-passed' | 'passed' | 'legacy-unknown';
export type NativeFirstTurnWriteFenceStatus = NativeFirstThreadStartFenceStatus;

// Codex thread IDs may be UUIDv7; creator/owner IDs are currently UUIDv4.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const identifier = (value: unknown, limit = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/u.test(value);
const fail = (): never => { throw new Error('First-turn bootstrap journal conflict or invalid record'); };
const ingressFail = (): never => { throw new Error('First-turn ingress lease conflict or invalid scope'); };
function validIngressScope(scope: NativeFirstTurnIngressLeaseScope): void {
  if (!scope || !UUID.test(scope.operationId) || !UUID.test(scope.threadId) ||
      !identifier(scope.sourceId) || !UUID.test(scope.sourceGeneration) ||
      !UUID.test(scope.ownerEpoch) || !FINGERPRINT.test(scope.backendIdentity) ||
      !Number.isSafeInteger(scope.backendGeneration) || scope.backendGeneration < 1 ||
      !FINGERPRINT.test(scope.profileIdentity) || !UUID.test(scope.leaseId)) ingressFail();
}
function physicalProfileIdentity(preflight: AuthenticatedProfileSourcePreflight): string {
  const pin = preflight.sourceHomeIdentity, work = preflight.workspaceIdentity;
  if (!work) return ingressFail();
  return createHash('sha256').update('vkodex-first-turn-physical-profile-v1\0')
    .update(JSON.stringify([preflight.sourceHome, pin.dev.toString(), pin.ino.toString(),
      pin.birthtimeMs.toString(), preflight.workspace, work.dev.toString(),
      work.ino.toString(), work.birthtimeMs.toString()])).digest('hex');
}
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
  readonly #filePath: string;
  readonly #directory: string;
  #closed = false;
  constructor(filePath: string) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail();
    this.#filePath = filePath;
    this.#directory = path.dirname(filePath);
    // The caller must establish the private directory/key before opening the
    // journal. Never create an unprotected bootstrap parent as a side effect.
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
      // Rows created before this table existed have unknown write history. A
      // missing marker must never be interpreted as proof of no socket write.
      this.#db.exec(`CREATE TABLE IF NOT EXISTS native_first_thread_start_fences (
        operation_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('not-passed','passed'))
      )`);
      // A missing marker on an older reserved turn says nothing about whether
      // its native command crossed the socket write boundary.
      this.#db.exec(`CREATE TABLE IF NOT EXISTS native_first_turn_write_fences (
        operation_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('not-passed','passed'))
      )`);
      this.#db.exec(`CREATE TABLE IF NOT EXISTS native_first_turn_ingress_leases (
        slot INTEGER PRIMARY KEY CHECK(slot=1), operation_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        source_id TEXT NOT NULL, source_generation TEXT NOT NULL, owner_epoch TEXT NOT NULL,
        backend_identity TEXT NOT NULL, backend_generation INTEGER NOT NULL CHECK(backend_generation>=1),
        profile_identity TEXT NOT NULL, lease_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('held','uncertain','revoked'))
      )`);
    } catch (error) { this.#db.close(); throw error; }
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
  filePath(): string { this.#open(); return this.#filePath; }
  /** The key and one-operation database share a caller-owned private directory. */
  directory(): string { this.#open(); return this.#directory; }
  synchronousMode(): number { this.#open(); return this.#db.pragma('synchronous', { simple: true }) as number; }
  #open(): void { if (this.#closed) fail(); }
  get(operationId: string): NativeFirstTurnBootstrapRecord | null {
    this.#open(); if (!UUID.test(operationId)) fail();
    const row = this.#db.prepare('SELECT * FROM native_first_turn_bootstraps WHERE operation_id=?').get(operationId) as Row | undefined;
    return row ? validRow(row) : null;
  }
  getThreadStartFenceStatus(operationId: string): NativeFirstThreadStartFenceStatus {
    this.#open(); if (!UUID.test(operationId) || !this.get(operationId)) fail();
    const row = this.#db.prepare('SELECT status FROM native_first_thread_start_fences WHERE operation_id=?')
      .get(operationId) as { status: string } | undefined;
    if (!row) return 'legacy-unknown';
    const status = row.status;
    if (status === 'not-passed' || status === 'passed') return status;
    return fail();
  }
  getFirstTurnWriteFenceStatus(operationId: string): NativeFirstTurnWriteFenceStatus {
    this.#open(); if (!UUID.test(operationId)) fail();
    const current = this.get(operationId);
    if (!current || current.revision < 3) fail();
    const row = this.#db.prepare('SELECT status FROM native_first_turn_write_fences WHERE operation_id=?')
      .get(operationId) as { status: string } | undefined;
    if (!row) return 'legacy-unknown';
    if (row.status === 'not-passed' || row.status === 'passed') return row.status;
    return fail();
  }
  #ingressRow(): IngressRow | undefined {
    return this.#db.prepare('SELECT * FROM native_first_turn_ingress_leases WHERE slot=1').get() as IngressRow | undefined;
  }
  #assertPinnedIngressJournal(rpc: PinnedDetachedProfileRpc, generation: number): void {
    const directory = pinnedDetachedProfilePrivateDirectory(rpc, generation);
    if (comparablePath(this.#filePath) !== comparablePath(path.join(directory, 'first-turn.sqlite')))
      ingressFail();
  }
  #assertIngressAuthority(scope: NativeFirstTurnIngressLeaseScope): void {
    validIngressScope(scope);
    const authority = ingressAuthorities.get(scope);
    if (!authority || authority.filePath !== this.#filePath) return ingressFail();
    try {
      this.#assertPinnedIngressJournal(authority.rpc, authority.backendGeneration);
      if (pinnedDetachedProfileBackendIdentity(authority.rpc, authority.backendGeneration) !== scope.backendIdentity ||
          pinnedDetachedProfileBackendHome(authority.rpc, authority.backendGeneration) !== authority.preflight.sourceHome ||
          authority.backendGeneration !== scope.backendGeneration) ingressFail();
      const source = { operationId: scope.operationId, sourceId: scope.sourceId,
        sourceGeneration: scope.sourceGeneration };
      assertAuthenticatedProfileSourcePreflightForWrite(authority.preflight, source,
        pinnedDetachedProfileBackendHome(authority.rpc, authority.backendGeneration),
        authority.preflight.workspace);
      assertAuthenticatedProfileSourceReceiptForWrite(path.join(this.#directory, 'source-preflight.json'),
        authority.preflight);
      if (physicalProfileIdentity(authority.preflight) !== scope.profileIdentity) ingressFail();
      const record = this.get(scope.operationId);
      if (!record || record.threadId !== scope.threadId || record.sourceId !== scope.sourceId ||
          record.sourceGeneration !== scope.sourceGeneration || record.ownerEpoch !== scope.ownerEpoch ||
          record.backendIdentity !== scope.backendIdentity ||
          record.threadStartFingerprint !== authority.threadStartFingerprint ||
          this.getThreadStartFenceStatus(scope.operationId) !== 'passed') ingressFail();
    } catch { ingressFail(); }
  }
  /** Mint admission only from fresh, read-only evidence on a production-pinned
   * connection and a physically authenticated source. This is not proof that
   * another native client cannot concurrently write to the same profile. */
  async qualifyFirstTurnIngressLeaseScope(operationId: string, rpc: PinnedDetachedProfileRpc,
    preflight: AuthenticatedProfileSourcePreflight): Promise<NativeFirstTurnIngressLeaseScope> {
    this.#open();
    const record = this.get(operationId);
    if (!record || record.state !== 'thread-accepted' || record.revision !== 2 || !record.threadId ||
        this.getThreadStartFenceStatus(operationId) !== 'passed') return ingressFail();
    const session = await rpc.initializedSession().catch(() => ingressFail());
    const generation = session.generation;
    try { this.#assertPinnedIngressJournal(rpc, generation); } catch { return ingressFail(); }
    const scope: NativeFirstTurnIngressLeaseScope = Object.freeze({ operationId, threadId: record.threadId,
      sourceId: record.sourceId, sourceGeneration: record.sourceGeneration, ownerEpoch: record.ownerEpoch,
      backendIdentity: record.backendIdentity, backendGeneration: generation,
      profileIdentity: physicalProfileIdentity(preflight), leaseId: randomUUID() });
    ingressAuthorities.set(scope, { filePath: this.#filePath, rpc, preflight, backendGeneration: generation,
      threadStartFingerprint: record.threadStartFingerprint });
    this.#assertIngressAuthority(scope);
    const current = (): void => {
      this.#assertIngressAuthority(scope);
      const now = this.get(operationId);
      if (now?.state !== 'thread-accepted' || now.revision !== 2) ingressFail();
    };
    try {
      const observed = await readAndQualifyFreshFirstTurnIdleState(rpc, record.threadId, current);
      current();
      if (observed.backendGeneration !== generation) ingressFail();
      return scope;
    } catch { ingressAuthorities.delete(scope); return ingressFail(); }
  }
  #assertIngress(scope: NativeFirstTurnIngressLeaseScope): NativeFirstTurnBootstrapRecord {
    this.#assertIngressAuthority(scope);
    const record = this.get(scope.operationId);
    const lease = this.#ingressRow();
    if (!record) return ingressFail();
    if (!lease || lease.status !== 'held' ||
        record.threadId !== scope.threadId || record.sourceId !== scope.sourceId ||
        record.sourceGeneration !== scope.sourceGeneration || record.ownerEpoch !== scope.ownerEpoch ||
        record.backendIdentity !== scope.backendIdentity ||
        lease.operation_id !== scope.operationId || lease.thread_id !== scope.threadId ||
        lease.source_id !== scope.sourceId || lease.source_generation !== scope.sourceGeneration ||
        lease.owner_epoch !== scope.ownerEpoch || lease.backend_identity !== scope.backendIdentity ||
        lease.backend_generation !== scope.backendGeneration ||
        lease.profile_identity !== scope.profileIdentity || lease.lease_id !== scope.leaseId ||
        this.getThreadStartFenceStatus(scope.operationId) !== 'passed' ||
        !(record.state === 'thread-accepted' && record.revision === 2 ||
          record.state === 'turn-reserved' && record.revision === 3 &&
            this.getFirstTurnWriteFenceStatus(scope.operationId) === 'not-passed')) ingressFail();
    return record;
  }
  /** One durable, no-reacquire VKodex ingress slot for the accepted empty
   * thread. Qualification checks source/backend/idle state. A caller that
   * plans a native write must ALSO establish a closed-world profile: this
   * slot cannot exclude external Desktop, VS Code or CLI writers. */
  acquireFirstTurnIngressLease(scope: NativeFirstTurnIngressLeaseScope): void {
    this.#open(); this.#assertIngressAuthority(scope);
    try { this.#db.transaction(() => {
      const record = this.get(scope.operationId);
      if (!record || record.state !== 'thread-accepted' || record.revision !== 2 ||
          record.threadId !== scope.threadId || record.sourceId !== scope.sourceId ||
          record.sourceGeneration !== scope.sourceGeneration || record.ownerEpoch !== scope.ownerEpoch ||
          record.backendIdentity !== scope.backendIdentity ||
          this.getThreadStartFenceStatus(scope.operationId) !== 'passed' || this.#ingressRow()) ingressFail();
      this.#db.prepare(`INSERT INTO native_first_turn_ingress_leases
        (slot,operation_id,thread_id,source_id,source_generation,owner_epoch,backend_identity,
          backend_generation,profile_identity,lease_id,status)
        VALUES (1,?,?,?,?,?,?,?,?,?,'held')`).run(scope.operationId, scope.threadId, scope.sourceId,
        scope.sourceGeneration, scope.ownerEpoch, scope.backendIdentity, scope.backendGeneration,
        scope.profileIdentity, scope.leaseId);
    }).immediate(); } catch { ingressFail(); }
  }
  assertFirstTurnIngressLeaseCurrent(scope: NativeFirstTurnIngressLeaseScope): void {
    this.#open(); this.#assertIngress(scope);
  }
  /** The write connector must be the identical pinned object that performed
   * fresh qualification, not another connection with matching scalar fields. */
  assertFirstTurnIngressRpc(scope: NativeFirstTurnIngressLeaseScope,
    rpc: PinnedDetachedProfileRpc): void {
    this.assertFirstTurnIngressLeaseCurrent(scope);
    if (ingressAuthorities.get(scope)?.rpc !== rpc) ingressFail();
  }
  /** A caller can withdraw a pre-write admission. Revocation is durable and
   * irreversible in this one-operation journal; it never proves non-write. */
  revokeFirstTurnIngressLease(scope: NativeFirstTurnIngressLeaseScope): void {
    this.#open();
    try { this.#db.transaction(() => {
      this.#assertIngress(scope);
      const changed = this.#db.prepare(`UPDATE native_first_turn_ingress_leases SET status='revoked'
        WHERE slot=1 AND lease_id=? AND status='held'`).run(scope.leaseId);
      if (changed.changes !== 1) ingressFail();
    }).immediate(); } catch { ingressFail(); }
  }
  /** The lease and write fence transition in one SQLite transaction. A
   * committed uncertain state means a native write MAY follow or have happened;
   * it does not authorize replay after timeout or process loss. */
  markFirstTurnWriteFencePassedWithIngressLease(scope: NativeFirstTurnIngressLeaseScope): void {
    this.#open();
    try { this.#db.transaction(() => {
      const record = this.#assertIngress(scope);
      if (record.state !== 'turn-reserved' || record.revision !== 3) ingressFail();
      const fence = this.#db.prepare(`UPDATE native_first_turn_write_fences SET status='passed'
        WHERE operation_id=? AND status='not-passed'`).run(scope.operationId);
      const lease = this.#db.prepare(`UPDATE native_first_turn_ingress_leases SET status='uncertain'
        WHERE slot=1 AND lease_id=? AND status='held'`).run(scope.leaseId);
      if (fence.changes !== 1 || lease.changes !== 1) ingressFail();
    }).immediate(); } catch { ingressFail(); }
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
      this.#db.prepare(`INSERT INTO native_first_thread_start_fences (operation_id,status)
        VALUES (?,'not-passed')`).run(intent.operationId);
    }).immediate(); } catch { fail(); }
  }
  /** Durable boundary immediately before the native socket write. A passed
   * marker means a write MAY have happened, never that a write or ACK did. */
  markThreadStartWriteFencePassed(operationId: string): void {
    this.#open(); if (!UUID.test(operationId)) fail();
    try { this.#db.transaction(() => {
      const current = this.get(operationId);
      if (!current || current.state !== 'thread-reserved' || current.revision !== 1) fail();
      const changed = this.#db.prepare(`UPDATE native_first_thread_start_fences SET status='passed'
        WHERE operation_id=? AND status='not-passed'`).run(operationId);
      if (changed.changes !== 1) fail();
    }).immediate(); } catch { fail(); }
  }
  persistThreadAccepted({ operationId, expectedRevision, threadId }: {
    readonly operationId: string; readonly expectedRevision: number; readonly threadId: string;
  }): void { this.#transition({ operationId, expectedRevision, state: 'thread-reserved', next: 'thread-accepted',
    nextRevision: 2, changes: ['thread_id=?'], values: [threadId], validate: () => { if (!UUID.test(threadId)) fail(); } }); }
  reserveFirstTurn({ operationId, expectedRevision, clientUserMessageId, keyedFingerprint }: {
    readonly operationId: string; readonly expectedRevision: number; readonly clientUserMessageId: string; readonly keyedFingerprint: string;
  }): void {
    this.#reserveFirstTurn(operationId, expectedRevision, clientUserMessageId, keyedFingerprint);
  }
  /** A held ingress slot changes r2 -> r3 only through its opaque, current
   * authority. The reservation and not-passed fence commit in one transaction. */
  reserveFirstTurnWithIngressLease(scope: NativeFirstTurnIngressLeaseScope, { clientUserMessageId, keyedFingerprint }: {
    readonly clientUserMessageId: string; readonly keyedFingerprint: string;
  }): void {
    this.#reserveFirstTurn(scope.operationId, 2, clientUserMessageId, keyedFingerprint, scope);
  }
  #reserveFirstTurn(operationId: string, expectedRevision: number,
    clientUserMessageId: string, keyedFingerprint: string,
    ingressScope?: NativeFirstTurnIngressLeaseScope): void {
    this.#open();
    if (!UUID.test(operationId) || expectedRevision !== 2 ||
        !identifier(clientUserMessageId) || !FINGERPRINT.test(keyedFingerprint)) fail();
    try { this.#db.transaction(() => {
      if (ingressScope) {
        if (ingressScope.operationId !== operationId) ingressFail();
        const record = this.#assertIngress(ingressScope);
        if (record.state !== 'thread-accepted' || record.revision !== 2) ingressFail();
      } else if (this.#ingressRow()) ingressFail();
      const changed = this.#db.prepare(`UPDATE native_first_turn_bootstraps
        SET state='turn-reserved', revision=3, client_user_message_id=?, keyed_fingerprint=?
        WHERE operation_id=? AND state='thread-accepted' AND revision=2`)
        .run(clientUserMessageId, keyedFingerprint, operationId);
      if (changed.changes !== 1) fail();
      this.#db.prepare(`INSERT INTO native_first_turn_write_fences (operation_id,status)
        VALUES (?,'not-passed')`).run(operationId);
    }).immediate(); } catch { fail(); }
  }
  /** Durable one-shot boundary immediately before native turn/start. A passed
   * marker is an uncertain write, never proof of server acceptance. */
  markFirstTurnWriteFencePassed(operationId: string): void {
    this.#open(); if (!UUID.test(operationId)) fail();
    try { this.#db.transaction(() => {
      // Once a scoped ingress slot exists, the legacy unscoped path cannot
      // bypass its identity check, even after the slot becomes uncertain.
      if (this.#ingressRow()) ingressFail();
      const current = this.get(operationId);
      if (!current || current.state !== 'turn-reserved' || current.revision !== 3) fail();
      const changed = this.#db.prepare(`UPDATE native_first_turn_write_fences SET status='passed'
        WHERE operation_id=? AND status='not-passed'`).run(operationId);
      if (changed.changes !== 1) fail();
    }).immediate(); } catch { fail(); }
  }
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
