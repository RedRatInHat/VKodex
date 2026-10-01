import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppServerRpc } from '../src/codex/app-server-connection.js';
import { compileControlledNativeStartParams, createControlledNativeTask,
  ControlledNativeCreationUncertainError, projectControlledNativeStartPolicy,
  type ControlledCreationIntent, type ControlledCreationStarted,
  type ControlledCreationReceipt, type ControlledNativeTaskCreatorOptions } from '../src/desktop/controlled-native-task-creator.js';
import { ControlledNativeCreationJournal } from '../src/desktop/controlled-native-creation-journal.js';
import { NativeFirstTurnBootstrapJournal } from '../src/desktop/native-first-turn-bootstrap-journal.js';
import { prepareNativeFirstThreadStart, prepareNativeFirstThreadStartWithKey } from
  '../src/desktop/native-first-turn-thread-start.js';
import { dispatchPreparedNativeFirstThreadStartCanary } from
  '../src/desktop/native-first-thread-start-canary.js';
import { dispatchPreparedNativeFirstThreadStartForOfflineTest } from
  './support/native-first-thread-start-harness.js';
import type { PinnedDetachedProfileRpc } from '../src/codex/detached-profile-capability.js';
import { reconcileControlledNativeCreation } from '../src/desktop/controlled-native-creation-reconciler.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import { createPinnedDetachedProfileConnection, detachedProfileKey } from
  '../src/codex/detached-profile-capability.js';
import { captureAuthenticatedProfileSourcePreflight } from
  '../src/desktop/controlled-native-source-proof.js';
import { ensureProtectedLocalDirectory } from '../src/desktop/managed-worker-private-state.js';
import { createNativeFirstTurnPrivateKey } from '../src/desktop/native-first-turn-private-key.js';
import { readWindowsProcessIdentity } from '../src/desktop/windows-process-identity.js';

const cwd = 'C:\\fixture\\workspace';
const rolloutPath = 'C:\\fixture\\home\\sessions\\new.jsonl';
const template = { model: 'gpt-5.6-sol', modelProvider: 'openai', effort: 'medium', cwd,
  runtimeWorkspaceRoots: [cwd], allowedEnvironments: [[]], approvalPolicy: 'never',
  approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', extends: null },
  sandbox: { type: 'dangerFullAccess' }, allowedServiceTiers: [null, 'default'] } as const;
const taskId = randomUUID();
const startResult = { thread: { id: taskId, status: { type: 'idle' }, turns: [],
  model: template.model, modelProvider: template.modelProvider, reasoningEffort: template.effort,
  cwd, environments: [] }, model: template.model, modelProvider: template.modelProvider,
  reasoningEffort: template.effort, cwd, runtimeWorkspaceRoots: [cwd],
  approvalPolicy: template.approvalPolicy, approvalsReviewer: template.approvalsReviewer,
  activePermissionProfile: template.activePermissionProfile, sandbox: template.sandbox,
  serviceTier: 'default' };

const firstTurnReadOnlyPolicy = { ...template,
  activePermissionProfile: { id: ':read-only', extends: null },
  sandbox: { type: 'readOnly', networkAccess: false } } as const;
const firstTurnReadOnlyResult = { ...startResult,
  activePermissionProfile: firstTurnReadOnlyPolicy.activePermissionProfile,
  sandbox: firstTurnReadOnlyPolicy.sandbox };
function firstTurnStartFixture() {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-thread-')), 'journal.sqlite');
  const journal = new NativeFirstTurnBootstrapJournal(filePath);
  const identity = { operationId: randomUUID(), sourceId: 'profile-a',
    sourceGeneration: randomUUID(), ownerEpoch: randomUUID(), backendIdentity: 'b'.repeat(64) };
  const key = Buffer.alloc(32, 7);
  const prepared = prepareNativeFirstThreadStartWithKey(journal, identity,
    firstTurnReadOnlyPolicy, key);
  key.fill(0);
  return { filePath, journal, identity, prepared };
}

test('one-shot first thread/start persists keyed intent before a policy-qualified ACK', async () => {
  const { journal, prepared } = firstTurnStartFixture();
  let writes = 0;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(method: string, params: Record<string, unknown>, options: {
      mutating?: boolean; expectedGeneration?: number; assertBeforeWrite?: () => void;
      onResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }) {
      assert.equal(journal.get(prepared.identity.operationId)?.state, 'thread-reserved');
      assert.equal(method, 'thread/start'); assert.equal(options.mutating, true);
      assert.equal(options.expectedGeneration, 5);
      assert.deepEqual(params, compileControlledNativeStartParams(firstTurnReadOnlyPolicy));
      assert.equal(journal.getThreadStartFenceStatus(prepared.identity.operationId), 'not-passed');
      options.assertBeforeWrite?.();
      assert.equal(journal.getThreadStartFenceStatus(prepared.identity.operationId), 'passed');
      writes++;
      options.onResponseEnvelope?.({ result: firstTurnReadOnlyResult });
      return firstTurnReadOnlyResult;
    } };
  try {
    const result = await dispatchPreparedNativeFirstThreadStartForOfflineTest(journal, prepared, rpc,
      expected => expected);
    assert.equal(result.state, 'thread-accepted'); assert.equal(result.threadId, taskId);
    assert.equal(writes, 1);
    assert.equal(journal.getThreadStartFenceStatus(prepared.identity.operationId), 'passed');
    await assert.rejects(dispatchPreparedNativeFirstThreadStartForOfflineTest(journal, prepared, rpc,
      expected => expected), /unqualified/u);
    assert.equal(writes, 1);
    assert.throws(() => prepareNativeFirstThreadStartWithKey(journal, { ...prepared.identity,
      operationId: randomUUID() }, firstTurnReadOnlyPolicy, Buffer.alloc(32, 7)), /conflict/u);
  } finally { journal.close(); }
});

test('production first thread preparation refuses an unpinned RPC before reserving an intent', async () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-thread-')),
    'journal.sqlite');
  const journal = new NativeFirstTurnBootstrapJournal(filePath);
  const scope = { operationId: randomUUID(), sourceId: 'profile-a',
    sourceGeneration: randomUUID(), ownerEpoch: randomUUID() };
  const fake = { async initializedSession() { return { generation: 1 }; },
    isSessionCurrent: () => true } as unknown as PinnedDetachedProfileRpc;
  try {
    await assert.rejects(prepareNativeFirstThreadStart(journal, scope,
      firstTurnReadOnlyPolicy, fake, {} as never), /unavailable/iu);
    assert.equal(journal.get(scope.operationId), null);
  } finally { journal.close(); }
});

