import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedWorkerFrontendHost } from '../src/codex/managed-worker-frontend-host.js';
import { NativeStartIntentStore } from '../src/codex/native-start-intent-store.js';
import type { AppServerServerRequest } from '../src/codex/app-server-connection.js';
import { DesktopIpcClient, encodeFrame, FrameDecoder } from '../src/desktop/ipc-client.js';
import type { IpcObject } from '../src/desktop/ipc-client.js';
import { ManagedWorkerNativeOwner } from '../src/desktop/managed-worker-native-owner.js';
import type { ManagedNativeStockQueueContext, ManagedWorkerNativeOwnerOptions } from '../src/desktop/managed-worker-native-owner.js';
import { ManagedNativeStockQueueAdapter } from '../src/desktop/managed-native-stock-queue-adapter.js';
import type { NativeProjectionState } from '../src/codex/managed-native-projection.js';
import type { ContinuationOwnerFence, QualifiedContinuationEvidence } from '../src/desktop/managed-worker-bootstrap.js';

const taskId = 'own-native-task';
function state(): NativeProjectionState {
  return { id: taskId, hostId: 'local', turns: [], requests: [],
    turnsPagination: { hasLoadedOldest: true, olderCursor: null },
    currentPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalsReviewer: 'user', runtimeWorkspaceRoots: [] },
    latestThreadSettings: { serviceTier: null }, latestModel: 'fixture-model', latestReasoningEffort: 'low',
    cwd: 'C:/own', latestCollaborationMode: { mode: 'default',
      settings: { model: '', reasoning_effort: null, developer_instructions: null } },
    previousTurnModel: null, title: 'Own', threadRuntimeStatus: { type: 'idle' },
    latestTokenUsageInfo: null, hasUnreadTurn: false, updatedAt: 1 };
}

test('native CLI auto-start absence requires a live, current, isolated idle owner', async () => {
  let current = true;
  const f = await fixture(async () => state(), undefined, undefined, false,
    undefined, () => current);
  try {
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    await f.owner.start();
    assert.equal(f.owner.noPendingNativeCliAutoStart(), true);
    current = false;
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    current = true;
    f.child.send('thread/status/changed', { threadId: taskId, status: { type: 'active' } });
    await waitUntil(() => f.owner.metadata.revision > 1);
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
  assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
});

test('native CLI auto-start absence refuses stock queue and continuation capability', async () => {
  for (const mode of ['stock', 'continuation'] as const) {
    const f = await fixture(async () => mode === 'stock' ? state() : continuationState(),
      undefined, undefined, mode === 'continuation',
      mode === 'continuation' ? async fence => continuationEvidence(fence) : undefined,
      () => true, mode === 'stock');
    try {
      await f.owner.start();
      assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    } finally { f.owner.close(); await f.host.stop('test-cleanup'); f.intentStore?.close(); }
  }
});

test('native CLI auto-start absence refuses pending host requests and commands', async () => {
  const f = await fixture();
  const requests = f.host.requestQuiescence.bind(f.host);
  const commands = f.host.commandQuiescence.bind(f.host);
  const receipts = f.host.acceptedCommandReceipts.bind(f.host);
  const queued = f.host.acceptedQueueInputs.bind(f.host);
  try {
    await f.owner.start();
    assert.equal(f.owner.noPendingNativeCliAutoStart(), true);
    f.host.requestQuiescence = key => ({ ...requests(key), unresolved: 1 });
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    f.host.requestQuiescence = requests;
    f.host.commandQuiescence = key => ({ ...commands(key), inFlight: 1 });
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    f.host.commandQuiescence = commands;
    assert.equal(f.owner.noPendingNativeCliAutoStart(), true);
    f.host.acceptedCommandReceipts = () => [{ method: 'turn/start', receiptId: 'accepted' }];
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    f.host.acceptedCommandReceipts = receipts;
    f.host.acceptedQueueInputs = () => [{ clientUserMessageId: 'queued', submissionId: 'accepted' }];
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
  } finally {
    f.host.requestQuiescence = requests; f.host.commandQuiescence = commands;
    f.host.acceptedCommandReceipts = receipts; f.host.acceptedQueueInputs = queued;
    f.owner.close(); await f.host.stop('test-cleanup');
  }
});

test('native CLI auto-start absence accepts only turn receipts proven terminal in current history', async () => {
  const f = await fixture(async () => continuationState());
  const receipts = f.host.acceptedCommandReceipts.bind(f.host);
  try {
    await f.owner.start();
    f.host.acceptedCommandReceipts = () => [{ method: 'turn/start', receiptId: 'completed-old' }];
    assert.equal(f.owner.noPendingNativeCliAutoStart(), true);
    f.host.acceptedCommandReceipts = () => [{ method: 'turn/start', receiptId: 'missing-turn' }];
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    f.host.acceptedCommandReceipts = () => [{ method: 'thread/queue/add', receiptId: 'completed-old' }];
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'busy-turn', status: 'inProgress', items: [] } });
    await waitUntil(() => f.owner.metadata.revision > 1);
    f.host.acceptedCommandReceipts = () => [{ method: 'turn/start', receiptId: 'busy-turn' }];
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
  } finally {
    f.host.acceptedCommandReceipts = receipts;
    f.owner.close(); await f.host.stop('test-cleanup');
  }
});

test('native CLI auto-start absence refuses a nonterminal projected turn', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'busy-turn', status: 'inProgress', items: [] } });
    await waitUntil(() => f.owner.metadata.revision > 1);
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('native CLI auto-start absence refuses projected requests', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    assert.equal(f.owner.noPendingNativeCliAutoStart(), true);
    f.child.stdout.write(`${JSON.stringify({ id: 71, method: 'item/tool/requestUserInput',
      params: { threadId: taskId, turnId: 'unobserved-turn', itemId: 'question', questions: [] } })}\n`);
    await waitUntil(() => f.owner.metadata.revision > 1);
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('managed bridge observation snapshots one native generation and fails closed on owner retirement', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.owner.subscribeBridgeState(() => {}, () => {}));
    await f.owner.start();
    const events: Array<{ seq: number; generation: number; state: NativeProjectionState }> = [];
    const failures: string[] = [];
    const observed = f.owner.subscribeBridgeState(event => events.push(event), reason => failures.push(reason));
    assert.equal(observed.initial.seq, 1);
    assert.equal(observed.initial.generation, f.host.metadata.backendGeneration);
    assert.equal(observed.initial.state.id, taskId);
    assert.equal(observed.current(), true);
    assert.equal(Object.isFrozen(observed.initial.state), true);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'managed-observed-turn', status: 'inProgress', startedAt: 1780000000, items: [] } });
    await waitUntil(() => events.length === 1);
    assert.equal(events[0]?.seq, 2);
    assert.equal(events[0]?.generation, observed.initial.generation);
    assert.equal(events[0]?.state.turns[0]?.turnId, 'managed-observed-turn');
    assert.equal(observed.initial.state.turns.length, 0);
    observed.detach();
    f.child.send('turn/completed', { threadId: taskId,
      turn: { id: 'managed-observed-turn', status: 'completed', startedAt: 1780000000,
        completedAt: 1780000001, items: [] } });
    await waitUntil(() => f.owner.metadata.revision > 2);
    assert.equal(events.length, 1);
    f.owner.close();
    assert.equal(observed.current(), false);
    assert.deepEqual(failures, []);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('native goal changes fence stale Composer state without retiring the turn observer', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    const events: Array<{ state: NativeProjectionState }> = [];
    const failures: string[] = [];
    const observed = f.owner.subscribeBridgeState(event => events.push(event), reason => failures.push(reason));
    const before = f.owner.metadata.semanticRevision;
    f.child.send('thread/goal/updated', { threadId: taskId, goal: { objective: 'inspect', status: 'active' } });
    await waitUntil(() => events.length === 1);
    assert.ok(f.owner.metadata.semanticRevision > before);
    assert.equal(events[0]!.state.goalSignalRevision, 1);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'goal-followup', status: 'inProgress', items: [] } });
    await waitUntil(() => events.length === 2);
    assert.equal(events[1]!.state.turns[0]!.turnId, 'goal-followup');
    assert.equal(observed.current(), true);
    assert.deepEqual(failures, []);
    observed.detach();
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('managed owner retains only a bounded category for native IPC refusal diagnosis', async () => {
  const f = await fixture();
  try {
    const initialFailure = f.owner.metadata.lastRequestFailure;
    assert.equal(initialFailure, undefined);
    const before = Date.now();
    f.owner.onRequestFailure('settings-refused');
    f.owner.onRequestFailure('unclassified');
    assert.equal(f.owner.metadata.lastRequestFailure?.category, 'unclassified');
    assert.equal(f.owner.metadata.lastRequestFailure?.count, 2);
    assert.ok((f.owner.metadata.lastRequestFailure?.atMs ?? 0) >= before);
    assert.ok((f.owner.metadata.lastRequestFailure?.atMs ?? Infinity) <= Date.now());
    for (let i = 0; i < 300; i++) f.owner.onRequestFailure('owner-refused');
    assert.equal(f.owner.metadata.lastRequestFailure?.category, 'owner-refused');
    assert.equal(f.owner.metadata.lastRequestFailure?.count, 255);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('managed bridge observation continues through frontend EOF without reopening the backend', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    const events: Array<{ seq: number; state: NativeProjectionState }> = [];
    const observed = f.owner.subscribeBridgeState(event => events.push(event), () => {});
    const initializations = f.child.frames.filter(frame => frame.method === 'initialize').length;
    f.broker.destroy();
    await waitUntil(() => f.owner.metadata.state === 'disconnected');
    assert.equal(observed.current(), true);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'offline-bridge-turn', status: 'inProgress', startedAt: 1780000000, items: [] } });
    await waitUntil(() => events.length === 1);
    assert.equal(events[0]?.seq, observed.initial.seq + 1);
    assert.equal(events[0]?.state.turns[0]?.turnId, 'offline-bridge-turn');
    assert.equal(f.child.frames.filter(frame => frame.method === 'initialize').length, initializations);
    observed.detach();
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('managed bridge observation reports projection failure without stopping backend', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    const failures: string[] = [];
    const observed = f.owner.subscribeBridgeState(() => {}, reason => failures.push(reason));
    f.child.send('turn/started', { threadId: taskId, turn: { status: 'inProgress', items: [] } });
    await waitUntil(() => failures.length === 1);
    assert.deepEqual(failures, ['projection-failed']);
    assert.equal(observed.current(), false);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});
