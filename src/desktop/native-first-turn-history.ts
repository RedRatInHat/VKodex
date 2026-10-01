import { createHmac, timingSafeEqual } from 'node:crypto';
import { fingerprintNativeFirstTurnUserItem, type NativeFirstTurnInputScope } from
  './native-first-turn-input-fingerprint.js';

type JsonObject = Record<string, unknown>;
export interface NativeFirstTurnHistoryScope extends NativeFirstTurnInputScope {
  readonly turnId: string;
  /** The durable keyedFingerprint from the one-shot bootstrap journal. */
  readonly expectedInputFingerprint: string;
}
export type NativeFirstTurnUnknownHistoryScope = Omit<NativeFirstTurnHistoryScope, 'turnId'>;
export interface NativeFirstTurnHistoryReader {
  initializedSession(): Promise<{ readonly generation: number }>;
  isSessionCurrent(generation: number): boolean;
  request(method: string, params: Record<string, unknown>, options?: Readonly<{
    expectedGeneration?: number; timeoutMs?: number;
  }>): Promise<unknown>;
}
export interface NativeFirstTurnHistoryEvidence {
  readonly threadId: string;
  readonly turnId: string;
  readonly clientUserMessageId: string;
  /** A keyed digest of the complete native page, including message content. */
  readonly historyHmac: string;
}

const fail = (): never => { throw new Error('Native first-turn history unqualified'); };
const identifier = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
const cursor = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const object = (value: unknown): value is JsonObject => value !== null &&
  typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: JsonObject, expected: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));

function strictJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) return fail();
  if (depth > 32 || seen.has(value)) return fail();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1 ||
          Object.keys(value).length !== value.length ||
          Array.from({ length: value.length }, (_, index) => !Object.hasOwn(value, index)).some(Boolean)) fail();
      for (const entry of value) strictJson(entry, seen, depth + 1);
    } else {
      if (!object(value)) return fail();
      if (Reflect.ownKeys(value).length !== Object.keys(value).length ||
          Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) return fail();
      for (const entry of Object.values(value)) strictJson(entry, seen, depth + 1);
    }
  } finally { seen.delete(value); }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}

/** Classify only the initial, tool-free read-only canary subset. This is one
 * history witness, not proof of a durable rollout, idle queue, source or owner.
 * Those must be checked separately on a fresh connection before cutover. */
function qualifyNativeFirstTurnHistory(page: unknown,
  scope: NativeFirstTurnHistoryScope): NativeFirstTurnHistoryEvidence {
  if (!scope || !identifier(scope.threadId) || !identifier(scope.turnId) ||
      !identifier(scope.clientUserMessageId) ||
      !/^[a-f0-9]{64}$/u.test(scope.expectedInputFingerprint) ||
      !(scope.fingerprintKey instanceof Uint8Array) ||
      scope.fingerprintKey.byteLength < 32 || scope.fingerprintKey.byteLength > 128) return fail();
  if (!object(page)) return fail();
  // Native CLI 0.155.1 includes backwardsCursor even for a one-turn page;
  // it is an opaque page anchor, not evidence of an earlier turn. The reader
  // below issues the first ascending full page itself, with no cursor.
  if (!exactKeys(page, ['backwardsCursor', 'data', 'nextCursor']) ||
      page.nextCursor !== null ||
      page.backwardsCursor !== null && !cursor(page.backwardsCursor)) return fail();
  if (!Array.isArray(page.data) || page.data.length !== 1) return fail();
  strictJson(page);
  const encoded = JSON.stringify(page);
  if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) fail();
  const turn = page.data[0];
  if (!object(turn) || !exactKeys(turn, ['id', 'startedAt', 'completedAt',
    'durationMs', 'status', 'error', 'itemsView', 'items']) ||
      turn.id !== scope.turnId || turn.status !== 'completed' ||
      turn.itemsView !== 'full' || !Array.isArray(turn.items) ||
      turn.startedAt !== null &&
        !(typeof turn.startedAt === 'number' && Number.isFinite(turn.startedAt)) ||
      typeof turn.completedAt !== 'number' || !Number.isFinite(turn.completedAt) ||
      typeof turn.durationMs !== 'number' || !Number.isFinite(turn.durationMs) ||
      turn.durationMs < 0 || turn.error !== null) fail();
  let userCount = 0, assistantCount = 0;
  let userItem: JsonObject | null = null;
  const itemIds = new Set<string>();
  for (const item of turn.items) {
    if (!object(item) || !identifier(item.id) || typeof item.type !== 'string' ||
        itemIds.has(item.id)) fail();
    itemIds.add(item.id as string);
    switch (item.type) {
      case 'userMessage':
        if (!exactKeys(item, ['id', 'type', 'clientId', 'content']) ||
            item.clientId !== scope.clientUserMessageId || !Array.isArray(item.content)) fail();
        userCount++;
        userItem = item;
        break;
      case 'agentMessage':
        // The observed 0.155.1 one-turn full-history response has four null
        // auxiliary fields. A changed final-message shape needs a new canary,
        // not a permissive default that could accept an interactive question.
        if (!exactKeys(item, ['id', 'type', 'text', 'delivery', 'memoryCitation',
          'phase', 'questions']) ||
            typeof item.text !== 'string' || !item.text.trim() ||
            item.delivery !== null || item.memoryCitation !== null ||
            item.phase !== null || item.questions !== null) fail();
        assistantCount++;
        break;
      case 'reasoning':
        if (!exactKeys(item, ['id', 'type', 'summary', 'content']) ||
            !Array.isArray(item.summary) || !Array.isArray(item.content)) fail();
        break;
      case 'plan':
        if (!exactKeys(item, ['id', 'type', 'steps']) || !Array.isArray(item.steps)) fail();
        break;
      default: fail();
    }
  }
  if (userCount !== 1 || assistantCount < 1 || !userItem) fail();
  const actualInputFingerprint = (() => {
    try { return fingerprintNativeFirstTurnUserItem(userItem, scope); }
    catch { return fail(); }
  })();
  if (!timingSafeEqual(Buffer.from(actualInputFingerprint, 'hex'),
    Buffer.from(scope.expectedInputFingerprint, 'hex'))) fail();
  const digest = createHmac('sha256', scope.fingerprintKey)
    .update('vkodex-native-first-turn-history-v1\0')
    .update(JSON.stringify([scope.threadId, scope.turnId, scope.clientUserMessageId]))
    .update('\0').update(JSON.stringify(canonical(turn))).digest('hex');
  return Object.freeze({ threadId: scope.threadId, turnId: scope.turnId,
    clientUserMessageId: scope.clientUserMessageId, historyHmac: digest });
}


