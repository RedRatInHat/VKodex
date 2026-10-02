import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeStore } from '../src/bridge/store.js';
import { ManagedWorkerRegistry, type ProcessIdentity } from '../src/codex/managed-worker-registry.js';
import { ManagedOwnerRouteResolver } from '../src/bridge/managed-owner-route-resolver.js';
import { ManagedOwnerHandoffCoordinator } from '../src/bridge/managed-owner-handoff-coordinator.js';
import { ManagedWorkerControlServer } from '../src/desktop/managed-worker-control.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import type { ManagedWorkerClaimReference } from '../src/desktop/managed-worker-claim-readback.js';
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

async function fixture(options: { claimed?: boolean; trustedClaimPatch?: Partial<ManagedWorkerClaimReference> } = {}) {
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
  const storePath = path.join(root, 'bridge.sqlite');
  const store = options.claimed ? new BridgeStore(storePath) : new BridgeStore();
  const binding = store.ensureBinding({ ...task, title: 'Owned', workspace: home, updatedAt: 1 });
  const registering = store.claimManagedOwner(binding.id, { ownerEpoch: attempt.epoch,
    canonicalHome: attempt.canonicalHome, familyRoot, evidence: {
      backendGeneration: backend.generation, registryRevision: attempt.revision,
      endpointRef, host, backend: { pid: backend.pid, birthTicks: backend.birthTicks },
    } });
  const claim = store.transitionManagedOwner(registering, 'ready');
  const policy = options.claimed ? approveTaskPolicy({ threadId: taskId, model: 'gpt-6-luna',
    modelProvider: 'openai', effort: 'high', cwd: home, runtimeWorkspaceRoots: [home], environments: [],
    approvalPolicy: 'never', approvalsReviewer: 'user',
    activePermissionProfile: { id: ':danger-full-access', extends: null },
    sandbox: { type: 'dangerFullAccess' }, serviceTier: null }) : null;
  const filesystem = new MemoryFilesystem();
  const state = await createManagedWorkerPrivateState({
    schemaVersion: 1, epoch: attempt.epoch, taskId, familyRoot, home, cwd: home,
    cliPath: path.join(root, 'codex.exe'), cliSha256: 'a'.repeat(64),
    initializeRequest: {}, resumeParams: policy ? { threadId: taskId, cwd: home, model: policy.model,
      permissions: policy.activePermissionProfile.id, approvalPolicy: policy.approvalPolicy,
      runtimeWorkspaceRoots: [home], config: { model_reasoning_effort: policy.effort } } : {}, registryPath,
    ...(policy ? { approvedTaskPolicy: policy, managedOwnerClaim: { storePath, bindingId: binding.id,
      claimId: claim.id, ...options.trustedClaimPatch } } : {}),
  }, { baseDirectory: privateBaseDirectory, protector, filesystem });
  await mkdir(state.privateDirectory);
  const endpointFile = path.join(state.privateDirectory, 'endpoint.v1.json');
  const endpoint = { schemaVersion: 1, epoch: attempt.epoch, endpointRef, host, backend,
    control: { host: '127.0.0.1', port: 12345 }, taskState: { host: '127.0.0.1', port: 23456 } };
  await writeFile(endpointFile, JSON.stringify(endpoint));
  const observed = new Map([[host.pid, host], [backend.pid, backend]]);
  const resolver = new ManagedOwnerRouteResolver({ store, privateBaseDirectory,
    ...(options.claimed ? { bridgeStorePath: storePath } : {}),
    privateStateOptions: { protector, filesystem },
    observeProcess: (pid: number): ProcessIdentity | null => observed.get(pid) ?? null });
  return { root, home, task, store, storePath, claim, resolver, registryPath, endpointFile, endpoint,
    filesystem, privateBaseDirectory,
    observed, controlToken: Buffer.from(state.keys.controlToken, 'base64').toString('base64url') };
}

test('real resolver and authenticated control complete a fenced durable handoff', async () => {
  const f = await fixture();
  const calls: string[] = [];
  let revoked = false;
  const control = new ManagedWorkerControlServer({
    ownerEpoch: f.claim.ownerEpoch, taskId: f.task.threadId, token: f.controlToken,
    status: () => ({ hostState: 'running', backendGeneration: 1,
      nativeState: 'connected', nativeRevision: 1 }),
    requestStop: async () => { throw new Error('stop must not run'); },
    handoff: {
      revoke: expected => {
        assert.deepEqual(expected, { backendGeneration: f.claim.evidence.backendGeneration,
          registryRevision: f.claim.evidence.registryRevision });
        assert.equal(f.store.managedOwner(f.task)?.state, 'ready');
        revoked = true;
        calls.push('revoke');
        return expected;
      },
      qualify: async expected => {
        assert.equal(revoked, true);
        assert.equal(f.store.managedOwner(f.task)?.state, 'ready');
        calls.push('qualify');
        return { ...expected, ownerEpoch: f.claim.ownerEpoch, taskId: f.task.threadId,
          host: f.endpoint.host, backend: f.endpoint.backend,
          endpointRef: f.endpoint.endpointRef, nonce: randomUUID() };
      },
    },
  });
  const capability = await control.listen();
  try {
    await writeFile(f.endpointFile, JSON.stringify({ ...f.endpoint,
      control: { host: capability.host, port: capability.port } }));
    const handoff = await new ManagedOwnerHandoffCoordinator(f.store, f.resolver)
      .beginHandoff(f.task);
    assert.deepEqual(calls, ['revoke', 'qualify']);
    assert.equal(handoff.state, 'handoff_pending');
    assert.equal(handoff.revision, f.claim.revision + 1);
    assert.equal(f.resolver.owns(f.task), true);
    assert.equal((await f.resolver.resolve(f.task)).kind, 'unavailable');
  } finally { await control.close(); f.store.close(); }
});

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

