import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedWorkerFrontendHost } from '../src/codex/managed-worker-frontend-host.js';
import { ManagedWorkerNativeStartHandler } from '../src/desktop/managed-worker-native-start.js';
import type { NativeStartAuthority, StockNativeStartAdmission } from '../src/desktop/managed-worker-native-start.js';
import { NativeStartIntentStore } from '../src/codex/native-start-intent-store.js';
import { prepareNativeFollowerStart } from '../src/codex/native-follower-start.js';
import type { QualifiedContinuationEvidence } from '../src/desktop/managed-worker-bootstrap.js';
import { DesktopIpcClient, encodeFrame, FrameDecoder } from '../src/desktop/ipc-client.js';
import type { IpcObject, IpcIncomingRequest } from '../src/desktop/ipc-client.js';

class Child extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly frames: IpcObject[] = [];
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; pid = undefined;
  constructor() {
    super(); let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'); const frame = JSON.parse(buffer.slice(0, at)) as IpcObject;
        buffer = buffer.slice(at + 1); this.frames.push(frame);
        if (frame.method === 'initialize') queueMicrotask(() => this.reply(frame.id, { serverInfo: { name: 'test' } }));
      }
    });
  }
  reply(id: unknown, result: IpcObject): void { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
  kill(): boolean { this.emit('close', 0, null); return true; }
}
class Broker extends Duplex {
  readonly frames: IpcObject[] = []; readonly decoder = new FrameDecoder();
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    for (const frame of this.decoder.push(chunk)) {
      this.frames.push(frame);
      if (frame.method === 'initialize') queueMicrotask(() => this.send({ type: 'response',
        requestId: frame.requestId, resultType: 'success', result: { clientId: 'owner-peer' } }));
    }
    callback();
  }
  send(frame: IpcObject): void { this.push(encodeFrame(frame)); }
}
async function waitFrame(frames: IpcObject[], predicate: (frame: IpcObject) => boolean): Promise<IpcObject> {
  const end = Date.now() + 2000;
  for (;;) {
    const found = frames.find(predicate); if (found) return found;
    if (Date.now() > end) throw new Error('fixture-frame-timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(timeout = 2000) {
  const taskId = 'native-task', ownerEpoch = randomUUID(), controlKey = {}, child = new Child();
  const state = { authorized: true };
  const authority: NativeStartAuthority = { ownerEpoch, backendGeneration: 1, authorityRevision: 1,
    snapshot: { id: taskId, cwd: 'C:/native-test', latestModel: 'gpt-fixture', latestReasoningEffort: 'low',
      latestServiceTier: null, latestCollaborationMode: null,
      currentPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalsReviewer: 'user', runtimeWorkspaceRoots: [] } } };
  const host = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/native-test',
    initializeRequest: { clientInfo: { name: 'fixture' }, capabilities: {} }, adapterKey: {},
    bootstrapReadMethods: [], backendTimeoutMs: timeout, allowRequest: () => false, allowAnswer: () => false,
    launch: () => child as unknown as ChildProcessWithoutNullStreams,
    commandPolicy: { controlKey, ownerEpoch, fingerprintKey: randomBytes(32),
      journalPath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-native-start-')), 'ops.sqlite'),
      isOwnerCurrent: () => true, authorize: ({ params }) => params.model === 'gpt-fixture' || params.model === 'gpt-5.6-sol' ||
        params.model === null && ['gpt-fixture', 'gpt-5.6-sol'].includes(
          ((params.collaborationMode as IpcObject)?.settings as IpcObject)?.model as string) } });
  await host.start();
  const handler = new ManagedWorkerNativeStartHandler({ host, controlKey, taskId, ownerEpoch,
    authority: () => authority, authorizeFollower: r => state.authorized && r.sourceClientId === 'desktop' });
  const request: IpcIncomingRequest = { requestId: 'send-1', sourceClientId: 'desktop', hostId: 'local',
    method: 'thread-follower-start-turn', version: 2,
    params: { conversationId: taskId, turnStart: { request: { threadId: taskId,
      clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'native input', text_elements: [] }] },
      context: { inheritThreadSettings: true } } } };
  return { host, handler, child, request, state, authority, controlKey, taskId, ownerEpoch };
}

