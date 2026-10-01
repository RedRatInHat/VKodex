import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import type { WorkerAttempt } from '../codex/managed-worker-registry.js';

export interface ManagedWorkerClaimBinding {
  readonly storePath: string;
  readonly bindingId: string;
}

export class ManagedWorkerClaimDispatchError extends Error {
  constructor(readonly outcome: 'not-dispatched' | 'unknown') {
    super('Managed worker bridge claim dispatch unavailable');
    this.name = 'ManagedWorkerClaimDispatchError';
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const unavailable = (): never => { throw new Error('Managed worker bridge claim unavailable'); };

/** Trusted launch metadata, never copied from a VK request or worker payload. */
export function assertManagedWorkerClaimBinding(value: unknown):
  asserts value is ManagedWorkerClaimBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 2 || typeof item.storePath !== 'string' ||
      !path.isAbsolute(item.storePath) || typeof item.bindingId !== 'string' ||
      !uuid.test(item.bindingId)) unavailable();
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

/** The short IMMEDIATE transaction prevents a concurrent bridge handoff from
 * committing between final claim readback and the synchronous OS spawn call.
 * It is not a native writer lease; the child must independently fence startup. */
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