function stockQualification(ownerEpoch: string) {
  const cwd = 'C:/own';
  const requested = { mode: 'default', settings: { model: 'fixture-model',
    reasoning_effort: 'medium', developer_instructions: null } };
  const settings = { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never',
    approvalsReviewer: 'user', permissions: ':danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' }, model: 'fixture-model', serviceTier: null,
    effort: 'medium', summary: null, personality: 'pragmatic', collaborationMode: {
      mode: 'default', settings: { model: 'fixture-model', reasoning_effort: 'medium',
        developer_instructions: 'synthetic built-in' } } };
  return { taskId, ownerEpoch, confirmed: true as const,
    completeQueueAndHistory: true, exclusiveLifecycleWriter: true, ambientContextEmpty: true,
    effectiveSettings: settings, initializationReceipt: { taskId, ownerEpoch, confirmed: true,
      expansionKind: 'builtin-default-instructions', requestedCollaborationMode: requested,
      confirmedEffectiveCollaborationMode: settings.collaborationMode,
      requestedSettings: { ...settings, sandboxPolicy: null, serviceTier: 'default',
        collaborationMode: requested }, confirmedEffectiveSettings: settings },
    tierResolution: { taskId, ownerEpoch, requested: 'default', effective: null,
      fastModeAllowed: false, confirmed: true } };
}
function stockEntry(id = randomUUID()) {
  const text = 'PUBLIC_OK', cwd = 'C:/own';
  const requested = { mode: 'default', settings: { model: 'fixture-model',
    reasoning_effort: 'medium', developer_instructions: null } };
  return { id, text, cwd, createdAt: 1780000000000,
    context: { prompt: text, turnTrigger: 'composer', workspaceRoots: [cwd],
      usedDictation: false, existingWorkspaceRoot: null, localProjectId: null,
      fileAttachments: [], addedFiles: [] },
    responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    submissionOptions: { executionHostId: 'local', agentMode: 'full-access',
      permissionProfileId: ':danger-full-access', serviceTier: 'default',
      shouldSendPermissionOverrides: false, usePermissionSelection: false,
      permissionSelection: null, collaborationMode: requested,
      clientUserMessageId: 'separate-native-option-id' },
    writingBlockAdditionalContext: null, mentionedBrowserFamilies: [], submissionIntent: 'send-now',
    submission: { hostId: 'local', status: 'pending', queueModeOverride: 'queue' } };
}
class Child extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly frames: IpcObject[] = []; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  onFrame: ((frame: IpcObject) => void) | null = null;
  pid = undefined;
  constructor() { super(); let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => { buffer += chunk.toString();
      while (buffer.includes('\n')) { const at = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, at)) as IpcObject;
        buffer = buffer.slice(at + 1); this.frames.push(frame); this.onFrame?.(frame);
        if (frame.method === 'initialize') queueMicrotask(() => this.reply(frame.id,
          { serverInfo: { name: 'fixture' } })); } });
  }
  reply(id: unknown, result: IpcObject): void { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
  send(method: string, params: IpcObject): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
  kill(): boolean { this.emit('close', 0, null); return true; }
}
class Broker extends Duplex {
  readonly frames: IpcObject[] = []; readonly decoder = new FrameDecoder();
  followWithInitialize = false;
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    for (const frame of this.decoder.push(chunk)) { this.frames.push(frame);
      if (frame.method === 'initialize') queueMicrotask(() => {
        const reply = { type: 'response', requestId: frame.requestId,
          resultType: 'success', result: { clientId: 'owner-peer' } };
        if (this.followWithInitialize) {
          const follow = { type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
            sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } };
          const foreign = { ...follow, params: { ...follow.params, conversationId: 'foreign-task' } };
          this.push(Buffer.concat([encodeFrame(reply),
            ...Array.from({ length: 129 }, () => encodeFrame(foreign)), encodeFrame(follow)]));
        } else this.send(reply);
      }); }
    done();
  }
  send(frame: IpcObject): void { this.push(encodeFrame(frame)); }
}
async function waitFrame(frames: IpcObject[], predicate: (frame: IpcObject) => boolean): Promise<IpcObject> {
  const end = Date.now() + 1000;
  for (;;) { const found = frames.find(predicate); if (found) return found;
    if (Date.now() > end) throw new Error('fixture-frame-timeout');
    await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('fixture-condition-timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(readInitialState: () => Promise<NativeProjectionState> = async () => state(),
  allowAnswer: (request: AppServerServerRequest, response: IpcObject) => boolean = () => false,
  allowFollower: (id: string) => boolean = id => id === 'follower', composer = false,
  qualifyContinuation?: (fence: () => ContinuationOwnerFence) => Promise<QualifiedContinuationEvidence>,
  isOwnerCurrent: () => boolean = () => true,
  stock = false,
  stockHooks: { confirmOwner?: (qualified: boolean) => boolean | Promise<boolean>;
    baseline?: () => boolean | Promise<boolean> } = {},
  qualifyFirstTurn?: NonNullable<ManagedWorkerNativeOwnerOptions['qualifyFirstTurn']>) {
  const child = new Child(), adapterKey = {}, controlKey = {}, ownerEpoch = randomUUID();
  const host = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: { clientInfo: { name: 'fixture' }, capabilities: {} },
    bootstrapReadMethods: [], adapterKey, allowRequest: () => true, allowAnswer,
    launch: () => child as unknown as ChildProcessWithoutNullStreams,
    commandPolicy: { controlKey, ownerEpoch, fingerprintKey: randomBytes(32),
      journalPath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-owner-')), 'ops.sqlite'),
      isOwnerCurrent: () => true, authorize: ({ method, params }) =>
        stock && method === 'thread/queue/add' || params.model === 'fixture-model' ||
        composer && params.model === null && params.permissions === ':read-only' } });
  await host.start();
  const generation = host.metadata.backendGeneration;
  assert.ok(generation);
  const intentStore = composer ? new NativeStartIntentStore({
    filePath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-composer-intent-')), 'intent.sqlite'),
    ownerEpoch, backendGeneration: generation, threadId: taskId,
    encryptionKey: randomBytes(32) }) : null;
  let broker = new Broker(); const brokers = [broker];
  const owner = new ManagedWorkerNativeOwner({ host, adapterKey, controlKey, taskId, ownerEpoch,
    isOwnerCurrent, allowFollower, readInitialState,
    ...(stock ? { queueAdapterFactory: ({ publish, onStockQueueChanged, onFailure,
      captureAuthority, assertCurrent, host: queueHost, controlKey: queueControl,
      taskId: queueTask, ownerEpoch: queueEpoch, backendGeneration }: ManagedNativeStockQueueContext) => {
      let ticket: ReturnType<typeof captureAuthority> | null = null;
      let ticketEntryId: string | null = null;
      assert.equal(queueHost, host); assert.equal(queueControl, controlKey);
      assert.equal(queueTask, taskId); assert.equal(queueEpoch, ownerEpoch);
      assert.equal(backendGeneration, generation);
      return new ManagedNativeStockQueueAdapter({ taskId, ownerEpoch, backendGeneration: generation,
        sourceGeneration: String(generation), controlKey, host,
        journalPath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-owner-stock-')), 'native.sqlite'),
        assertInitialNativeQueueBaseline: () => stockHooks.baseline?.() ?? true,
        qualify: ({ entry }) => {
          if (entry && entry.id !== ticketEntryId) { ticket = captureAuthority(); ticketEntryId = entry.id; }
          return stockQualification(ownerEpoch);
        },
        confirmOwner: () => stockHooks.confirmOwner?.(ticket !== null) ?? true,
        assertOwnerCurrent: () => isOwnerCurrent(),
        assertDispatchCurrent: () => ticket !== null && assertCurrent(ticket),
        publish, onStockQueueChanged, onFailure });
    } } : {}),
    ...(intentStore ? { intentStore, composerDefaults: () => ({ taskId, cwd: 'C:/own' }) } : {}),
    ...(qualifyContinuation ? { qualifyContinuation } : {}),
    ...(qualifyFirstTurn ? { qualifyFirstTurn } : {}),
    clientFactory: handler => new DesktopIpcClient(() => {
      if (broker.destroyed) { broker = new Broker(); brokers.push(broker); }
      return broker;
    }, 1000, handler) });
  return { child, host, get broker() { return broker; }, brokers, owner, intentStore, adapterKey,
    controlKey, ownerEpoch };
}

