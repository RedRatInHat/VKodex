import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { bootstrapManagedWorker } from '../src/desktop/managed-worker-bootstrap.js';
import { compileNativeReadOnlyComposerStart } from '../src/codex/native-composer-start.js';

type Row = Record<string, unknown>;
const taskId = 'own-zero-turn';
const cwd = 'C:/own-workspace';
const initializeRequest: Row = { clientInfo: { name: 'fixture', version: '1' },
  capabilities: { experimentalApi: true } };
const resumeParams: Row = { threadId: taskId, cwd, model: 'gpt-5.6-sol',
  permissions: ':read-only', approvalPolicy: 'never', runtimeWorkspaceRoots: [cwd],
  config: { model_reasoning_effort: 'low' } };

class BackendFixture {
  readonly server: Server;
  readonly sockets = new Set<Socket>();
  readonly methods: string[] = [];
  readonly token = 'a'.repeat(43);
  readonly adapterKey = {};
  readonly settings = { taskId, state: 'running' as const, backendGeneration: 7,
    frontend: null };
  turns: Row[] = [];
  goal: unknown = null;
  queue: Row[] = [];
  nextCursor: string | null = null;
  beforeStatus: string = 'notLoaded';
  readCwd: string = cwd;
  exposedModel: string | null = null;
  readTurnStatusOverride: string | null = null;
  resumeCount = 0;
  replyError: string | null = null;
  eofMethod: string | null = null;
  malformedMethod: string | null = null;
  wrongIdMethod: string | null = null;
  generationFlipMethod: string | null = null;
  stopCalls = 0;
  constructor() {
    this.server = createServer(socket => {
      this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket));
      let buffer = '', authenticated = false;
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const frame = JSON.parse(buffer.slice(0, end)) as Row;
          buffer = buffer.slice(end + 1);
          if (!authenticated) {
            authenticated = frame.token === this.token;
            socket.write(JSON.stringify({ ok: authenticated }) + '\n');
            if (!authenticated) socket.destroy();
            continue;
          }
          const method = frame.method as string;
          this.methods.push(method);
          if (this.eofMethod === method) { socket.destroy(); continue; }
          if (this.malformedMethod === method) { socket.write('{bad-json}\n'); continue; }
          if (this.replyError === method) {
            socket.write(JSON.stringify({ id: frame.id, error: { code: -32001, message: 'sensitive-native-error' } }) + '\n');
            continue;
          }
          const result = this.respond(method, frame.params as Row);
          if (this.generationFlipMethod === method) this.settings.backendGeneration++;
          socket.write(JSON.stringify({ id: this.wrongIdMethod === method ? 999 : frame.id, result }) + '\n');
        }
      });
    });
  }
  get host() { return { metadata: this.settings,
    frontendCapability: (key: object) => {
      assert.strictEqual(key, this.adapterKey);
      const address = this.server.address();
      assert.ok(address && typeof address !== 'string');
      return { host: '127.0.0.1', port: address.port, token: this.token };
    } }; }
  async listen(): Promise<void> { this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening'); }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  async waitDetached(): Promise<void> {
    const until = Date.now() + 1000;
    while (this.sockets.size && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 10));
  }
  private respond(method: string, params: Row): Row {
    if (method === 'initialize') return { serverInfo: { name: 'fixture' } };
    if (method === 'thread/resume') {
      assert.deepEqual(params, resumeParams); this.resumeCount++;
      return { thread: this.thread('idle'), cwd, model: 'gpt-5.6-sol', reasoningEffort: 'low',
        approvalPolicy: 'never', activePermissionProfile: { id: ':read-only' },
        sandbox: { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [cwd],
        serviceTier: null };
    }
    if (method === 'thread/read') return { thread: this.thread(this.resumeCount ? 'idle' : this.beforeStatus) };
    if (method === 'thread/turns/list') return { data: this.turns.map(turn => ({ ...turn, itemsView: 'full' })),
      nextCursor: this.nextCursor };
    if (method === 'thread/goal/get') return { goal: this.goal };
    if (method === 'thread/queue/list') return { data: this.queue, nextCursor: null };
    if (method === 'config/read') return { config: { model_reasoning_summary: null, personality: 'pragmatic' } };
    throw new Error('unallowed test RPC');
  }
  private thread(status: string): Row {
    return { id: taskId, sessionId: taskId, createdAt: 100, updatedAt: 101,
      cwd: this.readCwd, ...(this.exposedModel === null ? {} : { model: this.exposedModel }),
      status: { type: status }, turns: this.turns.map(turn => this.readTurnStatusOverride === null ? turn :
        { ...turn, status: this.readTurnStatusOverride }),
      environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] };
  }
}
const options = (fixture: BackendFixture) => ({ host: fixture.host, adapterKey: fixture.adapterKey,
  taskId, cwd, initializeRequest, resumeParams });

