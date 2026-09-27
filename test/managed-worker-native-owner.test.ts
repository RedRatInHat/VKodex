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
import { DesktopIpcClient, encodeFrame, FrameDecoder } from '../src/desktop/ipc-client.js';
import type { IpcObject } from '../src/desktop/ipc-client.js';
import { ManagedWorkerNativeOwner } from '../src/desktop/managed-worker-native-owner.js';
import type { NativeProjectionState } from '../src/codex/managed-native-projection.js';

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
async function fixture(readInitialState: () => Promise<NativeProjectionState> = async () => state()) {
  const child = new Child(), adapterKey = {}, controlKey = {}, ownerEpoch = randomUUID();
  const host = new ManagedWorkerFrontendHost({ taskId, ownCwd: 'C:/own',
    initializeRequest: { clientInfo: { name: 'fixture' }, capabilities: {} },
    bootstrapReadMethods: [], adapterKey, allowRequest: () => false, allowAnswer: () => false,
    launch: () => child as unknown as ChildProcessWithoutNullStreams,
    commandPolicy: { controlKey, ownerEpoch, fingerprintKey: randomBytes(32),
      journalPath: path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-owner-')), 'ops.sqlite'),
      isOwnerCurrent: () => true, authorize: ({ params }) => params.model === 'fixture-model' } });
  await host.start();
  let broker = new Broker(); const brokers = [broker];
  const owner = new ManagedWorkerNativeOwner({ host, adapterKey, controlKey, taskId, ownerEpoch,
    isOwnerCurrent: () => true, allowFollower: id => id === 'follower', readInitialState,
    clientFactory: handler => new DesktopIpcClient(() => {
      if (broker.destroyed) { broker = new Broker(); brokers.push(broker); }
      return broker;
    }, 1000, handler) });
  return { child, host, get broker() { return broker; }, brokers, owner, adapterKey,
    controlKey, ownerEpoch };
}

test('bootstrap rejects a notification during asynchronous full-history read before IPC claim', async () => {
  let resolve!: (value: NativeProjectionState) => void;
  const read = new Promise<NativeProjectionState>(done => { resolve = done; });
  const f = await fixture(() => read);
  try { const starting = f.owner.start();
    f.child.send('turn/started', { threadId: taskId, turn: { id: 'raced', status: 'inProgress', items: [] } });
    resolve(state());
    await assert.rejects(starting);
    assert.equal(f.broker.frames.some(frame => frame.method === 'initialize'), false);
    assert.equal(f.host.metadata.state, 'running');
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
      assert.equal(f.broker.frames.some(frame => frame.method === 'initialize'), false);
      assert.equal(f.host.metadata.state, 'running');
    } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
  }
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
  } finally { f.owner.close(); await f.host.stop('test-cleanup'); }
});