function composerState(): NativeProjectionState {
  const base = state();
  const profile = { id: ':read-only' };
  const sandbox = { type: 'readOnly', networkAccess: false };
  const mode = { mode: 'default', settings: {
    model: 'fixture-model', reasoning_effort: 'low', developer_instructions: null } };
  return { ...base, resumeState: 'resumed', workspaceKind: 'projectless', environments: [],
    latestCollaborationMode: mode,
    latestThreadSettings: { cwd: 'C:/own', model: 'fixture-model', effort: 'low', serviceTier: null,
      summary: null, personality: 'pragmatic', activePermissionProfile: profile, sandboxPolicy: sandbox },
    currentPermissions: { activePermissionProfile: profile, sandboxPolicy: sandbox,
      approvalPolicy: 'never', approvalsReviewer: 'user', runtimeWorkspaceRoots: ['C:/own'] } };
}

function firstComposerRequest(clientId: string, requestId = 'fenced-first'): IpcObject {
  return { type: 'request', requestId, sourceClientId: 'follower', hostId: 'local',
    targetClientId: 'owner-peer', method: 'thread-follower-start-turn', version: 2,
    params: { conversationId: taskId, turnStart: {
      request: { threadId: taskId, clientUserMessageId: clientId,
        input: [{ type: 'text', text: 'one', text_elements: [] }],
        cwd: 'C:/own', model: null, effort: null, serviceTier: null,
        collaborationMode: composerState().latestCollaborationMode,
        permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        turnTrigger: 'composer', multiAgentMode: 'explicitRequestOnly',
        responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' } },
      context: { inheritThreadSettings: true, writingBlockContextPrepared: true,
        localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [],
        responseItems: [], useAppServerPermissionDefault: false, usePermissionSelection: false } } } };
}

function continuationState(): NativeProjectionState {
  const base = composerState();
  const mode = { mode: 'default', settings: {
    model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } };
  return { ...base, latestModel: 'gpt-5.6-sol', latestCollaborationMode: mode,
    latestThreadSettings: { ...base.latestThreadSettings, model: 'gpt-5.6-sol',
      approvalPolicy: 'on-request', approvalsReviewer: 'user' },
    environments: [{ environmentId: 'local', cwd: 'C:/own', runtimeWorkspaceRoots: ['C:/own'] }],
    turns: [{ turnId: 'completed-old', status: 'completed', items: [],
      params: { input: [], clientUserMessageId: null }, turnStartedAtMs: 1,
      finalAssistantStartedAtMs: 2, durationMs: null, error: null } as NativeProjectionState['turns'][number]],
    nativeQueue: [], queuedFollowUps: [] };
}

function continuationEvidence(fence: () => ContinuationOwnerFence): QualifiedContinuationEvidence {
  return { owner: fence(), turnCount: 1, latestTurnId: 'completed-old',
    terminalTurnIds: ['completed-old'], historyDigest: 'a'.repeat(64),
    effective: { model: 'gpt-5.6-sol', effort: 'low', cwd: 'C:/own',
      activePermissionProfileId: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandboxType: 'readOnly', networkAccess: false, serviceTier: null,
      runtimeWorkspaceRoots: ['C:/own'], environments: continuationState().environments as IpcObject[] },
    composerDefaults: { taskId, cwd: 'C:/own', summary: null, personality: 'pragmatic' } };
}

function continuationRequest(clientId: string, requestId: string): IpcObject {
  return { type: 'request', requestId, sourceClientId: 'follower', hostId: 'local',
    targetClientId: 'owner-peer', method: 'thread-follower-start-turn', version: 2,
    params: { conversationId: taskId, turnStart: {
      request: { threadId: taskId, clientUserMessageId: clientId,
        input: [{ type: 'text', text: 'test', text_elements: [] }], cwd: 'C:/own', model: null,
        effort: null, serviceTier: null, collaborationMode: continuationState().latestCollaborationMode,
        permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        turnTrigger: 'composer', multiAgentMode: 'explicitRequestOnly',
        responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' } },
      context: { inheritThreadSettings: true, writingBlockContextPrepared: true,
        localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [],
        responseItems: [], useAppServerPermissionDefault: false, usePermissionSelection: false } } } };
}

function snapshotTurn(frame: IpcObject): IpcObject | null {
  if (frame.method !== 'thread-stream-state-changed') return null;
  const params = frame.params as IpcObject;
  const change = params?.change as IpcObject;
  const state = change?.conversationState as IpcObject;
  return ((state?.turns as IpcObject[] | undefined) ?? [])[0] ?? null;
}
function followQueue(broker: Broker, source = 'follower', following = true): void {
  broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
    sourceClientId: source, params: { hostId: 'local', conversationId: taskId, following } });
}
function submitQueue(broker: Broker, entry = stockEntry(), requestId = 'queue-one',
  source = 'follower'): void {
  broker.send({ type: 'request', requestId, sourceClientId: source, hostId: 'local',
    method: 'thread-follower-set-queued-follow-ups-state', version: 1,
    params: { hostId: 'local', conversationId: taskId, state: { [taskId]: [entry] } } });
}

test('cold retirement proof permits readonly follow but never an admitted native mutation', async () => {
  for (const stock of [false, true]) {
    const f = await fixture(async () => state(), () => false, () => true,
      false, undefined, () => true, stock);
    try {
      assert.equal(f.owner.retiredWithoutNativeIngress(), false);
      await f.owner.start();
      followQueue(f.broker);
      await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
      if (stock) await waitFrame(f.broker.frames,
        frame => frame.method === 'thread-queued-followups-changed');
      f.owner.close();
      assert.equal(f.owner.retiredWithoutNativeIngress(), true);
      f.owner.close();
      assert.equal(f.owner.retiredWithoutNativeIngress(), true);
    } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
  }
});

test('opt-in native queue v1 durably adds on the same worker before acknowledgement', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true);
  try {
    assert.equal(f.owner.queueQuiescence(), null);
    f.child.onFrame = frame => {
      if (frame.method === 'thread/queue/add') queueMicrotask(() => f.child.reply(frame.id,
        { queuedSubmission: { id: 'stock-receipt',
          clientUserMessageId: (frame.params as IpcObject).clientUserMessageId,
          input: (frame.params as IpcObject).input } }));
    };
    await f.owner.start();
    assert.deepEqual(f.owner.queueQuiescence(), { taskVersion: 0, unresolved: 0, unconsumed: 0 });
    followQueue(f.broker);
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    const entry = stockEntry();
    submitQueue(f.broker, entry);
    const reply = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'queue-one');
    assert.equal(reply.resultType, 'success');
    assert.deepEqual(reply.result, { ok: true });
    assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length, 1);
    assert.equal(f.owner.queueQuiescence()?.unconsumed, 1);
    f.broker.send(continuationRequest(randomUUID(), 'stock-direct-bypass'));
    const denied = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'stock-direct-bypass');
    assert.equal(denied.resultType, 'error');
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { f.owner.close(); assert.equal(f.owner.retiredWithoutNativeIngress(), false);
    assert.equal(f.owner.queueQuiescence(), null);
    await f.host.stop('test-cleanup'); }
});

