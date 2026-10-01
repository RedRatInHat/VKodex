import type { NativeCliTurnStartScope } from '../codex/native-cli-turn-start.js';
import type { AppServerRequestOptions, AppServerResponseEnvelope } from
  '../codex/app-server-connection.js';
import type { WorkerCommand } from '../codex/managed-worker-command-dispatcher.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapIdentity,
  type NativeFirstTurnBootstrapRecord } from
  './native-first-turn-bootstrap-journal.js';
import { prepareNativeFirstTurnBootstrapCommand } from './native-first-turn-input-fingerprint.js';
import { loadNativeFirstTurnPrivateKey } from './native-first-turn-private-key.js';

const fail = (): never => { throw new Error('Native first-turn reservation unqualified'); };
const issued = new WeakSet<object>();
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
  const prepared = Object.freeze({ command: compiled.command, operationId: identity.operationId,
    revision: 3 as const, keyedFingerprint: compiled.keyedFingerprint });
  issued.add(prepared);
  return prepared;
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

export interface NativeFirstTurnDispatchRpc {
  initializedSession(): Promise<{ readonly generation: number }>;
  isSessionCurrent(generation: number): boolean;
  request(method: string, params: Record<string, unknown>,
    options: AppServerRequestOptions): Promise<unknown>;
}

/** One attempted native write from one in-process prepared reservation. The
 * authority callback must synchronously prove current source/owner/queue and
 * effective policy, including immediately before the connection writes. */
export async function dispatchPreparedNativeFirstTurn(journal: NativeFirstTurnBootstrapJournal,
  prepared: NativeFirstTurnPreparedReservation, rpc: NativeFirstTurnDispatchRpc,
  authority: () => boolean): Promise<NativeFirstTurnBootstrapRecord> {
  if (!prepared || !issued.delete(prepared) || typeof authority !== 'function' ||
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
  let writeFencePassed = false;
  const positiveAck = (envelope: AppServerResponseEnvelope): void => {
    if (!writeFencePassed || !('result' in envelope) || !envelope.result ||
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
        writeFencePassed = true;
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
