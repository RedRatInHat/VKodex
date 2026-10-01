import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { readAndQualifyNativeFirstTurnHistory,
  readAndQualifyUnknownNativeFirstTurnHistory } from '../src/desktop/native-first-turn-history.js';
import { readAndQualifyFreshFirstTurnIdleState } from
  '../src/desktop/native-first-turn-idle-state.js';
import { fingerprintNativeFirstTurnInput, fingerprintNativeFirstTurnUserItem } from
  '../src/desktop/native-first-turn-input-fingerprint.js';

const key = randomBytes(32);
const identity = { operationId: 'b857db38-8ad4-4b6c-83cc-2ba63b6aef61',
  sourceId: 'profile-a', sourceGeneration: '3818c7d2-4c41-4e93-a310-0fbfcfbe5d55',
  ownerEpoch: '2967ba72-3675-41ce-a591-f0dc7958482f',
  threadStartFingerprint: 'c'.repeat(64), backendIdentity: 'b'.repeat(64) };
const expected = { ...identity, threadId: '01a0f511-86e7-7942-8067-91d169eb18c7',
  turnId: 'turn-a', clientUserMessageId: 'client-a' } as const;
const expectedInputFingerprint = fingerprintNativeFirstTurnInput(
  [{ type: 'text', text: 'canary' }], { ...expected, fingerprintKey: key });
const turn = () => ({ id: expected.turnId, status: 'completed', itemsView: 'full',
  startedAt: null, completedAt: 123, durationMs: 34, error: null, items: [
  { id: 'user-a', type: 'userMessage', clientId: expected.clientUserMessageId,
    content: [{ type: 'text', text: 'canary', text_elements: [] }] },
  { id: 'reason-a', type: 'reasoning', summary: [], content: [] },
  { id: 'answer-a', type: 'agentMessage', text: 'done', delivery: null,
    memoryCitation: null, phase: null, questions: null },
] });
const page = (item: unknown = turn()) => ({ backwardsCursor: 'opaque-first', data: [item], nextCursor: null });
const read = (value: unknown, onRequest?: () => void) => {
  const rpc = { async initializedSession() { return { generation: 7 }; },
    isSessionCurrent(generation: number) { return generation === 7; },
    async request(method: string, params: unknown, options?: { expectedGeneration?: number; mutating?: boolean }) {
      assert.equal(method, 'thread/turns/list');
      assert.deepEqual(params, { threadId: expected.threadId, limit: 2,
        sortDirection: 'asc', itemsView: 'full' });
      assert.equal(options?.expectedGeneration, 7);
      assert.notEqual(options?.mutating, true);
      onRequest?.();
      return value;
    } };
  return readAndQualifyNativeFirstTurnHistory(rpc,
    { ...expected, expectedInputFingerprint, fingerprintKey: key });
};

test('fresh first-turn idle observation is read-only, generation-bound and content-free', async () => {
  const calls: string[] = [];
  const rpc = { async initializedSession() { return { generation: 7 }; },
    isSessionCurrent: (generation: number) => generation === 7,
    async request(method: string, params: Record<string, unknown>, options?: {
      expectedGeneration?: number; mutating?: boolean;
    }) {
      calls.push(method);
      assert.equal(params.threadId, expected.threadId);
      assert.equal(options?.expectedGeneration, 7);
      assert.notEqual(options?.mutating, true);
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false);
        return { thread: { id: expected.threadId, status: { type: 'idle' }, turns: [],
          privateText: 'PRIVATE_SENTINEL' } };
      }
      if (method === 'thread/turns/list') return { backwardsCursor: null,
        data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/queue/list') return { data: [], nextCursor: null };
      throw new Error('unexpected method');
    } };
  const evidence = await readAndQualifyFreshFirstTurnIdleState(rpc, expected.threadId);
  assert.deepEqual(calls, ['thread/read', 'thread/turns/list', 'thread/goal/get',
    'thread/queue/list', 'thread/read']);
  assert.deepEqual(evidence, { threadId: expected.threadId, backendGeneration: 7,
    status: 'idle', turnsEmpty: true, goalEmpty: true, queueEmpty: true });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_SENTINEL/u);
});

