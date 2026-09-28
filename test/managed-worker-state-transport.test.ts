import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, test } from 'node:test';
import { ManagedWorkerStateTransport } from '../src/codex/managed-worker-state-transport.js';
import { RoutedTaskStateTransport, TaskStateConnections, type TaskStateTransport } from '../src/core/task-state.js';

const scope = {
  hostId: 'local', taskId: 'task-1', ownerEpoch: 'd51af40e-0987-4b0f-a9bb-a4e4d9ae3827',
  backendGeneration: 3, token: 'private-token',
};
const task = { hostId: 'local', threadId: scope.taskId };
const state = () => ({ kind: 'app-server', threadId: scope.taskId, title: null,
  cwd: 'D:/work', model: 'gpt-6-sol', effort: 'low', runtimeStatus: 'idle',
  context: null, questions: [], turns: [], createdAt: 1, updatedAt: 2 });
const frame = (kind: 'snapshot' | 'changed', seq: number, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, kind, epoch: scope.ownerEpoch, taskId: scope.taskId,
  backendGeneration: scope.backendGeneration, seq, historyComplete: true, state: state(), ...extra,
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const opened: Array<{ server: Server; sockets: Set<Socket> }> = [];
afterEach(async () => {
  for (const { server, sockets } of opened.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function fixture(onLine: (value: Record<string, unknown>, socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      for (;;) {
        const index = pending.indexOf('\n'); if (index < 0) break;
        const raw = pending.slice(0, index); pending = pending.slice(index + 1);
        onLine(JSON.parse(raw) as Record<string, unknown>, socket);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  opened.push({ server, sockets });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}
const transport = (port: number) => new ManagedWorkerStateTransport({ ...scope, port });

test('authenticates, subscribes exact scope, and delivers full initial and changed states', async () => {
  let lines = 0;
  const port = await fixture((value, socket) => {
    lines++;
    if (lines === 1) { assert.deepEqual(value, { token: scope.token }); socket.write(line({ ok: true })); }
    else {
      assert.deepEqual(value, { method: 'observe-task-v1', epoch: scope.ownerEpoch,
        taskId: scope.taskId, backendGeneration: scope.backendGeneration });
      socket.write(line(frame('snapshot', 7)) + line(frame('changed', 8)));
    }
  });
  const seen: Array<{ initial: boolean; state: unknown }> = [];
  const errors: Error[] = [];
  const client = transport(port);
  const stream = client.subscribe(task, (value, initial) => seen.push({ state: value, initial }), error => errors.push(error));
  await stream.start();
  await waitFor(() => seen.length === 2, 'initial and changed states');
  assert.deepEqual(seen.map(item => item.initial), [true, false]);
  assert.deepEqual(seen[0]?.state, state());
  assert.deepEqual(errors, []);
  await stream.verifyOwner();
  assert.equal(stream.diagnostic?.().kind, 'app-server');
  client.close();
});

test('wrong task is refused before opening a socket', async () => {
  const port = await fixture(() => assert.fail('unexpected socket input'));
  const client = transport(port);
  assert.throws(() => client.subscribe({ hostId: 'local', threadId: 'other' }, () => {}, () => {}));
  assert.throws(() => client.subscribe({ hostId: 'remote', threadId: scope.taskId }, () => {}, () => {}));
  client.close();
});

test('missing full-history proof fails before any state reaches TaskStateConnections', async () => {
  let lines = 0;
  const port = await fixture((_value, socket) => {
    lines++; socket.write(line(lines === 1 ? { ok: true } : frame('snapshot', 0, { historyComplete: false })));
  });
  const client = transport(port);
  const seen: unknown[] = [];
  const stream = client.subscribe(task, value => seen.push(value), () => {});
  await assert.rejects(stream.start(), /state stream/i);
  assert.deepEqual(seen, []);
  client.close();
});

test('sequence gap, wrong epoch, malformed change, and unknown frame fields fail closed', async () => {
  for (const bad of [frame('changed', 4), frame('changed', 3, { epoch: crypto.randomUUID() }),
    frame('changed', 3, { historyComplete: false }), frame('changed', 3, { extra: true })]) {
    let lines = 0;
    const port = await fixture((_value, socket) => {
      lines++; socket.write(line(lines === 1 ? { ok: true } : frame('snapshot', 2)));
      if (lines === 2) setImmediate(() => socket.write(line(bad)));
    });
    const client = transport(port);
    const errors: Error[] = []; const seen: boolean[] = [];
    const stream = client.subscribe(task, (_value, initial) => seen.push(initial), error => errors.push(error));
    await stream.start();
    await waitFor(() => errors.length === 1, 'invalid change failure');
    assert.deepEqual(seen, [true]);
    assert.equal(errors.length, 1);
    await assert.rejects(stream.verifyOwner());
    client.close();
  }
});

test('EOF after snapshot fails stream, while local close is silent', async () => {
  let lines = 0;
  const port = await fixture((_value, socket) => {
    lines++; socket.write(line(lines === 1 ? { ok: true } : frame('snapshot', 0)));
    if (lines === 2) setImmediate(() => socket.end());
  });
  const client = transport(port); const errors: Error[] = [];
  const stream = client.subscribe(task, () => {}, error => errors.push(error));
  await stream.start();
  await waitFor(() => errors.length === 1, 'EOF failure');
  assert.equal(errors.length, 1);
  client.close();
});

test('exclusive TaskStateConnections route drops a gapped stream without legacy fallback', async () => {
  let lines = 0;
  const port = await fixture((_value, socket) => {
    lines++; socket.write(line(lines === 1 ? { ok: true } : frame('snapshot', 11)));
    if (lines === 2) setImmediate(() => socket.write(line(frame('changed', 13))));
  });
  let fallbackCalls = 0;
  const fallback: TaskStateTransport = {
    subscribe() { fallbackCalls++; throw new Error('legacy fallback must not run'); }, close() {},
  };
  const managed = transport(port);
  const routed = new RoutedTaskStateTransport(fallback, [{
    routingPolicy: 'exclusive', owns: value => value.threadId === task.threadId, states: managed,
  }]);
  const connections = new TaskStateConnections(routed);
  const seen: boolean[] = []; const failures: Error[] = [];
  await connections.connect('bridge-task', task, (_state, initial) => seen.push(initial),
    failure => failures.push(failure.error));
  await waitFor(() => failures.length === 1, 'exclusive route failure');
  assert.deepEqual(seen, [true]);
  assert.equal(failures.length, 1);
  assert.equal(connections.has('bridge-task'), false);
  assert.equal(fallbackCalls, 0);
  await connections.stop();
});

test('initial auth timeout is bounded and never emits partial state', async () => {
  const port = await fixture(() => {}); // Deliberately never authenticate.
  const client = transport(port); const seen: unknown[] = [];
  const stream = client.subscribe(task, value => seen.push(value), () => {});
  await assert.rejects(stream.start(25), /deadline/i);
  assert.deepEqual(seen, []);
  await assert.rejects(stream.verifyOwner());
  client.close();
});

test('heartbeat retains sequence without creating a state update', async () => {
  let lines = 0;
  const port = await fixture((_value, socket) => {
    lines++;
    if (lines === 1) socket.write(line({ ok: true }));
    else socket.write(line(frame('snapshot', 4)) + line({ schemaVersion: 1, kind: 'heartbeat',
      epoch: scope.ownerEpoch, taskId: scope.taskId, backendGeneration: scope.backendGeneration, seq: 4 }) +
      line(frame('changed', 5)));
  });
  const client = transport(port); const seen: boolean[] = [];
  const stream = client.subscribe(task, (_value, initial) => seen.push(initial), () => {});
  await stream.start();
  await waitFor(() => seen.length === 2, 'state following heartbeat');
  assert.deepEqual(seen, [true, false]);
  await stream.verifyOwner();
  client.close();
});

test('unknown visible item is refused rather than silently omitted by the observer', async () => {
  let lines = 0;
  const invalidState = { ...state(), turns: [{ id: 'turn-1', status: 'completed', startedAt: 1,
    items: [{ id: 'item-1', type: 'futureVisibleThing', text: 'must not disappear' }] }] };
  const port = await fixture((_value, socket) => {
    lines++; socket.write(line(lines === 1 ? { ok: true } : frame('snapshot', 0, { state: invalidState })));
  });
  const client = transport(port); const seen: unknown[] = [];
  const stream = client.subscribe(task, value => seen.push(value), () => {});
  await assert.rejects(stream.start(), /full history state required/i);
  assert.deepEqual(seen, []);
  client.close();
});
