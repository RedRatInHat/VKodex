import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { createProjection, applyNotification, type NativeProjectionState } from '../src/codex/managed-native-projection.js';
import { ManagedWorkerTaskStateServer, type ManagedWorkerTaskStateSource } from '../src/desktop/managed-worker-task-state-server.js';

const epoch = randomUUID();
const taskId = randomUUID();
const token = 'A'.repeat(43);
const generation = 1;
const native = (): NativeProjectionState => createProjection({ thread: { id: taskId, turns: [] },
  cwd: 'C:/owned', model: 'gpt-6-sol', reasoningEffort: 'low', approvalPolicy: 'never',
  sandbox: { type: 'readOnly' }, activePermissionProfile: null, runtimeWorkspaceRoots: [], serviceTier: null },
{ thread: { id: taskId, turns: [], status: { type: 'idle' }, createdAt: 10, updatedAt: 11,
  name: 'Owned', cwd: 'C:/owned' } }, { hostId: 'local', workspaceKind: 'projectless' });

function fixture() {
  let state = native(), seq = 0, listener: ((event: { seq: number; generation: number; state: NativeProjectionState }) => void) | null = null;
  let failure: ((reason: 'owner-lost' | 'projection-failed') => void) | null = null;
  let subscribed = 0, detached = 0, current = true;
  const source: ManagedWorkerTaskStateSource = {
    subscribe(onState, onFailure) {
      subscribed++;
      listener = onState; failure = onFailure;
      return { initial: { seq, generation, state: structuredClone(state) },
        detach: () => { detached++; listener = null; failure = null; },
        current: () => current };
    },
  };
  return { source, get subscribed() { return subscribed; }, get detached() { return detached; },
    emit(next: NativeProjectionState) { state = next; seq++; listener?.({ seq, generation, state: structuredClone(state) }); },
    gap() { seq += 2; listener?.({ seq, generation, state: structuredClone(state) }); },
    fail() { failure?.('owner-lost'); },
    revoke() { current = false; } };
}

function lines(socket: Socket) {
  let buffer = '', closed = false;
  const values: unknown[] = [];
  const waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const value = JSON.parse(buffer.slice(0, index)) as unknown;
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift(); if (waiter) waiter.resolve(value); else values.push(value);
    }
  });
  socket.on('close', () => { closed = true; for (const waiter of waiters.splice(0)) waiter.reject(new Error('closed')); });
  return { async next(): Promise<unknown> {
    if (values.length) return values.shift();
    if (closed) throw new Error('closed');
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('line timeout')), 2000);
      waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } }); });
  } };
}

async function client(port: number) {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return { socket, reader: lines(socket) };
}
const subscribe = (socket: Socket) => socket.write(JSON.stringify({ method: 'observe-task-v1',
  epoch, taskId, backendGeneration: generation }) + '\n');

test('one source subscription fans full initial and ordered changes to authenticated clients', async t => {
  const f = fixture();
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source: f.source, heartbeatMs: 1000 });
  t.after(() => server.close());
  const endpoint = await server.listen();
  const a = await client(endpoint.port); const b = await client(endpoint.port);
  t.after(() => { a.socket.destroy(); b.socket.destroy(); });
  for (const c of [a, b]) {
    c.socket.write(JSON.stringify({ token }) + '\n');
    assert.deepEqual(await c.reader.next(), { ok: true });
    subscribe(c.socket);
    const initial = await c.reader.next() as Record<string, unknown>;
    assert.equal(initial.kind, 'snapshot'); assert.equal(initial.seq, 0);
    assert.equal(initial.historyComplete, true);
    assert.equal(initial.taskId, taskId); assert.equal(initial.epoch, epoch);
    assert.equal((initial.state as Record<string, unknown>).kind, 'app-server');
  }
  assert.equal(f.subscribed, 1);
  f.emit(applyNotification(native(), { method: 'turn/started', params: { threadId: taskId,
    turn: { id: 'turn-1', status: 'inProgress', startedAt: 12, items: [
      { id: 'user-1', type: 'userMessage', clientId: 'vk-operation', content: [{ type: 'text', text: 'hello' }] },
    ] } } }));
  for (const c of [a, b]) {
    const changed = await c.reader.next() as Record<string, unknown>;
    assert.equal(changed.kind, 'changed'); assert.equal(changed.seq, 1);
    assert.equal(changed.historyComplete, true);
    const state = changed.state as { turns: Array<{ id: string; items: Array<{ clientId?: string }> }> };
    assert.equal(state.turns[0]?.id, 'turn-1');
    assert.equal(state.turns[0]?.items[0]?.clientId, 'vk-operation');
  }
  a.socket.destroy();
  assert.equal(f.detached, 0, 'client EOF did not detach the one upstream source');
  await server.close();
  assert.equal(f.detached, 1);
});