function continuationFixture(f: Awaited<ReturnType<typeof fixture>>): {
  request: IpcIncomingRequest; evidence: QualifiedContinuationEvidence;
} {
  const sandboxPolicy = { type: 'readOnly', networkAccess: false }, profile = { id: ':read-only' };
  const mode = { mode: 'default', settings: { model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } };
  const snapshot = { id: f.taskId, cwd: 'C:/native-test', hostId: 'local', resumeState: 'resumed',
    workspaceKind: 'projectless', turns: [{ turnId: 'prior-terminal', status: 'completed' }],
    turnsPagination: { hasLoadedOldest: true, olderCursor: null }, threadRuntimeStatus: { type: 'idle' },
    requests: [], nativeQueue: [], queuedFollowUps: [],
    environments: [{ environmentId: 'local', cwd: 'C:/native-test', runtimeWorkspaceRoots: ['C:/native-test'] }],
    latestModel: 'gpt-5.6-sol', latestReasoningEffort: 'low', latestServiceTier: null,
    latestCollaborationMode: mode,
    currentPermissions: { activePermissionProfile: profile, sandboxPolicy, approvalPolicy: 'on-request',
      approvalsReviewer: 'user', runtimeWorkspaceRoots: ['C:/native-test'] },
    latestThreadSettings: { cwd: 'C:/native-test', model: 'gpt-5.6-sol', effort: 'low', serviceTier: null,
      summary: null, personality: 'pragmatic', activePermissionProfile: profile, sandboxPolicy,
      approvalPolicy: 'on-request', approvalsReviewer: 'user' } };
  Object.assign(f.authority, { semanticRevision: 7, snapshot, composer: { snapshot, defaults: {
    taskId: f.taskId, cwd: 'C:/native-test', summary: null, personality: 'pragmatic' } } });
  const request = structuredClone(f.request), start = request.params.turnStart as IpcObject;
  Object.assign(start.request as IpcObject, { cwd: 'C:/native-test', model: null, effort: null, serviceTier: null,
    collaborationMode: mode, permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
    turnTrigger: 'composer', responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    multiAgentMode: 'explicitRequestOnly' });
  start.context = { inheritThreadSettings: true, writingBlockContextPrepared: true,
    localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [], responseItems: [],
    useAppServerPermissionDefault: false, usePermissionSelection: false };
  const evidence: QualifiedContinuationEvidence = { owner: { threadId: f.taskId, ownerEpoch: f.ownerEpoch,
    backendGeneration: 1, semanticRevision: 7, pendingRequests: 0, queuedFollowUps: 0,
    inFlightCommands: 0, unconfirmedOperations: false }, turnCount: 1, latestTurnId: 'prior-terminal', terminalTurnIds: ['prior-terminal'],
    historyDigest: 'a'.repeat(64), effective: { model: 'gpt-5.6-sol', effort: 'low', cwd: 'C:/native-test',
      activePermissionProfileId: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandboxType: 'readOnly', networkAccess: false, serviceTier: null, runtimeWorkspaceRoots: ['C:/native-test'],
      environments: structuredClone(snapshot.environments) }, composerDefaults: {
      taskId: f.taskId, cwd: 'C:/native-test', summary: null, personality: 'pragmatic' } };
  return { request, evidence };
}

