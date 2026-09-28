import { isDeepStrictEqual } from 'node:util';
import type { ControlledNativeCreationJournal } from './controlled-native-creation-journal.js';
import { controlledNativeSourceProofResolver, policyFromControlledStarted, qualifyControlledZeroTurn,
  type ControlledCreationReceipt, type CreatorRpc,
  type ControlledNativeTaskCreatorOptions, type ControlledNativeSourceProofOptions } from './controlled-native-task-creator.js';

const refuse = (): never => { throw new Error('Controlled native creation reconciliation unqualified'); };

/** Read-only native reconciliation for a known positive start receipt.
 * No thread/start, thread/resume, turn/start, queue/add, or owner claim. */
export async function reconcileControlledNativeCreation(options: Readonly<{
  journal: Pick<ControlledNativeCreationJournal, 'get' | 'persistQualified'>;
  operationId: string;
  rpc: CreatorRpc;
  resolveSource: ControlledNativeTaskCreatorOptions['resolveSource'];
  sourceProof?: ControlledNativeSourceProofOptions;
}>): Promise<ControlledCreationReceipt> {
  const initial = options.journal.get(options.operationId);
  if (initial == null) throw new Error('Controlled native creation reconciliation unqualified');
  if (initial.state !== 'started' || initial.qualified) refuse();
  const started = initial.started;
  if (started == null) throw new Error('Controlled native creation reconciliation unqualified');
  const effectivePolicy = policyFromControlledStarted(started);
  const session = await options.rpc.initializedSession();
  if (!Number.isSafeInteger(session.generation) || session.generation < 1 ||
    !options.rpc.isSessionCurrent(session.generation)) refuse();
  const assertCurrent = (): void => {
    const current = options.journal.get(options.operationId);
    if (!current || current.state !== 'started' ||
      !isDeepStrictEqual(current.started, started)) refuse();
  };
  const rolloutPath = await qualifyControlledZeroTurn({ rpc: options.rpc,
    generation: session.generation, threadId: started.threadId, sourceId: started.sourceId,
    effectivePolicy, resolveSource: options.sourceProof
      ? controlledNativeSourceProofResolver(started, options.sourceProof) : options.resolveSource,
    assertCurrent });
  if (!options.rpc.isSessionCurrent(session.generation)) refuse();
  assertCurrent();
  const receipt = Object.freeze({ ...started, effectivePolicy, rolloutPath,
    status: 'qualified-zero-turn' as const }) satisfies ControlledCreationReceipt;
  await options.journal.persistQualified(receipt);
  return receipt;
}
