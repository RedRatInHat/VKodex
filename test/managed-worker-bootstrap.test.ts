import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { bootstrapManagedWorker } from '../src/desktop/managed-worker-bootstrap.js';
import { compileNativeReadOnlyComposerStart } from '../src/codex/native-composer-start.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';

type Row = Record<string, unknown>;
const taskId = '01a0e498-4fa0-74c0-a795-c5047a06d21c';
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
  fastModeAllowed: boolean | null = false;
  requirementsWithoutFastMode = false;
  onTurnsList: ((count: number) => void) | null = null;
  turnsListCount = 0;
  onThreadRead: ((count: number) => void) | null = null;
  threadReadCount = 0;
  nextCursor: string | null = null;
  beforeStatus: string = 'notLoaded';
  readCwd: string = cwd;
  exposedModel: string | null = null;
  readTurnStatusOverride: string | null = null;
  resumeCount = 0;
  idOnlyResumeCount = 0;
  idOnlyApprovalPolicy: string = 'never';
  onIdOnly: (() => void) | null = null;
  replyError: string | null = null;
  eofMethod: string | null = null;
  malformedMethod: string | null = null;
  wrongIdMethod: string | null = null;
  generationFlipMethod: string | null = null;
  idOnlyBenignNotifications = false;
  stopCalls = 0;
  effectiveOverride: Row | null = null;
  threadOverrides: Row = {};
  expectedResume: Row = resumeParams;
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
          if (this.idOnlyBenignNotifications && method === 'thread/resume' &&
            (frame.params as Row).threadId === taskId && Object.keys(frame.params as Row).length === 1) {
            socket.write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: taskId } }) + '\n');
            socket.write(JSON.stringify({ method: 'thread/goal/cleared', params: { threadId: taskId } }) + '\n');
          }
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
      if (Object.keys(params).length === 1 && params.threadId === taskId) {
        this.idOnlyResumeCount++;
        this.onIdOnly?.();
      } else { assert.deepEqual(params, this.expectedResume); this.resumeCount++; }
      return { thread: this.thread('idle'), cwd, model: 'gpt-5.6-sol', reasoningEffort: 'low',
        approvalPolicy: this.idOnlyResumeCount ? this.idOnlyApprovalPolicy : 'never',
        approvalsReviewer: 'user', activePermissionProfile: { id: ':read-only' },
        sandbox: { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [cwd],
        serviceTier: null, ...(this.effectiveOverride ?? {}) };
    }
    if (method === 'thread/read') {
      const thread = this.thread(this.resumeCount ? 'idle' : this.beforeStatus);
      this.threadReadCount++; this.onThreadRead?.(this.threadReadCount);
      return { thread };
    }
    if (method === 'thread/turns/list') {
      const data = this.turns.map(turn => ({ ...turn, itemsView: 'full' }));
      this.turnsListCount++; this.onTurnsList?.(this.turnsListCount);
      return { data, nextCursor: this.nextCursor };
    }
    if (method === 'thread/goal/get') return { goal: this.goal };
    if (method === 'thread/queue/list') return { data: this.queue, nextCursor: null };
    if (method === 'config/read') return { config: { model_reasoning_summary: null, personality: 'pragmatic' } };
    if (method === 'configRequirements/read') return { requirements: this.fastModeAllowed === null ? null :
      { featureRequirements: this.requirementsWithoutFastMode ? {} :
        { fast_mode: this.fastModeAllowed } } };
    throw new Error('unallowed test RPC');
  }
  private thread(status: string): Row {
    return { id: taskId, sessionId: taskId, createdAt: 100, updatedAt: 101,
      cwd: this.readCwd, model: this.exposedModel ?? 'gpt-5.6-sol', modelProvider: 'openai',
      reasoningEffort: 'low',
      status: { type: status }, turns: this.turns.map(turn => this.readTurnStatusOverride === null ? turn :
        { ...turn, status: this.readTurnStatusOverride }),
      environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }],
      ...this.threadOverrides };
  }
}
const options = (fixture: BackendFixture) => ({ host: fixture.host, adapterKey: fixture.adapterKey,
  taskId, cwd, initializeRequest, resumeParams });

