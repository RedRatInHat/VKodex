import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { comparablePath } from '../core/paths.js';
import type { ApprovedTaskPolicy } from '../codex/managed-task-policy.js';
import { ControlledNativeCreationJournal, type ControlledCreationJournalRecord } from
  './controlled-native-creation-journal.js';
import { loadControlledNativeSourcePreflightReceipt, proveControlledNativeSource } from
  './controlled-native-source-proof.js';

const internal = new WeakMap<object, Readonly<{
  journal: ControlledNativeCreationJournal; operationId: string; record: ControlledCreationJournalRecord;
  preflightReceiptPath: string; sourceHome: string; workspace: string;
}>>();
const refuse = (): never => { throw new Error('Controlled native CLI source scope unqualified'); };

/** An in-process proof handle. It cannot be assembled from a manifest or an idle native read. */
export interface ControlledNativeCliSourceScope {
  readonly taskId: string;
  readonly sourceGeneration: string;
  readonly sourceHome: string;
  readonly workspace: string;
  readonly policy: ApprovedTaskPolicy;
}

export function assertControlledNativeCliSourceScope(value: unknown): asserts value is ControlledNativeCliSourceScope {
  if (!value || typeof value !== 'object' || !internal.has(value)) refuse();
}

/** Re-read the durable journal and immutable preflight receipt, then prove the
 * exact single native rollout. The journal remains the trust root. */
export async function verifyControlledNativeCliSourceScope(scope: ControlledNativeCliSourceScope,
  manifest?: Readonly<{ taskId: string; home: string; cwd: string;
    approvedTaskPolicy?: ApprovedTaskPolicy }>): Promise<void> {
  assertControlledNativeCliSourceScope(scope);
  const state = internal.get(scope)!;
  let current: ControlledCreationJournalRecord | null;
  try { current = state.journal.get(state.operationId); } catch { return refuse(); }
  if (!current) return refuse();
  if (!isDeepStrictEqual(current, state.record) || current.state !== 'qualified' ||
      current.intent.sourceProofRequired !== true || current.started?.sourceProofRequired !== true ||
      current.qualified?.sourceProofRequired !== true) refuse();
  const qualified = current.qualified;
  if (!qualified) return refuse();
  if (qualified.threadId !== scope.taskId ||
      qualified.sourceGeneration !== scope.sourceGeneration ||
      !isDeepStrictEqual(qualified.effectivePolicy, scope.policy)) refuse();
  const identity = { operationId: current.intent.operationId, sourceId: current.intent.sourceId,
    sourceGeneration: current.intent.sourceGeneration };
  const preflight = await loadControlledNativeSourcePreflightReceipt(state.preflightReceiptPath,
    identity, state.sourceHome, state.workspace).catch(() => refuse());
  const proof = await proveControlledNativeSource(preflight, qualified.rolloutPath, qualified.threadId)
    .catch(() => refuse());
  const policyWorkspace = await realpath(qualified.effectivePolicy.cwd).catch(() => refuse());
  if (comparablePath(proof.rolloutPath) !== comparablePath(qualified.rolloutPath) ||
      comparablePath(preflight.sourceHome) !== comparablePath(scope.sourceHome) ||
      comparablePath(preflight.workspace) !== comparablePath(scope.workspace) ||
      comparablePath(policyWorkspace) !== comparablePath(scope.workspace)) refuse();
  if (manifest) {
    let home: string, cwd: string;
    try { [home, cwd] = await Promise.all([realpath(manifest.home), realpath(manifest.cwd)]); }
    catch { return refuse(); }
    if (manifest.taskId !== scope.taskId ||
        comparablePath(home) !== comparablePath(scope.sourceHome) ||
        comparablePath(cwd) !== comparablePath(scope.workspace) ||
        !isDeepStrictEqual(manifest.approvedTaskPolicy, scope.policy)) refuse();
  }
}

export async function deriveControlledNativeCliSourceScope(options: Readonly<{
  journal: ControlledNativeCreationJournal; operationId: string;
  preflightReceiptPath: string; sourceHome: string; workspace: string;
}>): Promise<ControlledNativeCliSourceScope> {
  if (!options || !(options.journal instanceof ControlledNativeCreationJournal)) refuse();
  let record: ControlledCreationJournalRecord | null;
  try { record = options.journal.get(options.operationId); } catch { return refuse(); }
  if (!record) return refuse();
  if (record.state !== 'qualified' || !record.qualified ||
      record.intent.sourceProofRequired !== true || record.started?.sourceProofRequired !== true ||
      record.qualified.sourceProofRequired !== true) refuse();
  const qualified = record.qualified;
  if (!qualified) return refuse();
  let sourceHome: string, workspace: string;
  try { [sourceHome, workspace] = await Promise.all([
    realpath(options.sourceHome), realpath(options.workspace)]); }
  catch { return refuse(); }
  const scope: ControlledNativeCliSourceScope = Object.freeze({ taskId: qualified.threadId,
    sourceGeneration: qualified.sourceGeneration, sourceHome,
    workspace, policy: qualified.effectivePolicy });
  internal.set(scope, Object.freeze({ journal: options.journal, operationId: options.operationId,
    record, preflightReceiptPath: options.preflightReceiptPath,
    sourceHome: options.sourceHome, workspace: options.workspace }));
  try { await verifyControlledNativeCliSourceScope(scope); }
  catch { internal.delete(scope); return refuse(); }
  return scope;
}
