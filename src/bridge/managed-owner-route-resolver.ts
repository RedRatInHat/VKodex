import { lstat, readFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import DatabaseConstructor from 'better-sqlite3';
import type { TaskRef } from '../core/codex-tasks.js';
import type { TaskStateTransport } from '../core/task-state.js';
import type { BridgeStore, ManagedOwnerBinding, ManagedOwnerProcessIdentity } from './store.js';
import { ManagedWorkerStateTransport } from '../codex/managed-worker-state-transport.js';
import { ManagedWorkerControlClient, type ManagedWorkerScopedControlStatus } from
  '../desktop/managed-worker-control-client.js';
import { loadManagedWorkerPrivateState, type LoadManagedWorkerPrivateStateOptions } from
  '../desktop/managed-worker-private-state.js';
import { deriveManagedTaskStateToken } from '../desktop/managed-worker-task-state-token.js';
import { readWindowsProcessIdentity } from '../desktop/windows-process-identity.js';

type Row = Record<string, unknown>;
type PrivateStateDependencies = Omit<LoadManagedWorkerPrivateStateOptions, 'baseDirectory' | 'epoch'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Row, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const port = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
const birth = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,23}$/u.test(value);
const identity = (value: unknown, backend: boolean): value is Row =>
  object(value) && exact(value, backend ? ['pid', 'birthTicks', 'generation'] : ['pid', 'birthTicks']) &&
  Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && birth(value.birthTicks) &&
  (!backend || Number.isSafeInteger(value.generation) && (value.generation as number) > 0);

export interface ManagedOwnerRouteResolverOptions {
  readonly store: Pick<BridgeStore, 'managedOwner'>;
  readonly privateBaseDirectory: string;
  /** Test seam only; production uses DPAPI and the protected filesystem. */
  readonly privateStateOptions?: PrivateStateDependencies;
  /** Test seam only; production queries both same-machine PID birth identities. */
  readonly observeProcess?: typeof readWindowsProcessIdentity;
}

export type ManagedOwnerRouteResolution =
  | Readonly<{ kind: 'unclaimed' }>
  | Readonly<{ kind: 'unavailable'; claim: ManagedOwnerBinding }>
  | Readonly<{ kind: 'statically-qualified'; claim: ManagedOwnerBinding;
      controlStatus: () => Promise<ManagedWorkerScopedControlStatus>;
      states: TaskStateTransport }>;

interface RegistryReadyRow {
  epoch: string; revision: number; canonical_home: string; family_root: string; state: string;
  host_pid: number; host_birth: string; backend_pid: number; backend_birth: string;
  backend_generation: number; endpoint_ref: string;
}

function canonicalHome(home: string): string {
  if (!path.isAbsolute(home)) throw new Error('managed owner home is not absolute');
  const real = realpathSync.native(home);
  if (!statSync(real).isDirectory()) throw new Error('managed owner home unavailable');
  const normalized = process.platform === 'win32' ? path.win32.normalize(real).toLowerCase() : path.normalize(real);
  return normalized.length > 3 ? normalized.replace(/[\\/]$/u, '') : normalized;
}

/** Existing registry schema, opened without WAL/DDL/creation. No reservation,
 * takeover, or process launch is possible from this read path. */
