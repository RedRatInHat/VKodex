import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AppServerInitializedSession, AppServerRequestOptions,
  AppServerResponseEnvelope } from '../src/codex/app-server-connection.js';
import { PersistentFrontendSessions } from '../src/codex/persistent-frontend-session.js';
import { AppServerRequestInbox } from '../src/codex/app-server-request-inbox.js';

type JsonObject = Record<string, unknown>;
type TestFrame = JsonObject & {
  id?: string | number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject & { thread?: { id?: string } };
  error?: JsonObject & { code?: number };
};
type RequestOptions = AppServerRequestOptions & {
  expectedGeneration: number;
  onResponseEnvelope: (envelope: AppServerResponseEnvelope) => void;
};
interface TestBackend {
  initializeCalls: number;
  closeCalls: number;
  requests: Array<{ method: string; params: JsonObject; options: RequestOptions }>;
  notifications: Set<(notification: { method: string; params: JsonObject }) => void>;
  sessionGeneration: number;
  actualInitializeRequest?: Readonly<JsonObject>;
  initializedSession(): Promise<AppServerInitializedSession>;
  isSessionCurrent(generation: number): boolean;
  onNotification(listener: (notification: { method: string; params: JsonObject }) => void): () => void;
  request(method: string, params: JsonObject, options: RequestOptions): Promise<unknown>;
  close(): Promise<void>;
  emit(notification: { method: string; params: JsonObject }): void;
}
type SessionOptions = ConstructorParameters<typeof PersistentFrontendSessions>[0];
type Frontend = ReturnType<PersistentFrontendSessions['attach']>;
type InboxSend = Parameters<NonNullable<SessionOptions['requestInbox']>['attach']>[0];

// Installed VSCode 26.5917.62051 out/extension.js, initialize at ~2006618.
// Tj() returns "VS Code" for the installed host. $u().version normalizes
// package 26.5917.62051 to wire clientInfo.version 26.917.62051.
const vscodeInitialize = Object.freeze({
  clientInfo: { name: 'VS Code', title: 'Codex Extension', version: '26.917.62051' },
  capabilities: {
    experimentalApi: true,
    extensions: { 'openai/elicitation': { form: {} } },
    mcpServerOpenaiFormElicitation: true,
    requestAttestation: false,
  },
});
const taskId = '01a0e351-946b-7c31-9d1e-565bc68dcbc5';
const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fakeBackend(): TestBackend {
  const notifications = new Set<(notification: { method: string; params: JsonObject }) => void>();
  const requests: TestBackend['requests'] = [];
  const backend: TestBackend = {
    initializeCalls: 0, closeCalls: 0, requests, notifications,
    sessionGeneration: 7,
    async initializedSession() {
      this.initializeCalls++;
      return { generation: this.sessionGeneration,
        initializeResult: { userAgent: 'real-worker-agent', codexHome: 'isolated-home',
          platformFamily: 'windows', platformOs: 'windows' } };
    },
    isSessionCurrent(generation: number) { return generation === this.sessionGeneration; },
    onNotification(listener: (notification: { method: string; params: JsonObject }) => void) {
      notifications.add(listener); return () => notifications.delete(listener);
    },
    async request(method: string, params: JsonObject, options: RequestOptions) {
      requests.push({ method, params, options });
      const result = { method, threadId: params.threadId,
        ...(method === 'thread/read' || method === 'thread/resume' ?
          { thread: { id: params.threadId } } : {}) };
      options.onResponseEnvelope({ result });
      return result;
    },
    async close() { this.closeCalls++; },
    emit(notification: { method: string; params: JsonObject }) {
      for (const listener of [...notifications]) listener(notification);
    },
  };
  return backend;
}
function createSessions(backend: TestBackend, extra: Partial<SessionOptions> = {}) {
  return new PersistentFrontendSessions({ taskId, initializeRequest: vscodeInitialize,
    ...extra,
    backendFactory: actualRequest => {
      assert.deepEqual(actualRequest, vscodeInitialize);
      assert.equal(Object.isFrozen(actualRequest), true);
      assert.equal(Object.isFrozen((actualRequest.capabilities as JsonObject).extensions), true);
      backend.actualInitializeRequest = actualRequest;
      return backend as unknown as ReturnType<SessionOptions['backendFactory']>;
    } });
}

function fakeInbox(threadId = taskId, generation = 7) {
  const owner = Object.freeze({ threadId, generation });
  const question = { id: 70, method: 'item/tool/requestUserInput',
    params: { threadId, questions: [] } };
  const leases: Array<{ active: boolean }> = [];
  const answers: Array<{ id: string | number; result?: JsonObject; error?: JsonObject }> = [];
  return { owner, leases, answers, attach(send: InboxSend) {
    const lease = { active: true,
      detach() { this.active = false; },
      answer(id: string | number, result: JsonObject) {
        if (!this.active || id !== question.id) return false;
        answers.push({ id, result }); return true;
      },
      reject(id: string | number, error: JsonObject) {
        if (!this.active || id !== question.id) return false;
        answers.push({ id, error }); return true;
      } };
    leases.push(lease);
    send(question);
    return lease;
  } };
}

test('inbox replay follows initialize result and only current lease answers', async () => {
  const backend = fakeBackend();
  const inbox = fakeInbox();
  const sessions = createSessions(backend, { requestInbox: inbox });
  const first = attach(sessions); await initialize(first.frontend);
  assert.equal(first.frames[0]!.id, '1');
  assert.deepEqual(first.frames[1]!, { id: 70, method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } });
  first.frontend.detach();
  const second = attach(sessions); await initialize(second.frontend);
  assert.equal(inbox.leases[0]!.active, false);
  assert.equal(inbox.leases[1]!.active, true);
  assert.deepEqual(second.frames.map(frame => frame.id), ['1', 70]);
  assert.equal(await first.frontend.receive({ id: 70, result: { answers: {} } }), 'detached-or-invalid');
  assert.equal(await second.frontend.receive({ id: 70, result: { answers: {} } }), 'server-request-answered');
  assert.deepEqual(inbox.answers, [{ id: 70, result: { answers: {} } }]);
  assert.equal(backend.closeCalls, 0);
});