test('stock queue backend event during qualification invalidates the pending actual write', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let block = false;
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true,
    { confirmOwner: async qualified => { if (block && qualified) { entered(); await waiting; } return true; } });
  try {
    await f.owner.start(); followQueue(f.broker);
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed');
    block = true; submitQueue(f.broker, stockEntry(), 'queue-fenced');
    await started;
    assert.equal(f.owner.metadata.pendingNativeOperations, 1);
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    assert.equal(f.owner.retiredWithoutNativeIngress(), false);
    assert.equal(f.owner.metadata.pendingEvents, 0);
    f.child.send('thread/queue/changed', { threadId: taskId });
    release();
    const reply = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'queue-fenced').catch(error => {
        assert.fail(`queue response absent; owner=${f.owner.metadata.state}; writes=${
          f.child.frames.filter(frame => frame.method === 'thread/queue/add').length}; replies=${
          f.broker.frames.filter(frame => frame.type === 'response').length}: ${String(error)}`);
      });
    assert.equal(reply.resultType, 'error');
    assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length, 0);
    assert.equal(f.owner.metadata.pendingNativeOperations, 0);
    assert.notEqual(f.owner.metadata.state, 'failed');
  } finally { release(); f.owner.close(); assert.equal(f.owner.retiredWithoutNativeIngress(), false);
    await f.host.stop('test-cleanup'); }
});

test('queue ingress survives EOF, while explicit unfollow or re-follow revokes its lease', async () => {
  for (const disposition of ['eof', 'unfollow', 'refollow', 'eof-refollow'] as const) {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let block = false;
    const f = await fixture(async () => state(), () => false, () => true,
      false, undefined, () => true, true,
      { confirmOwner: async qualified => { if (block && qualified) { entered(); await waiting; }
          return true; } });
    try {
      f.child.onFrame = frame => { if (frame.method === 'thread/queue/add')
        queueMicrotask(() => f.child.reply(frame.id, { queuedSubmission: { id: 'r',
          clientUserMessageId: (frame.params as IpcObject).clientUserMessageId,
          input: (frame.params as IpcObject).input } })); };
      await f.owner.start(); followQueue(f.broker);
      await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
      await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed');
      block = true; submitQueue(f.broker, stockEntry(), `queue-${disposition}`);
      await started;
      if (disposition === 'unfollow') followQueue(f.broker, 'follower', false);
      else if (disposition === 'refollow') followQueue(f.broker, 'follower', true);
      else {
        f.broker.destroy(); await new Promise(resolve => setImmediate(resolve));
        if (disposition === 'eof-refollow') {
          await f.owner.reconnect();
          followQueue(f.broker, 'follower', true);
          await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
        }
      }
      release();
      if (disposition === 'unfollow' || disposition === 'refollow') {
        const reply = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
          frame.requestId === `queue-${disposition}`);
        assert.equal(reply.resultType, 'error');
      } else if (disposition === 'eof') await waitFrame(f.child.frames,
        frame => frame.method === 'thread/queue/add');
      else await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length,
        disposition === 'eof' ? 1 : 0);
    } finally { release(); f.owner.close(); await f.host.stop('test-cleanup'); }
  }
});

test('native queue hydrates each follower separately and consumes the authoritative user item', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true);
  try {
    f.child.onFrame = frame => { if (frame.method === 'thread/queue/add')
      queueMicrotask(() => f.child.reply(frame.id, { queuedSubmission: { id: 'stock-r',
        clientUserMessageId: (frame.params as IpcObject).clientUserMessageId,
        input: (frame.params as IpcObject).input } })); };
    await f.owner.start();
    followQueue(f.broker, 'A');
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed' &&
      (frame.targetClientIds as string[])[0] === 'A');
    followQueue(f.broker, 'B');
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed' &&
      (frame.targetClientIds as string[])[0] === 'B');
    const hydrated = f.broker.frames.filter(frame => frame.method === 'thread-queued-followups-changed');
    assert.deepEqual(hydrated.map(frame => frame.targetClientIds), [['A'], ['B']]);
    const entry = stockEntry();
    submitQueue(f.broker, entry, 'queue-consume', 'A');
    const reply = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'queue-consume');
    assert.equal(reply.resultType, 'success');
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed' &&
      (frame.targetClientIds as string[])[0] === 'B' &&
      ((frame.params as IpcObject).messages as unknown[]).length === 1);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'stock-turn', status: 'inProgress', startedAt: 1, items: [
        { id: 'stock-user', type: 'userMessage', clientId: entry.id,
          content: [{ type: 'text', text: entry.text }] }] } });
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed' &&
      (frame.targetClientIds as string[])[0] === 'B' &&
      ((frame.params as IpcObject).messages as unknown[]).length === 0 &&
      f.broker.frames.indexOf(frame) > f.broker.frames.indexOf(reply));
    assert.notEqual(f.owner.metadata.state, 'failed');
    assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length, 1);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('foreign embedded thread cannot consume an owned native queue entry', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true);
  try {
    f.child.onFrame = frame => { if (frame.method === 'thread/queue/add')
      queueMicrotask(() => f.child.reply(frame.id, { queuedSubmission: { id: 'r',
        clientUserMessageId: (frame.params as IpcObject).clientUserMessageId,
        input: (frame.params as IpcObject).input } })); };
    await f.owner.start(); followQueue(f.broker);
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed');
    const entry = stockEntry(); submitQueue(f.broker, entry, 'owned-queue');
    await waitFrame(f.broker.frames, frame => frame.type === 'response' && frame.requestId === 'owned-queue');
    f.child.send('turn/started', { threadId: 'foreign-task',
      turn: { id: 'foreign-turn', status: 'inProgress', items: [
        { id: 'foreign-user', type: 'userMessage', clientId: entry.id,
          content: [{ type: 'text', text: entry.text }] }] } });
    await new Promise(resolve => setTimeout(resolve, 30));
    // Host routing drops foreign thread IDs before this observer. Either way,
    // that event cannot consume our durable queue identity.
    assert.equal(f.owner.metadata.state, 'connected');
    const zeroAfterForeign = f.broker.frames.filter(frame => frame.method ===
      'thread-queued-followups-changed' &&
      ((frame.params as IpcObject).messages as unknown[]).length === 0).length;
    assert.equal(zeroAfterForeign, 1); // Initial targeted hydration only.
    assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length, 1);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('stock owner accepts host-routed thread started without a top-level threadId', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true);
  try {
    await f.owner.start();
    f.child.send('thread/started', { thread: { id: taskId, cwd: 'C:/own' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.owner.metadata.state, 'connected');
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('native queue unknown receipt never ACKs or repeats the same backend add', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true);
  try {
    f.child.onFrame = frame => { if (frame.method === 'thread/queue/add')
      queueMicrotask(() => f.child.reply(frame.id, { queuedSubmission: { id: 'wrong',
        clientUserMessageId: 'wrong-client-id', input: [] } })); };
    await f.owner.start(); followQueue(f.broker);
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed');
    const entry = stockEntry(); submitQueue(f.broker, entry, 'unknown-first');
    const first = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'unknown-first');
    assert.equal(first.resultType, 'error');
    submitQueue(f.broker, entry, 'unknown-repeat');
    const second = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'unknown-repeat');
    assert.equal(second.resultType, 'error');
    assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length, 1);
  } finally { f.owner.close(); assert.equal(f.owner.retiredWithoutNativeIngress(), false);
    await f.host.stop('test-cleanup'); }
});

test('accepted stock receipt still ACKs after a later same-worker notification', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true);
  try {
    f.child.onFrame = frame => { if (frame.method === 'thread/queue/add') {
      queueMicrotask(() => {
        f.child.reply(frame.id, { queuedSubmission: { id: 'stock-r',
          clientUserMessageId: (frame.params as IpcObject).clientUserMessageId,
          input: (frame.params as IpcObject).input } });
        const usage = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
          cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
        f.child.send('thread/tokenUsage/updated', { threadId: taskId, turnId: 'old',
          tokenUsage: { total: usage, last: usage, modelContextWindow: null } });
      });
    } };
    await f.owner.start(); followQueue(f.broker);
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed');
    submitQueue(f.broker, stockEntry(), 'receipt-followed-by-event');
    const reply = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'receipt-followed-by-event');
    assert.equal(reply.resultType, 'success');
    assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length, 1);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('queue-enabled usage-only notification does not advance owner semantic revision', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true);
  try {
    await f.owner.start();
    const semantic = f.owner.metadata.semanticRevision;
    const usage = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    f.child.send('thread/tokenUsage/updated', { threadId: taskId, turnId: 'old',
      tokenUsage: { total: usage, last: usage, modelContextWindow: null } });
    await waitUntil(() => f.owner.metadata.revision > 1);
    assert.equal(f.owner.metadata.semanticRevision, semantic);
    assert.equal(f.owner.metadata.state, 'connected');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('unqualified initial queue baseline retires native owner during hydrate, not backend', async () => {
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true, { baseline: () => false });
  try {
    await f.owner.start(); followQueue(f.broker);
    await waitUntil(() => f.owner.metadata.state === 'failed');
    assert.equal(f.owner.metadata.failure, 'queue-hydration-failed');
    assert.equal(f.host.metadata.state, 'running');
    assert.equal(f.child.frames.filter(frame => frame.method === 'thread/queue/add').length, 0);
    assert.equal(f.owner.retiredWithoutNativeIngress(), false);
  } finally { f.owner.close(); assert.equal(f.owner.retiredWithoutNativeIngress(), false);
    await f.host.stop('test-cleanup'); }
});

