import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedWorkerRegistry } from '../src/codex/managed-worker-registry.js';
import { launchManagedWorker, ManagedWorkerLaunchError } from '../src/desktop/managed-worker-launcher.js';
import { buildManagedWorkerEnvironment, buildDetachedWorkerSpawnOptions } from '../src/desktop/managed-worker-environment.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vkodex-launcher-'));
  const runtime = path.join(root, 'node.exe'), entry = path.join(root, 'worker.js'), cli = path.join(root, 'codex.exe');
  for (const file of [runtime, entry, cli]) writeFileSync(file, 'fixture-only');
  const sha256 = createHash('sha256').update('fixture-only').digest('hex');
  return { root, options: { home: root, familyRoot: 'own-task', taskId: 'own-task', cwd: root,
    cliPath: cli, cliSha256: sha256, initializeRequest: { clientInfo: {}, capabilities: {} },
    resumeParams: { threadId: 'own-task' }, registryPath: path.join(root, 'registry.sqlite'),
    privateBaseDirectory: path.join(root, 'private'), nativeIpc: 'local' as const,
    runtime: { executable: runtime, sha256, entrypoint: entry, entrypointSha256: sha256 } } };
}

const syntheticEnvironment = Object.freeze({
  Path: 'synthetic-path', HTTPS_PROXY: 'http://synthetic-proxy.invalid',
  CODEX_API_KEY: 'synthetic-codex-auth', cOdEx_HoMe: 'old-home',
  VK_TOKEN: 'synthetic-vk', vkOdEx_Secret: 'synthetic-vkodex',
  bOt_DaTa_DiR: 'synthetic-bot-data', nOdE_OpTiOnS: 'synthetic-node-hook',
  NODE_PATH: 'synthetic-node-path', eLeCtRoN_Run_As_Node: 'synthetic-electron-hook',
  VSCODE_INSPECTOR_OPTIONS: 'synthetic-inspector', NORMAL_VALUE: 'safe',
  NODE_EXTRA_CA_CERTS: 'synthetic-ca', NO_PROXY: 'synthetic-no-proxy',
});

test('worker environment strips bridge and runtime hooks without mutating caller input', () => {
  const before = { ...syntheticEnvironment };
  const result = buildManagedWorkerEnvironment(syntheticEnvironment, 'C:/qualified/home');
  assert.deepEqual(syntheticEnvironment, before);
  assert.deepEqual(result, { Path: 'synthetic-path', HTTPS_PROXY: 'http://synthetic-proxy.invalid',
    CODEX_API_KEY: 'synthetic-codex-auth', NORMAL_VALUE: 'safe', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    NO_PROXY: 'synthetic-no-proxy', CODEX_HOME: 'C:/qualified/home' });
});

test('detached spawn specification applies the same policy to synthetic environment', () => {
  const { options } = fixture();
  const spec = buildDetachedWorkerSpawnOptions(options.cwd, options.home, syntheticEnvironment);
  assert.deepEqual(spec.env, { Path: 'synthetic-path', HTTPS_PROXY: 'http://synthetic-proxy.invalid',
    CODEX_API_KEY: 'synthetic-codex-auth', NORMAL_VALUE: 'safe', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    NO_PROXY: 'synthetic-no-proxy', CODEX_HOME: options.home });
  assert.equal(spec.detached, true);
  assert.equal(spec.stdio, 'ignore');
});

test('launch reserves before protecting state and detaches without secret arguments or stdin', async () => {
  const { root, options } = fixture(); const order: string[] = [];
  let epoch = '';
  const result = await launchManagedWorker(options, {
    protectState: async manifest => {
      order.push('protect'); epoch = manifest.epoch;
      const db = new ManagedWorkerRegistry(options.registryPath);
      try { assert.equal(db.get(root, 'own-task')?.epoch, epoch); } finally { db.close(); }
    },
    spawn: (file, args, spawnOptions) => {
      order.push('spawn'); assert.equal(file, options.runtime.executable);
      assert.deepEqual(args, [options.runtime.entrypoint, '--private-base', options.privateBaseDirectory, '--epoch', epoch, '--native-ipc', 'local']);
      assert.equal(spawnOptions.detached, true); assert.equal(spawnOptions.windowsHide, true);
      assert.equal(spawnOptions.stdio, 'ignore'); assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.env?.CODEX_HOME, root);
      assert.equal(spawnOptions.env?.NODE_OPTIONS, undefined);
      const child = Object.assign(new EventEmitter(), { pid: 1234, unref: () => { order.push('unref'); } });
      queueMicrotask(() => child.emit('spawn')); return child;
    },
  });
  assert.deepEqual(order, ['protect', 'spawn', 'unref']);
  assert.deepEqual(result, { epoch, state: 'dispatched', pid: 1234 });
  await assert.rejects(launchManagedWorker(options, { protectState: async () => { throw new Error('should not run'); } }), /already reserved/);
});