test('inbox negative answers preserve exact error and malformed replies cause no loop', async () => {
  const backend = fakeBackend();
  const inbox = fakeInbox();
  const { frames, frontend } = attach(createSessions(backend, { requestInbox: inbox }));
  await initialize(frontend);
  const error = { code: -32602, message: 'Declined', data: { reason: 'fixture' } };
  for (const frame of [
    { id: 70, result: {}, error }, { id: 70, method: 'turn/start', result: {} },
    { id: 71, result: {} }, { id: 70, result: {}, surprise: true },
  ]) assert.notEqual(await frontend.receive(frame), 'server-request-answered');
  assert.equal(frames.length, 2);
  assert.deepEqual(inbox.answers, []);
  assert.equal(await frontend.receive({ id: 70, error }), 'server-request-answered');
  assert.deepEqual(inbox.answers, [{ id: 70, error }]);
});

test('inbox owner task and generation must match the pinned backend', async () => {
  const backend = fakeBackend();
  assert.throws(() => createSessions(backend, { requestInbox: fakeInbox('foreign') }), TypeError);
  const stale = fakeInbox(taskId, 8);
  const { frames, frontend } = attach(createSessions(backend, { requestInbox: stale }));
  await initialize(frontend);
  assert.equal(frames[0]!.error!.code, -32001);
  assert.equal(stale.leases.length, 0);
  assert.equal(backend.requests.length, 0);
});

test('a synchronous frontend reply during inbox replay is accepted after lease creation', async () => {
  const backend = fakeBackend();
  const inbox = fakeInbox();
  const sessions = createSessions(backend, { requestInbox: inbox });
  const frames: TestFrame[] = [], replies: Array<Promise<string>> = [];
  let frontend!: Frontend;
  frontend = sessions.attach(frame => {
    frames.push(frame);
    if (frame.method === 'item/tool/requestUserInput')
      replies.push(frontend.receive({ id: frame.id, result: { answers: {} } }));
  });
  await initialize(frontend);
  assert.deepEqual(await Promise.all(replies), ['server-request-answered']);
  assert.deepEqual(inbox.answers, [{ id: 70, result: { answers: {} } }]);
  assert.deepEqual(frames.map(frame => frame.id), ['1', 70]);
});

test('external server-request resolution is forwarded only for own typed request', async () => {
  const backend = fakeBackend();
  const { frames, frontend } = attach(createSessions(backend, { requestInbox: fakeInbox() }));
  await initialize(frontend);
  backend.emit({ method: 'serverRequest/resolved',
    params: { threadId: taskId, requestId: 70 } });
  backend.emit({ method: 'serverRequest/resolved',
    params: { threadId: 'foreign', requestId: 70 } });
  backend.emit({ method: 'serverRequest/resolved',
    params: { threadId: taskId, requestId: {} } });
  assert.deepEqual(frames.slice(2), [{ method: 'serverRequest/resolved',
    params: { threadId: taskId, requestId: 70 } }]);
});

test('malformed synchronous replay answers are bounded and never sent to backend', async () => {
  const backend = fakeBackend();
  const answers: Array<Promise<string>> = [];
  const inbox = { owner: Object.freeze({ threadId: taskId, generation: 7 }),
    attach(send: InboxSend) {
      for (let id = 1; id <= 66; id++) send({ id, method: 'item/tool/requestUserInput',
        params: { threadId: taskId } });
      return { detach() {}, answer() { return true; }, reject() { return true; } };
    } };
  const sessions = createSessions(backend, { requestInbox: inbox });
  let frontend!: Frontend;
  frontend = sessions.attach(frame => {
    if (!frame.method) return;
    answers.push(frontend.receive({ id: frame.id,
      result: frame.id === 1 ? { invalid: () => {} } : {} }));
  });
  await initialize(frontend);
  const statuses = await Promise.all(answers);
  assert.equal(statuses[0]!, 'invalid-server-request-answer');
  assert.equal(statuses.filter(status => status === 'server-request-answered').length, 64);
  assert.equal(statuses[65]!, 'server-request-unavailable');
  assert.equal(backend.requests.length, 0);
});

test('actual inbox and connection preserve wire order, replay, and native error',
  { skip: !process.execArgv.includes('tsx') }, async () => {
    const [{ AppServerConnection }, { AppServerRequestInbox }] = await Promise.all([
      import('../src/codex/app-server-connection.js'),
      import('../src/codex/app-server-request-inbox.js'),
    ]);
    class Child extends EventEmitter {
      stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
      messages: TestFrame[] = []; exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null; pid = undefined;
      constructor() {
        super(); let buffer = '';
        this.stdin.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n');
            const message = JSON.parse(buffer.slice(0, end)) as TestFrame;
            buffer = buffer.slice(end + 1);
            this.messages.push(message);
            if (message.method === 'initialize')
              queueMicrotask(() => this.send({ id: message.id as number,
                result: { serverInfo: { name: 'fixture' } } }));
          }
        });
      }
      send(frame: TestFrame) { this.stdout.write(`${JSON.stringify(frame)}\n`); }
      kill() { this.emit('close', 1, null); return true; }
      asChild(): ChildProcessWithoutNullStreams {
        return this as unknown as ChildProcessWithoutNullStreams;
      }
    }
    const child = new Child();
    const rpc = new AppServerConnection(() => child.asChild(), vscodeInitialize, 1000);
    const session = await rpc.initializedSession();
    const inbox = new AppServerRequestInbox({ threadId: taskId,
      generation: session.generation,
      isGenerationCurrent: generation => rpc.isSessionCurrent(generation),
      allowRequest: request => request.method === 'item/tool/requestUserInput',
      allowAnswer: () => true, allowError: () => true });
    rpc.onServerRequest((request, context) => inbox.handle(request, context));
    try {
      child.send({ id: 69, method: 'item/tool/requestUserInput',
        params: { threadId: taskId, questions: [] } });
      await new Promise(resolve => setImmediate(resolve));
      child.send({ method: 'serverRequest/resolved',
        params: { threadId: taskId, requestId: 69 } });
      child.send({ id: '70', method: 'item/tool/requestUserInput',
        params: { threadId: taskId, questions: [] } });
      await new Promise(resolve => setImmediate(resolve));
      const sessions = new PersistentFrontendSessions({
        taskId, initializeRequest: vscodeInitialize,
        backendFactory: () => rpc, requestInbox: inbox });
      const first = attach(sessions); await initialize(first.frontend);
      assert.deepEqual(first.frames.map(frame => frame.id), ['1', '70']);
      first.frontend.detach();
      const second = attach(sessions); await initialize(second.frontend);
      assert.deepEqual(second.frames.map(frame => frame.id), ['1', '70']);
      assert.equal(await first.frontend.receive({ id: '70', result: {} }), 'detached-or-invalid');
      const nativeError = { code: -32602, message: 'fixture denial', data: { reason: 'test' } };
      assert.equal(await second.frontend.receive({ id: '70', error: nativeError }),
        'server-request-answered');
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(child.messages.find(frame => frame.id === '70' && frame.error)?.error,
        nativeError);
      assert.equal(child.messages.some(frame => frame.id === 69 && frame.result), false);
      assert.equal(child.messages.filter(frame => frame.method === 'initialize').length, 1);
    } finally { await rpc.close(); }
  });

