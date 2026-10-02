import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { AppServerConnection } from '../src/codex/app-server-connection.js';
import { ManagedWorkerFrontendHost } from '../src/codex/managed-worker-frontend-host.js';
import { ManagedNativeCliStartAdmission } from '../src/codex/managed-native-cli-start-admission.js';
import type { ManagedWorkerNotification } from '../src/codex/managed-worker-frontend-host.js';
import type { WorkerCommand, WorkerCommandPolicy } from '../src/codex/managed-worker-command-dispatcher.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import { createManagedStockSettingsInitializer } from '../src/desktop/managed-stock-settings-initializer.js';
import type { ManagedStockSettingsInitializer } from '../src/desktop/managed-stock-settings-initializer.js';
import type { NativeProjectionState } from '../src/codex/managed-native-projection.js';

type Frame = Record<string, unknown>;
const taskId = 'own-thread';
const init: Frame = { clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } };
class Child extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly messages: Frame[] = [];
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; pid: number | undefined = undefined;
  autoInitialize = true;
  constructor() {
    super(); let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, end)) as Frame;
        buffer = buffer.slice(end + 1); this.messages.push(frame);
        if (frame.method === 'initialize' && this.autoInitialize)
          queueMicrotask(() => this.send({ id: frame.id, result: { serverInfo: { name: 'fixture' } } }));
        if (frame.method === 'thread/read')
          queueMicrotask(() => this.send({ id: frame.id, result: { thread: { id: taskId } } }));
      }
    });
  }
  send(frame: Frame): void { this.stdout.write(`${JSON.stringify(frame)}\n`); }
  disconnect(): void { this.emit('close', 1, null); }
  kill(): boolean { this.disconnect(); return true; }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}
class Client {
  readonly frames: Frame[] = [];
  private readonly waiting: Array<(frame: Frame) => void> = [];
  private buffer = '';
  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      while (this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n');
        const frame = JSON.parse(this.buffer.slice(0, end)) as Frame;
        this.buffer = this.buffer.slice(end + 1);
        const waiter = this.waiting.shift();
        if (waiter) waiter(frame); else this.frames.push(frame);
      }
    });
    socket.on('error', () => {});
  }
  send(frame: Frame): void { this.socket.write(`${JSON.stringify(frame)}\n`); }
  next(): Promise<Frame> {
    const existing = this.frames.shift();
    if (existing) return Promise.resolve(existing);
    return Promise.race([new Promise<Frame>(resolve => this.waiting.push(resolve)),
      new Promise<Frame>((_, reject) => setTimeout(() => reject(new Error('client-frame-timeout')), 1000))]);
  }
  close(): void { this.socket.destroy(); }
}
async function client(capability: Readonly<{ host: string; port: number; token: string }>): Promise<Client> {
  const socket = connect({ host: capability.host, port: capability.port });
  await once(socket, 'connect');
  const connected = new Client(socket);
  connected.send({ token: capability.token });
  assert.equal((await connected.next()).ok, true);
  return connected;
}
class WebSocketClient {
  readonly frames: Frame[] = [];
  private readonly waiting: Array<(frame: Frame) => void> = [];
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()) as Frame;
      const waiter = this.waiting.shift();
      if (waiter) waiter(frame); else this.frames.push(frame);
    });
    socket.on('error', () => {});
  }
  send(frame: Frame): void { this.socket.send(JSON.stringify(frame)); }
  next(): Promise<Frame> {
    const existing = this.frames.shift();
    if (existing) return Promise.resolve(existing);
    return Promise.race([new Promise<Frame>(resolve => this.waiting.push(resolve)),
      new Promise<Frame>((_, reject) => setTimeout(() => reject(new Error('websocket-frame-timeout')), 1000))]);
  }
  close(): void { this.socket.terminate(); }
}
async function websocketClient(capability: Readonly<{ host: string; port: number; token: string }>): Promise<WebSocketClient> {
  const socket = new WebSocket(`ws://${capability.host}:${capability.port}/`, {
    headers: { Authorization: `Bearer ${capability.token}` }, perMessageDeflate: false,
  });
  await once(socket, 'open');
  return new WebSocketClient(socket);
}
function host(child: Child, adapterKey: object, port = 0) {
  let launches = 0;
  const managed = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: init, adapterKey, frontendPort: port, backendTimeoutMs: 500,
    bootstrapReadMethods: [],
    allowRequest: request => request.method === 'item/tool/requestUserInput',
    allowAnswer: (_request, result) => result.answers !== undefined,
    allowError: () => true,
    launch: () => { launches++; return child.asChild(); } });
  return { managed, get launches() { return launches; } };
}

test('opt-in WebSocket host accepts native initialize/read without a JSONL auth frame', async () => {
  const child = new Child(), key = {};
  const fixture = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own', initializeRequest: init,
    adapterKey: key, frontendProtocol: 'websocket', backendTimeoutMs: 500, bootstrapReadMethods: [],
    allowRequest: () => false, allowAnswer: () => false, launch: () => child.asChild() });
  await fixture.start();
  try {
    assert.throws(() => fixture.frontendCapability(key), /JSONL|protocol/i);
    assert.throws(() => fixture.frontendWebSocketCapability({}), TypeError);
    const cap = fixture.frontendWebSocketCapability(key);
    assert.equal(cap.host, '127.0.0.1');
    assert.equal(cap.protocol, 'websocket');
    await assert.rejects(websocketClient({ ...cap, token: 'wrong' }));
    const client = await websocketClient(cap);
    try {
      assert.deepEqual(client.frames, []);
      client.send({ id: 'native-init', method: 'initialize', params: init });
      assert.equal((await client.next()).id, 'native-init');
      client.send({ id: 'native-read', method: 'thread/read', params: { threadId: taskId } });
      assert.deepEqual((await client.next()).result, { thread: { id: taskId } });
    } finally { client.close(); }
  } finally { await fixture.stop('test-cleanup'); }
});

test('opt-in CLI start crosses the WebSocket only through the durable same-worker command path', async () => {
  const child = new Child(), adapterKey = {}, controlKey = {};
  const ownerEpoch = randomUUID(), clientId = randomUUID();
  const journalPath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-cli-start-host-')), 'operations.sqlite');
  const settings = { cwd: 'C:/own', runtimeWorkspaceRoots: ['C:/own'],
    approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false }, model: 'gpt-5.6-sol', serviceTier: 'default',
    effort: 'low', summary: null, personality: null,
    collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-sol',
      reasoning_effort: 'low', developer_instructions: null } } };
  const params = { threadId: taskId, clientUserMessageId: clientId,
    input: [{ type: 'text', text: 'isolated host turn' }], turnTrigger: null,
    toolOutput: null, responsesapiClientMetadata: null, additionalContext: null,
    environments: null, cwd: settings.cwd, runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots,
    approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
    sandboxPolicy: null, permissions: settings.permissions, model: settings.model,
    serviceTier: settings.serviceTier, serviceTierForTurn: null, effort: settings.effort,
    summary: null, personality: null, outputSchema: null,
    collaborationMode: settings.collaborationMode, multiAgentMode: null,
    cyberAccessProgram: null };
  const resumeParams = { threadId: taskId };
  const resumeResult = { thread: { id: taskId, status: { type: 'idle' }, turns: [],
    model: settings.model, reasoningEffort: settings.effort, cwd: settings.cwd,
    environments: [{ environmentId: 'local', cwd: settings.cwd,
      runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots }] },
  model: settings.model, reasoningEffort: settings.effort,
  serviceTier: settings.serviceTier, cwd: settings.cwd,
  runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots,
  approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
  sandbox: settings.sandboxPolicy,
  activePermissionProfile: { id: ':read-only', extends: null } };
  const admission = new ManagedNativeCliStartAdmission({ taskId, ownerEpoch, controlKey,
    qualify: async () => ({ taskId, ownerEpoch,
      backendGeneration: 1, semanticRevision: 1,
      effectiveSettings: settings, idle: true, nativeQueueEmpty: true,
      noPendingAutoStart: true, assertCurrent: () => {},
    }) });
  const policy: WorkerCommandPolicy = { controlKey, ownerEpoch, journalPath,
    fingerprintKey: randomBytes(32), isOwnerCurrent: () => true,
    authorize: ({ params: command }) => command.model === settings.model };
  const options = { taskId, ownCwd: 'C:/own', initializeRequest: init, adapterKey,
    frontendProtocol: 'websocket' as const, backendTimeoutMs: 500,
    bootstrapReadMethods: [], allowRequest: () => false, allowAnswer: () => false,
    resumeAuthority: ({ taskId: scopedTask, generation }: { taskId: string; generation: number }) =>
      ({ taskId: scopedTask, generation, params: resumeParams }),
    commandPolicy: policy, frontendStartAdmission: admission, launch: () => child.asChild() };
  const { commandPolicy: _unused, ...noCommandPolicy } = options;
  assert.throws(() => new ManagedWorkerFrontendHost(noCommandPolicy), TypeError);
  assert.throws(() => new ManagedWorkerFrontendHost({ ...options,
    frontendProtocol: 'jsonl' }), TypeError);
  assert.throws(() => new ManagedWorkerFrontendHost({ ...options,
    commandPolicy: { ...policy, controlKey: {} } }), TypeError);
  const managed = new ManagedWorkerFrontendHost(options);
  await managed.start();
  try {
    const client = await websocketClient(managed.frontendWebSocketCapability(adapterKey));
    try {
      client.send({ id: 'init', method: 'initialize', params: init });
      assert.equal((await client.next()).id, 'init');
      client.send({ id: 1, method: 'thread/resume', params: resumeParams });
      const resumeWire = await sentMutation(child, 'thread/resume');
      child.send({ id: resumeWire.id, result: resumeResult });
      assert.deepEqual((await client.next()).result, resumeResult);
      client.send({ id: 2, method: 'turn/start', params });
      const wire = await sentMutation(child);
      assert.deepEqual(wire.params, params);
      child.send({ id: wire.id, result: { turn: { id: 'native-turn-ok', status: 'inProgress' } } });
      assert.deepEqual((await client.next()).result,
        { turn: { id: 'native-turn-ok', status: 'inProgress' } });
      assert.deepEqual(managed.acceptedCommandReceipts(controlKey),
        [{ method: 'turn/start', receiptId: 'native-turn-ok' }]);
      assert.equal(child.messages.filter(frame => frame.method === 'turn/start').length, 1);
      client.send({ id: 3, method: 'thread/resume', params: resumeParams });
      const activeWire = await sentMutation(child, 'thread/resume', 2);
      const activeResume = { ...resumeResult, thread: { ...resumeResult.thread,
        status: { type: 'active' } } };
      child.send({ id: activeWire.id, result: activeResume });
      assert.deepEqual((await client.next()).result, activeResume);
      client.send({ id: 4, method: 'turn/start', params });
      assert.equal(((await client.next()).error as { code: number }).code, -32602);
      assert.equal(child.messages.filter(frame => frame.method === 'turn/start').length, 1);
    } finally { client.close(); }
  } finally { await managed.stop('test-cleanup'); }
});

