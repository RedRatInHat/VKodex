import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { AppServerRpc } from '../codex/app-server-connection.js';
import { approveTaskPolicy, assertEffectiveResume, type ApprovedTaskPolicy } from
  '../codex/managed-task-policy.js';
import { comparablePath } from '../core/paths.js';
import { assertAuthenticatedProfileSourcePreflightForWrite, captureAuthenticatedProfileSourcePreflight, captureControlledNativeSourcePreflight,
  loadAuthenticatedProfileSourcePreflightReceipt, loadControlledNativeSourcePreflightReceipt,
  persistAuthenticatedProfileSourcePreflightReceipt, persistControlledNativeSourcePreflightReceipt,
  proveAuthenticatedProfileSource, proveControlledNativeSource,
  type AuthenticatedProfileSourcePreflight, type ControlledNativeSourceIdentity } from './controlled-native-source-proof.js';

type Row = Record<string, unknown>;
export type PolicyTemplate = Omit<ApprovedTaskPolicy, 'threadId' | 'serviceTier' | 'environments'> & Readonly<{
  allowedServiceTiers: readonly (string | null)[];
  allowedEnvironments: readonly ApprovedTaskPolicy['environments'][];
}>;
export type CreatorRpc = Pick<AppServerRpc, 'request'> & Readonly<{
  initializedSession(): Promise<{ readonly generation: number }>;
  isSessionCurrent(generation: number): boolean;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const row = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathEqual = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' &&
  path.win32.isAbsolute(a) && path.win32.isAbsolute(b) &&
  comparablePath(a) === comparablePath(b);
async function sameExistingFilePath(a: unknown, b: unknown): Promise<boolean> {
  if (pathEqual(a, b)) return true;
  if (typeof a !== 'string' || typeof b !== 'string' ||
    !path.win32.isAbsolute(a) || !path.win32.isAbsolute(b)) return false;
  try {
    const [left, right] = await Promise.all([realpath(a), realpath(b)]);
    return comparablePath(left) === comparablePath(right);
  } catch { return false; }
}
const refuse = (): never => { throw new Error('Controlled native creation unqualified'); };
class FirstReadRpcExhausted extends Error {}
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}

/** The native thread may already exist. Reconciliation is required; never retry thread/start. */
export type ControlledNativeCreationUncertainPhase = 'start-response' | 'persist-started' |
  'policy' | 'readback' | 'persist-qualified';
export class ControlledNativeCreationUncertainError extends Error {
  readonly phase: ControlledNativeCreationUncertainPhase;
  constructor(phase: ControlledNativeCreationUncertainPhase = 'start-response') {
    super('Controlled native creation result is uncertain');
    this.name = 'ControlledNativeCreationUncertainError';
    this.phase = phase;
  }
}

export interface ControlledCreationIntent {
  readonly operationId: string;
  readonly creatorNonce: string;
  /** Producer-issued source instance ID, not a native monotonic source revision. */
  readonly sourceGeneration: string;
  readonly sourceId: string;
  /** Requires the opt-in source proof protocol during creation and reconciliation. */
  readonly sourceProofRequired?: true;
  /** Explicit candidate-only proof for a populated profile; absent means exclusive empty home. */
  readonly sourceProofMode?: 'authenticated-profile-new-task';
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
    /** Absent only in legacy, pre-reconciliation journal records. */
    runtimeWorkspaceRoots?: readonly string[] | null;
    approvalsReviewer?: string | null;
    activePermissionProfile?: Readonly<{ id: string | null; extends: string | null }> | null;
    sandbox?: ApprovedTaskPolicy['sandbox'] | null;
    /** Positive native start response, before any readback. Legacy records omit this. */
    startThread?: Readonly<{ status: string | null; turnCount: number | null;
      model: string | null; modelProvider: string | null;
      reasoningEffort: string | null; cwd: string | null }>;
    /** False if native nested objects had fields elided by bounded projection. */
    nativeShapeExact?: boolean;
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
  /** Optional new, owned, independent read-only session after the original first read RPC is exhausted.
   * The factory must not return a shared connection. The creator closes a validated returned session. */
  readonly freshReadRpc?: () => Promise<Readonly<{ rpc: CreatorRpc; close(): Promise<void> }>>;
  /** Opt-in source proof. The default requires an empty exclusive home; the
   * explicit authenticated-profile mode proves only the returned candidate.
   * Its durable preflight receipt must precede thread/start. */
  readonly sourceProof?: ControlledNativeSourceProofOptions;
  /** Independent trusted source mapping; cannot be synthesized from empty history. */
  /** Independently verifies the observed native path under the chosen source proof.
   * The optional path argument preserves existing one-argument resolvers. */
  readonly resolveSource: (threadId: string, observedNativePath?: string) =>
    Promise<Readonly<{ sourceId: string; rolloutPath: string }>>;
}