test('opt-in approved policy qualifies exact native model, profile, sandbox, environment and rejects drift', async () => {
  for (const sandbox of [
    { type: 'readOnly', networkAccess: false },
    { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    { type: 'dangerFullAccess' },
  ]) {
    const fixture = new BackendFixture(); await fixture.listen();
    try {
      const profile = { id: sandbox.type === 'dangerFullAccess' ? ':danger-full-access' :
        sandbox.type === 'workspaceWrite' ? ':workspace-write' : ':read-only', extends: null };
      const environments = [{ environmentId: 'local' as const, cwd, runtimeWorkspaceRoots: [cwd] }];
      const policy = approveTaskPolicy({ threadId: taskId, model: 'gpt-6-luna', modelProvider: 'openai',
        effort: 'high', cwd, runtimeWorkspaceRoots: [cwd], environments,
        approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: profile,
        sandbox, serviceTier: null });
      const exposedEnvironments = sandbox.type === 'readOnly'
        ? [{ environmentId: 'local', cwd: 'c:\\OWN-WORKSPACE',
          runtimeWorkspaceRoots: ['c:\\own-workspace'] }] : environments;
      fixture.threadOverrides = { model: policy.model, modelProvider: policy.modelProvider,
        reasoningEffort: policy.effort, environments: exposedEnvironments };
      fixture.effectiveOverride = { model: policy.model, modelProvider: policy.modelProvider,
        reasoningEffort: policy.effort, activePermissionProfile: profile, sandbox };
      const approvedResume = { ...resumeParams, model: policy.model, permissions: profile.id,
        config: { model_reasoning_effort: policy.effort } };
      fixture.expectedResume = structuredClone(approvedResume);
      const givenResume = structuredClone(approvedResume);
      const givenPolicy = structuredClone(policy);
      const pending = bootstrapManagedWorker({ ...options(fixture),
        resumeParams: givenResume, approvedTaskPolicy: givenPolicy });
      // Scope is copied before the first awaited native read.
      (givenResume as Row).model = 'caller-mutated';
      (givenPolicy as unknown as Row).model = 'caller-mutated';
      const bootstrap = await pending;
      assert.equal(bootstrap.initialState.latestModel, policy.model);
      assert.equal(bootstrap.initialState.currentPermissions.sandboxPolicy &&
        (bootstrap.initialState.currentPermissions.sandboxPolicy as Row).type, sandbox.type);
      assert.equal(fixture.resumeCount, 1);
      await assert.rejects(bootstrap.qualifyContinuation(() => ({} as never)), /opt-in-continuation-not-qualified/);
      fixture.threadOverrides = { ...fixture.threadOverrides, model: 'unexpected' };
      await assert.rejects(bootstrap.readInitialState(), /actual-thread-settings-drift/);
      assert.equal(fixture.stopCalls, 0);
    } finally { await fixture.close(); }
  }
});

test('opt-in effective response rejects missing or mismatched provider, reviewer, profile, tier and roots', async () => {
  const profile = { id: ':read-only', extends: null };
  const environments = [{ environmentId: 'local' as const, cwd, runtimeWorkspaceRoots: [cwd] }];
  const policy = approveTaskPolicy({ threadId: taskId, model: 'gpt-6-luna', modelProvider: 'openai',
    effort: 'high', cwd, runtimeWorkspaceRoots: [cwd], environments,
    approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: profile,
    sandbox: { type: 'readOnly', networkAccess: false }, serviceTier: null });
  const approvedResume = { ...resumeParams, model: policy.model,
    config: { model_reasoning_effort: policy.effort } };
  for (const changed of [
    { modelProvider: 'other' }, { approvalsReviewer: 'auto_review' },
    { activePermissionProfile: { id: ':read-only', extends: ':inherited' } },
    { serviceTier: 'priority' }, { runtimeWorkspaceRoots: ['C:/elsewhere'] },
    { sandbox: { type: 'readOnly', networkAccess: true } },
  ]) {
    const fixture = new BackendFixture(); await fixture.listen();
    try {
      fixture.expectedResume = approvedResume;
      fixture.threadOverrides = { model: policy.model, modelProvider: policy.modelProvider,
        reasoningEffort: policy.effort, environments };
      fixture.effectiveOverride = { model: policy.model, modelProvider: policy.modelProvider,
        reasoningEffort: policy.effort, activePermissionProfile: profile,
        sandbox: policy.sandbox, ...changed };
      await assert.rejects(bootstrapManagedWorker({ ...options(fixture),
        resumeParams: approvedResume, approvedTaskPolicy: policy }), /effective resume differs/);
      assert.equal(fixture.resumeCount, 1);
      assert.equal(fixture.stopCalls, 0);
    } finally { await fixture.close(); }
  }
});

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

test('stock reader proves same-worker terminal history, empty queue and explicit tier requirements', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    const stock = await bootstrap.readStockState(() => {});
    assert.deepEqual(stock.terminalTurnIds, []);
    assert.equal(stock.turnCount, 0);
    assert.equal(stock.fastModeAllowed, false);
    assert.equal(stock.model, 'gpt-5.6-sol');
    assert.equal(stock.reasoningEffort, 'low');
    assert.equal(fixture.methods.filter(method => method === 'configRequirements/read').length, 1);
    fixture.requirementsWithoutFastMode = true;
    assert.equal((await bootstrap.readStockState(() => {})).fastModeAllowed, null);
    fixture.requirementsWithoutFastMode = false;
    fixture.queue = [{ id: 'unrelated-queued' }];
    await assert.rejects(bootstrap.readStockState(() => {}), /goal-or-queue-not-empty/);
    fixture.queue = [];
    fixture.turns = [{ id: 'active', status: 'inProgress', items: [] }];
    await assert.rejects(bootstrap.readStockState(() => {}), /nonterminal/);
    fixture.turns = [{ id: 'same-id', status: 'completed', items: [{ id: 'i', type: 'userMessage',
      content: [{ type: 'text', text: 'before' }] }] }];
    const mutateOn = fixture.threadReadCount + 2;
    fixture.onThreadRead = count => { if (count === mutateOn) fixture.turns = [{ id: 'same-id',
      status: 'completed', items: [{ id: 'i', type: 'userMessage',
        content: [{ type: 'text', text: 'after' }] }] }]; };
    await assert.rejects(bootstrap.readStockState(() => {}), /stock-history-unstable-or-nonterminal/);
    const queueOn = fixture.threadReadCount + 2;
    fixture.onThreadRead = count => { if (count === queueOn) fixture.queue = [
      { id: 'late-queue' }]; };
    fixture.turns = []; fixture.queue = [];
    await assert.rejects(bootstrap.readStockState(() => {}), /goal-or-queue-not-empty/);
  } finally { await fixture.close(); }
});

