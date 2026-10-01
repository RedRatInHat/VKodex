import type { AppServerResponseEnvelope } from '../codex/app-server-connection.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapRecord,
  type NativeFirstTurnWriteFenceStatus } from './native-first-turn-bootstrap-journal.js';
import { consumeProductionNativeFirstTurnReservation,
  type NativeFirstTurnPreparedReservation } from './native-first-turn-bootstrap-preparation.js';

const fail = (): never => { throw new Error('Native first-turn canary unqualified'); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type NativeFirstTurnCanaryOutcome = Readonly<{
  kind: 'accepted' | 'uncertain';
  diagnostic: 'accepted' | 'prewrite-refused' | 'native-error' |
    'unqualified-response' | 'transport-or-no-ack';
  writeFence: NativeFirstTurnWriteFenceStatus;
  record: NativeFirstTurnBootstrapRecord;
}>;

/** One write on an already qualified, isolated first-turn path. The opaque
 * ingress admission excludes only VKodex's duplicate ingress; it CANNOT
 * exclude an external Desktop/VS Code/CLI writer on a shared CODEX_HOME.
 * Do not wire this canary to a shared or advertised profile. Until a separate
 * closed-world profile lifecycle is proven, this remains an isolated canary. */
export async function dispatchPreparedNativeFirstTurnCanary(
  journal: NativeFirstTurnBootstrapJournal,
  prepared: NativeFirstTurnPreparedReservation): Promise<NativeFirstTurnCanaryOutcome> {
  const authority = consumeProductionNativeFirstTurnReservation(prepared);
  if (!authority || authority.journal !== journal ||
      !(journal instanceof NativeFirstTurnBootstrapJournal)) return fail();
  const { ingressScope: scope, rpc } = authority;
  const params = prepared.command.params;
  const exactReservation = (): void => {
    const record = journal.get(prepared.operationId);
    if (!record || record.state !== 'turn-reserved' || record.revision !== 3 ||
        record.threadId !== scope.threadId || record.keyedFingerprint !== prepared.keyedFingerprint ||
        record.clientUserMessageId !== params.clientUserMessageId ||
        params.threadId !== scope.threadId || prepared.command.method !== 'turn/start' ||
        journal.getFirstTurnWriteFenceStatus(prepared.operationId) !== 'not-passed') fail();
  };
  const current = (): void => {
    journal.assertFirstTurnIngressRpc(scope, rpc);
    exactReservation();
  };
  const filePath = journal.filePath();
  let diagnostic: NativeFirstTurnCanaryOutcome['diagnostic'] = 'transport-or-no-ack';
  const positiveAck = (envelope: AppServerResponseEnvelope): void => {
    if (!('result' in envelope)) { diagnostic = 'native-error'; return; }
    const turn = envelope.result.turn;
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      diagnostic = 'unqualified-response'; return;
    }
    const id = (turn as Record<string, unknown>).id;
    const status = (turn as Record<string, unknown>).status;
    if (typeof id !== 'string' || !uuid.test(id) ||
        status !== 'inProgress' && status !== 'completed') {
      diagnostic = 'unqualified-response'; return;
    }
    try {
      const reopened = new NativeFirstTurnBootstrapJournal(filePath);
      try {
        if (reopened.getFirstTurnWriteFenceStatus(prepared.operationId) !== 'passed') return;
        const record = reopened.get(prepared.operationId);
        if (!record || record.threadId !== scope.threadId ||
            record.clientUserMessageId !== params.clientUserMessageId ||
            record.keyedFingerprint !== prepared.keyedFingerprint) return;
        if (record.state === 'turn-reserved' || record.state === 'turn-unknown')
          reopened.markFirstTurnAccepted({ operationId: prepared.operationId,
            expectedRevision: record.revision, turnId: id });
      } finally { reopened.close(); }
    } catch { /* Lost local receipt leaves a durable uncertain operation. */ }
  };
  try {
    const session = await rpc.initializedSession();
    if (session.generation !== scope.backendGeneration ||
        !rpc.isSessionCurrent(scope.backendGeneration)) fail();
    current();
    await rpc.request('turn/start', structuredClone(params), {
      mutating: true, expectedGeneration: scope.backendGeneration,
      assertBeforeWrite: () => {
        current();
        journal.markFirstTurnWriteFencePassedWithIngressLease(scope);
      },
      onBeforeWriteRefused: () => { diagnostic = 'prewrite-refused'; },
      onResponseEnvelope: positiveAck, onLateResponseEnvelope: positiveAck,
    });
  } catch { /* A refusal, timeout or lost ACK never authorizes replay. */ }
  const settled = new NativeFirstTurnBootstrapJournal(filePath);
  try {
    let record = settled.get(prepared.operationId);
    if (!record) return fail();
    if (record.state === 'turn-reserved') {
      try { settled.markFirstTurnUnknown({ operationId: prepared.operationId, expectedRevision: 3 }); }
      catch { /* A valid late ACK may have won the CAS. */ }
      record = settled.get(prepared.operationId);
    }
    if (!record || record.state !== 'turn-accepted' && record.state !== 'turn-unknown') return fail();
    return Object.freeze({ kind: record.state === 'turn-accepted' ? 'accepted' : 'uncertain',
      diagnostic: record.state === 'turn-accepted' ? 'accepted' : diagnostic,
      writeFence: settled.getFirstTurnWriteFenceStatus(prepared.operationId), record });
  } finally { settled.close(); }
}