test('inbox observer and independent responder coexist with frontend attachment and typed replay', async () => {
  let current = true;
  const inbox = new AppServerRequestInbox({ threadId: taskId, generation: 7,
    isGenerationCurrent: () => current, allowRequest: () => true,
    allowAnswer: () => true, allowError: () => true });
  const controller = new AbortController();
  const written = deferred<void>();
  const request = (id: string | number) => ({ id, method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } });
  const numeric = inbox.handle(request(7), { signal: controller.signal, responseWritten: written.promise });
  const literal = inbox.handle(request('7'), { signal: controller.signal, responseWritten: written.promise });
  const frontendFrames: JsonObject[] = [];
  const frontend = inbox.attach(frame => frontendFrames.push(frame));
  const observerFrames: JsonObject[] = [], faults: string[] = [];
  const detach = inbox.observePending(frame => { observerFrames.push(frame); frame.params.questions = ['tampered']; },
    reason => faults.push(reason));
  const live = inbox.handle(request(8), { signal: controller.signal, responseWritten: written.promise });
  assert.deepEqual(frontendFrames.map(frame => frame.id), [7, '7', 8]);
  assert.deepEqual(observerFrames.map(frame => frame.id), [7, '7', 8]);
  assert.deepEqual(frontendFrames[0]!.params, request(7).params);
  let authorized = true;
  const responder = inbox.createResponder(() => authorized);
  assert.equal(responder.answer(7, { answers: { n: 'native' } }), true);
  assert.equal(frontend.answer(7, { answers: {} }), false);
  assert.deepEqual(await numeric, { answers: { n: 'native' } });
  assert.equal(frontend.answer('7', { answers: {} }), true);
  assert.deepEqual(await literal, { answers: {} });
  assert.equal(responder.answer('7', { answers: {} }), false);
  assert.equal(responder.answer(8, { answers: { live: true } }), true);
  assert.deepEqual(await live, { answers: { live: true } });
  responder.detach(); detach(); frontend.detach(); current = false;
  assert.deepEqual(faults, []);
});

test('inbox unresolved count includes answered requests until responseWritten or abort retires them', async () => {
  const inbox = new AppServerRequestInbox({ threadId: taskId, generation: 7,
    isGenerationCurrent: () => true, allowRequest: () => true, allowAnswer: () => true });
  const controller = new AbortController(), written = deferred<void>();
  assert.equal(inbox.unresolvedCount(), 0);
  const pending = inbox.handle({ id: 7, method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } },
  { signal: controller.signal, responseWritten: written.promise });
  assert.equal(inbox.unresolvedCount(), 1);
  const responder = inbox.createResponder(() => true);
  assert.equal(responder.answer(7, { answers: {} }), true);
  assert.deepEqual(await pending, { answers: {} });
  assert.equal(inbox.unresolvedCount(), 1);
  written.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(inbox.unresolvedCount(), 0);
  const pendingAbort = inbox.handle({ id: '8', method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } },
  { signal: controller.signal, responseWritten: written.promise });
  assert.equal(inbox.unresolvedCount(), 1);
  controller.abort(); await assert.rejects(pendingAbort);
  assert.equal(inbox.unresolvedCount(), 0);
  responder.detach();
});

test('faulty pending observers retire alone and frontend EOF leaves typed requests replayable', async () => {
  const inbox = new AppServerRequestInbox({ threadId: taskId, generation: 7,
    isGenerationCurrent: () => true, allowRequest: () => true,
    allowAnswer: () => true });
  const controller = new AbortController(), written = deferred<void>();
  const pending = inbox.handle({ id: '7', method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } },
  { signal: controller.signal, responseWritten: written.promise });
  const errors: string[] = [];
  inbox.observePending(() => { throw new Error('observer failed'); }, reason => errors.push(reason));
  inbox.observePending((() => Promise.reject(new Error('async observer failed'))) as () => void,
    reason => errors.push(reason));
  assert.deepEqual(errors, ['observer-faulted', 'observer-faulted']);
  const first = inbox.attach(() => {}); first.detach();
  const replayed: Array<string | number> = [];
  const detach = inbox.observePending(frame => replayed.push(frame.id), () => {});
  assert.deepEqual(replayed, ['7']);
  const second = inbox.attach(frame => replayed.push(String(frame.id)));
  assert.deepEqual(replayed, ['7', '7']);
  assert.equal(first.answer('7', {}), false);
  assert.equal(second.answer(7, {}), false);
  assert.equal(second.answer('7', { answers: {} }), true);
  assert.deepEqual(await pending, { answers: {} });
  detach(); second.detach();
});

test('independent responder loses authority during policy and never bypasses answer policy', async () => {
  let current = true, authorized = true, policyCalls = 0;
  const inbox = new AppServerRequestInbox({ threadId: taskId, generation: 7,
    isGenerationCurrent: () => current, allowRequest: () => true,
    allowAnswer: () => { policyCalls++; authorized = false; return true; },
    allowError: () => false });
  const controller = new AbortController(), written = deferred<void>();
  const pending = inbox.handle({ id: 7, method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } },
  { signal: controller.signal, responseWritten: written.promise });
  const responder = inbox.createResponder(() => authorized);
  assert.equal(responder.answer('7', {}), false);
  assert.equal(responder.reject(7, { code: -32602, message: 'No' }), false);
  assert.equal(policyCalls, 0);
  assert.equal(responder.answer(7, {}), false);
  assert.equal(policyCalls, 1);
  authorized = true; current = false;
  assert.equal(responder.answer(7, {}), false);
  current = true; responder.detach();
  assert.equal(responder.answer(7, {}), false);
  const frontend = inbox.attach(() => {});
  assert.equal(frontend.answer(7, {}), true);
  assert.equal(policyCalls, 2);
  assert.deepEqual(await pending, {});
  frontend.detach();
});

