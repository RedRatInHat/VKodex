import path from 'node:path';
import { pinnedDetachedProfileBackendHome, pinnedDetachedProfileBackendIdentity,
  type PinnedDetachedProfileRpc } from '../codex/detached-profile-capability.js';
import { assertAuthenticatedProfileSourcePreflightForWrite,
  assertAuthenticatedProfileSourceReceiptForWrite,
  type AuthenticatedProfileSourcePreflight } from './controlled-native-source-proof.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapRecord } from
  './native-first-turn-bootstrap-journal.js';
import { readAndQualifyFreshFirstTurnIdleState } from './native-first-turn-idle-state.js';

const fail = (): never => { throw new Error('Native first-turn candidate unqualified'); };

/** Read-only evidence for a single accepted, still empty native thread.
 * This is deliberately not a writer lease, dispatch token or proof that other
 * Desktop/VS Code/CLI clients cannot start a turn after the final read. */
export interface NativeFirstTurnCandidateObservation {
  readonly operationId: string;
  readonly threadId: string;
  readonly backendGeneration: number;
  readonly journalRevision: 2;
  readonly idleAndEmpty: true;
}

export async function observeNativeFirstTurnCandidate(journal: NativeFirstTurnBootstrapJournal,
  operationId: string, rpc: PinnedDetachedProfileRpc,
  preflight: AuthenticatedProfileSourcePreflight): Promise<NativeFirstTurnCandidateObservation> {
  if (!(journal instanceof NativeFirstTurnBootstrapJournal) || !rpc || !preflight) fail();
  const initial = journal.get(operationId);
  if (!initial || initial.state !== 'thread-accepted' || initial.revision !== 2 ||
      !initial.threadId || journal.getThreadStartFenceStatus(operationId) !== 'passed') fail();
  const record = initial as NativeFirstTurnBootstrapRecord & { threadId: string };
  const session = await rpc.initializedSession();
  const generation = session.generation;
  const sourceIdentity = { operationId: record.operationId, sourceId: record.sourceId,
    sourceGeneration: record.sourceGeneration };
  const receiptPath = path.join(journal.directory(), 'source-preflight.json');
  const current = (): void => {
    if (pinnedDetachedProfileBackendIdentity(rpc, generation) !== record.backendIdentity) fail();
    const home = pinnedDetachedProfileBackendHome(rpc, generation);
    assertAuthenticatedProfileSourcePreflightForWrite(preflight, sourceIdentity,
      home, preflight.workspace);
    assertAuthenticatedProfileSourceReceiptForWrite(receiptPath, preflight);
    const now = journal.get(operationId);
    if (!now || now.state !== 'thread-accepted' || now.revision !== 2 ||
        now.threadId !== record.threadId || now.sourceId !== record.sourceId ||
        now.sourceGeneration !== record.sourceGeneration || now.ownerEpoch !== record.ownerEpoch ||
        now.backendIdentity !== record.backendIdentity ||
        now.threadStartFingerprint !== record.threadStartFingerprint ||
        journal.getThreadStartFenceStatus(operationId) !== 'passed') fail();
  };
  current();
  const observation = await readAndQualifyFreshFirstTurnIdleState(rpc, record.threadId, current);
  current();
  if (observation.backendGeneration !== generation) fail();
  return Object.freeze({ operationId, threadId: record.threadId,
    backendGeneration: generation, journalRevision: 2 as const, idleAndEmpty: true as const });
}