test('owner-scoped state reads use the exact worker without opening or mutating another connection', async () => {
  const child = new Child(), controlKey = {}, adapterKey = {};
  let ownerCurrent = true;
  const policy: WorkerCommandPolicy = { controlKey, ownerEpoch: randomUUID(),
    journalPath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-owner-read-')), 'operations.sqlite'),
    fingerprintKey: randomBytes(32), isOwnerCurrent: () => ownerCurrent,
    authorize: () => false };
  const managed = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: init, adapterKey, backendTimeoutMs: 500, bootstrapReadMethods: [],
    allowRequest: () => false, allowAnswer: () => false,
    commandPolicy: policy, launch: () => child.asChild() });
  await managed.start();
  try {
    const generation = managed.metadata.backendGeneration!;
    await assert.rejects(managed.ownerRead({}, generation, 'thread/read', { threadId: taskId }));
    await assert.rejects(managed.ownerRead(controlKey, generation, 'thread/read', { threadId: 'foreign' }));
    await assert.rejects(managed.ownerRead(controlKey, generation, 'thread/start', { threadId: taskId }));
    await assert.rejects(managed.ownerRead(controlKey, generation, 'thread/turns/list',
      { threadId: taskId, limit: 101 }));
    await assert.rejects(managed.ownerRead(controlKey, generation, 'config/read',
      { cwd: 'C:/foreign' }));
    assert.deepEqual(await managed.ownerRead(controlKey, generation, 'thread/read',
      { threadId: taskId, includeTurns: false }), { thread: { id: taskId } });
    assert.deepEqual(await managed.ownerRead(controlKey, generation, 'thread/read',
      { threadId: taskId, includeTurns: true }), { thread: { id: taskId } });
    const turns = managed.ownerRead(controlKey, generation, 'thread/turns/list',
      { threadId: taskId, limit: 2, sortDirection: 'asc', itemsView: 'summary' });
    const turnsWire = await sentMutation(child, 'thread/turns/list');
    assert.equal((turnsWire.params as Record<string, unknown>).itemsView, 'summary');
    child.send({ id: turnsWire.id, result: { data: [], nextCursor: null } });
    assert.deepEqual(await turns, { data: [], nextCursor: null });
    const queue = managed.ownerRead(controlKey, generation, 'thread/queue/list',
      { threadId: taskId, cursor: null, limit: 100 });
    const wire = await sentMutation(child, 'thread/queue/list');
    assert.equal(wire.method, 'thread/queue/list');
    child.send({ id: wire.id, result: { data: [], nextCursor: null } });
    assert.deepEqual(await queue, { data: [], nextCursor: null });
    const goal = managed.ownerRead(controlKey, generation, 'thread/goal/get', { threadId: taskId });
    const goalWire = await sentMutation(child, 'thread/goal/get');
    ownerCurrent = false;
    child.send({ id: goalWire.id, result: { goal: null } });
    await assert.rejects(goal, /source changed/i);
    await assert.rejects(managed.ownerRead(controlKey, generation, 'thread/read', { threadId: taskId }));
    assert.equal(child.messages.filter(frame => frame.method === 'thread/read').length, 2);
  } finally { await managed.stop('test-cleanup'); }
});

test('WebSocket restart retains backend PID and rejects old bearer on the new listener', async () => {
  const child = new Child(), key = {}; child.pid = 42_424; let launches = 0;
  const fixture = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own', initializeRequest: init,
    adapterKey: key, frontendProtocol: 'websocket', backendTimeoutMs: 500, bootstrapReadMethods: [],
    allowRequest: () => false, allowAnswer: () => false,
    launch: () => { launches++; return child.asChild(); } });
  await fixture.start();
  try {
    const oldCap = fixture.frontendWebSocketCapability(key);
    const old = await websocketClient(oldCap);
    old.send({ id: 'before', method: 'initialize', params: init });
    assert.equal((await old.next()).id, 'before');
    const oldPid = child.pid;
    const closed = once(old.socket, 'close');
    await fixture.restartFrontend();
    await closed;
    const newCap = fixture.frontendWebSocketCapability(key);
    assert.notEqual(newCap.token, oldCap.token);
    assert.equal(oldPid, 42_424);
    assert.equal(child.pid, oldPid);
    assert.equal(launches, 1);
    assert.equal(child.stdin.writableEnded, false);
    await assert.rejects(websocketClient({ ...newCap, token: oldCap.token }));
    const fresh = await websocketClient(newCap);
    try {
      fresh.send({ id: 'after', method: 'initialize', params: init });
      assert.equal((await fresh.next()).id, 'after');
      fresh.send({ id: 'read-after', method: 'thread/read', params: { threadId: taskId } });
      assert.deepEqual((await fresh.next()).result, { thread: { id: taskId } });
    } finally { fresh.close(); old.close(); }
  } finally { await fixture.stop('test-cleanup'); }
});

test('owner revocation cannot resurrect a WebSocket bearer racing frontend restart', async () => {
  const child = new Child(), adapterKey = {}, controlKey = {};
  const policy: WorkerCommandPolicy = { controlKey, ownerEpoch: randomUUID(),
    journalPath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-frontend-revoke-')), 'operations.sqlite'),
    fingerprintKey: randomBytes(32), isOwnerCurrent: () => true, authorize: () => false };
  const managed = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: init, adapterKey, frontendProtocol: 'websocket',
    backendTimeoutMs: 500, bootstrapReadMethods: [], commandPolicy: policy,
    allowRequest: () => false, allowAnswer: () => false,
    launch: () => child.asChild() });
  await managed.start();
  try {
    const bearer = managed.frontendWebSocketCapability(adapterKey);
    const client = await websocketClient(bearer);
    try {
      client.send({ id: 'init', method: 'initialize', params: init });
      assert.equal((await client.next()).id, 'init');
      await assert.rejects(managed.revokeFrontend({}), /Unauthorized/);
      const closed = once(client.socket, 'close');
      const restarting = managed.restartFrontend();
      await managed.revokeFrontend(controlKey);
      await assert.rejects(restarting, /superseded|unavailable/i);
      await closed;
      await assert.rejects(websocketClient(bearer));
      await assert.rejects(managed.restartFrontend(), /unavailable/i);
      assert.equal(child.stdin.writableEnded, false);
      assert.equal(managed.metadata.state, 'frontend-unavailable');
    } finally { client.close(); }
  } finally { await managed.stop('test-cleanup'); }
});

test('default JSONL host does not expose a WebSocket capability and rejects invalid protocol', async () => {
  const child = new Child(), key = {}, fixture = host(child, key);
  assert.throws(() => new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own', initializeRequest: init,
    adapterKey: key, frontendProtocol: 'http' as 'websocket', bootstrapReadMethods: [],
    allowRequest: () => false, allowAnswer: () => false, launch: () => child.asChild() }), TypeError);
  await fixture.managed.start();
  try {
    assert.throws(() => fixture.managed.frontendWebSocketCapability(key), /WebSocket|protocol/i);
    assert.throws(() => fixture.managed.frontendWebSocketCapability({}), TypeError);
    const frontend = await client(fixture.managed.frontendCapability(key));
    frontend.close();
  } finally { await fixture.managed.stop('test-cleanup'); }
});

