import type { AppServerResponseEnvelope } from '../../src/codex/app-server-connection.js';
import { projectControlledNativeStartPolicy } from '../../src/desktop/controlled-native-task-creator.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapRecord } from
  '../../src/desktop/native-first-turn-bootstrap-journal.js';
import { consumePreparedNativeFirstThreadStart, type NativeFirstThreadStartPrepared } from
  '../../src/desktop/native-first-turn-thread-start.js';

interface TestRpc {
  initializedSession(): Promise<{ readonly generation: number }>;
  isSessionCurrent(generation: number): boolean;
  request(method: string, params: Record<string, unknown>, options: {
    mutating: true; expectedGeneration: number; assertBeforeWrite(): void;
    onResponseEnvelope(envelope: AppServerResponseEnvelope): void;
    onLateResponseEnvelope(envelope: AppServerResponseEnvelope): void;
  }): Promise<unknown>;
}
export interface TestAuthorityProof {
  readonly backendIdentity: string;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
}
const fail = (): never => { throw new Error('Native first thread/start unqualified'); };

/** Fault-injection test harness. Deliberately absent from src/ and production
 * build: a test-supplied RPC or authority object is not a writer lease. */
export async function dispatchPreparedNativeFirstThreadStartForOfflineTest(
  journal: NativeFirstTurnBootstrapJournal, prepared: NativeFirstThreadStartPrepared,
  rpc: TestRpc, authority: (expected: TestAuthorityProof) => TestAuthorityProof | null,
): Promise<NativeFirstTurnBootstrapRecord> {
  if (!prepared || !consumePreparedNativeFirstThreadStart(prepared) || typeof authority !== 'function' ||
      !rpc || typeof rpc.initializedSession !== 'function' ||
      typeof rpc.isSessionCurrent !== 'function' || typeof rpc.request !== 'function') return fail();
  const record = journal.get(prepared.identity.operationId);
  if (!record || record.state !== 'thread-reserved' || record.revision !== 1 ||
      record.sourceId !== prepared.identity.sourceId ||
      record.sourceGeneration !== prepared.identity.sourceGeneration ||
      record.ownerEpoch !== prepared.identity.ownerEpoch ||
      record.backendIdentity !== prepared.identity.backendIdentity ||
      record.threadStartFingerprint !== prepared.identity.threadStartFingerprint) return fail();
  const filePath = journal.filePath();
  let writeFencePassed = false;
  const authorized = (generation: number): boolean => {
    const expected = Object.freeze({ backendIdentity: prepared.identity.backendIdentity,
      sourceId: prepared.identity.sourceId, sourceGeneration: prepared.identity.sourceGeneration,
      ownerEpoch: prepared.identity.ownerEpoch, backendGeneration: generation });
    const observed = authority(expected);
    return !!observed && observed.backendIdentity === expected.backendIdentity &&
      observed.sourceId === expected.sourceId &&
      observed.sourceGeneration === expected.sourceGeneration &&
      observed.ownerEpoch === expected.ownerEpoch &&
      observed.backendGeneration === expected.backendGeneration;
  };
  const positiveAck = (envelope: AppServerResponseEnvelope): void => {
    if (!writeFencePassed || !('result' in envelope)) return;
    let threadId: string;
    try { threadId = projectControlledNativeStartPolicy(envelope.result,
      prepared.requestedPolicy).threadId; }
    catch { return; }
    try {
      const reopened = new NativeFirstTurnBootstrapJournal(filePath);
      try {
        const current = reopened.get(prepared.identity.operationId);
        if (current?.state === 'thread-reserved' && current.revision === 1 &&
            current.sourceId === prepared.identity.sourceId &&
            current.sourceGeneration === prepared.identity.sourceGeneration &&
            current.ownerEpoch === prepared.identity.ownerEpoch &&
            current.threadStartFingerprint === prepared.identity.threadStartFingerprint &&
            current.backendIdentity === prepared.identity.backendIdentity)
          reopened.persistThreadAccepted({ operationId: prepared.identity.operationId,
            expectedRevision: 1, threadId });
      } finally { reopened.close(); }
    } catch { /* The intent remains reserved; no second start is allowed. */ }
  };
  try {
    const session = await rpc.initializedSession();
    if (!Number.isSafeInteger(session.generation) || session.generation < 1 ||
        !rpc.isSessionCurrent(session.generation) || !authorized(session.generation)) fail();
    await rpc.request('thread/start', structuredClone(prepared.params), {
      mutating: true, expectedGeneration: session.generation,
      assertBeforeWrite: () => {
        if (!rpc.isSessionCurrent(session.generation) || !authorized(session.generation)) fail();
        writeFencePassed = true;
      },
      onResponseEnvelope: positiveAck, onLateResponseEnvelope: positiveAck,
    });
  } catch { /* Failed/uncertain native start is never replayed. */ }
  const settle = new NativeFirstTurnBootstrapJournal(filePath);
  try {
    const outcome = settle.get(prepared.identity.operationId);
    if (!outcome || outcome.state !== 'thread-reserved' && outcome.state !== 'thread-accepted')
      return fail();
    return outcome;
  } finally { settle.close(); }
}
