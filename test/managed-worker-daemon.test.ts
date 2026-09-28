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
import { ManagedWorkerOperationJournal } from '../src/codex/managed-worker-operation-journal.js';
import Database from 'better-sqlite3';
import { DesktopIpcClient, encodeFrame, FrameDecoder } from '../src/desktop/ipc-client.js';
import { ManagedWorkerDaemon } from '../src/desktop/managed-worker-daemon.js';
import { ManagedWorkerControlServer } from '../src/desktop/managed-worker-control.js';
import { buildBackendWorkerSpawnOptions } from '../src/desktop/managed-worker-environment.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import { NativeStockQueueJournal } from '../src/codex/native-stock-queue-journal.js';

test('daemon requires explicit follower and IPC policy before private state is read', () => {
  assert.throws(() => new ManagedWorkerDaemon({
    baseDirectory: 'C:\\private', epoch: '11111111-1111-4111-8111-111111111111',
  } as never), /explicit.*polic/i);
});

test('stock daemon confirms one settings write on its own backend before readiness', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false }, 'normal', true);
  try {
    assert.equal(own.daemon.metadata.state, 'ready');
    assert.equal(own.backend.settingsWrites, 1);
    assert.equal(own.backend.queueWrites, 0);
    assert.equal(own.backend.writes, 0);
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(own.brokers.length, 1);
    assert.ok(own.brokers[0]?.frames.some(frame => frame.method === 'thread-queued-followups-changed'));
    assert.ok(own.probeBrokers.some(broker => broker.frames.some(frame =>
      frame.method === 'thread-owner-discovery')));
    const journal = new Database(path.join(own.privateDirectory, 'operations.sqlite'), { readonly: true });
    try {
      const settings = journal.prepare('SELECT state,rpc_ack,effective_fingerprint FROM managed_worker_settings_operations')
        .all() as Array<{state:string;rpc_ack:number;effective_fingerprint:string|null}>;
      assert.equal(settings.length, 1);
      assert.equal(settings[0]?.rpc_ack, 1);
      assert.match(settings[0]?.effective_fingerprint ?? '', /^[0-9a-f]{64}$/u);
      assert.equal((journal.prepare('SELECT count(*) AS n FROM managed_worker_operations').get() as {n:number}).n, 0);
    } finally { journal.close(); }
  } finally {
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'stock-stop')).result,
      { stopped: true });
  }
});