test('scoped notification observers survive frontend detach without owning worker lifetime', async () => {
  const child = new Child(), key = {}, fixture = host(child, key);
  const managed = fixture.managed;
  const seen: ManagedWorkerNotification[] = [];
  const failures: string[] = [];
  const failed = (reason: string) => { failures.push(reason); };
  assert.throws(() => managed.observeNotifications(key, () => {}, failed));
  await managed.start();
  try {
    assert.throws(() => managed.observeNotifications({}, () => {}, failed), TypeError);
    const unwatchBroken = managed.observeNotifications(key, event => {
      event.notification.params.mutated = true;
      throw new Error('isolated projection failure');
    }, failed);
    const unwatch = managed.observeNotifications(key, event => seen.push(event), failed);
    child.send({ method: 'turn/started', params: { threadId: 'other', turn: { id: 'other-turn' } } });
    child.send({ method: 'turn/started', params: { threadId: taskId, turn: { id: 'one' } } });
    assert.equal(seen.length, 1);
    assert.deepEqual(failures, ['observer-failed']);
    assert.deepEqual(seen[0], { taskId, generation: 1,
      notification: { method: 'turn/started', params: { threadId: taskId, turn: { id: 'one' } } } });
    await managed.restartFrontend();
    child.send({ method: 'turn/completed', params: { threadId: taskId, turn: { id: 'one' } } });
    assert.equal(seen.length, 2);
    unwatch(); unwatch(); unwatchBroken();
    child.send({ method: 'turn/started', params: { threadId: taskId, turn: { id: 'two' } } });
    assert.equal(seen.length, 2);
    assert.equal(child.stdin.writableEnded, false);
    assert.equal(fixture.launches, 1);
    managed.observeNotifications(key, event => seen.push(event), failed);
    child.disconnect();
    child.send({ method: 'turn/completed', params: { threadId: taskId, turn: { id: 'two' } } });
    assert.equal(seen.length, 2);
    assert.deepEqual(failures, ['observer-failed', 'backend-lost']);
    assert.throws(() => managed.observeNotifications(key, () => {}, failed));
  } finally { await managed.stop('test-cleanup'); }
});

test('an asynchronous projection callback is retired without an unhandled rejection or worker stop', async () => {
  const child = new Child(), key = {}, { managed } = host(child, key);
  await managed.start();
  try {
    const failures: string[] = [];
    managed.observeNotifications(key, async () => { throw new Error('projection rejected'); },
      reason => { failures.push(reason); });
    child.send({ method: 'turn/started', params: { threadId: taskId, turn: { id: 'one' } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(failures, ['observer-failed']);
    child.send({ method: 'turn/completed', params: { threadId: taskId, turn: { id: 'one' } } });
    assert.deepEqual(failures, ['observer-failed']);
    assert.equal(managed.metadata.state, 'running');
  } finally { await managed.stop('test-cleanup'); }
});

test('observer retirement cannot reenter a second owner stop', async () => {
  const child = new Child(), key = {}, { managed } = host(child, key);
  await managed.start();
  let reentered: Promise<void> | undefined;
  managed.observeNotifications(key, () => {}, reason => {
    assert.equal(reason, 'owner-stopped');
    reentered = managed.stop('owner-request');
  });
  const stopping = managed.stop('owner-request');
  await stopping;
  assert.strictEqual(reentered, stopping);
});

test('pending observer replays without replacing the persistent frontend inbox attachment', async () => {
  const child = new Child(), key = {}, { managed } = host(child, key);
  await managed.start();
  try {
    const frontend = await client(managed.frontendCapability(key));
    frontend.send({ id: 1, method: 'initialize', params: init });
    assert.equal((await frontend.next()).id, 1);
    child.send({ id: 'pending-replay', method: 'item/tool/requestUserInput',
      params: { threadId: taskId, questions: [] } });
    await new Promise(resolve => setImmediate(resolve));
    const seen: unknown[] = []; const failures: string[] = [];
    assert.throws(() => managed.observePendingRequests({}, () => {}, () => {}), TypeError);
    managed.observePendingRequests(key, async () => { throw new Error('async observer'); }, reason => failures.push(reason));
    const detach = managed.observePendingRequests(key, event => seen.push(event), reason => failures.push(reason));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { taskId, generation: 1,
      request: { id: 'pending-replay', method: 'item/tool/requestUserInput', params: { threadId: taskId, questions: [] } } });
    assert.equal((await frontend.next()).id, 'pending-replay');
    detach(); child.disconnect();
    assert.deepEqual(failures, ['observer-failed']);
  } finally { await managed.stop('test-cleanup'); }
});

test('synchronous pending replay may stop the host without retaining an orphan observer', async () => {
  const child = new Child(), key = {}, { managed } = host(child, key);
  await managed.start();
  child.send({ id: 'stop-replay', method: 'item/tool/requestUserInput', params: { threadId: taskId, questions: [] } });
  await new Promise(resolve => setImmediate(resolve));
  let stopped: Promise<void> | undefined;
  const detach = managed.observePendingRequests(key, () => { stopped = managed.stop('owner-request'); }, () => {});
  await stopped;
  detach(); detach();
  assert.equal(managed.metadata.state, 'stopped');
});

test('request responder is command-key scoped, policy fenced, and invalidated by loss', async () => {
  const f = commandFixture(); await f.managed.start();
  try {
    assert.throws(() => f.managed.createRequestResponder({}), /responder/i);
    let narrow = true;
    const responder = f.managed.createRequestResponder(f.controlKey, () => narrow);
    f.child.send({ id: 'native-answer', method: 'item/tool/requestUserInput',
      params: { threadId: taskId, questions: [] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responder.answer('native-answer', { answers: {} }), true);
    assert.equal(responder.answer('native-answer', { answers: {} }), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.child.messages.filter(frame => frame.id === 'native-answer' && 'result' in frame).length, 1);
    f.child.send({ id: 'revoked-answer', method: 'item/tool/requestUserInput',
      params: { threadId: taskId, questions: [] } });
    await new Promise(resolve => setImmediate(resolve));
    narrow = false; assert.equal(responder.answer('revoked-answer', { answers: {} }), false);
    f.child.disconnect(); assert.equal(responder.answer('revoked-answer', { answers: {} }), false);
    responder.detach();
  } finally { await f.managed.stop('test-cleanup'); }
});

test('responder remains usable across frontend restart but a reentrant final guard cannot settle', async () => {
  const f = commandFixture(); await f.managed.start();
  try {
    const observed: unknown[] = [];
    f.managed.observePendingRequests(f.adapterKey, event => observed.push(event.request.id), () => {});
    const restarting = f.managed.restartFrontend();
    f.child.send({ id: 'restart-answer', method: 'item/tool/requestUserInput', params: { threadId: taskId, questions: [] } });
    assert.deepEqual(observed, ['restart-answer']);
    const responder = f.managed.createRequestResponder(f.controlKey);
    assert.equal(responder.answer('restart-answer', { answers: {} }), true);
    await restarting;
    f.child.send({ id: 'reentrant-answer', method: 'item/tool/requestUserInput', params: { threadId: taskId, questions: [] } });
    await new Promise(resolve => setImmediate(resolve));
    const revoked = f.managed.createRequestResponder(f.controlKey, () => { void f.managed.stop('owner-request'); return true; });
    assert.equal(revoked.answer('reentrant-answer', { answers: {} }), false);
    await f.managed.stop('test-cleanup');
    responder.detach(); revoked.detach();
  } finally { await f.managed.stop('test-cleanup'); }
});

test('one backend and one handler survive listener restart; old capability and answer fail', async () => {
  const child = new Child(); const key = {};
  const fixture = host(child, key); const managed = fixture.managed;
  const firstStart = managed.start();
  assert.strictEqual(managed.start(), firstStart);
  await firstStart;
  assert.equal(fixture.launches, 1);
  assert.equal(child.messages.filter(frame => frame.method === 'initialize').length, 1);
  assert.throws(() => managed.frontendCapability({}), TypeError);
  const oldCap = managed.frontendCapability(key);
  child.send({ id: 'question', method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } });
  await new Promise(resolve => setImmediate(resolve));
  const old = await client(oldCap);
  old.send({ id: 1, method: 'initialize', params: init });
  assert.equal((await old.next()).id, 1);
  assert.equal((await old.next()).id, 'question');
  const restartA = managed.restartFrontend();
  assert.strictEqual(managed.restartFrontend(), restartA);
  await restartA;
  const newCap = managed.frontendCapability(key);
  assert.notEqual(newCap.token, oldCap.token);
  assert.equal(child.stdin.writableEnded, false);
  if (!old.socket.destroyed) await once(old.socket, 'close');
  assert.equal(old.socket.destroyed, true);
  const stale = connect({ host: newCap.host, port: newCap.port });
  stale.on('error', () => {}); await once(stale, 'connect');
  stale.write(`${JSON.stringify({ token: oldCap.token })}\n`);
  await once(stale, 'close');
  const fresh = await client(newCap);
  fresh.send({ id: 2, method: 'initialize', params: init });
  assert.equal((await fresh.next()).id, 2);
  assert.equal((await fresh.next()).id, 'question');
  old.send({ id: 'question', result: { answers: {} } });
  fresh.send({ id: 'question', result: { answers: {} } });
  for (let attempt = 0; attempt < 30 &&
    !child.messages.some(frame => frame.id === 'question' && frame.result !== undefined); attempt++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(child.messages.filter(frame => frame.id === 'question' && frame.result !== undefined).length, 1);
  assert.equal(fixture.launches, 1);
  fresh.close(); old.close();
  await managed.stop('test-cleanup');
});

test('frontend EOF does not stop worker or listener', async () => {
  const child = new Child(); const key = {}; const fixture = host(child, key);
  await fixture.managed.start();
  const cap = fixture.managed.frontendCapability(key);
  const first = await client(cap);
  first.close(); await once(first.socket, 'close');
  assert.equal(fixture.managed.metadata.state, 'running');
  assert.equal(child.stdin.writableEnded, false);
  const second = await client(cap);
  second.close();
  await fixture.managed.stop('test-cleanup');
});

test('disconnect racing listener restart cannot resurrect a frontend', async () => {
  const child = new Child(); const key = {}; const fixture = host(child, key);
  await fixture.managed.start();
  const restart = fixture.managed.restartFrontend();
  child.disconnect();
  await assert.rejects(restart);
  assert.equal(fixture.managed.metadata.state, 'lost');
  assert.throws(() => fixture.managed.frontendCapability(key));
  assert.equal(fixture.launches, 1);
  await fixture.managed.stop('test-cleanup');
});

test('invalid construction policy rejects before launching any worker', () => {
  const child = new Child(); let launches = 0;
  assert.throws(() => new ManagedWorkerFrontendHost({ taskId: '', ownCwd: 'C:/own',
    initializeRequest: init, adapterKey: {}, bootstrapReadMethods: [],
    allowRequest: () => true, allowAnswer: () => true,
    launch: () => { launches++; return child.asChild(); } }), TypeError);
  assert.equal(launches, 0);
  assert.equal(child.stdin.writableEnded, false);
  assert.throws(() => new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: init, adapterKey: {}, bootstrapReadMethods: ['turn/start'],
    allowRequest: () => true, allowAnswer: () => true,
    launch: () => { launches++; return child.asChild(); } }));
  const circular: Frame = { clientInfo: {}, capabilities: {} }; circular.self = circular;
  assert.throws(() => new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: circular, adapterKey: {}, bootstrapReadMethods: [],
    allowRequest: () => true, allowAnswer: () => true,
    launch: () => { launches++; return child.asChild(); } }), TypeError);
  assert.equal(launches, 0);
});

