import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { HomogeneousQueueSettings } from './homogeneous-queue-policy.js';
import type { WorkerCommand } from './managed-worker-command-dispatcher.js';

type JsonObject = Record<string, unknown>;
export interface NativeCliTurnStartScope {
  readonly taskId: string;
  readonly ownerEpoch: string;
  /** Same-worker, source-qualified effective settings. Never derived from the CLI frame. */
  readonly effectiveSettings: HomogeneousQueueSettings;
}

const profileKeys = [
  'threadId', 'clientUserMessageId', 'input', 'turnTrigger', 'toolOutput',
  'responsesapiClientMetadata', 'additionalContext', 'environments', 'cwd',
  'runtimeWorkspaceRoots', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy',
  'permissions', 'model', 'serviceTier', 'serviceTierForTurn', 'effort', 'summary',
  'personality', 'outputSchema', 'collaborationMode', 'multiAgentMode',
  'cyberAccessProgram',
] as const;
const nullKeys = [
  'turnTrigger', 'toolOutput', 'responsesapiClientMetadata', 'additionalContext',
  'environments', 'sandboxPolicy', 'serviceTierForTurn', 'outputSchema',
  'multiAgentMode', 'cyberAccessProgram',
] as const;
const comparableKeys = [
  'cwd', 'runtimeWorkspaceRoots', 'approvalPolicy', 'approvalsReviewer',
  'permissions', 'model', 'serviceTier', 'effort', 'summary',
  'personality', 'collaborationMode',
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (value: unknown): value is JsonObject => value !== null &&
  typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function strictJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || depth > 32 || seen.has(value)) throw new TypeError('Invalid CLI start JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1 ||
          Object.keys(value).length !== value.length ||
          Array.from({ length: value.length }, (_, index) => !Object.hasOwn(value, index)).some(Boolean))
        throw new TypeError('Invalid CLI start array');
      for (const entry of value) strictJson(entry, seen, depth + 1);
    } else {
      if (!object(value) || Reflect.ownKeys(value).length !== Object.keys(value).length ||
          Object.keys(value).some(key => ['__proto__', 'prototype', 'constructor'].includes(key)))
        throw new TypeError('Invalid CLI start object');
      for (const entry of Object.values(value)) strictJson(entry, seen, depth + 1);
    }
  } finally { seen.delete(value); }
}

/** Compile only the observed plain-text, read-only CLI 0.155.1 subset.
 * This is preparation, not ownership or admission: the caller must fence the
 * queue, owner epoch and backend generation again before the durable write. */
export function prepareNativeCliTurnStart(params: unknown,
  scope: NativeCliTurnStartScope): WorkerCommand {
  if (!object(params) || !object(scope) ||
      !uuid.test(scope.ownerEpoch) ||
      typeof scope.taskId !== 'string' || !scope.taskId ||
      Object.keys(params).length !== profileKeys.length ||
      profileKeys.some(key => !Object.hasOwn(params, key)) ||
      Object.keys(params).some(key => !profileKeys.includes(key as typeof profileKeys[number])))
    throw new TypeError('Unsupported native CLI start shape');
  strictJson(params);
  const encoded = JSON.stringify(params);
  if (Buffer.byteLength(encoded) > 32 * 1024 * 1024 ||
      params.threadId !== scope.taskId ||
      typeof params.clientUserMessageId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(params.clientUserMessageId) ||
      !Array.isArray(params.input) || params.input.length !== 1 ||
      !object(params.input[0]) || params.input[0].type !== 'text' ||
      typeof params.input[0].text !== 'string' || !params.input[0].text.trim() ||
      Object.keys(params.input[0]).some(key => !['type', 'text', 'text_elements'].includes(key)) ||
      (params.input[0].text_elements !== undefined &&
        (!Array.isArray(params.input[0].text_elements) || params.input[0].text_elements.length !== 0)) ||
      nullKeys.some(key => params[key] !== null))
    throw new TypeError('Unsupported native CLI start context');
  const effective = scope.effectiveSettings;
  if (!object(effective) || effective.permissions !== ':read-only' ||
      effective.approvalPolicy !== 'never' ||
      !object(effective.sandboxPolicy) || effective.sandboxPolicy.type !== 'readOnly' ||
      effective.sandboxPolicy.networkAccess !== false ||
      typeof effective.model !== 'string' || !effective.model ||
      typeof effective.cwd !== 'string' || !effective.cwd ||
      !Array.isArray(effective.runtimeWorkspaceRoots) ||
      effective.runtimeWorkspaceRoots.length !== 1 ||
      comparableKeys.some(key => !isDeepStrictEqual(params[key], effective[key])))
    throw new TypeError('Native CLI start differs from effective worker settings');
  const bytes = createHash('sha256').update('vkodex-native-cli-start-v1\0')
    .update(JSON.stringify([scope.ownerEpoch, scope.taskId, params.clientUserMessageId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { operationId, method: 'turn/start', params: JSON.parse(encoded) as JsonObject };
}
