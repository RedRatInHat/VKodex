import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { qualifyNativeFirstTurnHistory } from '../src/desktop/native-first-turn-history.js';

const key = randomBytes(32);
const expected = { threadId: 'thread-a', turnId: 'turn-a', clientUserMessageId: 'client-a' };
const turn = () => ({ id: expected.turnId, status: 'completed', itemsView: 'full', items: [
  { id: 'user-a', type: 'userMessage', clientId: expected.clientUserMessageId,
    content: [{ type: 'text', text: 'canary' }] },
  { id: 'reason-a', type: 'reasoning', summary: [] },
  { id: 'answer-a', type: 'agentMessage', text: 'done' },
] });
const page = (item: unknown = turn()) => ({ data: [item], nextCursor: null });
const qualify = (value: unknown) => qualifyNativeFirstTurnHistory(value, { ...expected, fingerprintKey: key });

test('one completed full native turn binds the exact client input without exposing content', () => {
  const evidence = qualify(page());
  assert.deepEqual(Object.keys(evidence).sort(), ['clientUserMessageId', 'historyHmac', 'threadId', 'turnId']);
  assert.equal(evidence.clientUserMessageId, expected.clientUserMessageId);
  assert.match(evidence.historyHmac, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(evidence).includes('canary'), false);
  assert.deepEqual(qualify(page()), evidence);
  assert.notEqual(qualify(page({ ...turn(), items: [
    { ...turn().items[0], content: [{ type: 'text', text: 'changed' }] }, ...turn().items.slice(1),
  ] })).historyHmac, evidence.historyHmac);
});

test('incomplete, wrong, duplicate or nonterminal first turns cannot qualify', () => {
  const base = turn();
  for (const value of [
    { data: [base], nextCursor: 'later' }, { data: [], nextCursor: null },
    { data: [base, { ...base, id: 'turn-b' }], nextCursor: null },
    page({ ...base, id: 'turn-b' }), page({ ...base, status: 'inProgress' }),
    page({ ...base, status: 'failed' }), page({ ...base, itemsView: 'summary' }),
    page({ ...base, items: base.items.slice(1) }),
    page({ ...base, items: [{ ...base.items[0], clientId: 'wrong' }, ...base.items.slice(1)] }),
    page({ ...base, items: [base.items[0], base.items[0], ...base.items.slice(1)] }),
    page({ ...base, items: [base.items[0], base.items[1]] }),
  ]) assert.throws(() => qualify(value), /first-turn history unqualified/u);
});

test('tools, unknown item shapes and malformed response are refused', () => {
  const base = turn();
  for (const item of [
    { id: 'tool', type: 'commandExecution' }, { id: 'tool', type: 'mcpToolCall' },
    { id: 'tool', type: 'collabAgentToolCall' }, { id: 'unknown', type: 'futureKind' },
    { id: 'unknown' }, { type: 'reasoning' },
  ]) assert.throws(() => qualify(page({ ...base, items: [...base.items, item] })), /first-turn history unqualified/u);
  assert.throws(() => qualify({ ...page(), extra: 'unexpected' }), /first-turn history unqualified/u);
  assert.throws(() => qualify(page({ ...base, items: undefined })), /first-turn history unqualified/u);
});

test('scope, key and bounded JSON are mandatory', () => {
  assert.throws(() => qualifyNativeFirstTurnHistory(page(), { ...expected,
    fingerprintKey: new Uint8Array(4) }), /first-turn history unqualified/u);
  assert.throws(() => qualifyNativeFirstTurnHistory(page(), { ...expected,
    threadId: '', fingerprintKey: key }), /first-turn history unqualified/u);
  assert.throws(() => qualify(page({ ...turn(), extra: 'x'.repeat(1024 * 1024 + 1) })),
    /first-turn history unqualified/u);
});
