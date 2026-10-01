import { createHmac } from 'node:crypto';

type JsonObject = Record<string, unknown>;
export interface NativeFirstTurnHistoryScope {
  readonly threadId: string;
  readonly turnId: string;
  readonly clientUserMessageId: string;
  /** Protected, caller-owned key; never saved with the digest. */
  readonly fingerprintKey: Uint8Array;
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

/** Classify only the initial, tool-free read-only canary subset. This is one
 * history witness, not proof of a durable rollout, idle queue, source or owner.
 * Those must be checked separately on a fresh connection before cutover. */
export function qualifyNativeFirstTurnHistory(page: unknown,
  scope: NativeFirstTurnHistoryScope): NativeFirstTurnHistoryEvidence {
  if (!scope || !identifier(scope.threadId) || !identifier(scope.turnId) ||
      !identifier(scope.clientUserMessageId) ||
      !(scope.fingerprintKey instanceof Uint8Array) ||
      scope.fingerprintKey.byteLength < 32 || scope.fingerprintKey.byteLength > 128) return fail();
  if (!object(page)) return fail();
  if (!exactKeys(page, ['data', 'nextCursor']) || page.nextCursor !== null) return fail();
  if (!Array.isArray(page.data) || page.data.length !== 1) return fail();
  strictJson(page);
  const encoded = JSON.stringify(page);
  if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) fail();
  const turn = page.data[0];
  if (!object(turn) || turn.id !== scope.turnId || turn.status !== 'completed' ||
      turn.itemsView !== 'full' || !Array.isArray(turn.items)) fail();
  let userCount = 0, assistantCount = 0;
  for (const item of turn.items) {
    if (!object(item) || !identifier(item.id) || typeof item.type !== 'string') fail();
    switch (item.type) {
      case 'userMessage':
        if (!exactKeys(item, ['id', 'type', 'clientId', 'content']) ||
            item.clientId !== scope.clientUserMessageId || !Array.isArray(item.content)) fail();
        userCount++;
        break;
      case 'agentMessage':
        if (!exactKeys(item, ['id', 'type', 'text']) ||
            typeof item.text !== 'string' || !item.text.trim()) fail();
        assistantCount++;
        break;
      case 'reasoning':
        if (!exactKeys(item, ['id', 'type', 'summary']) || !Array.isArray(item.summary)) fail();
        break;
      case 'plan':
        if (!exactKeys(item, ['id', 'type', 'steps']) || !Array.isArray(item.steps)) fail();
        break;
      default: fail();
    }
  }
  if (userCount !== 1 || assistantCount < 1) fail();
  const digest = createHmac('sha256', scope.fingerprintKey)
    .update('vkodex-native-first-turn-history-v1\0')
    .update(JSON.stringify([scope.threadId, scope.turnId, scope.clientUserMessageId]))
    .update('\0').update(encoded).digest('hex');
  return Object.freeze({ threadId: scope.threadId, turnId: scope.turnId,
    clientUserMessageId: scope.clientUserMessageId, historyHmac: digest });
}