async function registryReadyRow(registryPath: string, home: string, familyRoot: string): Promise<RegistryReadyRow | null> {
  await unlinkedAncestors(registryPath);
  const stat = await lstat(registryPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('managed registry unavailable');
  const db = new DatabaseConstructor(registryPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT epoch, revision, canonical_home, family_root, state,
      host_pid, host_birth, backend_pid, backend_birth, backend_generation, endpoint_ref
      FROM managed_worker_attempts WHERE canonical_home = ? AND family_root = ? AND state <> 'retired'`)
      .get(home, familyRoot) as unknown;
    if (!object(row) || !exact(row, ['epoch', 'revision', 'canonical_home', 'family_root', 'state',
      'host_pid', 'host_birth', 'backend_pid', 'backend_birth', 'backend_generation', 'endpoint_ref']) ||
      row.state !== 'ready' || !UUID.test(String(row.epoch)) ||
      !Number.isSafeInteger(row.revision) || (row.revision as number) < 0 ||
      row.canonical_home !== home || row.family_root !== familyRoot ||
      !identity({ pid: row.host_pid, birthTicks: row.host_birth }, false) ||
      !identity({ pid: row.backend_pid, birthTicks: row.backend_birth,
        generation: row.backend_generation }, true) || !UUID.test(String(row.endpoint_ref))) return null;
    return row as unknown as RegistryReadyRow;
  } finally { db.close(); }
}

async function unlinkedAncestors(file: string): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error('managed path is not absolute');
  const normalized = path.normalize(file);
  const parsed = path.parse(normalized);
  let current = parsed.root;
  for (const segment of path.dirname(normalized).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const item = await lstat(current);
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('managed path is linked');
  }
}

function sameIdentity(left: ManagedOwnerProcessIdentity | null, pid: number, birthTicks: string): boolean {
  return left !== null && left.pid === pid && left.birthTicks === birthTicks;
}

async function readEndpoint(file: string): Promise<Row> {
  await unlinkedAncestors(file);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 8192)
    throw new Error('managed endpoint unavailable');
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes.length ||
    before.dev !== after.dev || before.ino !== after.ino || bytes.length > 8192)
    throw new Error('managed endpoint changed');
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(parsed) || !exact(parsed, ['schemaVersion', 'epoch', 'endpointRef', 'host',
    'backend', 'control', 'taskState']) || parsed.schemaVersion !== 1 ||
    !UUID.test(String(parsed.epoch)) || !UUID.test(String(parsed.endpointRef)) ||
    !identity(parsed.host, false) || !identity(parsed.backend, true) ||
    !object(parsed.control) || !exact(parsed.control, ['host', 'port']) ||
    parsed.control.host !== '127.0.0.1' || !port(parsed.control.port) ||
    !object(parsed.taskState) || !exact(parsed.taskState, ['host', 'port']) ||
    parsed.taskState.host !== '127.0.0.1' || !port(parsed.taskState.port))
    throw new Error('managed endpoint schema invalid');
  return parsed;
}

/** A persisted claim is an exclusive routing fence, including while the worker
 * is unavailable. Resolution checks stored evidence and observed PID births but
 * does not authenticate control status or prove a live state stream. Its result
 * must not authorize submit; a later server-side ingress fence is required. */
export class ManagedOwnerRouteResolver {
  private readonly options: ManagedOwnerRouteResolverOptions;
  constructor(options: ManagedOwnerRouteResolverOptions) {
    if (!options?.store || typeof options.store.managedOwner !== 'function' ||
      !path.isAbsolute(options.privateBaseDirectory)) throw new TypeError('Invalid managed owner resolver options');
    this.options = { store: options.store, privateBaseDirectory: options.privateBaseDirectory,
      ...(options.privateStateOptions ? { privateStateOptions: options.privateStateOptions } : {}),
      observeProcess: options.observeProcess ?? readWindowsProcessIdentity };
  }

  owns(task: TaskRef): boolean { return this.options.store.managedOwner(task) !== null; }

  /** Synchronous persisted-claim fence for every future read frame. This is
   * not a server-side ingress fence and never authorizes a worker mutation. */
  isCurrent(claim: ManagedOwnerBinding): boolean {
    const current = this.options.store.managedOwner({ hostId: claim.hostId,
      threadId: claim.threadId, sourceId: claim.sourceId });
    return !!current && current.id === claim.id && current.revision === claim.revision &&
      current.state === claim.state && isDeepStrictEqual(current, claim);
  }

  async resolve(task: TaskRef): Promise<ManagedOwnerRouteResolution> {
    const scoped = { hostId: task.hostId, threadId: task.threadId, sourceId: task.sourceId ?? '' };
    const claim = this.options.store.managedOwner(scoped);
    if (!claim) return { kind: 'unclaimed' };
    const unavailable = (): ManagedOwnerRouteResolution => ({ kind: 'unavailable', claim });
    if (claim.state !== 'ready' || claim.hostId !== scoped.hostId ||
      claim.threadId !== scoped.threadId || claim.sourceId !== scoped.sourceId ||
      claim.hostId !== 'local') return unavailable();
    try {
      const evidence = claim.evidence;
      if (evidence.registryRevision === null || evidence.backendGeneration === null ||
        evidence.endpointRef === null || evidence.host === null || evidence.backend === null)
        return unavailable();
      const privateState = await loadManagedWorkerPrivateState({
        ...this.options.privateStateOptions, baseDirectory: this.options.privateBaseDirectory,
        epoch: claim.ownerEpoch,
      });
      const manifest = privateState.manifest;
      if (manifest.epoch !== claim.ownerEpoch || manifest.taskId !== scoped.threadId ||
        manifest.familyRoot !== claim.familyRoot ||
        privateState.privateDirectory !== path.join(this.options.privateBaseDirectory, claim.ownerEpoch))
        return unavailable();
      const home = canonicalHome(manifest.home);
      if (home !== claim.canonicalHome) return unavailable();
      const registry = await registryReadyRow(manifest.registryPath, home, claim.familyRoot);
      if (!registry || registry.epoch !== claim.ownerEpoch ||
        registry.revision !== evidence.registryRevision ||
        registry.backend_generation !== evidence.backendGeneration ||
        registry.endpoint_ref !== evidence.endpointRef ||
        !sameIdentity(evidence.host, registry.host_pid, registry.host_birth) ||
        !sameIdentity(evidence.backend, registry.backend_pid, registry.backend_birth)) return unavailable();
      const endpoint = await readEndpoint(path.join(privateState.privateDirectory, 'endpoint.v1.json'));
      if (endpoint.epoch !== claim.ownerEpoch || endpoint.endpointRef !== evidence.endpointRef ||
        !isDeepStrictEqual(endpoint.host, evidence.host) ||
        !isDeepStrictEqual(endpoint.backend, { pid: registry.backend_pid,
          birthTicks: registry.backend_birth, generation: registry.backend_generation })) return unavailable();
      const observe = this.options.observeProcess ?? readWindowsProcessIdentity;
      const liveHost = observe(evidence.host.pid), liveBackend = observe(evidence.backend.pid);
      if (!liveHost || !liveBackend ||
        !sameIdentity(evidence.host, liveHost.pid, liveHost.birthTicks) ||
        !sameIdentity(evidence.backend, liveBackend.pid, liveBackend.birthTicks)) return unavailable();
      if (!this.isCurrent(claim)) return unavailable();
      const freshRegistry = await registryReadyRow(manifest.registryPath, home, claim.familyRoot);
      if (!isDeepStrictEqual(freshRegistry, registry)) return unavailable();
      const controlEndpoint = endpoint.control as { host: '127.0.0.1'; port: number };
      const stateEndpoint = endpoint.taskState as { host: '127.0.0.1'; port: number };
      const control = new ManagedWorkerControlClient({ host: controlEndpoint.host,
        port: controlEndpoint.port,
        token: Buffer.from(privateState.keys.controlToken, 'base64').toString('base64url'),
        ownerEpoch: claim.ownerEpoch, taskId: scoped.threadId });
      const states = new ManagedWorkerStateTransport({ hostId: scoped.hostId,
        sourceId: scoped.sourceId, taskId: scoped.threadId,
        ownerEpoch: claim.ownerEpoch, backendGeneration: evidence.backendGeneration,
        port: stateEndpoint.port, token: deriveManagedTaskStateToken(privateState.keys.controlToken,
          claim.ownerEpoch, scoped.threadId, evidence.backendGeneration) });
      return Object.freeze({ kind: 'statically-qualified', claim,
        controlStatus: () => control.status(), states });
    } catch { return unavailable(); }
  }
}
