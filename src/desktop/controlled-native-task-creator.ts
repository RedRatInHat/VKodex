import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { AppServerRpc } from '../codex/app-server-connection.js';
import { approveTaskPolicy, assertEffectiveResume, type ApprovedTaskPolicy } from
  '../codex/managed-task-policy.js';

type Row = Record<string, unknown>;
type PolicyTemplate = Omit<ApprovedTaskPolicy, 'threadId' | 'serviceTier' | 'environments'> & Readonly<{
  allowedServiceTiers: readonly (string | null)[];
  allowedEnvironments: readonly ApprovedTaskPolicy['environments'][];
}>;
type CreatorRpc = Pick<AppServerRpc, 'request'> & Readonly<{
  initializedSession(): Promise<{ readonly generation: number }>;
  isSessionCurrent(generation: number): boolean;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const row = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathEqual = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' &&
  path.win32.isAbsolute(a) && path.win32.isAbsolute(b) &&
  path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const refuse = (): never => { throw new Error('Controlled native creation unqualified'); };
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}

/** The native thread may already exist. Reconciliation is required; never retry thread/start. */
export class ControlledNativeCreationUncertainError extends Error {
  constructor() { super('Controlled native creation result is uncertain'); this.name = 'ControlledNativeCreationUncertainError'; }
}

export interface ControlledCreationIntent {
  readonly operationId: string;
  readonly creatorNonce: string;
  /** Producer-issued source instance ID, not a native monotonic source revision. */
  readonly sourceGeneration: string;
  readonly sourceId: string;
  readonly requestedPolicy: PolicyTemplate;
}
export interface ControlledCreationStarted extends ControlledCreationIntent {
  readonly threadId: string;
  /** Bounded native selection, saved before policy qualification for reconciliation. */
  readonly selectedEffective: Readonly<{
    model: string | null; modelProvider: string | null; reasoningEffort: string | null;
    serviceTier: string | null; cwd: string | null; approvalPolicy: string | null;
    environments: readonly Readonly<{ environmentId: string | null; cwd: string | null;
      runtimeWorkspaceRoots: readonly string[] | null }>[] | null;
  }>;
}
export interface ControlledCreationReceipt extends ControlledCreationStarted {
  readonly effectivePolicy: ApprovedTaskPolicy;
  readonly rolloutPath: string;
  readonly status: 'qualified-zero-turn';
}
export interface ControlledNativeTaskCreatorOptions {
  readonly rpc: CreatorRpc;
  readonly operationId: string;
  readonly sourceId: string;
  readonly requestedPolicy: PolicyTemplate;
  /** The implementation must atomically reserve operationId and durably save the intent. */
  readonly persistIntent: (intent: ControlledCreationIntent) => Promise<Readonly<{ isCurrent(): boolean }>>;
  /** Saves positive native acceptance before any post-start reads. */
  readonly persistStarted: (started: ControlledCreationStarted) => Promise<void>;
  /** Saves a qualified, immutable receipt before it is returned to the caller. */
  readonly persistQualified: (receipt: ControlledCreationReceipt) => Promise<void>;
  /** Independent trusted source mapping; cannot be synthesized from empty history. */
  readonly resolveSource: (threadId: string) => Promise<Readonly<{ sourceId: string; rolloutPath: string }>>;
}

function policyTemplate(value: unknown): PolicyTemplate {
  if (!row(value) || Object.hasOwn(value, 'threadId') || Object.hasOwn(value, 'serviceTier') ||
    Object.hasOwn(value, 'environments') || !Array.isArray(value.allowedServiceTiers) ||
    !Array.isArray(value.allowedEnvironments) || value.allowedServiceTiers.length < 1 ||
    value.allowedServiceTiers.length > 4 || value.allowedEnvironments.length < 1 ||
    value.allowedEnvironments.length > 4) refuse();
  const { allowedServiceTiers, allowedEnvironments, ...requested } = value as Row;
  const tiers = allowedServiceTiers as (string | null)[];
  const environments = allowedEnvironments as ApprovedTaskPolicy['environments'][];
  for (const tier of tiers) for (const environment of environments) approveTaskPolicy({
    ...requested, threadId: '00000000-0000-4000-8000-000000000000',
    serviceTier: tier, environments: environment });
  return freezeTree({ ...structuredClone(requested),
    allowedServiceTiers: [...tiers],
    allowedEnvironments: environments.map(item => structuredClone(item)) }) as unknown as PolicyTemplate;
}