test('fresh first-turn idle observation rejects native activity, incomplete pages and generation drift', async () => {
  const base = { read: { thread: { id: expected.threadId,
    status: { type: 'idle' }, turns: [] } },
  turns: { backwardsCursor: null, data: [], nextCursor: null },
  goal: { goal: null }, queue: { data: [], nextCursor: null } };
  const cases = [
    { read: { thread: { ...base.read.thread, status: { type: 'notLoaded' } } } },
    { read: { thread: { ...base.read.thread, turns: [{}] } } },
    { read: { thread: { ...base.read.thread, id: 'foreign' } } },
    { turns: { ...base.turns, nextCursor: 'later' } },
    { turns: { ...base.turns, backwardsCursor: 'older' } },
    { turns: { ...base.turns, data: [{}] } },
    { goal: { goal: { status: 'active' } } },
    { queue: { ...base.queue, data: [{}] } },
    { queue: { ...base.queue, nextCursor: 'later' } },
  ];
  for (const change of cases) {
    const input = { ...base, ...change };
    const rpc = { initializedSession: async () => ({ generation: 7 }),
      isSessionCurrent: (generation: number) => generation === 7,
      request: async (method: string) => method === 'thread/read' ? input.read :
        method === 'thread/turns/list' ? input.turns :
        method === 'thread/goal/get' ? input.goal : input.queue };
    await assert.rejects(readAndQualifyFreshFirstTurnIdleState(rpc,
      expected.threadId), /first-turn idle state unqualified/u);
  }
  const absentBackwardsCursor = { data: [], nextCursor: null };
  const optionalCursorRpc = { initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: (generation: number) => generation === 7,
    request: async (method: string) => method === 'thread/read' ? base.read :
      method === 'thread/turns/list' ? absentBackwardsCursor :
      method === 'thread/goal/get' ? base.goal : base.queue };
  assert.equal((await readAndQualifyFreshFirstTurnIdleState(optionalCursorRpc,
    expected.threadId)).turnsEmpty, true);
  let current = true;
  await assert.rejects(readAndQualifyFreshFirstTurnIdleState({
    initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: (generation: number) => current && generation === 7,
    request: async (method: string) => {
      if (method === 'thread/queue/list') current = false;
      return method === 'thread/read' ? base.read :
        method === 'thread/turns/list' ? base.turns :
        method === 'thread/goal/get' ? base.goal : base.queue;
    },
  }, expected.threadId), /first-turn idle state unqualified/u);
  let readCount = 0;
  await assert.rejects(readAndQualifyFreshFirstTurnIdleState({
    initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: generation => generation === 7,
    request: async (method: string) => method === 'thread/read' ?
      ++readCount === 1 ? base.read : { thread: { ...base.read.thread,
        status: { type: 'active' } } } :
      method === 'thread/turns/list' ? base.turns :
      method === 'thread/goal/get' ? base.goal : base.queue,
  }, expected.threadId), /first-turn idle state unqualified/u);
  assert.equal(readCount, 2);
  const fencedCalls: string[] = [];
  let allowed = true;
  await assert.rejects(readAndQualifyFreshFirstTurnIdleState({
    initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: generation => generation === 7,
    request: async (method: string) => {
      fencedCalls.push(method);
      allowed = false;
      return base.read;
    },
  }, expected.threadId, () => { if (!allowed) throw new Error('source changed'); }),
  /first-turn idle state unqualified/u);
  assert.deepEqual(fencedCalls, ['thread/read']);
  let failedCalls = 0;
  await assert.rejects(readAndQualifyFreshFirstTurnIdleState({
    initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: generation => generation === 7,
    request: async () => { failedCalls++; throw new Error('PRIVATE_BACKEND_ERROR'); },
  }, expected.threadId), error => {
    assert.doesNotMatch(String(error), /PRIVATE_BACKEND_ERROR/u);
    return /first-turn idle state unqualified/u.test(String(error));
  });
  assert.equal(failedCalls, 1, 'a failed read must not be retried');
});

