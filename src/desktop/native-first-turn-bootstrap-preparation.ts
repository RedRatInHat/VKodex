import type { NativeCliTurnStartScope } from '../codex/native-cli-turn-start.js';
import type { WorkerCommand } from '../codex/managed-worker-command-dispatcher.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapIdentity } from
  './native-first-turn-bootstrap-journal.js';
import { prepareNativeFirstTurnBootstrapCommand } from './native-first-turn-input-fingerprint.js';
import { loadNativeFirstTurnPrivateKey } from './native-first-turn-private-key.js';

const fail = (): never => { throw new Error('Native first-turn reservation unqualified'); };
export interface NativeFirstTurnPreparedReservation {
  readonly command: WorkerCommand;
  readonly operationId: string;
  readonly revision: 3;
  readonly keyedFingerprint: string;
}

/** Testable zero-RPC phase: the caller supplies the already loaded key. This
 * reserves exactly one first turn after a separately durable thread/start ACK.
 * Source, owner and queue are not proven here and must be checked by the
 * dispatcher immediately before its one and only native write. */
export function reserveNativeFirstTurnWithKey(journal: NativeFirstTurnBootstrapJournal,
  identity: NativeFirstTurnBootstrapIdentity, nativeParams: unknown,
  cliScope: NativeCliTurnStartScope, key: Uint8Array): NativeFirstTurnPreparedReservation {
  if (!journal || typeof journal.get !== 'function' ||
      typeof journal.reserveFirstTurn !== 'function' || !identity) fail();
  const record = journal.get(identity.operationId);
  if (!record || record.state !== 'thread-accepted' || record.revision !== 2 ||
      !record.threadId || record.operationId !== identity.operationId ||
      record.sourceId !== identity.sourceId ||
      record.sourceGeneration !== identity.sourceGeneration ||
      record.ownerEpoch !== identity.ownerEpoch ||
      record.threadStartFingerprint !== identity.threadStartFingerprint ||
      record.backendIdentity !== identity.backendIdentity ||
      cliScope.taskId !== record.threadId || cliScope.ownerEpoch !== record.ownerEpoch) return fail();
  const compiled = prepareNativeFirstTurnBootstrapCommand(nativeParams, cliScope, {
    ...identity, threadId: record.threadId,
    clientUserMessageId: (nativeParams as { clientUserMessageId?: unknown } | null)
      ?.clientUserMessageId as string, fingerprintKey: key,
  });
  const clientUserMessageId = compiled.command.params.clientUserMessageId;
  if (typeof clientUserMessageId !== 'string') return fail();
  journal.reserveFirstTurn({ operationId: identity.operationId, expectedRevision: 2,
    clientUserMessageId, keyedFingerprint: compiled.keyedFingerprint });
  return Object.freeze({ command: compiled.command, operationId: identity.operationId,
    revision: 3 as const, keyedFingerprint: compiled.keyedFingerprint });
}

/** Production zero-RPC phase: require an existing private key. No auto-create,
 * native request or replay is possible through this entrypoint. The returned
 * command stays in memory; the journal holds only its keyed text fingerprint. */
export async function prepareAndReserveNativeFirstTurn(journal: NativeFirstTurnBootstrapJournal,
  identity: NativeFirstTurnBootstrapIdentity,
  nativeParams: unknown, cliScope: NativeCliTurnStartScope): Promise<NativeFirstTurnPreparedReservation> {
  // The directory comes from this one-operation journal, never from a wire
  // request or an independent routing argument.
  const key = await loadNativeFirstTurnPrivateKey(journal.directory());
  try { return reserveNativeFirstTurnWithKey(journal, identity, nativeParams, cliScope, key); }
  finally { key.fill(0); }
}
