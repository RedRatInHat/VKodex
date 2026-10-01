import { createHmac } from 'node:crypto';
import { prepareNativeCliTurnStart, type NativeCliTurnStartScope } from
  '../codex/native-cli-turn-start.js';
import type { WorkerCommand } from '../codex/managed-worker-command-dispatcher.js';
import type { NativeFirstTurnBootstrapIdentity } from './native-first-turn-bootstrap-journal.js';

type Row = Record<string, unknown>;
export const NATIVE_FIRST_TURN_TEXT_MAX_BYTES = 8 * 1024;
export interface NativeFirstTurnInputScope extends NativeFirstTurnBootstrapIdentity {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  /** Durable private key supplied by the caller, never stored in the journal. */
  readonly fingerprintKey: Uint8Array;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEX = /^[a-f0-9]{64}$/u;
const row = (value: unknown): value is Row => value !== null &&
  typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: Row, expected: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
const identifier = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
const fail = (): never => { throw new Error('Native first-turn input unqualified'); };
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
function validScope(scope: NativeFirstTurnInputScope): void {
  if (!scope || !UUID.test(scope.operationId) || !identifier(scope.sourceId) ||
      !UUID.test(scope.sourceGeneration) || !UUID.test(scope.ownerEpoch) ||
      !HEX.test(scope.threadStartFingerprint) || !HEX.test(scope.backendIdentity) ||
      !UUID.test(scope.threadId) || !identifier(scope.clientUserMessageId) ||
      !(scope.fingerprintKey instanceof Uint8Array) ||
      scope.fingerprintKey.byteLength < 32 || scope.fingerprintKey.byteLength > 128) fail();
}
function textValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() ||
      Buffer.byteLength(value, 'utf8') > NATIVE_FIRST_TURN_TEXT_MAX_BYTES ||
      value.includes('\0')) fail();
  return value as string;
}
function digest(text: string, scope: NativeFirstTurnInputScope): string {
  validScope(scope);
  return createHmac('sha256', scope.fingerprintKey)
    .update(JSON.stringify(['vkodex-native-first-turn-input-v1', scope.operationId,
      scope.sourceId, scope.sourceGeneration, scope.ownerEpoch,
      scope.threadStartFingerprint, scope.backendIdentity, scope.threadId,
      scope.clientUserMessageId, text])).digest('hex');
}

/** Called only on the single text input of a separately policy-qualified
 * turn/start. The digest is reconcilable after a lost ACK without saving text. */
export function fingerprintNativeFirstTurnInput(input: unknown,
  scope: NativeFirstTurnInputScope): string {
  if (!Array.isArray(input) || input.length !== 1 || !row(input[0])) fail();
  const item = (input as unknown[])[0] as Row;
  if (item.type !== 'text' || !(keys(item, ['type', 'text']) ||
      keys(item, ['type', 'text', 'text_elements']) &&
        Array.isArray(item.text_elements) && item.text_elements.length === 0)) fail();
  return digest(textValue(item.text), scope);
}

/** Recomputes the same digest from the exact native full-history user item.
 * Alternate/multipart/edited wire forms stay unknown rather than guessing. */
export function fingerprintNativeFirstTurnUserItem(item: unknown,
  scope: NativeFirstTurnInputScope): string {
  if (!row(item) || !keys(item, ['id', 'type', 'clientId', 'content']) ||
      !identifier(item.id) || item.type !== 'userMessage' ||
      item.clientId !== scope.clientUserMessageId ||
      !Array.isArray(item.content) || item.content.length !== 1 ||
      !row(item.content[0])) fail();
  const content = ((item as Row).content as unknown[])[0] as Row;
  // The observed full-history projection adds an empty text_elements array
  // even when the outbound single-text request omitted it.
  if (!keys(content, ['type', 'text', 'text_elements']) ||
      content.type !== 'text' || !Array.isArray(content.text_elements) ||
      content.text_elements.length !== 0) fail();
  return digest(textValue(content.text), scope);
}

/** Compiles the complete read-only native command and its recoverable input
 * digest together. Call before durable reservation; never send a generic
 * 32 MiB-eligible CLI request through the narrower first-turn pilot. */
export function prepareNativeFirstTurnBootstrapCommand(params: unknown,
  cliScope: NativeCliTurnStartScope,
  fingerprintScope: NativeFirstTurnInputScope): Readonly<{
    command: WorkerCommand; keyedFingerprint: string;
  }> {
  const command = prepareNativeCliTurnStart(params, cliScope);
  if (command.params.threadId !== fingerprintScope.threadId ||
      command.params.clientUserMessageId !== fingerprintScope.clientUserMessageId ||
      cliScope.ownerEpoch !== fingerprintScope.ownerEpoch) fail();
  const keyedFingerprint = fingerprintNativeFirstTurnInput(command.params.input,
    fingerprintScope);
  return Object.freeze({ command: freezeTree(command), keyedFingerprint });
}
