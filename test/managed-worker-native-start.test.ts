import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedWorkerFrontendHost } from '../src/codex/managed-worker-frontend-host.js';
import { ManagedWorkerNativeStartHandler } from '../src/desktop/managed-worker-native-start.js';
import type { NativeStartAuthority } from '../src/desktop/managed-worker-native-start.js';
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
      isOwnerCurrent: () => true, authorize: ({ params }) => params.model === 'gpt-fixture' } });
  await host.start();
  const handler = new ManagedWorkerNativeStartHandler({ host, controlKey, taskId, ownerEpoch,
    authority: () => authority, authorizeFollower: r => state.authorized && r.sourceClientId === 'desktop' });
  const request: IpcIncomingRequest = { requestId: 'send-1', sourceClientId: 'desktop', hostId: 'local',
    method: 'thread-follower-start-turn', version: 2,
    params: { conversationId: taskId, turnStart: { request: { threadId: taskId,
      clientUserMessageId: randomUUID(), input: [{ type: 'text', text: 'native input', text_elements: [] }] },
      context: { inheritThreadSettings: true } } } };
  return { host, handler, child, request, state, authority };
}

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