export interface ControlledNativeSourceProofOptions {
  readonly sourceHome: string;
  readonly preflightReceiptPath: string;
  readonly mode?: 'authenticated-profile-new-task';
}

/** Binds the observed native path to a pre-start receipt and the durable intent. */
export function controlledNativeSourceProofResolver(intent: ControlledCreationIntent,
  options: ControlledNativeSourceProofOptions): ControlledNativeTaskCreatorOptions['resolveSource'] {
  const identity: ControlledNativeSourceIdentity = { operationId: intent.operationId,
    sourceId: intent.sourceId, sourceGeneration: intent.sourceGeneration };
  return async (threadId, observedNativePath) => {
    if (typeof observedNativePath !== 'string') refuse();
    const nativePath = observedNativePath as string;
    if (intent.sourceProofMode !== options.mode) refuse();
    const proof = options.mode === 'authenticated-profile-new-task'
      ? await proveAuthenticatedProfileSource(
        await loadAuthenticatedProfileSourcePreflightReceipt(options.preflightReceiptPath,
          identity, options.sourceHome, intent.requestedPolicy.cwd), nativePath, threadId)
      : await proveControlledNativeSource(
        await loadControlledNativeSourcePreflightReceipt(options.preflightReceiptPath,
          identity, options.sourceHome, intent.requestedPolicy.cwd), nativePath, threadId);
    return { sourceId: identity.sourceId, rolloutPath: proof.rolloutPath };
  };
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

/** The sole thread/start request schema for controlled native creation. This
 * compiles policy only; durable intent, live generation and source proof are
 * separate requirements before using the request. */
export function compileControlledNativeStartParams(requestedPolicy: PolicyTemplate): Readonly<{
  cwd: string; model: string; config: Readonly<{ model_reasoning_effort: string | null }>;
  permissions: string; approvalPolicy: string; runtimeWorkspaceRoots: readonly string[];
  ephemeral: false;
}> {
  const policy = policyTemplate(requestedPolicy);
  return Object.freeze({ cwd: policy.cwd, model: policy.model,
    config: Object.freeze({ model_reasoning_effort: policy.effort }),
    permissions: policy.activePermissionProfile.id,
    approvalPolicy: policy.approvalPolicy,
    runtimeWorkspaceRoots: Object.freeze([...policy.runtimeWorkspaceRoots]),
    ephemeral: false });
}

const bounded = (value: unknown, max = 128): string | null =>
  typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value) ? value : null;
const boundedPaths = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.length <= 32 && value.every(item => bounded(item, 4096) !== null)
    ? value.map(item => item as string) : null;
const exactKeys = (value: unknown, expected: readonly string[]): boolean =>
  row(value) && Reflect.ownKeys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