test('stock daemon routes two native queue sends through one journaled backend and stops after terminal proof', async () => {
  const own = await readyFixture({ allow: true, expectedTurnCount: 2 },
    { enabled: true, early: false }, 'normal', true);
  const broker = own.brokers[0]!;
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), JSON.stringify({ methods: own.backend.methods,
      native: own.daemon.metadata.nativeState, errors: own.handlerErrors }));
  };
  try {
    await wait(() => broker.frames.some(frame => frame.method === 'thread-queued-followups-changed'));
    broker.send(composerRequest(own.taskId, own.home, 'stock-direct-denied'));
    await wait(() => broker.frames.some(frame => frame.type === 'response' &&
      frame.requestId === 'stock-direct-denied'));
    assert.equal(broker.frames.find(frame => frame.requestId === 'stock-direct-denied')?.resultType, 'error');
    assert.equal(own.backend.writes, 0);
    for (let index = 1; index <= 2; index++) {
      const entry = stockEntry(own.home);
      broker.send({ type: 'request', requestId: `stock-${index}`, sourceClientId: 'follower',
        targetClientId: broker.ownerId, hostId: 'local',
        method: 'thread-follower-set-queued-follow-ups-state', version: 1,
        params: { hostId: 'local', conversationId: own.taskId,
          state: { [own.taskId]: [entry] } } });
      await wait(() => broker.frames.some(frame => frame.type === 'response' &&
        frame.requestId === `stock-${index}`));
      assert.equal(broker.frames.find(frame => frame.requestId === `stock-${index}`)?.resultType,
        'success', JSON.stringify({ errors: own.handlerErrors }));
      assert.equal(own.backend.queueWrites, index);
      assert.equal(own.backend.writes, 0);
      const userItem = { id: `stock-user-${index}`, type: 'userMessage', clientId: entry.id,
        content: [{ type: 'text', text: 'PUBLIC_OK' }] };
      const turn = { id: `stock-turn-${index}`, status: 'inProgress', startedAt: index, items: [] };
      own.backend.stdout.write(JSON.stringify({ method: 'turn/started',
        params: { threadId: own.taskId, turn } }) + '\n');
      own.backend.stdout.write(JSON.stringify({ method: 'item/started',
        params: { threadId: own.taskId, turnId: turn.id, item: userItem } }) + '\n');
      own.backend.stockCompletedClients.push(entry.id as string);
      own.backend.stdout.write(JSON.stringify({ method: 'turn/completed',
        params: { threadId: own.taskId, turn: { ...turn, status: 'completed',
          completedAt: index + 1, itemsView: 'full', items: [userItem] } } }) + '\n');
      await wait(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed' &&
        JSON.stringify(frame).includes(`stock-turn-${index}`) && JSON.stringify(frame).includes('completed')));
    }
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(own.backend.settingsWrites, 1);
    assert.equal(own.backend.queueWrites, 2);
    assert.equal(own.backend.writes, 0);
    const queueJournal = new Database(path.join(own.privateDirectory, 'native-stock.sqlite'), { readonly: true });
    try {
      const rows = queueJournal.prepare('SELECT phase,consumed FROM native_repeated_op ORDER BY seq')
        .all() as Array<{phase:string;consumed:number}>;
      assert.deepEqual(rows, [{ phase: 'accepted', consumed: 1 },
        { phase: 'accepted', consumed: 1 }]);
    } finally { queueJournal.close(); }
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'stock-two-stop')).result,
      { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('stock stop refuses native intents missing from the worker journal, including a late family-proof reservation', async () => {
  for (const phase of ['reserved', 'unknown', 'accepted', 'during-family'] as const) {
    const family: { allow: boolean; beforeReturn?: () => void } = { allow: true };
    const own = await readyFixture(family, { enabled: false, early: false }, 'normal', true);
    const journal = new NativeStockQueueJournal({ filePath: path.join(own.privateDirectory, 'native-stock.sqlite'),
      taskId: own.taskId, ownerEpoch: own.reserved.epoch, sourceGeneration: 'qualified-stock-v1' });
    const id = randomUUID(), fingerprint = 'a'.repeat(64);
    const input = [{ type: 'text', text: 'PUBLIC_PENDING', text_elements: [] }];
    const reserve = () => journal.reserve({ expectedVersion: journal.readTask().version,
      opId: id, fingerprint, nativeEntry: { id, text: 'PUBLIC_PENDING' },
      effectiveSettings: { model: 'gpt-5.6-sol', effort: 'medium' },
      admissionEvidence: { taskId: own.taskId, ownerEpoch: own.reserved.epoch },
      stockInput: input, forwardedUpstream: {} });
    try {
      if (phase === 'during-family') family.beforeReturn = () => { reserve(); };
      else {
        reserve();
        if (phase === 'unknown') journal.markUnknown({ opId: id, fingerprint });
        if (phase === 'accepted') journal.markAccepted({ opId: id, fingerprint, stockId: 'own-submission',
          input, sourceGeneration: 'qualified-stock-v1', clientUserMessageId: id,
          threadId: own.taskId, assertSourceCurrent: () => true });
      }
      assert.equal((await controlStop(own.privateDirectory, own.reserved.epoch, `native-${phase}`)).error,
        'stop-refused');
      assert.equal(own.backend.exitCode, null);
      assert.equal(own.daemon.metadata.state, 'ready');
      assert.equal(own.backend.queueWrites, 0);
      assert.equal(own.backend.writes, 0);
    } finally {
      journal.close();
      await (own.control as ManagedWorkerControlServer | null)?.close();
      own.backend.stdin.end();
    }
  }
});

test('stock daemon refuses uncontrolled baseline or foreign owner discovery before queue writes', async () => {
  for (const failure of ['baseline', 'discovery'] as const) {
    const own = await readyFixture({ allow: true }, { enabled: true, early: false },
      'normal', true, failure);
    try {
      if (failure === 'baseline') {
        assert.equal(own.daemon.metadata.state, 'ready');
        const broker = own.brokers[0]!;
        broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
          sourceClientId: 'follower', params: { hostId: 'local', conversationId: own.taskId,
            following: true } });
        broker.send({ type: 'request', requestId: 'uncontrolled-queue',
          sourceClientId: 'follower', targetClientId: broker.ownerId, hostId: 'local',
          method: 'thread-follower-set-queued-follow-ups-state', version: 1,
          params: { hostId: 'local', conversationId: own.taskId,
            state: { [own.taskId]: [stockEntry(own.home)] } } });
        const deadline = Date.now() + 2_000;
        const refused = () => broker.frames.some(frame => frame.type === 'response' &&
          frame.requestId === 'uncontrolled-queue' && frame.resultType === 'error') ||
          own.daemon.metadata.nativeState === 'failed';
        while (!refused() && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(refused(), 'uncontrolled native queue request did not reach a refusal');
      } else assert.equal(own.daemon.metadata.state, 'failed');
      assert.equal(own.backend.settingsWrites, 1);
      assert.equal(own.backend.queueWrites, 0);
      assert.equal(own.backend.writes, 0);
      assert.equal(own.backend.exitCode, null);
      assert.ok(own.probeBrokers.some(broker => broker.frames.some(frame =>
        frame.method === 'thread-owner-discovery')));
    } finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      own.backend.stdin.end();
    }
  }
});

test('failed stock owner discovery requires explicit authenticated zero-work stop', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
    assert.equal(own.backend.writes, 0);
    assert.equal(own.backend.queueWrites, 0);
    const locator = JSON.parse(await readFile(path.join(own.privateDirectory,
      'startup-control.v1.json'), 'utf8')) as {control:{port:number}};
    const disconnected = await controlRequest(locator.control.port, own.reserved.epoch,
      'failed-status', 'status');
    assert.ok(disconnected.result);
    assert.equal(own.backend.exitCode, null, 'control EOF did not stop the worker');
    const stopped = await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'explicit-failed-stop', 'stop');
    assert.deepEqual(stopped.result, { stopped: true });
    assert.equal(own.daemon.metadata.state, 'stopped');
    assert.equal(own.backend.exitCode, 0);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    if (own.backend.exitCode === null) own.backend.stdin.end();
  }
});

