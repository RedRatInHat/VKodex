import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { readAndQualifyNativeFirstTurnHistory } from '../src/desktop/native-first-turn-history.js';

const key = randomBytes(32);
const expected = { threadId: 'thread-a', turnId: 'turn-a', clientUserMessageId: 'client-a' } as const;
const turn = () => ({ id: expected.turnId, status: 'completed', itemsView: 'full',
  startedAt: null, completedAt: 123, durationMs: 34, error: null, items: [
  { id: 'user-a', type: 'userMessage', clientId: expected.clientUserMessageId,
    content: [{ type: 'text', text: 'canary' }] },
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
    { ...expected, fingerprintKey: key });
};

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
  assert.notEqual((await read(page({ ...turn(), items: [
    { ...turn().items[0], content: [{ type: 'text', text: 'changed' }] }, ...turn().items.slice(1),
  ] }))).historyHmac, evidence.historyHmac);
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
  }, { ...expected, fingerprintKey: new Uint8Array(4) }), /first-turn history unqualified/u);
  await assert.rejects(readAndQualifyNativeFirstTurnHistory({
    initializedSession: async () => ({ generation: 7 }), isSessionCurrent: () => true,
    request: async () => page(),
  }, { ...expected, threadId: '', fingerprintKey: key }), /first-turn history unqualified/u);
  await assert.rejects(read(page({ ...turn(), extra: 'x'.repeat(1024 * 1024 + 1) })),
    /first-turn history unqualified/u);
});

test('history read refuses a changed backend generation rather than rebinding to another server', async () => {
  let current = true;
  await assert.rejects(readAndQualifyNativeFirstTurnHistory({
    initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: generation => current && generation === 7,
    request: async () => { current = false; return page(); },
  }, { ...expected, fingerprintKey: key }), /first-turn history unqualified/u);
});
