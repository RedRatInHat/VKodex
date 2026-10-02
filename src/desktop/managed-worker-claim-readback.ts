import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import DatabaseConstructor from 'better-sqlite3';
import type { WorkerAttempt } from '../codex/managed-worker-registry.js';
import { taskKey } from '../core/codex-tasks.js';

export interface ManagedWorkerClaimBinding {
  readonly storePath: string;
  readonly bindingId: string;
}

export interface ManagedWorkerClaimReference extends ManagedWorkerClaimBinding {
  readonly claimId: string;
}

export class ManagedWorkerClaimDispatchError extends Error {
  constructor(readonly outcome: 'not-dispatched' | 'unknown') {
    super('Managed worker bridge claim dispatch unavailable');
    this.name = 'ManagedWorkerClaimDispatchError';
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const unavailable: () => never = () => { throw new Error('Managed worker bridge claim unavailable'); };

/** Trusted launch metadata, never copied from a VK request or worker payload. */
export function assertManagedWorkerClaimBinding(value: unknown):
  asserts value is ManagedWorkerClaimBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 2 || typeof item.storePath !== 'string' ||
      !path.isAbsolute(item.storePath) || typeof item.bindingId !== 'string' ||
      !uuid.test(item.bindingId)) unavailable();
}

export function assertManagedWorkerClaimReference(value: unknown):
  asserts value is ManagedWorkerClaimReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || typeof item.claimId !== 'string' ||
      !uuid.test(item.claimId)) unavailable();
  assertManagedWorkerClaimBinding({ storePath: item.storePath, bindingId: item.bindingId });
}

/** A new read-only SQLite connection independently observes the committed
 * exact-task claim. Callback success or a returned object is not evidence. */
function claimIdIn(db: InstanceType<typeof DatabaseConstructor>,
  binding: ManagedWorkerClaimBinding, attempt: WorkerAttempt, taskId: string): string {
  if (attempt.state !== 'reserved' || attempt.revision !== 0 ||
      typeof taskId !== 'string' || !taskId) unavailable();
  const row = db.prepare(`SELECT m.id, m.binding_id, m.host_id, m.thread_id, m.source_id,
        m.owner_epoch, m.canonical_home, m.family_root, m.state, m.revision,
        m.backend_generation, m.registry_revision, m.endpoint_ref, m.host_pid,
        m.host_birth, m.backend_pid, m.backend_birth,
        b.host_id AS binding_host, b.thread_id AS binding_thread,
        b.source_id AS binding_source, b.attached AS binding_attached
      FROM managed_owner_bindings AS m JOIN bridge_bindings AS b ON b.id = m.binding_id
      WHERE m.binding_id = ? AND m.state <> 'retired'`).get(binding.bindingId) as
      Record<string, unknown> | undefined;
    if (!row) return unavailable();
    const claimId = typeof row.id === 'string' ? row.id : unavailable();
    if (!uuid.test(claimId) ||
        row.binding_id !== binding.bindingId || row.host_id !== 'local' ||
        row.thread_id !== taskId || row.source_id !== row.binding_source ||
        row.binding_host !== 'local' || row.binding_thread !== taskId ||
        row.binding_attached !== 1 || row.owner_epoch !== attempt.epoch ||
        row.canonical_home !== attempt.canonicalHome ||
        row.family_root !== attempt.familyRoot || row.state !== 'registering' ||
        row.revision !== 0 || row.backend_generation !== null ||
        row.registry_revision !== null || row.endpoint_ref !== null ||
        row.host_pid !== null || row.host_birth !== null ||
        row.backend_pid !== null || row.backend_birth !== null) unavailable();
  return claimId;
}

export function readManagedWorkerClaim(binding: ManagedWorkerClaimBinding,
  attempt: WorkerAttempt, taskId: string): string {
  assertManagedWorkerClaimBinding(binding);
  let db: InstanceType<typeof DatabaseConstructor> | null = null;
  try {
    db = new DatabaseConstructor(binding.storePath, { readonly: true, fileMustExist: true });
    return claimIdIn(db, binding, attempt, taskId);
  } catch { return unavailable(); }
  finally {
    try { db?.close(); }
    catch { unavailable(); }
  }
}

/** Child startup must independently reject a retired or replaced claim before
 * host registration. This is a snapshot, not a native writer lease. */