test('failed-start stop refuses unconfirmed settings while preserving control and backend', async () => {
  const own = await readyFixture({ allow: true }, { enabled: false, early: false },
    'normal', true, 'notice');
  try {
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.settingsWrites, 1);
    assert.equal(own.backend.writes, 0);
    const refused = await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'unknown-settings-stop', 'stop');
    assert.equal(refused.error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
    assert.ok((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'unknown-settings-status', 'status')).result);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

test('failed-start family refusal is definitive and a later explicit stop can succeed', async () => {
  const family: { allow: boolean; beforeReturn?: () => void } = { allow: false };
  const own = await readyFixture(family, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-busy', 'stop')).error, 'stop-refused');
    assert.equal(own.backend.exitCode, null);
    assert.equal(own.daemon.metadata.state, 'failed');
    family.allow = true;
    family.beforeReturn = () => { throw new Error('test-only family proof unavailable'); };
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-family-error', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    delete family.beforeReturn;
    assert.deepEqual((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-idle', 'stop')).result, { stopped: true });
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    if (own.backend.exitCode === null) own.backend.stdin.end();
  }
});

test('failed-start stop refuses a backend birth change during family proof', async () => {
  const family: {allow:boolean;beforeReturn?:()=>void} = { allow: true };
  const own = await readyFixture(family, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    family.beforeReturn = () => { own.backend.birthDrift = true; };
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-birth-drift', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
    assert.ok((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-birth-status', 'status')).result);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

test('failed-start stop refuses a new unresolved server request during family proof', async () => {
  const family: {allow:boolean;beforeReturn?:()=>void} = { allow: true };
  const own = await readyFixture(family, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    family.beforeReturn = () => {
      own.backend.stdout.write(JSON.stringify({ id: 'pending-question',
        method: 'item/tool/requestUserInput', params: { threadId: own.taskId,
          turnId: 'none', questions: [] } }) + '\n');
    };
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-pending-request', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

test('failed-start stop refuses a durable accepted queue receipt even with zero visible turns', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, 'discovery');
  const generation = own.daemon.metadata.generation;
  assert.ok(generation);
  const journal = new ManagedWorkerOperationJournal({ filePath: path.join(own.privateDirectory,
    'operations.sqlite'), ownerEpoch: own.reserved.epoch, backendGeneration: generation,
  threadId: own.taskId });
  try {
    const operation = journal.reserve({ operationId: randomUUID(),
      clientUserMessageId: randomUUID(), method: 'thread/queue/add',
      fingerprint: 'a'.repeat(64) }).operation;
    journal.accept(operation, 'retained-queue-submission');
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-accepted-queue', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
  } finally {
    journal.close();
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

class Backend extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly pid = 42424; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  readonly methods: string[] = []; resumed = false; writes = 0; materializeTurn = true;
  stock = false; settingsWrites = 0; queueWrites = 0; emitSettingsNotice = true; birthDrift = false;
  readonly frames: Record<string, unknown>[] = [];
  failBootstrap = false;
  terminalQueueClients: string[] | null = null;
  stockCompletedClients: string[] = [];
  queueEntries: Record<string, unknown>[] = [];
  readStatusOverride: string | null = null;
  holdIdOnlyResume = false;
  heldIdOnlyResume: unknown = null;
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
        if (method === 'thread/settings/update') {
          this.settingsWrites++;
          queueMicrotask(() => {
            this.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\n');
            if (this.emitSettingsNotice) this.stdout.write(JSON.stringify({
              method: 'thread/settings/updated', params: { threadId: this.taskId,
                threadSettings: { ...(frame.params as Record<string, unknown>),
                  modelProvider: 'openai', sandboxPolicy: { type: 'dangerFullAccess' },
                  activePermissionProfile: { id: ':danger-full-access', extends: null },
                  disabledPluginIds: [], multiAgentMode: 'explicitRequestOnly' } } }) + '\n');
          });
          continue;
        }
        if (method === 'thread/queue/add') { this.queueWrites++;
          const params = frame.params as Record<string, unknown>;
          queueMicrotask(() => this.stdout.write(JSON.stringify({ id: frame.id,
            result: { queuedSubmission: { id: `submission-${this.queueWrites}`,
              clientUserMessageId: params.clientUserMessageId, input: params.input } } }) + '\n'));
          continue;
        }
        if (method === 'thread/resume' && this.holdIdOnlyResume &&
            Object.keys(frame.params as Record<string, unknown>).length === 1) {
          this.holdIdOnlyResume = false; this.heldIdOnlyResume = frame.id; continue;
        }
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
      model: 'gpt-5.6-sol', modelProvider: 'openai', reasoningEffort: this.stock ? 'medium' : 'low',
      status: { type: this.readStatusOverride ?? (this.resumed ? 'idle' : 'notLoaded') },
      turns: this.terminalTurns(),
      environments: this.stock ? [] : [{ environmentId: 'local', cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd] }] });
    if (method === 'initialize') return { serverInfo: { name: 'fixture' } };
    if (method === 'thread/read') return { thread: this.failBootstrap && this.resumed ?
      { ...thread(), status: { type: 'inProgress' } } : thread() };
    if (method === 'thread/turns/list') return { data: this.terminalTurns().map(turn =>
      ({ ...turn, itemsView: 'full' })), nextCursor: null };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/queue/list') return { data: this.queueEntries, nextCursor: null };
    if (method === 'thread/resume') {
      this.resumed = true;
      return { thread: thread(), cwd: this.cwd, model: 'gpt-5.6-sol', modelProvider: 'openai',
        reasoningEffort: this.stock ? 'medium' : 'low',
        approvalPolicy: 'never', activePermissionProfile: this.stock ?
          { id: ':danger-full-access', extends: null } : { id: ':read-only' },
        sandbox: this.stock ? { type: 'dangerFullAccess' } :
          { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [this.cwd],
        serviceTier: null, approvalsReviewer: 'user', disabledPluginIds: [],
        multiAgentMode: 'explicitRequestOnly', collaborationMode: null };
    }
    if (method === 'config/read') return { config: { model_reasoning_summary: null, personality: 'pragmatic' } };
    if (method === 'configRequirements/read') return { requirements: {
      featureRequirements: { fast_mode: false } } };
    throw new Error(`unexpected method ${method}`);
  }
  kill(): boolean { this.exitCode = 0; this.emit('close', 0, null); return true; }
  rejectHeldIdOnlyResume(): void {
    assert.notEqual(this.heldIdOnlyResume, null);
    this.stdout.write(JSON.stringify({ id: this.heldIdOnlyResume,
      error: { code: -32001, message: 'fixture-current-read-unavailable' } }) + '\n');
    this.heldIdOnlyResume = null;
  }
  terminalTurns(): Record<string, unknown>[] {
    if (this.stock && this.stockCompletedClients.length) return this.stockCompletedClients.map((clientId, index) =>
      ({ id: `stock-turn-${index + 1}`, status: 'completed', items: [
        { id: `stock-user-${index + 1}`, type: 'userMessage', clientId,
          content: [{ type: 'text', text: 'PUBLIC_OK' }] },
        { id: `stock-agent-${index + 1}`, type: 'agentMessage', text: 'done' } ] }));
    if (this.terminalQueueClients !== null) return [{ id: 'queue-terminal-turn', status: 'completed',
      items: this.terminalQueueClients.map((clientId, index) => ({ id: `queue-user-${index}`,
        type: 'userMessage', clientId, content: [{ type: 'text', text: 'fixture only' }] })) }];
    return this.writes && this.materializeTurn ?
      [{ id: 'accepted-composer-turn', status: 'completed', items: [] }] : [];
  }
}
class Broker extends Duplex {
  readonly decoder = new FrameDecoder();
  readonly frames: Record<string, unknown>[] = [];
  constructor(readonly early: Record<string, unknown> | null = null, readonly taskId = '',
    readonly rejectInitialize = false, readonly probe = false,
    readonly ownerId = 'local-owner', readonly initialFollow = false) { super(); }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    for (const frame of this.decoder.push(chunk)) {
      this.frames.push(frame);
      if (frame.method === 'initialize') {
        if (this.rejectInitialize) { queueMicrotask(() => this.destroy()); continue; }
        const reply = encodeFrame({ type: 'response', requestId: frame.requestId,
          resultType: 'success', result: { clientId: this.probe ? 'probe' : this.ownerId } });
        if (this.early) this.push(Buffer.concat([reply, encodeFrame({ type: 'broadcast',
          method: 'thread-stream-following-changed', version: 1, sourceClientId: 'follower',
          params: { conversationId: this.taskId, hostId: 'local', following: true } }), encodeFrame(this.early)]));
        else if (this.initialFollow) this.push(Buffer.concat([reply, encodeFrame({ type: 'broadcast',
          method: 'thread-stream-following-changed', version: 1, sourceClientId: 'follower',
          params: { conversationId: this.taskId, hostId: 'local', following: true } })]));
        else this.push(reply);
      }
      if (frame.method === 'thread-owner-discovery') this.push(encodeFrame({ type: 'response',
        requestId: frame.requestId, resultType: 'success', handledByClientId: this.ownerId,
        result: { supportsUntrustedAppInput: false } }));
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

function stockEntry(cwd: string, id = randomUUID()): Record<string, unknown> {
  const mode = { mode: 'default', settings: { model: 'gpt-5.6-sol',
    reasoning_effort: 'medium', developer_instructions: null } };
  return { id, text: 'PUBLIC_OK', cwd, createdAt: 1780000000000,
    context: { prompt: 'PUBLIC_OK', turnTrigger: 'composer', workspaceRoots: [cwd],
      usedDictation: false, existingWorkspaceRoot: null, localProjectId: null,
      fileAttachments: [], addedFiles: [] },
    responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    submissionOptions: { executionHostId: 'local', agentMode: 'full-access',
      permissionProfileId: ':danger-full-access', serviceTier: 'default',
      shouldSendPermissionOverrides: false, usePermissionSelection: false,
      permissionSelection: null, collaborationMode: mode,
      clientUserMessageId: randomUUID() },
    writingBlockAdditionalContext: null, mentionedBrowserFamilies: [], submissionIntent: 'send-now',
    submission: { hostId: 'local', status: 'pending', queueModeOverride: 'queue' } };
}

async function readyFixture(family: { allow: boolean; beforeReturn?: () => void;
  expectedTurnCount?: number } = { allow: true },
  native: { enabled: boolean; early: boolean; available?: boolean } = { enabled: false, early: false },
  startup: 'normal' | 'bootstrap-fail' | 'control-bind-fail' | 'endpoint-collision' = 'normal',
  stock = false, stockFailure: 'baseline' | 'discovery' | 'notice' | null = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-ready-'));
  const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
  await Promise.all([mkdir(home), mkdir(privateDirectory)]);
  if (startup === 'endpoint-collision')
    await writeFile(path.join(privateDirectory, 'endpoint.v1.json'), 'preexisting-own-endpoint');
  const cliPath = path.join(root, 'cli.exe'), registryPath = path.join(root, 'registry.sqlite');
  await writeFile(cliPath, 'pinned-code');
  const registry = new ManagedWorkerRegistry(registryPath);
  const reserved = registry.reserve(home, 'own-family'); registry.close();
  const taskId = stock ? randomUUID() : 'own-zero-turn';
  const backend = new Backend(taskId, home), brokers: Broker[] = [], probeBrokers: Broker[] = [],
    handlerErrors: string[] = [];
  const ownerId = stock ? randomUUID() : 'local-owner';
  backend.stock = stock;
  backend.emitSettingsNotice = stockFailure !== 'notice';
  backend.failBootstrap = startup === 'bootstrap-fail';
  let control: ManagedWorkerControlServer | null = null;
  let launches = 0, observations = 0;
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: root, epoch: reserved.epoch, allowFollower: () => native.enabled,
    ...(stock ? { nativeStockQueue: { sourceGeneration: 'qualified-stock-v1',
      assertControlledNativeBaseline: () => stockFailure !== 'baseline',
      createProbeClient: () => new DesktopIpcClient(() => {
        const probe = new Broker(null, taskId, false, true,
          stockFailure === 'discovery' ? 'foreign-owner' : ownerId);
        probeBrokers.push(probe); return probe;
      }, 500) } } : {}),
    clientFactory: handler => new DesktopIpcClient(() => {
      const broker = new Broker(native.early && brokers.length === 0 ?
        composerRequest(taskId, home, 'before-ready') : null, taskId, native.available === false,
        false, ownerId, stock && stockFailure !== 'baseline');
      brokers.push(broker); return broker;
    }, 500, { canHandle: request => handler.canHandle(request),
      handle: async (request, signal) => {
        try { return await handler.handle(request, signal); }
        catch (error) { handlerErrors.push(error instanceof Error ? error.message : 'non-error'); throw error; }
      } }),
    verifyFamilyQuiescent: async ({ idle }) => {
      family.beforeReturn?.();
      if (family.expectedTurnCount !== undefined)
        return family.allow && idle.turnCount === family.expectedTurnCount;
      return family.allow && (native.enabled && backend.writes && backend.materializeTurn ?
        idle.turnCount === 1 && idle.latestTurnId === 'accepted-composer-turn' :
        idle.turnCount === 0 && idle.latestTurnId === null);
    },
    dependencies: {
      createControl: options => {
        control = startup === 'control-bind-fail' ?
          new class extends ManagedWorkerControlServer {
            override listen(): ReturnType<ManagedWorkerControlServer['listen']> {
              return Promise.reject(new Error('fixture bind failure'));
            }
          }(options) : new ManagedWorkerControlServer(options);
        return control;
      },
      loadPrivateState: async () => ({ manifest: {
        schemaVersion: 1, epoch: reserved.epoch, taskId, familyRoot: 'own-family',
        home, cwd: home, cliPath, cliSha256: createHash('sha256').update('pinned-code').digest('hex'),
        initializeRequest: { clientInfo: { name: 'fixture' }, capabilities: {} },
        resumeParams: { threadId: taskId, cwd: home, model: 'gpt-5.6-sol',
          permissions: stock ? ':danger-full-access' : ':read-only', approvalPolicy: 'never',
          runtimeWorkspaceRoots: [home], config: { model_reasoning_effort: stock ? 'medium' : 'low' } },
        ...(stock ? { approvedTaskPolicy: approveTaskPolicy({ threadId: taskId,
          model: 'gpt-5.6-sol', modelProvider: 'openai', effort: 'medium', cwd: home,
          runtimeWorkspaceRoots: [home], environments: [], approvalPolicy: 'never',
          approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', extends: null },
          sandbox: { type: 'dangerFullAccess' }, serviceTier: null }) } : {}), registryPath,
      }, keys: { fingerprintKey: Buffer.alloc(32, 1).toString('base64'),
        intentKey: Buffer.alloc(32, 2).toString('base64'),
        controlToken: Buffer.alloc(32, 3).toString('base64') }, privateDirectory }),
      observeProcess: pid => { observations++; return pid === backend.pid && backend.exitCode !== null ? null :
        { pid, birthTicks: String(pid + 100 + (pid === backend.pid && backend.birthDrift ? 1 : 0)) }; },
      launch: () => { launches++; return backend as unknown as ChildProcessWithoutNullStreams; },
    },
  });
  if (stockFailure === 'discovery' || stockFailure === 'notice') {
    try {
      await daemon.start();
      throw new Error(`stock ${stockFailure} unexpectedly reached ready`);
    } catch (error) {
      if (daemon.metadata.state !== 'failed') {
        await (control as ManagedWorkerControlServer | null)?.close(); backend.stdin.end();
        throw error;
      }
    }
  }
  else if (startup === 'normal') {
    try { await daemon.start(); }
    catch (error) {
      if (stock) { await (control as ManagedWorkerControlServer | null)?.close(); backend.stdin.end(); }
      throw error;
    }
  }
  else await assert.rejects(daemon.start(), /startup unavailable/);
  return { daemon, backend, brokers, probeBrokers, handlerErrors, reserved, home, taskId, registryPath,
    privateDirectory, launches, observations, control };
}

test('backend spawn specification strips synthetic bridge hooks and retains TLS and proxy settings', () => {
  const source = Object.freeze({ Path: 'synthetic-path', HTTP_PROXY: 'http://synthetic.invalid',
    NO_PROXY: 'synthetic-no-proxy', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    CODEX_API_KEY: 'synthetic-auth', cOdEx_HoMe: 'old-home', VK_TOKEN: 'synthetic-vk',
    vkOdEx_Secret: 'synthetic-vkodex', BOT_DATA_DIR: 'synthetic-bot',
    nOdE_OpTiOnS: 'synthetic-node-hook', ELECTRON_RUN_AS_NODE: 'synthetic-electron' });
  const spec = buildBackendWorkerSpawnOptions('C:/qualified/cwd', 'C:/qualified/home', source);
  assert.deepEqual(spec.env, { Path: 'synthetic-path', HTTP_PROXY: 'http://synthetic.invalid',
    NO_PROXY: 'synthetic-no-proxy', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    CODEX_API_KEY: 'synthetic-auth', CODEX_HOME: 'C:/qualified/home' });
  assert.deepEqual(source, { Path: 'synthetic-path', HTTP_PROXY: 'http://synthetic.invalid',
    NO_PROXY: 'synthetic-no-proxy', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    CODEX_API_KEY: 'synthetic-auth', cOdEx_HoMe: 'old-home', VK_TOKEN: 'synthetic-vk',
    vkOdEx_Secret: 'synthetic-vkodex', BOT_DATA_DIR: 'synthetic-bot',
    nOdE_OpTiOnS: 'synthetic-node-hook', ELECTRON_RUN_AS_NODE: 'synthetic-electron' });
  assert.deepEqual(spec.stdio, ['pipe', 'pipe', 'pipe']);
});

async function controlRequest(port: number, epoch: string, id: string, method: string,
  afterAuth?: () => void | Promise<void>): Promise<Record<string, unknown>> {
  const socket = connect(port, '127.0.0.1');
  let buffer = ''; const frames: Record<string, unknown>[] = [];
  let terminal: 'closed' | 'errored' | null = null;
  socket.on('data', chunk => { buffer += chunk.toString();
    while (buffer.includes('\n')) { const at = buffer.indexOf('\n');
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1); }
  });
  socket.on('error', () => { terminal = 'errored'; });
  socket.on('close', () => { terminal ??= 'closed'; });
  await new Promise<void>((resolve, reject) => {
    const connected = () => { socket.off('error', failed); resolve(); };
    const failed = () => { socket.off('connect', connected); reject(new Error('control socket connection failed')); };
    socket.once('connect', connected); socket.once('error', failed);
  });
  const wait = async (phase: 'auth' | 'commandreply', predicate: (frame: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate); if (found) return found;
      if (terminal !== null) throw new Error(`control socket ${terminal} during ${phase}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`control ${phase} timeout (frames=${frames.length})`);
  };
  try {
    socket.write(JSON.stringify({ token: Buffer.alloc(32, 3).toString('base64url') }) + '\n');
    await wait('auth', frame => frame.ok === true);
    await afterAuth?.();
    socket.write(JSON.stringify({ id, epoch, method }) + '\n');
    return await wait('commandreply', frame => frame.id === id);
  } finally { socket.destroy(); }
}

async function controlStop(privateDirectory: string, epoch: string, id: string): Promise<Record<string, unknown>> {
  const endpoint = JSON.parse(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8')) as
    { control: { port: number } };
  return controlRequest(endpoint.control.port, epoch, id, 'stop');
}

async function startupControlRequest(privateDirectory: string, epoch: string,
  id: string, method: string, afterAuth?: () => void | Promise<void>): Promise<Record<string, unknown>> {
  const locator = JSON.parse(await readFile(path.join(privateDirectory, 'startup-control.v1.json'), 'utf8')) as
    { control: { port: number } };
  return controlRequest(locator.control.port, epoch, id, method, afterAuth);
}

test('control bind failure leaves reserved worker unlaunched', async () => {
  const { daemon, backend, launches, control, registryPath, home, privateDirectory } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'control-bind-fail');
  try {
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(launches, 0);
    assert.equal(backend.methods.length, 0);
    await assert.rejects(readFile(path.join(privateDirectory, 'endpoint.v1.json')));
    await assert.rejects(readFile(path.join(privateDirectory, 'startup-control.v1.json')));
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'host_registered'); }
    finally { registry.close(); }
  } finally { await (control as ManagedWorkerControlServer | null)?.close(); }
});

test('bootstrap failure retains authenticated startup diagnosis while EOF cannot stop worker', async () => {
  const { daemon, backend, launches, control, reserved, privateDirectory, registryPath, home } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'bootstrap-fail');
  try {
    assert.equal(launches, 1);
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.startupPhase, 'bootstrapping');
    const locator = JSON.parse(await readFile(path.join(privateDirectory, 'startup-control.v1.json'), 'utf8')) as
      Record<string, unknown>;
    assert.deepEqual(Object.keys(locator).sort(), ['control', 'epoch', 'host', 'schemaVersion']);
    assert.equal(locator.epoch, reserved.epoch);
    assert.equal(JSON.stringify(locator).includes(Buffer.alloc(32, 3).toString('base64url')), false);
    await assert.rejects(readFile(path.join(privateDirectory, 'endpoint.v1.json')));
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'backend_registered'); }
    finally { registry.close(); }
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'd', 'diagnose-v1');
    assert.deepEqual(diagnosis.result, { ownerEpoch: reserved.epoch, taskId: 'own-zero-turn',
      schemaVersion: 1, startupPhase: 'bootstrapping', daemonState: 'failed',
      failureCode: 'startup-unavailable', registryState: 'backend_registered', owner: null });
    const changed = new ManagedWorkerRegistry(registryPath);
    try {
      const row = changed.get(home, 'own-family')!;
      changed.markLost(row, row.host!, row.backend!, 'backend_unavailable');
    } finally { changed.close(); }
    const later = await startupControlRequest(privateDirectory, reserved.epoch, 'later', 'diagnose-v1');
    assert.equal((later.result as Record<string, unknown>).registryState, 'lost');
    assert.equal((await startupControlRequest(privateDirectory, reserved.epoch, 's', 'stop')).error,
      'stop-refused');
    assert.equal((await startupControlRequest(privateDirectory, reserved.epoch, 'again', 'status')).result
      ? 'available' : 'missing', 'available');
    assert.equal(backend.exitCode, null);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
});

test('control request helper reports an authenticated control termination during command reply', async () => {
  const { backend, control, reserved, privateDirectory } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'bootstrap-fail');
  try {
    if (control === null) throw new Error('fixture control unavailable');
    const activeControl = control as unknown as ManagedWorkerControlServer;
    await assert.rejects(startupControlRequest(privateDirectory, reserved.epoch, 'closed', 'status',
      async () => { await activeControl.close(); }),
    /control socket (closed|errored) during commandreply/);
    assert.equal(backend.exitCode, null);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
});

test('post-owner ready endpoint collision retires native gateway but preserves backend and startup control', async () => {
  const { daemon, backend, brokers, control, reserved, privateDirectory, registryPath, home } =
    await readyFixture({ allow: true }, { enabled: true, early: false }, 'endpoint-collision');
  try {
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.startupPhase, 'publishing-ready');
    assert.equal(daemon.metadata.nativeState, 'closed');
    assert.equal(brokers.length, 1);
    assert.equal(brokers[0]!.destroyed, true);
    assert.equal(backend.exitCode, null);
    assert.equal(backend.writes, 0);
    assert.equal(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8'),
      'preexisting-own-endpoint');
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'backend_registered'); }
    finally { registry.close(); }
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'failed-owner', 'diagnose-v1');
    assert.deepEqual(diagnosis.result, { ownerEpoch: reserved.epoch, taskId: 'own-zero-turn',
      schemaVersion: 1, startupPhase: 'publishing-ready', daemonState: 'failed',
      failureCode: 'startup-unavailable', registryState: 'backend_registered',
      owner: daemon.metadata.nativeStartup });
    assert.deepEqual((await startupControlRequest(privateDirectory, reserved.epoch, 'stop', 'stop')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
    assert.equal(backend.exitCode, 0);
    assert.equal(backend.writes, 0);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
});

for (const meaningful of [false, true]) {
  test(`stop fence ${meaningful ? 'rejects a new turn' : 'permits usage-only updates'} during family proof`, async () => {
    const family: { allow: boolean; beforeReturn?: () => void } = { allow: true };
    const f = await readyFixture(family);
    const usage = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    family.beforeReturn = () => {
      f.backend.stdout.write(JSON.stringify(meaningful
        ? { method: 'turn/started', params: { threadId: 'own-zero-turn',
          turn: { id: 'raced-turn', status: 'inProgress', items: [] } } }
        : { method: 'thread/tokenUsage/updated', params: { threadId: 'own-zero-turn',
          turnId: 'usage-only', tokenUsage: { total: usage, last: usage, modelContextWindow: null } } }) + '\n');
    };
    try {
      const reply = await controlStop(f.privateDirectory, f.reserved.epoch, 'fenced-stop');
      if (meaningful) {
        assert.equal(reply.error, 'stop-refused');
        assert.equal(f.backend.exitCode, null);
        assert.equal(f.daemon.metadata.state, 'ready');
      } else {
        assert.deepEqual(reply.result, { stopped: true });
        assert.equal(f.backend.exitCode, 0);
      }
    } finally {
      await (f.control as ManagedWorkerControlServer | null)?.close();
      if (f.backend.exitCode === null) f.backend.stdin.end();
    }
  });
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

test('native projection failure retires daemon readiness while preserving backend and diagnosis', async () => {
  const { daemon, backend, control, reserved, privateDirectory, registryPath, home } = await readyFixture();
  try {
    backend.stdout.write(JSON.stringify({ method: 'thread/unsupported',
      params: { threadId: 'own-zero-turn' } }) + '\n');
    const ownerDeadline = Date.now() + 2000;
    while (daemon.metadata.nativeState !== 'failed' && Date.now() < ownerDeadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(daemon.metadata.nativeState, 'failed');
    const daemonDeadline = Date.now() + 2500;
    while (daemon.metadata.state === 'ready' && Date.now() < daemonDeadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.failure, 'native-owner-unavailable');
    assert.equal(backend.exitCode, null);
    assert.equal(backend.writes, 0);
    assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'ready'); }
    finally { registry.close(); }
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'owner-failed', 'diagnose-v1');
    assert.equal((diagnosis.result as Record<string, unknown>).daemonState, 'failed');
    assert.equal((diagnosis.result as Record<string, unknown>).failureCode, 'native-owner-unavailable');
    assert.equal((diagnosis.result as Record<string, unknown>).registryState, 'ready');
    assert.equal((await startupControlRequest(privateDirectory, reserved.epoch, 'stop-failed', 'stop')).error,
      'stop-refused');
    assert.equal(backend.exitCode, null);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
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

test('qualified backend publishes disconnected native gateway then reconnects same worker', async () => {
  const native = { enabled: false, early: false, available: false };
  const { daemon, backend, brokers, reserved, privateDirectory, registryPath, home, launches, control } =
    await readyFixture({ allow: true }, native);
  try {
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(daemon.metadata.nativeState, 'disconnected');
    assert.equal(daemon.metadata.nativeStartup?.startupStage, 'connecting');
    assert.equal(backend.exitCode, null);
    assert.equal(backend.writes, 0);
    assert.equal(launches, 1);
    assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'ready'); }
    finally { registry.close(); }
    const status = await startupControlRequest(privateDirectory, reserved.epoch, 'headless-status', 'status');
    assert.equal((status.result as Record<string, unknown>).nativeState, 'disconnected');
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'headless-diagnose', 'diagnose-v1');
    assert.equal((diagnosis.result as Record<string, unknown>).daemonState, 'ready');
    assert.equal((diagnosis.result as Record<string, unknown>).ownerEpoch, reserved.epoch);
    native.available = true;
    const currentNativeState = () => daemon.metadata.nativeState;
    const deadline = Date.now() + 4000;
    while (currentNativeState() !== 'connected' && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(currentNativeState(), 'connected');
    assert.equal(brokers.length, 2);
    assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(backend.writes, 0);
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-after-late-connect')).result,
      { stopped: true });
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    if (backend.exitCode === null) backend.stdin.end();
  }
});

test('headless backend can be explicitly stopped while native broker remains unavailable', async () => {
  const { daemon, backend, reserved, privateDirectory, control } = await readyFixture(
    { allow: true }, { enabled: false, early: false, available: false });
  try {
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(daemon.metadata.nativeState, 'disconnected');
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-headless')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
    assert.equal(backend.exitCode, 0);
    assert.equal(backend.writes, 0);
  } finally { await (control as ManagedWorkerControlServer | null)?.close(); }
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
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.materializeTurn = true;
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'now-terminal')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
  } finally {
    if (backend.exitCode === null) { backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null); }
  }
});

test('temporary read-only idle proof refusal keeps an exact live worker ready', async () => {
  const { daemon, backend, reserved, privateDirectory } = await readyFixture();
  try {
    backend.queueEntries = [{ id: 'still-queued' }];
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'queue-busy')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.queueEntries = [];
    backend.readStatusOverride = 'inProgress';
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'not-idle')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.readStatusOverride = null;
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'now-idle')).result,
      { stopped: true });
  } finally {
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
  }
});

test('stop refuses a native continuation still qualifying before any second worker RPC', async () => {
  const { daemon, backend, brokers, reserved, privateDirectory, home } = await readyFixture(
    { allow: true }, { enabled: true, early: false });
  const broker = brokers[0]!;
  const until = Date.now() + 2500;
  try {
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: 'own-zero-turn',
        hostId: 'local', following: true } });
    while (!broker.frames.some(frame => frame.method === 'thread-stream-state-changed') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    broker.send(composerRequest('own-zero-turn', home, 'first-composer'));
    while (!broker.frames.some(frame => frame.type === 'response' && frame.requestId === 'first-composer') &&
      Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'first-composer')?.resultType, 'success');
    assert.equal(backend.writes, 1);
    backend.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'own-zero-turn',
      turn: { id: 'accepted-composer-turn', status: 'inProgress', startedAt: 2, items: [] } } }) + '\n');
    backend.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'own-zero-turn',
      turn: { id: 'accepted-composer-turn', status: 'completed', startedAt: 2, items: [] } } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    backend.holdIdOnlyResume = true;
    broker.send(composerRequest('own-zero-turn', home, 'second-qualifying'));
    while (backend.heldIdOnlyResume === null && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.notEqual(backend.heldIdOnlyResume, null,
      JSON.stringify({ methods: backend.methods, responses: broker.frames.filter(frame =>
        frame.type === 'response').map(frame => ({ id: frame.requestId, type: frame.resultType })) }));
    assert.equal(backend.writes, 1);
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'native-before-rpc')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.rejectHeldIdOnlyResume();
    while (!broker.frames.some(frame => frame.type === 'response' &&
      frame.requestId === 'second-qualifying') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'second-qualifying')?.resultType, 'error');
    assert.equal(backend.writes, 1);
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'native-drained')).result,
      { stopped: true });
  } finally {
    if (backend.heldIdOnlyResume !== null) backend.rejectHeldIdOnlyResume();
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
  }
});

test('accepted queue input stops only after exact unique terminal user client identity', async () => {
  for (const observed of [['queue-client'], ['other-client'], ['queue-client', 'queue-client']]) {
    const { daemon, backend, reserved, privateDirectory } = await readyFixture(
      { allow: true, expectedTurnCount: 1 });
    const generation = daemon.metadata.generation;
    assert.ok(generation);
    const journal = new ManagedWorkerOperationJournal({
      filePath: path.join(privateDirectory, 'operations.sqlite'), ownerEpoch: reserved.epoch,
      backendGeneration: generation, threadId: 'own-zero-turn' });
    try {
      const operation = journal.reserve({ operationId: randomUUID(),
        clientUserMessageId: 'queue-client', method: 'thread/queue/add',
        fingerprint: 'a'.repeat(64) }).operation;
      journal.accept(operation, 'actual-queue-submission');
      backend.terminalQueueClients = observed;
      const first = await controlStop(privateDirectory, reserved.epoch, `queue-stop-${observed.length}`);
      if (observed.length === 1 && observed[0] === 'queue-client') {
        assert.deepEqual(first.result, { stopped: true });
      } else {
        assert.equal(first.error, 'stop-refused');
        assert.equal(daemon.metadata.state, 'ready');
        assert.equal(backend.exitCode, null);
        backend.terminalQueueClients = ['queue-client'];
        assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'queue-terminal-proven')).result,
          { stopped: true });
      }
    } finally {
      journal.close();
      if (backend.exitCode === null) {
        backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
      }
    }
  }
});

test('duplicate accepted queue submission IDs refuse stop even with distinct terminal clients', async () => {
  const { daemon, backend, reserved, privateDirectory, control } = await readyFixture(
    { allow: true, expectedTurnCount: 1 });
  const generation = daemon.metadata.generation;
  assert.ok(generation);
  const journal = new ManagedWorkerOperationJournal({
    filePath: path.join(privateDirectory, 'operations.sqlite'), ownerEpoch: reserved.epoch,
    backendGeneration: generation, threadId: 'own-zero-turn' });
  try {
    for (const clientUserMessageId of ['queue-one', 'queue-two']) {
      const operation = journal.reserve({ operationId: randomUUID(), clientUserMessageId,
        method: 'thread/queue/add', fingerprint: 'a'.repeat(64) }).operation;
      journal.accept(operation, 'same-submission-id');
    }
    backend.terminalQueueClients = ['queue-one', 'queue-two'];
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'duplicate-queue-receipt')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
  } finally {
    journal.close();
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
    await (control as ManagedWorkerControlServer | null)?.close();
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