test('responder self-detach in post-policy authority callback cannot settle pending request', async () => {
  const inbox = new AppServerRequestInbox({ threadId: taskId, generation: 7,
    isGenerationCurrent: () => true, allowRequest: () => true, allowAnswer: () => true });
  const controller = new AbortController(), written = deferred<void>();
  const pending = inbox.handle({ id: 9, method: 'item/tool/requestUserInput',
    params: { threadId: taskId, questions: [] } },
  { signal: controller.signal, responseWritten: written.promise });
  let calls = 0;
  let responder!: ReturnType<typeof inbox.createResponder>;
  responder = inbox.createResponder(() => { if (++calls === 2) responder.detach(); return true; });
  assert.equal(responder.answer(9, {}), false);
  assert.equal(calls, 2);
  const frontend = inbox.attach(() => {});
  assert.equal(frontend.answer(9, { answers: {} }), true);
  assert.deepEqual(await pending, { answers: {} });
  frontend.detach();
});

test('bootstrap reads are opt-in, validated, and leave mutations unavailable', async () => {
  const backend = fakeBackend();
  const disabled = attach(createSessions(backend));
  await initialize(disabled.frontend);
  await disabled.frontend.receive({ id: 1, method: 'model/list', params: { includeHidden: true } });
  assert.equal(backend.requests.length, 0);
  const enabled = attach(createSessions(backend, { bootstrapReadMethods: [
    'config/read', 'configRequirements/read', 'model/list', 'permissionProfile/list',
    'account/read', 'account/rateLimits/read', 'thread/turns/list',
    'thread/list', 'thread/loaded/list'], ownCwd: 'C:/own' }));
  await initialize(enabled.frontend);
  for (const [method, params] of [
    ['config/read', { includeLayers: true, cwd: 'C:/own' }],
    ['configRequirements/read', {}],
    ['model/list', { cursor: null, limit: 10, includeHidden: true }],
    ['permissionProfile/list', { cursor: null, limit: 10, cwd: 'C:/own' }],
    ['account/read', { refreshToken: false }],
    ['account/rateLimits/read', { supportsLunaReserve: false }],
    ['thread/turns/list', { threadId: taskId, cursor: null, itemsView: 'full' }],
  ]) await enabled.frontend.receive({ id: method, method, params });
  assert.equal(backend.requests.length, 7);
  for (const [method, params] of [
    ['config/read', { cwd: 'C:/foreign' }],
    ['configRequirements/read', { surprise: true }],
    ['model/list', { limit: -1 }],
    ['permissionProfile/list', { cwd: 'C:/foreign' }],
    ['account/read', { refreshToken: true }],
    ['account/rateLimits/read', { supportsLunaReserve: true }],
    ['thread/turns/list', { threadId: 'foreign' }],
    ['config/value/write', {}], ['thread/start', {}],
  ]) await enabled.frontend.receive({ id: `bad-${method}`, method, params });
  assert.equal(backend.requests.length, 7);
});

test('configRequirements/read accepts native absent and null params without changing them', async () => {
  const backend = fakeBackend();
  const { frontend } = attach(createSessions(backend, {
    bootstrapReadMethods: ['configRequirements/read'] }));
  await initialize(frontend);
  for (const params of [undefined, null, {}])
    await frontend.receive({ id: `requirements-${String(params)}`, method: 'configRequirements/read', params });
  assert.deepEqual(backend.requests.map(request => request.params), [undefined, null, {}]);
  assert.equal(backend.requests.length, 3);
});

test('bootstrap cwd reads accept the same absolute Windows directory across casing and separators', async () => {
  const backend = fakeBackend();
  const { frontend } = attach(createSessions(backend, {
    bootstrapReadMethods: ['config/read', 'permissionProfile/list'], ownCwd: 'D:\\GitStorageG\\VKodex' }));
  await initialize(frontend);
  await frontend.receive({ id: 'config', method: 'config/read',
    params: { cwd: 'd:/gitstorageg/vkodex/' } });
  await frontend.receive({ id: 'permissions', method: 'permissionProfile/list',
    params: { cwd: 'd:/gitstorageg/vkodex' } });
  assert.deepEqual(backend.requests.map(request => request.method),
    ['config/read', 'permissionProfile/list']);
  await frontend.receive({ id: 'relative', method: 'config/read', params: { cwd: 'VKodex' } });
  await frontend.receive({ id: 'drive-relative', method: 'config/read', params: { cwd: 'D:VKodex' } });
  await frontend.receive({ id: 'root-relative', method: 'config/read', params: { cwd: '\\GitStorageG\\VKodex' } });
  await frontend.receive({ id: 'other', method: 'config/read', params: { cwd: 'D:/GitStorageG/Other' } });
  assert.equal(backend.requests.length, 2);
});

test('pinned native resume parameters pass unchanged only under same-generation authority', async () => {
  const backend = fakeBackend();
  const original = { threadId: taskId, history: null, path: 'C:/own/rollout.jsonl',
    model: null, modelProvider: 'openai', cwd: 'C:/own', personality: null,
    excludeTurns: true, initialTurnsPage: { limit: 20 }, permissions: 'default' };
  let pinned = structuredClone(original);
  const sessions = createSessions(backend, { resumeAuthority: ({ taskId: id, generation }) => {
    assert.equal(id, taskId); assert.equal(generation, 7);
    return { taskId, generation, params: pinned };
  } });
  const { frames, frontend } = attach(sessions); await initialize(frontend);
  await frontend.receive({ id: 20, method: 'thread/resume', params: original });
  assert.deepEqual(backend.requests[0]!.params, original);
  assert.equal(backend.requests[0]!.options.expectedGeneration, 7);
  assert.equal(backend.requests[0]!.options.mutating, true);
  assert.deepEqual(frames[1]!.result!.thread, { id: taskId });
  for (const [id, alteration] of ([
    [21, { path: 'C:/foreign/rollout.jsonl' }], [22, { cwd: 'C:/foreign' }],
    [23, { permissions: 'dangerous' }], [24, { threadId: 'foreign' }],
    [25, { history: [{ type: 'message' }] }], [26, { config: { override: true } }],
    [27, { surprise: true }],
  ] as Array<[number, JsonObject]>)) await frontend.receive({ id, method: 'thread/resume',
    params: { ...original, ...alteration } });
  assert.equal(backend.requests.length, 1);
  pinned = { ...original, path: 'C:/foreign/rollout.jsonl' };
  await frontend.receive({ id: 28, method: 'thread/resume', params: original });
  assert.equal(backend.requests.length, 1);
  backend.sessionGeneration++;
  await frontend.receive({ id: 29, method: 'thread/resume', params: pinned });
  assert.equal(backend.requests.length, 1);
});

