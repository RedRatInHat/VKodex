import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ManagedWorkerRegistry } from '../src/codex/managed-worker-registry.js';
import Database from 'better-sqlite3';
import { DesktopIpcClient, encodeFrame, FrameDecoder } from '../src/desktop/ipc-client.js';
import { ManagedWorkerDaemon } from '../src/desktop/managed-worker-daemon.js';

test('daemon requires explicit follower and IPC policy before private state is read', () => {
  assert.throws(() => new ManagedWorkerDaemon({
    baseDirectory: 'C:\\private', epoch: '11111111-1111-4111-8111-111111111111',
  } as never), /explicit.*polic/i);
});

class Backend extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly pid = 42424; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  readonly methods: string[] = []; resumed = false; writes = 0; materializeTurn = true;
  readonly frames: Record<string, unknown>[] = [];
  readonly taskId: string; readonly cwd: string;
  constructor(taskId: string, cwd: string) {
    super(); this.taskId = taskId; this.cwd = cwd;
    let data = '';
    this.stdin.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      while (data.includes('\n')) {
        const end = data.indexOf('\n'); const frame = JSON.parse(data.slice(0, end)) as Record<string, unknown>;
        data = data.slice(end + 1);
        const method = String(frame.method); this.methods.push(method); this.frames.push(frame);
        if (!Object.hasOwn(frame, 'id')) continue;
        if (method === 'turn/start') { this.writes++;
          queueMicrotask(() => this.stdout.write(JSON.stringify({ id: frame.id,
            result: { turn: { id: 'accepted-composer-turn', status: 'inProgress', extra: true } } }) + '\n'));
          continue; }
        queueMicrotask(() => this.stdout.write(JSON.stringify({ id: frame.id,
          result: this.answer(method) }) + '\n'));
      }
    });
    this.stdin.on('finish', () => {
      this.exitCode = 0; this.emit('exit', 0, null); this.emit('close', 0, null);
    });
  }
  answer(method: string): Record<string, unknown> {
    const thread = () => ({ id: this.taskId, sessionId: this.taskId,
      createdAt: 100, updatedAt: 101, cwd: this.cwd,
      status: { type: this.resumed ? 'idle' : 'notLoaded' },
      turns: this.writes && this.materializeTurn ? [{ id: 'accepted-composer-turn', status: 'completed', items: [] }] : [],
      environments: [{ environmentId: 'local', cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd] }] });
    if (method === 'initialize') return { serverInfo: { name: 'fixture' } };
    if (method === 'thread/read') return { thread: thread() };
    if (method === 'thread/turns/list') return { data: this.writes && this.materializeTurn ?
      [{ id: 'accepted-composer-turn', status: 'completed', items: [], itemsView: 'full' }] : [], nextCursor: null };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/queue/list') return { data: [], nextCursor: null };
    if (method === 'thread/resume') {
      this.resumed = true;
      return { thread: thread(), cwd: this.cwd, model: 'gpt-5.6-sol', reasoningEffort: 'low',
        approvalPolicy: 'never', activePermissionProfile: { id: ':read-only' },
        sandbox: { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [this.cwd],
        serviceTier: null, approvalsReviewer: 'user', disabledPluginIds: [],
        multiAgentMode: 'explicitRequestOnly', collaborationMode: null };
    }
    if (method === 'config/read') return { config: { model_reasoning_summary: null, personality: 'pragmatic' } };
    throw new Error(`unexpected method ${method}`);
  }
  kill(): boolean { this.exitCode = 0; this.emit('close', 0, null); return true; }
}
class Broker extends Duplex {
  readonly decoder = new FrameDecoder();
  readonly frames: Record<string, unknown>[] = [];
  constructor(readonly early: Record<string, unknown> | null = null, readonly taskId = '') { super(); }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    for (const frame of this.decoder.push(chunk)) {
      this.frames.push(frame);
      if (frame.method === 'initialize') {
        const reply = encodeFrame({ type: 'response', requestId: frame.requestId,
          resultType: 'success', result: { clientId: 'local-owner' } });
        if (this.early) this.push(Buffer.concat([reply, encodeFrame({ type: 'broadcast',
          method: 'thread-stream-following-changed', version: 1, sourceClientId: 'follower',
          params: { conversationId: this.taskId, hostId: 'local', following: true } }), encodeFrame(this.early)]));
        else this.push(reply);
      }
    }
    done();
  }
  send(frame: Record<string, unknown>): void { this.push(encodeFrame(frame)); }
}

