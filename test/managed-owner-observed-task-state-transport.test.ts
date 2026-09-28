import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import test, { afterEach } from 'node:test';
import type { ManagedOwnerBinding } from '../src/bridge/store.js';
import { ManagedOwnerObservedTaskStateTransport, type ManagedOwnerRouteObserver } from
  '../src/bridge/managed-owner-observed-task-state-transport.js';
import { ManagedWorkerStateTransport } from '../src/codex/managed-worker-state-transport.js';
import type { TaskRef } from '../src/core/codex-tasks.js';

const task: TaskRef = { hostId: 'local', threadId: randomUUID(), sourceId: 'vk' };
const epoch = randomUUID();
const token = 'private-token';
const claim: ManagedOwnerBinding = Object.freeze({ id: randomUUID(), bindingId: randomUUID(),
  hostId: task.hostId, threadId: task.threadId, sourceId: task.sourceId!, ownerEpoch: epoch,
  canonicalHome: 'D:/managed', familyRoot: task.threadId, state: 'ready', revision: 3,
  evidence: { backendGeneration: 2, registryRevision: 4, endpointRef: randomUUID(),
    host: { pid: 11, birthTicks: '1' }, backend: { pid: 12, birthTicks: '2' } },
  createdAt: 1, updatedAt: 1 });
const state = () => ({ kind: 'app-server', threadId: task.threadId, title: null, cwd: 'D:/managed',
  model: 'gpt-6-sol', effort: 'low', runtimeStatus: 'idle', context: null, questions: [], turns: [],
  createdAt: 1, updatedAt: 1 });
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const frame = (kind: 'snapshot' | 'changed', seq: number) => ({ schemaVersion: 1, kind, epoch,
  taskId: task.threadId, backendGeneration: 2, seq, historyComplete: true, state: state() });

const opened: Array<{ server: Server; sockets: Set<Socket> }> = [];
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    for (const socket of entry.sockets) socket.destroy();
    await new Promise<void>(resolve => entry.server.close(() => resolve()));
  }
});
async function loopback(onSubscribe: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = ''; let stage = 0;
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'); const value = JSON.parse(pending.slice(0, at)) as Record<string, unknown>;
        pending = pending.slice(at + 1);
        if (stage++ === 0) { assert.deepEqual(value, { token }); socket.write(line({ ok: true })); }
        else { assert.deepEqual(value, { method: 'observe-task-v1', epoch, taskId: task.threadId, backendGeneration: 2 }); onSubscribe(socket); }
      }
    });
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  opened.push({ server, sockets }); const address = server.address(); assert.ok(address && typeof address !== 'string');
  return address.port;
}

function resolver(port: number, current: () => boolean, status?: () => Promise<Record<string, unknown>>): ManagedOwnerRouteObserver {
  return {
    async resolve() { return { kind: 'statically-qualified' as const, claim,
      controlStatus: async () => status ? status() as never : ({ ownerEpoch: epoch, taskId: task.threadId,
        hostState: 'running', backendGeneration: 2, nativeState: 'connected', nativeRevision: 1 }),
      states: new ManagedWorkerStateTransport({ hostId: 'local', sourceId: 'vk', taskId: task.threadId,
        ownerEpoch: epoch, backendGeneration: 2, port, token }) }; },
    isCurrent: () => current(),
  };
}

test('lazily proves status then observes an exact loopback worker stream', async () => {
  const port = await loopback(socket => socket.write(line(frame('snapshot', 0)) + line(frame('changed', 1))));
  let resolveCalls = 0; const base = resolver(port, () => true);
  const observed: ManagedOwnerRouteObserver = { ...base, async resolve(ref) { resolveCalls++; return base.resolve(ref); } };
  const transport = new ManagedOwnerObservedTaskStateTransport(observed, task);
  const seen: boolean[] = []; const stream = transport.subscribe(task, (_value, initial) => seen.push(initial), () => assert.fail('unexpected failure'));
  assert.equal(resolveCalls, 0);
  await stream.start(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [true, false]); assert.equal(resolveCalls, 1); await stream.verifyOwner(); transport.close();
});