test('bounded queue event tail retires only native owner when attribution stalls', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let block = false;
  const f = await fixture(async () => state(), () => false, () => true,
    false, undefined, () => true, true,
    { confirmOwner: async qualified => { if (qualified && block) { entered(); await waiting; }
        return true; } });
  try {
    f.child.onFrame = frame => { if (frame.method === 'thread/queue/add')
      queueMicrotask(() => f.child.reply(frame.id, { queuedSubmission: { id: 'r',
        clientUserMessageId: (frame.params as IpcObject).clientUserMessageId,
        input: (frame.params as IpcObject).input } })); };
    await f.owner.start(); followQueue(f.broker);
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-queued-followups-changed');
    const entry = stockEntry(); submitQueue(f.broker, entry, 'queue-before-flood');
    await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'queue-before-flood');
    block = true;
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'stock-turn', status: 'inProgress', items: [
        { id: 'stock-user', type: 'userMessage', clientId: entry.id,
          content: [{ type: 'text', text: entry.text }] }] } });
    await started;
    assert.ok(f.owner.metadata.pendingEvents > 0);
    assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
    const usage = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    for (let index = 0; index < 129; index++) f.child.send('thread/tokenUsage/updated',
      { threadId: taskId, turnId: 'stock-turn',
        tokenUsage: { total: usage, last: usage, modelContextWindow: null } });
    await waitUntil(() => f.owner.metadata.state === 'failed');
    assert.equal(f.owner.metadata.failure, 'queue-event-overflow');
    assert.equal(f.host.metadata.state, 'running');
    const before = f.broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length;
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length,
      before);
  } finally { release(); f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('semantic fence ignores usage-only changes but advances for turn events and reconnect', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    const initial = f.owner.metadata.semanticRevision;
    assert.ok(Number.isSafeInteger(initial));
    const usage = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    f.child.send('thread/tokenUsage/updated', { threadId: taskId, turnId: 'old',
      tokenUsage: { total: usage, last: usage, modelContextWindow: null } });
    assert.equal(f.owner.metadata.semanticRevision, initial);
    f.child.send('turn/started', { threadId: taskId, turn: { id: 'new', status: 'inProgress', items: [] } });
    assert.equal(f.owner.metadata.semanticRevision, initial + 1);
    f.broker.destroy(); await new Promise(resolve => setImmediate(resolve));
    const disconnected = f.owner.metadata.semanticRevision;
    assert.ok(disconnected > initial + 1);
    await f.owner.reconnect();
    assert.ok(f.owner.metadata.semanticRevision > disconnected);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('bootstrap rejects a notification during asynchronous full-history read before IPC claim', async () => {
  let resolve!: (value: NativeProjectionState) => void;
  const read = new Promise<NativeProjectionState>(done => { resolve = done; });
  let authorityCalls = 0;
  const f = await fixture(() => read, undefined, undefined, false, undefined,
    () => { authorityCalls++; return true; });
  try { const starting = f.owner.start();
    assert.equal(f.owner.metadata.startupStage, 'reading-initial');
    f.child.send('turn/started', { threadId: taskId, turn: { id: 'raced', status: 'inProgress', items: [] } });
    resolve(state());
    await assert.rejects(starting);
    assert.equal(f.owner.metadata.startupStage, 'checking-boundary');
    assert.equal(f.owner.metadata.bootstrapEventCount, 1);
    assert.equal(f.owner.metadata.bootstrapNotifications.turn, 1);
    assert.equal(f.owner.metadata.bootstrapPendingRequests, 0);
    assert.deepEqual(f.owner.metadata.bootstrapBoundary,
      { stateIsBootstrapping: true, ownerCurrent: null, hasEvents: true });
    assert.equal(authorityCalls, 1);
    assert.equal(f.broker.frames.some(frame => frame.method === 'initialize'), false);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('one scoped MCP startup-status notification does not invalidate an otherwise stable initial read', async () => {
  let release!: (value: NativeProjectionState) => void;
  const reading = new Promise<NativeProjectionState>(resolve => { release = resolve; });
  const f = await fixture(() => reading);
  try {
    const starting = f.owner.start();
    f.child.send('mcpServer/startupStatus/updated', { threadId: taskId, name: 'fixture', status: 'ready' });
    release(state());
    await starting;
    assert.equal(f.owner.metadata.state, 'connected');
    assert.equal(f.owner.metadata.startupStage, 'ready');
    assert.equal(f.owner.metadata.bootstrapEventCount, 0);
    assert.equal(f.owner.metadata.bootstrapNotifications['startup-or-warning'], 1);
    assert.deepEqual(f.owner.metadata.bootstrapBoundary,
      { stateIsBootstrapping: true, hasEvents: false, ownerCurrent: true });
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('startup warning remains an invalidating bootstrap event', async () => {
  let release!: (value: NativeProjectionState) => void;
  const reading = new Promise<NativeProjectionState>(resolve => { release = resolve; });
  const f = await fixture(() => reading);
  try {
    const starting = f.owner.start();
    f.child.send('deprecationNotice', { threadId: taskId });
    release(state());
    await assert.rejects(starting);
    assert.equal(f.owner.metadata.bootstrapNotifications['startup-or-warning'], 1);
    assert.equal(f.owner.metadata.bootstrapEventCount, 1);
    assert.deepEqual(f.owner.metadata.bootstrapBoundary,
      { stateIsBootstrapping: true, hasEvents: true, ownerCurrent: null });
    assert.equal(f.broker.frames.some(frame => frame.method === 'initialize'), false);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('initialize reply and follow in one chunk establish follower despite foreign burst', async () => {
  const f = await fixture();
  try {
    f.broker.followWithInitialize = true;
    await f.owner.start();
    const snapshot = await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    assert.deepEqual(snapshot.targetClientIds, ['follower']);
    assert.equal(f.owner.metadata.state, 'connected');
    assert.equal(f.owner.metadata.startupStage, 'ready');
    assert.equal(f.owner.metadata.followerCount, 1);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('targeted full snapshot and live native turn events continue independently of frontend socket', async () => {
  const f = await fixture();
  try { await f.owner.start();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    const first = await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    assert.deepEqual(first.targetClientIds, ['follower']);
    assert.equal((first.params as IpcObject).conversationId, taskId);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'turn-1', status: 'inProgress', startedAt: 1, items: [] } });
    const next = await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed' &&
      ((frame.params as IpcObject).change as IpcObject)?.revision === 2);
    assert.equal((((next.params as IpcObject).change as IpcObject).conversationState as IpcObject).id, taskId);
    f.child.send('item/started', { threadId: taskId, turnId: 'turn-1',
      item: { id: 'user-1', type: 'userMessage', clientId: 'client-1',
        content: [{ type: 'text', text: 'hello' }] } });
    f.child.send('item/started', { threadId: taskId, turnId: 'turn-1',
      item: { id: 'assistant-1', type: 'agentMessage', text: '' } });
    f.child.send('item/agentMessage/delta', { threadId: taskId, turnId: 'turn-1',
      itemId: 'assistant-1', delta: 'answer' });
    const live = await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed' &&
      ((frame.params as IpcObject).change as IpcObject)?.revision === 5);
    const liveTurn = ((((live.params as IpcObject).change as IpcObject).conversationState as IpcObject).turns as IpcObject[])[0]!;
    assert.equal((liveTurn.params as IpcObject).clientUserMessageId, 'client-1');
    assert.equal((liveTurn.items as IpcObject[])[1]!.text, 'answer');
    assert.equal(f.owner.metadata.authorityRevision, 1);
    f.broker.destroy();
    await new Promise(resolve => setImmediate(resolve));
    f.child.send('turn/completed', { threadId: taskId,
      turn: { id: 'turn-1', status: 'completed', completedAt: 2, itemsView: 'summary' } });
    assert.equal(f.owner.metadata.revision, 6);
    await f.owner.reconnect();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    const restored = await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    const restoredTurn = (((restored.params as IpcObject).change as IpcObject).conversationState as IpcObject).turns as IpcObject[];
    assert.equal(restoredTurn[0]!.status, 'completed');
    assert.equal((restoredTurn[0]!.params as IpcObject).clientUserMessageId, 'client-1');
    assert.equal((restoredTurn[0]!.items as IpcObject[])[1]!.text, 'answer');
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('two permitted native followers retain independent leases while one starts a qualified turn', async () => {
  const f = await fixture(undefined, undefined, id => id === 'follower' || id === 'follower-two');
  const snapshots = (source: string) => f.broker.frames.filter(frame => frame.method === 'thread-stream-state-changed' &&
    Array.isArray(frame.targetClientIds) && frame.targetClientIds.length === 1 && frame.targetClientIds[0] === source);
  const follow = (source: string, following: boolean) => f.broker.send({ type: 'broadcast',
    method: 'thread-stream-following-changed', version: 1, sourceClientId: source,
    params: { conversationId: taskId, hostId: 'local', following } });
  try {
    await f.owner.start();
    const broker = f.broker;
    const initializations = f.child.frames.filter(frame => frame.method === 'initialize').length;
    follow('follower', true); follow('follower-two', true);
    await waitFrame(f.broker.frames, frame => snapshots('follower').includes(frame));
    await waitFrame(f.broker.frames, frame => snapshots('follower-two').includes(frame));
    assert.equal(f.owner.metadata.followerCount, 2);

    follow('follower', false);
    assert.equal(f.owner.metadata.followerCount, 1);
    const beforeSecond = snapshots('follower-two').length;
    const beforeFirst = snapshots('follower').length;
    const clientId = randomUUID();
    f.broker.send({ type: 'request', requestId: 'second-follower-start', sourceClientId: 'follower-two',
      hostId: 'local', targetClientId: 'owner-peer', method: 'thread-follower-start-turn', version: 2,
      params: { conversationId: taskId, turnStart: { request: { threadId: taskId, clientUserMessageId: clientId,
        input: [{ type: 'text', text: 'two', text_elements: [] }] }, context: { inheritThreadSettings: true } } } });
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    f.child.reply(wire.id, { turn: { id: 'two-follower-turn', status: 'inProgress' } });
    const response = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'second-follower-start');
    assert.equal(response.resultType, 'success');
    f.broker.send({ type: 'request', requestId: 'second-follower-history', sourceClientId: 'follower-two',
      hostId: 'local', targetClientId: 'owner-peer', method: 'thread-follower-load-complete-history', version: 1,
      params: { conversationId: taskId } });
    await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'second-follower-history' && frame.resultType === 'success');
    await waitFrame(f.broker.frames, frame => snapshots('follower-two').includes(frame) &&
      snapshots('follower-two').length > beforeSecond);
    assert.equal(snapshots('follower').length, beforeFirst);
    assert.equal(f.owner.metadata.followerCount, 1);
    assert.equal(f.broker, broker);
    assert.equal(f.brokers.length, 1);
    assert.equal(f.child.frames.filter(frame => frame.method === 'initialize').length, initializations);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('concurrent reconnect shares one connection and preserves observer projection', async () => {
  const f = await fixture();
  try { await f.owner.start();
    f.broker.destroy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.owner.metadata.state, 'disconnected');
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'offline-turn', status: 'inProgress', startedAt: 2, items: [] } });
    assert.equal(f.owner.metadata.revision, 2);
    const first = f.owner.reconnect(), second = f.owner.reconnect();
    assert.strictEqual(first, second);
    await Promise.all([first, second]);
    assert.equal(f.owner.metadata.state, 'connected');
    assert.equal(f.brokers.length, 2);
    assert.equal(f.broker.frames.filter(frame => frame.method === 'initialize').length, 1);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('stream revision changes for turn events while authority revision changes only for settings', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'turn-1', status: 'inProgress', startedAt: 1, items: [] } });
    assert.deepEqual([f.owner.metadata.revision, f.owner.metadata.authorityRevision], [2, 1]);
    f.child.send('thread/settings/updated', { threadId: taskId,
      threadSettings: { cwd: 'C:/own', model: 'new-model', modelProvider: 'openai', effort: 'low',
        serviceTier: null, collaborationMode: state().latestCollaborationMode } });
    assert.deepEqual([f.owner.metadata.revision, f.owner.metadata.authorityRevision], [3, 2]);
    f.child.send('unsupported/own-notification', { threadId: taskId });
    assert.equal(f.owner.metadata.state, 'failed');
    assert.equal(f.host.metadata.state, 'running');
    assert.equal(f.owner.metadata.failure, 'projection-failed');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('wrong task, version and unfollowed peer cannot start a native turn', async () => {
  const f = await fixture();
  try {
    await f.owner.start();
    const request = { type: 'request', requestId: 'wrong-task', sourceClientId: 'follower',
      hostId: 'local', targetClientId: 'owner-peer', method: 'thread-follower-start-turn', version: 2,
      params: { conversationId: 'foreign-task' } };
    f.broker.send(request);
    f.broker.send({ ...request, requestId: 'wrong-version', version: 1,
      params: { conversationId: taskId } });
    f.broker.send({ ...request, requestId: 'unfollowed', params: { conversationId: taskId } });
    for (const id of ['wrong-task', 'wrong-version', 'unfollowed']) {
      const response = await waitFrame(f.broker.frames, frame => frame.type === 'response' && frame.requestId === id);
      assert.equal(response.resultType, 'error');
    }
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(f.owner.handle({ requestId: 'already-aborted', sourceClientId: 'follower',
      hostId: 'local', method: 'thread-follower-start-turn', version: 2,
      params: { conversationId: taskId } }, abort.signal));
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('bootstrap refuses nonterminal turn and explicit pending queue markers', async () => {
  for (const change of [
    { turns: [{ turnId: 'active', status: 'inProgress', items: [] }] },
    { nativeQueue: [{ id: 'pending' }] },
  ]) {
    const f = await fixture(async () => ({ ...state(), ...change } as NativeProjectionState));
    try { await assert.rejects(f.owner.start());
      assert.equal(f.owner.metadata.startupStage, 'validating-initial');
      assert.equal(f.owner.metadata.bootstrapEventCount, 0);
      assert.equal(f.owner.metadata.bootstrapBoundary, null);
      assert.equal(f.broker.frames.some(frame => frame.method === 'initialize'), false);
      assert.equal(f.host.metadata.state, 'running');
    } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
  }
});

test('bootstrap diagnostics distinguish lost owner authority from a notification boundary', async () => {
  let release!: (value: NativeProjectionState) => void;
  const reading = new Promise<NativeProjectionState>(resolve => { release = resolve; });
  let authorized = true;
  let authorityCalls = 0;
  const f = await fixture(() => reading, undefined, undefined, false, undefined,
    () => { authorityCalls++; return authorized; });
  try {
    const starting = f.owner.start(); authorized = false; release(state());
    await assert.rejects(starting);
    assert.equal(f.owner.metadata.startupStage, 'checking-boundary');
    assert.deepEqual(f.owner.metadata.bootstrapBoundary,
      { stateIsBootstrapping: true, ownerCurrent: false, hasEvents: false });
    assert.equal(f.owner.metadata.bootstrapEventCount, 0);
    assert.equal(authorityCalls, 2);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('admitted direct start survives owner IPC EOF before final worker write; reconnect duplicate is one wire', async () => {
  const f = await fixture();
  try { await f.owner.start();
    let stateAtWrite: string | null = null;
    f.child.onFrame = frame => {
      if (frame.method === 'turn/start') stateAtWrite = f.owner.metadata.state;
    };
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    const clientId = randomUUID();
    const params = { conversationId: taskId, turnStart: { request: { threadId: taskId,
      clientUserMessageId: clientId, input: [{ type: 'text', text: 'one', text_elements: [] }] },
      context: { inheritThreadSettings: true } } };
    const request = { type: 'request', requestId: 'first', sourceClientId: 'follower',
      hostId: 'local', targetClientId: 'owner-peer', method: 'thread-follower-start-turn', version: 2, params };
    f.broker.send(request);
    // Deliver the transport EOF before the asynchronous final policy/write boundary.
    f.broker.emit('close');
    f.broker.destroy();
    const written = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    assert.equal(stateAtWrite, 'disconnected');
    f.child.reply(written.id, { turn: { id: 'native-turn', status: 'inProgress', extra: true } });
    const hash = createHash('sha256').update(JSON.stringify([
      'vkodex-native-start-v2', f.ownerEpoch, taskId, clientId])).digest('hex');
    const opId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const end = Date.now() + 1000;
    while (f.host.commandStatus(f.controlKey, opId)?.state !== 'accepted' && Date.now() < end)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.host.commandStatus(f.controlKey, opId)?.receiptId, 'native-turn');
    await f.owner.reconnect();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    f.broker.send({ ...request, requestId: 'second' });
    const response = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'second');
    assert.equal(response.resultType, 'success');
    assert.deepEqual((response.result as IpcObject).result,
      { turn: { id: 'native-turn', status: 'inProgress', extra: true } });
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); assert.equal(f.owner.retiredWithoutNativeIngress(), false);
    await f.host.stop('test-cleanup'); }
});

test('Composer intent overlays only its accepted observed turn and retries after first-turn eligibility is gone', async () => {
  const f = await fixture(async () => composerState(), undefined, undefined, true);
  const clientId = randomUUID();
  const user = { id: 'composer-user', type: 'userMessage', clientId,
    content: [{ type: 'text', text: 'hello', text_elements: [] }] };
  const params = { conversationId: taskId, turnStart: {
    request: { threadId: taskId, clientUserMessageId: clientId, input: user.content,
      cwd: 'C:/own', model: null, effort: null, serviceTier: null,
      collaborationMode: composerState().latestCollaborationMode,
      permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      turnTrigger: 'composer', multiAgentMode: 'explicitRequestOnly',
      responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' } },
    context: { inheritThreadSettings: true, writingBlockContextPrepared: true,
      localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [],
      responseItems: [], useAppServerPermissionDefault: false, usePermissionSelection: false } } };
  const request = { type: 'request', requestId: 'composer-first', sourceClientId: 'follower',
    hostId: 'local', targetClientId: 'owner-peer', method: 'thread-follower-start-turn', version: 2, params };
  const follow = () => f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed',
    version: 1, sourceClientId: 'follower',
    params: { conversationId: taskId, hostId: 'local', following: true } });
  try {
    await f.owner.start(); follow();
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    f.broker.send(request);
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    assert.equal((wire.params as IpcObject).turnTrigger, 'composer');
    assert.equal(f.intentStore?.getByClientUserMessageId(clientId)?.intent.uiParams?.turnTrigger, 'composer');
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'composer-turn', status: 'inProgress', startedAt: 1, items: [] } });
    f.child.send('item/started', { threadId: taskId, turnId: 'composer-turn', item: user });
    const pending = await waitFrame(f.broker.frames, frame =>
      snapshotTurn(frame)?.turnId === 'composer-turn' &&
      ((snapshotTurn(frame)?.items as IpcObject[] | undefined) ?? []).some(item => item.clientId === clientId));
    assert.equal((snapshotTurn(pending)!.params as IpcObject).turnTrigger, undefined);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
    // A full-history refresh may temporarily lack the user item. Acceptance
    // alone must not apply the local UI overlay to that incomplete turn.
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'composer-turn', status: 'inProgress', itemsView: 'full', items: [] } });
    f.child.reply(wire.id, { turn: { id: 'composer-turn', status: 'inProgress' } });
    const accepted = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'composer-first');
    assert.equal(accepted.resultType, 'success');
    const record = f.intentStore!.getByClientUserMessageId(clientId);
    assert.ok(record);
    assert.equal(f.host.commandStatus(f.controlKey, record.operationId)?.receiptId, 'composer-turn');
    const acceptedWithoutUser = f.broker.frames.filter(frame =>
      snapshotTurn(frame)?.turnId === 'composer-turn').at(-1)!;
    assert.equal((snapshotTurn(acceptedWithoutUser)!.params as IpcObject).turnTrigger, undefined);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'composer-turn', status: 'inProgress', itemsView: 'full', items: [user] } });
    const overlaid = await waitFrame(f.broker.frames, frame =>
      snapshotTurn(frame)?.turnId === 'composer-turn' &&
      (snapshotTurn(frame)?.params as IpcObject | undefined)?.turnTrigger === 'composer');
    const ui = snapshotTurn(overlaid)!.params as IpcObject;
    assert.equal(ui.fileAttachmentCount, 0);
    assert.equal(ui.cwd, 'C:/own');
    assert.deepEqual(ui.runtimeWorkspaceRoots, ['C:/own']);
    assert.deepEqual(ui.responsesapiClientMetadata,
      { source: 'codex', client_type: 'desktop_app' });
    assert.deepEqual(ui.sandboxPolicy,
      { type: 'readOnly', networkAccess: false });
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'composer-turn', status: 'inProgress', itemsView: 'full', items: [user] } });
    const refreshed = await waitFrame(f.broker.frames, frame =>
      snapshotTurn(frame)?.turnId === 'composer-turn' &&
      ((frame.params as IpcObject).change as IpcObject).revision === f.owner.metadata.revision);
    assert.equal((snapshotTurn(refreshed)!.params as IpcObject).turnTrigger, 'composer');
    f.broker.destroy();
    await new Promise(resolve => setImmediate(resolve));
    await f.owner.reconnect(); follow();
    const resumed = await waitFrame(f.broker.frames, frame =>
      (snapshotTurn(frame)?.params as IpcObject | undefined)?.turnTrigger === 'composer');
    assert.equal(snapshotTurn(resumed)?.turnId, 'composer-turn');
    f.broker.send({ ...request, requestId: 'composer-retry' });
    const retry = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'composer-retry');
    assert.equal(retry.resultType, 'success');
    assert.deepEqual((retry.result as IpcObject).result,
      { turn: { id: 'composer-turn', status: 'inProgress' } });
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.owner.metadata.state, 'connected');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); f.intentStore?.close(); }
});