test('launch is captured at construction before caller can change options', async () => {
  const original = new Child(); const replacement = new Child(); let originalLaunches = 0;
  const options = { taskId, ownCwd: 'C:/own', initializeRequest: init,
    adapterKey: {}, bootstrapReadMethods: [],
    allowRequest: () => true, allowAnswer: () => true,
    launch: () => { originalLaunches++; return original.asChild(); } };
  const managed = new ManagedWorkerFrontendHost(options);
  options.launch = () => replacement.asChild();
  await managed.start();
  assert.equal(originalLaunches, 1);
  assert.equal(replacement.messages.length, 0);
  await managed.stop('test-cleanup');
});

test('worker generation loss retires listener and cannot relaunch', async () => {
  const child = new Child(); const key = {}; const fixture = host(child, key);
  await fixture.managed.start();
  const connected = await client(fixture.managed.frontendCapability(key));
  child.disconnect();
  await once(connected.socket, 'close');
  assert.equal(fixture.managed.metadata.state, 'lost');
  await assert.rejects(fixture.managed.start());
  await assert.rejects(fixture.managed.restartFrontend());
  assert.equal(fixture.launches, 1);
  await fixture.managed.stop('test-cleanup');
});

test('explicit stop closes owned child and leaves unrelated worker running', async () => {
  const child = new Child(); const unrelated = new Child();
  const other = new AppServerConnection(() => unrelated.asChild(), init);
  const otherSession = await other.initializedSession();
  const fixture = host(child, {}); await fixture.managed.start();
  await fixture.managed.stop('owner-request');
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(other.isSessionCurrent(otherSession.generation), true);
  assert.equal(unrelated.stdin.writableEnded, false);
  await other.close();
});

test('listen failure remains visible and never retries or silently stops worker', async () => {
  const occupied = createServer(); occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  const child = new Child(); const fixture = host(child, {}, address.port);
  try {
    const start = fixture.managed.start();
    await assert.rejects(start);
    await assert.rejects(fixture.managed.start());
    assert.equal(fixture.launches, 1);
    assert.equal(child.stdin.writableEnded, false);
    assert.equal(fixture.managed.metadata.state, 'frontend-unavailable');
  } finally {
    await fixture.managed.stop('test-cleanup');
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});

test('explicit listener recovery after port failure retains worker generation', async () => {
  const occupied = createServer(); occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  const child = new Child(); const key = {}; const fixture = host(child, key, address.port);
  try {
    const initial = fixture.managed.start();
    await assert.rejects(initial);
    await assert.rejects(fixture.managed.start());
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await fixture.managed.restartFrontend();
    await fixture.managed.start();
    assert.equal(fixture.launches, 1);
    assert.equal(child.messages.filter(frame => frame.method === 'initialize').length, 1);
    const frontend = await client(fixture.managed.frontendCapability(key));
    frontend.send({ id: 1, method: 'initialize', params: init });
    assert.equal((await frontend.next()).id, 1);
    frontend.send({ id: 2, method: 'thread/read', params: { threadId: taskId } });
    assert.equal((await frontend.next()).id, 2);
    frontend.close();
  } finally {
    await fixture.managed.stop('test-cleanup');
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});

test('explicit stop promptly cancels an unanswered worker initialize', async () => {
  const child = new Child(); child.autoInitialize = false;
  const managed = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: init, adapterKey: {}, bootstrapReadMethods: [],
    backendTimeoutMs: 5_000, allowRequest: () => true, allowAnswer: () => true,
    launch: () => child.asChild() });
  const startup = managed.start();
  const startupRejected = assert.rejects(startup);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.messages.filter(frame => frame.method === 'initialize').length, 1);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([managed.stop('test-cleanup'), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('stop waited for initialize timeout')), 1_000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
  await startupRejected;
  assert.equal(managed.metadata.state, 'stopped');
  assert.equal(child.stdin.writableEnded, true);
});

test('explicit stop during startup cannot publish a late listener', async () => {
  const child = new Child(); child.autoInitialize = false;
  const key = {}; const fixture = host(child, key);
  const start = fixture.managed.start();
  await new Promise(resolve => setImmediate(resolve));
  const stop = fixture.managed.stop('test-cleanup');
  const request = child.messages.find(frame => frame.method === 'initialize');
  assert.ok(request);
  child.send({ id: request.id, result: { serverInfo: { name: 'fixture' } } });
  await assert.rejects(start);
  await stop;
  assert.equal(fixture.managed.metadata.state, 'stopped');
  assert.throws(() => fixture.managed.frontendCapability(key));
  assert.equal(fixture.launches, 1);
});

function commandFixture(timeout = 100, enableSettings = false,
  qualifier?: WorkerCommandPolicy['qualifySettingsEffect'],
  settingsModel = 'qualified-settings-model', scopedTaskId = taskId,
  settingsAuthorizer?: WorkerCommandPolicy['authorizeSettings']) {
  const child = new Child(); const adapterKey = {}; const controlKey = {};
  const directory = mkdtempSync(path.join(tmpdir(), 'vkodex-command-host-'));
  const journalPath = path.join(directory, 'operations.sqlite');
  const authority = { current: true, admit: true, onAuthorize: () => {} };
  const policy: WorkerCommandPolicy = { controlKey, ownerEpoch: randomUUID(), journalPath,
    fingerprintKey: randomBytes(32), isOwnerCurrent: () => authority.current,
    authorize: ({ params }) => {
      authority.onAuthorize();
      return authority.admit && params.model === 'qualified-fixture-model';
    }, ...(enableSettings ? { authorizeSettings: settingsAuthorizer ??
      (({ params }: { params: Record<string, unknown> }) =>
        authority.admit && params.model === settingsModel) } : {}),
    ...(qualifier ? { qualifySettingsEffect: qualifier } : {}) };
  const managed = new ManagedWorkerFrontendHost({ taskId: scopedTaskId, ownCwd: 'C:/own',
    initializeRequest: init, adapterKey, bootstrapReadMethods: [], backendTimeoutMs: timeout,
    allowRequest: () => true, allowAnswer: () => true, commandPolicy: policy,
    launch: () => child.asChild() });
  const command: WorkerCommand = { operationId: randomUUID(), method: 'turn/start',
    params: { threadId: taskId, clientUserMessageId: randomUUID(), model: 'qualified-fixture-model',
      input: [{ type: 'text', text: `private-marker-${randomUUID()}` }] } };
  return { managed, child, controlKey, adapterKey, command, journalPath, authority, policy };
}

test('settings mutation is opt-in, ACK is durable but never a receipt or effective-state confirmation', async () => {
  const denied = commandFixture(200);
  await denied.managed.start();
  const settings = { operationId: randomUUID(), method: 'thread/settings/update' as const,
    params: { threadId: taskId, model: 'qualified-settings-model', effort: 'low',
      collaborationMode: { mode: 'default', settings: { model: 'qualified-settings-model',
        reasoning_effort: 'low', developer_instructions: 'PRIVATE_SETTINGS_MARKER_9048' } } } };
  try {
    assert.throws(() => denied.managed.executeSettingsCommand(denied.controlKey, settings), /authority|policy/i);
    assert.equal(denied.child.messages.some(frame => frame.method === 'thread/settings/update'), false);
  } finally { await denied.managed.stop('test-cleanup'); }

  const f = commandFixture(200, true); await f.managed.start();
  try {
    const pending = f.managed.executeSettingsCommand(f.controlKey, settings);
    const wire = await sentMutation(f.child, 'thread/settings/update');
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 1, unconfirmed: true });
    f.child.send({ id: wire.id, result: {} });
    const result = await pending;
    assert.equal(result.state, 'unknown');
    assert.equal(result.rpcAck, true);
    assert.equal(Object.hasOwn(result, 'receiptId'), false);
    assert.deepEqual(f.managed.acceptedCommandReceipts(f.controlKey), []);
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: true });
    assert.deepEqual(f.managed.settingsCommandStatus(f.controlKey, settings.operationId), result);
    assert.throws(() => f.managed.settingsCommandStatus({}, settings.operationId), /control/i);
    assert.deepEqual(await f.managed.executeSettingsCommand(f.controlKey, settings), result);
    assert.equal(f.child.messages.filter(frame => frame.method === 'thread/settings/update').length, 1);
    assert.throws(() => f.managed.executeCommand(f.controlKey, f.command), /unsettled/i);
    for (const file of [f.journalPath, `${f.journalPath}-wal`]) if (existsSync(file))
      assert.equal(readFileSync(file).includes('PRIVATE_SETTINGS_MARKER_9048'), false);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('late settings ACK after timeout changes only ack bit and never unblocks another mutation', async () => {
  const f = commandFixture(20, true); await f.managed.start();
  const settings = { operationId: randomUUID(), method: 'thread/settings/update' as const,
    params: { threadId: taskId, model: 'qualified-settings-model', effort: 'low' } };
  try {
    const pending = f.managed.executeSettingsCommand(f.controlKey, settings);
    const wire = await sentMutation(f.child, 'thread/settings/update');
    const timedOut = await pending;
    assert.equal(timedOut.state, 'unknown');
    assert.equal(timedOut.rpcAck, false);
    f.child.send({ id: wire.id, result: {} });
    await new Promise(resolve => setImmediate(resolve));
    const late = f.managed.settingsCommandStatus(f.controlKey, settings.operationId);
    assert.equal(late?.rpcAck, true);
    assert.equal(late?.state, 'unknown');
    assert.deepEqual(f.managed.acceptedCommandReceipts(f.controlKey), []);
    assert.throws(() => f.managed.executeCommand(f.controlKey, f.command), /unsettled/i);
  } finally { await f.managed.stop('test-cleanup'); }
});