test('concurrent starts share one status proof and one loopback state socket', async () => {
  let subscriptions = 0;
  const port = await loopback(socket => { subscriptions++; socket.write(line(frame('snapshot', 0))); });
  let statusCalls = 0;
  const transport = new ManagedOwnerObservedTaskStateTransport(resolver(port, () => true, async () => {
    statusCalls++;
    return { ownerEpoch: epoch, taskId: task.threadId, hostState: 'running', backendGeneration: 2,
      nativeState: 'connected', nativeRevision: 1 };
  }), task);
  const stream = transport.subscribe(task, () => {}, () => assert.fail('unexpected failure'));
  const first = stream.start(); const second = stream.start();
  assert.equal(first, second);
  await first;
  assert.equal(statusCalls, 1); assert.equal(subscriptions, 1);
  transport.close(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(opened[0]?.sockets.size, 0, 'transport close also tears down its owned worker stream');
});

test('claim transition while status is pending opens no worker stream and forwards no state', async () => {
  const port = await loopback(socket => socket.write(line(frame('snapshot', 0))));
  let current = true; let release!: () => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { release = () => resolve({ ownerEpoch: epoch,
    taskId: task.threadId, hostState: 'running', backendGeneration: 2, nativeState: 'connected', nativeRevision: 1 }); });
  const transport = new ManagedOwnerObservedTaskStateTransport(resolver(port, () => current, () => pending), task);
  const seen: unknown[] = []; const stream = transport.subscribe(task, value => seen.push(value), () => {});
  const starting = stream.start(1000); await new Promise(resolve => setImmediate(resolve)); current = false; release();
  await assert.rejects(starting, /unavailable/); assert.deepEqual(seen, []); transport.close();
});

test('outer transport close during status proof also closes the pending private state transport', async () => {
  const port = await loopback(socket => socket.write(line(frame('snapshot', 0))));
  let release!: () => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { release = () => resolve({ ownerEpoch: epoch,
    taskId: task.threadId, hostState: 'running', backendGeneration: 2,
    nativeState: 'connected', nativeRevision: 1 }); });
  const base = resolver(port, () => true, () => pending);
  let source: ManagedWorkerStateTransport | null = null;
  const observed: ManagedOwnerRouteObserver = { ...base, async resolve(ref) {
    const value = await base.resolve(ref);
    if (value.kind === 'statically-qualified') source = value.states;
    return value;
  } };
  const transport = new ManagedOwnerObservedTaskStateTransport(observed, task);
  const stream = transport.subscribe(task, () => assert.fail('state after close'), () => {});
  const starting = stream.start(1000);
  await new Promise(resolve => setImmediate(resolve));
  transport.close(); release();
  await assert.rejects(starting, /unavailable/);
  assert.ok(source);
  assert.throws(() => source!.subscribe(task, () => {}, () => {}));
  assert.equal(opened.at(-1)?.sockets.size, 0);
});

test('closing during a pending status proof opens no socket and releases the lazy stream', async () => {
  const port = await loopback(socket => socket.write(line(frame('snapshot', 0))));
  let release!: () => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { release = () => resolve({ ownerEpoch: epoch,
    taskId: task.threadId, hostState: 'running', backendGeneration: 2, nativeState: 'connected', nativeRevision: 1 }); });
  const transport = new ManagedOwnerObservedTaskStateTransport(resolver(port, () => true, () => pending), task);
  const stream = transport.subscribe(task, () => assert.fail('state after close'), () => {});
  const starting = stream.start(); await new Promise(resolve => setImmediate(resolve));
  stream.close(); release();
  await assert.rejects(starting, /unavailable/);
  assert.equal(opened[0]?.sockets.size, 0);
  transport.close();
});

test('old frames are fenced after a durable claim transition, and failed status opens nothing', async () => {
  const port = await loopback(socket => socket.write(line(frame('snapshot', 0))));
  let current = true; const transport = new ManagedOwnerObservedTaskStateTransport(resolver(port, () => current), task);
  const seen: boolean[] = []; const failures: Error[] = [];
  const stream = transport.subscribe(task, (_value, initial) => seen.push(initial), error => failures.push(error));
  await stream.start(); current = false;
  for (const entry of opened) for (const socket of entry.sockets) socket.write(line(frame('changed', 1)));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [true]); assert.equal(failures.length, 1); transport.close();

  const refused = new ManagedOwnerObservedTaskStateTransport(resolver(port, () => true, async () => {
    throw new Error('unavailable'); }), task);
  await assert.rejects(refused.subscribe(task, () => assert.fail('state'), () => {}).start(), /unavailable/);
  refused.close();
});
