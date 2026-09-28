import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyNotification, createProjection, type NativeProjectionState } from
  '../src/codex/managed-native-projection.js';
import { ManagedWorkerStateTransport } from '../src/codex/managed-worker-state-transport.js';
import { ManagedWorkerTaskStateServer, type ManagedWorkerTaskStateSource } from
  '../src/desktop/managed-worker-task-state-server.js';
import { TaskStateConnections } from '../src/core/task-state.js';

const epoch = randomUUID();
const taskId = randomUUID();
const token = 'A'.repeat(43);
const generation = 1;
const task = { hostId: 'local', threadId: taskId };
const native = (): NativeProjectionState => createProjection({ thread: { id: taskId, turns: [] },
  cwd: 'C:/owned', model: 'gpt-6-sol', reasoningEffort: 'low', approvalPolicy: 'never',
  sandbox: { type: 'readOnly' }, activePermissionProfile: null, runtimeWorkspaceRoots: [], serviceTier: null },
{ thread: { id: taskId, turns: [], status: { type: 'idle' }, createdAt: 10, updatedAt: 11,
  name: 'Owned', cwd: 'C:/owned' } }, { hostId: 'local', workspaceKind: 'projectless' });

function sourceFixture() {
  let seq = 0;
  let state = native();
  let listener: ((event: { seq: number; generation: number; state: NativeProjectionState }) => void) | null = null;
  let failed: ((reason: 'owner-lost' | 'projection-failed') => void) | null = null;
  let current = true;
  const source: ManagedWorkerTaskStateSource = { subscribe(onState, onFailure) {
    listener = onState; failed = onFailure;
    return { initial: { seq, generation, state: structuredClone(state) },
      current: () => current, detach: () => { listener = null; failed = null; } };
  } };
  return { source,
    emit(next: NativeProjectionState) { state = next; seq++; listener?.({ seq, generation, state: structuredClone(state) }); },
    gap() { seq += 2; listener?.({ seq, generation, state: structuredClone(state) }); },
    loseOwner() { current = false; failed?.('owner-lost'); },
  };
}

async function pair(source: ManagedWorkerTaskStateSource, suppliedToken = token) {
  const server = new ManagedWorkerTaskStateServer({ epoch, taskId, backendGeneration: generation,
    token, source, heartbeatMs: 20 });
  const endpoint = await server.listen();
  const client = new ManagedWorkerStateTransport({ hostId: 'local', taskId, ownerEpoch: epoch,
    backendGeneration: generation, token: suppliedToken, port: endpoint.port });
  return { server, client };
}

test('real worker stream feeds TaskStateConnections with exact initial and changed bridge states', async t => {
  const fixture = sourceFixture(); const { server, client } = await pair(fixture.source);
  t.after(async () => { client.close(); await server.close(); });
  const connections = new TaskStateConnections(client);
  const states: Array<{ initial: boolean; state: Record<string, unknown> }> = [];
  const failures: Error[] = [];
  await connections.connect('managed', task, (state, initial) => states.push({ state, initial }),
    failure => failures.push(failure.error));
  assert.equal(states.length, 1);
  assert.equal(states[0]?.initial, true);
  assert.equal(states[0]?.state.kind, 'app-server');
  assert.equal(states[0]?.state.threadId, taskId);
  assert.deepEqual(states[0]?.state.turns, []);

  fixture.emit(applyNotification(native(), { method: 'turn/started', params: { threadId: taskId,
    turn: { id: 'turn-1', status: 'inProgress', startedAt: 12, items: [
      { id: 'user-1', type: 'userMessage', clientId: 'vk-operation',
        content: [{ type: 'text', text: 'hello' }] },
    ] } } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(states.length, 2);
  assert.equal(states[1]?.initial, false);
  const turns = states[1]?.state.turns as Array<{ id: string; items: Array<{ clientId?: string }> }>;
  assert.equal(turns[0]?.id, 'turn-1');
  assert.equal(turns[0]?.items[0]?.clientId, 'vk-operation');
  assert.deepEqual(failures, []);
  await connections.stop();
});

test('real server denies wrong capability before any state', async t => {
  const fixture = sourceFixture(); const { server, client } = await pair(fixture.source, 'B'.repeat(43));
  t.after(async () => { client.close(); await server.close(); });
  const states: unknown[] = [];
  const stream = client.subscribe(task, state => states.push(state), () => {});
  await assert.rejects(stream.start(1000), /managed state stream/i);
  assert.deepEqual(states, []);
});

test('real worker source gap and owner loss each fail the client stream without a fallback', async t => {
  for (const failure of ['gap', 'owner'] as const) {
    const fixture = sourceFixture(); const { server, client } = await pair(fixture.source);
    t.after(async () => { client.close(); await server.close(); });
    const errors: Error[] = [];
    const stream = client.subscribe(task, () => {}, error => errors.push(error));
    await stream.start();
    if (failure === 'gap') fixture.gap(); else fixture.loseOwner();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(errors.length, 1);
    await assert.rejects(stream.verifyOwner());
    client.close(); await server.close();
  }
});
