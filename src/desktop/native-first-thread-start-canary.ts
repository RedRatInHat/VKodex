import type { AppServerResponseEnvelope } from '../codex/app-server-connection.js';
import { pinnedDetachedProfileBackendIdentity } from
  '../codex/detached-profile-capability.js';
import { projectControlledNativeStartPolicy } from './controlled-native-task-creator.js';
import { assertAuthenticatedProfileSourcePreflightForWrite,
  assertAuthenticatedProfileSourceReceiptForWrite } from
  './controlled-native-source-proof.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapRecord,
  type NativeFirstThreadStartFenceStatus } from
  './native-first-turn-bootstrap-journal.js';
import { consumeProductionPreparedNativeFirstThreadStart,
  type NativeFirstThreadStartPrepared } from './native-first-turn-thread-start.js';

const fail = (): never => { throw new Error('Native first thread/start canary unqualified'); };
export type NativeFirstThreadStartCanaryOutcome = Readonly<{
  kind: 'accepted' | 'uncertain';
  /** Phase-only diagnostic. Even a native error does not authorize retry. */
  diagnostic: 'accepted' | 'prewrite-refused' | 'native-error' |
    'unqualified-response' | 'transport-or-no-ack';
  writeFence: NativeFirstThreadStartFenceStatus;
  record: NativeFirstTurnBootstrapRecord;
}>;

/** One native thread/start attempt for an isolated, as-yet-unadvertised task.
 * This is not a general worker route or a grant to start a model turn. The
 * production-pinned backend, v3 physical source and one-operation durable
 * reservation are all checked again at the actual native socket write.
 * A lost ACK leaves the intent reserved; this function never retries it. */
export async function dispatchPreparedNativeFirstThreadStartCanary(
  journal: NativeFirstTurnBootstrapJournal,
  prepared: NativeFirstThreadStartPrepared): Promise<NativeFirstThreadStartCanaryOutcome> {
  const authority = consumeProductionPreparedNativeFirstThreadStart(prepared);
  if (!authority || journal !== authority.journal ||
      !(journal instanceof NativeFirstTurnBootstrapJournal)) return fail();
  const { rpc, preflight, preflightReceiptPath, backendGeneration, sourceHome, workspace } = authority;
  const identity = prepared.identity;
  const sourceIdentity = { operationId: identity.operationId, sourceId: identity.sourceId,
    sourceGeneration: identity.sourceGeneration };
  const exactReservation = (): void => {
    const current = journal.get(identity.operationId);
    if (!current || current.state !== 'thread-reserved' || current.revision !== 1 ||
        current.operationId !== identity.operationId ||
        current.sourceId !== identity.sourceId ||
        current.sourceGeneration !== identity.sourceGeneration ||
        current.ownerEpoch !== identity.ownerEpoch ||
        current.backendIdentity !== identity.backendIdentity ||
        current.threadStartFingerprint !== identity.threadStartFingerprint) fail();
  };
  const current = (): void => {
    if (pinnedDetachedProfileBackendIdentity(rpc, backendGeneration) !== identity.backendIdentity)
      fail();
    assertAuthenticatedProfileSourcePreflightForWrite(preflight, sourceIdentity,
      sourceHome, workspace);
    assertAuthenticatedProfileSourceReceiptForWrite(preflightReceiptPath, preflight);
    exactReservation();
  };
  const journalPath = journal.filePath();
  let diagnostic: NativeFirstThreadStartCanaryOutcome['diagnostic'] = 'transport-or-no-ack';
  const positiveAck = (envelope: AppServerResponseEnvelope): void => {
    if (!('result' in envelope)) { diagnostic = 'native-error'; return; }
    let threadId: string;
    try { threadId = projectControlledNativeStartPolicy(envelope.result,
      prepared.requestedPolicy).threadId; }
    catch { diagnostic = 'unqualified-response'; return; }
    try {
      // Late native replies can outlive the initiating journal handle. Never
      // submit a replacement thread/start to resolve a timeout.
      const reopened = new NativeFirstTurnBootstrapJournal(journalPath);
      try {
        if (reopened.getThreadStartFenceStatus(identity.operationId) !== 'passed') return;
        const record = reopened.get(identity.operationId);
        if (record?.state === 'thread-reserved' && record.revision === 1 &&
            record.sourceId === identity.sourceId &&
            record.sourceGeneration === identity.sourceGeneration &&
            record.ownerEpoch === identity.ownerEpoch &&
            record.backendIdentity === identity.backendIdentity &&
            record.threadStartFingerprint === identity.threadStartFingerprint)
          reopened.persistThreadAccepted({ operationId: identity.operationId,
            expectedRevision: 1, threadId });
      } finally { reopened.close(); }
    } catch { /* No positive receipt: preserve the uncertain reservation. */ }
  };
  try {
    const session = await rpc.initializedSession();
    if (session.generation !== backendGeneration) fail();
    current();
    await rpc.request('thread/start', structuredClone(prepared.params), {
      mutating: true, expectedGeneration: backendGeneration,
      assertBeforeWrite: () => { current(); journal.markThreadStartWriteFencePassed(identity.operationId); },
      onBeforeWriteRefused: () => { diagnostic = 'prewrite-refused'; },
      onResponseEnvelope: positiveAck, onLateResponseEnvelope: positiveAck,
    });
  } catch { /* A refusal, timeout or lost ACK never authorizes another write. */ }
  const settled = new NativeFirstTurnBootstrapJournal(journalPath);
  try {
    const result = settled.get(identity.operationId);
    if (!result || result.state !== 'thread-reserved' && result.state !== 'thread-accepted')
      return fail();
    const writeFence = settled.getThreadStartFenceStatus(identity.operationId);
    return Object.freeze({ kind: result.state === 'thread-accepted' ? 'accepted' : 'uncertain',
      diagnostic: result.state === 'thread-accepted' ? 'accepted' : diagnostic,
      writeFence, record: result });
  } finally { settled.close(); }
}
