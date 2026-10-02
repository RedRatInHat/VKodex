import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { approveTaskPolicy, type ApprovedTaskPolicy } from '../codex/managed-task-policy.js';
import type { ManagedWorkerBootstrap, StockReadState } from './managed-worker-bootstrap.js';
import type { ManagedStockInitialized } from './managed-stock-settings-initializer.js';
import { ManagedNativeStockQueueAdapter } from './managed-native-stock-queue-adapter.js';
import type { ManagedNativeStockQueueAdapterOptions } from './managed-native-stock-queue-adapter.js';
import type { ManagedNativeStockQueueAuthority, ManagedNativeStockQueueContext } from './managed-worker-native-owner.js';
import type { NativeProjectionState } from '../codex/managed-native-projection.js';

type Scope = Readonly<{ taskId: string; ownerEpoch: string; backendGeneration: number;
  sourceGeneration: string }>;
type OwnerScope = Readonly<{ taskId: string; ownerEpoch: string }>;
const fail = (): never => { throw new Error('Managed stock queue runtime unavailable'); };
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function copy<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 2_000_000) fail();
  const parsed = JSON.parse(encoded) as T;
  if (!isDeepStrictEqual(value, parsed)) fail();
  return parsed;
}
function samePath(a: unknown, b: string): boolean {
  return typeof a === 'string' &&
    path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}

/** Pure parity assertion shared by native FWE and headless VK queue ingress.
 * The caller separately proves that the owner ticket is still current. */
type QualifiedInitial = Pick<NativeProjectionState, 'latestThreadSettings' |
  'currentPermissions'> & { readonly environments?: unknown };
export function assertManagedStockReadParity(ticket: ManagedNativeStockQueueAuthority,
  read: StockReadState, initial: QualifiedInitial, policy: ApprovedTaskPolicy,
  ownerEpoch: string, generation: number): void {
  const p = ticket.projection;
  if (ticket.taskId !== policy.threadId || ticket.ownerEpoch !== ownerEpoch ||
      ticket.backendGeneration !== generation || ticket.pendingEvents !== 0 ||
      !row(p) || p.id !== policy.threadId || !row(p.threadRuntimeStatus) ||
      p.threadRuntimeStatus.type !== 'idle' ||
      !Array.isArray(p.activeTurnIds) || p.activeTurnIds.length !== 0 ||
      !Array.isArray(p.terminalTurnIds) ||
      !isDeepStrictEqual(p.terminalTurnIds, read.terminalTurnIds) ||
      read.turnCount !== p.terminalTurnIds.length ||
      read.threadId !== policy.threadId || read.generation !== generation ||
      read.model !== policy.model || read.modelProvider !== policy.modelProvider ||
      read.reasoningEffort !== policy.effort || !samePath(read.cwd, policy.cwd) ||
      !isDeepStrictEqual(read.environments, policy.environments) ||
      policy.serviceTier === null && read.fastModeAllowed !== false ||
      !samePath(p.cwd, policy.cwd) || p.latestModel !== policy.model ||
      p.latestReasoningEffort !== policy.effort ||
      !isDeepStrictEqual(p.latestThreadSettings, initial.latestThreadSettings) ||
      !isDeepStrictEqual(p.currentPermissions, initial.currentPermissions) ||
      !isDeepStrictEqual(p.environments, initial.environments ?? null)) fail();
}

export interface ManagedStockQueueRuntimeOptions {
  readonly journalPath: string;
  readonly sourceGeneration: string;
  readonly bootstrap: Pick<ManagedWorkerBootstrap, 'generation' | 'readStockState'>;
  readonly initialized: Pick<ManagedStockInitialized, 'effectiveSettings' | 'initializationReceipt' |
    'tierResolution' | 'initialState'>;
  readonly approvedTaskPolicy: ApprovedTaskPolicy;
  /** Proof from controlled native task creation, not stock queue/list or an empty journal. */
  readonly assertControlledNativeBaseline: (scope: Scope) => boolean | Promise<boolean>;
  /** Independent real owner discovery; false or uncertain refuses even empty replay. */
  readonly confirmNativeOwner: (scope: OwnerScope) => boolean | Promise<boolean>;
  readonly isOwnerCurrent: () => boolean;
  readonly admissionOpen: () => boolean;
  readonly isClientReservedOutsideQueue?: (clientId: string) => boolean;
}