function nativeNestedShapeExact(start: Row): boolean {
  if (!exactKeys(start.activePermissionProfile, ['id', 'extends']) || !row(start.sandbox) ||
    !row(start.thread) || !Array.isArray(start.thread.environments)) return false;
  const sandbox = start.sandbox;
  const sandboxKeys = sandbox.type === 'dangerFullAccess' ? ['type']
    : sandbox.type === 'readOnly' ? ['type', 'networkAccess']
    : sandbox.type === 'workspaceWrite' ? ['type', 'writableRoots', 'networkAccess',
      'excludeTmpdirEnvVar', 'excludeSlashTmp'] : [];
  return sandboxKeys.length > 0 && exactKeys(sandbox, sandboxKeys) &&
    start.thread.environments.length <= 1 && start.thread.environments.every(item =>
      exactKeys(item, ['environmentId', 'cwd', 'runtimeWorkspaceRoots']));
}
function boundedSandbox(value: unknown): ApprovedTaskPolicy['sandbox'] | null {
  if (!row(value)) return null;
  if (value.type === 'dangerFullAccess') return { type: 'dangerFullAccess' };
  if (value.type === 'readOnly' && typeof value.networkAccess === 'boolean')
    return { type: 'readOnly', networkAccess: value.networkAccess };
  const roots = boundedPaths(value.writableRoots);
  if (value.type === 'workspaceWrite' && roots !== null &&
    typeof value.networkAccess === 'boolean' && typeof value.excludeTmpdirEnvVar === 'boolean' &&
    typeof value.excludeSlashTmp === 'boolean') return { type: 'workspaceWrite',
      writableRoots: roots, networkAccess: value.networkAccess,
      excludeTmpdirEnvVar: value.excludeTmpdirEnvVar, excludeSlashTmp: value.excludeSlashTmp };
  return null;
}
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
    environments: sanitizedEnvironments, runtimeWorkspaceRoots: boundedPaths(start.runtimeWorkspaceRoots),
    approvalsReviewer: bounded(start.approvalsReviewer),
    activePermissionProfile: row(start.activePermissionProfile) ? {
      id: bounded(start.activePermissionProfile.id),
      extends: bounded(start.activePermissionProfile.extends),
    } : null, sandbox: boundedSandbox(start.sandbox),
    startThread: row(start.thread) ? {
      status: row(start.thread.status) ? bounded(start.thread.status.type) : null,
      turnCount: Array.isArray(start.thread.turns) ? start.thread.turns.length : null,
      model: bounded(start.thread.model), modelProvider: bounded(start.thread.modelProvider),
      reasoningEffort: bounded(start.thread.reasoningEffort, 64),
      cwd: bounded(start.thread.cwd, 4096),
    } : { status: null, turnCount: null, model: null, modelProvider: null,
      reasoningEffort: null, cwd: null },
    nativeShapeExact: nativeNestedShapeExact(start) });
}

/** A persisted full native start selection can qualify policy after a crash.
 * Legacy partial selections cannot, even when current history looks empty. */
export function policyFromControlledStarted(started: Pick<ControlledCreationStarted,
  'threadId' | 'requestedPolicy' | 'selectedEffective'>): ApprovedTaskPolicy {
  const selected = started.selectedEffective;
  if (!Object.hasOwn(selected, 'runtimeWorkspaceRoots') ||
    !Object.hasOwn(selected, 'approvalsReviewer') ||
    !Object.hasOwn(selected, 'activePermissionProfile') || !Object.hasOwn(selected, 'sandbox') ||
    !Object.hasOwn(selected, 'startThread') ||
    selected.nativeShapeExact !== true || !selected.startThread ||
    selected.startThread.status !== 'idle' || selected.startThread.turnCount !== 0) refuse();
  const startThread = selected.startThread!;
  const requested = policyTemplate(started.requestedPolicy);
  if (!requested.allowedServiceTiers.includes(selected.serviceTier) ||
    !requested.allowedEnvironments.some(item => isDeepStrictEqual(item, selected.environments))) refuse();
  const { allowedServiceTiers: _tiers, allowedEnvironments: _environments, ...fixed } = requested;
  const policy = approveTaskPolicy({ ...fixed, threadId: started.threadId,
    serviceTier: selected.serviceTier, environments: selected.environments });
  if (selected.model !== policy.model || selected.modelProvider !== policy.modelProvider ||
    selected.reasoningEffort !== policy.effort || !pathEqual(selected.cwd, policy.cwd) ||
    !isDeepStrictEqual(selected.runtimeWorkspaceRoots, policy.runtimeWorkspaceRoots) ||
    selected.approvalPolicy !== policy.approvalPolicy ||
    selected.approvalsReviewer !== policy.approvalsReviewer ||
    !isDeepStrictEqual(selected.activePermissionProfile, policy.activePermissionProfile) ||
    !isDeepStrictEqual(selected.sandbox, policy.sandbox)) refuse();
  assertEffectiveResume(policy, {
    thread: { id: started.threadId, status: { type: startThread.status },
      model: startThread.model,
      modelProvider: startThread.modelProvider,
      reasoningEffort: startThread.reasoningEffort,
      cwd: startThread.cwd, environments: selected.environments },
    model: selected.model, modelProvider: selected.modelProvider,
    reasoningEffort: selected.reasoningEffort, cwd: selected.cwd,
    runtimeWorkspaceRoots: selected.runtimeWorkspaceRoots,
    approvalPolicy: selected.approvalPolicy, approvalsReviewer: selected.approvalsReviewer,
    activePermissionProfile: selected.activePermissionProfile, sandbox: selected.sandbox,
    serviceTier: selected.serviceTier });
  return policy;
}

