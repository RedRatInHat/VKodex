import type { NativeCliTurnStartScope } from '../codex/native-cli-turn-start.js';
import type { WorkerCommand } from '../codex/managed-worker-command-dispatcher.js';
import type { PinnedDetachedProfileRpc } from '../codex/detached-profile-capability.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapIdentity,
  type NativeFirstTurnIngressLeaseScope } from
  './native-first-turn-bootstrap-journal.js';
import { prepareNativeFirstTurnBootstrapCommand } from './native-first-turn-input-fingerprint.js';
import { loadNativeFirstTurnPrivateKey } from './native-first-turn-private-key.js';

const fail = (): never => { throw new Error('Native first-turn reservation unqualified'); };
const issued = new WeakSet<object>();
const productionIssued = new WeakMap<object, Readonly<{
  journal: NativeFirstTurnBootstrapJournal;
  ingressScope: NativeFirstTurnIngressLeaseScope;
  rpc: PinnedDetachedProfileRpc;
}>>();
export interface NativeFirstTurnPreparedReservation {
  readonly command: WorkerCommand;
  readonly operationId: string;
  readonly revision: 3;
  readonly keyedFingerprint: string;
}

/** Retires only the in-process preparation token; never sends a native RPC. */
export function consumeNativeFirstTurnReservation(prepared: NativeFirstTurnPreparedReservation): boolean {
  return !!prepared && issued.delete(prepared);
}

/** Only the private-key preparation path can give the production dispatcher
 * the exact journal and opaque ingress object. A scalar copy or offline test
 * preparation cannot become native write authority. Consumption is one-shot. */
export function consumeProductionNativeFirstTurnReservation(prepared: NativeFirstTurnPreparedReservation):
  Readonly<{ journal: NativeFirstTurnBootstrapJournal; ingressScope: NativeFirstTurnIngressLeaseScope;
    rpc: PinnedDetachedProfileRpc }> | null {
  const authority = prepared && productionIssued.get(prepared);
  if (!authority || !issued.delete(prepared)) return null;
  productionIssued.delete(prepared);
  return authority;
}

/** Testable zero-RPC phase: the caller supplies the already loaded key. This
 * reserves exactly one first turn after a separately durable thread/start ACK.
 * Source, owner and queue are not proven here and must be checked by the
 * dispatcher immediately before its one and only native write. */
export function reserveNativeFirstTurnWithKey(journal: NativeFirstTurnBootstrapJournal,
  identity: NativeFirstTurnBootstrapIdentity, nativeParams: unknown,
  cliScope: NativeCliTurnStartScope, key: Uint8Array,
  ingressScope?: NativeFirstTurnIngressLeaseScope): NativeFirstTurnPreparedReservation {
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
  if (ingressScope) journal.reserveFirstTurnWithIngressLease(ingressScope,
    { clientUserMessageId, keyedFingerprint: compiled.keyedFingerprint });
  else journal.reserveFirstTurn({ operationId: identity.operationId, expectedRevision: 2,
    clientUserMessageId, keyedFingerprint: compiled.keyedFingerprint });
  const prepared = Object.freeze({ command: compiled.command, operationId: identity.operationId,
    revision: 3 as const, keyedFingerprint: compiled.keyedFingerprint });
  issued.add(prepared);
  return prepared;
}

/** Production zero-RPC phase: require an existing private key and a current,
 * opaque ingress scope. No auto-create, native request or replay is possible
 * here. The command stays in memory; the journal holds only its keyed digest. */
export async function prepareAndReserveNativeFirstTurn(journal: NativeFirstTurnBootstrapJournal,
  identity: NativeFirstTurnBootstrapIdentity,
  nativeParams: unknown, cliScope: NativeCliTurnStartScope,
  ingressScope: NativeFirstTurnIngressLeaseScope,
  rpc: PinnedDetachedProfileRpc): Promise<NativeFirstTurnPreparedReservation> {
  journal.assertFirstTurnIngressRpc(ingressScope, rpc);
  // The directory comes from this one-operation journal, never from a wire
  // request or an independent routing argument.
  const key = await loadNativeFirstTurnPrivateKey(journal.directory());
  try {
    const prepared = reserveNativeFirstTurnWithKey(journal, identity, nativeParams, cliScope, key, ingressScope);
    productionIssued.set(prepared, { journal, ingressScope, rpc });
    return prepared;
  }
  finally { key.fill(0); }
}