function composerRequest(taskId: string, cwd: string, requestId: string): Record<string, unknown> {
  return { type: 'request', requestId, sourceClientId: 'follower', hostId: 'local',
    targetClientId: 'local-owner', method: 'thread-follower-start-turn', version: 2,
    params: { conversationId: taskId, turnStart: { request: {
      threadId: taskId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: 'fixture only', text_elements: [] }],
      cwd, model: null, effort: null, serviceTier: null,
      collaborationMode: { mode: 'default', settings: {
        model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } },
      permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      turnTrigger: 'composer', multiAgentMode: 'explicitRequestOnly',
      responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    }, context: { inheritThreadSettings: true, writingBlockContextPrepared: true,
      localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [],
      responseItems: [], useAppServerPermissionDefault: false, usePermissionSelection: false } } } };
}

async function readyFixture(family = { allow: true }, native = { enabled: false, early: false }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-ready-'));
  const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
  await Promise.all([mkdir(home), mkdir(privateDirectory)]);
  const cliPath = path.join(root, 'cli.exe'), registryPath = path.join(root, 'registry.sqlite');
  await writeFile(cliPath, 'pinned-code');
  const registry = new ManagedWorkerRegistry(registryPath);
  const reserved = registry.reserve(home, 'own-family'); registry.close();
  const taskId = 'own-zero-turn';
  const backend = new Backend(taskId, home), brokers: Broker[] = [], handlerErrors: string[] = [];
  let launches = 0, observations = 0;
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: root, epoch: reserved.epoch, allowFollower: () => native.enabled,
    clientFactory: handler => new DesktopIpcClient(() => {
      const broker = new Broker(native.early && brokers.length === 0 ?
        composerRequest(taskId, home, 'before-ready') : null, taskId);
      brokers.push(broker); return broker;
    }, 500, { canHandle: request => handler.canHandle(request),
      handle: async (request, signal) => {
        try { return await handler.handle(request, signal); }
        catch (error) { handlerErrors.push(error instanceof Error ? error.message : 'non-error'); throw error; }
      } }),
    verifyFamilyQuiescent: async ({ idle }) => family.allow &&
      (native.enabled && backend.writes && backend.materializeTurn ?
        idle.turnCount === 1 && idle.latestTurnId === 'accepted-composer-turn' :
        idle.turnCount === 0 && idle.latestTurnId === null),
    dependencies: {
      loadPrivateState: async () => ({ manifest: {
        schemaVersion: 1, epoch: reserved.epoch, taskId, familyRoot: 'own-family',
        home, cwd: home, cliPath, cliSha256: createHash('sha256').update('pinned-code').digest('hex'),
        initializeRequest: { clientInfo: { name: 'fixture' }, capabilities: {} },
        resumeParams: { threadId: taskId, cwd: home, model: 'gpt-5.6-sol',
          permissions: ':read-only', approvalPolicy: 'never', runtimeWorkspaceRoots: [home],
          config: { model_reasoning_effort: 'low' } }, registryPath,
      }, keys: { fingerprintKey: Buffer.alloc(32, 1).toString('base64'),
        intentKey: Buffer.alloc(32, 2).toString('base64'),
        controlToken: Buffer.alloc(32, 3).toString('base64') }, privateDirectory }),
      observeProcess: pid => { observations++; return pid === backend.pid && backend.exitCode !== null ? null :
        { pid, birthTicks: String(pid + 100) }; },
      launch: () => { launches++; return backend as unknown as ChildProcessWithoutNullStreams; },
    },
  });
  await daemon.start();
  return { daemon, backend, brokers, handlerErrors, reserved, home, registryPath,
    privateDirectory, launches, observations };
}