test('Windows production-pinned authenticated source permits one fenced first thread/start', {
  skip: process.platform !== 'win32', timeout: 90_000,
}, async () => {
  const localAppData = process.env.LOCALAPPDATA;
  assert.ok(localAppData && path.win32.isAbsolute(localAppData));
  const root = path.join(localAppData, `VKodex-first-start-integration-${randomUUID()}`);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024,
    verifyClient: (info: { req: import('node:http').IncomingMessage }) =>
      info.req.headers.authorization === `Bearer ${serverToken}` });
  const serverListening = new Promise<void>(resolve => server.once('listening', resolve));
  const serverToken = `integration-${randomUUID().replaceAll('-', '')}`;
  let serverError: unknown;
  let startRequests = 0;
  const methods: string[] = [];
  const sockets = new Set<WebSocket>();
  let journal: NativeFirstTurnBootstrapJournal | undefined;
  let client: ReturnType<typeof createPinnedDetachedProfileConnection> | undefined;
  let listening = false;
  try {
    // Let the ACL helper create protected leaves; precreating them with mkdir
    // would leave an inherited ACL that its existing-directory check refuses.
    await ensureProtectedLocalDirectory(root);
    const serverRoot = path.join(root, 'server');
    const profileRoot = path.join(serverRoot, 'profiles');
    const home = path.join(root, 'source-home');
    const workspace = path.join(root, 'workspace');
    await ensureProtectedLocalDirectory(serverRoot);
    await ensureProtectedLocalDirectory(profileRoot);
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await mkdir(path.join(home, 'sessions'), { recursive: true });
    const canonicalHome = await realpath(home);
    const privateDirectory = path.join(profileRoot, detachedProfileKey(canonicalHome));
    await ensureProtectedLocalDirectory(privateDirectory);

    const epoch = randomUUID();
    const epochDirectory = path.join(privateDirectory, epoch);
    await ensureProtectedLocalDirectory(epochDirectory);
    await writeFile(path.join(epochDirectory, 'token'), serverToken, { flag: 'wx' });
    await serverListening;
    listening = true;
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const processIdentity = readWindowsProcessIdentity(process.pid, 2_000);
    assert.ok(processIdentity && processIdentity.pid === process.pid);
    const descriptor = { schemaVersion: 1 as const, epoch,
      profileKey: detachedProfileKey(canonicalHome), home: canonicalHome,
      url: `ws://127.0.0.1:${address.port}`,
      backend: { pid: processIdentity.pid, birthTicks: processIdentity.birthTicks } };
    await writeFile(path.join(privateDirectory, 'ready.json'), JSON.stringify(descriptor), { flag: 'wx' });

    const key = await createNativeFirstTurnPrivateKey(privateDirectory);
    key.fill(0);
    const journalPath = path.join(privateDirectory, 'first-turn.sqlite');
    journal = new NativeFirstTurnBootstrapJournal(journalPath);
    const sourceId = 'windows-production-pinned-integration';
    const scope = { operationId: randomUUID(), sourceId,
      sourceGeneration: randomUUID(), ownerEpoch: randomUUID() };
    const policy = { ...firstTurnReadOnlyPolicy, cwd: workspace,
      runtimeWorkspaceRoots: [workspace] } as const;
    const preflight = await captureAuthenticatedProfileSourcePreflight({
      operationId: scope.operationId, sourceId: scope.sourceId,
      sourceGeneration: scope.sourceGeneration,
    }, canonicalHome, workspace);
    client = createPinnedDetachedProfileConnection(privateDirectory, canonicalHome, descriptor);
    const response = { ...firstTurnReadOnlyResult, cwd: workspace,
      runtimeWorkspaceRoots: [workspace], thread: { ...firstTurnReadOnlyResult.thread,
        cwd: workspace } };

    server.on('connection', (socket, request) => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${serverToken}`);
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('message', frame => {
          void (async () => {
            const message = JSON.parse(frame.toString()) as Record<string, unknown>;
            if (typeof message.method === 'string') methods.push(message.method);
            if (message.id === undefined) return;
            if (message.method === 'initialize') {
              socket.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: 'loopback-test' } } }));
              return;
            }
            if (message.method !== 'thread/start') throw new Error(`Unexpected request method: ${String(message.method)}`);
            startRequests++;
            assert.deepEqual(message.params, compileControlledNativeStartParams(policy));
            const reopened = new NativeFirstTurnBootstrapJournal(journalPath);
            try {
              assert.equal(reopened.getThreadStartFenceStatus(scope.operationId), 'passed');
              assert.equal(reopened.get(scope.operationId)?.state, 'thread-reserved');
            } finally { reopened.close(); }
            socket.send(JSON.stringify({ id: message.id, result: response }));
          })().catch(error => { serverError = error; socket.close(1011); });
        });
      } catch (error) { serverError = error; socket.close(1011); }
    });

    const prepared = await prepareNativeFirstThreadStart(journal, scope, policy, client, preflight);
    const outcome = await dispatchPreparedNativeFirstThreadStartCanary(journal, prepared);
    assert.equal(serverError, undefined);
    assert.equal(outcome.kind, 'accepted');
    assert.equal(outcome.diagnostic, 'accepted');
    assert.equal(outcome.writeFence, 'passed');
    assert.equal(outcome.record.state, 'thread-accepted');
    assert.equal(outcome.record.threadId, taskId);
    assert.equal(startRequests, 1);
    assert.equal(methods.filter(method => method === 'thread/start').length, 1);
    assert.deepEqual(methods.filter(method => method !== 'initialized'), ['initialize', 'thread/start']);
  } finally {
    await client?.close();
    journal?.close();
    for (const socket of sockets) socket.terminate();
    if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
    else server.close();
    let fixtureExists = true;
    try { await lstat(root); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') fixtureExists = false;
      else throw error;
    }
    if (fixtureExists) {
      try {
        const entry = await lstat(root);
        const resolvedRoot = await realpath(root);
        const [resolvedParent, localParent] = await Promise.all([
          stat(path.dirname(resolvedRoot), { bigint: true }),
          stat(localAppData, { bigint: true }),
        ]);
        const comparable = (value: string) => path.win32.normalize(value).toLowerCase();
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
        assert.equal(comparable(path.dirname(root)), comparable(localAppData));
        assert.equal(resolvedParent.dev, localParent.dev);
        assert.equal(resolvedParent.ino, localParent.ino);
        assert.equal(resolvedParent.birthtimeMs, localParent.birthtimeMs);
        assert.match(path.basename(resolvedRoot),
          /^VKodex-first-start-integration-[0-9a-f]{8}-[0-9a-f-]{27}$/u);
        const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:VKODEX_TEST_RECYCLE_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)";
        await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60_000,
          env: { ...process.env, VKODEX_TEST_RECYCLE_TARGET: resolvedRoot }, maxBuffer: 64 * 1024 });
        await assert.rejects(lstat(root), { code: 'ENOENT' });
      } catch (error) {
        throw new Error(`Windows integration fixture could not be moved to Recycle Bin; preserved at ${root}`, { cause: error });
      }
    }
  }
});

test('production first-thread canary refuses an offline-key preparation without a native write', async () => {
  const { journal, prepared } = firstTurnStartFixture();
  try {
    await assert.rejects(dispatchPreparedNativeFirstThreadStartCanary(journal, prepared),
      /canary unqualified/u);
    assert.equal(journal.get(prepared.identity.operationId)?.state, 'thread-reserved');
  } finally { journal.close(); }
});

test('production first-turn preparation modules expose no raw-RPC native mutation helper', async () => {
  const [threadStart, firstTurn] = await Promise.all([
    import('../src/desktop/native-first-turn-thread-start.js'),
    import('../src/desktop/native-first-turn-bootstrap-preparation.js'),
  ]);
  assert.equal(Object.keys(threadStart).some(name => name.startsWith('dispatch')), false);
  assert.equal(Object.keys(firstTurn).some(name => name.startsWith('dispatch')), false);
});

test('first thread/start timeout cannot replay but a late matching ACK can persist', async () => {
  const { filePath, journal, prepared } = firstTurnStartFixture();
  let writes = 0;
  let late: ((value: { result: Record<string, unknown> }) => void) | undefined;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(_method: string, _params: Record<string, unknown>, options: {
      assertBeforeWrite?: () => void;
      onLateResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }): Promise<unknown> {
      options.assertBeforeWrite?.(); writes++; late = options.onLateResponseEnvelope;
      throw new Error('timeout');
    } };
  try {
    const result = await dispatchPreparedNativeFirstThreadStartForOfflineTest(journal, prepared, rpc,
      expected => expected);
    assert.equal(result.state, 'thread-reserved'); assert.equal(writes, 1);
    assert.equal(journal.getThreadStartFenceStatus(prepared.identity.operationId), 'passed');
  } finally { journal.close(); }
  late?.({ result: firstTurnReadOnlyResult });
  const reopened = new NativeFirstTurnBootstrapJournal(filePath);
  try { assert.equal(reopened.get(prepared.identity.operationId)?.state, 'thread-accepted');
    assert.equal(reopened.get(prepared.identity.operationId)?.threadId, taskId); }
  finally { reopened.close(); }
});

test('first thread/start refuses full access and a response before its final write fence', async () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-thread-')), 'journal.sqlite');
  const journal = new NativeFirstTurnBootstrapJournal(filePath);
  const identity = { operationId: randomUUID(), sourceId: 'profile-a',
    sourceGeneration: randomUUID(), ownerEpoch: randomUUID(), backendIdentity: 'b'.repeat(64) };
  try {
    assert.throws(() => prepareNativeFirstThreadStartWithKey(journal, identity,
      template, Buffer.alloc(32, 7)), /unqualified/u);
    assert.equal(journal.get(identity.operationId), null);
  } finally { journal.close(); }
  const fixture = firstTurnStartFixture();
  let authority = true, writes = 0;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(_method: string, _params: Record<string, unknown>, options: {
      assertBeforeWrite?: () => void;
      onResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }) {
      options.onResponseEnvelope?.({ result: firstTurnReadOnlyResult });
      authority = false; options.assertBeforeWrite?.(); writes++;
      return firstTurnReadOnlyResult;
    } };
  try {
    const result = await dispatchPreparedNativeFirstThreadStartForOfflineTest(fixture.journal,
      fixture.prepared, rpc, expected => authority ? expected : null);
    assert.equal(result.state, 'thread-reserved'); assert.equal(writes, 0);
    assert.equal(fixture.journal.getThreadStartFenceStatus(fixture.prepared.identity.operationId),
      'not-passed');
  } finally { fixture.journal.close(); }
});

test('first thread/start refuses a replacement backend identity before wire write', async () => {
  const { journal, prepared } = firstTurnStartFixture();
  let writes = 0;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request() { writes++; return firstTurnReadOnlyResult; } };
  try {
    const result = await dispatchPreparedNativeFirstThreadStartForOfflineTest(journal, prepared, rpc,
      expected => ({ ...expected, backendIdentity: 'a'.repeat(64) }));
    assert.equal(result.state, 'thread-reserved'); assert.equal(writes, 0);
  } finally { journal.close(); }
});

test('first thread/start HMAC binds exact policy and source without persisting model or key', () => {
  const identity = { operationId: randomUUID(), sourceId: 'profile-a',
    sourceGeneration: randomUUID(), ownerEpoch: randomUUID(), backendIdentity: 'b'.repeat(64) };
  const key = Buffer.alloc(32, 7);
  const prepare = (sourceGeneration: string, model: string) => {
    const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-thread-')),
      'journal.sqlite');
    const journal = new NativeFirstTurnBootstrapJournal(filePath);
    try {
      const prepared = prepareNativeFirstThreadStartWithKey(journal,
        { ...identity, sourceGeneration }, { ...firstTurnReadOnlyPolicy, model }, key);
      assert.equal(journal.get(identity.operationId)?.state, 'thread-reserved');
      assert.equal(JSON.stringify(journal.get(identity.operationId)).includes(model), false);
      return prepared.identity.threadStartFingerprint;
    } finally { journal.close(); }
  };
  try {
    const base = prepare(identity.sourceGeneration, 'gpt-5.6-sol');
    assert.match(base, /^[a-f0-9]{64}$/u);
    assert.notEqual(prepare(identity.sourceGeneration, 'gpt-6-sol'), base);
    assert.notEqual(prepare(randomUUID(), 'gpt-5.6-sol'), base);
  } finally { key.fill(0); }
});

test('native start selection projects policy before the first model turn without claiming source or ownership', () => {
  const selected = projectControlledNativeStartPolicy(startResult, template);
  assert.equal(selected.threadId, taskId);
  assert.equal(selected.effectivePolicy.serviceTier, 'default');
  assert.deepEqual(selected.effectivePolicy.environments, []);
  for (const response of [
    { ...startResult, serviceTier: 'unapproved' },
    { ...startResult, thread: { ...startResult.thread, turns: [{ id: 'other' }] } },
    { ...startResult, thread: { ...startResult.thread, status: { type: 'active' } } },
    { ...startResult, activePermissionProfile: { ...startResult.activePermissionProfile, extra: true } },
  ]) assert.throws(() => projectControlledNativeStartPolicy(response, template), /unqualified/u);
});

test('controlled thread/start params compile from the validated policy template', () => {
  assert.deepEqual(compileControlledNativeStartParams(template), {
    cwd, model: template.model, config: { model_reasoning_effort: template.effort },
    permissions: template.activePermissionProfile.id,
    approvalPolicy: template.approvalPolicy, runtimeWorkspaceRoots: [cwd], ephemeral: false,
  });
  assert.throws(() => compileControlledNativeStartParams({ ...template,
    allowedServiceTiers: [] as const }), /unqualified/u);
});

function fixture(failure: 'none' | 'unknown' | 'invalid-start-response' | 'started-persist' |
  'qualified-persist' | 'source-mismatch' |
  'read-fail' | 'read-once' | 'read-once-lost-reservation' | 'second-read-fail' |
  'unloaded' | 'idle-to-unloaded' | 'provider-mismatch' |
  'cwd-mismatch' | 'policy-mismatch' | 'start-active' | 'start-turn' |
  'profile-extra' | 'sandbox-extra' | 'environment-extra' = 'none') {
  const calls: string[] = [], persisted: string[] = [];
  let reserved = false, readCount = 0;
  const rpc = {
    async initializedSession() { return { generation: 1, initializeResult: {} }; },
    isSessionCurrent(generation: number) { return generation === 1; },
    async request(method: string, params: Record<string, unknown>, options?: {
      mutating?: boolean; expectedGeneration?: number; assertBeforeWrite?: () => void;
    }) {
      calls.push(method);
      if (method === 'thread/start') {
        assert.equal(reserved, true);
        assert.equal(options?.mutating, true);
        assert.equal(options.expectedGeneration, 1);
        options.assertBeforeWrite?.();
        assert.deepEqual(params, { cwd, model: template.model,
          config: { model_reasoning_effort: template.effort },
          permissions: template.activePermissionProfile.id,
          approvalPolicy: template.approvalPolicy, runtimeWorkspaceRoots: [cwd], ephemeral: false });
        if (failure === 'unknown') throw new Error('connection lost after write');
        if (failure === 'invalid-start-response') return { thread: { id: 'invalid' } };
        if (failure === 'policy-mismatch') return { ...startResult, serviceTier: 'unapproved' };
        if (failure === 'start-active') return { ...startResult,
          thread: { ...startResult.thread, status: { type: 'active' } } };
        if (failure === 'start-turn') return { ...startResult,
          thread: { ...startResult.thread, turns: [{ id: 'turn-1' }] } };
        if (failure === 'profile-extra') return { ...startResult,
          activePermissionProfile: { ...startResult.activePermissionProfile, extra: 'hidden' } };
        if (failure === 'sandbox-extra') return { ...startResult,
          sandbox: { ...startResult.sandbox, extra: 'hidden' } };
        if (failure === 'environment-extra') return { ...startResult,
          thread: { ...startResult.thread, environments: [{ environmentId: 'local', cwd,
            runtimeWorkspaceRoots: [cwd], extra: 'hidden' }] } };
        return startResult;
      }
      if (method === 'thread/read') {
        assert.equal(options?.expectedGeneration, 1);
        readCount++;
        if (failure === 'read-fail') throw new Error('readback unavailable');
        if (failure === 'read-once' && readCount === 1) throw new Error('readback unavailable');
        if (failure === 'read-once-lost-reservation' && readCount === 1) {
          reserved = false;
          throw new Error('readback unavailable');
        }
        if (failure === 'second-read-fail' && readCount === 2) throw new Error('readback unavailable');
        return { thread: failure === 'unloaded' || failure === 'idle-to-unloaded' && readCount === 2
          ? { ...startResult.thread, status: { type: 'notLoaded' }, model: null,
            reasoningEffort: null, environments: null, path: rolloutPath }
          : { ...startResult.thread,
            modelProvider: failure === 'provider-mismatch' ? 'other' : template.modelProvider,
            cwd: failure === 'cwd-mismatch' ? 'C:\\fixture\\other' : cwd,
            path: failure === 'source-mismatch' ? 'C:\\fixture\\home\\other.jsonl' : rolloutPath } };
      }
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/queue/list') return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    },
  } as unknown as AppServerRpc & { initializedSession(): Promise<{ generation: number; initializeResult: Record<string, unknown> }>;
    isSessionCurrent(generation: number): boolean };
  const options = { rpc, operationId: randomUUID(), sourceId: 'source-a', requestedPolicy: template,
    persistIntent: async (intent: ControlledCreationIntent) => {
      assert.equal(intent.operationId.length, 36); assert.equal(intent.sourceId, 'source-a');
      assert.equal(reserved, false); reserved = true; persisted.push('intent');
      return { isCurrent: () => reserved };
    },
    persistStarted: async (started: ControlledCreationStarted) => {
      assert.equal(started.threadId, taskId); persisted.push('started');
      assert.deepEqual(started.selectedEffective.runtimeWorkspaceRoots, [cwd]);
      assert.equal(started.selectedEffective.approvalsReviewer, 'user');
      assert.deepEqual(started.selectedEffective.activePermissionProfile,
        { id: ':danger-full-access', extends: null });
      assert.deepEqual(started.selectedEffective.sandbox, { type: 'dangerFullAccess' });
      assert.deepEqual(started.selectedEffective.startThread, {
        status: failure === 'start-active' ? 'active' : 'idle',
        turnCount: failure === 'start-turn' ? 1 : 0, model: template.model,
        modelProvider: template.modelProvider, reasoningEffort: template.effort, cwd });
      assert.equal(started.selectedEffective.nativeShapeExact,
        !['profile-extra', 'sandbox-extra', 'environment-extra'].includes(failure));
      if (failure === 'policy-mismatch') assert.equal(started.selectedEffective.serviceTier, 'unapproved');
      if (failure === 'started-persist') throw new Error('storage unavailable');
    },
    persistQualified: async (receipt: ControlledCreationReceipt) => {
      assert.equal(receipt.threadId, taskId); persisted.push('qualified');
      if (failure === 'qualified-persist') throw new Error('sensitive storage detail');
    },
    resolveSource: async () => ({ sourceId: 'source-a', rolloutPath }),
  };
  return { calls, persisted, options };
}

test('controlled creator writes one thread/start after intent, then qualifies zero-turn source', async () => {
  const f = fixture();
  const receipt = await createControlledNativeTask(f.options);
  assert.equal(receipt.threadId, taskId);
  assert.equal(receipt.effectivePolicy.serviceTier, 'default');
  assert.equal(receipt.rolloutPath, rolloutPath);
  assert.equal(receipt.sourceGeneration.length, 36);
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
  assert.deepEqual(f.calls, ['thread/start', 'thread/read', 'thread/turns/list',
    'thread/goal/get', 'thread/queue/list', 'thread/read']);
  assert.equal(f.calls.includes('turn/start'), false);
});

test('first read RPC error retries read-only and qualifies the same native task', async () => {
  const f = fixture('read-once');
  const receipt = await createControlledNativeTask(f.options);
  assert.equal(receipt.threadId, taskId);
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
  assert.deepEqual(f.calls, ['thread/start', 'thread/read', 'thread/read',
    'thread/turns/list', 'thread/goal/get', 'thread/queue/list', 'thread/read']);
});

test('first read RPC error does not retry after the creator reservation changes', async () => {
  const f = fixture('read-once-lost-reservation');
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, ['thread/start', 'thread/read']);
  assert.deepEqual(f.persisted, ['intent', 'started']);
});

test('second read RPC error is not retried', async () => {
  const f = fixture('second-read-fail');
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, ['thread/start', 'thread/read', 'thread/turns/list',
    'thread/goal/get', 'thread/queue/list', 'thread/read']);
  assert.deepEqual(f.persisted, ['intent', 'started']);
});

test('exhausted first read uses one distinct fresh read-only session and closes it', async () => {
  const f = fixture('read-fail');
  const freshCalls: string[] = [];
  let factoryCalls = 0, closes = 0;
  const freshRpc = {
    async initializedSession() { return { generation: 2 }; },
    isSessionCurrent(generation: number) { return generation === 2; },
    async request(method: string, _params?: Record<string, unknown>, options?: { expectedGeneration?: number }) {
      freshCalls.push(method);
      assert.equal(options?.expectedGeneration, 2);
      if (method === 'thread/read') return { thread: { ...startResult.thread, path: rolloutPath } };
      if (method === 'thread/turns/list' || method === 'thread/queue/list')
        return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      throw new Error(`fresh session invoked ${method}`);
    },
  };
  const receipt = await createControlledNativeTask({ ...f.options,
    freshReadRpc: async () => { factoryCalls++; return { rpc: freshRpc, close: async () => { closes++; } }; } });
  assert.equal(receipt.threadId, taskId);
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
  assert.deepEqual(f.calls, ['thread/start', 'thread/read', 'thread/read', 'thread/read']);
  assert.deepEqual(freshCalls, ['thread/read', 'thread/turns/list', 'thread/goal/get',
    'thread/queue/list', 'thread/read']);
  assert.equal(factoryCalls, 1);
  assert.equal(closes, 1);
});

for (const failure of ['unknown', 'policy-mismatch', 'source-mismatch',
  'provider-mismatch', 'cwd-mismatch', 'second-read-fail',
  'read-once-lost-reservation'] as const)
  test(`fresh read factory is not invoked for ${failure}`, async () => {
    const f = fixture(failure);
    let factoryCalls = 0;
    await assert.rejects(createControlledNativeTask({ ...f.options,
      freshReadRpc: async () => { factoryCalls++; throw new Error('factory should not run'); } }),
    ControlledNativeCreationUncertainError);
    assert.equal(factoryCalls, 0);
    assert.equal(f.calls.filter(method => method === 'thread/start').length, 1);
    assert.deepEqual(f.persisted, failure === 'unknown' ? ['intent'] : ['intent', 'started']);
  });

test('fresh reader failure leaves started uncertain and closes the reader', async () => {
  const f = fixture('read-fail');
  const freshCalls: string[] = [];
  let closes = 0;
  const freshRpc = {
    async initializedSession() { return { generation: 2 }; },
    isSessionCurrent(generation: number) { return generation === 2; },
    async request(method: string) { freshCalls.push(method); throw new Error('fresh read unavailable'); },
  };
  await assert.rejects(createControlledNativeTask({ ...f.options,
    freshReadRpc: async () => ({ rpc: freshRpc, close: async () => { closes++; } }) }),
  ControlledNativeCreationUncertainError);
  assert.deepEqual(f.persisted, ['intent', 'started']);
  assert.deepEqual(freshCalls, ['thread/read']);
  assert.equal(f.calls.filter(method => method === 'thread/start').length, 1);
  assert.equal(closes, 1);
});

test('fresh reader must be a distinct RPC and never closes the original writer', async () => {
  const f = fixture('read-fail');
  let closes = 0;
  await assert.rejects(createControlledNativeTask({ ...f.options,
    freshReadRpc: async () => ({ rpc: f.options.rpc, close: async () => { closes++; } }) }),
  ControlledNativeCreationUncertainError);
  assert.deepEqual(f.persisted, ['intent', 'started']);
  assert.equal(f.calls.filter(method => method === 'thread/start').length, 1);
  assert.equal(closes, 0);
});

test('malformed fresh RPC does not trigger an untrusted close callback', async () => {
  const f = fixture('read-fail');
  let closes = 0;
  await assert.rejects(createControlledNativeTask({ ...f.options,
    freshReadRpc: async () => ({ rpc: {} as ControlledNativeTaskCreatorOptions['rpc'],
      close: async () => { closes++; } }) }), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.persisted, ['intent', 'started']);
  assert.equal(f.calls.filter(method => method === 'thread/start').length, 1);
  assert.equal(closes, 0);
});

test('fresh reader still requires the opt-in source proof', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vkodex-controlled-fresh-proof-'));
  const sourceHome = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  const preflightReceiptPath = path.join(root, 'preflight.json');
  mkdirSync(sourceHome); mkdirSync(workspace);
  const nativePath = path.join(sourceHome, 'sessions', `${taskId}.jsonl`);
  const native = { ...startResult, cwd: workspace, runtimeWorkspaceRoots: [workspace],
    thread: { ...startResult.thread, cwd: workspace } };
  const originalCalls: string[] = [], freshCalls: string[] = [];
  let closes = 0;
  const originalRpc = {
    async initializedSession() { return { generation: 1 }; },
    isSessionCurrent(generation: number) { return generation === 1; },
    async request(method: string) {
      originalCalls.push(method);
      if (method === 'thread/start') {
        mkdirSync(path.dirname(nativePath), { recursive: true });
        writeFileSync(nativePath, `${JSON.stringify({ type: 'session_meta',
          payload: { id: taskId, session_id: taskId, cwd: workspace } })}\n`);
        return native;
      }
      if (method === 'thread/read') throw new Error('original session read rejected');
      throw new Error(`unexpected original ${method}`);
    },
  } as unknown as ControlledNativeTaskCreatorOptions['rpc'];
  const freshRpc = {
    async initializedSession() { return { generation: 2 }; },
    isSessionCurrent(generation: number) { return generation === 2; },
    async request(method: string) {
      freshCalls.push(method);
      if (method === 'thread/read') return { thread: { ...native.thread, path: nativePath } };
      if (method === 'thread/turns/list' || method === 'thread/queue/list')
        return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      throw new Error(`unexpected fresh ${method}`);
    },
  } as unknown as ControlledNativeTaskCreatorOptions['rpc'];
  const journal = new ControlledNativeCreationJournal(path.join(root, 'creation.sqlite'));
  const operationId = randomUUID();
  try {
    const receipt = await createControlledNativeTask({ rpc: originalRpc, operationId,
      sourceId: 'isolated', requestedPolicy: { ...template, cwd: workspace,
        runtimeWorkspaceRoots: [workspace] },
      persistIntent: intent => journal.persistIntent(intent),
      persistStarted: started => journal.persistStarted(started),
      persistQualified: qualified => journal.persistQualified(qualified),
      sourceProof: { sourceHome, preflightReceiptPath },
      resolveSource: async () => { throw new Error('uncontrolled resolver'); },
      freshReadRpc: async () => ({ rpc: freshRpc, close: async () => { closes++; } }) });
    assert.equal(await realpath(receipt.rolloutPath), await realpath(nativePath));
    assert.equal(journal.get(operationId)?.state, 'qualified');
    assert.deepEqual(originalCalls, ['thread/start', 'thread/read', 'thread/read', 'thread/read']);
    assert.deepEqual(freshCalls, ['thread/read', 'thread/turns/list', 'thread/goal/get',
      'thread/queue/list', 'thread/read']);
    assert.equal(closes, 1);
  } finally { journal.close(); }
});

test('reservation loss during fresh reader close leaves started uncertain', async () => {
  const f = fixture('read-fail');
  let current = true, closes = 0;
  const freshRpc = {
    async initializedSession() { return { generation: 2 }; },
    isSessionCurrent(generation: number) { return generation === 2; },
    async request(method: string) {
      if (method === 'thread/read') return { thread: { ...startResult.thread, path: rolloutPath } };
      if (method === 'thread/turns/list' || method === 'thread/queue/list')
        return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      throw new Error(`unexpected ${method}`);
    },
  };
  await assert.rejects(createControlledNativeTask({ ...f.options,
    persistIntent: async intent => {
      const reservation = await f.options.persistIntent(intent);
      return { isCurrent: () => current && reservation.isCurrent() };
    },
    freshReadRpc: async () => ({ rpc: freshRpc,
      close: async () => { closes++; current = false; } }) }), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.persisted, ['intent', 'started']);
  assert.equal(closes, 1);
  assert.equal(f.calls.filter(method => method === 'thread/start').length, 1);
});

for (const mode of [undefined, 'authenticated-profile-new-task'] as const)
for (const loseRead of [false, true]) test(`${mode ?? 'exclusive'} source proof qualifies exact rollout${loseRead ? ' after restart' : ''}`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vkodex-controlled-source-'));
  const sourceHome = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  const aliasHome = path.join(root, 'home-alias');
  const preflightReceiptPath = path.join(root, 'preflight.json');
  mkdirSync(path.join(sourceHome, 'sessions'), { recursive: true });
  if (mode) writeFileSync(path.join(sourceHome, 'sessions', 'preexisting.jsonl'), '{"legacy":true}\n');
  symlinkSync(sourceHome, aliasHome, process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(workspace);
  const nativePath = path.join(sourceHome, 'sessions', `${taskId}.jsonl`);
  const nativeReadPath = path.toNamespacedPath(path.join(aliasHome, 'sessions', `${taskId}.jsonl`));
  const policy = { ...template, cwd: workspace, runtimeWorkspaceRoots: [workspace] };
  const native = { ...startResult, cwd: workspace, runtimeWorkspaceRoots: [workspace],
    thread: { ...startResult.thread, cwd: workspace } };
  const calls: string[] = [];
  let rejectRead = loseRead;
  const rpc = {
    async initializedSession() { return { generation: 1 }; },
    isSessionCurrent(generation: number) { return generation === 1; },
    async request(method: string) {
      calls.push(method);
      if (method === 'thread/start') {
        assert.equal(existsSync(preflightReceiptPath), true);
        writeFileSync(nativePath, `${JSON.stringify({ type: 'session_meta',
          payload: { id: taskId, session_id: taskId, cwd: workspace } })}\n`);
        return native;
      }
      if (method === 'thread/read') {
        if (rejectRead) throw new Error('readback unavailable');
        return { thread: { ...native.thread, path: nativeReadPath } };
      }
      if (method === 'thread/turns/list' || method === 'thread/queue/list') return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      throw new Error(`Unexpected ${method}`);
    },
  } as unknown as Parameters<typeof createControlledNativeTask>[0]['rpc'];
  const journalPath = path.join(root, 'creation.sqlite');
  let journal = new ControlledNativeCreationJournal(journalPath);
  try {
    const options: ControlledNativeTaskCreatorOptions = { rpc, operationId: randomUUID(), sourceId: 'isolated',
      requestedPolicy: policy, persistIntent: intent => journal.persistIntent(intent),
      persistStarted: started => journal.persistStarted(started),
      persistQualified: receipt => journal.persistQualified(receipt),
      resolveSource: async () => { throw new Error('legacy resolver must not run'); },
      sourceProof: { sourceHome, preflightReceiptPath, ...(mode ? { mode } : {}) } };
    if (loseRead) {
      await assert.rejects(createControlledNativeTask(options), ControlledNativeCreationUncertainError);
      assert.equal(journal.get(options.operationId)?.state, 'started');
      assert.equal(journal.get(options.operationId)?.intent.sourceProofRequired, true);
      assert.equal(journal.get(options.operationId)?.started?.sourceProofRequired, true);
      journal.close();
      journal = new ControlledNativeCreationJournal(journalPath);
      const beforeBypass = calls.length;
      await assert.rejects(reconcileControlledNativeCreation({ journal,
        operationId: options.operationId, rpc,
        resolveSource: async () => ({ sourceId: 'isolated', rolloutPath: nativePath }) }));
      if (mode) await assert.rejects(reconcileControlledNativeCreation({ journal,
        operationId: options.operationId, rpc, resolveSource: options.resolveSource,
        sourceProof: { sourceHome, preflightReceiptPath } }));
      assert.equal(calls.length, beforeBypass);
      assert.equal(journal.get(options.operationId)?.state, 'started');
      rejectRead = false;
    }
    const result = loseRead ? await reconcileControlledNativeCreation({ journal,
      operationId: options.operationId, rpc, resolveSource: options.resolveSource,
      sourceProof: { sourceHome, preflightReceiptPath, ...(mode ? { mode } : {}) } }) : await createControlledNativeTask(options);
    assert.equal(await realpath(result.rolloutPath), await realpath(nativePath));
    assert.equal(result.sourceProofRequired, true);
    assert.equal(result.sourceProofMode, mode);
    assert.equal(journal.get(options.operationId)?.qualified?.sourceProofRequired, true);
    assert.deepEqual(calls, [...(loseRead ? ['thread/start', 'thread/read', 'thread/read',
      'thread/read'] : ['thread/start']),
      'thread/read', 'thread/turns/list',
      'thread/goal/get', 'thread/queue/list', 'thread/read']);
  } finally { journal.close(); }
});

test('opt-in source preflight refuses occupied home before thread/start', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vkodex-controlled-occupied-'));
  const sourceHome = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  mkdirSync(path.join(sourceHome, 'sessions'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(path.join(sourceHome, 'sessions', `${taskId}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: taskId, session_id: taskId, cwd: workspace } })}\n`);
  const f = fixture();
  await assert.rejects(createControlledNativeTask({ ...f.options,
    requestedPolicy: { ...template, cwd: workspace, runtimeWorkspaceRoots: [workspace] },
    sourceProof: { sourceHome, preflightReceiptPath: path.join(root, 'preflight.json') } }));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.persisted, ['intent']);
});

test('authenticated-profile opt-in selects the exact returned task from a populated home and survives journal reload', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vkodex-controlled-auth-profile-'));
  const sourceHome = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  const sessions = path.join(sourceHome, 'sessions');
  const preflightReceiptPath = path.join(root, 'authenticated-profile-preflight.json');
  const journalPath = path.join(root, 'creation.sqlite');
  mkdirSync(sessions, { recursive: true }); mkdirSync(workspace);
  for (let index = 0; index < 3; index++)
    writeFileSync(path.join(sessions, `legacy-${index}.jsonl`), '{"legacy":true}\n');
  const nativePath = path.join(sessions, `${taskId}.jsonl`);
  const native = { ...startResult, cwd: workspace, runtimeWorkspaceRoots: [workspace],
    thread: { ...startResult.thread, cwd: workspace } };
  const calls: string[] = [];
  const rpc = {
    async initializedSession() { return { generation: 1 }; },
    isSessionCurrent(generation: number) { return generation === 1; },
    async request(method: string) {
      calls.push(method);
      if (method === 'thread/start') {
        assert.equal(existsSync(preflightReceiptPath), true);
        writeFileSync(nativePath, `${JSON.stringify({ type: 'session_meta',
          payload: { id: taskId, session_id: taskId, cwd: workspace } })}\n`);
        return native;
      }
      if (method === 'thread/read') return { thread: { ...native.thread, path: nativePath } };
      if (method === 'thread/turns/list' || method === 'thread/queue/list')
        return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      throw new Error(`Unexpected ${method}`);
    },
  } as unknown as ControlledNativeTaskCreatorOptions['rpc'];
  let journal = new ControlledNativeCreationJournal(journalPath);
  const operationId = randomUUID();
  try {
    const receipt = await createControlledNativeTask({ rpc, operationId, sourceId: 'authenticated-profile',
      requestedPolicy: { ...template, cwd: workspace, runtimeWorkspaceRoots: [workspace] },
      persistIntent: intent => journal.persistIntent(intent),
      persistStarted: started => journal.persistStarted(started),
      persistQualified: qualified => journal.persistQualified(qualified),
      resolveSource: async () => { throw new Error('uncontrolled resolver'); },
      sourceProof: { mode: 'authenticated-profile-new-task', sourceHome, preflightReceiptPath } });
    assert.equal(receipt.threadId, taskId);
    assert.equal(await realpath(receipt.rolloutPath), await realpath(nativePath));
    assert.equal(receipt.sourceProofMode, 'authenticated-profile-new-task');
    assert.equal(journal.get(operationId)?.state, 'qualified');
    assert.equal(journal.get(operationId)?.intent.sourceProofMode, 'authenticated-profile-new-task');
    assert.deepEqual(calls, ['thread/start', 'thread/read', 'thread/turns/list',
      'thread/goal/get', 'thread/queue/list', 'thread/read']);
    journal.close();
    journal = new ControlledNativeCreationJournal(journalPath);
    const restored = journal.get(operationId);
    assert.equal(restored?.state, 'qualified');
    assert.equal(restored?.intent.sourceProofMode, 'authenticated-profile-new-task');
    assert.equal(restored?.qualified?.threadId, taskId);
    assert.equal(await realpath(restored!.qualified!.rolloutPath), await realpath(nativePath));
  } finally { journal.close(); }
});

test('authenticated-profile workspace replacement rejects immediately before thread/start with zero writes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vkodex-controlled-auth-workspace-'));
  const sourceHome = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  const preflightReceiptPath = path.join(root, 'preflight.json');
  mkdirSync(path.join(sourceHome, 'sessions'), { recursive: true }); mkdirSync(workspace);
  writeFileSync(path.join(sourceHome, 'sessions', 'legacy.jsonl'), '{"legacy":true}\n');
  const journal = new ControlledNativeCreationJournal(path.join(root, 'creation.sqlite'));
  let writes = 0, replaced = false;
  const rpc = { async initializedSession() {
      if (!replaced) { renameSync(workspace, path.join(root, 'replaced-workspace')); mkdirSync(workspace); replaced = true; }
      return { generation: 1 };
    }, isSessionCurrent: (generation: number) => generation === 1,
    async request(method: string, _params: Record<string, unknown>, options?: { assertBeforeWrite?: () => void }) {
      assert.equal(method, 'thread/start');
      options?.assertBeforeWrite?.(); writes++;
      return startResult;
    } } as unknown as ControlledNativeTaskCreatorOptions['rpc'];
  try {
    await assert.rejects(createControlledNativeTask({ rpc, operationId: randomUUID(), sourceId: 'authenticated-profile',
      requestedPolicy: { ...template, cwd: workspace, runtimeWorkspaceRoots: [workspace] },
      persistIntent: intent => journal.persistIntent(intent), persistStarted: started => journal.persistStarted(started),
      persistQualified: qualified => journal.persistQualified(qualified),
      resolveSource: async () => { throw new Error('uncontrolled resolver'); },
      sourceProof: { mode: 'authenticated-profile-new-task', sourceHome, preflightReceiptPath } }));
    assert.equal(writes, 0);
  } finally { journal.close(); }
});

test('selected effective policy remains authoritative when readback is notLoaded', async () => {
  const f = fixture('unloaded');
  const receipt = await createControlledNativeTask(f.options);
  assert.equal(receipt.effectivePolicy.serviceTier, 'default');
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
});

test('idle to notLoaded is the same qualified zero-turn source', async () => {
  const f = fixture('idle-to-unloaded');
  const receipt = await createControlledNativeTask(f.options);
  assert.equal(receipt.threadId, taskId);
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
});

for (const failure of ['unknown', 'started-persist'] as const) test(`${failure} remains uncertain with no replay`, async () => {
  const f = fixture(failure);
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, ['thread/start']);
  assert.deepEqual(f.persisted, failure === 'unknown' ? ['intent'] : ['intent', 'started']);
});

for (const [failure, phase, expectedCalls, expectedPersisted] of [
  ['unknown', 'start-response', ['thread/start'], ['intent']],
  ['invalid-start-response', 'start-response', ['thread/start'], ['intent']],
  ['started-persist', 'persist-started', ['thread/start'], ['intent', 'started']],
  ['policy-mismatch', 'policy', ['thread/start'], ['intent', 'started']],
  ['read-fail', 'readback', ['thread/start', 'thread/read', 'thread/read',
    'thread/read'], ['intent', 'started']],
  ['qualified-persist', 'persist-qualified', ['thread/start', 'thread/read',
    'thread/turns/list', 'thread/goal/get', 'thread/queue/list', 'thread/read'],
  ['intent', 'started', 'qualified']],
] as const) test(`${failure} reports safe uncertain phase without replay`, async () => {
  const f = fixture(failure);
  await assert.rejects(createControlledNativeTask(f.options), error => {
    assert.ok(error instanceof ControlledNativeCreationUncertainError);
    assert.equal(error.phase, phase);
    assert.equal(error.message, 'Controlled native creation result is uncertain');
    assert.equal('cause' in error, false);
    assert.equal(JSON.stringify(error).includes('sensitive storage detail'), false);
    return true;
  });
  assert.deepEqual(f.calls, expectedCalls);
  assert.deepEqual(f.persisted, expectedPersisted);
});

for (const failure of ['source-mismatch', 'read-fail', 'provider-mismatch', 'cwd-mismatch'] as const)
  test(`${failure} after native acceptance refuses qualification without replay`, async () => {
  const f = fixture(failure);
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, failure === 'read-fail'
    ? ['thread/start', 'thread/read', 'thread/read', 'thread/read']
    : ['thread/start', 'thread/read']);
  assert.deepEqual(f.persisted, ['intent', 'started']);
  });

test('empty native state without a reserved creator intent cannot dispatch', async () => {
  const f = fixture();
  const options = { ...f.options, persistIntent: async () => { throw new Error('no creator provenance'); } };
  await assert.rejects(createControlledNativeTask(options), /no creator provenance/u);
  assert.deepEqual(f.calls, []);
});

test('native policy mismatch still persists known created ID before refusing qualification', async () => {
  const f = fixture('policy-mismatch');
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, ['thread/start']);
  assert.deepEqual(f.persisted, ['intent', 'started']);
});

for (const failure of ['start-active', 'start-turn', 'profile-extra',
  'sandbox-extra', 'environment-extra'] as const)
  test(`${failure} persists positive ID but refuses qualification`, async () => {
    const f = fixture(failure);
    await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
    assert.deepEqual(f.calls, ['thread/start']);
    assert.deepEqual(f.persisted, ['intent', 'started']);
  });

function journalFixture() {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-controlled-create-')), 'creation.sqlite');
  const intent: ControlledCreationIntent = { operationId: randomUUID(), creatorNonce: randomUUID(),
    sourceGeneration: randomUUID(), sourceId: 'source-a', requestedPolicy: template };
  const started: ControlledCreationStarted = { ...intent, threadId: taskId,
    selectedEffective: { model: template.model, modelProvider: template.modelProvider,
      reasoningEffort: template.effort, serviceTier: 'default', cwd,
      approvalPolicy: template.approvalPolicy, environments: [] } };
  const { allowedEnvironments: _environments, allowedServiceTiers: _tiers, ...requested } = template;
  const effectivePolicy = approveTaskPolicy({ ...requested, threadId: taskId,
    serviceTier: 'default', environments: [] });
  const qualified: ControlledCreationReceipt = { ...started, effectivePolicy,
    rolloutPath, status: 'qualified-zero-turn' };
  return { filePath, intent, started, qualified };
}

test('creation journal persists intent, native ID, and qualification across reopen', async () => {
  const f = journalFixture();
  let journal = new ControlledNativeCreationJournal(f.filePath);
  const reservation = await journal.persistIntent(f.intent);
  assert.equal(reservation.isCurrent(), true);
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  assert.equal(journal.synchronousMode(), 2);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  await journal.persistStarted(f.started);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  assert.equal(journal.get(f.intent.operationId)?.started?.threadId, taskId);
  await journal.persistQualified(f.qualified);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  assert.equal(journal.get(f.intent.operationId)?.qualified?.rolloutPath, rolloutPath);
  assert.deepEqual(journal.listUncertainPage({ limit: 100 }).items, []);
  journal.close();
});

test('creation journal rejects duplicate operation and immutable-scope drift without overwrite', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  await journal.persistIntent(f.intent);
  await assert.rejects(journal.persistIntent(f.intent));
  await assert.rejects(journal.persistStarted({ ...f.started, sourceId: 'different' }));
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  await journal.persistStarted(f.started);
  await assert.rejects(journal.persistStarted({ ...f.started, threadId: randomUUID() }));
  await assert.rejects(journal.persistQualified({ ...f.qualified, creatorNonce: randomUUID() }));
  assert.equal(journal.get(f.intent.operationId)?.state, 'started');
  assert.equal(journal.get(f.intent.operationId)?.started?.threadId, taskId);
  assert.deepEqual(journal.listUncertainPage({ limit: 100 }).items.map(row => row.state), ['started']);
  journal.close();
});

test('journal preserves source proof requirement across stages and rejects downgrade', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  const intent = { ...f.intent, sourceProofRequired: true as const };
  const started = { ...f.started, sourceProofRequired: true as const };
  await assert.rejects(journal.persistIntent({ ...f.intent,
    sourceProofRequired: false } as unknown as ControlledCreationIntent));
  await journal.persistIntent(intent);
  await assert.rejects(journal.persistStarted(f.started));
  await journal.persistStarted(started);
  await assert.rejects(journal.persistQualified(f.qualified));
  await journal.persistQualified({ ...f.qualified, sourceProofRequired: true });
  assert.equal(journal.get(f.intent.operationId)?.qualified?.sourceProofRequired, true);
  journal.close();
});

test('journal preserves authenticated-profile mode and refuses silent downgrade or unsupported mode', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  const mode = 'authenticated-profile-new-task' as const;
  const intent = { ...f.intent, sourceProofRequired: true as const, sourceProofMode: mode };
  const started = { ...f.started, sourceProofRequired: true as const, sourceProofMode: mode };
  await assert.rejects(journal.persistIntent({ ...f.intent,
    sourceProofMode: mode } as ControlledCreationIntent));
  await assert.rejects(journal.persistIntent({ ...f.intent, sourceProofRequired: true,
    sourceProofMode: 'unexpected-mode' } as unknown as ControlledCreationIntent));
  await journal.persistIntent(intent);
  await assert.rejects(journal.persistStarted({ ...f.started, sourceProofRequired: true }));
  await journal.persistStarted(started);
  await assert.rejects(journal.persistQualified({ ...f.qualified, sourceProofRequired: true }));
  await journal.persistQualified({ ...f.qualified, sourceProofRequired: true, sourceProofMode: mode });
  assert.equal(journal.get(f.intent.operationId)?.qualified?.sourceProofMode, mode);
  journal.close();
});

test('reopened uncertain intent prevents any second native thread/start', async () => {
  const f = journalFixture();
  let journal = new ControlledNativeCreationJournal(f.filePath);
  await journal.persistIntent(f.intent);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  const rpc = fixture();
  await assert.rejects(createControlledNativeTask({ ...rpc.options,
    operationId: f.intent.operationId,
    persistIntent: intent => journal.persistIntent(intent),
    persistStarted: started => journal.persistStarted(started),
    persistQualified: receipt => journal.persistQualified(receipt) }));
  assert.deepEqual(rpc.calls, []);
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  journal.close();
});

test('journal independently rejects forged or malformed requested policy', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  await assert.rejects(journal.persistIntent({ ...f.intent,
    requestedPolicy: { ...f.intent.requestedPolicy, model: 'bad model' } }));
  await assert.rejects(journal.persistIntent({ ...f.intent,
    requestedPolicy: { ...f.intent.requestedPolicy, allowedServiceTiers: ['bad tier'] } }));
  await assert.rejects(journal.persistIntent({ ...f.intent,
    requestedPolicy: { ...f.intent.requestedPolicy, extra: 'unapproved' } } as ControlledCreationIntent));
  assert.equal(journal.get(f.intent.operationId), null);
  journal.close();
});

test('journal rejects qualified policy that differs from fixed request or native selection', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  await journal.persistIntent(f.intent);
  await journal.persistStarted(f.started);
  await assert.rejects(journal.persistQualified({ ...f.qualified,
    effectivePolicy: approveTaskPolicy({ ...f.qualified.effectivePolicy, model: 'gpt-6-sol' }) }));
  await assert.rejects(journal.persistQualified({ ...f.qualified,
    effectivePolicy: approveTaskPolicy({ ...f.qualified.effectivePolicy, serviceTier: null }) }));
  assert.equal(journal.get(f.intent.operationId)?.state, 'started');
  journal.close();
});

test('same native thread ID cannot be persisted for two creation operations', async () => {
  const first = journalFixture(), second = journalFixture();
  const journal = new ControlledNativeCreationJournal(first.filePath);
  await journal.persistIntent(first.intent);
  await journal.persistStarted(first.started);
  await journal.persistIntent(second.intent);
  await assert.rejects(journal.persistStarted(second.started));
  assert.equal(journal.get(second.intent.operationId)?.state, 'intent');
  assert.equal(journal.get(first.intent.operationId)?.started?.threadId, taskId);
  journal.close();
});

test('qualified native cwd accepts equivalent Windows path spelling', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  const started = { ...f.started, selectedEffective: { ...f.started.selectedEffective,
    cwd: 'c:\\FIXTURE\\workspace\\.' } };
  await journal.persistIntent(f.intent);
  await journal.persistStarted(started);
  await journal.persistQualified({ ...f.qualified, selectedEffective: started.selectedEffective });
  assert.equal(journal.get(f.intent.operationId)?.state, 'qualified');
  journal.close();
});

test('uncertain journal pages remain bounded and stable across insertion and reopen', async () => {
  const f = journalFixture();
  let journal = new ControlledNativeCreationJournal(f.filePath);
  const ids: string[] = [];
  for (let index = 0; index < 101; index++) {
    const operationId = randomUUID(); ids.push(operationId);
    await journal.persistIntent({ ...f.intent, operationId, creatorNonce: randomUUID() });
  }
  const first = journal.listUncertainPage({ limit: 100 });
  assert.equal(first.items.length, 100);
  assert.deepEqual(first.items.map(row => row.intent.operationId), ids.slice(0, 100));
  assert.equal(typeof first.nextCursor, 'number');
  const inserted = randomUUID();
  await journal.persistIntent({ ...f.intent, operationId: inserted, creatorNonce: randomUUID() });
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  const second = journal.listUncertainPage({ afterSequence: first.nextCursor!, limit: 100 });
  assert.deepEqual(second.items.map(row => row.intent.operationId), [ids[100], inserted]);
  assert.equal(second.nextCursor, null);
  assert.ok(second.items.every(row => row.sequence > first.nextCursor!));
  assert.throws(() => journal.listUncertainPage({ limit: 101 }));
  journal.close();
});

test('published pre-pagination journal schema reopens and paginates without migration', () => {
  const f = journalFixture();
  const database = new Database(f.filePath);
  database.exec(`CREATE TABLE controlled_native_creations (
    operation_id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, state TEXT NOT NULL
      CHECK(state IN ('intent','started','qualified')),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 3),
    intent_json TEXT NOT NULL, started_json TEXT, qualified_json TEXT,
    CHECK((state='intent' AND revision=1 AND thread_id IS NULL AND started_json IS NULL AND qualified_json IS NULL)
      OR (state='started' AND revision=2 AND thread_id IS NOT NULL AND started_json IS NOT NULL AND qualified_json IS NULL)
      OR (state='qualified' AND revision=3 AND thread_id IS NOT NULL AND started_json IS NOT NULL AND qualified_json IS NOT NULL))
  )`);
  database.prepare(`INSERT INTO controlled_native_creations
    (operation_id,state,revision,intent_json) VALUES (?,'intent',1,?)`)
    .run(f.intent.operationId, JSON.stringify(f.intent));
  database.close();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  const page = journal.listUncertainPage({ limit: 100 });
  assert.deepEqual(page.items.map(item => item.intent.operationId), [f.intent.operationId]);
  assert.equal(page.items[0]?.sequence, 1);
  assert.equal(page.nextCursor, null);
  journal.close();
});

function fullStarted(started: ControlledCreationStarted): ControlledCreationStarted {
  return { ...started, selectedEffective: { ...started.selectedEffective,
    runtimeWorkspaceRoots: [cwd], approvalsReviewer: 'user',
    activePermissionProfile: { id: ':danger-full-access', extends: null },
    sandbox: { type: 'dangerFullAccess' }, nativeShapeExact: true,
    startThread: { status: 'idle', turnCount: 0, model: template.model,
      modelProvider: template.modelProvider, reasoningEffort: template.effort, cwd } } };
}

test('read-only reconciliation qualifies a full persisted native selection without any write', async () => {
  const f = journalFixture(), runtime = fixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  const observed: string[] = [];
  await journal.persistIntent(f.intent);
  await journal.persistStarted(fullStarted(f.started));
  const receipt = await reconcileControlledNativeCreation({ journal,
    operationId: f.intent.operationId, rpc: runtime.options.rpc,
    resolveSource: async (id, observedPath) => {
      assert.equal(id, taskId);
      observed.push(observedPath!);
      return { sourceId: 'source-a', rolloutPath };
    } });
  assert.equal(receipt.threadId, taskId);
  assert.equal(journal.get(f.intent.operationId)?.state, 'qualified');
  assert.deepEqual(runtime.calls, ['thread/read', 'thread/turns/list', 'thread/goal/get',
    'thread/queue/list', 'thread/read']);
  assert.deepEqual(observed, [rolloutPath, rolloutPath]);
  journal.close();
});

test('legacy incomplete started record remains readable but cannot reconcile', async () => {
  const f = journalFixture(), runtime = fixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  await journal.persistIntent(f.intent);
  await journal.persistStarted(f.started);
  assert.equal(journal.get(f.intent.operationId)?.state, 'started');
  await assert.rejects(reconcileControlledNativeCreation({ journal,
    operationId: f.intent.operationId, rpc: runtime.options.rpc,
    resolveSource: runtime.options.resolveSource }));
  assert.equal(journal.get(f.intent.operationId)?.state, 'started');
  assert.deepEqual(runtime.calls, []);
  journal.close();
});

for (const failure of ['wrong-policy', 'wrong-source', 'active', 'resumed', 'new-turn',
  'start-active', 'start-turn', 'shape-loss', 'thread-policy'] as const)
  test(`reconciliation refuses ${failure} without any native mutation`, async () => {
    const f = journalFixture(), runtime = fixture();
    const journal = new ControlledNativeCreationJournal(f.filePath);
    const started = fullStarted(f.started);
    await journal.persistIntent(f.intent);
    const selection = failure === 'wrong-policy' ? { ...started.selectedEffective,
      approvalsReviewer: 'auto_review' }
      : failure === 'start-active' ? { ...started.selectedEffective,
        startThread: { ...started.selectedEffective.startThread!, status: 'active' } }
      : failure === 'start-turn' ? { ...started.selectedEffective,
        startThread: { ...started.selectedEffective.startThread!, turnCount: 1 } }
      : failure === 'shape-loss' ? { ...started.selectedEffective, nativeShapeExact: false }
      : failure === 'thread-policy' ? { ...started.selectedEffective,
        startThread: { ...started.selectedEffective.startThread!, model: 'other' } }
      : started.selectedEffective;
    await journal.persistStarted({ ...started, selectedEffective: selection });
    const original = runtime.options.rpc.request.bind(runtime.options.rpc);
    const rpc = { ...runtime.options.rpc, request: async (...args: Parameters<typeof original>) => {
      if (failure === 'active' && args[0] === 'thread/read') return { thread: {
        ...startResult.thread, path: rolloutPath, status: { type: 'active' } } };
      if (failure === 'resumed' && args[0] === 'thread/read') return { thread: {
        ...startResult.thread, path: rolloutPath, turns: [{ id: 'unexpected' }] } };
      if (failure === 'new-turn' && args[0] === 'thread/turns/list')
        return { data: [{ id: 'unexpected' }], nextCursor: null };
      return original(...args);
    } };
    await assert.rejects(reconcileControlledNativeCreation({ journal,
      operationId: f.intent.operationId, rpc,
      resolveSource: failure === 'wrong-source' ? async () => ({ sourceId: 'other', rolloutPath })
        : runtime.options.resolveSource }));
    assert.equal(journal.get(f.intent.operationId)?.state, 'started');
    assert.equal(runtime.calls.includes('thread/start'), false);
    journal.close();
  });
