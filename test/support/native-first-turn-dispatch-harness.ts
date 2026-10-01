import type { AppServerRequestOptions, AppServerResponseEnvelope } from
  '../../src/codex/app-server-connection.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapRecord } from
  '../../src/desktop/native-first-turn-bootstrap-journal.js';
import { consumeNativeFirstTurnReservation, type NativeFirstTurnPreparedReservation } from
  '../../src/desktop/native-first-turn-bootstrap-preparation.js';

const fail = (): never => { throw new Error('Native first-turn reservation unqualified'); };
/** Offline fault-injection harness only. Deliberately absent from production source. */
export interface NativeFirstTurnDispatchRpc {
  initializedSession(): Promise<{ readonly generation: number }>;
  isSessionCurrent(generation: number): boolean;
  request(method: string, params: Record<string, unknown>,
    options: AppServerRequestOptions): Promise<unknown>;
}

/** Offline fault-injection harness only. The generic RPC and caller-supplied
 * boolean authority are not a production source/owner/queue capability. Do
 * not wire this entrypoint to a live Codex backend. A production dispatcher
 * must obtain a pinned authenticated connection and an opaque current lease. */
export async function dispatchPreparedNativeFirstTurnForOfflineTest(journal: NativeFirstTurnBootstrapJournal,
  prepared: NativeFirstTurnPreparedReservation, rpc: NativeFirstTurnDispatchRpc,
  authority: () => boolean): Promise<NativeFirstTurnBootstrapRecord> {
  if (!prepared || !consumeNativeFirstTurnReservation(prepared) || typeof authority !== 'function' ||
      !rpc || typeof rpc.initializedSession !== 'function' ||
      typeof rpc.isSessionCurrent !== 'function' || typeof rpc.request !== 'function') return fail();
  const record = journal.get(prepared.operationId);
  const params = prepared.command.params;
  if (!record || record.state !== 'turn-reserved' || record.revision !== 3 ||
      record.keyedFingerprint !== prepared.keyedFingerprint ||
      record.threadId !== params.threadId ||
      record.clientUserMessageId !== params.clientUserMessageId ||
      prepared.command.method !== 'turn/start') return fail();
  const filePath = journal.filePath();
  const positiveAck = (envelope: AppServerResponseEnvelope): void => {
    if (!('result' in envelope) || !envelope.result ||
        typeof envelope.result !== 'object' || Array.isArray(envelope.result)) return;
    const turn = envelope.result.turn;
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return;
    const turnId = (turn as Record<string, unknown>).id;
    const status = (turn as Record<string, unknown>).status;
    if (typeof turnId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(turnId) ||
        status !== 'inProgress' && status !== 'completed') return;
    try {
      // A late callback can outlive the caller's journal handle. Reopen the
      // same one-operation database; never issue a second native request.
      const reopened = new NativeFirstTurnBootstrapJournal(filePath);
      try {
        if (reopened.getFirstTurnWriteFenceStatus(prepared.operationId) !== 'passed') return;
        const current = reopened.get(prepared.operationId);
        if (!current || current.keyedFingerprint !== prepared.keyedFingerprint ||
            current.threadId !== params.threadId ||
            current.clientUserMessageId !== params.clientUserMessageId) return;
        if (current.state === 'turn-reserved' || current.state === 'turn-unknown')
          reopened.markFirstTurnAccepted({ operationId: prepared.operationId,
            expectedRevision: current.revision, turnId });
      } finally { reopened.close(); }
    } catch { /* A failed ACK write leaves the operation uncertain. */ }
  };
  try {
    const session = await rpc.initializedSession();
    if (!Number.isSafeInteger(session.generation) || session.generation < 1 ||
        !rpc.isSessionCurrent(session.generation) || authority() !== true) fail();
    await rpc.request('turn/start', structuredClone(params), {
      mutating: true, expectedGeneration: session.generation,
      assertBeforeWrite: () => {
        if (!rpc.isSessionCurrent(session.generation) || authority() !== true) fail();
        journal.markFirstTurnWriteFencePassed(prepared.operationId);
      },
      onResponseEnvelope: positiveAck, onLateResponseEnvelope: positiveAck,
    });
  } catch { /* A failed, refused, or timed-out write never authorizes replay. */ }
  // The initiating handle can be closed while the RPC is in flight. Reopen
  // for the terminal observation just as the late-response callback does.
  const settle = new NativeFirstTurnBootstrapJournal(filePath);
  try {
    const current = settle.get(prepared.operationId);
    if (!current) return fail();
    if (current.state === 'turn-reserved') {
      try { settle.markFirstTurnUnknown({ operationId: prepared.operationId, expectedRevision: 3 }); }
      catch { /* A positive callback may have won the CAS. */ }
    }
    const outcome = settle.get(prepared.operationId);
    if (!outcome || outcome.state !== 'turn-accepted' && outcome.state !== 'turn-unknown') return fail();
    return outcome;
  } finally {
    settle.close();
  }
}