test('own-task thread/items/list accepts native page controls unchanged', async () => {
  const backend = fakeBackend();
  const { frontend } = attach(createSessions(backend)); await initialize(frontend);
  const params = { threadId: taskId, turnId: 'turn-1', cursor: 'opaque',
    limit: 20, sortDirection: 'desc' };
  await frontend.receive({ id: 30, method: 'thread/items/list', params });
  assert.deepEqual(backend.requests[0]!.params, params);
  for (const [id, bad] of [[31, { ...params, threadId: 'foreign' }],
    [32, { ...params, turnId: 7 }], [33, { ...params, limit: -1 }],
    [34, { ...params, sortDirection: 'sideways' }],
    [35, { ...params, extra: true }]])
    await frontend.receive({ id, method: 'thread/items/list', params: bad });
  assert.equal(backend.requests.length, 1);
});

test('resume authority failure or mutation cannot authorize an inbound override', async () => {
  const backend = fakeBackend();
  const inbound = { threadId: taskId, history: null, path: 'C:/own/rollout.jsonl',
    cwd: 'C:/own', permissions: 'default' };
  let authority: (context: { taskId: string; generation: number }) => unknown =
    () => { throw new Error('authority unavailable'); };
  const { frontend } = attach(createSessions(backend, {
    resumeAuthority: context => authority(context) }));
  await initialize(frontend);
  await frontend.receive({ id: 40, method: 'thread/resume', params: inbound });
  assert.equal(backend.requests.length, 0);
  authority = ({ taskId: id, generation }) => ({ taskId: id, generation: generation + 1,
    params: inbound });
  await frontend.receive({ id: 41, method: 'thread/resume', params: inbound });
  assert.equal(backend.requests.length, 0);
  authority = ({ taskId: id, generation }) => ({ taskId: id, generation,
    params: { ...inbound } });
  await frontend.receive({ id: 42, method: 'thread/resume', params: inbound });
  assert.equal(backend.requests.length, 1);
  inbound.permissions = 'unsafe-after-dispatch';
  assert.equal(backend.requests[0]!.params.permissions, 'default');
});

test('resume authority is rechecked after queued initialize and generation loss', async () => {
  const backend = fakeBackend();
  const gate = deferred<AppServerInitializedSession>();
  backend.initializedSession = () => gate.promise;
  const params = { threadId: taskId, path: 'C:/own/rollout.jsonl' };
  let permitted = true;
  const { frontend } = attach(createSessions(backend, {
    resumeAuthority: ({ taskId: id, generation }) => permitted ?
      { taskId: id, generation, params } : null }));
  const boot = initialize(frontend);
  const queued = frontend.receive({ id: 43, method: 'thread/resume', params });
  permitted = false;
  gate.resolve({ generation: 7, initializeResult: { userAgent: 'real-worker-agent' } });
  await Promise.all([boot, queued]);
  assert.equal(backend.requests.length, 0);
  permitted = true;
  backend.sessionGeneration = 8;
  await frontend.receive({ id: 44, method: 'thread/resume', params });
  assert.equal(backend.requests.length, 0);
});

test('resume authority cannot dispatch after detaching its frontend', async () => {
  const backend = fakeBackend();
  const params = { threadId: taskId, path: 'C:/own/rollout.jsonl' };
  let frontend!: Frontend;
  const sessions = createSessions(backend, {
    resumeAuthority: ({ taskId: id, generation }) => {
      frontend.detach();
      return { taskId: id, generation, params };
    } });
  ({ frontend } = attach(sessions));
  await initialize(frontend);
  assert.equal(await frontend.receive({ id: 45, method: 'thread/resume', params }), 'detached');
  assert.equal(backend.requests.length, 0);
});

test('catalog bootstrap filters own task while preserving opaque native cursors', async () => {
  const backend = fakeBackend();
  backend.request = async (method, params, options) => {
    backend.requests.push({ method, params, options });
    options.onResponseEnvelope({ result: method === 'thread/list' ? {
      data: [{ id: 'foreign' }, { id: taskId, title: 'own' }],
      nextCursor: 'opaque-next', backwardsCursor: 'opaque-back' } : {
      data: ['foreign', taskId], nextCursor: 'opaque-loaded' } });
  };
  const { frames, frontend } = attach(createSessions(backend, {
    bootstrapReadMethods: ['thread/list', 'thread/loaded/list'] }));
  await initialize(frontend);
  await frontend.receive({ id: 1, method: 'thread/list', params: { limit: 2 } });
  await frontend.receive({ id: 2, method: 'thread/loaded/list', params: { cursor: null } });
  assert.deepEqual(frames[1]!, { id: 1, result: {
    data: [{ id: taskId, title: 'own' }],
    nextCursor: 'opaque-next', backwardsCursor: 'opaque-back' } });
  assert.deepEqual(frames[2]!, { id: 2, result: {
    data: [taskId], nextCursor: 'opaque-loaded' } });
});

test('empty filtered page keeps native cursor and native errors stay local', async () => {
  const backend = fakeBackend();
  backend.request = async (method, params, options) => {
    backend.requests.push({ method, params, options });
    options.onResponseEnvelope(method === 'thread/list' ? { result: {
      data: [{ id: 'foreign' }], nextCursor: 'page-two', backwardsCursor: null,
      privateExtra: 'must-not-forward' } } : { error: {
      code: -32602, message: 'synthetic-local-error', data: { local: true } } });
  };
  const { frames, frontend } = attach(createSessions(backend, {
    bootstrapReadMethods: ['thread/list', 'model/list'] }));
  await initialize(frontend);
  await frontend.receive({ id: 1, method: 'thread/list', params: {} });
  await frontend.receive({ id: 2, method: 'model/list', params: {} });
  assert.deepEqual(frames[1]!, { id: 1, result: {
    data: [], nextCursor: 'page-two', backwardsCursor: null } });
  assert.deepEqual(frames[2]!, { id: 2, error: {
    code: -32602, message: 'synthetic-local-error', data: { local: true } } });
  assert.equal(backend.requests[0]!.options.expectedGeneration, 7);
  assert.equal(backend.closeCalls, 0);
});