export function assertManagedWorkerClaimCurrent(reference: ManagedWorkerClaimReference,
  attempt: WorkerAttempt, taskId: string): void {
  assertManagedWorkerClaimReference(reference);
  if (readManagedWorkerClaim({ storePath: reference.storePath,
    bindingId: reference.bindingId }, attempt, taskId) !== reference.claimId) unavailable();
}

/** The short IMMEDIATE transaction prevents a concurrent bridge handoff from
 * committing between final claim readback and a synchronous spawn or host
 * registration call. It is not a native writer lease after the call returns. */
export function dispatchWithManagedWorkerClaim<T>(binding: ManagedWorkerClaimBinding,
  attempt: WorkerAttempt, taskId: string, expectedClaimId: string, dispatch: () => T): T {
  assertManagedWorkerClaimBinding(binding);
  let enteredDispatch = false;
  let db: InstanceType<typeof DatabaseConstructor> | null = null;
  try {
    db = new DatabaseConstructor(binding.storePath, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    return db.transaction(() => {
      if (claimIdIn(db!, binding, attempt, taskId) !== expectedClaimId) unavailable();
      enteredDispatch = true;
      return dispatch();
    }).immediate();
  } catch { throw new ManagedWorkerClaimDispatchError(enteredDispatch ? 'unknown' : 'not-dispatched'); }
  finally {
    try { db?.close(); }
    catch { throw new ManagedWorkerClaimDispatchError(enteredDispatch ? 'unknown' : 'not-dispatched'); }
  }
}

const boundedIdentity = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);

/** Ready worker write fence, separate from the reserved/revision-zero launch
 * fence. The IMMEDIATE transaction protects exact committed routing authority
 * only for this synchronous callback; no lease survives it or spans RPC/ACK.
 * An operation ID additionally fences its immutable original claim/stream
 * authority; a fresh claim never grants permission to rebind that operation. */