test('opt-in first Composer owner fence observes zero work before reservation and only its dispatch at write', async () => {
  const phases: string[] = [];
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async () => composerState(), undefined, undefined, true,
    undefined, () => true, false, {}, scope => {
      phases.push(scope.phase);
      assert.equal(f.owner.noPendingNativeCliAutoStart(), false);
      const operation = f.host.commandStatusForIntent(f.controlKey, scope.command);
      assert.equal(operation?.state ?? null,
        scope.phase === 'before-reservation' ? null : 'dispatching');
      return true;
    });
  try {
    await f.owner.start();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    f.broker.send(firstComposerRequest(randomUUID()));
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    f.child.reply(wire.id, { turn: { id: 'fenced-turn', status: 'inProgress' } });
    const response = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'fenced-first');
    assert.equal(response.resultType, 'success');
    assert.deepEqual(phases, ['before-reservation', 'before-write']);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('opt-in first Composer owner fence rejects owner drift at write without backend request', async () => {
  let live = true;
  const phases: string[] = [];
  const f = await fixture(async () => composerState(), undefined, undefined, true,
    undefined, () => live, false, {}, scope => {
      phases.push(scope.phase);
      if (scope.phase === 'before-write') live = false;
      return true;
    });
  try {
    await f.owner.start();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    f.broker.send(firstComposerRequest(randomUUID()));
    await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'fenced-first');
    assert.deepEqual(phases, ['before-reservation', 'before-write']);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('opt-in first Composer owner fence refuses pending requests and competing journal work', async () => {
  for (const blocked of ['pending-request', 'in-flight-command'] as const) {
    const f = await fixture(async () => composerState(), undefined, undefined, true,
      undefined, () => true, false, {}, () => true);
    const requests = f.host.requestQuiescence.bind(f.host);
    const commands = f.host.commandQuiescence.bind(f.host);
    try {
      await f.owner.start();
      f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
        sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
      await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
      if (blocked === 'pending-request')
        f.host.requestQuiescence = key => ({ ...requests(key), unresolved: 1 });
      else f.host.commandQuiescence = key => ({ ...commands(key), inFlight: 1 });
      f.broker.send(firstComposerRequest(randomUUID()));
      const response = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
        frame.requestId === 'fenced-first');
      assert.equal(response.resultType, 'error');
      assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    } finally {
      f.host.requestQuiescence = requests;
      f.host.commandQuiescence = commands;
      f.owner.close(); await f.host.stop('test-cleanup');
    }
  }
});

test('qualified second Composer send uses one actual wire and accepted duplicate skips fresh qualification', async () => {
  let qualified = 0;
  const f = await fixture(async () => continuationState(), undefined, undefined, true,
    async fence => { qualified++; return continuationEvidence(fence); });
  const follow = () => f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed',
    version: 1, sourceClientId: 'follower',
    params: { conversationId: taskId, hostId: 'local', following: true } });
  const clientId = randomUUID();
  try {
    await f.owner.start(); follow();
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    f.child.send('thread/goal/cleared', { threadId: taskId });
    assert.equal(f.owner.metadata.state, 'connected');
    f.child.onFrame = frame => {
      if (frame.method === 'turn/start') queueMicrotask(() => f.child.reply(frame.id,
        { turn: { id: 'continuation-turn', status: 'inProgress', extra: 'actual-native' } }));
    };
    f.broker.send(continuationRequest(clientId, 'continuation-first'));
    const first = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'continuation-first');
    assert.equal(first.resultType, 'success');
    assert.deepEqual((first.result as IpcObject).result,
      { turn: { id: 'continuation-turn', status: 'inProgress', extra: 'actual-native' } });
    assert.equal(qualified, 1);
    const wire = await waitFrame(f.child.frames, frame => frame.method === 'turn/start');
    assert.equal((wire.params as IpcObject).turnTrigger, 'composer');
    assert.equal((wire.params as IpcObject).model, null);
    assert.equal((wire.params as IpcObject).approvalPolicy, 'on-request');
    // The accepted native receipt has not yet appeared in full terminal
    // history. A different command cannot use the old continuation proof.
    f.broker.send(continuationRequest(randomUUID(), 'continuation-other'));
    const denied = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'continuation-other');
    assert.equal(denied.resultType, 'error');
    assert.equal(qualified, 2);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'continuation-turn', status: 'inProgress', startedAt: 3, items: [] } });
    assert.ok(f.owner.metadata.semanticRevision > 1);
    f.broker.destroy();
    await new Promise(resolve => setImmediate(resolve));
    await f.owner.reconnect(); follow();
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    f.broker.send(continuationRequest(clientId, 'continuation-duplicate'));
    const duplicate = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'continuation-duplicate');
    assert.equal(duplicate.resultType, 'success');
    assert.deepEqual(duplicate.result, first.result);
    assert.equal(qualified, 2);
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); f.intentStore?.close(); }
});