test('legacy token status requires trusted local construction and never refreshes', async () => {
  const backend = fakeBackend();
  backend.request = async (method, params, options) => {
    backend.requests.push({ method, params, options });
    options.onResponseEnvelope({ result: { authMethod: 'chatgpt',
      authToken: 'synthetic-test-token', requiresOpenaiAuth: true } });
  };
  const untrusted = attach(createSessions(backend, {
    bootstrapReadMethods: ['getAuthStatus'] }));
  await initialize(untrusted.frontend);
  await untrusted.frontend.receive({ id: 1, method: 'getAuthStatus',
    params: { includeToken: true, refreshToken: false } });
  assert.equal(backend.requests.length, 0);
  const trusted = attach(createSessions(backend, {
    bootstrapReadMethods: ['getAuthStatus'], trustedLocalFrontend: true }));
  await initialize(trusted.frontend);
  await trusted.frontend.receive({ id: 2, method: 'getAuthStatus',
    params: { includeToken: true, refreshToken: false } });
  assert.equal(backend.requests.length, 1);
  assert.equal(trusted.frames[1]!.result!.authToken, 'synthetic-test-token');
  await trusted.frontend.receive({ id: 3, method: 'getAuthStatus',
    params: { includeToken: true, refreshToken: true } });
  assert.equal(backend.requests.length, 1);
});
function attach(sessions: PersistentFrontendSessions): { frames: TestFrame[]; frontend: Frontend } {
  const frames: TestFrame[] = [];
  return { frames, frontend: sessions.attach(frame => frames.push(frame as TestFrame)) };
}
async function initialize(frontend: Frontend, id: string | number = '1') {
  return frontend.receive({ id, method: 'initialize', params: structuredClone(vscodeInitialize) });
}

test('installed package version is not the normalized initialize wire version', async () => {
  const backend = fakeBackend();
  const { frames, frontend } = attach(createSessions(backend));
  const rawPackageVersion = structuredClone(vscodeInitialize);
  rawPackageVersion.clientInfo.version = '26.5917.62051';
  assert.equal(await frontend.receive({ id: '1', method: 'initialize',
    params: rawPackageVersion }), 'initialize-incompatible');
  assert.equal(backend.initializeCalls, 0);
  assert.equal(frames[0]!.error!.code, -32602);
  assert.equal(vscodeInitialize.clientInfo.version, '26.917.62051');
});

test('pipelined bootstrap reads wait for initialize then dispatch independently', async () => {
  const backend = fakeBackend();
  const gate = deferred<AppServerInitializedSession>();
  backend.initializedSession = async () => {
    backend.initializeCalls++;
    return gate.promise;
  };
  backend.request = async (method, params, options) => {
    backend.requests.push({ method, params, options });
    options.onResponseEnvelope({ result: method === 'thread/list' ?
      { data: [{ id: taskId }], nextCursor: null, backwardsCursor: null } :
      { config: {} } });
  };
  const { frames, frontend } = attach(createSessions(backend, {
    bootstrapReadMethods: ['config/read', 'thread/list'], ownCwd: 'C:/own' }));
  const initializing = initialize(frontend);
  const config = frontend.receive({ id: 0, method: 'config/read', params: { cwd: 'C:/own' } });
  const listA = frontend.receive({ id: '0', method: 'thread/list', params: { limit: 5 } });
  const listB = frontend.receive({ id: 2, method: 'thread/list', params: { cursor: 'next' } });
  assert.equal(await frontend.receive({ id: 0, method: 'config/read',
    params: { cwd: 'C:/own' } }), 'duplicate-pending-id');
  assert.equal(backend.requests.length, 0);
  assert.equal(frames.length, 0);
  gate.resolve({ generation: 7, initializeResult: { userAgent: 'real-worker-agent',
    codexHome: 'isolated-home', platformFamily: 'windows', platformOs: 'windows' } });
  await Promise.all([initializing, config, listA, listB]);
  assert.equal(backend.initializeCalls, 1);
  assert.deepEqual(backend.requests.map(request => request.method),
    ['config/read', 'thread/list', 'thread/list']);
  assert.deepEqual(frames.map(frame => frame.id), ['1', 0, '0', 2]);
  assert.ok(frames.slice(1).every(frame => frame.result && !frame.error));
});

test('detaching during initialize drops pipelined requests without backend dispatch', async () => {
  const backend = fakeBackend();
  const gate = deferred<AppServerInitializedSession>();
  backend.initializedSession = () => gate.promise;
  const { frames, frontend } = attach(createSessions(backend, {
    bootstrapReadMethods: ['config/read'] }));
  const initializing = initialize(frontend);
  const pipelined = frontend.receive({ id: 4, method: 'config/read', params: {} });
  frontend.detach();
  gate.resolve({ generation: 7, initializeResult: { userAgent: 'real-worker-agent' } });
  await Promise.all([initializing, pipelined]);
  assert.equal(backend.requests.length, 0);
  assert.equal(frames.length, 0);
});

test('two frontend generations share one actual initialized backend and never close it', async () => {
  const backend = fakeBackend();
  const sessions = createSessions(backend);
  const a = attach(sessions);
  await initialize(a.frontend);
  assert.deepEqual(a.frames, [{ id: '1', result: {
    userAgent: 'real-worker-agent', codexHome: 'isolated-home',
    platformFamily: 'windows', platformOs: 'windows' } }]);
  await a.frontend.receive({ id: 0, method: 'thread/read',
    params: { threadId: taskId, includeTurns: true } });
  a.frontend.detach();
  const b = attach(sessions);
  await initialize(b.frontend);
  await b.frontend.receive({ id: 0, method: 'thread/resume', params: { threadId: taskId } });
  assert.equal(backend.closeCalls, 0);
  assert.equal(backend.requests.length, 2);
  assert.equal(backend.requests[1]!.method, 'thread/resume');
  assert.equal(backend.requests[1]!.options.mutating, true);
  assert.equal(backend.requests[0]!.options.expectedGeneration, 7);
  assert.equal(backend.requests[1]!.options.expectedGeneration, 7);
  assert.deepEqual(b.frames[1]!, { id: 0,
    result: { method: 'thread/resume', threadId: taskId, thread: { id: taskId } } });
});