test('qualified bootstrap returns exact first-turn compiler inputs and fresh attachments', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    assert.equal(bootstrap.generation, 7);
    assert.equal(bootstrap.initialState.turns.length, 0);
    assert.equal(Object.isFrozen(bootstrap.initialState), true);
    assert.equal(Object.isFrozen(bootstrap.initialState.currentPermissions), true);
    assert.equal(bootstrap.initialState.latestModel, 'gpt-5.6-sol');
    assert.deepEqual(bootstrap.composerDefaults, { taskId, cwd, summary: null, personality: 'pragmatic' });
    assert.equal(fixture.resumeCount, 1);
    const envelope = { conversationId: taskId, turnStart: {
      request: { threadId: taskId, clientUserMessageId: 'client-1',
        input: [{ type: 'text', text: 'canary', text_elements: [] }], cwd,
        model: null, effort: null, serviceTier: null,
        collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-sol',
          reasoning_effort: 'low', developer_instructions: null } },
        permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
        turnTrigger: 'composer', multiAgentMode: 'explicitRequestOnly',
        responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' } },
      context: { inheritThreadSettings: true, writingBlockContextPrepared: true,
        localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [],
        responseItems: [], useAppServerPermissionDefault: false, usePermissionSelection: false } } };
    const compiled = compileNativeReadOnlyComposerStart(bootstrap.initialState, envelope,
      bootstrap.composerDefaults);
    assert.equal(compiled.request.cwd, null);
    assert.equal(compiled.request.runtimeWorkspaceRoots, null);
    assert.deepEqual(compiled.uiParams.runtimeWorkspaceRoots, [cwd]);
    const read = await bootstrap.readInitialState();
    assert.equal(read.turns.length, 0);
    assert.equal(fixture.resumeCount, 1);
    assert.deepEqual(await bootstrap.verifyIdle(), { turnCount: 0, latestTurnId: null });
    await fixture.waitDetached();
    assert.equal(fixture.sockets.size, 0);
    assert.equal(fixture.stopCalls, 0);
    assert.equal(fixture.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(fixture.methods.some(method => method === 'turn/start'), false);
  } finally { await fixture.close(); }
});

test('pre-resume history, pending queue/goal, unknown status and mismatched cwd fail closed', async () => {
  for (const mutation of ['history', 'queue', 'goal', 'cwd', 'unknown-status']) {
    const fixture = new BackendFixture(); await fixture.listen();
    try {
      if (mutation === 'history') fixture.turns = [{ id: 'existing', status: 'completed', items: [] }];
      if (mutation === 'queue') fixture.queue = [{ id: 'pending' }];
      if (mutation === 'goal') fixture.goal = { id: 'active' };
      if (mutation === 'cwd') fixture.readCwd = 'C:/other';
      if (mutation === 'unknown-status') fixture.beforeStatus = 'mystery';
      await assert.rejects(bootstrapManagedWorker(options(fixture)));
      if (mutation === 'queue' || mutation === 'goal') assert.equal(fixture.resumeCount, 0);
      assert.equal(fixture.stopCalls, 0);
    } finally { await fixture.close(); }
  }
});

test('same generation is required and later idle proof has terminal full history only', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    fixture.turns = [{ id: 'turn-one', status: 'completed', items: [] }];
    assert.deepEqual(await bootstrap.verifyIdle(), { turnCount: 1, latestTurnId: 'turn-one' });
    await assert.rejects(bootstrap.readInitialState(), /initial-history-not-empty/);
    fixture.readTurnStatusOverride = 'inProgress';
    await assert.rejects(bootstrap.verifyIdle(), /idle-history-unstable-or-nonterminal/);
    fixture.readTurnStatusOverride = null;
    fixture.turns = [{ id: 'turn-one', status: 'inProgress', items: [] }];
    await assert.rejects(bootstrap.verifyIdle(), /idle-history-unstable-or-nonterminal/);
    fixture.turns = [{ id: 'turn-one', status: 'completed', items: [] }];
    fixture.settings.backendGeneration = 8;
    await assert.rejects(bootstrap.verifyIdle(), /host-generation-changed/);
    assert.equal(fixture.resumeCount, 1);
  } finally { await fixture.close(); }
});

test('re-read rejects actually exposed model drift before first owner start', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    fixture.exposedModel = 'other-model';
    await assert.rejects(bootstrap.readInitialState(), /actual-thread-settings-drift/);
    assert.equal(fixture.resumeCount, 1);
  } finally { await fixture.close(); }
});

test('malformed frame, wrong ID, native error and EOF detach without stopping host', async () => {
  for (const error of ['native-error', 'eof', 'malformed', 'wrong-id']) {
    const fixture = new BackendFixture(); await fixture.listen();
    try {
      if (error === 'eof') fixture.eofMethod = 'thread/read';
      else if (error === 'malformed') fixture.malformedMethod = 'thread/read';
      else if (error === 'wrong-id') fixture.wrongIdMethod = 'thread/read';
      else fixture.replyError = 'thread/read';
      await assert.rejects(bootstrapManagedWorker(options(fixture)),
        error === 'eof' ? /frontend-eof/ :
          error === 'malformed' ? /frontend-frame-malformed/ :
          error === 'wrong-id' ? /frontend-response-id-mismatch/ : /frontend-rpc-error:-32001/);
      await fixture.waitDetached();
      assert.equal(fixture.stopCalls, 0);
      assert.equal(fixture.resumeCount, 0);
      assert.equal(fixture.sockets.size, 0);
    } finally { await fixture.close(); }
  }
});

test('unqualified resume options reject before opening a frontend', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    await assert.rejects(bootstrapManagedWorker({ ...options(fixture),
      resumeParams: { ...resumeParams, approvalPolicy: 'on-request' } }), /unqualified-resume-policy/);
    assert.equal(fixture.sockets.size, 0);
    assert.equal(fixture.methods.length, 0);
  } finally { await fixture.close(); }
});

test('generation replacement during a read rejects even when the old socket replies', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    fixture.generationFlipMethod = 'thread/read';
    await assert.rejects(bootstrapManagedWorker(options(fixture)), /host-generation-changed/);
    assert.equal(fixture.resumeCount, 0);
    await fixture.waitDetached();
    assert.equal(fixture.sockets.size, 0);
  } finally { await fixture.close(); }
});