function effectiveSettings() {
  return { cwd: 'C:/own', runtimeWorkspaceRoots: ['C:/own'], approvalPolicy: 'never',
    approvalsReviewer: null, permissions: 'read-only', sandboxPolicy: { type: 'readOnly' },
    model: 'qualified-settings-model', serviceTier: null, effort: 'low', summary: null,
    collaborationMode: null, personality: null };
}

test('settings confirmation requires a trusted fresh full tuple and never creates a native receipt', async () => {
  let calls = 0, revision = 1;
  const f = commandFixture(200, true, async (context, assertCurrent) => {
    calls++; assertCurrent();
    assert.equal(context.params.model, 'qualified-settings-model');
    assert.equal(Object.isFrozen(context), true);
    const observed = revision;
    return { effectiveSettings: effectiveSettings(), assertCurrent: () => {
      if (revision !== observed) throw new Error('notification revision changed');
    } };
  });
  await f.managed.start();
  const settings = { operationId: randomUUID(), method: 'thread/settings/update' as const,
    params: { threadId: taskId, model: 'qualified-settings-model', effort: 'low' } };
  try {
    assert.throws(() => f.managed.confirmSettingsCommand(f.controlKey, settings), /conflict/i);
    const pending = f.managed.executeSettingsCommand(f.controlKey, settings);
    const wire = await sentMutation(f.child, 'thread/settings/update');
    assert.throws(() => f.managed.confirmSettingsCommand(f.controlKey, settings), /unavailable/i);
    f.child.send({ id: wire.id, result: {} });
    await pending;
    const confirmed = await f.managed.confirmSettingsCommand(f.controlKey, settings);
    assert.equal(confirmed.state, 'confirmed');
    assert.match(confirmed.effectiveFingerprint ?? '', /^[a-f0-9]{64}$/);
    assert.equal(calls, 1);
    assert.deepEqual(await f.managed.confirmSettingsCommand(f.controlKey, settings), confirmed);
    assert.equal(calls, 1);
    assert.deepEqual(f.managed.acceptedCommandReceipts(f.controlKey), []);
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: false });
    assert.equal(f.child.messages.filter(frame => frame.method === 'thread/settings/update').length, 1);
    assert.throws(() => f.managed.confirmSettingsCommand(f.controlKey,
      { ...settings, params: { ...settings.params, effort: 'high' } }), /conflict/i);
    revision++;
  } finally { await f.managed.stop('test-cleanup'); }
});

test('effect observation drift and missing verifier leave ACKed settings unknown', async () => {
  let release!: () => void; let revision = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = commandFixture(200, true, async (_context, assertCurrent) => {
    assertCurrent(); const observed = revision; await gate;
    return { effectiveSettings: effectiveSettings(), assertCurrent: () => {
      if (revision !== observed) throw new Error('effect revision drift');
    } };
  });
  await f.managed.start();
  const settings = { operationId: randomUUID(), method: 'thread/settings/update' as const,
    params: { threadId: taskId, model: 'qualified-settings-model', effort: 'low' } };
  try {
    const pending = f.managed.executeSettingsCommand(f.controlKey, settings);
    const wire = await sentMutation(f.child, 'thread/settings/update');
    f.child.send({ id: wire.id, result: {} }); await pending;
    const confirmation = f.managed.confirmSettingsCommand(f.controlKey, settings);
    assert.throws(() => f.managed.executeCommand(f.controlKey, f.command), /reentrant/i);
    revision++; release();
    await assert.rejects(confirmation, /drift/i);
    assert.equal(f.managed.settingsCommandStatus(f.controlKey, settings.operationId)?.state, 'unknown');
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: true });
  } finally { release(); await f.managed.stop('test-cleanup'); }
});

test('missing qualifier and incomplete effective tuple cannot clear durable uncertainty', async () => {
  let tuple: unknown = { ...effectiveSettings(), personality: undefined };
  let verified = 0;
  const f = commandFixture(200, true, async () => ({
    effectiveSettings: tuple as ReturnType<typeof effectiveSettings>,
    assertCurrent: () => { verified++; },
  }));
  await f.managed.start();
  const settings = { operationId: randomUUID(), method: 'thread/settings/update' as const,
    params: { threadId: taskId, model: 'qualified-settings-model', effort: 'low' } };
  try {
    const pending = f.managed.executeSettingsCommand(f.controlKey, settings);
    const wire = await sentMutation(f.child, 'thread/settings/update');
    f.child.send({ id: wire.id, result: {} }); await pending;
    await assert.rejects(f.managed.confirmSettingsCommand(f.controlKey, settings), /strict JSON/i);
    assert.equal(verified, 0);
    assert.equal(f.managed.settingsCommandStatus(f.controlKey, settings.operationId)?.state, 'unknown');
    tuple = Object.defineProperty(effectiveSettings(), 'hidden', { value: 1 });
    await assert.rejects(f.managed.confirmSettingsCommand(f.controlKey, settings), /strict JSON/i);
    assert.equal(verified, 0);
    tuple = effectiveSettings();
    assert.equal((await f.managed.confirmSettingsCommand(f.controlKey, settings)).state, 'confirmed');
    assert.equal(verified, 1);
  } finally { await f.managed.stop('test-cleanup'); }

  const noQualifier = commandFixture(200, true); await noQualifier.managed.start();
  try {
    const next = { ...settings, operationId: randomUUID() };
    const pending = noQualifier.managed.executeSettingsCommand(noQualifier.controlKey, next);
    const wire = await sentMutation(noQualifier.child, 'thread/settings/update');
    noQualifier.child.send({ id: wire.id, result: {} }); await pending;
    assert.throws(() => noQualifier.managed.confirmSettingsCommand(noQualifier.controlKey, next), /unavailable/i);
    assert.equal(noQualifier.managed.commandQuiescence(noQualifier.controlKey).unconfirmed, true);
  } finally { await noQualifier.managed.stop('test-cleanup'); }
});

test('owner loss during effect read cannot confirm an ACKed settings operation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = commandFixture(200, true, async (_context, assertCurrent) => {
    assertCurrent(); await gate;
    return { effectiveSettings: effectiveSettings(), assertCurrent: () => {} };
  });
  await f.managed.start();
  const settings = { operationId: randomUUID(), method: 'thread/settings/update' as const,
    params: { threadId: taskId, model: 'qualified-settings-model', effort: 'low' } };
  try {
    const pending = f.managed.executeSettingsCommand(f.controlKey, settings);
    const wire = await sentMutation(f.child, 'thread/settings/update');
    f.child.send({ id: wire.id, result: {} }); await pending;
    const confirmation = f.managed.confirmSettingsCommand(f.controlKey, settings);
    f.authority.current = false; release();
    await assert.rejects(confirmation, /changed/i);
    assert.equal(f.managed.settingsCommandStatus(f.controlKey, settings.operationId)?.state, 'unknown');
    assert.equal(f.managed.commandQuiescence(f.controlKey).unconfirmed, true);
  } finally { release(); await f.managed.stop('test-cleanup'); }
});