test('opt-in launch snapshots explicit policy and rejects changed resume before reservation', async () => {
  const { options } = fixture();
  const taskId = '01a0e498-4fa0-74c0-a795-c5047a06d21c';
  const policy = approveTaskPolicy({ threadId: taskId, model: 'gpt-6-luna', modelProvider: 'openai',
    effort: 'high', cwd: options.cwd, runtimeWorkspaceRoots: [options.cwd], environments: [],
    approvalPolicy: 'never', approvalsReviewer: 'user',
    activePermissionProfile: { id: ':danger-full-access', extends: null },
    sandbox: { type: 'dangerFullAccess' }, serviceTier: null });
  const resumeParams = { threadId: taskId, cwd: options.cwd, model: policy.model,
    permissions: policy.activePermissionProfile.id, approvalPolicy: policy.approvalPolicy,
    runtimeWorkspaceRoots: [options.cwd], config: { model_reasoning_effort: policy.effort } };
  let protectedManifest: unknown;
  const input = { ...options, taskId, familyRoot: taskId, approvedTaskPolicy: policy, resumeParams };
  await assert.rejects(launchManagedWorker({ ...input,
    resumeParams: { ...resumeParams, model: 'unapproved' } }, {
    protectState: async () => { throw new Error('must not protect'); },
  }), /effective resume differs/i);
  const db = new ManagedWorkerRegistry(options.registryPath);
  try { assert.equal(db.get(options.home, taskId), null); } finally { db.close(); }
  await launchManagedWorker(input, { protectState: async manifest => { protectedManifest = manifest; },
    spawn: () => { const child = Object.assign(new EventEmitter(), { pid: 1234, unref: () => {} });
      queueMicrotask(() => child.emit('spawn')); return child; } });
  assert.deepEqual((protectedManifest as { approvedTaskPolicy: unknown }).approvedTaskPolicy, policy);
  assert.equal(Object.isFrozen((protectedManifest as { approvedTaskPolicy: unknown }).approvedTaskPolicy), true);
});

test('private-state failure keeps reservation and never starts a worker or leaks error content', async () => {
  const { root, options } = fixture(); let starts = 0;
  await assert.rejects(launchManagedWorker(options, {
    protectState: async () => { throw new Error('SECRET-CONTENT'); },
    spawn: () => { starts++; throw new Error('unexpected'); },
  }), (error: unknown) => {
    assert.ok(error instanceof ManagedWorkerLaunchError);
    assert.equal(error.phase, 'private-state'); assert.equal(error.outcome, 'not-dispatched');
    assert.equal(error.message.includes('SECRET'), false); return true;
  });
  assert.equal(starts, 0);
  const db = new ManagedWorkerRegistry(options.registryPath);
  try { assert.equal(db.get(root, 'own-task')?.state, 'reserved'); } finally { db.close(); }
});

test('spawn rejection is recorded as not-dispatched, never a ready worker and never retried', async () => {
  const { options } = fixture(); let starts = 0;
  await assert.rejects(launchManagedWorker(options, { protectState: async () => {}, spawn: () => {
    starts++; const child = Object.assign(new EventEmitter(), { unref: () => {} });
    queueMicrotask(() => child.emit('error', new Error('SECRET-CONTENT'))); return child;
  } }), (error: unknown) => {
    assert.ok(error instanceof ManagedWorkerLaunchError);
    assert.equal(error.phase, 'spawn'); assert.equal(error.outcome, 'not-dispatched'); return true;
  });
  assert.equal(starts, 1);
});

test('bad binary pins fail before reservation and private writes', async () => {
  const { root, options } = fixture(); let protects = 0;
  await assert.rejects(launchManagedWorker({ ...options, cliSha256: '0'.repeat(64) }, {
    protectState: async () => { protects++; },
  }), /pin mismatch/);
  assert.equal(protects, 0);
  const db = new ManagedWorkerRegistry(options.registryPath);
  try { assert.equal(db.get(root, 'own-task'), null); } finally { db.close(); }
});

test('missing or substituted native IPC route is rejected before reservation and private writes', async () => {
  const { options } = fixture(); let protects = 0;
  await assert.rejects(launchManagedWorker({ ...options, nativeIpc: undefined as unknown as 'local' }, {
    protectState: async () => { protects++; },
  }), /local native IPC/u);
  assert.equal(protects, 0);
  const db = new ManagedWorkerRegistry(options.registryPath);
  try { assert.equal(db.get(options.home, options.familyRoot), null); } finally { db.close(); }
});

test('a runtime file changed while private state is protected is re-pinned and never spawned', async () => {
  const { root, options } = fixture(); let starts = 0;
  await assert.rejects(launchManagedWorker(options, {
    protectState: async () => { writeFileSync(options.runtime.entrypoint, 'changed-after-initial-pin'); },
    spawn: () => { starts++; throw new Error('must not spawn'); },
  }), (error: unknown) => {
    assert.ok(error instanceof ManagedWorkerLaunchError);
    assert.equal(error.phase, 'spawn'); assert.equal(error.outcome, 'not-dispatched'); return true;
  });
  assert.equal(starts, 0);
  const db = new ManagedWorkerRegistry(options.registryPath);
  try { assert.equal(db.get(root, 'own-task')?.state, 'reserved'); } finally { db.close(); }
});

test('a spawned process without usable identity has unknown outcome, not a retryable launch failure', async () => {
  const { options } = fixture(); let detached = false;
  await assert.rejects(launchManagedWorker(options, { protectState: async () => {}, spawn: () => {
    const child = Object.assign(new EventEmitter(), { unref: () => { detached = true; } });
    queueMicrotask(() => child.emit('spawn')); return child;
  } }), (error: unknown) => {
    assert.ok(error instanceof ManagedWorkerLaunchError);
    assert.equal(error.outcome, 'unknown'); return true;
  });
  assert.equal(detached, true);
});