test('typed pending IDs are independent; duplicate pending ID is suppressed', async () => {
  const backend = fakeBackend();
  const pending = deferred();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options });
    if (typeof backend.requests.length === 'number' && backend.requests.length === 1) return pending.promise;
    const result = { method, threadId: params.threadId };
    options.onResponseEnvelope({ result });
    return Promise.resolve(result);
  };
  const sessions = createSessions(backend);
  const { frames, frontend } = attach(sessions);
  await initialize(frontend);
  const first = frontend.receive({ id: 0, method: 'thread/read', params: { threadId: taskId } });
  assert.equal(await frontend.receive({ id: 0, method: 'thread/read',
    params: { threadId: taskId } }), 'duplicate-pending-id');
  await frontend.receive({ id: '0', method: 'thread/goal/get', params: { threadId: taskId } });
  assert.equal(backend.requests.length, 2);
  const firstResult = { thread: { id: taskId }, item: 'first' };
  backend.requests[0]!.options.onResponseEnvelope({ result: firstResult });
  pending.resolve(firstResult); await first;
  assert.deepEqual(frames.slice(1), [
    { id: '0', result: { method: 'thread/goal/get', threadId: taskId } },
    { id: 0, result: { thread: { id: taskId }, item: 'first' } },
  ]);
});

test('ready attachment caps in-flight requests and recovers capacity after replies', async () => {
  const backend = fakeBackend();
  const waits: Array<ReturnType<typeof deferred<JsonObject>>> = [];
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options });
    const wait = deferred<JsonObject>(); waits.push(wait);
    return wait.promise;
  };
  const { frames, frontend } = attach(createSessions(backend));
  await initialize(frontend);
  const requests = Array.from({ length: 128 }, (_, index) =>
    frontend.receive({ id: index + 1, method: 'thread/goal/get',
      params: { threadId: taskId } }));
  assert.equal(backend.requests.length, 128);
  assert.equal(await frontend.receive({ id: 1, method: 'thread/goal/get',
    params: { threadId: taskId } }), 'duplicate-pending-id');
  const overloaded = frontend.receive({ id: 129, method: 'thread/goal/get',
    params: { threadId: taskId } });
  assert.equal(await Promise.race([overloaded,
    new Promise<string>(resolve => setTimeout(() => resolve('timed-out'), 50))]),
  'request-pipeline-full');
  assert.equal(backend.requests.length, 128);
  assert.equal(frames.at(-1)?.error?.code, -32001);
  assert.equal(backend.closeCalls, 0);
  for (let index = 0; index < waits.length; index++) {
    const result = { goal: null };
    backend.requests[index]!.options.onResponseEnvelope({ result });
    waits[index]!.resolve(result);
  }
  await Promise.all(requests);
  const later = frontend.receive({ id: 130, method: 'thread/goal/get',
    params: { threadId: taskId } });
  assert.equal(backend.requests.length, 129);
  backend.requests[128]!.options.onResponseEnvelope({ result: { goal: null } });
  waits[128]!.resolve({ goal: null });
  assert.equal(await later, 'forwarded');
});

test('detached late result cannot reach new frontend with reused numeric or string ID', async () => {
  const backend = fakeBackend();
  const pending = deferred();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options });
    if (backend.requests.length === 1) return pending.promise;
    const result = { fresh: true,
      ...(method === 'thread/read' ? { thread: { id: params.threadId } } : {}) };
    options.onResponseEnvelope({ result });
    return Promise.resolve(result);
  };
  const sessions = createSessions(backend);
  const a = attach(sessions); await initialize(a.frontend);
  const old = a.frontend.receive({ id: 0, method: 'thread/read', params: { threadId: taskId } });
  a.frontend.detach();
  const b = attach(sessions); await initialize(b.frontend);
  await b.frontend.receive({ id: 0, method: 'thread/read', params: { threadId: taskId } });
  await b.frontend.receive({ id: '0', method: 'thread/goal/get', params: { threadId: taskId } });
  backend.requests[0]!.options.onResponseEnvelope({ result: { stale: true } });
  pending.resolve({ stale: true }); await old;
  assert.equal(a.frames.length, 1);
  assert.deepEqual(b.frames.slice(1), [
    { id: 0, result: { fresh: true, thread: { id: taskId } } },
    { id: '0', result: { fresh: true } },
  ]);
});

test('capability mismatch is rejected before backend initialization', async () => {
  const backend = fakeBackend();
  const sessions = createSessions(backend);
  const { frames, frontend } = attach(sessions);
  const altered = structuredClone(vscodeInitialize);
  altered.capabilities.requestAttestation = true;
  await frontend.receive({ id: '1', method: 'initialize', params: altered });
  assert.equal(backend.initializeCalls, 0);
  assert.equal(frames[0]!.error!.code, -32602);
  assert.equal(Object.hasOwn(frames[0]!, 'result'), false);
});

test('foreign tasks, settings, queue writes and arbitrary requests never reach backend', async () => {
  const backend = fakeBackend();
  const sessions = createSessions(backend);
  const { frames, frontend } = attach(sessions); await initialize(frontend);
  for (const [id, method, params] of [
    [2, 'thread/read', { threadId: 'foreign' }],
    [3, 'thread/resume', { threadId: taskId, path: 'some-path' }],
    [4, 'turn/start', { threadId: taskId }],
    [5, 'thread/queue/add', { threadId: taskId }],
    [6, 'thread/settings/update', { threadId: taskId }],
    [7, 'config/read', {}],
  ]) await frontend.receive({ id, method, params });
  assert.equal(backend.requests.length, 0);
  assert.equal(frames.slice(1).length, 6);
  assert.ok(frames.slice(1).every(frame => frame.error && !frame.result));
});

test('notifications are task-scoped and detached generation cannot receive late events', async () => {
  const backend = fakeBackend();
  const sessions = createSessions(backend);
  const a = attach(sessions); await initialize(a.frontend);
  backend.emit({ method: 'thread/status/changed', params: { threadId: taskId, status: 'idle' } });
  backend.emit({ method: 'item/started', params: { threadId: taskId, item: { id: 'own-item' } } });
  backend.emit({ method: 'thread/status/changed', params: { threadId: 'foreign' } });
  backend.emit({ method: 'item/delta', params: { threadId: 'foreign', delta: 'no' } });
  backend.emit({ method: 'config/updated', params: {} });
  a.frontend.detach();
  backend.emit({ method: 'thread/status/changed', params: { threadId: taskId, status: 'late' } });
  const b = attach(sessions); await initialize(b.frontend);
  backend.emit({ method: 'thread/status/changed', params: { threadId: taskId, status: 'new' } });
  assert.equal(a.frames.length, 3);
  assert.deepEqual(a.frames[2]!, { method: 'item/started',
    params: { threadId: taskId, item: { id: 'own-item' } } });
  assert.deepEqual(b.frames[1]!, { method: 'thread/status/changed',
    params: { threadId: taskId, status: 'new' } });
  assert.equal(backend.closeCalls, 0);
});