test('semantic change during continuation qualification refuses before durable intent or worker wire', async () => {
  let entered!: () => void, release!: () => void;
  const begun = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => continuationState(), undefined, undefined, true,
    async fence => { const evidence = continuationEvidence(fence); entered(); await hold; return evidence; });
  try {
    await f.owner.start();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    await waitFrame(f.broker.frames, frame => frame.method === 'thread-stream-state-changed');
    const clientId = randomUUID();
    f.broker.send(continuationRequest(clientId, 'semantic-race'));
    await begun;
    f.child.send('thread/goal/cleared', { threadId: taskId });
    assert.equal(f.owner.metadata.state, 'connected');
    const before = f.owner.metadata.semanticRevision;
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'raced-turn', status: 'inProgress', startedAt: 4, items: [] } });
    assert.ok(f.owner.metadata.semanticRevision > before);
    release();
    const denied = await waitFrame(f.broker.frames, frame => frame.type === 'response' &&
      frame.requestId === 'semantic-race');
    assert.equal(denied.resultType, 'error');
    assert.equal(f.child.frames.filter(frame => frame.method === 'turn/start').length, 0);
    assert.equal(f.intentStore?.getByClientUserMessageId(clientId), null);
    assert.equal(f.host.metadata.state, 'running');
  } finally { release?.(); f.owner.close(); await f.host.stop('test-cleanup'); f.intentStore?.close(); }
});