function stockInitializerFixture(noticeTimeoutMs = 100) {
  const scopedTaskId = randomUUID(), operationId = randomUUID(), cwd = 'C:/own';
  const profile = { id: ':danger-full-access', extends: null };
  const approvedTaskPolicy = approveTaskPolicy({ threadId: scopedTaskId,
    model: 'gpt-5.6-sol', modelProvider: 'openai', effort: 'medium', cwd,
    runtimeWorkspaceRoots: [cwd], environments: [], approvalPolicy: 'never',
    approvalsReviewer: 'user', activePermissionProfile: profile,
    sandbox: { type: 'dangerFullAccess' }, serviceTier: null });
  const initialState = { id: scopedTaskId, hostId: 'local', turns: [], requests: [], cwd,
    currentPermissions: { activePermissionProfile: profile,
      sandboxPolicy: approvedTaskPolicy.sandbox, runtimeWorkspaceRoots: [cwd],
      approvalPolicy: 'never', approvalsReviewer: 'user' },
    latestThreadSettings: { cwd, model: approvedTaskPolicy.model,
      modelProvider: 'openai', effort: 'medium',
      collaborationMode: { mode: 'default', settings: { model: approvedTaskPolicy.model,
        reasoning_effort: 'medium', developer_instructions: null } }, serviceTier: null },
    latestModel: approvedTaskPolicy.model, latestReasoningEffort: 'medium',
    modelProvider: 'openai', latestCollaborationMode: { mode: 'default', settings: {
      model: approvedTaskPolicy.model, reasoning_effort: 'medium', developer_instructions: null } },
    previousTurnModel: null, title: null, threadRuntimeStatus: { type: 'idle' },
    latestTokenUsageInfo: null, hasUnreadTurn: false, updatedAt: 1,
    turnsPagination: { hasLoadedOldest: true, olderCursor: null }, environments: [],
  } as NativeProjectionState;
  let initializer!: ManagedStockSettingsInitializer;
  const f = commandFixture(200, true,
    (context, assertCurrent) => initializer.qualifySettingsEffect(context, assertCurrent),
    approvedTaskPolicy.model, scopedTaskId, context => initializer.authorizesSettingsCommand(context));
  const bootstrap = { generation: 1, initialState,
    composerDefaults: { taskId: scopedTaskId, cwd, summary: null,
      personality: 'pragmatic' as const },
    async readStockState(assertCurrent: () => void) {
      assertCurrent();
      return { threadId: scopedTaskId, generation: 1, turnCount: 0, terminalTurnIds: [],
        historyDigest: 'a'.repeat(64), model: approvedTaskPolicy.model,
        modelProvider: 'openai', reasoningEffort: 'medium', cwd, environments: [],
        updatedAt: 1, fastModeAllowed: false };
    } };
  initializer = createManagedStockSettingsInitializer({ host: f.managed,
    adapterKey: f.adapterKey, controlKey: f.controlKey, bootstrap, taskId: scopedTaskId,
    ownerEpoch: f.policy.ownerEpoch, operationId, approvedTaskPolicy,
    assertOwnerCurrent: () => { if (!f.authority.current) throw new Error('owner lost'); },
    noticeTimeoutMs });
  const nativeSettings = { cwd, model: approvedTaskPolicy.model, modelProvider: 'openai',
    effort: 'medium', activePermissionProfile: profile,
    sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
    approvalsReviewer: 'user', serviceTier: null, summary: null, personality: 'pragmatic',
    disabledPluginIds: [], multiAgentMode: 'explicitRequestOnly',
    collaborationMode: { mode: 'default', settings: { model: approvedTaskPolicy.model,
      reasoning_effort: 'medium', developer_instructions: 'built-in instructions' } } };
  return { ...f, scopedTaskId, operationId, initializer, nativeSettings };
}

test('stock initializer uses actual managed host wire, notification, journal ACK and effect CAS', async () => {
  const f = stockInitializerFixture(); await f.managed.start();
  try {
    const work = f.initializer.initialize();
    const wire = await sentMutation(f.child, 'thread/settings/update');
    f.child.send({ method: 'thread/settings/updated', params: {
      threadId: f.scopedTaskId, threadSettings: f.nativeSettings } });
    f.child.send({ id: wire.id, result: {} });
    const result = await work;
    assert.equal(result.effectiveSettings.model, 'gpt-5.6-sol');
    assert.equal(result.initializationReceipt?.expansionKind, 'builtin-default-instructions');
    const durable = f.managed.settingsCommandStatus(f.controlKey, f.operationId);
    assert.equal(durable?.state, 'confirmed');
    assert.equal(durable.rpcAck, true);
    assert.match(durable.effectiveFingerprint ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual(f.managed.acceptedCommandReceipts(f.controlKey), []);
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: false });
    const exact = { operationId: f.operationId, method: 'thread/settings/update' as const,
      params: wire.params as Record<string, unknown> };
    assert.equal((await f.managed.executeSettingsCommand(f.controlKey, exact)).state, 'confirmed');
    assert.deepEqual(f.child.messages.filter(frame => frame.method === 'thread/settings/update').length, 1);
    assert.equal(f.child.messages.some(frame => frame.method === 'turn/start' ||
      frame.method === 'thread/queue/add'), false);
  } finally { f.initializer.close(); await f.managed.stop('test-cleanup'); }
});

test('stock initializer cannot turn settings ACK without notice into confirmation or replay', async () => {
  const f = stockInitializerFixture(20); await f.managed.start();
  try {
    const work = f.initializer.initialize();
    const wire = await sentMutation(f.child, 'thread/settings/update');
    f.child.send({ id: wire.id, result: {} });
    await assert.rejects(work, /notification unavailable/i);
    const durable = f.managed.settingsCommandStatus(f.controlKey, f.operationId);
    assert.equal(durable?.state, 'unknown');
    assert.equal(durable.rpcAck, true);
    assert.equal(durable.effectiveFingerprint, null);
    assert.equal(f.managed.commandQuiescence(f.controlKey).unconfirmed, true);
    assert.deepEqual(f.managed.acceptedCommandReceipts(f.controlKey), []);
    const exact = { operationId: f.operationId, method: 'thread/settings/update' as const,
      params: wire.params as Record<string, unknown> };
    assert.equal((await f.managed.executeSettingsCommand(f.controlKey, exact)).state, 'unknown');
    assert.equal(f.child.messages.filter(frame => frame.method === 'thread/settings/update').length, 1);
  } finally { f.initializer.close(); await f.managed.stop('test-cleanup'); }
});

test('settings before-write lease revocation persists unknown without a backend write', async () => {
  const f = commandFixture(200, true); await f.managed.start();
  const settings = { operationId: randomUUID(), method: 'thread/settings/update' as const,
    params: { threadId: taskId, model: 'qualified-settings-model', effort: 'low' } };
  let lease = true, checks = 0;
  try {
    const pending = f.managed.executeSettingsCommand(f.controlKey, settings, () => {
      checks++;
      if (!lease) throw new Error('settings lease revoked');
    });
    lease = false;
    const outcome = await pending;
    assert.equal(outcome.state, 'unknown'); assert.equal(outcome.rpcAck, false);
    assert.equal(checks, 2);
    assert.equal(f.child.messages.some(frame => frame.method === 'thread/settings/update'), false);
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: true });
  } finally { await f.managed.stop('test-cleanup'); }
});