/** Opt-in cold-created, homogeneous queue route on the NativeOwner's one worker.
 * Each new stock write uses a fresh exhaustive terminal/idle same-worker read;
 * the owner-created opaque ticket fences the final synchronous write. */
export function createManagedStockQueueRuntimeFactory(options: ManagedStockQueueRuntimeOptions):
  (context: Readonly<ManagedNativeStockQueueContext>) => ManagedNativeStockQueueAdapter {
  if (!options || typeof options.journalPath !== 'string' || !path.isAbsolute(options.journalPath) ||
      typeof options.sourceGeneration !== 'string' || !options.sourceGeneration ||
      !options.bootstrap || !Number.isSafeInteger(options.bootstrap.generation) ||
      options.bootstrap.generation < 1 || typeof options.bootstrap.readStockState !== 'function' ||
      !options.initialized || !options.initialized.initialState ||
      ![options.assertControlledNativeBaseline, options.confirmNativeOwner,
        options.isOwnerCurrent, options.admissionOpen].every(callback => typeof callback === 'function')) fail();
  const policy = approveTaskPolicy(options.approvedTaskPolicy);
  const taskId = policy.threadId;
  const sourceGeneration = options.sourceGeneration, journalPath = options.journalPath;
  const generation = options.bootstrap.generation;
  const readStockState = options.bootstrap.readStockState.bind(options.bootstrap);
  const assertBaseline = options.assertControlledNativeBaseline;
  const discover = options.confirmNativeOwner;
  const isOwnerCurrent = options.isOwnerCurrent, admissionOpen = options.admissionOpen;
  const effectiveSettings = copy(options.initialized.effectiveSettings);
  const initializationReceipt = copy(options.initialized.initializationReceipt);
  const tierResolution = copy(options.initialized.tierResolution);
  const initial = options.initialized.initialState;
  const qualifiedInitial = copy({ id: initial.id, cwd: initial.cwd,
    latestModel: initial.latestModel, latestReasoningEffort: initial.latestReasoningEffort,
    latestThreadSettings: initial.latestThreadSettings,
    currentPermissions: initial.currentPermissions,
    environments: initial.environments ?? null });
  if (initial.hostId !== 'local' || !Array.isArray(initial.turns) || initial.turns.length !== 0 ||
      !Array.isArray(initial.requests) || initial.requests.length !== 0 ||
      !row(initial.threadRuntimeStatus) || initial.threadRuntimeStatus.type !== 'idle' ||
      qualifiedInitial.id !== taskId || !samePath(qualifiedInitial.cwd, policy.cwd) ||
      qualifiedInitial.latestModel !== policy.model ||
      qualifiedInitial.latestReasoningEffort !== policy.effort ||
      !row(qualifiedInitial.latestThreadSettings) || !row(qualifiedInitial.currentPermissions) ||
      !isDeepStrictEqual(qualifiedInitial.environments, policy.environments) ||
      effectiveSettings.model !== policy.model || effectiveSettings.effort !== policy.effort ||
      !samePath(effectiveSettings.cwd, policy.cwd) ||
      effectiveSettings.serviceTier !== policy.serviceTier ||
      !isDeepStrictEqual(effectiveSettings.runtimeWorkspaceRoots, policy.runtimeWorkspaceRoots) ||
      !isDeepStrictEqual(effectiveSettings.sandboxPolicy, policy.sandbox) ||
      effectiveSettings.approvalPolicy !== policy.approvalPolicy ||
      effectiveSettings.approvalsReviewer !== policy.approvalsReviewer ||
      effectiveSettings.permissions !== policy.activePermissionProfile.id ||
      initializationReceipt !== null && (!row(initializationReceipt) ||
        initializationReceipt.taskId !== taskId || initializationReceipt.confirmed !== true) ||
      tierResolution !== null && (!row(tierResolution) || tierResolution.taskId !== taskId ||
        tierResolution.confirmed !== true)) fail();
  let created = false;
  return (context: Readonly<ManagedNativeStockQueueContext>): ManagedNativeStockQueueAdapter => {
    if (created || !context || context.taskId !== taskId ||
        context.backendGeneration !== generation || typeof context.ownerEpoch !== 'string' ||
        !context.ownerEpoch || !context.host || !context.controlKey ||
        typeof context.captureAuthority !== 'function' ||
        typeof context.assertCurrent !== 'function') fail();
    created = true;
    const ownerEpoch = context.ownerEpoch;
    if (initializationReceipt !== null && initializationReceipt.ownerEpoch !== ownerEpoch ||
        tierResolution !== null && tierResolution.ownerEpoch !== ownerEpoch) fail();
    const host = context.host, controlKey = context.controlKey;
    const captureAuthority = context.captureAuthority, assertCurrent = context.assertCurrent;
    const publish = context.publish, onStockQueueChanged = context.onStockQueueChanged;
    const onFailure = context.onFailure;
    const scope = Object.freeze({ taskId, ownerEpoch, backendGeneration: generation,
      sourceGeneration });
    let wireTicket: { entryId: string; ticket: ManagedNativeStockQueueAuthority } | null = null;
    const current = (): boolean => {
      try {
        const metadata = host.metadata;
        if (metadata.taskId !== taskId || metadata.backendGeneration !== generation ||
            metadata.state !== 'running' || isOwnerCurrent() !== true) return false;
        const after = host.metadata;
        return after.taskId === taskId && after.backendGeneration === generation &&
          after.state === 'running';
      } catch { return false; }
    };
    const ticketCurrent = (ticket: ManagedNativeStockQueueAuthority): boolean =>
      current() && assertCurrent(ticket) === true && current();
    const assertTicket = (ticket: ManagedNativeStockQueueAuthority): void => {
      if (!ticketCurrent(ticket)) fail();
    };
    const adapterOptions: ManagedNativeStockQueueAdapterOptions = {
      taskId, ownerEpoch, backendGeneration: generation, sourceGeneration,
      journalPath, controlKey, host,
      ...(options.isClientReservedOutsideQueue ? {
        isClientReservedOutsideQueue: options.isClientReservedOutsideQueue,
      } : {}),
      assertInitialNativeQueueBaseline: async observed => {
        if (!isDeepStrictEqual(observed, scope) || !current()) return false;
        if (await discover(Object.freeze({ taskId, ownerEpoch })) !== true || !current()) return false;
        const proof = await assertBaseline(scope);
        return proof === true && current();
      },
      qualify: async observed => {
        if (observed.taskId !== taskId || observed.ownerEpoch !== ownerEpoch || !current()) fail();
        const entryId = observed.entry === null ? null : observed.entry.id;
        if (entryId !== null && (typeof entryId !== 'string' || !entryId)) fail();
        const previous = entryId !== null && wireTicket?.entryId === entryId ? wireTicket.ticket : null;
        if (entryId !== null && previous === null && admissionOpen() !== true) fail();
        const ticket = previous ?? captureAuthority();
        assertTicket(ticket);
        const read = await readStockState(() => assertTicket(ticket));
        assertTicket(ticket);
        assertManagedStockReadParity(ticket, read, qualifiedInitial, policy, ownerEpoch, generation);
        // A same-entry requalification cannot replace its original wire fence.
        // Empty-state/hydration qualification cannot authorize a queued write.
        if (entryId !== null && previous === null) wireTicket = { entryId, ticket };
        return { taskId, ownerEpoch, confirmed: true, completeQueueAndHistory: true,
          exclusiveLifecycleWriter: true, ambientContextEmpty: true,
          effectiveSettings: copy(effectiveSettings),
          initializationReceipt: copy(initializationReceipt), tierResolution: copy(tierResolution) };
      },
      confirmOwner: async observed => {
        if (observed.taskId !== taskId || observed.ownerEpoch !== ownerEpoch || !current()) return false;
        const found = await discover(Object.freeze({ taskId, ownerEpoch }));
        return found === true && current();
      },
      assertOwnerCurrent: observed => observed.taskId === taskId &&
        observed.ownerEpoch === ownerEpoch && current(),
      assertDispatchCurrent: observed => observed.taskId === taskId &&
        observed.ownerEpoch === ownerEpoch &&
        isDeepStrictEqual(observed.effectiveSettings, effectiveSettings) &&
        wireTicket !== null && ticketCurrent(wireTicket.ticket),
      publish, onStockQueueChanged, onFailure,
    };
    return new ManagedNativeStockQueueAdapter(adapterOptions);
  };
}
