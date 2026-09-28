import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNativeNextTurnSettings as compile } from '../src/codex/native-next-turn-settings.js';

const taskId = '01a0e498-4fa0-74c0-a795-c5047a06d21c';
function state() {
  return { id: taskId, hostId: 'local', latestModel: 'gpt-5.6-sol', latestReasoningEffort: 'low',
    threadRuntimeStatus: { type: 'idle' }, turnsPagination: { hasLoadedOldest: true, olderCursor: null },
    turns: [{ turnId: 'turn-1', status: 'completed' }],
    requests: [] };
}
function evidence() {
  return { threadId: taskId, terminalTurnIds: ['turn-1'], pendingRequests: 0,
    queuedFollowUps: 0, backendQueueEmpty: true };
}
function compileNativeNextTurnSettings(input: unknown, current: unknown, proof: unknown = evidence()) {
  return compile(input, current, proof);
}
function request() {
  return { requestId: 'request-1', sourceClientId: 'follower-1',
    method: 'thread-follower-update-thread-settings', version: 2, hostId: 'local',
    params: { conversationId: taskId, activeTurnId: null,
      threadSettings: { model: 'gpt-6-luna', effort: 'medium', multiAgentMode: 'explicitRequestOnly' },
      condition: { ifModelEquals: 'gpt-5.6-sol', ifEffortEquals: 'low' } } };
}

test('idle local v2 model change compiles only schema-supported next-turn fields', () => {
  const input = request(), current = state();
  const original = structuredClone(input);
  assert.deepEqual(compileNativeNextTurnSettings(input, current), {
    kind: 'ready', params: { threadId: taskId, model: 'gpt-6-luna', effort: 'medium',
      multiAgentMode: 'explicitRequestOnly' },
  });
  assert.deepEqual(input, original);
});

test('failed model or effort condition is explicit no-write outcome', () => {
  const staleModel = request(); staleModel.params.condition.ifModelEquals = 'other';
  assert.deepEqual(compileNativeNextTurnSettings(staleModel, state()), { kind: 'condition-not-applied' });
  const staleEffort = request(); staleEffort.params.condition.ifEffortEquals = 'high';
  assert.deepEqual(compileNativeNextTurnSettings(staleEffort, state()), { kind: 'condition-not-applied' });
});

test('active-turn permissions update and unrelated settings never compile as next-turn model change', () => {
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), params: {
    ...request().params, activeTurnId: 'active-turn' } }, state()), /unsupported/i);
  for (const key of ['permissions', 'sandboxPolicy', 'cwd', 'serviceTier', 'approvalPolicy']) {
    const input = request() as unknown as { params: { threadSettings: Record<string, unknown> } };
    input.params.threadSettings[key] = key === 'cwd' ? 'C:/other' : null;
    assert.throws(() => compileNativeNextTurnSettings(input, state()), /unsupported/i, key);
  }
});

test('wrong route and non-idle or incomplete state fail closed', () => {
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), version: 1 }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), hostId: 'remote' }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), params: {
    ...request().params, conversationId: 'other' } }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), { ...state(),
    threadRuntimeStatus: { type: 'inProgress' } }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), { ...state(),
    requests: [{ id: 1 }] }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), { ...state(),
    turnsPagination: { hasLoadedOldest: false, olderCursor: 'old' } }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), state(), { ...evidence(),
    backendQueueEmpty: false }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), state(), { ...evidence(),
    queuedFollowUps: 1 }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), state(), { ...evidence(),
    terminalTurnIds: ['other-turn'] }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), { ...state(),
    nativeQueue: [{ id: 'queued' }] }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), { ...state(),
    queuedFollowUps: [{ id: 'queued' }] }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), { ...state(),
    turns: [{ turnId: 'turn-1', status: 'completed' },
      { turnId: 'turn-1', status: 'completed' }] },
  { ...evidence(), terminalTurnIds: ['turn-1', 'turn-1'] }), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), state(), null), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings(request(), { ...state(),
    turns: [{ turnId: 'turn-1', status: 'inProgress' }] }), /unsupported/i);
});

test('malformed envelopes, conditions and omitted settings do not become defaults', () => {
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), type: 'notification' }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), requestId: {} }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), unexpected: true }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), params: {
    ...request().params, threadSettings: { model: 'gpt-6-luna' } } }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), params: {
    ...request().params, condition: { ifModelEquals: undefined } } }, state()), /unsupported/i);
  assert.throws(() => compileNativeNextTurnSettings({ ...request(), params: {
    ...request().params, threadSettings: { model: 'gpt-6-luna', effort: null,
      multiAgentMode: undefined } } }, state()), /unsupported/i);
  assert.deepEqual(compileNativeNextTurnSettings({ ...request(), params: {
    ...request().params, condition: { ifEffortEquals: null },
    threadSettings: { model: 'gpt-6-luna', effort: null } } },
  { ...state(), latestReasoningEffort: null }), {
    kind: 'ready', params: { threadId: taskId, model: 'gpt-6-luna', effort: null },
  });
});