test('idle proof joins accepted queue client IDs to exactly one terminal user message', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    const user = (clientId: string | null) => ({ id: `item-${clientId ?? 'null'}`,
      type: 'userMessage', clientId, content: [{ type: 'text', text: 'fixture only' }] });
    fixture.turns = [{ id: 'terminal-queue-turn', status: 'completed', items: [user('queued-client')] }];
    assert.deepEqual(await bootstrap.verifyIdle([], ['queued-client']),
      { turnCount: 1, latestTurnId: 'terminal-queue-turn' });
    fixture.turns = [{ id: 'terminal-queue-turn', status: 'completed', items: [
      { id: 'older-user', type: 'userMessage', content: [{ type: 'text', text: 'legacy' }] },
      user('queued-client')] }];
    assert.deepEqual(await bootstrap.verifyIdle([], ['queued-client']),
      { turnCount: 1, latestTurnId: 'terminal-queue-turn' });
    await assert.rejects(bootstrap.verifyIdle([], ['queued-client', 'queued-client']),
      /invalid-expected-queue-clients/);
    await assert.rejects(bootstrap.verifyIdle([], ['missing-client']), /queue|terminal/i);
    fixture.turns = [{ id: 'terminal-queue-turn', status: 'completed', items: [user(null)] }];
    await assert.rejects(bootstrap.verifyIdle([], ['queued-client']), /queue|terminal/i);
    fixture.turns = [{ id: 'terminal-queue-turn', status: 'completed',
      items: [user('queued-client'), { ...user('queued-client'), id: 'second' }] }];
    await assert.rejects(bootstrap.verifyIdle([], ['queued-client']), /queue|terminal/i);
    fixture.turns = [{ id: 'terminal-queue-turn', status: 'completed', items: [user('queued-client')] }];
    fixture.queue = [{ id: 'still-queued' }];
    await assert.rejects(bootstrap.verifyIdle([], ['queued-client']), /goal-or-queue-not-empty/);
  } finally { await fixture.close(); }
});