test('backend generation change blocks forwarding and does not silently reinitialize', async () => {
  const backend = fakeBackend();
  const sessions = createSessions(backend);
  const a = attach(sessions); await initialize(a.frontend);
  a.frontend.detach();
  backend.sessionGeneration = 8;
  const b = attach(sessions); await initialize(b.frontend);
  assert.equal(b.frames[0]!.error!.code, -32001);
  assert.equal(backend.requests.length, 0);
});

test('conflicting duplicate ID detaches; its late backend result is not delivered', async () => {
  const backend = fakeBackend();
  const pending = deferred();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options }); return pending.promise;
  };
  const sessions = createSessions(backend);
  const a = attach(sessions); await initialize(a.frontend);
  const old = a.frontend.receive({ id: 0, method: 'thread/read',
    params: { threadId: taskId } });
  assert.equal(await a.frontend.receive({ id: 0, method: 'thread/goal/get',
    params: { threadId: taskId } }), 'conflicting-pending-id');
  backend.requests[0]!.options.onResponseEnvelope({ result: { thread: { id: taskId } } });
  pending.resolve({ thread: { id: taskId } }); await old;
  assert.equal(a.frames.length, 1);
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.closeCalls, 0);
});

test('generation loss during pending read yields no false success', async () => {
  const backend = fakeBackend();
  const pending = deferred();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options }); return pending.promise;
  };
  const sessions = createSessions(backend);
  const { frames, frontend } = attach(sessions); await initialize(frontend);
  const inFlight = frontend.receive({ id: 9, method: 'thread/read',
    params: { threadId: taskId } });
  backend.sessionGeneration++;
  backend.requests[0]!.options.onResponseEnvelope({ result: { thread: { id: taskId } } });
  pending.resolve({ thread: { id: taskId } }); await inFlight;
  assert.equal(frames[1]!.error!.code, -32001);
  assert.equal(frames.some(frame => frame.id === 9 && frame.result), false);
});

test('frontend server-request replies and global reads are not relayed', async () => {
  const backend = fakeBackend();
  const sessions = createSessions(backend);
  const { frames, frontend } = attach(sessions); await initialize(frontend);
  assert.equal(await frontend.receive({ id: 7, result: { decision: 'accept' } }),
    'invalid-envelope');
  await frontend.receive({ id: 8, method: 'thread/loaded/list', params: {} });
  await frontend.receive({ id: 9, method: 'thread/queue/list',
    params: { threadId: taskId, cursor: null, limit: 100 } });
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.requests[0]!.method, 'thread/queue/list');
  assert.equal(frames[1]!.error!.code, -32601);
});

test('native error envelope keeps the frontend typed ID and exact error without a Promise duplicate', async () => {
  const backend = fakeBackend();
  const nativeError = { code: -32602, message: 'Synthetic native error',
    data: { reason: 'fixture-only' } };
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options });
    options.onResponseEnvelope({ error: nativeError });
    return Promise.reject(new Error('sanitized Promise rejection'));
  };
  const { frames, frontend } = attach(createSessions(backend));
  await initialize(frontend);
  assert.equal(await frontend.receive({ id: 'typed-client-id', method: 'thread/read',
    params: { threadId: taskId } }), 'forwarded');
  assert.deepEqual(frames.slice(1), [{ id: 'typed-client-id', error: nativeError }]);
  assert.equal(Object.hasOwn(frames[1]!, 'result'), false);
});

test('Promise-only result is unsupported and cannot become frontend success', async () => {
  const backend = fakeBackend();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options });
    return Promise.resolve({ thread: { id: taskId } });
  };
  const { frames, frontend } = attach(createSessions(backend));
  await initialize(frontend);
  assert.equal(await frontend.receive({ id: 11, method: 'thread/read',
    params: { threadId: taskId } }), 'backend-response-envelope-unavailable');
  assert.equal(frames[1]!.error!.code, -32001);
  assert.equal(Object.hasOwn(frames[1]!, 'result'), false);
});

test('response callback is synchronous and duplicate callback or Promise result cannot duplicate a reply', async () => {
  const backend = fakeBackend();
  const pending = deferred();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options }); return pending.promise;
  };
  const { frames, frontend } = attach(createSessions(backend));
  await initialize(frontend);
  const request = frontend.receive({ id: 12, method: 'thread/read',
    params: { threadId: taskId } });
  const result = { thread: { id: taskId } };
  const callback = backend.requests[0]!.options.onResponseEnvelope;
  callback({ result });
  assert.deepEqual(frames[1]!, { id: 12, result });
  callback({ error: { code: 1, message: 'late duplicate' } });
  pending.resolve(result);
  assert.equal(await request, 'forwarded');
  assert.equal(frames.length, 2);
});

test('callback task mismatch is blocked before forwarding native result', async () => {
  const backend = fakeBackend();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options });
    const result = { thread: { id: 'foreign' } };
    options.onResponseEnvelope({ result });
    return Promise.resolve(result);
  };
  const { frames, frontend } = attach(createSessions(backend));
  await initialize(frontend);
  await frontend.receive({ id: 13, method: 'thread/read', params: { threadId: taskId } });
  assert.equal(frames[1]!.error!.code, -32001);
  assert.equal(Object.hasOwn(frames[1]!, 'result'), false);
});

test('old callback cannot answer a new request that reuses the same typed ID', async () => {
  const backend = fakeBackend();
  const second = deferred();
  backend.request = (method, params, options) => {
    backend.requests.push({ method, params, options });
    if (backend.requests.length === 1) {
      const result = { thread: { id: taskId } };
      options.onResponseEnvelope({ result });
      return Promise.resolve(result);
    }
    return second.promise;
  };
  const { frames, frontend } = attach(createSessions(backend));
  await initialize(frontend);
  await frontend.receive({ id: 14, method: 'thread/read', params: { threadId: taskId } });
  const later = frontend.receive({ id: 14, method: 'thread/goal/get',
    params: { threadId: taskId } });
  backend.requests[0]!.options.onResponseEnvelope({ error: { code: -1, message: 'stale' } });
  assert.equal(frames.length, 2);
  const result = { goal: null };
  backend.requests[1]!.options.onResponseEnvelope({ result });
  second.resolve(result);
  await later;
  assert.deepEqual(frames[2]!, { id: 14, result });
  assert.equal(frames.length, 3);
});