test('command quiescence is authenticated, read-only and distinguishes in-flight from durable unknown', async () => {
  const noPolicy = host(new Child(), {});
  await noPolicy.managed.start();
  try { assert.throws(() => noPolicy.managed.commandQuiescence({}), /unavailable/i); }
  finally { await noPolicy.managed.stop('test-cleanup'); }

  const f = commandFixture(20); await f.managed.start();
  let policyCalls = 0; f.authority.onAuthorize = () => { policyCalls++; };
  try {
    assert.throws(() => f.managed.commandQuiescence({}), /control/i);
    const fresh = f.managed.commandQuiescence(f.controlKey);
    assert.deepEqual(fresh, { inFlight: 0, unconfirmed: false });
    assert.equal(Object.isFrozen(fresh), true);
    assert.equal(policyCalls, 0);
    const pending = f.managed.executeCommand(f.controlKey, f.command);
    await sentMutation(f.child);
    const wireCount = f.child.messages.length, admittedCalls = policyCalls;
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 1, unconfirmed: true });
    assert.equal(f.child.messages.length, wireCount);
    assert.equal(policyCalls, admittedCalls);
    assert.equal((await pending).state, 'unknown');
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: true });
    f.child.send({ id: f.child.messages.find(frame => frame.method === 'turn/start')!.id,
      result: { turn: { id: 'late-accepted' } } });
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: false });
    assert.throws(() => f.managed.acceptedCommandReceipts({}), /control/i);
    const receipts = f.managed.acceptedCommandReceipts(f.controlKey);
    assert.deepEqual(receipts, [{ method: 'turn/start', receiptId: 'late-accepted' }]);
    assert.equal(Object.isFrozen(receipts), true);
    assert.equal(f.child.messages.length, wireCount);
    assert.equal(policyCalls, admittedCalls);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('command client identity lookup is authenticated, bounded and read-only across acceptance', async () => {
  const f = commandFixture(2000); await f.managed.start();
  let authorizationCalls = 0;
  f.authority.onAuthorize = () => { authorizationCalls++; };
  const clientId = f.command.params.clientUserMessageId as string;
  try {
    assert.equal(f.managed.hasCommandClientIdentity(f.controlKey, clientId), false);
    assert.throws(() => f.managed.hasCommandClientIdentity({}, clientId), /control/i);
    for (const invalid of ['', ' leading', 'trailing ', 'bad\nvalue', 'x'.repeat(129)]) {
      assert.throws(() => f.managed.hasCommandClientIdentity(f.controlKey, invalid), /client/i);
    }
    assert.equal(authorizationCalls, 0);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 0);

    const pending = f.managed.executeCommand(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    const authorizedWrites = authorizationCalls;
    assert.equal(f.managed.hasCommandClientIdentity(f.controlKey, clientId), true);
    assert.ok(authorizedWrites > 0);
    assert.equal(authorizationCalls, authorizedWrites);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
    f.child.send({ id: request.id, result: { turn: { id: 'identity-receipt' } } });
    assert.equal((await pending).state, 'accepted');
    assert.equal(f.managed.hasCommandClientIdentity(f.controlKey, clientId), true);
    assert.equal(authorizationCalls, authorizedWrites);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('request quiescence is control-key scoped and generation fenced', async () => {
  const f = commandFixture(2000); await f.managed.start();
  try {
    assert.throws(() => f.managed.requestQuiescence({}), /control|unavailable/i);
    const initial = f.managed.requestQuiescence(f.controlKey);
    assert.deepEqual(initial, { generation: 1, unresolved: 0 });
    assert.equal(Object.isFrozen(initial), true);
    f.child.send({ id: 'pending-proof', method: 'item/tool/requestUserInput',
      params: { threadId: taskId, questions: [] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.managed.requestQuiescence(f.controlKey), { generation: 1, unresolved: 1 });
    const responder = f.managed.createRequestResponder(f.controlKey);
    assert.equal(responder.answer('pending-proof', { answers: {} }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.managed.requestQuiescence(f.controlKey), { generation: 1, unresolved: 0 });
    responder.detach();
    f.child.disconnect();
    assert.throws(() => f.managed.requestQuiescence(f.controlKey), /unavailable|generation/i);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('validated rejection clears command quiescence without a backend read', async () => {
  const f = commandFixture(2000); await f.managed.start();
  try {
    const pending = f.managed.executeCommand(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 1, unconfirmed: true });
    f.child.send({ id: request.id, error: { code: -32602, message: 'invalid params' } });
    assert.equal((await pending).state, 'rejected');
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: false });
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('real final pre-wire lease refusal is durably rejected with no worker frame or hidden replay', async () => {
  const f = commandFixture(200); await f.managed.start();
  try {
    let checks = 0;
    const denied = await f.managed.executeCommandWithResponse(f.controlKey, f.command, () => {
      if (++checks === 2) throw new Error('lease-revoked-before-write');
    });
    assert.equal(checks, 2);
    assert.equal(denied.operation.state, 'rejected');
    assert.equal(denied.operation.rejectionCode, null);
    assert.equal(denied.response, null);
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: false });
    assert.equal(f.child.messages.some(frame => frame.method === 'turn/start'), false);
    assert.equal((await f.managed.executeCommandWithResponse(f.controlKey, f.command)).operation.state, 'rejected');
    assert.equal(f.child.messages.some(frame => frame.method === 'turn/start'), false);
    const next = { ...f.command, operationId: randomUUID(), params: { ...f.command.params,
      clientUserMessageId: randomUUID() } };
    const running = f.managed.executeCommandWithResponse(f.controlKey, next);
    const frame = await sentMutation(f.child);
    f.child.send({ id: frame.id, result: { turn: { id: 'next-real-turn' } } });
    assert.equal((await running).operation.receiptId, 'next-real-turn');
  } finally { await f.managed.stop('test-cleanup'); }
});

test('a written mutation without a response remains unknown and blocks a new command', async () => {
  const f = commandFixture(20); await f.managed.start();
  try {
    const work = f.managed.executeCommandWithResponse(f.controlKey, f.command);
    await sentMutation(f.child);
    const outcome = await work;
    assert.equal(outcome.operation.state, 'unknown');
    assert.equal(outcome.response, null);
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: true });
    const next = { ...f.command, operationId: randomUUID(), params: { ...f.command.params,
      clientUserMessageId: randomUUID() } };
    assert.throws(() => f.managed.executeCommandWithResponse(f.controlKey, next), /unsettled/i);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});
async function sentMutation(child: Child, method = 'turn/start', occurrence = 1): Promise<Frame> {
  for (let tries = 0; tries < 50; tries++) {
    const frame = child.messages.filter(value => value.method === method)[occurrence - 1];
    if (frame) return frame;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('mutation-not-written');
}

test('owner command receipt survives frontend restart and duplicates never dispatch again', async () => {
  const f = commandFixture(2000);
  await f.managed.start();
  try {
    assert.throws(() => f.managed.executeCommand({}, f.command), /control/i);
    const running = f.managed.executeCommand(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    assert.equal(f.managed.commandStatus(f.controlKey, f.command.operationId)?.state, 'dispatching');
    await f.managed.restartFrontend();
    f.child.send({ id: request.id, result: { turn: { id: 'real-turn' } } });
    assert.equal((await running).receiptId, 'real-turn');
    f.authority.admit = false; // Starting another turn is now inadmissible.
    const duplicate = await f.managed.executeCommand(f.controlKey, f.command);
    assert.equal(duplicate.state, 'accepted');
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.child.messages.filter(frame => frame.method === 'initialize').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('read-only attested command lookup never reserves or authorizes a fresh write', async () => {
  const f = commandFixture(2000); await f.managed.start();
  let policyCalls = 0; f.authority.onAuthorize = () => { policyCalls++; };
  try {
    assert.equal(f.managed.commandStatusForIntent(f.controlKey, f.command), null);
    assert.equal(policyCalls, 0);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 0);
    const pending = f.managed.executeCommand(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    f.child.send({ id: request.id, result: { turn: { id: 'attested-turn' } } });
    assert.equal((await pending).state, 'accepted');
    const before = f.child.messages.filter(frame => frame.method === 'turn/start').length;
    f.authority.admit = false;
    const found = f.managed.commandStatusForIntent(f.controlKey, f.command);
    assert.equal(found?.state, 'accepted'); assert.equal(found?.receiptId, 'attested-turn');
    assert.equal(policyCalls, 2); // Lookup is not a fresh authorization.
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, before);
    assert.throws(() => f.managed.commandStatusForIntent(f.controlKey, { ...f.command,
      params: { ...f.command.params, input: [{ type: 'text', text: 'changed' }] } }), /intent conflict/i);
    assert.throws(() => f.managed.commandStatusForIntent(f.controlKey, { ...f.command,
      params: { ...f.command.params, approvalPolicy: 'changed' } }), /intent conflict/i);
    assert.throws(() => f.managed.commandStatusForIntent({}, f.command), /control/i);
    assert.equal(f.managed.commandStatusForIntent(f.controlKey, { ...f.command, operationId: randomUUID(),
      params: { ...f.command.params, clientUserMessageId: randomUUID() } }), null);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, before);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('timeout is durable unknown, late receipt settles once without a second model turn', async () => {
  const f = commandFixture(20); await f.managed.start();
  try {
    const pending = f.managed.executeCommand(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    assert.equal((await pending).state, 'unknown');
    assert.equal((await f.managed.executeCommand(f.controlKey, f.command)).state, 'unknown');
    assert.throws(() => f.managed.executeCommand(f.controlKey, { ...f.command, operationId: randomUUID(),
      params: { ...f.command.params, clientUserMessageId: randomUUID() } }), /unresolved|unsettled|pending/i);
    f.child.send({ id: request.id, result: { turn: { id: 'late-turn' } } });
    const accepted = f.managed.commandStatus(f.controlKey, f.command.operationId);
    assert.equal(accepted?.state, 'accepted'); assert.equal(accepted?.receiptId, 'late-turn');
    f.child.send({ id: request.id, result: { turn: { id: 'duplicate-conflict' } } });
    assert.deepEqual(f.managed.commandStatus(f.controlKey, f.command.operationId), accepted);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.child.stdin.writableEnded, false);
    const raw = [f.journalPath, `${f.journalPath}-wal`].filter(existsSync)
      .map(file => readFileSync(file).toString()).join('');
    assert.equal(raw.includes((f.command.params.input as Array<{ text: string }>)[0]!.text), false);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('owner revoked before actual write is definitively rejected without closing the worker', async () => {
  const f = commandFixture(); await f.managed.start();
  try {
    const pending = f.managed.executeCommand(f.controlKey, f.command);
    f.authority.current = false;
    assert.equal((await pending).state, 'rejected');
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: false });
    assert.equal(f.child.messages.some(frame => frame.method === 'turn/start'), false);
    assert.equal(f.child.stdin.writableEnded, false);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('owner policy cannot reenter command admission before reservation or write', async () => {
  const f = commandFixture(2000); await f.managed.start();
  let checking = false; let checks = 0;
  f.authority.onAuthorize = () => {
    if (checking) return; // Bound the regression without overflowing the stack.
    checking = true;
    try {
      for (const operationId of [f.command.operationId, randomUUID()]) {
        assert.throws(() => f.managed.executeCommand(f.controlKey, { ...f.command, operationId }), /reentrant/i);
      }
      checks++;
    } finally { checking = false; }
  };
  try {
    const pending = f.managed.executeCommand(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    f.child.send({ id: request.id, result: { turn: { id: 'one-turn' } } });
    assert.equal((await pending).state, 'accepted');
    assert.equal(checks, 2); // Admission and immediately before the RPC write.
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('only validated receipts settle a command; internal errors remain unknown', async () => {
  for (const code of [-32602, -32603]) {
    const f = commandFixture(); await f.managed.start();
    try {
      const pending = f.managed.executeCommand(f.controlKey, f.command);
      const request = await sentMutation(f.child);
      f.child.send({ id: request.id, error: { code, message: 'private server detail' } });
      const result = await pending;
      assert.equal(result.state, code === -32602 ? 'rejected' : 'unknown');
      assert.equal(f.child.stdin.writableEnded, false);
    } finally { await f.managed.stop('test-cleanup'); }
  }
});

test('stock queue receipt requires exact client identity and input echo', async () => {
  for (const matching of [true, false]) {
    const f = commandFixture(); await f.managed.start();
    try {
      const command = { ...f.command, method: 'thread/queue/add' as const };
      const pending = f.managed.executeCommandWithResponse(f.controlKey, command);
      const request = await sentMutation(f.child, command.method);
      const native = { queuedSubmission: { id: 'queue-entry',
        clientUserMessageId: command.params.clientUserMessageId,
        input: matching ? command.params.input : [{ type: 'text', text: 'changed' }] },
        nativeExtra: { retained: true } };
      f.child.send({ id: request.id, result: native });
      const outcome = await pending;
      assert.equal(outcome.operation.state, matching ? 'accepted' : 'unknown');
      assert.deepEqual(outcome.response, matching ? native : null);
    } finally { await f.managed.stop('test-cleanup'); }
  }
});

test('stopping host settles in-flight command without losing its durable unknown state', async () => {
  const f = commandFixture(2000); await f.managed.start();
  const pending = f.managed.executeCommand(f.controlKey, f.command);
  await sentMutation(f.child);
  await f.managed.stop('test-cleanup');
  assert.equal((await pending).state, 'unknown');
  assert.throws(() => f.managed.commandStatus(f.controlKey, f.command.operationId), /control/i);
});

test('response relay preserves actual native fields, clone isolation and duplicate one-wire semantics', async () => {
  const f = commandFixture(2000); await f.managed.start();
  try {
    const first = f.managed.executeCommandWithResponse(f.controlKey, f.command);
    const duplicate = f.managed.executeCommandWithResponse(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    const native = { turn: { id: 'native-turn', status: 'inProgress' },
      extra: { nativeOnly: ['retained'] } };
    f.child.send({ id: request.id, result: native });
    const [a, b] = await Promise.all([first, duplicate]);
    assert.equal(a.operation.state, 'accepted');
    assert.deepEqual(a.response, native); assert.deepEqual(b.response, native);
    (a.response!.extra as { nativeOnly: string[] }).nativeOnly.push('mutation');
    assert.deepEqual(b.response, native);
    const third = await f.managed.executeCommandWithResponse(f.controlKey, f.command);
    assert.deepEqual(third.response, native);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
    assert.throws(() => f.managed.executeCommandWithResponse(f.controlKey,
      { ...f.command, params: { ...f.command.params, model: 'changed' } }), /conflict/i);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('response relay returns null while unknown and exact late native result after durable receipt', async () => {
  const f = commandFixture(20); await f.managed.start();
  try {
    const pending = f.managed.executeCommandWithResponse(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    const unknown = await pending;
    assert.equal(unknown.operation.state, 'unknown'); assert.equal(unknown.response, null);
    const native = { turn: { id: 'late-native' }, extra: { echoed: true } };
    f.child.send({ id: request.id, result: native });
    assert.equal(f.managed.commandStatus(f.controlKey, f.command.operationId)?.state, 'accepted');
    const duplicate = await f.managed.executeCommandWithResponse(f.controlKey, f.command);
    assert.deepEqual(duplicate.response, native);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('response relay never fabricates native success for rejected, malformed or failed persistence', async () => {
  for (const reply of [
    { error: { code: -32602, message: 'invalid params' } },
    { result: { turn: { id: 7 }, extra: 'untrusted' } },
  ]) {
    const f = commandFixture(); await f.managed.start();
    try {
      const pending = f.managed.executeCommandWithResponse(f.controlKey, f.command);
      const request = await sentMutation(f.child); f.child.send({ id: request.id, ...reply });
      const outcome = await pending;
      assert.equal(outcome.response, null);
      assert.equal(outcome.operation.state, 'error' in reply ? 'rejected' : 'unknown');
    } finally { await f.managed.stop('test-cleanup'); }
  }
  const f = commandFixture(); await f.managed.start();
  const db = new Database(f.journalPath);
  try {
    const pending = f.managed.executeCommandWithResponse(f.controlKey, f.command);
    const request = await sentMutation(f.child);
    db.exec(`CREATE TRIGGER deny_accept BEFORE UPDATE ON managed_worker_operations
      WHEN NEW.state = 'accepted' BEGIN SELECT RAISE(ABORT, 'deny accepted receipt'); END`);
    f.child.send({ id: request.id, result: { turn: { id: 'not-durable' }, extra: true } });
    const outcome = await pending;
    assert.equal(outcome.response, null);
    assert.notEqual(outcome.operation.state, 'accepted');
  } finally { db.close(); await f.managed.stop('test-cleanup'); }
});

test('response cache eviction and reopened journal never reconstruct native result from receipt ID', async () => {
  const f = commandFixture(2000); await f.managed.start();
  const first = f.command;
  try {
    for (let index = 0; index < 129; index++) {
      const command = index === 0 ? first : { ...first, operationId: randomUUID(),
        params: { ...first.params, clientUserMessageId: randomUUID() } };
      const pending = f.managed.executeCommandWithResponse(f.controlKey, command);
      let request: Frame | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        request = f.child.messages.find(frame => frame.method === 'turn/start' &&
          (frame.params as Frame)?.clientUserMessageId === command.params.clientUserMessageId);
        if (request) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.ok(request);
      f.child.send({ id: request.id, result: { turn: { id: `native-${index}` }, extra: index } });
      assert.equal((await pending).operation.state, 'accepted');
    }
    const evicted = await f.managed.executeCommandWithResponse(f.controlKey, first);
    assert.equal(evicted.operation.state, 'accepted'); assert.equal(evicted.response, null);
  } finally { await f.managed.stop('test-cleanup'); }
  const reopenedChild = new Child();
  const reopened = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: init, adapterKey: {}, bootstrapReadMethods: [],
    allowRequest: () => true, allowAnswer: () => true, commandPolicy: f.policy,
    launch: () => reopenedChild.asChild() });
  await reopened.start();
  try {
    const result = await reopened.executeCommandWithResponse(f.controlKey, first);
    assert.equal(result.operation.state, 'accepted'); assert.equal(result.response, null);
    assert.equal(reopenedChild.messages.some(frame => frame.method === 'turn/start'), false);
  } finally { await reopened.stop('test-cleanup'); }
});

test('scoped before-write fence revocation leaves a rejected journal entry without native write', async () => {
  const f = commandFixture(); await f.managed.start();
  let lease = true; let checks = 0;
  try {
    const pending = f.managed.executeCommandWithResponse(f.controlKey, f.command, () => {
      checks++;
      if (!lease) throw new Error('follower lease revoked');
    });
    lease = false;
    const outcome = await pending;
    assert.equal(outcome.operation.state, 'rejected'); assert.equal(outcome.response, null);
    assert.equal(outcome.operation.rejectionCode, null);
    assert.equal(checks, 2);
    assert.equal(f.child.messages.some(frame => frame.method === 'turn/start'), false);
    assert.equal(f.child.stdin.writableEnded, false);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('accepted duplicate validates intent but does not recheck the scoped lease callback', async () => {
  const f = commandFixture(); await f.managed.start();
  let checks = 0;
  try {
    const pending = f.managed.executeCommandWithResponse(f.controlKey, f.command,
      () => { checks++; });
    const request = await sentMutation(f.child);
    f.child.send({ id: request.id, result: { turn: { id: 'native-result' } } });
    assert.equal((await pending).operation.state, 'accepted');
    assert.equal(checks, 2);
    const duplicate = await f.managed.executeCommandWithResponse(f.controlKey, f.command,
      () => { throw new Error('duplicate callback must not run'); });
    assert.equal(duplicate.operation.state, 'accepted');
    assert.deepEqual(duplicate.response, { turn: { id: 'native-result' } });
    assert.throws(() => f.managed.executeCommandWithResponse(f.controlKey, f.command, 42 as never),
      /before.write|callback|function/i);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('host actual-write wrapper refuses before entry and leaves the backend usable', async () => {
  const f = commandFixture(); await f.managed.start();
  try {
    const outcome = await f.managed.executeCommandWithResponse(f.controlKey, f.command,
      undefined, () => { throw new Error('claim changed before write'); });
    assert.equal(outcome.operation.state, 'rejected');
    assert.equal(outcome.response, null);
    assert.equal(f.child.messages.some(frame => frame.method === 'turn/start'), false);
    assert.equal(f.managed.metadata.state, 'running');
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: false });
  } finally { await f.managed.stop('test-cleanup'); }
});

test('host preserves late acceptance after the write-scoped claim predicate changes', async () => {
  const f = commandFixture(15); await f.managed.start();
  let claimCurrent = true, wrappers = 0;
  const beforeWrite = () => { if (!claimCurrent) throw new Error('claim retired'); };
  try {
    const pending = f.managed.executeCommandWithResponse(f.controlKey, f.command, beforeWrite,
      write => { wrappers++; beforeWrite(); write(); claimCurrent = false; });
    const frame = await sentMutation(f.child);
    assert.equal((await pending).operation.state, 'unknown');
    f.child.send({ id: frame.id, result: { turn: { id: 'accepted-after-claim-change' } } });
    assert.equal(f.managed.commandStatus(f.controlKey, f.command.operationId)?.state, 'accepted');
    const duplicate = await f.managed.executeCommandWithResponse(f.controlKey, f.command,
      beforeWrite, () => { assert.fail('accepted intent must not write twice'); });
    assert.equal(duplicate.operation.receiptId, 'accepted-after-claim-change');
    assert.deepEqual(duplicate.response, { turn: { id: 'accepted-after-claim-change' } });
    assert.equal(wrappers, 1);
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
  } finally { await f.managed.stop('test-cleanup'); }
});

test('host post-write wrapper ambiguity retains unknown until exact late receipt', async () => {
  const f = commandFixture(); await f.managed.start();
  try {
    const pending = f.managed.executeCommandWithResponse(f.controlKey, f.command, undefined,
      write => { write(); throw new Error('claim commit ambiguous'); });
    const frame = await sentMutation(f.child);
    assert.equal((await pending).operation.state, 'unknown');
    assert.deepEqual(f.managed.commandQuiescence(f.controlKey), { inFlight: 0, unconfirmed: true });
    f.child.send({ id: frame.id, result: { turn: { id: 'exact-late-proof' } } });
    assert.equal(f.managed.commandStatus(f.controlKey, f.command.operationId)?.receiptId, 'exact-late-proof');
    assert.equal(f.child.messages.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(f.managed.metadata.state, 'running');
  } finally { await f.managed.stop('test-cleanup'); }
});