test('stock admission joins prior accepted queue clients to unique terminal canonical items', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    const read = bootstrap.readStockState;
    const user = (clientId: string) => ({ id: `item-${clientId}`, type: 'userMessage',
      clientId, content: [{ type: 'text', text: 'fixture only' }] });
    const methodsBefore = fixture.methods.length;
    await assert.rejects(read(() => {}, ['accepted-but-missing']),
      /accepted-queue-input-not-terminal/);
    fixture.turns = [{ id: 'terminal', status: 'completed', items: [user('accepted')] }];
    assert.deepEqual((await read(() => {}, ['accepted'])).terminalTurnIds, ['terminal']);
    fixture.turns = [
      { id: 'terminal-a', status: 'completed', items: [{ ...user('accepted-a'), id: 'same-canonical-item' }] },
      { id: 'terminal-b', status: 'completed', items: [{ ...user('accepted-b'), id: 'same-canonical-item' }] },
    ];
    await assert.rejects(read(() => {}, ['accepted-a', 'accepted-b']),
      /accepted-queue-input-not-terminal/);
    fixture.turns = [{ id: 'terminal', status: 'completed', items: [user('accepted')] }];
    fixture.turns.push({ id: 'second-terminal', status: 'completed', items: [user('accepted')] });
    await assert.rejects(read(() => {}, ['accepted']), /accepted-queue-input-not-terminal/);
    fixture.turns = [{ id: 'terminal', status: 'completed', items: [
      { ...user('accepted'), id: '' }] }];
    await assert.rejects(read(() => {}, ['accepted']), /accepted-queue-input-not-terminal/);
    fixture.turns = [{ id: 'terminal', status: 'completed', items: [
      { id: 'response-echo', type: 'agentMessage', clientId: 'accepted', text: 'not a user item' }] }];
    await assert.rejects(read(() => {}, ['accepted']), /accepted-queue-input-not-terminal/);
    await assert.rejects(read(() => {}, ['accepted', 'accepted']), /invalid-expected-queue-clients/);
    assert.ok(fixture.methods.slice(methodsBefore).every(method =>
      !['thread/resume', 'turn/start', 'thread/queue/add'].includes(method)));
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

test('idle proof accounts for every accepted receipt before declaring safe shutdown', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    await assert.rejects(bootstrap.verifyIdle(['accepted-one']),
      { name: 'ManagedWorkerIdleProofRefusedError', message: 'accepted-turn-not-terminal' });
    fixture.turns = [{ id: 'unrelated', status: 'completed', items: [] }];
    await assert.rejects(bootstrap.verifyIdle(['accepted-one']),
      { name: 'ManagedWorkerIdleProofRefusedError', message: 'accepted-turn-not-terminal' });
    fixture.turns.push({ id: 'accepted-one', status: 'completed', items: [] });
    assert.deepEqual(await bootstrap.verifyIdle(['accepted-one']),
      { turnCount: 2, latestTurnId: 'accepted-one' });
    const methodCount = fixture.methods.length;
    await assert.rejects(bootstrap.verifyIdle(['']), /invalid-expected-turn-ids/);
    await assert.rejects(bootstrap.verifyIdle(['accepted-one', 'accepted-one']), /invalid-expected-turn-ids/);
    assert.equal(fixture.methods.length, methodCount);
    fixture.eofMethod = 'thread/turns/list';
    await assert.rejects(bootstrap.verifyIdle(['accepted-one']), /frontend-eof/);
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

function ownerFence() {
  return { threadId: taskId, ownerEpoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', backendGeneration: 7,
    semanticRevision: 12, pendingRequests: 0, queuedFollowUps: 0,
    inFlightCommands: 0, unconfirmedOperations: false };
}

test('continuation qualifier accepts bounded completed history and exact ID-only current policy', async () => {
  for (const count of [1, 2]) {
    const fixture = new BackendFixture(); await fixture.listen();
    try {
      const bootstrap = await bootstrapManagedWorker(options(fixture));
      fixture.idOnlyBenignNotifications = true;
      fixture.turns = Array.from({ length: count }, (_, index) =>
        ({ id: `turn-${index}`, status: 'completed', items: [] }));
      const evidence = await bootstrap.qualifyContinuation(ownerFence);
      assert.equal(evidence.turnCount, count);
      assert.equal(evidence.latestTurnId, `turn-${count - 1}`);
      assert.deepEqual(evidence.terminalTurnIds, fixture.turns.map(turn => turn.id));
      assert.equal(Object.isFrozen(evidence.terminalTurnIds), true);
      assert.equal(evidence.effective.activePermissionProfileId, ':read-only');
      assert.equal(evidence.effective.approvalPolicy, 'never');
      assert.equal(fixture.idOnlyResumeCount, 1);
      assert.equal(fixture.resumeCount, 1);
      assert.equal(fixture.stopCalls, 0);
    } finally { await fixture.close(); }
  }
});

test('continuation qualifier cannot replace the first-turn bootstrap path', async () => {
  const fixture = new BackendFixture(); await fixture.listen();
  try {
    const bootstrap = await bootstrapManagedWorker(options(fixture));
    await assert.rejects(bootstrap.qualifyContinuation(ownerFence), /continuation-requires-prior-turn/);
    assert.equal(fixture.idOnlyResumeCount, 0);
  } finally { await fixture.close(); }
});

test('continuation qualifier refuses pending owner state, unsafe policy, history change and semantic drift', async () => {
  for (const scenario of ['pending', 'unsafe', 'history', 'revision']) {
    const fixture = new BackendFixture(); await fixture.listen();
    try {
      const bootstrap = await bootstrapManagedWorker(options(fixture));
      fixture.turns = [{ id: 'turn-0', status: 'completed', items: [] }];
      const fence = ownerFence();
      if (scenario === 'pending') fence.pendingRequests = 1;
      if (scenario === 'unsafe') fixture.idOnlyApprovalPolicy = 'untrusted';
      if (scenario === 'history') fixture.onIdOnly = () => {
        fixture.turns.push({ id: 'turn-1', status: 'completed', items: [] });
      };
      if (scenario === 'revision') fixture.onIdOnly = () => { fence.semanticRevision++; };
      await assert.rejects(bootstrap.qualifyContinuation(() => fence));
      if (scenario === 'pending') assert.equal(fixture.idOnlyResumeCount, 0);
      assert.equal(fixture.stopCalls, 0);
    } finally { await fixture.close(); }
  }
});