/** Project policy from a native start-shaped response. This is not an
 * operation-bound receipt: source, owner, generation and durable intent must
 * be independently fenced before it contributes to writer admission. */
export function projectControlledNativeStartPolicy(start: unknown,
  requestedPolicy: PolicyTemplate): Readonly<{ threadId: string; effectivePolicy: ApprovedTaskPolicy }> {
  if (!row(start)) refuse();
  const selected = start as Row;
  const thread = selected.thread as Row;
  if (!row(thread) || typeof thread.id !== 'string' || !UUID.test(thread.id)) refuse();
  const threadId = thread.id as string;
  const effectivePolicy = policyFromControlledStarted({ threadId, requestedPolicy,
    selectedEffective: selectedEffective(selected) });
  if (!requestedPolicy.allowedServiceTiers.some(tier => tier === selected.serviceTier) ||
    !requestedPolicy.allowedEnvironments.some(allowed =>
      isDeepStrictEqual(allowed, thread.environments))) refuse();
  assertEffectiveResume(effectivePolicy, selected);
  return Object.freeze({ threadId, effectivePolicy });
}

async function qualifyRead(read: Row, threadId: string, rolloutPath: string,
  policy: ApprovedTaskPolicy): Promise<void> {
  if (!row(read.thread) || read.thread.id !== threadId ||
    !row(read.thread.status) ||
    !['idle', 'notLoaded'].includes(read.thread.status.type as string) ||
    !Array.isArray(read.thread.turns) || read.thread.turns.length !== 0 ||
    !(await sameExistingFilePath(read.thread.path, rolloutPath)) ||
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

/** Shared read-only qualification used after native start and after restart. */
export async function qualifyControlledZeroTurn(options: Readonly<{
  rpc: CreatorRpc; generation: number; threadId: string; sourceId: string;
  effectivePolicy: ApprovedTaskPolicy;
  resolveSource: ControlledNativeTaskCreatorOptions['resolveSource'];
  assertCurrent?: () => void;
  retryFirstRead?: boolean;
}>): Promise<string> {
  const { rpc, generation, threadId, effectivePolicy } = options;
  const current = (): void => {
    if (!rpc.isSessionCurrent(generation)) refuse();
    options.assertCurrent?.();
  };
  current();
  const readParams = { threadId, includeTurns: true };
  // A newly accepted thread can briefly reject its first read. Retry only
  // this read-only RPC while the original session and reservation still hold.
  const firstReadDelaysMs = options.retryFirstRead === false ? [] : [150, 500];
  let read: Row | undefined;
  for (let attempt = 0; attempt <= firstReadDelaysMs.length; attempt++) {
    current();
    try {
      read = await rpc.request('thread/read', readParams, { expectedGeneration: generation });
      break;
    } catch {
      if (attempt === firstReadDelaysMs.length) throw new FirstReadRpcExhausted();
      current();
      await delay(firstReadDelaysMs[attempt]);
    }
  }
  if (!read) throw new Error('Controlled native creation unqualified');
  const observedPath = row(read.thread) ? read.thread.path : null;
  if (typeof observedPath !== 'string') throw new Error('Controlled native creation unqualified');
  const source = await options.resolveSource(threadId, observedPath);
  if (!source || source.sourceId !== options.sourceId) refuse();
  await qualifyRead(read, threadId, source.rolloutPath, effectivePolicy);
  const turns = await rpc.request('thread/turns/list', {
    threadId, limit: 100, sortDirection: 'asc', itemsView: 'full' },
    { expectedGeneration: generation });
  const goal = await rpc.request('thread/goal/get', { threadId }, { expectedGeneration: generation });
  const queue = await rpc.request('thread/queue/list', { threadId, limit: 100 },
    { expectedGeneration: generation });
  const after = await rpc.request('thread/read', readParams, { expectedGeneration: generation });
  if (!Array.isArray(turns.data) || turns.data.length !== 0 || turns.nextCursor !== null ||
    goal.goal !== null || !Array.isArray(queue.data) || queue.data.length !== 0 ||
    queue.nextCursor !== null) refuse();
  await qualifyRead(after, threadId, source.rolloutPath, effectivePolicy);
  const observedAfterPath = row(after.thread) ? after.thread.path : null;
  if (typeof observedAfterPath !== 'string') throw new Error('Controlled native creation unqualified');
  const sourceAfter = await options.resolveSource(threadId, observedAfterPath);
  if (!sourceAfter || sourceAfter.sourceId !== source.sourceId ||
    !pathEqual(sourceAfter.rolloutPath, source.rolloutPath)) refuse();
  current();
  return source.rolloutPath;
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
    options.freshReadRpc !== undefined && typeof options.freshReadRpc !== 'function' ||
    options.sourceProof?.mode !== undefined &&
      options.sourceProof.mode !== 'authenticated-profile-new-task' ||
    ![options.persistIntent, options.persistStarted, options.persistQualified,
      options.resolveSource].every(callback => typeof callback === 'function')) refuse();
  const requestedPolicy = policyTemplate(options.requestedPolicy);
  const intent = Object.freeze({ operationId: options.operationId,
    creatorNonce: randomUUID(), sourceGeneration: randomUUID(), sourceId: options.sourceId,
    ...(options.sourceProof ? { sourceProofRequired: true as const } : {}),
    ...(options.sourceProof?.mode ? { sourceProofMode: options.sourceProof.mode } : {}),
    requestedPolicy }) satisfies ControlledCreationIntent;
  const reservation = await options.persistIntent(intent);
  if (!reservation || typeof reservation.isCurrent !== 'function' ||
    reservation.isCurrent() !== true) refuse();
  let authenticatedPreflight: AuthenticatedProfileSourcePreflight | undefined;
  if (options.sourceProof) {
    const identity: ControlledNativeSourceIdentity = { operationId: intent.operationId,
      sourceId: intent.sourceId, sourceGeneration: intent.sourceGeneration };
    if (options.sourceProof.mode === 'authenticated-profile-new-task') {
      const preflight = await captureAuthenticatedProfileSourcePreflight(identity,
        options.sourceProof.sourceHome, requestedPolicy.cwd);
      if (reservation.isCurrent() !== true) refuse();
      await persistAuthenticatedProfileSourcePreflightReceipt(options.sourceProof.preflightReceiptPath, preflight);
      authenticatedPreflight = preflight;
    } else {
      const preflight = await captureControlledNativeSourcePreflight(identity,
        options.sourceProof.sourceHome, requestedPolicy.cwd);
      if (reservation.isCurrent() !== true) refuse();
      await persistControlledNativeSourcePreflightReceipt(options.sourceProof.preflightReceiptPath, preflight);
    }
    if (reservation.isCurrent() !== true) refuse();
  }
  const resolveSource = options.sourceProof
    ? controlledNativeSourceProofResolver(intent, options.sourceProof) : options.resolveSource;
  let dispatched = false;
  let phase: ControlledNativeCreationUncertainPhase = 'start-response';
  try {
    const session = await options.rpc.initializedSession();
    if (!Number.isSafeInteger(session.generation) || session.generation < 1 ||
      !options.rpc.isSessionCurrent(session.generation) || reservation.isCurrent() !== true) refuse();
    const startParams = compileControlledNativeStartParams(requestedPolicy);
    // Mark before invoking request: if transport outcome is unknown, the durable
    // intent remains the sole reconciliation key and no second start is sent.
    dispatched = true;
    const start = await options.rpc.request('thread/start', startParams, {
      mutating: true, expectedGeneration: session.generation,
      assertBeforeWrite: () => {
        if (!options.rpc.isSessionCurrent(session.generation) || reservation.isCurrent() !== true) refuse();
        if (options.sourceProof?.mode === 'authenticated-profile-new-task') {
          const preflight = authenticatedPreflight ?? refuse();
          assertAuthenticatedProfileSourcePreflightForWrite(preflight, intent,
            options.sourceProof.sourceHome, requestedPolicy.cwd);
        }
      },
    });
    const candidateId = row(start.thread) ? start.thread.id : null;
    if (typeof candidateId !== 'string' || !UUID.test(candidateId)) refuse();
    const threadId = candidateId as string;
    const started = Object.freeze({ ...intent, threadId,
      selectedEffective: selectedEffective(start) }) satisfies ControlledCreationStarted;
    phase = 'persist-started';
    await options.persistStarted(started);
    // Persist native acceptance first, then require the saved projection to
    // reproduce the initial idle, zero-turn, exact-shape policy evidence.
    phase = 'policy';
    const effectivePolicy = policyFromControlledStarted(started);
    const selectedTier = start.serviceTier;
    const selectedEnvironments = row(start.thread) ? start.thread.environments : null;
    if (!requestedPolicy.allowedServiceTiers.some(tier => tier === selectedTier) ||
      !requestedPolicy.allowedEnvironments.some(allowed => isDeepStrictEqual(allowed, selectedEnvironments))) refuse();
    assertEffectiveResume(effectivePolicy, start);
    phase = 'readback';
    let rolloutPath: string;
    try {
      rolloutPath = await qualifyControlledZeroTurn({ rpc: options.rpc,
        generation: session.generation, threadId, sourceId: intent.sourceId,
        effectivePolicy, resolveSource,
        assertCurrent: () => { if (reservation.isCurrent() !== true) refuse(); } });
    } catch (error) {
      if (!(error instanceof FirstReadRpcExhausted) || !options.freshReadRpc) throw error;
      if (reservation.isCurrent() !== true) refuse();
      let fresh: Awaited<ReturnType<NonNullable<typeof options.freshReadRpc>>> | undefined;
      try {
        const candidate = await options.freshReadRpc();
        // Do not invoke an untrusted close callback until ownership is plausible.
        if (!candidate || typeof candidate.close !== 'function' || !candidate.rpc ||
          candidate.rpc === options.rpc || typeof candidate.rpc.initializedSession !== 'function' ||
          typeof candidate.rpc.isSessionCurrent !== 'function' ||
          typeof candidate.rpc.request !== 'function') refuse();
        fresh = candidate;
        if (reservation.isCurrent() !== true) refuse();
        const allowed = new Set(['thread/read', 'thread/turns/list', 'thread/goal/get', 'thread/queue/list']);
        const readOnlyRpc: CreatorRpc = { initializedSession: () => fresh!.rpc.initializedSession(),
          isSessionCurrent: generation => fresh!.rpc.isSessionCurrent(generation),
          request: (method, params, requestOptions) => {
            if (!allowed.has(method) || requestOptions?.mutating === true) refuse();
            return fresh!.rpc.request(method, params, requestOptions);
          } };
        const freshSession = await readOnlyRpc.initializedSession();
        if (!Number.isSafeInteger(freshSession.generation) || freshSession.generation < 1 ||
          !readOnlyRpc.isSessionCurrent(freshSession.generation) || reservation.isCurrent() !== true) refuse();
        rolloutPath = await qualifyControlledZeroTurn({ rpc: readOnlyRpc,
          generation: freshSession.generation, threadId, sourceId: intent.sourceId,
          effectivePolicy, resolveSource, retryFirstRead: false,
          assertCurrent: () => { if (reservation.isCurrent() !== true) refuse(); } });
      } finally { if (fresh && typeof fresh.close === 'function') await fresh.close(); }
      if (reservation.isCurrent() !== true) refuse();
    }
    const receipt = Object.freeze({ ...started, effectivePolicy, rolloutPath,
      status: 'qualified-zero-turn' as const }) satisfies ControlledCreationReceipt;
    phase = 'persist-qualified';
    await options.persistQualified(receipt);
    return receipt;
  } catch (error) {
    if (dispatched) throw new ControlledNativeCreationUncertainError(phase);
    throw error;
  }
}