const bounded = (value: unknown, max = 128): string | null =>
  typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value) ? value : null;
function selectedEffective(start: Row): ControlledCreationStarted['selectedEffective'] {
  const environments = row(start.thread) ? start.thread.environments : null;
  const sanitizedEnvironments = Array.isArray(environments) && environments.length <= 4
    ? environments.map(item => row(item) ? {
      environmentId: bounded(item.environmentId), cwd: bounded(item.cwd, 4096),
      runtimeWorkspaceRoots: Array.isArray(item.runtimeWorkspaceRoots) &&
        item.runtimeWorkspaceRoots.length <= 32 && item.runtimeWorkspaceRoots.every(
          root => bounded(root, 4096) !== null)
        ? item.runtimeWorkspaceRoots.map(root => root as string) : null,
    } : { environmentId: null, cwd: null, runtimeWorkspaceRoots: null }) : null;
  return freezeTree({ model: bounded(start.model), modelProvider: bounded(start.modelProvider),
    reasoningEffort: bounded(start.reasoningEffort, 64), serviceTier: bounded(start.serviceTier, 64),
    cwd: bounded(start.cwd, 4096), approvalPolicy: bounded(start.approvalPolicy),
    environments: sanitizedEnvironments });
}

function qualifyRead(read: Row, threadId: string, rolloutPath: string,
  policy: ApprovedTaskPolicy): void {
  if (!row(read.thread) || read.thread.id !== threadId ||
    !row(read.thread.status) ||
    !['idle', 'notLoaded'].includes(read.thread.status.type as string) ||
    !Array.isArray(read.thread.turns) || read.thread.turns.length !== 0 ||
    !pathEqual(read.thread.path, rolloutPath) ||
    !pathEqual(read.thread.cwd, policy.cwd) ||
    read.thread.modelProvider !== policy.modelProvider) refuse();
  const thread = read.thread as Row;
  if ((thread.status as Row).type === 'notLoaded') {
    if (thread.model != null && thread.model !== policy.model ||
      thread.reasoningEffort != null && thread.reasoningEffort !== policy.effort ||
      thread.environments != null && !isDeepStrictEqual(thread.environments, policy.environments)) refuse();
  } else if (thread.model !== policy.model || thread.reasoningEffort !== policy.effort ||
    !isDeepStrictEqual(thread.environments, policy.environments)) refuse();
}

/** Creates one zero-turn native task, without launching a model or granting stock writes.
 * The injected reservation is the durable single-dispatch authority. After a
 * possible wire write, every failure is uncertain and this function never replays. */
