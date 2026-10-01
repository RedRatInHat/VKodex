import { pinnedDetachedProfileBackendIdentity,
  type PinnedDetachedProfileRpc } from '../codex/detached-profile-capability.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapRecord } from
  './native-first-turn-bootstrap-journal.js';
import { readAndQualifyUnknownNativeFirstTurnHistory,
  type NativeFirstTurnHistoryEvidence } from './native-first-turn-history.js';
import { loadNativeFirstTurnPrivateKey } from './native-first-turn-private-key.js';

const fail = (): never => { throw new Error('Native first-turn unknown outcome unqualified'); };
const unsettled = (record: NativeFirstTurnBootstrapRecord): boolean =>
  record.state === 'turn-reserved' || record.state === 'turn-unknown';
const sameIntent = (a: NativeFirstTurnBootstrapRecord,
  b: NativeFirstTurnBootstrapRecord): boolean =>
  a.operationId === b.operationId && a.sourceId === b.sourceId &&
  a.sourceGeneration === b.sourceGeneration && a.ownerEpoch === b.ownerEpoch &&
  a.threadStartFingerprint === b.threadStartFingerprint &&
  a.backendIdentity === b.backendIdentity && a.threadId === b.threadId &&
  a.clientUserMessageId === b.clientUserMessageId &&
  a.keyedFingerprint === b.keyedFingerprint;

/** Read-only lost-ACK recovery for a previously reserved first turn. A fresh
 * exact completed history can confirm acceptance, but an absent/nonterminal
 * turn leaves the durable unknown state untouched and never sends a request.
 * This does not grant owner, source or queue authority for a new write. */
export async function reconcileUnknownNativeFirstTurnFromPinnedHistory(
  journal: NativeFirstTurnBootstrapJournal, operationId: string,
  rpc: PinnedDetachedProfileRpc): Promise<NativeFirstTurnHistoryEvidence> {
  if (!(journal instanceof NativeFirstTurnBootstrapJournal) || !rpc) return fail();
  const before = journal.get(operationId);
  if (!before || !unsettled(before) || !before.threadId ||
      !before.clientUserMessageId || !before.keyedFingerprint) return fail();
  const session = await rpc.initializedSession();
  const generation = session.generation;
  if (pinnedDetachedProfileBackendIdentity(rpc, generation) !== before.backendIdentity) return fail();
  const key = await loadNativeFirstTurnPrivateKey(journal.directory());
  try {
    if (pinnedDetachedProfileBackendIdentity(rpc, generation) !== before.backendIdentity) return fail();
    const evidence = await readAndQualifyUnknownNativeFirstTurnHistory({
      initializedSession: async () => ({ generation }),
      isSessionCurrent: candidate => candidate === generation && rpc.isSessionCurrent(candidate),
      request: (method, params, options) => rpc.request(method, params, options),
    }, { operationId: before.operationId, sourceId: before.sourceId,
      sourceGeneration: before.sourceGeneration, ownerEpoch: before.ownerEpoch,
      threadStartFingerprint: before.threadStartFingerprint,
      backendIdentity: before.backendIdentity, threadId: before.threadId,
      clientUserMessageId: before.clientUserMessageId,
      expectedInputFingerprint: before.keyedFingerprint, fingerprintKey: key });
    if (pinnedDetachedProfileBackendIdentity(rpc, generation) !== before.backendIdentity) return fail();
    const current = journal.get(operationId);
    if (!current || !sameIntent(before, current)) return fail();
    if (unsettled(current)) {
      try { journal.markFirstTurnAccepted({ operationId, expectedRevision: current.revision,
        turnId: evidence.turnId }); }
      catch { /* A matching late positive ACK may have won the journal CAS. */ }
    }
    else if (current.state !== 'turn-accepted' || current.turnId !== evidence.turnId) return fail();
    const final = journal.get(operationId);
    if (!final || final.state !== 'turn-accepted' || !sameIntent(before, final) ||
        final.turnId !== evidence.turnId) return fail();
    return evidence;
  } finally { key.fill(0); }
}