export function withReadyManagedWorkerClaimDispatch(reference: ManagedWorkerClaimReference,
  ready: WorkerAttempt, taskId: string, sourceId: string, expectedClaimRevision: number,
  write: () => void, operationId?: string): void {
  let enteredWrite = false;
  let db: InstanceType<typeof DatabaseConstructor> | null = null;
  try {
    assertManagedWorkerClaimReference(reference);
    if (!boundedIdentity(reference.storePath, 4096) || !ready || ready.state !== 'ready' ||
        !uuid.test(ready.epoch) || !Number.isSafeInteger(ready.revision) || ready.revision < 3 ||
        !boundedIdentity(ready.canonicalHome, 4096) || !path.isAbsolute(ready.canonicalHome) ||
        !boundedIdentity(ready.familyRoot, 256) || !boundedIdentity(taskId, 256) ||
        !boundedIdentity(sourceId, 256, true) || !Number.isSafeInteger(expectedClaimRevision) ||
        expectedClaimRevision < 1 || !ready.host || !ready.backend ||
        !Number.isSafeInteger(ready.host.pid) || ready.host.pid < 1 ||
        !Number.isSafeInteger(ready.backend.pid) || ready.backend.pid < 1 ||
        typeof ready.host.birthTicks !== 'string' || !/^[1-9]\d{0,23}$/u.test(ready.host.birthTicks) ||
        typeof ready.backend.birthTicks !== 'string' || !/^[1-9]\d{0,23}$/u.test(ready.backend.birthTicks) ||
        !Number.isSafeInteger(ready.backend.generation) || ready.backend.generation < 1 ||
        typeof ready.endpointRef !== 'string' || !uuid.test(ready.endpointRef) ||
        ready.lostReason !== null || ready.cleanupEvidence !== null || typeof write !== 'function' ||
        Object.prototype.toString.call(write) === '[object AsyncFunction]' ||
        operationId !== undefined && (typeof operationId !== 'string' || !uuid.test(operationId))) unavailable();
    // Snapshot all caller identities before the transaction and callback.
    const identity = { claimId: reference.claimId, bindingId: reference.bindingId,
      epoch: ready.epoch, canonicalHome: ready.canonicalHome, familyRoot: ready.familyRoot,
      revision: ready.revision, endpointRef: ready.endpointRef,
      hostPid: ready.host!.pid, hostBirth: ready.host!.birthTicks,
      backendPid: ready.backend!.pid, backendBirth: ready.backend!.birthTicks,
      backendGeneration: ready.backend!.generation };
    db = new DatabaseConstructor(reference.storePath, { fileMustExist: true });
    // Short contention refusal. Never block the owner event loop for the launch
    // fence's five-second timeout or permit an asynchronous authorization gap.
    db.pragma('busy_timeout = 50');
    const started = performance.now();
    db.transaction(() => {
      const row = db!.prepare(`SELECT m.*, b.host_id AS binding_host,
        b.thread_id AS binding_thread, b.source_id AS binding_source, b.attached AS binding_attached
        FROM managed_owner_bindings AS m JOIN bridge_bindings AS b ON b.id = m.binding_id
        WHERE m.id = ? AND m.binding_id = ?`).get(identity.claimId, identity.bindingId) as
          Record<string, unknown> | undefined;
      if (!row || row.id !== identity.claimId || row.binding_id !== identity.bindingId ||
          row.host_id !== 'local' || row.thread_id !== taskId || row.source_id !== sourceId ||
          row.binding_host !== 'local' || row.binding_thread !== taskId ||
          row.binding_source !== sourceId || row.binding_attached !== 1 ||
          row.state !== 'ready' || row.revision !== expectedClaimRevision ||
          row.owner_epoch !== identity.epoch || row.canonical_home !== identity.canonicalHome ||
          row.family_root !== identity.familyRoot || row.registry_revision !== identity.revision ||
          row.backend_generation !== identity.backendGeneration || row.endpoint_ref !== identity.endpointRef ||
          row.host_pid !== identity.hostPid || row.host_birth !== identity.hostBirth ||
          row.backend_pid !== identity.backendPid || row.backend_birth !== identity.backendBirth ||
          performance.now() - started >= 100) unavailable();
      if (operationId !== undefined) {
        const originalTaskKey = taskKey({ hostId: 'local', threadId: taskId, sourceId });
        const original = db!.prepare(`SELECT a.authority, o.task_key AS operation_task,
          o.state AS operation_state FROM bridge_managed_operation_authorities AS a
          JOIN bridge_operations AS o ON o.id = a.operation_id
          WHERE a.operation_id = ? AND a.task_key = ? AND a.binding_id = ?`)
          .get(operationId, originalTaskKey, identity.bindingId) as Record<string, unknown> | undefined;
        const generationRow = db!.prepare('SELECT value FROM bridge_values WHERE key = ?')
          .get(`stream-generation:${identity.bindingId}`) as { value: unknown } | undefined;
        if (!original || original.operation_task !== originalTaskKey ||
            !['sending', 'uncertain'].includes(original.operation_state as string) ||
            typeof original.authority !== 'string' || original.authority.length > 16384 ||
            generationRow && typeof generationRow.value !== 'string' ||
            !Number.isSafeInteger(row.created_at) || (row.created_at as number) < 0 ||
            !Number.isSafeInteger(row.updated_at) || (row.updated_at as number) < 0) unavailable();
        const generation: unknown = generationRow ? JSON.parse(generationRow.value as string) : 0;
        if (!Number.isSafeInteger(generation) || (generation as number) < 0) unavailable();
        const authority: unknown = JSON.parse(original!.authority as string);
        // Exact immutable snapshot, including the captured original stream. A
        // fresh ready claim cannot rebind an older operation's routing scope.
        const expected = { schemaVersion: 1, operationId, taskKey: originalTaskKey,
          bindingId: identity.bindingId, streamGeneration: generation,
          claim: { id: identity.claimId, bindingId: identity.bindingId, hostId: 'local',
            threadId: taskId, sourceId, ownerEpoch: identity.epoch,
            canonicalHome: identity.canonicalHome, familyRoot: identity.familyRoot,
            state: 'ready', revision: expectedClaimRevision,
            evidence: { backendGeneration: identity.backendGeneration,
              registryRevision: identity.revision, endpointRef: identity.endpointRef,
              host: { pid: identity.hostPid, birthTicks: identity.hostBirth },
              backend: { pid: identity.backendPid, birthTicks: identity.backendBirth } },
            createdAt: row.created_at, updatedAt: row.updated_at } };
        if (!isDeepStrictEqual(authority, expected) || performance.now() - started >= 100) unavailable();
      }
      enteredWrite = true;
      const returned: unknown = write();
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => {});
        unavailable();
      }
      if (performance.now() - started >= 100) unavailable();
    }).immediate();
    if (performance.now() - started >= 100) unavailable();
  } catch { throw new ManagedWorkerClaimDispatchError(enteredWrite ? 'unknown' : 'not-dispatched'); }
  finally {
    try { db?.close(); }
    catch { throw new ManagedWorkerClaimDispatchError(enteredWrite ? 'unknown' : 'not-dispatched'); }
  }
}
