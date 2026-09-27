import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import test from 'node:test';
import { AppServerConnection } from '../src/codex/app-server-connection.js';
import { ManagedWorkerFrontendHost } from '../src/codex/managed-worker-frontend-host.js';

type Frame = Record<string, unknown>;
const taskId = 'own-thread';
const init: Frame = { clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } };
class Child extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly messages: Frame[] = [];
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; pid = undefined;
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