test('pending user question survives IPC EOF, answers once, completes only on native resolution', async () => {
  const f = await fixture(undefined, (_request, response) => !!response.answers);
  const follow = () => f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed',
    version: 1, sourceClientId: 'follower',
    params: { conversationId: taskId, hostId: 'local', following: true } });
  const latest = (): IpcObject => {
    const frame = f.broker.frames.filter(value => value.method === 'thread-stream-state-changed').at(-1)!;
    return ((frame.params as IpcObject).change as IpcObject).conversationState as IpcObject;
  };
  try {
    await f.owner.start(); follow();
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 'question-turn', status: 'inProgress', items: [] } });
    f.broker.destroy(); await new Promise(resolve => setImmediate(resolve));
    f.child.stdout.write(`${JSON.stringify({ id: 7, method: 'item/tool/requestUserInput',
      params: { threadId: taskId, turnId: 'question-turn', itemId: 'question-item', questions: [
        { id: 'q', header: 'Choose', question: 'Continue?', isSecret: false, isOther: false, options: [] },
      ] } })}\n`);
    await f.owner.reconnect(); follow();
    assert.equal((latest().requests as IpcObject[]).length, 1);
    const request = { requestId: 'answer', sourceClientId: 'follower', hostId: 'local',
      method: 'thread-follower-submit-user-input', version: 1,
      params: { conversationId: taskId, requestId: 7, response: { answers: { q: { answers: ['yes'] } } } } };
    await assert.rejects(f.owner.handle({ ...request,
      params: { ...request.params, requestId: '7' } }, new AbortController().signal));
    assert.deepEqual(await f.owner.handle(request, new AbortController().signal), { ok: true });
    await waitFrame(f.child.frames, frame => frame.id === 7 && !!frame.result);
    await assert.rejects(f.owner.handle(request, new AbortController().signal));
    assert.equal(f.child.frames.filter(frame => frame.id === 7 && !!frame.result).length, 1);
    assert.equal((latest().requests as IpcObject[]).length, 1);
    const item = ((latest().turns as IpcObject[])[0]!.items as IpcObject[])[0]!;
    assert.equal(item.completed, false);
    f.child.send('serverRequest/resolved', { threadId: taskId, requestId: 7 });
    assert.equal((latest().requests as IpcObject[]).length, 0);
    assert.equal((((latest().turns as IpcObject[])[0]!.items as IpcObject[])[0]!).completed, true);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); assert.equal(f.owner.retiredWithoutNativeIngress(), false);
    await f.host.stop('test-cleanup'); }
});

test('final follower policy cannot retire Gateway and still authorize an answer', async () => {
  let arm = false;
  const f = await fixture(undefined, () => { arm = true; return true; }, id => {
    if (arm) f.owner.close();
    return id === 'follower';
  });
  try {
    await f.owner.start();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 't', status: 'inProgress', items: [] } });
    f.child.stdout.write(`${JSON.stringify({ id: 7, method: 'item/tool/requestUserInput',
      params: { threadId: taskId, turnId: 't', itemId: 'i', questions: [] } })}\n`);
    await assert.rejects(f.owner.handle({ requestId: 'answer', sourceClientId: 'follower',
      method: 'thread-follower-submit-user-input', version: 1,
      params: { conversationId: taskId, requestId: 7, response: { answers: {} } },
    }, new AbortController().signal));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.child.frames.some(frame => frame.id === 7 && !!frame.result), false);
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('approval routes match the pending method and preserve typed request IDs', async () => {
  const f = await fixture(undefined, () => true);
  try {
    await f.owner.start();
    f.broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: taskId, hostId: 'local', following: true } });
    f.child.send('turn/started', { threadId: taskId,
      turn: { id: 't', status: 'inProgress', items: [] } });
    const samples = [
      { id: 8, method: 'item/commandExecution/requestApproval',
        route: 'thread-follower-command-approval-decision', extra: { availableDecisions: ['decline'] },
        reply: { decision: 'decline' } },
      { id: '8', method: 'item/fileChange/requestApproval',
        route: 'thread-follower-file-approval-decision', extra: {}, reply: { decision: 'cancel' } },
      { id: 9, method: 'item/permissions/requestApproval',
        route: 'thread-follower-permissions-request-approval-response', extra: { permissions: {} },
        reply: { response: { permissions: {}, scope: 'turn' } } },
    ];
    for (const sample of samples) f.child.stdout.write(`${JSON.stringify({ id: sample.id,
      method: sample.method, params: { threadId: taskId, turnId: 't', itemId: `i-${sample.id}`,
        ...sample.extra } })}\n`);
    for (const sample of samples) {
      const request = { requestId: `reply-${sample.id}`, sourceClientId: 'follower',
        method: sample.route, version: 1,
        params: { conversationId: taskId, requestId: sample.id, ...sample.reply } };
      await assert.rejects(f.owner.handle({ ...request, method: 'thread-follower-submit-user-input' },
        new AbortController().signal));
      assert.deepEqual(await f.owner.handle(request, new AbortController().signal), { ok: true });
      const wire = await waitFrame(f.child.frames, frame => frame.id === sample.id && !!frame.result);
      assert.deepEqual(wire.result, 'response' in sample.reply ? sample.reply.response : sample.reply);
    }
    assert.equal(f.host.metadata.state, 'running');
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});

test('pending replay fences idle bootstrap; unsupported live request retires only Gateway', async () => {
  for (const replay of [true, false]) {
    const f = await fixture(undefined, () => true);
    try {
      if (!replay) await f.owner.start();
      f.child.stdout.write(`${JSON.stringify({ id: 77, method: 'unqualified/request',
        params: { threadId: taskId, turnId: 't', itemId: 'i' } })}\n`);
      if (replay) await assert.rejects(f.owner.start());
      assert.equal(f.owner.metadata.state, 'failed');
      assert.equal(f.owner.metadata.failure, replay ? 'bootstrap-failed' : 'request-projection-failed');
      assert.equal(f.host.metadata.state, 'running');
      assert.equal(f.child.frames.some(frame => frame.id === 77 && ('result' in frame || 'error' in frame)), false);
      // A different authorized frontend can still answer the same inbox after
      // retiring the unsupported renderer; no cancellation was fabricated.
      const responder = f.host.createRequestResponder(f.controlKey);
      assert.equal(responder.answer(77, {}), true);
      await waitFrame(f.child.frames, frame => frame.id === 77 && !!frame.result);
      responder.detach();
    } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
  }
});