async function controlStop(privateDirectory: string, epoch: string, id: string): Promise<Record<string, unknown>> {
  const endpoint = JSON.parse(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8')) as
    { control: { port: number } };
  const socket = connect(endpoint.control.port, '127.0.0.1');
  let buffer = ''; const frames: Record<string, unknown>[] = [];
  socket.on('data', chunk => { buffer += chunk.toString();
    while (buffer.includes('\n')) { const at = buffer.indexOf('\n');
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1); }
  });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const wait = async (predicate: (frame: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate); if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('control response timeout');
  };
  try {
    socket.write(JSON.stringify({ token: Buffer.alloc(32, 3).toString('base64url') }) + '\n');
    await wait(frame => frame.ok === true);
    socket.write(JSON.stringify({ id, epoch, method: 'stop' }) + '\n');
    return await wait(frame => frame.id === id);
  } finally { socket.destroy(); }
}

test('opt-in daemon composes one backend, bootstrap, native owner, and ready registry', async () => {
  const { daemon, backend, reserved, home, registryPath, privateDirectory, launches, observations } = await readyFixture();
  assert.equal(daemon.metadata.state, 'ready');
  assert.equal(daemon.metadata.nativeState, 'connected');
  assert.equal(daemon.metadata.nativeStartup?.startupStage, 'ready');
  assert.equal(daemon.metadata.nativeStartup?.bootstrapEventCount, 0);
  assert.equal(launches, 1);
  assert.equal(observations, 2); // startup only, never per native notification
  assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
  assert.equal(backend.writes, 0);
  const check = new ManagedWorkerRegistry(registryPath);
  try {
    const row = check.get(home, 'own-family');
    assert.equal(row?.state, 'ready');
    assert.equal(row?.endpointRef, daemon.metadata.endpointRef);
  } finally { check.close(); }
  const endpoint = JSON.parse(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8')) as
    { control: { port: number } };
  const socket = connect(endpoint.control.port, '127.0.0.1');
  let buffer = ''; const frames: Record<string, unknown>[] = [];
  socket.on('data', chunk => { buffer += chunk.toString();
    while (buffer.includes('\n')) { const at = buffer.indexOf('\n');
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1); }
  });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const send = (frame: object) => socket.write(JSON.stringify(frame) + '\n');
  const wait = async (predicate: (frame: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate); if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('control response timeout');
  };
  send({ token: Buffer.alloc(32, 3).toString('base64url') });
  assert.equal((await wait(frame => frame.ok === true)).ok, true);
  send({ id: 'stop-once', epoch: reserved.epoch, method: 'stop' });
  assert.deepEqual((await wait(frame => frame.id === 'stop-once')).result, { stopped: true });
  socket.destroy();
  assert.equal(daemon.metadata.state, 'stopped');
  assert.equal(backend.exitCode, 0);
});

test('unexpected backend exit retires ready admission and marks only its registry epoch lost', async () => {
  const { daemon, backend, reserved, home, registryPath } = await readyFixture();
  backend.exitCode = 1;
  backend.emit('exit', 1, null);
  backend.emit('close', 1, null);
  assert.equal(daemon.metadata.state, 'failed');
  assert.equal(daemon.metadata.failure, 'backend-lost');
  const check = new ManagedWorkerRegistry(registryPath);
  try {
    const row = check.get(home, 'own-family');
    assert.equal(row?.epoch, reserved.epoch);
    assert.equal(row?.state, 'lost');
    assert.equal(row?.lostReason, 'backend_unavailable');
  } finally { check.close(); }
});