test('one completed full native turn binds the exact client input without exposing content', async () => {
  const evidence = await read(page());
  assert.deepEqual(Object.keys(evidence).sort(), ['clientUserMessageId', 'historyHmac', 'threadId', 'turnId']);
  assert.equal(evidence.clientUserMessageId, expected.clientUserMessageId);
  assert.match(evidence.historyHmac, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes('canary'), false);
  assert.deepEqual(await read(page()), evidence);
  assert.deepEqual(await read({ ...page(), backwardsCursor: 'different-opaque-cursor' }), evidence);
  assert.deepEqual(await read({ ...page(), data: [{
    items: turn().items, error: null, durationMs: 34, completedAt: 123,
    startedAt: null, itemsView: 'full', status: 'completed', id: expected.turnId,
  }] }), evidence);
  await assert.rejects(read(page({ ...turn(), items: [
    { ...turn().items[0], content: [{ type: 'text', text: 'changed', text_elements: [] }] },
    ...turn().items.slice(1),
  ] })), /first-turn history unqualified/u);
});

test('incomplete, wrong, duplicate or nonterminal first turns cannot qualify', async () => {
  const base = turn();
  for (const value of [
    { ...page(), nextCursor: 'later' }, { ...page(), data: [] },
    { ...page(), data: [base, { ...base, id: 'turn-b' }] },
    page({ ...base, id: 'turn-b' }), page({ ...base, status: 'inProgress' }),
    page({ ...base, status: 'failed' }), page({ ...base, itemsView: 'summary' }),
    page({ ...base, items: base.items.slice(1) }),
    page({ ...base, items: [{ ...base.items[0], clientId: 'wrong' }, ...base.items.slice(1)] }),
    page({ ...base, items: [base.items[0], base.items[0], ...base.items.slice(1)] }),
    page({ ...base, items: [base.items[0], base.items[1]] }),
    page({ ...base, items: [base.items[0], base.items[1],
      { ...base.items[2], id: base.items[1]!.id }] }),
  ]) await assert.rejects(read(value), /first-turn history unqualified/u);
});

test('tools, unknown item shapes and malformed response are refused', async () => {
  const base = turn();
  for (const item of [
    { id: 'tool', type: 'commandExecution' }, { id: 'tool', type: 'mcpToolCall' },
    { id: 'tool', type: 'collabAgentToolCall' }, { id: 'unknown', type: 'futureKind' },
    { id: 'unknown' }, { type: 'reasoning' },
  ]) await assert.rejects(read(page({ ...base, items: [...base.items, item] })), /first-turn history unqualified/u);
  await assert.rejects(read({ ...page(), extra: 'unexpected' }), /first-turn history unqualified/u);
  await assert.rejects(read(page({ ...base, items: undefined })), /first-turn history unqualified/u);
  for (const field of ['delivery', 'phase', 'memoryCitation', 'questions'] as const) {
    await assert.rejects(read(page({ ...base, items: [base.items[0], base.items[1],
      { ...base.items[2], [field]: field === 'questions' ? [{ prompt: 'more' }] : 'other' }] })),
    /first-turn history unqualified/u);
  }
});