test('stock direct hook cannot be bypassed by an ordinary native envelope', async () => {
  const f = await fixture(100);
  const store = new NativeStartIntentStore({ filePath: path.join(
    mkdtempSync(path.join(tmpdir(), 'vkodex-stock-direct-')), 'intents.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId,
    encryptionKey: randomBytes(32) });
  let preparations = 0;
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store,
    stockStart: { async prepare() { preparations++; throw new Error('stock proof unavailable'); } },
  });
  try {
    await assert.rejects(handler.handle(f.request, new AbortController().signal), /stock proof unavailable/);
    assert.equal(preparations, 1);
    assert.equal(store.list().length, 0);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('stock direct admission preserves actual turn receipt and durable duplicate across policy drift', async () => {
  const f = await fixture();
  Object.assign(f.authority.snapshot, { currentPermissions: { activePermissionProfile: { id: ':danger-full-access' },
    sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user',
    runtimeWorkspaceRoots: ['C:/native-test'] } });
  const store = new NativeStartIntentStore({ filePath: path.join(
    mkdtempSync(path.join(tmpdir(), 'vkodex-stock-receipt-')), 'intents.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  const phases: string[] = [];
  let preparations = 0, settled = 0;
  const stockStart: StockNativeStartAdmission = { async prepare(scope) {
    preparations++;
    assert.equal(scope.previousIntent, null);
    return { params: prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params),
      uiParams: null, localMetadata: { forwardedUpstream: { turnTrigger: false } },
      assertCurrent(phase) { phases.push(phase); }, settle() { settled++; } };
  } };
  const make = () => new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store, stockStart });
  let handler = make();
  try {
    const pending = handler.handle(f.request, new AbortController().signal);
    const frame = await waitFrame(f.child.frames, value => value.method === 'turn/start');
    assert.equal((frame.params as IpcObject).permissions, ':danger-full-access');
    assert.equal(store.list().length, 1);
    const result = { turn: { id: 'actual-stock-direct-turn', status: 'inProgress' } };
    f.child.reply(frame.id, result);
    assert.deepEqual(await pending, { result });
    assert.deepEqual(phases, ['before-intent', 'before-reservation', 'before-write']);
    assert.equal(settled, 1);
    handler.close(); handler = make();
    Object.assign(f.authority, { authorityRevision: 2 });
    Object.assign(f.authority.snapshot, { latestModel: 'changed-after-acceptance' });
    assert.deepEqual(await handler.handle({ ...f.request, requestId: 'after-reconnect' },
      new AbortController().signal), { result });
    assert.equal(preparations, 1);
    assert.equal(settled, 1);
    assert.equal(f.child.frames.filter(value => value.method === 'turn/start').length, 1);
    const changed = structuredClone(f.request);
    ((changed.params.turnStart as IpcObject).request as IpcObject).input = [
      { type: 'text', text: 'different', text_elements: [] }];
    await assert.rejects(handler.handle(changed, new AbortController().signal));
    assert.equal(preparations, 1);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('stock fence refusal at write retains rejection and never falls back or replays', async () => {
  const f = await fixture();
  const store = new NativeStartIntentStore({ filePath: path.join(
    mkdtempSync(path.join(tmpdir(), 'vkodex-stock-fence-')), 'intents.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  let preparations = 0, settled = 0;
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store, stockStart: { async prepare(scope) {
      preparations++;
      return { params: prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params),
        uiParams: null, localMetadata: null, assertCurrent(phase) {
          if (phase === 'before-write') throw new Error('stock owner revoked');
        }, settle() { settled++; } };
    } } });
  try {
    await assert.rejects(handler.handle(f.request, new AbortController().signal));
    const intent = store.list()[0]!;
    assert.equal(f.host.commandStatus(f.controlKey, intent.operationId)?.state, 'rejected');
    await assert.rejects(handler.handle(f.request, new AbortController().signal));
    assert.equal(preparations, 1);
    assert.equal(settled, 1);
    assert.equal(f.child.frames.filter(value => value.method === 'turn/start').length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('stock prepare deferred across follower, authority, and adapter revocation cannot persist or write', async () => {
  const f = await fixture();
  const store = new NativeStartIntentStore({ filePath: path.join(
    mkdtempSync(path.join(tmpdir(), 'vkodex-stock-revoked-')), 'intents.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => f.state.authorized, intentStore: store,
    stockStart: { async prepare(scope) {
      entered(); await gate;
      return { params: prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params),
        uiParams: null, localMetadata: null, assertCurrent() {
          if (!f.state.authorized) throw new Error('stock follower revoked');
        }, settle() {} };
    } } });
  try {
    const pending = handler.handle(f.request, new AbortController().signal);
    await preparing;
    f.state.authorized = false;
    Object.assign(f.authority, { authorityRevision: f.authority.authorityRevision + 1 });
    handler.close();
    release();
    await assert.rejects(pending);
    assert.equal(store.list().length, 0);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('stock timeout unknown duplicate refuses without reprepare or rewrite and changed body collides', async () => {
  const f = await fixture(40);
  const store = new NativeStartIntentStore({ filePath: path.join(
    mkdtempSync(path.join(tmpdir(), 'vkodex-stock-unknown-')), 'intents.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  let preparations = 0, settles = 0;
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store, stockStart: { async prepare(scope) {
      preparations++;
      return { params: prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params),
        uiParams: null, localMetadata: null, assertCurrent() {}, settle() { settles++; } };
    } } });
  try {
    await assert.rejects(handler.handle(f.request, new AbortController().signal), /receipt unavailable/);
    const frameCount = f.child.frames.filter(frame => frame.method === 'turn/start').length;
    assert.equal(frameCount, 1);
    assert.equal(store.list().length, 1);
    await assert.rejects(handler.handle({ ...f.request, requestId: 'exact-unknown-retry' },
      new AbortController().signal));
    assert.equal(preparations, 1);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, frameCount);
    const changed = structuredClone(f.request);
    ((changed.params.turnStart as IpcObject).request as IpcObject).input = [
      { type: 'text', text: 'different body', text_elements: [] }];
    await assert.rejects(handler.handle(changed, new AbortController().signal));
    assert.equal(preparations, 1);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, frameCount);
    assert.equal(settles, 1);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('stock asynchronous currentness callbacks fail closed before intent and at write', async t => {
  for (const phase of ['before-intent', 'before-write'] as const) {
    await t.test(`${phase} promise result is refused`, async () => {
      const f = await fixture();
      const store = new NativeStartIntentStore({ filePath: path.join(
        mkdtempSync(path.join(tmpdir(), 'vkodex-stock-async-fence-')), 'intents.sqlite'),
        ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
      const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
        taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
        authorizeFollower: () => true, intentStore: store, stockStart: { async prepare(scope) {
          return { params: prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params),
            uiParams: null, localMetadata: null,
            assertCurrent(current) {
              if (current === phase) return Promise.resolve(false) as unknown as void;
            }, settle() {} };
        } } });
      try {
        await assert.rejects(handler.handle(f.request, new AbortController().signal));
        assert.equal(store.list().length, phase === 'before-intent' ? 0 : 1);
        assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
      } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
    });
    await t.test(`${phase} rejected promise is refused without unhandled rejection`, async () => {
      const f = await fixture();
      const store = new NativeStartIntentStore({ filePath: path.join(
        mkdtempSync(path.join(tmpdir(), 'vkodex-stock-async-reject-')), 'intents.sqlite'),
        ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
      const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
        taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
        authorizeFollower: () => true, intentStore: store, stockStart: { async prepare(scope) {
          return { params: prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params),
            uiParams: null, localMetadata: null,
            assertCurrent(current) {
              if (current === phase) return Promise.reject(new Error('async stock fence failure')) as unknown as void;
            }, settle() {} };
        } } });
      try {
        await assert.rejects(handler.handle(f.request, new AbortController().signal));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(store.list().length, phase === 'before-intent' ? 0 : 1);
        assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
      } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
    });
  }
});

test('stock settle exceptions cannot replace the actual accepted receipt', async t => {
  for (const settle of [
    () => { throw new Error('settle threw'); },
    () => Promise.reject(new Error('settle rejected')),
  ]) {
    await t.test('accepted receipt survives failed settle', async () => {
      const f = await fixture();
      const store = new NativeStartIntentStore({ filePath: path.join(
        mkdtempSync(path.join(tmpdir(), 'vkodex-stock-settle-')), 'intents.sqlite'),
        ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
      const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
        taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
        authorizeFollower: () => true, intentStore: store, stockStart: { async prepare(scope) {
          return { params: prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params),
            uiParams: null, localMetadata: null, assertCurrent() {}, settle };
        } } });
      try {
        const pending = handler.handle(f.request, new AbortController().signal);
        const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
        const receipt = { turn: { id: 'accepted-despite-settle-failure', status: 'inProgress' } };
        f.child.reply(wire.id, receipt);
        assert.deepEqual(await pending, { result: receipt });
        await new Promise(resolve => setImmediate(resolve));
      } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
    });
  }
});

test('stock intent-only admission preserves original intent when compiled candidate changes', async () => {
  const f = await fixture();
  const store = new NativeStartIntentStore({ filePath: path.join(
    mkdtempSync(path.join(tmpdir(), 'vkodex-stock-candidate-drift-')), 'intents.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  let compilations = 0;
  const stockStart: StockNativeStartAdmission = { async prepare(scope) {
    compilations++;
    const params = prepareNativeFollowerStart(scope.authority.snapshot, scope.request.params);
    if (compilations > 1) params.serviceTier = 'candidate-drift';
    return { params, uiParams: null, localMetadata: null,
      assertCurrent(phase) { if (phase === 'before-write' && compilations === 1) throw new Error('stop before write'); },
      settle() {} };
  } };
  const host = { get metadata() { return f.host.metadata; },
    commandStatusForIntent: f.host.commandStatusForIntent.bind(f.host),
    executeCommandWithResponse: async () => { throw new Error('simulated pre-dispatch interruption'); } };
  let handler = new ManagedWorkerNativeStartHandler({ host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store, stockStart });
  try {
    await assert.rejects(handler.handle(f.request, new AbortController().signal));
    const original = store.list()[0]!;
    assert.equal(f.host.commandStatusForIntent(f.controlKey, original.intent.command), null);
    assert.equal(original.intent.command.params.stockCandidateMarker, undefined);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    handler.close();
    handler = new ManagedWorkerNativeStartHandler({ host, controlKey: f.controlKey,
      taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
      authorizeFollower: () => true, intentStore: store, stockStart });
    await assert.rejects(handler.handle({ ...f.request, requestId: 'candidate-drift-retry' },
      new AbortController().signal));
    assert.equal(compilations, 2);
    assert.deepEqual(store.get(original.operationId)?.intent, original.intent);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('Composer intent survives adapter recreation and first-turn eligibility loss without a second write', async () => {
  const f = await fixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-composer-intent-'));
  const options = { filePath: path.join(directory, 'intent.sqlite'), ownerEpoch: f.ownerEpoch,
    backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) };
  let store = new NativeStartIntentStore(options);
  const sandboxPolicy = { type: 'readOnly', networkAccess: false };
  const mode = { mode: 'default', settings: { model: 'gpt-fixture', reasoning_effort: 'low', developer_instructions: null } };
  const profile = { id: ':read-only' };
  const full = { ...structuredClone(f.authority.snapshot), hostId: 'local', resumeState: 'resumed',
    workspaceKind: 'projectless', turns: [], environments: [], latestCollaborationMode: mode,
    turnsPagination: { hasLoadedOldest: true, olderCursor: null }, threadRuntimeStatus: { type: 'idle' },
    requests: [], nativeQueue: [], queuedFollowUps: [],
    currentPermissions: { activePermissionProfile: profile, sandboxPolicy, approvalPolicy: 'never',
      approvalsReviewer: 'user', runtimeWorkspaceRoots: ['C:/native-test'] },
    latestThreadSettings: { cwd: 'C:/native-test', model: 'gpt-fixture', effort: 'low', serviceTier: null,
      summary: null, personality: 'pragmatic', activePermissionProfile: profile, sandboxPolicy } };
  Object.assign(f.authority, { snapshot: full, composer: { snapshot: full, defaults: null } });
  const request = structuredClone(f.request), start = request.params.turnStart as IpcObject;
  Object.assign(start.request as IpcObject, { cwd: 'C:/native-test', model: null, effort: null, serviceTier: null,
    collaborationMode: mode, permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
    turnTrigger: 'composer', responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    multiAgentMode: 'explicitRequestOnly' });
  start.context = { inheritThreadSettings: true, writingBlockContextPrepared: true,
    localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [], responseItems: [],
    useAppServerPermissionDefault: false, usePermissionSelection: false };
  const make = () => new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => f.state.authorized, intentStore: store });
  let handler = make();
  try {
    const run = handler.handle(request, new AbortController().signal);
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    assert.equal(store.list().length, 1); // Written before the worker receives anything.
    assert.equal((wire.params as IpcObject).permissions, ':read-only');
    Object.assign(f.authority, { composer: null }); // Real turn 0 -> 1 after admission.
    const actual = { turn: { id: 'composer-turn', status: 'inProgress' } };
    f.child.reply(wire.id, actual);
    assert.deepEqual(await run, { result: actual });
    handler.close(); store.close();
    store = new NativeStartIntentStore(options); handler = make();
    assert.deepEqual(await handler.handle({ ...request, requestId: 'reconnected' }, new AbortController().signal),
      { result: actual });
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.deepEqual(store.list()[0]!.intent.localMetadata, { fileAttachmentCount: 0 });
    const changed = structuredClone(request);
    ((changed.params.turnStart as IpcObject).request as IpcObject).input = [{ type: 'text', text: 'changed' }];
    await assert.rejects(handler.handle(changed, new AbortController().signal));
    const newId = structuredClone(request);
    ((newId.params.turnStart as IpcObject).request as IpcObject).clientUserMessageId = randomUUID();
    await assert.rejects(handler.handle(newId, new AbortController().signal));
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('reopened intent-only reservation cannot dispatch under changed original admission', async () => {
  const f = await fixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-intent-gap-'));
  const options = { filePath: path.join(directory, 'intent.sqlite'), ownerEpoch: f.ownerEpoch,
    backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) };
  let store = new NativeStartIntentStore(options);
  const envelope = structuredClone(f.request.params);
  const clientId = ((envelope.turnStart as IpcObject).request as IpcObject).clientUserMessageId as string;
  const digest = createHash('sha256').update(JSON.stringify([
    'vkodex-native-start-v2', f.ownerEpoch, f.taskId, clientId])).digest('hex');
  const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const original = structuredClone(f.authority);
  store.reserve(operationId, clientId, { envelope,
    command: { operationId, method: 'turn/start',
      params: prepareNativeFollowerStart(original.snapshot, envelope) },
    admission: original as unknown as IpcObject, uiParams: null, localMetadata: null });
  assert.equal(f.host.commandStatus(f.controlKey, operationId), null);
  store.close(); // A crash/recreation after intent commit, before operation-journal reservation.
  store = new NativeStartIntentStore(options);
  Object.assign(f.authority, { authorityRevision: 2,
    snapshot: { ...f.authority.snapshot, latestModel: 'changed-model' } });
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store });
  try {
    await assert.rejects(handler.handle(f.request, new AbortController().signal));
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    assert.equal(f.host.commandStatus(f.controlKey, operationId), null);
    assert.deepEqual(store.get(operationId)?.intent.admission, original);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('intent persistence capacity failure prevents operation reservation and worker write', async () => {
  const f = await fixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-intent-fail-'));
  const store = new NativeStartIntentStore({ filePath: path.join(directory, 'intent.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId,
    encryptionKey: randomBytes(32), maxBytes: 128 });
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store });
  try {
    await assert.rejects(handler.handle(f.request, new AbortController().signal));
    assert.equal(store.list().length, 0);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('native IPC receives exact worker result only after durable dispatch; duplicate does not run twice', async () => {
  const f = await fixture(), broker = new Broker();
  const peer = new DesktopIpcClient(() => broker, 2000, f.handler);
  try {
    await peer.connect(); broker.send({ type: 'request', ...f.request });
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    assert.equal(broker.frames.some(frame => frame.requestId === 'send-1'), false);
    const actual = { turn: { id: 'native-real-turn', status: 'inProgress', items: [] }, upstreamOnly: { version: 7 } };
    f.child.reply(wire.id, actual);
    const received = await waitFrame(broker.frames, frame => frame.requestId === 'send-1');
    assert.equal(received.resultType, 'success'); assert.deepEqual(received.result, { result: actual });
    broker.send({ type: 'request', ...f.request, requestId: 'send-2' });
    assert.deepEqual((await waitFrame(broker.frames, frame => frame.requestId === 'send-2')).result, { result: actual });
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { peer.close(); await f.host.stop('test-cleanup'); }
});

test('native disconnect suppresses response delivery but preserves accepted worker outcome for reconnect', async () => {
  const f = await fixture(); const signal = new AbortController();
  try {
    const running = f.handler.handle(f.request, signal.signal);
    const failedDelivery = assert.rejects(running, /delivery disconnected/);
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    signal.abort(); f.child.reply(wire.id, { turn: { id: 'surviving-turn', items: [] } });
    await failedDelivery;
    assert.equal(f.child.stdin.writableEnded, false);
    const rejoined = await f.handler.handle({ ...f.request, requestId: 'rejoined' }, new AbortController().signal);
    assert.deepEqual(rejoined, { result: { turn: { id: 'surviving-turn', items: [] } } });
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.host.stop('test-cleanup'); }
});

test('opt-in first Composer fence runs before reservation and again for the exact dispatching operation', async () => {
  const f = await fixture();
  const { request } = continuationFixture(f);
  (f.authority.composer!.snapshot.turns as unknown[]).length = 0;
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-first-fence-'));
  const store = new NativeStartIntentStore({ filePath: path.join(directory, 'intent.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId,
    encryptionKey: randomBytes(32) });
  const phases: string[] = [];
  const host = {
    get metadata() { return f.host.metadata; },
    commandStatusForIntent: f.host.commandStatusForIntent.bind(f.host),
    executeCommandWithResponse: (...args: Parameters<typeof f.host.executeCommandWithResponse>) => {
      assert.deepEqual(phases, ['before-reservation']);
      return f.host.executeCommandWithResponse(...args);
    },
  };
  const handler = new ManagedWorkerNativeStartHandler({ host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store,
    qualifyFirstTurn: (_request, _authority, command, phase) => {
      phases.push(phase);
      const operation = f.host.commandStatusForIntent(f.controlKey, command);
      assert.equal(operation?.state ?? null, phase === 'before-reservation' ? null : 'dispatching');
    } });
  try {
    const running = handler.handle(request, new AbortController().signal);
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    f.child.reply(wire.id, { turn: { id: 'fenced-first-turn', status: 'inProgress' } });
    await running;
    assert.deepEqual(phases, ['before-reservation', 'before-write']);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('opt-in first Composer fence refusal at actual write never reaches backend', async () => {
  const f = await fixture();
  const { request } = continuationFixture(f);
  (f.authority.composer!.snapshot.turns as unknown[]).length = 0;
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-first-fence-refuse-'));
  const store = new NativeStartIntentStore({ filePath: path.join(directory, 'intent.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId,
    encryptionKey: randomBytes(32) });
  const phases: string[] = [];
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store,
    qualifyFirstTurn: (_request, _authority, _command, phase) => {
      phases.push(phase);
      if (phase === 'before-write') throw new Error('fence-changed');
    } });
  try {
    await assert.rejects(handler.handle(request, new AbortController().signal));
    assert.deepEqual(phases, ['before-reservation', 'before-write']);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('opt-in first Composer fence never falls back to ordinary or continuation starts', async () => {
  const f = await fixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-first-fence-no-fallback-'));
  const store = new NativeStartIntentStore({ filePath: path.join(directory, 'intent.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId,
    encryptionKey: randomBytes(32) });
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: store, qualifyFirstTurn: () => {} });
  try {
    await assert.rejects(handler.handle(f.request, new AbortController().signal));
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    const continued = continuationFixture(f).request;
    await assert.rejects(handler.handle(continued, new AbortController().signal));
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    assert.equal(store.list().length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('unqualified native scope, lease, context and version cannot dispatch', async () => {
  const f = await fixture();
  try {
    for (const patch of [{ version: 1 }, { hostId: 'other' }, { sourceClientId: 'untrusted' },
      { params: { ...f.request.params, conversationId: 'other' } }]) {
      const request = { ...f.request, ...patch };
      assert.equal(f.handler.canHandle(request), false);
      await assert.rejects(f.handler.handle(request, new AbortController().signal));
    }
    const bad = structuredClone(f.request);
    (bad.params.turnStart as IpcObject).context = { inheritThreadSettings: true, hiddenIntent: null };
    await assert.rejects(f.handler.handle(bad, new AbortController().signal));
    f.state.authorized = false;
    await assert.rejects(f.handler.handle(f.request, new AbortController().signal));
    assert.equal(f.child.frames.some(frame => frame.method === 'turn/start'), false);
  } finally { await f.host.stop('test-cleanup'); }
});

test('timeout does not manufacture native turn receipt; changed retransmission never dispatches', async () => {
  const f = await fixture(50);
  try {
    await assert.rejects(f.handler.handle(f.request, new AbortController().signal), /receipt unavailable/);
    const changed = structuredClone(f.request);
    ((changed.params.turnStart as IpcObject).request as IpcObject).input = [{ type: 'text', text: 'different intent' }];
    await assert.rejects(f.handler.handle(changed, new AbortController().signal));
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.child.stdin.writableEnded, false);
  } finally { await f.host.stop('test-cleanup'); }
});

test('revoking native admission in the asynchronous write gap cannot start a turn', async () => {
  const f = await fixture();
  try {
    const pending = f.handler.handle(f.request, new AbortController().signal);
    f.state.authorized = false;
    await assert.rejects(pending);
    assert.equal(f.child.frames.some(frame => frame.method === 'turn/start'), false);
    assert.equal(f.child.stdin.writableEnded, false);
  } finally { await f.host.stop('test-cleanup'); }
});

test('qualified V3 Composer continuation dispatches only after exact live evidence', async () => {
  const f = await fixture(), { request, evidence } = continuationFixture(f);
  let qualified = 0;
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority,
    authorizeFollower: () => true, intentStore: new NativeStartIntentStore({
      filePath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-continuation-')), 'intent.sqlite'),
      ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) }),
    qualifyContinuation: async captured => { qualified++; assert.equal(captured.semanticRevision, 7); return evidence; } });
  try {
    const running = handler.handle(request, new AbortController().signal);
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    assert.equal(qualified, 1); assert.equal((((wire.params as IpcObject).collaborationMode as IpcObject).settings as IpcObject).model, 'gpt-5.6-sol');
    f.child.reply(wire.id, { turn: { id: 'continuation-turn', status: 'inProgress' } });
    assert.deepEqual(await running, { result: { turn: { id: 'continuation-turn', status: 'inProgress' } } });
  } finally { handler.close(); await f.host.stop('test-cleanup'); }
});

test('continuation qualification drift prevents intent persistence and worker write', async () => {
  const f = await fixture(), { request, evidence } = continuationFixture(f);
  const store = new NativeStartIntentStore({ filePath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-continuation-drift-')), 'intent.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority, authorizeFollower: () => true,
    intentStore: store, qualifyContinuation: async () => { Object.assign(f.authority, { semanticRevision: 8 }); return evidence; } });
  try {
    await assert.rejects(handler.handle(request, new AbortController().signal));
    assert.equal(store.list().length, 0); assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('concurrent new continuation qualification is refused rather than queued', async () => {
  const f = await fixture(), { request, evidence } = continuationFixture(f);
  const store = new NativeStartIntentStore({ filePath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-continuation-race-')), 'intent.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority, authorizeFollower: () => true,
    intentStore: store, qualifyContinuation: async () => { await gate; return evidence; } });
  try {
    const first = handler.handle(request, new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    const second = structuredClone(request);
    ((second.params.turnStart as IpcObject).request as IpcObject).clientUserMessageId = randomUUID();
    await assert.rejects(handler.handle(second, new AbortController().signal));
    assert.equal(store.list().length, 0); assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    release!(); const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    f.child.reply(wire.id, { turn: { id: 'race-first', status: 'inProgress' } }); await first;
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('accepted continuation duplicate returns its receipt after authority drift without requalification', async () => {
  const f = await fixture(), { request, evidence } = continuationFixture(f);
  const store = new NativeStartIntentStore({ filePath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-continuation-duplicate-')), 'intent.sqlite'),
    ownerEpoch: f.ownerEpoch, backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) });
  let qualified = 0;
  const handler = new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority, authorizeFollower: () => true,
    intentStore: store, qualifyContinuation: async () => { qualified++; return evidence; } });
  try {
    const running = handler.handle(request, new AbortController().signal);
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    const actual = { turn: { id: 'continuation-accepted', status: 'inProgress' } };
    f.child.reply(wire.id, actual); assert.deepEqual(await running, { result: actual });
    Object.assign(f.authority, { semanticRevision: 8, authorityRevision: 2 });
    assert.deepEqual(await handler.handle({ ...request, requestId: 'continuation-rejoin' }, new AbortController().signal),
      { result: actual });
    assert.equal(qualified, 1); assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});

test('continuation intent-only reservation refuses changed original semantic admission', async () => {
  const f = await fixture(50), { request, evidence } = continuationFixture(f);
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-continuation-intent-only-'));
  const options = { filePath: path.join(directory, 'intent.sqlite'), ownerEpoch: f.ownerEpoch,
    backendGeneration: 1, threadId: f.taskId, encryptionKey: randomBytes(32) };
  let store = new NativeStartIntentStore(options);
  const make = () => new ManagedWorkerNativeStartHandler({ host: f.host, controlKey: f.controlKey,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, authority: () => f.authority, authorizeFollower: () => true,
    intentStore: store, qualifyContinuation: async () => evidence });
  let handler = make();
  try {
    await assert.rejects(handler.handle(request, new AbortController().signal), /receipt unavailable/);
    assert.equal(store.list().length, 1);
    handler.close(); store.close(); store = new NativeStartIntentStore(options); handler = make();
    Object.assign(f.authority, { semanticRevision: 8 });
    await assert.rejects(handler.handle({ ...request, requestId: 'continuation-intent-rejoin' }, new AbortController().signal));
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { handler.close(); store.close(); await f.host.stop('test-cleanup'); }
});
