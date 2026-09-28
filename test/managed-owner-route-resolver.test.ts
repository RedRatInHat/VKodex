import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeStore } from '../src/bridge/store.js';
import { ManagedWorkerRegistry, type ProcessIdentity } from '../src/codex/managed-worker-registry.js';
import { ManagedOwnerRouteResolver } from '../src/bridge/managed-owner-route-resolver.js';
import { createManagedWorkerPrivateState, type ManagedWorkerPrivateStateFilesystem,
  type ManagedWorkerPrivateStateProtector } from '../src/desktop/managed-worker-private-state.js';

class MemoryFilesystem implements ManagedWorkerPrivateStateFilesystem {
  readonly values = new Map<string, Uint8Array>();
  async ensureProtectedDirectory(): Promise<void> {}
  async writeExclusive(file: string, bytes: Uint8Array): Promise<void> { this.values.set(file, Uint8Array.from(bytes)); }
  async readProtectedFile(file: string): Promise<Uint8Array> {
    const value = this.values.get(file); if (!value) throw new Error('missing'); return Uint8Array.from(value);
  }
}
const protector: ManagedWorkerPrivateStateProtector = {
  async protect(bytes) { return Uint8Array.from(bytes); },
  async unprotect(bytes) { return Uint8Array.from(bytes); },
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vkodex-owner-route-'));
  const home = path.join(root, 'home'), privateBaseDirectory = path.join(root, 'private');
  await mkdir(home); await mkdir(privateBaseDirectory);
  const taskId = randomUUID(), familyRoot = taskId, sourceId = 'owned-source';
  const task = { hostId: 'local', threadId: taskId, sourceId };
  const registryPath = path.join(root, 'registry.sqlite');
  const registry = new ManagedWorkerRegistry(registryPath);
  const host = { pid: 10101, birthTicks: '100' };
  const backend = { pid: 20202, birthTicks: '200', generation: 1 };
  let attempt = registry.reserve(home, familyRoot);
  attempt = registry.registerHost(attempt, host);
  attempt = registry.registerBackend(attempt, host, backend);
  const endpointRef = randomUUID();
  attempt = registry.markReady(attempt, host, backend, endpointRef);
  registry.close();
  const filesystem = new MemoryFilesystem();
  const state = await createManagedWorkerPrivateState({
    schemaVersion: 1, epoch: attempt.epoch, taskId, familyRoot, home, cwd: home,
    cliPath: path.join(root, 'codex.exe'), cliSha256: 'a'.repeat(64),
    initializeRequest: {}, resumeParams: {}, registryPath,
  }, { baseDirectory: privateBaseDirectory, protector, filesystem });
  await mkdir(state.privateDirectory);
  const endpointFile = path.join(state.privateDirectory, 'endpoint.v1.json');
  const endpoint = { schemaVersion: 1, epoch: attempt.epoch, endpointRef, host, backend,
    control: { host: '127.0.0.1', port: 12345 }, taskState: { host: '127.0.0.1', port: 23456 } };
  await writeFile(endpointFile, JSON.stringify(endpoint));
  const store = new BridgeStore();
  const binding = store.ensureBinding({ ...task, title: 'Owned', workspace: home, updatedAt: 1 });
  const registering = store.claimManagedOwner(binding.id, { ownerEpoch: attempt.epoch,
    canonicalHome: attempt.canonicalHome, familyRoot, evidence: {
      backendGeneration: backend.generation, registryRevision: attempt.revision,
      endpointRef, host, backend: { pid: backend.pid, birthTicks: backend.birthTicks },
    } });
  const claim = store.transitionManagedOwner(registering, 'ready');
  const observed = new Map([[host.pid, host], [backend.pid, backend]]);
  const resolver = new ManagedOwnerRouteResolver({ store, privateBaseDirectory,
    privateStateOptions: { protector, filesystem },
    observeProcess: (pid: number): ProcessIdentity | null => observed.get(pid) ?? null });
  return { root, home, task, store, claim, resolver, registryPath, endpointFile, endpoint, observed };
}

test('exact persisted ready claim resolves private control and state transport without writing registry', async () => {
  const f = await fixture();
  try {
    assert.equal(f.resolver.owns(f.task), true);
    assert.equal(f.resolver.isCurrent(f.claim), true);
    const resolved = await f.resolver.resolve(f.task);
    assert.equal(resolved.kind, 'statically-qualified');
    if (resolved.kind !== 'statically-qualified') return;
    assert.equal(resolved.claim.id, f.claim.id);
    assert.equal(resolved.claim.evidence.endpointRef, f.endpoint.endpointRef);
    assert.equal(typeof resolved.controlStatus, 'function');
    assert.equal(Object.hasOwn(resolved, 'control'), false, 'static proof exposes no mutating control client');
    assert.equal(Object.hasOwn(resolved, 'revokeIngress'), false,
      'observation must not expose mutating handoff control');
    const handoff = await f.resolver.resolveHandoff(f.task);
    assert.equal(handoff.kind, 'statically-qualified');
    if (handoff.kind === 'statically-qualified') {
      assert.equal(handoff.claim.id, f.claim.id);
      assert.equal(typeof handoff.revokeIngress, 'function');
      assert.equal(typeof handoff.qualify, 'function');
      assert.equal(Object.hasOwn(handoff, 'states'), false);
    }
    assert.throws(() => resolved.states.subscribe({ ...f.task, threadId: randomUUID() }, () => {}, () => {}));
    resolved.states.close();
    assert.equal((await f.resolver.resolve({ ...f.task, sourceId: 'foreign' })).kind, 'unclaimed');
  } finally { f.store.close(); }
});

test('active unavailable claim still owns route and forbids a fallback', async () => {
  const f = await fixture();
  try {
    f.store.transitionManagedOwner(f.claim, 'unavailable');
    assert.equal(f.resolver.isCurrent(f.claim), false);
    assert.equal(f.resolver.owns(f.task), true);
    assert.equal((await f.resolver.resolve(f.task)).kind, 'unavailable');
  } finally { f.store.close(); }
});

test('registry revision and exact process birth mismatch refuse a ready endpoint', async () => {
  const f = await fixture();
  try {
    f.observed.set(f.endpoint.host.pid, { ...f.endpoint.host, birthTicks: '999' });
    assert.equal((await f.resolver.resolve(f.task)).kind, 'unavailable');
    f.observed.set(f.endpoint.host.pid, f.endpoint.host);
    const db = new ManagedWorkerRegistry(f.registryPath);
    try { db.markLost(db.get(f.home, f.task.threadId)!, f.endpoint.host, f.endpoint.backend,
      'backend_unavailable'); } finally { db.close(); }
    assert.equal((await f.resolver.resolve(f.task)).kind, 'unavailable');
  } finally { f.store.close(); }
});

test('missing state endpoint or swapped endpoint identity fail closed', async () => {
  const f = await fixture();
  try {
    const { taskState: _removed, ...noState } = f.endpoint;
    await writeFile(f.endpointFile, JSON.stringify(noState));
    assert.equal((await f.resolver.resolve(f.task)).kind, 'unavailable');
    await writeFile(f.endpointFile, JSON.stringify({ ...f.endpoint,
      backend: { ...f.endpoint.backend, birthTicks: '201' } }));
    assert.equal((await f.resolver.resolve(f.task)).kind, 'unavailable');
  } finally { f.store.close(); }
});