test('native broker EOF rejoins transport without another backend launch or resume', async () => {
  const { daemon, backend, brokers, reserved, privateDirectory } = await readyFixture();
  assert.equal(brokers.length, 1);
  brokers[0]!.destroy();
  const deadline = Date.now() + 4000;
  while (brokers.length < 2 && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(brokers.length, 2);
  assert.equal(daemon.metadata.state, 'ready');
  assert.equal(daemon.metadata.nativeState, 'connected');
  assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
  const endpoint = JSON.parse(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8')) as
    { control: { port: number } };
  const socket = connect(endpoint.control.port, '127.0.0.1');
  let data = ''; socket.on('data', chunk => { data += chunk.toString(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(JSON.stringify({ token: Buffer.alloc(32, 3).toString('base64url') }) + '\n');
  while (!data.includes('"ok":true')) await new Promise(resolve => setTimeout(resolve, 5));
  socket.write(JSON.stringify({ id: 'stop-after-rejoin', epoch: reserved.epoch, method: 'stop' }) + '\n');
  while (!data.includes('"stopped":true')) await new Promise(resolve => setTimeout(resolve, 5));
  socket.destroy();
});

test('pre-ready start cannot write; qualified first Composer start preserves inherited environment wire', async () => {
  const { daemon, backend, brokers, handlerErrors, reserved, privateDirectory, home } = await readyFixture(
    { allow: true }, { enabled: true, early: true });
  try {
  const broker = brokers[0]!;
  const deadline = Date.now() + 2000;
  while (!broker.frames.some(frame => frame.requestId === 'before-ready') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(backend.writes, 0);
  const snapshots = broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length;
  broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
    sourceClientId: 'follower', params: { conversationId: 'own-zero-turn', hostId: 'local', following: true } });
  while (broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length <= snapshots && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length > snapshots);
  broker.send(composerRequest('own-zero-turn', home, 'after-ready'));
  const written = Date.now() + 2000;
  while (backend.writes === 0 && Date.now() < written)
    await new Promise(resolve => setTimeout(resolve, 5));
  const intents = new Database(path.join(privateDirectory, 'start-intents.sqlite'), { readonly: true });
  const intentCount = (intents.prepare('SELECT count(*) AS n FROM native_start_intents').get() as { n: number }).n;
  intents.close();
  assert.equal(backend.writes, 1, JSON.stringify({ native: daemon.metadata.nativeState, intentCount, handlerErrors,
    results: broker.frames.filter(frame => frame.type === 'response').map(frame => ({
      requestId: frame.requestId, resultType: frame.resultType, error: frame.error })) }));
  const wire = backend.frames.find(frame => frame.method === 'turn/start')!;
  const params = wire.params as Record<string, unknown>;
  assert.equal(params.cwd, null);
  assert.equal(params.runtimeWorkspaceRoots, null);
  assert.deepEqual(params.environments, [{ environmentId: 'local', cwd: home,
    runtimeWorkspaceRoots: [home] }]);
  assert.equal(params.permissions, ':read-only');
  assert.equal(params.approvalPolicy, 'on-request');
  const responseDeadline = Date.now() + 2000;
  while (!broker.frames.some(frame => frame.requestId === 'after-ready') && Date.now() < responseDeadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(broker.frames.find(frame => frame.requestId === 'after-ready')?.resultType, 'success');
  assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-after-composer')).result,
    { stopped: true });
  assert.equal(daemon.metadata.state, 'stopped');
  } finally {
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
  }
});

test('definitive family refusal preserves worker and permits a new explicit stop', async () => {
  const family = { allow: false };
  const { daemon, backend, reserved, privateDirectory } = await readyFixture(family);
  assert.equal((await controlStop(privateDirectory, reserved.epoch, 'busy')).error, 'stop-refused');
  assert.equal(daemon.metadata.state, 'ready');
  assert.equal(backend.exitCode, null);
  family.allow = true;
  assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'authorized')).result,
    { stopped: true });
  assert.equal(daemon.metadata.state, 'stopped');
});

test('accepted turn absent from terminal full history refuses stop until it appears', async () => {
  const { daemon, backend, brokers, reserved, privateDirectory, home } = await readyFixture(
    { allow: true }, { enabled: true, early: false });
  try {
    backend.materializeTurn = false;
    const broker = brokers[0]!;
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: 'own-zero-turn', hostId: 'local', following: true } });
    const deadline = Date.now() + 2000;
    while (!broker.frames.some(frame => frame.method === 'thread-stream-state-changed') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    broker.send(composerRequest('own-zero-turn', home, 'accepted-before-history'));
    while (!broker.frames.some(frame => frame.requestId === 'accepted-before-history') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'accepted-before-history')?.resultType, 'success');
    assert.equal(backend.writes, 1);
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'not-terminal')).error, 'stop-refused');
    assert.equal(backend.exitCode, null);
    backend.materializeTurn = true;
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'now-terminal')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
  } finally {
    if (backend.exitCode === null) { backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null); }
  }
});