export async function createControlledNativeTask(options: ControlledNativeTaskCreatorOptions):
  Promise<ControlledCreationReceipt> {
  if (!options || !options.rpc || typeof options.rpc.request !== 'function' ||
    typeof options.rpc.initializedSession !== 'function' ||
    typeof options.rpc.isSessionCurrent !== 'function' ||
    !UUID.test(options.operationId) || typeof options.sourceId !== 'string' ||
    !options.sourceId || options.sourceId.length > 256 || /[\x00-\x1f\x7f]/u.test(options.sourceId) ||
    ![options.persistIntent, options.persistStarted, options.persistQualified,
      options.resolveSource].every(callback => typeof callback === 'function')) refuse();
  const requestedPolicy = policyTemplate(options.requestedPolicy);
  const intent = Object.freeze({ operationId: options.operationId,
    creatorNonce: randomUUID(), sourceGeneration: randomUUID(), sourceId: options.sourceId,
    requestedPolicy }) satisfies ControlledCreationIntent;
  const reservation = await options.persistIntent(intent);
  if (!reservation || typeof reservation.isCurrent !== 'function' ||
    reservation.isCurrent() !== true) refuse();
  let dispatched = false;
  try {
    const session = await options.rpc.initializedSession();
    if (!Number.isSafeInteger(session.generation) || session.generation < 1 ||
      !options.rpc.isSessionCurrent(session.generation) || reservation.isCurrent() !== true) refuse();
    const startParams = { cwd: requestedPolicy.cwd, model: requestedPolicy.model,
      config: { model_reasoning_effort: requestedPolicy.effort },
      permissions: requestedPolicy.activePermissionProfile.id,
      approvalPolicy: requestedPolicy.approvalPolicy,
      runtimeWorkspaceRoots: [...requestedPolicy.runtimeWorkspaceRoots], ephemeral: false };
    // Mark before invoking request: if transport outcome is unknown, the durable
    // intent remains the sole reconciliation key and no second start is sent.
    dispatched = true;
    const start = await options.rpc.request('thread/start', startParams, {
      mutating: true, expectedGeneration: session.generation,
      assertBeforeWrite: () => {
        if (!options.rpc.isSessionCurrent(session.generation) || reservation.isCurrent() !== true) refuse();
      },
    });
    const candidateId = row(start.thread) ? start.thread.id : null;
    if (typeof candidateId !== 'string' || !UUID.test(candidateId)) refuse();
    const threadId = candidateId as string;
    const started = Object.freeze({ ...intent, threadId,
      selectedEffective: selectedEffective(start) }) satisfies ControlledCreationStarted;
    await options.persistStarted(started);
    const selectedTier = start.serviceTier;
    const selectedEnvironments = row(start.thread) ? start.thread.environments : null;
    if (!requestedPolicy.allowedServiceTiers.some(tier => tier === selectedTier) ||
      !requestedPolicy.allowedEnvironments.some(allowed => isDeepStrictEqual(allowed, selectedEnvironments))) refuse();
    const { allowedServiceTiers: _tiers, allowedEnvironments: _environments,
      ...fixedPolicy } = requestedPolicy;
    const effectivePolicy = approveTaskPolicy({ ...fixedPolicy, threadId,
      serviceTier: selectedTier, environments: selectedEnvironments });
    assertEffectiveResume(effectivePolicy, start);
    const readParams = { threadId, includeTurns: true };
    const read = await options.rpc.request('thread/read', readParams,
      { expectedGeneration: session.generation });
    const nativePath = row(read.thread) ? read.thread.path : null;
    const source = await options.resolveSource(threadId);
    if (!source || source.sourceId !== intent.sourceId ||
      !pathEqual(nativePath, source.rolloutPath)) refuse();
    qualifyRead(read, threadId, source.rolloutPath, effectivePolicy);
    const turns = await options.rpc.request('thread/turns/list', {
      threadId, limit: 100, sortDirection: 'asc', itemsView: 'full' },
      { expectedGeneration: session.generation });
    const goal = await options.rpc.request('thread/goal/get', { threadId },
      { expectedGeneration: session.generation });
    const queue = await options.rpc.request('thread/queue/list', { threadId, limit: 100 },
      { expectedGeneration: session.generation });
    const after = await options.rpc.request('thread/read', readParams,
      { expectedGeneration: session.generation });
    if (!Array.isArray(turns.data) || turns.data.length !== 0 || turns.nextCursor !== null ||
      goal.goal !== null || !Array.isArray(queue.data) || queue.data.length !== 0 ||
      queue.nextCursor !== null || !options.rpc.isSessionCurrent(session.generation) ||
      reservation.isCurrent() !== true) refuse();
    qualifyRead(after, threadId, source.rolloutPath, effectivePolicy);
    const sourceAfter = await options.resolveSource(threadId);
    if (!sourceAfter || sourceAfter.sourceId !== source.sourceId ||
      !pathEqual(sourceAfter.rolloutPath, source.rolloutPath)) refuse();
    const receipt = Object.freeze({ ...started, effectivePolicy, rolloutPath: source.rolloutPath,
      status: 'qualified-zero-turn' as const }) satisfies ControlledCreationReceipt;
    await options.persistQualified(receipt);
    return receipt;
  } catch (error) {
    if (dispatched) throw new ControlledNativeCreationUncertainError();
    throw error;
  }
}