/** Request the first ascending full native page ourselves, pinned to one
 * initialized backend generation. This still proves only history content;
 * source, owner, queue and post-read idle state require separate checks. */
async function readNativeFirstTurnPage(rpc: NativeFirstTurnHistoryReader,
  threadId: string): Promise<unknown> {
  if (!rpc || typeof rpc.initializedSession !== 'function' ||
      typeof rpc.isSessionCurrent !== 'function' || typeof rpc.request !== 'function' ||
      !identifier(threadId)) fail();
  const session = await rpc.initializedSession();
  if (!Number.isSafeInteger(session.generation) || session.generation < 1 ||
      !rpc.isSessionCurrent(session.generation)) fail();
  const page = await rpc.request('thread/turns/list', { threadId,
    limit: 2, sortDirection: 'asc', itemsView: 'full' },
  { expectedGeneration: session.generation, timeoutMs: 30_000 });
  if (!rpc.isSessionCurrent(session.generation)) fail();
  return page;
}

export async function readAndQualifyNativeFirstTurnHistory(rpc: NativeFirstTurnHistoryReader,
  scope: NativeFirstTurnHistoryScope): Promise<NativeFirstTurnHistoryEvidence> {
  if (!scope || !identifier(scope.threadId) || !identifier(scope.turnId) ||
      !identifier(scope.clientUserMessageId) ||
      !/^[a-f0-9]{64}$/u.test(scope.expectedInputFingerprint) ||
      !(scope.fingerprintKey instanceof Uint8Array) ||
      scope.fingerprintKey.byteLength < 32 || scope.fingerprintKey.byteLength > 128) fail();
  return qualifyNativeFirstTurnHistory(await readNativeFirstTurnPage(rpc, scope.threadId), scope);
}

/** Resolve an unknown ACK from one exact persisted first turn. This is only
 * read-only outcome evidence, not source/owner/queue admission or a retry. */
export async function readAndQualifyUnknownNativeFirstTurnHistory(rpc: NativeFirstTurnHistoryReader,
  scope: NativeFirstTurnUnknownHistoryScope): Promise<NativeFirstTurnHistoryEvidence> {
  if (!scope || !identifier(scope.threadId) ||
      !identifier(scope.clientUserMessageId) ||
      !/^[a-f0-9]{64}$/u.test(scope.expectedInputFingerprint) ||
      !(scope.fingerprintKey instanceof Uint8Array) ||
      scope.fingerprintKey.byteLength < 32 || scope.fingerprintKey.byteLength > 128) fail();
  const page = await readNativeFirstTurnPage(rpc, scope.threadId);
  if (!object(page) || !Array.isArray(page.data) || page.data.length !== 1) return fail();
  const turn = page.data[0];
  if (!object(turn) || !identifier(turn.id)) return fail();
  return qualifyNativeFirstTurnHistory(page, { ...scope, turnId: turn.id });
}