test('exact reserved epoch is required before observing or launching a worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-reserve-'));
  const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
  await Promise.all([mkdir(home), mkdir(privateDirectory)]);
  const registryPath = path.join(root, 'registry.sqlite');
  const registry = new ManagedWorkerRegistry(registryPath);
  const actual = registry.reserve(home, 'own-family');
  registry.close();
  let observed = 0, launched = 0;
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: root, epoch: '22222222-2222-4222-8222-222222222222',
    allowFollower: () => false, clientFactory: () => { throw new Error('unexpected IPC'); },
    verifyFamilyQuiescent: async () => false,
    dependencies: {
      loadPrivateState: async () => ({ manifest: {
        schemaVersion: 1, epoch: '22222222-2222-4222-8222-222222222222',
        taskId: 'own-thread', familyRoot: 'own-family', home, cwd: home,
        cliPath: path.join(root, 'cli.exe'), cliSha256: '0'.repeat(64),
        initializeRequest: { clientInfo: {}, capabilities: {} }, resumeParams: {}, registryPath,
      }, keys: { fingerprintKey: '', intentKey: '', controlToken: '' }, privateDirectory }),
      observeProcess: () => { observed++; return { pid: process.pid, birthTicks: '1' }; },
      launch: () => { launched++; throw new Error('unexpected launch'); },
    },
  });
  await assert.rejects(daemon.start(), /startup unavailable/);
  assert.equal(daemon.metadata.state, 'failed');
  assert.equal(daemon.metadata.failure, 'startup-unavailable');
  assert.equal(observed, 0);
  assert.equal(launched, 0);
  const check = new ManagedWorkerRegistry(registryPath);
  try { assert.equal(check.get(home, 'own-family')?.epoch, actual.epoch); }
  finally { check.close(); }
});

test('CLI pin mismatch is refused before launch and retains host registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-pin-'));
  const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
  await Promise.all([mkdir(home), mkdir(privateDirectory)]);
  const cliPath = path.join(root, 'cli.exe'), registryPath = path.join(root, 'registry.sqlite');
  await writeFile(cliPath, 'qualified binary bytes');
  const registry = new ManagedWorkerRegistry(registryPath);
  const reserved = registry.reserve(home, 'own-family');
  registry.close();
  let launched = 0;
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: root, epoch: reserved.epoch,
    allowFollower: () => false, clientFactory: () => { throw new Error('unexpected IPC'); },
    verifyFamilyQuiescent: async () => false,
    dependencies: {
      loadPrivateState: async () => ({ manifest: {
        schemaVersion: 1, epoch: reserved.epoch, taskId: 'own-thread', familyRoot: 'own-family',
        home, cwd: home, cliPath,
        cliSha256: createHash('sha256').update('different bytes').digest('hex'),
        initializeRequest: { clientInfo: {}, capabilities: {} }, resumeParams: {}, registryPath,
      }, keys: { fingerprintKey: '', intentKey: '', controlToken: '' }, privateDirectory }),
      observeProcess: pid => ({ pid, birthTicks: '123' }),
      launch: () => { launched++; throw new Error('unexpected launch'); },
    },
  });
  await assert.rejects(daemon.start(), /startup unavailable/);
  assert.equal(launched, 0);
  const check = new ManagedWorkerRegistry(registryPath);
  try {
    const row = check.get(home, 'own-family');
    assert.equal(row?.state, 'host_registered');
    assert.deepEqual(row?.host, { pid: process.pid, birthTicks: '123' });
  } finally { check.close(); }
});