test('wrong token/scope do not expose state; owner loss closes stream without backend action', async t => {
  const f = fixture();
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source: f.source });
  t.after(() => server.close());
  const endpoint = await server.listen();
  const bad = await client(endpoint.port);
  bad.socket.write(JSON.stringify({ token: 'B'.repeat(43) }) + '\n');
  await assert.rejects(bad.reader.next(), /closed/);
  const wrong = await client(endpoint.port);
  wrong.socket.write(JSON.stringify({ token }) + '\n');
  assert.deepEqual(await wrong.reader.next(), { ok: true });
  wrong.socket.write(JSON.stringify({ method: 'observe-task-v1', epoch, taskId: 'other',
    backendGeneration: generation }) + '\n');
  await assert.rejects(wrong.reader.next(), /closed/);
  const good = await client(endpoint.port);
  good.socket.write(JSON.stringify({ token }) + '\n');
  assert.deepEqual(await good.reader.next(), { ok: true }); subscribe(good.socket);
  assert.equal((await good.reader.next() as Record<string, unknown>).kind, 'snapshot');
  f.fail();
  await assert.rejects(good.reader.next(), /closed/);
  assert.equal(f.detached, 1);
});

test('sequence gap fails closed without sending stale state', async t => {
  const f = fixture();
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source: f.source, heartbeatMs: 20 });
  t.after(() => server.close());
  const endpoint = await server.listen();
  const c = await client(endpoint.port);
  c.socket.write(JSON.stringify({ token }) + '\n');
  assert.deepEqual(await c.reader.next(), { ok: true }); subscribe(c.socket);
  assert.equal((await c.reader.next() as Record<string, unknown>).seq, 0);
  f.gap();
  await assert.rejects(c.reader.next(), /closed/);
  assert.equal(f.detached, 1);
});

test('heartbeat does not advance sequence and revocation closes the idle stream', async t => {
  const f = fixture();
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source: f.source, heartbeatMs: 20 });
  t.after(() => server.close());
  const endpoint = await server.listen();
  const c = await client(endpoint.port);
  c.socket.write(JSON.stringify({ token }) + '\n');
  assert.deepEqual(await c.reader.next(), { ok: true }); subscribe(c.socket);
  assert.equal((await c.reader.next() as Record<string, unknown>).seq, 0);
  const heartbeat = await c.reader.next() as Record<string, unknown>;
  assert.equal(heartbeat.kind, 'heartbeat'); assert.equal(heartbeat.seq, 0);
  assert.equal(Object.hasOwn(heartbeat, 'state'), false);
  f.revoke();
  await assert.rejects(c.reader.next(), /closed/);
  assert.equal(f.detached, 1);
});

test('reentrant source failure during registration detaches once and never listens', async () => {
  let detached = 0;
  const source: ManagedWorkerTaskStateSource = { subscribe(_onState, onFailure) {
    onFailure('owner-lost');
    return { initial: { seq: 0, generation, state: native() },
      current: () => true, detach: () => { detached++; } };
  } };
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source });
  await assert.rejects(server.listen(), /unavailable/);
  assert.equal(detached, 1);
  await server.close();
});

test('explicit close during listen retires observation and leaves no listener', async () => {
  const f = fixture();
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source: f.source });
  const listening = server.listen();
  const closing = server.close();
  await Promise.allSettled([listening, closing]);
  assert.equal(f.detached, 1);
  await assert.rejects(server.listen(), /closed/);
});

test('a throwing source health callback refuses subscription without a process error', async t => {
  const f = fixture();
  const source: ManagedWorkerTaskStateSource = { subscribe(listener, onFailure) {
    const attached = f.source.subscribe(listener, onFailure);
    let calls = 0;
    return { ...attached, current: () => {
      calls++;
      if (calls >= 3) throw new Error('sensitive source failure');
      return true;
    } };
  } };
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source });
  t.after(() => server.close());
  const endpoint = await server.listen();
  const c = await client(endpoint.port);
  c.socket.write(JSON.stringify({ token }) + '\n');
  assert.deepEqual(await c.reader.next(), { ok: true });
  subscribe(c.socket);
  await assert.rejects(c.reader.next(), /closed/);
});
