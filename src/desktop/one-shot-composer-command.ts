import { isDeepStrictEqual } from 'node:util';
import type { WorkerCommand, WorkerCommandScope } from '../codex/managed-worker-command-dispatcher.js';
import type { NativeStartIntentStore } from '../codex/native-start-intent-store.js';

type Command = Readonly<WorkerCommandScope & WorkerCommand>;
type IntentReader = Pick<NativeStartIntentStore, 'get'>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A private one-shot worker must not accept an alternate dispatcher caller.
 * The native owner persists the exact encrypted intent before reserving the
 * command, so every permitted write must correspond to that first Composer
 * request in this owner epoch and backend generation. */
export function oneShotComposerCommandAuthorized(store: IntentReader | null, scope: Command): boolean {
  if (!store || scope.method !== 'turn/start') return false;
  try {
    const record = store.get(scope.operationId);
    if (!record || record.operationId !== scope.operationId ||
        record.clientUserMessageId !== scope.params.clientUserMessageId ||
        record.intent.uiParams === null ||
        !isDeepStrictEqual(record.intent.command, {
          operationId: scope.operationId, method: scope.method, params: scope.params })) return false;
    const admission = record.intent.admission;
    if (admission.ownerEpoch !== scope.ownerEpoch ||
        admission.backendGeneration !== scope.backendGeneration ||
        !object(admission.snapshot) || admission.snapshot.id !== scope.threadId ||
        !object(admission.composer) || !object(admission.composer.snapshot)) return false;
    const turns = admission.composer.snapshot.turns;
    return Array.isArray(turns) && turns.length === 0;
  } catch { return false; }
}

/** Ephemeral proof that the native owner completed the first qualification
 * phase. A persisted intent by itself is not a write capability. */
export class OneShotComposerCommandGate {
  #qualifiedOperationId: string | null = null;

  note(command: Readonly<WorkerCommand>, phase: 'before-reservation' | 'before-write', passed: boolean): void {
    if (phase === 'before-write' || !passed) {
      if (this.#qualifiedOperationId === command.operationId) this.#qualifiedOperationId = null;
      return;
    }
    if (this.#qualifiedOperationId !== null && this.#qualifiedOperationId !== command.operationId)
      throw new Error('One-shot Composer qualification already active');
    this.#qualifiedOperationId = command.operationId;
  }

  settle(command: Readonly<WorkerCommand>): void {
    if (this.#qualifiedOperationId === command.operationId) this.#qualifiedOperationId = null;
  }

  authorize(store: IntentReader | null, scope: Command): boolean {
    return this.#qualifiedOperationId === scope.operationId &&
      oneShotComposerCommandAuthorized(store, scope);
  }
}