test('production ingress and original outcome require exact trusted manifest claim and bridge path', async () => {
  for (const options of [{}, { claimed: true, trustedClaimPatch: { claimId: randomUUID() } },
    { claimed: true, trustedClaimPatch: { bindingId: randomUUID() } },
    { claimed: true, trustedClaimPatch: { storePath: path.join(os.tmpdir(), 'foreign-bridge.sqlite') } }]) {
    const f = await fixture(options);
    try {
      const operationId = randomUUID(); f.store.recordOperation(operationId, f.task);
      const original = f.store.captureManagedOperationAuthority(operationId, f.task, f.claim, 0);
      assert.equal((await f.resolver.resolveIngress(f.task)).kind, 'unavailable');
      assert.equal((await f.resolver.resolveOutcome(original)).kind, 'unavailable');
    } finally { f.store.close(); }
  }
  const f = await fixture({ claimed: true });
  try {
    const operationId = randomUUID(); f.store.recordOperation(operationId, f.task);
    const original = f.store.captureManagedOperationAuthority(operationId, f.task, f.claim, 0);
    assert.equal((await f.resolver.resolveIngress(f.task)).kind, 'statically-qualified');
    const wrongPath = new ManagedOwnerRouteResolver({ store: f.store, privateBaseDirectory: f.privateBaseDirectory,
      bridgeStorePath: path.join(f.root, 'other-bridge.sqlite'), privateStateOptions: { protector, filesystem: f.filesystem },
      observeProcess: pid => f.observed.get(pid) ?? null });
    assert.equal((await wrongPath.resolveIngress(f.task)).kind, 'unavailable');
    assert.equal((await wrongPath.resolveOutcome(original)).kind, 'unavailable');
    const noPath = new ManagedOwnerRouteResolver({ store: f.store, privateBaseDirectory: f.privateBaseDirectory,
      privateStateOptions: { protector, filesystem: f.filesystem }, observeProcess: pid => f.observed.get(pid) ?? null });
    assert.equal((await noPath.resolveIngress(f.task)).kind, 'unavailable');
    assert.equal((await noPath.resolveOutcome(original)).kind, 'unavailable');
    f.observed.set(f.endpoint.backend.pid, { pid: f.endpoint.backend.pid, birthTicks: '999' });
    assert.equal((await f.resolver.resolveIngress(f.task)).kind, 'unavailable');
    assert.equal((await f.resolver.resolveOutcome(original)).kind, 'unavailable');
  } finally { f.store.close(); }
});

test('production original outcome remains readonly after retirement and refuses backend birth drift', async () => {
  const f = await fixture({ claimed: true }), operationId = randomUUID();
  let reads = 0, writes = 0;
  const workerScope = { ownerEpoch: f.claim.ownerEpoch, taskId: f.task.threadId,
    backendGeneration: f.endpoint.backend.generation, registryRevision: f.claim.evidence.registryRevision!,
    endpointRef: f.endpoint.endpointRef };
  const control = new ManagedWorkerControlServer({ ownerEpoch: f.claim.ownerEpoch,
    taskId: f.task.threadId, token: f.controlToken,
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: 'connected', nativeRevision: 1 }),
    requestStop: async () => { throw new Error('must not stop'); },
    vkV2: { isScopeCurrent: scope => { assert.deepEqual(scope, workerScope); return true; },
      ingressStatus: () => ({ capability: 'stock-idle-queue-v2', admissionOpen: true }),
      submit: async () => { writes++; throw new Error('must not submit'); },
      statusByOperationId: (_scope, id) => { assert.equal(id, operationId); reads++;
        return { state: 'accepted', submissionId: 'original-accepted' }; } } });
  const capability = await control.listen();
  try {
    await writeFile(f.endpointFile, JSON.stringify({ ...f.endpoint,
      control: { host: capability.host, port: capability.port } }));
    f.store.recordOperation(operationId, f.task);
    const original = f.store.captureManagedOperationAuthority(operationId, f.task, f.claim, 0);
    f.store.retireManagedOwner(f.store.transitionManagedOwner(f.claim, 'handoff_pending'));
    assert.equal((await f.resolver.resolveIngress(f.task)).kind, 'unclaimed');
    const recovered = await f.resolver.resolveOutcome(original);
    assert.equal(recovered.kind, 'statically-qualified');
    if (recovered.kind !== 'statically-qualified') return;
    assert.deepEqual(Object.keys(recovered.client).sort(),
      ['scanTerminalQueuedInputV2', 'vkSubmissionStatusByOperationIdV2']);
    const status = await recovered.client.vkSubmissionStatusByOperationIdV2(recovered.scope, operationId);
    assert.equal(status?.state, 'accepted'); assert.equal(status?.submissionId, 'original-accepted');
    assert.equal(reads, 1); assert.equal(writes, 0);
    assert.deepEqual(f.store.managedOperationAuthority(f.task, operationId), original);
    f.observed.set(f.endpoint.backend.pid, { pid: f.endpoint.backend.pid, birthTicks: '999' });
    assert.equal((await f.resolver.resolveOutcome(original)).kind, 'unavailable');
    assert.equal(reads, 1); assert.equal(writes, 0);
  } finally { await control.close(); f.store.close(); }
});