test('scope, key and bounded JSON are mandatory', async () => {
  await assert.rejects(readAndQualifyNativeFirstTurnHistory({
    initializedSession: async () => ({ generation: 7 }), isSessionCurrent: () => true,
    request: async () => page(),
  }, { ...expected, expectedInputFingerprint,
    fingerprintKey: new Uint8Array(4) }), /first-turn history unqualified/u);
  await assert.rejects(readAndQualifyNativeFirstTurnHistory({
    initializedSession: async () => ({ generation: 7 }), isSessionCurrent: () => true,
    request: async () => page(),
  }, { ...expected, threadId: '', expectedInputFingerprint,
    fingerprintKey: key }), /first-turn history unqualified/u);
  await assert.rejects(read(page({ ...turn(), extra: 'x'.repeat(1024 * 1024 + 1) })),
    /first-turn history unqualified/u);
});

test('history read refuses a changed backend generation rather than rebinding to another server', async () => {
  let current = true;
  await assert.rejects(readAndQualifyNativeFirstTurnHistory({
    initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: generation => current && generation === 7,
    request: async () => { current = false; return page(); },
  }, { ...expected, expectedInputFingerprint, fingerprintKey: key }), /first-turn history unqualified/u);
});

test('unknown first-turn ACK is resolved only by exact completed history', async () => {
  const scope = { ...identity, threadId: expected.threadId,
    clientUserMessageId: expected.clientUserMessageId,
    expectedInputFingerprint, fingerprintKey: key };
  const unknownRead = (value: unknown, onRequest?: () => void) =>
    readAndQualifyUnknownNativeFirstTurnHistory({
      initializedSession: async () => ({ generation: 7 }),
      isSessionCurrent: generation => generation === 7,
      request: async (method, params, options) => {
        assert.equal(method, 'thread/turns/list');
        assert.deepEqual(params, { threadId: expected.threadId, limit: 2,
          sortDirection: 'asc', itemsView: 'full' });
        assert.equal(options?.expectedGeneration, 7);
        onRequest?.();
        return value;
      },
    }, scope);
  const evidence = await unknownRead(page());
  assert.equal(evidence.turnId, expected.turnId);
  assert.equal(evidence.clientUserMessageId, expected.clientUserMessageId);
  assert.equal(JSON.stringify(evidence).includes('canary'), false);
  for (const value of [
    { ...page(), data: [] },
    { ...page(), data: [turn(), { ...turn(), id: 'turn-b' }] },
    { ...page(), nextCursor: 'later' },
    page({ ...turn(), status: 'inProgress' }),
    page({ ...turn(), items: [{ ...turn().items[0], content: [
      { type: 'text', text: 'other', text_elements: [] }] }, ...turn().items.slice(1)] }),
  ]) await assert.rejects(unknownRead(value), /first-turn history unqualified/u);
});

test('durable first-turn input fingerprint round-trips exact native text without storing it', () => {
  const scope = { ...expected, fingerprintKey: key };
  const input = [{ type: 'text', text: '  exact Unicode ё🚀 text  ' }];
  const native = { id: 'user-a', type: 'userMessage', clientId: expected.clientUserMessageId,
    content: [{ type: 'text', text: input[0]!.text, text_elements: [] }] };
  const fp = fingerprintNativeFirstTurnInput(input, scope);
  assert.match(fp, /^[0-9a-f]{64}$/u);
  assert.equal(fingerprintNativeFirstTurnUserItem(native, scope), fp);
  assert.notEqual(fingerprintNativeFirstTurnInput([{ type: 'text', text: '  exact Unicode ё🚀 text ' }],
    scope), fp);
  assert.notEqual(fingerprintNativeFirstTurnUserItem(native, { ...scope,
    ownerEpoch: 'b1ff8bbf-17c6-4f1e-b145-a49fe9781635' }), fp);
  for (const item of [
    { ...native, clientId: 'other' },
    { ...native, content: [{ type: 'text', text: input[0]!.text, extra: true }] },
    { ...native, content: [{ ...native.content[0], text_elements: [{ opaque: true }] }] },
    { ...native, content: [native.content[0], native.content[0]] },
    { ...native, content: 'legacy string' },
  ]) assert.throws(() => fingerprintNativeFirstTurnUserItem(item, scope), /first-turn input/u);
});
