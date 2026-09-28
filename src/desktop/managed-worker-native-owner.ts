import { isDeepStrictEqual } from 'node:util';
import type { ManagedWorkerFrontendHost, ManagedWorkerNotification } from '../codex/managed-worker-frontend-host.js';
import type { RequestFrame } from '../codex/app-server-request-inbox.js';
import { compileNativeRequestResponse } from '../codex/native-request-response.js';
import type { NativeStartIntentRecord, NativeStartIntentStore } from '../codex/native-start-intent-store.js';
import { projectNativeStartIntents } from '../codex/native-start-intent-projection.js';
import type { NativeProjectionState } from '../codex/managed-native-projection.js';
import { applyNotification, projectNativeServerRequest } from '../codex/managed-native-projection.js';
import { DesktopIpcClient } from './ipc-client.js';
import type { IpcIncomingRequest, IpcObject, IpcRequestHandler } from './ipc-client.js';
import { ManagedWorkerNativeStartHandler } from './managed-worker-native-start.js';
import type { NativeStartAuthority } from './managed-worker-native-start.js';
import type { ContinuationOwnerFence, QualifiedContinuationEvidence } from './managed-worker-bootstrap.js';
import { ManagedNativeStockQueueAdapter, type ManagedNativeStockPublish } from './managed-native-stock-queue-adapter.js';
import type { NativeStockQueueQuiescence } from '../codex/native-stock-queue-journal.js';

type Host = Pick<ManagedWorkerFrontendHost, 'metadata' | 'observeNotifications' | 'executeCommandWithResponse' |
  'observePendingRequests' | 'createRequestResponder' | 'commandStatusForIntent'> &
  Partial<Pick<ManagedWorkerFrontendHost, 'commandQuiescence' | 'requestQuiescence' | 'acceptedCommandReceipts'>>;
type OwnerState = 'new' | 'bootstrapping' | 'connected' | 'disconnected' | 'failed' | 'closed';
type StartupStage = 'not-started' | 'observing' | 'reading-initial' | 'validating-initial' |
  'checking-boundary' | 'connecting' | 'ready';
type BootstrapCategory = 'status' | 'settings' | 'goal' | 'usage' | 'startup-or-warning' |
  'turn' | 'item' | 'other';
const diagnosticCap = 255;
const queueEventTailCap = 128;
function bootstrapCategory(method: unknown): BootstrapCategory {
  if (method === 'thread/status/changed') return 'status';
  if (method === 'thread/settings/updated') return 'settings';
  if (method === 'thread/goal/cleared' || method === 'thread/goal/updated') return 'goal';
  if (method === 'thread/tokenUsage/updated') return 'usage';
  if (method === 'mcpServer/startupStatus/updated' || method === 'deprecationNotice' ||
      method === 'warning') return 'startup-or-warning';
  if (typeof method === 'string' && method.startsWith('turn/')) return 'turn';
  if (typeof method === 'string' && method.startsWith('item/')) return 'item';
  return 'other';
}
type Grant = Readonly<{ requestId: string; sourceClientId: string }>;
type QueueGrant = { readonly requestId: string; readonly sourceClientId: string;
  readonly lease: object; revoked: boolean };
export interface ManagedNativeStockQueueContext {
  readonly host: Host;
  readonly controlKey: object;
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly publish: ManagedNativeStockPublish;
  readonly onStockQueueChanged: () => void;
  readonly onFailure: (reason: string) => void;
  readonly captureAuthority: () => ManagedNativeStockQueueAuthority;
  readonly assertCurrent: (ticket: ManagedNativeStockQueueAuthority) => boolean;
}
export interface ManagedNativeStockQueueAuthority {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly semanticRevision: number;
  readonly authorityRevision: number;
  readonly projection: IpcObject;
  readonly pendingEvents: 0;
}
const knownVersions = new Map<string, number>([
  ['thread-owner-discovery', 1], ['thread-follower-start-turn', 2],
  ['thread-follower-steer-turn', 1], ['thread-follower-interrupt-turn', 4],
  ['thread-follower-load-complete-history', 1], ['thread-follower-compact-thread', 1],
  ['thread-follower-update-thread-settings', 2], ['thread-follower-update-daybreak', 1],
  ['thread-follower-edit-last-user-turn', 2], ['thread-follower-command-approval-decision', 1],
  ['thread-follower-file-approval-decision', 1],
  ['thread-follower-permissions-request-approval-response', 1],
  ['thread-follower-submit-user-input', 1],
  ['thread-follower-submit-mcp-server-elicitation-response', 1],
  ['thread-follower-set-queued-follow-ups-state', 1],
]);
const replyMethods = new Set(['thread-follower-submit-user-input',
  'thread-follower-permissions-request-approval-response',
  'thread-follower-command-approval-decision', 'thread-follower-file-approval-decision']);
const object = (value: unknown): value is IpcObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => structuredClone(value);
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}
const refuse = (): Error => new Error('Native owner route unavailable');

export interface ManagedWorkerNativeOwnerOptions {
  readonly host: Host;
  readonly adapterKey: object;
  readonly controlKey: object;
  readonly taskId: string;
  readonly ownerEpoch: string;
  /** Physical writer/family proof is supplied by the caller, not inferred from a path. */
  readonly isOwnerCurrent: () => boolean;
  /** Local peer policy, not authentication or proof of native writer ownership. */
  readonly allowFollower: (sourceClientId: string) => boolean;
  /** Must return a caller-qualified, exhausted full-history, idle snapshot. No worker creation/resume. */
  readonly readInitialState: () => Promise<NativeProjectionState>;
  /** Caller manages the private encrypted store and its key independently of IPC. */
  readonly intentStore?: NativeStartIntentStore;
  /** Explicit first-turn read-only Composer opt-in; defaults must be qualified from native config. */
  readonly composerDefaults?: () => IpcObject | null;
  /** Opt-in same-worker current-policy read. Must fence every awaited RPC. */
  readonly qualifyContinuation?: (fence: () => ContinuationOwnerFence) => Promise<QualifiedContinuationEvidence>;
  readonly clientFactory?: (handler: IpcRequestHandler) => DesktopIpcClient;
  /** Explicit previously qualified native queue adapter; never enabled by default. */
  readonly queueAdapterFactory?: (context: Readonly<ManagedNativeStockQueueContext>) => ManagedNativeStockQueueAdapter;
}
export interface ManagedWorkerNativeOwnerMetadata {
  readonly state: OwnerState;
  readonly connected: boolean;
  readonly revision: number;
  readonly authorityRevision: number;
  readonly semanticRevision: number;
  readonly followerCount: number;
  /** Accepted native requests that may still qualify before any worker RPC. */
  readonly pendingNativeOperations: number;
  /** Scoped notifications/requests awaiting ordered projection. */
  readonly pendingEvents: number;
  readonly failure: string | null;
  readonly startupStage: StartupStage;
  /** Count of bootstrap events that invalidate the initial-read boundary. */
  readonly bootstrapEventCount: number;
  /** Diagnostic categories include scoped MCP startup notifications exempted below. */
  readonly bootstrapNotifications: Readonly<Record<BootstrapCategory, number>>;
  readonly bootstrapPendingRequests: number;
  readonly bootstrapBoundary: Readonly<{
    stateIsBootstrapping: boolean; hasEvents: boolean; ownerCurrent: boolean | null;
  }> | null;
}

export interface ManagedWorkerBridgeStateEvent {
  readonly seq: number;
  readonly generation: number;
  readonly state: NativeProjectionState;
}
export interface ManagedWorkerBridgeStateSubscription {
  readonly initial: ManagedWorkerBridgeStateEvent;
  /** Synchronous same-worker liveness check; never acquires a route or resumes a thread. */
  current(): boolean;
  detach(): void;
}
type BridgeStateSubscriber = Readonly<{
  listener: (event: ManagedWorkerBridgeStateEvent) => void;
  onFailure: (reason: 'owner-lost' | 'projection-failed') => void;
}>;

/** One existing worker, one native owner projection. No worker launch/stop or UI reopening. */
export class ManagedWorkerNativeOwner implements IpcRequestHandler {
  readonly #options: ManagedWorkerNativeOwnerOptions;
  readonly #followers = new Map<string, object>();
  readonly #grants = new Map<string, Grant>();
  readonly #queueGrants = new Map<string, QueueGrant>();
  readonly #queueTickets = new WeakSet<object>();
  readonly #intentCache = new Map<string, NativeStartIntentRecord>();
  readonly #deferredBroadcasts: IpcObject[] = [];
  #state: OwnerState = 'new';
  #failure: string | null = null;
  #generation: number | null = null;
  #projection: NativeProjectionState | null = null;
  #authoritySnapshot: NativeStartAuthority['snapshot'] | null = null;
  #revision = 0;
  #bridgeStateSeq = 0;
  readonly #bridgeStateSubscribers = new Set<BridgeStateSubscriber>();
  #authorityRevision = 0;
  #semanticRevision = 0;
  #queueRevision = 0;
  #bootstrapEvents = 0;
  #startupStage: StartupStage = 'not-started';
  #bootstrapNotifications: Record<BootstrapCategory, number> =
    { status: 0, settings: 0, goal: 0, usage: 0, 'startup-or-warning': 0,
      turn: 0, item: 0, other: 0 };
  #bootstrapPendingRequests = 0;
  #bootstrapBoundary: ManagedWorkerNativeOwnerMetadata['bootstrapBoundary'] = null;
  #detachObserver: (() => void) | null = null;
  #detachRequests: (() => void) | null = null;
  #client: DesktopIpcClient | null = null;
  #startHandler: ManagedWorkerNativeStartHandler | null = null;
  #queueAdapter: ManagedNativeStockQueueAdapter | null = null;
  #eventTail: Promise<void> = Promise.resolve();
  #pendingEvents = 0;
  #everAdmittedNativeMutation = false;
  #coldRetirementProof: boolean | null = null;
  #startPromise: Promise<void> | null = null;
  #reconnectPromise: Promise<void> | null = null;

  constructor(options: ManagedWorkerNativeOwnerOptions) {
    if (!options || !options.host || typeof options.host.observeNotifications !== 'function' ||
        typeof options.host.executeCommandWithResponse !== 'function' ||
        typeof options.host.observePendingRequests !== 'function' ||
        typeof options.host.createRequestResponder !== 'function' ||
        options.intentStore !== undefined && typeof options.host.commandStatusForIntent !== 'function' ||
        !options.adapterKey || typeof options.adapterKey !== 'object' ||
        !options.controlKey || typeof options.controlKey !== 'object' ||
        typeof options.taskId !== 'string' || !options.taskId ||
        typeof options.ownerEpoch !== 'string' || !/^[0-9a-f-]{36}$/iu.test(options.ownerEpoch) ||
        typeof options.isOwnerCurrent !== 'function' || typeof options.allowFollower !== 'function' ||
        typeof options.readInitialState !== 'function' ||
        options.composerDefaults !== undefined &&
          (typeof options.composerDefaults !== 'function' || !options.intentStore) ||
        options.qualifyContinuation !== undefined &&
          (typeof options.qualifyContinuation !== 'function' || !options.composerDefaults ||
            typeof options.host.commandQuiescence !== 'function' ||
            typeof options.host.requestQuiescence !== 'function' ||
            typeof options.host.acceptedCommandReceipts !== 'function') ||
        (options.clientFactory !== undefined && typeof options.clientFactory !== 'function') ||
        (options.queueAdapterFactory !== undefined && typeof options.queueAdapterFactory !== 'function')) throw refuse();
    this.#options = Object.freeze({ ...options });
  }

  get metadata(): ManagedWorkerNativeOwnerMetadata {
    return Object.freeze({ state: this.#state, connected: this.#state === 'connected',
      revision: this.#revision, authorityRevision: this.#authorityRevision,
      semanticRevision: this.#semanticRevision,
      followerCount: this.#followers.size,
      pendingNativeOperations: this.#grants.size + this.#queueGrants.size,
      pendingEvents: this.#pendingEvents, failure: this.#failure,
      startupStage: this.#startupStage,
      bootstrapEventCount: Math.min(this.#bootstrapEvents, diagnosticCap),
      bootstrapNotifications: Object.freeze({ ...this.#bootstrapNotifications }),
      bootstrapPendingRequests: this.#bootstrapPendingRequests,
      bootstrapBoundary: this.#bootstrapBoundary });
  }

  /** Subscribe before capturing the complete same-generation snapshot. Native
   * projection changes are serialized on this owner; no second reader/resume. */
  subscribeBridgeState(listener: BridgeStateSubscriber['listener'],
    onFailure: BridgeStateSubscriber['onFailure']): ManagedWorkerBridgeStateSubscription {
    if (typeof listener !== 'function' || typeof onFailure !== 'function' ||
        !this.#projection || this.#generation === null || this.#bridgeStateSeq < 1 ||
        this.#pendingEvents !== 0 || !this.#ownerCurrent() ||
        this.#options.host.metadata.state !== 'running' ||
        !['connected', 'disconnected'].includes(this.#state)) throw refuse();
    const subscriber = { listener, onFailure };
    this.#bridgeStateSubscribers.add(subscriber);
    try {
      const initial = Object.freeze({ seq: this.#bridgeStateSeq, generation: this.#generation,
        state: freezeTree(copy(this.#projection)) });
      const current = () => this.#bridgeStateSubscribers.has(subscriber) &&
        this.#generation === initial.generation && this.#bridgeStateSeq >= initial.seq &&
        this.#projection !== null && this.#ownerCurrent() &&
        this.#options.host.metadata.state === 'running' &&
        ['connected', 'disconnected'].includes(this.#state);
      return Object.freeze({ initial, current,
        detach: () => { this.#bridgeStateSubscribers.delete(subscriber); } });
    } catch (error) {
      this.#bridgeStateSubscribers.delete(subscriber);
      throw error;
    }
  }

  #bridgeStateChanged(): void {
    if (this.#bridgeStateSeq >= Number.MAX_SAFE_INTEGER) {
      this.#failBridgeStateSubscribers('projection-failed'); return;
    }
    this.#bridgeStateSeq++;
    if (this.#bridgeStateSubscribers.size === 0 || !this.#projection || this.#generation === null) return;
    let event: ManagedWorkerBridgeStateEvent;
    try { event = Object.freeze({ seq: this.#bridgeStateSeq, generation: this.#generation,
      state: freezeTree(copy(this.#projection)) }); }
    catch { this.#failBridgeStateSubscribers('projection-failed'); return; }
    for (const subscriber of [...this.#bridgeStateSubscribers]) {
      if (!this.#bridgeStateSubscribers.has(subscriber)) continue;
      try { subscriber.listener(event); }
      catch {
        this.#bridgeStateSubscribers.delete(subscriber);
        try { subscriber.onFailure('projection-failed'); } catch { /* observer only */ }
      }
    }
  }

  #failBridgeStateSubscribers(reason: 'owner-lost' | 'projection-failed'): void {
    for (const subscriber of [...this.#bridgeStateSubscribers]) {
      this.#bridgeStateSubscribers.delete(subscriber);
      try { subscriber.onFailure(reason); } catch { /* observer only */ }
    }
  }

  /** Null means native queue drain is unavailable, never an empty queue. */
  queueQuiescence(): NativeStockQueueQuiescence | null {
    if (!this.#queueAdapter || !['connected', 'disconnected'].includes(this.#state) ||
        !this.#ownerCurrent()) return null;
    try { return this.#queueAdapter.quiescence(); }
    catch { return null; }
  }

  /** Captured once before retirement clears ingress grants or closes the
   * native queue journal. This proves only that this owner admitted no native
   * mutation; it is not backend idle or process-family evidence. */
  retiredWithoutNativeIngress(): boolean {
    return (this.#state === 'closed' || this.#state === 'failed') &&
      this.#coldRetirementProof === true;
  }

  #captureColdRetirementProof(reason?: string): void {
    if (this.#coldRetirementProof !== null) return;
    // A failed initial hydrate may mean the native FWE queue was never
    // qualified empty, regardless of our local journal's zero version.
    if (reason === 'queue-hydration-failed' || this.#everAdmittedNativeMutation ||
        this.#grants.size !== 0 ||
        this.#queueGrants.size !== 0 || this.#pendingEvents !== 0) {
      this.#coldRetirementProof = false;
      return;
    }
    if (!this.#queueAdapter) { this.#coldRetirementProof = true; return; }
    try {
      const proof = this.#queueAdapter.quiescence();
      this.#coldRetirementProof = proof.taskVersion === 0 && proof.unresolved === 0 &&
        proof.unconsumed === 0;
    } catch { this.#coldRetirementProof = false; }
  }

  #ownerCurrent(): boolean {
    try {
      const meta = this.#options.host.metadata;
      return this.#generation !== null && meta.taskId === this.#options.taskId &&
        meta.backendGeneration === this.#generation &&
        ['running', 'restarting', 'frontend-unavailable'].includes(meta.state) &&
        this.#options.isOwnerCurrent() === true;
    } catch { return false; }
  }

  #queueAuthority(): ManagedNativeStockQueueAuthority {
    if (!this.#queueAdapter || !this.#projection || this.#generation === null ||
        this.#pendingEvents !== 0 || !this.#ownerCurrent() ||
        !['connected', 'disconnected'].includes(this.#state)) throw refuse();
    const ticket = Object.freeze({ taskId: this.#options.taskId, ownerEpoch: this.#options.ownerEpoch,
      backendGeneration: this.#generation, semanticRevision: this.#queueRevision,
      authorityRevision: this.#authorityRevision, projection: freezeTree(copy({
        id: this.#projection.id, cwd: this.#projection.cwd,
        latestModel: this.#projection.latestModel,
        latestReasoningEffort: this.#projection.latestReasoningEffort,
        latestThreadSettings: this.#projection.latestThreadSettings,
        currentPermissions: this.#projection.currentPermissions,
        environments: this.#projection.environments ?? null,
        threadRuntimeStatus: this.#projection.threadRuntimeStatus,
        terminalTurnIds: this.#projection.turns.filter(turn =>
          ['completed', 'interrupted', 'failed'].includes(turn.status)).map(turn => turn.turnId),
        activeTurnIds: this.#projection.turns.filter(turn =>
          !['completed', 'interrupted', 'failed'].includes(turn.status)).map(turn => turn.turnId),
      })), pendingEvents: 0 as const });
    this.#queueTickets.add(ticket);
    return ticket;
  }

  #queueAuthorityCurrent(ticket: ManagedNativeStockQueueAuthority): boolean {
    try {
      return this.#queueTickets.has(ticket) &&
        ticket.taskId === this.#options.taskId && ticket.ownerEpoch === this.#options.ownerEpoch &&
        ticket.backendGeneration === this.#generation && ticket.pendingEvents === 0 &&
        this.#pendingEvents === 0 && ticket.semanticRevision === this.#queueRevision &&
        ticket.authorityRevision === this.#authorityRevision && this.#ownerCurrent() &&
        ['connected', 'disconnected'].includes(this.#state);
    } catch { return false; }
  }

  #snapshot(state: NativeProjectionState): NativeStartAuthority['snapshot'] {
    if (!object(state) || state.id !== this.#options.taskId || state.hostId !== 'local' ||
        typeof state.cwd !== 'string' || !state.cwd ||
        typeof state.latestModel !== 'string' || !state.latestModel ||
        !object(state.currentPermissions) || !object(state.latestThreadSettings)) throw refuse();
    return copy({ id: state.id, cwd: state.cwd, latestModel: state.latestModel,
      latestReasoningEffort: state.latestReasoningEffort as string | null,
      latestServiceTier: state.latestThreadSettings.serviceTier as string | null ?? null,
      currentPermissions: state.currentPermissions,
      workspaceKind: state.workspaceKind as 'project' | 'projectless' | null ?? null,
      latestCollaborationMode: state.latestCollaborationMode });
  }

  #validateInitial(state: NativeProjectionState): NativeProjectionState {
    if (!object(state) || state.id !== this.#options.taskId || state.hostId !== 'local' ||
        !Array.isArray(state.turns) || state.turns.some(turn => !object(turn) ||
          !['completed', 'interrupted', 'failed'].includes(String(turn.status))) ||
        !Array.isArray(state.requests) || state.requests.length !== 0 ||
        Array.isArray(state.nativeQueue) && state.nativeQueue.length !== 0 ||
        Array.isArray(state.queuedFollowUps) && state.queuedFollowUps.length !== 0 ||
        !object(state.threadRuntimeStatus) || state.threadRuntimeStatus.type !== 'idle' ||
        !object(state.turnsPagination) || state.turnsPagination.hasLoadedOldest !== true ||
        state.turnsPagination.olderCursor !== null) throw refuse();
    this.#snapshot(state);
    return copy(state);
  }

  #fail(reason: string): void {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    this.#captureColdRetirementProof(reason);
    this.#state = 'failed'; this.#failure = reason;
    this.#failBridgeStateSubscribers(reason.includes('projection') ? 'projection-failed' : 'owner-lost');
    this.#followers.clear(); this.#grants.clear(); this.#queueGrants.clear();
    this.#intentCache.clear(); this.#deferredBroadcasts.length = 0;
    this.#detachObserver?.(); this.#detachObserver = null;
    this.#detachRequests?.(); this.#detachRequests = null;
    this.#queueAdapter?.close(); this.#startHandler?.close(); this.#client?.close();
  }

  #observe(event: ManagedWorkerNotification): void {
    if (this.#state === 'bootstrapping') {
      const category = bootstrapCategory(event.notification.method);
      this.#bootstrapNotifications[category] = Math.min(this.#bootstrapNotifications[category] + 1, diagnosticCap);
      // The projector already treats this exact backend startup-status event
      // as state-neutral. Only a notification from the pinned live generation
      // may be excluded from the bootstrap's no-missed-state boundary.
      if (event.notification.method === 'mcpServer/startupStatus/updated' &&
          object(event.notification.params) && event.notification.params.threadId === this.#options.taskId &&
          event.taskId === this.#options.taskId && event.generation === this.#generation) {
        const meta = this.#options.host.metadata;
        if (meta.taskId === this.#options.taskId && meta.backendGeneration === this.#generation &&
            meta.state === 'running') return;
      }
      this.#bootstrapEvents++;
      return;
    }
    if (this.#state !== 'connected' && this.#state !== 'disconnected') return;
    if (this.#queueAdapter) {
      if (this.#pendingEvents >= queueEventTailCap) { this.#fail('queue-event-overflow'); return; }
      // Fence new admissions before asynchronous attribution/projection begins.
      this.#pendingEvents++;
      if (event.notification.method !== 'thread/tokenUsage/updated') {
        this.#semanticRevision++; this.#queueRevision++;
      }
      this.#eventTail = this.#eventTail.then(async () => {
        try { await this.#observeStockEvent(event); }
        finally { this.#pendingEvents--; }
      }).catch(() => { this.#fail('queue-projection-failed'); });
      return;
    }
    if (!this.#ownerCurrent() || event.taskId !== this.#options.taskId ||
        event.generation !== this.#generation || !this.#projection) {
      this.#fail('owner-changed'); return;
    }
    try {
      // The narrow continuation path proves goal=null before ID-only resume.
      // That resume emits this no-op notification. Active-goal updates remain
      // unsupported and retire this adapter, never the running worker.
      if (this.#options.qualifyContinuation && event.notification.method === 'thread/goal/cleared' &&
          object(event.notification.params) &&
          Object.keys(event.notification.params).length === 1 &&
          event.notification.params.threadId === this.#options.taskId) return;
      const next = applyNotification(this.#projection, event.notification);
      if (next === this.#projection) return;
      if (event.notification.method !== 'thread/tokenUsage/updated' &&
          !isDeepStrictEqual(next, this.#projection)) this.#semanticRevision++;
      const settings = this.#snapshot(next);
      if (!isDeepStrictEqual(settings, this.#authoritySnapshot)) {
        this.#authoritySnapshot = settings; this.#authorityRevision++;
      }
      this.#projection = next; this.#revision++;
      this.#bridgeStateChanged();
      for (const source of this.#followers.keys()) this.#sendSnapshot(source);
    } catch { this.#fail('projection-failed'); }
  }

  async #observeStockEvent(event: ManagedWorkerNotification): Promise<void> {
    const adapter = this.#queueAdapter;
    if (!adapter || !this.#ownerCurrent() || event.taskId !== this.#options.taskId ||
        event.generation !== this.#generation || !this.#projection) { this.#fail('owner-changed'); return; }
    const current = () => this.#queueAdapter === adapter && this.#ownerCurrent() &&
      event.taskId === this.#options.taskId && event.generation === this.#generation &&
      ['connected', 'disconnected'].includes(this.#state);
    if (adapter.observeBackendNotification(event.notification, current)) return;
    const notification = event.notification;
    const params = object(notification.params) ? notification.params : null;
    if (params && this.#options.qualifyContinuation && notification.method === 'thread/goal/cleared' &&
        params.threadId === this.#options.taskId &&
        Object.keys(params).length === 1) return;
    const items: { clientId: string; turnId: string }[] = [];
    if (params?.threadId === this.#options.taskId &&
        (notification.method === 'turn/started' || notification.method === 'turn/completed') &&
        params && object(params.turn) && typeof params.turn.id === 'string' &&
        Array.isArray(params.turn.items)) {
      for (const item of params.turn.items) if (object(item) && item.type === 'userMessage' &&
          typeof item.clientId === 'string') items.push({ clientId: item.clientId, turnId: params.turn.id });
    }
    if (params?.threadId === this.#options.taskId &&
        (notification.method === 'item/started' || notification.method === 'item/completed') &&
        params && typeof params.turnId === 'string' && object(params.item) &&
        params.item.type === 'userMessage' && typeof params.item.clientId === 'string')
      items.push({ clientId: params.item.clientId, turnId: params.turnId });
    for (const item of items) await adapter.consumeUserMessage(item.clientId, item.turnId, current);
    if (!current()) throw refuse();
    // Reuse the established projection path after attribution, without another tail enqueue.
    this.#projectNotification(event);
  }

  #projectNotification(event: ManagedWorkerNotification): void {
    if (!this.#projection) throw refuse();
    const next = applyNotification(this.#projection, event.notification);
    if (next === this.#projection) return;
    if (event.notification.method !== 'thread/tokenUsage/updated' &&
        !isDeepStrictEqual(next, this.#projection)) this.#semanticRevision++;
    const settings = this.#snapshot(next);
    if (!isDeepStrictEqual(settings, this.#authoritySnapshot)) {
      this.#authoritySnapshot = settings; this.#authorityRevision++;
    }
    this.#projection = next; this.#revision++;
    this.#bridgeStateChanged();
    for (const source of this.#followers.keys()) this.#sendSnapshot(source);
  }

  #observeRequest(event: { taskId: string; generation: number; request: RequestFrame }): void {
    if (this.#state === 'bootstrapping') {
      this.#bootstrapEvents++;
      this.#bootstrapPendingRequests = Math.min(this.#bootstrapPendingRequests + 1, diagnosticCap);
      return;
    }
    if (this.#state !== 'connected' && this.#state !== 'disconnected') return;
    if (this.#queueAdapter) {
      if (this.#pendingEvents >= queueEventTailCap) { this.#fail('queue-event-overflow'); return; }
      this.#pendingEvents++; this.#semanticRevision++; this.#queueRevision++;
      this.#eventTail = this.#eventTail.then(() => {
        try { this.#projectRequest(event); }
        finally { this.#pendingEvents--; }
      }).catch(() => { this.#fail('request-projection-failed'); });
      return;
    }
    if (!this.#ownerCurrent() || event.taskId !== this.#options.taskId ||
        event.generation !== this.#generation || !this.#projection) {
      this.#fail('owner-changed'); return;
    }
    try {
      const next = projectNativeServerRequest(this.#projection, event.request);
      if (next === this.#projection) return;
      this.#semanticRevision++;
      this.#projection = next; this.#revision++;
      this.#bridgeStateChanged();
      for (const source of this.#followers.keys()) this.#sendSnapshot(source);
    } catch { this.#fail('request-projection-failed'); }
  }

  #projectRequest(event: { taskId: string; generation: number; request: RequestFrame }): void {
    if (!['connected', 'disconnected'].includes(this.#state) ||
        !this.#ownerCurrent() || event.taskId !== this.#options.taskId ||
        event.generation !== this.#generation || !this.#projection) throw refuse();
    const next = projectNativeServerRequest(this.#projection, event.request);
    if (next === this.#projection) return;
    this.#semanticRevision++; this.#projection = next; this.#revision++;
    this.#bridgeStateChanged();
    for (const source of this.#followers.keys()) this.#sendSnapshot(source);
  }

  start(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== 'new') return Promise.reject(refuse());
    this.#startPromise = this.#startOnce();
    return this.#startPromise;
  }

  async #startOnce(): Promise<void> {
    this.#state = 'bootstrapping';
    this.#startupStage = 'observing';
    try {
      const meta = this.#options.host.metadata;
      if (meta.taskId !== this.#options.taskId || meta.state !== 'running' ||
          !Number.isSafeInteger(meta.backendGeneration) || !this.#options.isOwnerCurrent()) throw refuse();
      this.#generation = meta.backendGeneration;
      this.#detachObserver = this.#options.host.observeNotifications(this.#options.adapterKey,
        event => this.#observe(event), () => this.#fail('observer-failed'));
      const detachRequests = this.#options.host.observePendingRequests(this.#options.adapterKey,
        event => this.#observeRequest(event), () => this.#fail('request-observer-failed'));
      if (this.#state !== 'bootstrapping') { detachRequests(); throw refuse(); }
      this.#detachRequests = detachRequests;
      this.#startupStage = 'reading-initial';
      const read = await this.#options.readInitialState();
      this.#startupStage = 'validating-initial';
      const initial = this.#validateInitial(read);
      this.#startupStage = 'checking-boundary';
      const stateIsBootstrapping = this.#state === 'bootstrapping';
      const hasEvents = this.#bootstrapEvents !== 0;
      // Preserve the old short-circuit: do not call an external authority
      // callback merely to populate diagnostics after an earlier refusal.
      const ownerCurrent = stateIsBootstrapping && !hasEvents ? this.#ownerCurrent() : null;
      this.#bootstrapBoundary = Object.freeze({ stateIsBootstrapping, hasEvents, ownerCurrent });
      if (!stateIsBootstrapping || hasEvents || !ownerCurrent) throw refuse();
      this.#projection = initial;
      this.#bridgeStateSeq = 1;
      this.#authoritySnapshot = this.#snapshot(initial);
      this.#revision = 1; this.#authorityRevision = 1;
      this.#semanticRevision = 1;
      this.#queueRevision = 1;
      this.#startHandler = new ManagedWorkerNativeStartHandler({
        host: this.#options.host, controlKey: this.#options.controlKey,
        taskId: this.#options.taskId, ownerEpoch: this.#options.ownerEpoch,
        authority: () => this.#authority(),
        ...(this.#options.qualifyContinuation ? {
          qualifyContinuation: (authority: NativeStartAuthority) => this.#qualifyContinuation(authority),
        } : {}),
        authorizeFollower: request => {
          const grant = this.#grants.get(request.requestId);
          return grant?.sourceClientId === request.sourceClientId && this.#ownerCurrent() &&
            this.#grants.get(request.requestId) === grant;
        },
        ...(this.#options.intentStore ? { intentStore: this.#options.intentStore,
          onAccepted: () => {
            this.#revision++; this.#semanticRevision++;
            for (const source of this.#followers.keys()) this.#sendSnapshot(source);
          } } : {}),
      });
      if (this.#options.queueAdapterFactory) {
        const generation = this.#generation!;
        this.#queueAdapter = this.#options.queueAdapterFactory(Object.freeze({
          host: this.#options.host, controlKey: this.#options.controlKey,
          taskId: this.#options.taskId, ownerEpoch: this.#options.ownerEpoch,
          backendGeneration: generation,
          publish: (messages: Parameters<ManagedNativeStockPublish>[0],
            metadata: Parameters<ManagedNativeStockPublish>[1]) => this.#publishQueue(messages, metadata),
          onStockQueueChanged: () => { this.#semanticRevision++; this.#queueRevision++; },
          onFailure: () => this.#fail('queue-attribution-failed'),
          captureAuthority: () => this.#queueAuthority(),
          assertCurrent: (ticket: ManagedNativeStockQueueAuthority) => this.#queueAuthorityCurrent(ticket),
        }));
      }
      this.#client = (this.#options.clientFactory ??
        (handler => new DesktopIpcClient(undefined, 15_000, handler)))(this);
      this.#client.onBroadcast(message => this.#broadcastReceived(message));
      this.#client.onDisconnect(() => {
        if (this.#state === 'connected') { this.#state = 'disconnected'; this.#semanticRevision++; }
        this.#followers.clear(); // Admitted grants survive this transport EOF.
        this.#deferredBroadcasts.length = 0;
      });
      this.#state = 'disconnected';
      this.#startupStage = 'connecting';
      await this.reconnect();
      this.#startupStage = 'ready';
    } catch (error) {
      if (this.#state === 'bootstrapping') this.#fail('bootstrap-failed');
      else if (this.#state !== 'disconnected' && this.#state !== 'closed') this.#fail('bootstrap-failed');
      throw error;
    }
  }

  reconnect(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    if (this.#reconnectPromise) return this.#reconnectPromise;
    if (this.#state !== 'disconnected' || !this.#client || !this.#ownerCurrent())
      return Promise.reject(refuse());
    const work = (async () => {
      await this.#client!.connect();
      if (this.#state !== 'disconnected' || !this.#ownerCurrent()) {
        this.#client!.close(); throw refuse();
      }
      this.#state = 'connected';
      this.#semanticRevision++;
      const buffered = this.#deferredBroadcasts.splice(0);
      for (const message of buffered) this.#broadcastReceived(message);
    })();
    this.#reconnectPromise = work;
    void work.then(() => { if (this.#reconnectPromise === work) this.#reconnectPromise = null; },
      () => { if (this.#reconnectPromise === work) this.#reconnectPromise = null; });
    return work;
  }

  #authority(): NativeStartAuthority | null {
    if (!this.#ownerCurrent() || !this.#authoritySnapshot || this.#generation === null ||
        !['connected', 'disconnected'].includes(this.#state)) return null;
    let composer: NativeStartAuthority['composer'];
    if (this.#options.composerDefaults) {
      composer = null;
      if (this.#projection && (this.#projection.turns.length === 0 || this.#options.qualifyContinuation)) {
        const snapshot: IpcObject = { turns: this.#projection.turns.map(turn => ({
          turnId: turn.turnId, status: turn.status,
        })) };
        for (const key of ['id', 'cwd', 'hostId', 'resumeState', 'workspaceKind', 'environments',
          'latestModel', 'latestReasoningEffort', 'latestServiceTier', 'latestThreadSettings',
          'latestCollaborationMode', 'currentPermissions', 'turnsPagination', 'threadRuntimeStatus',
          'requests', 'nativeQueue', 'queuedFollowUps']) {
          if (this.#projection[key] !== undefined) snapshot[key] = copy(this.#projection[key]);
        }
        composer = { snapshot, defaults: copy(this.#options.composerDefaults()) };
      }
    }
    return { ownerEpoch: this.#options.ownerEpoch, backendGeneration: this.#generation,
      authorityRevision: this.#authorityRevision, snapshot: copy(this.#authoritySnapshot),
      ...(this.#options.qualifyContinuation ? { semanticRevision: this.#semanticRevision } : {}),
      ...(composer === undefined ? {} : { composer }) };
  }

  async #qualifyContinuation(authority: NativeStartAuthority): Promise<QualifiedContinuationEvidence> {
    const qualifier = this.#options.qualifyContinuation;
    if (!qualifier) throw refuse();
    const fence = (): ContinuationOwnerFence => {
      if (!this.#ownerCurrent() || !this.#projection || this.#generation === null ||
          this.#semanticRevision !== authority.semanticRevision ||
          this.#authorityRevision !== authority.authorityRevision ||
          !isDeepStrictEqual(this.#authoritySnapshot, authority.snapshot) ||
          !['connected', 'disconnected'].includes(this.#state)) throw refuse();
      const command = this.#options.host.commandQuiescence!(this.#options.controlKey);
      const requests = this.#options.host.requestQuiescence!(this.#options.controlKey);
      if (requests.generation !== this.#generation) throw refuse();
      let queuedFollowUps = 0;
      for (const field of ['nativeQueue', 'queuedFollowUps']) {
        const queue = this.#projection[field];
        if (queue !== undefined && !Array.isArray(queue)) throw refuse();
        if (Array.isArray(queue)) queuedFollowUps += queue.length;
      }
      return Object.freeze({ threadId: this.#options.taskId, ownerEpoch: this.#options.ownerEpoch,
        backendGeneration: this.#generation, semanticRevision: this.#semanticRevision,
        pendingRequests: Math.max(requests.unresolved, this.#projection.requests.length),
        queuedFollowUps, inFlightCommands: command.inFlight, unconfirmedOperations: command.unconfirmed });
    };
    const before = fence();
    const receipts = this.#options.host.acceptedCommandReceipts!(this.#options.controlKey);
    if (receipts.some(receipt => receipt.method !== 'turn/start')) throw refuse();
    const result = await qualifier(fence);
    if (!isDeepStrictEqual(before, fence()) || !isDeepStrictEqual(result.owner, before) ||
        !isDeepStrictEqual(receipts, this.#options.host.acceptedCommandReceipts!(this.#options.controlKey)) ||
        !Array.isArray(result.terminalTurnIds) ||
        receipts.some(receipt => !result.terminalTurnIds.includes(receipt.receiptId))) throw refuse();
    return result;
  }

  #route(request: IpcIncomingRequest): boolean {
    const params = request.params;
    return request.hostId !== undefined && request.hostId !== 'local' ? false :
      object(params) && (params.hostId === undefined || params.hostId === 'local') &&
      params.conversationId === this.#options.taskId &&
      knownVersions.get(request.method) === request.version;
  }

  canHandle(request: IpcIncomingRequest): boolean {
    return this.#state === 'connected' && this.#route(request);
  }

  async handle(request: IpcIncomingRequest, signal: AbortSignal): Promise<IpcObject> {
    if (signal.aborted) throw refuse();
    if (!this.#route(request) || this.#state !== 'connected' || !this.#ownerCurrent()) throw refuse();
    if (request.method === 'thread-owner-discovery') return { supportsUntrustedAppInput: false };
    if (request.method === 'thread-follower-load-complete-history') {
      if (!this.#followerCurrent(request.sourceClientId)) throw refuse();
      if (!this.#sendSnapshot(request.sourceClientId)) throw refuse();
      return { revision: this.#revision };
    }
    if (replyMethods.has(request.method)) return this.#answerRequest(request);
    if (request.method === 'thread-follower-set-queued-follow-ups-state') {
      const adapter = this.#queueAdapter;
      const lease = this.#followers.get(request.sourceClientId);
      if (!adapter || !lease || !this.#followerCurrent(request.sourceClientId) ||
          this.#queueGrants.size + this.#grants.size >= 128 ||
          this.#queueGrants.has(request.requestId) || this.#grants.has(request.requestId)) throw refuse();
      const grant: QueueGrant = { requestId: request.requestId,
        sourceClientId: request.sourceClientId, lease, revoked: false };
      this.#everAdmittedNativeMutation = true;
      this.#queueGrants.set(request.requestId, grant);
      const current = () => this.#queueAdapter === adapter &&
        this.#queueGrants.get(request.requestId) === grant && !grant.revoked &&
        this.#ownerCurrent() && ['connected', 'disconnected'].includes(this.#state);
      try { return await adapter.accept(request, current); }
      finally { if (this.#queueGrants.get(request.requestId) === grant)
        this.#queueGrants.delete(request.requestId); }
    }
    if (request.method !== 'thread-follower-start-turn') throw refuse();
    // Stock repeated admission owns command ordering for this opt-in route.
    // A direct start would bypass its homogeneous settings and queue journal.
    if (this.#queueAdapter) throw refuse();
    if (!this.#followerCurrent(request.sourceClientId) || !this.#startHandler ||
        this.#grants.size + this.#queueGrants.size >= 128 ||
        this.#grants.has(request.requestId) || this.#queueGrants.has(request.requestId)) throw refuse();
    const grant: Grant = Object.freeze({ requestId: request.requestId,
      sourceClientId: request.sourceClientId });
    this.#everAdmittedNativeMutation = true;
    this.#grants.set(request.requestId, grant);
    try {
      // The incoming IPC signal controls response delivery only. Once admitted,
      // EOF cannot revoke a native write; owner/projection revocation still can.
      return await this.#startHandler.handle(request, new AbortController().signal);
    } finally { if (this.#grants.get(request.requestId) === grant) this.#grants.delete(request.requestId); }
  }

  #answerRequest(request: IpcIncomingRequest): IpcObject {
    const params = request.params;
    if (!this.#followerCurrent(request.sourceClientId)) throw refuse();
    const pending = this.#projection?.requests.find(value => value.id === params.requestId);
    if (!pending) throw refuse();
    const response = compileNativeRequestResponse(request.method, params, pending);
    // The inbox retains the sole response writer. This capability only narrows
    // its existing policy and never replaces the native frontend attachment.
    const responder = this.#options.host.createRequestResponder(this.#options.controlKey, () =>
      this.#state === 'connected' && this.#ownerCurrent() && this.#followerCurrent(request.sourceClientId) &&
      this.#projection?.requests.some(value => value.id === pending.id && value.method === pending.method) === true);
    try {
      this.#everAdmittedNativeMutation = true;
      if (!responder.answer(pending.id, response)) throw refuse();
      // Native IPC acknowledges local submission. Only serverRequest/resolved
      // may remove the projected request or mark its transcript completed.
      return { ok: true };
    } finally { responder.detach(); }
  }

  #followerCurrent(source: string): boolean {
    const lease = this.#followers.get(source);
    try { return lease !== undefined && this.#options.allowFollower(source) === true &&
      this.#followers.get(source) === lease && this.#state === 'connected'; }
    catch { return false; }
  }

  #publishQueue(messages: readonly IpcObject[], metadata: Parameters<ManagedNativeStockPublish>[1],
    target?: { source: string; lease: object }): void {
    if (!this.#client || !this.#ownerCurrent() || this.#state !== 'connected' ||
        metadata.taskId !== this.#options.taskId || metadata.ownerEpoch !== this.#options.ownerEpoch)
      throw refuse();
    const sources = target ? [target.source] : [...this.#followers.keys()];
    for (const source of sources) {
      const lease = this.#followers.get(source);
      if (!lease || target && lease !== target.lease || !this.#followerCurrent(source)) {
        if (target) throw refuse();
        continue;
      }
      try { this.#client.broadcast('thread-queued-followups-changed', 2,
        { hostId: 'local', conversationId: this.#options.taskId, messages: copy(messages) }, source); }
      catch { if (this.#followers.get(source) === lease) this.#followers.delete(source); }
    }
  }

  #sendSnapshot(source: string): boolean {
    if (!this.#projection || !this.#client || this.#state !== 'connected' || !this.#ownerCurrent()) return false;
    let published = this.#projection;
    if (this.#options.intentStore) {
      try {
        const records = new Map<string, NativeStartIntentRecord>();
        for (const turn of published.turns) for (const item of turn.items) {
          const clientId = item.type === 'userMessage' ? item.clientId : null;
          if (typeof clientId !== 'string' || !clientId || clientId.length > 128 ||
              clientId.trim() !== clientId || /[\u0000-\u001f\u007f]/u.test(clientId)) continue;
          let record = this.#intentCache.get(clientId);
          if (!record) {
            record = this.#options.intentStore.getByClientUserMessageId(clientId) ?? undefined;
            if (record) this.#intentCache.set(clientId, record);
          }
          if (record) records.set(record.operationId, record);
        }
        published = projectNativeStartIntents(published, [...records.values()].map(record => ({ record,
          operation: this.#options.host.commandStatusForIntent(this.#options.controlKey, record.intent.command) })));
      } catch { this.#fail('intent-projection-failed'); return false; }
    }
    try {
      this.#client.broadcast('thread-stream-state-changed', 11,
        { hostId: 'local', conversationId: this.#options.taskId,
          change: { type: 'snapshot', revision: this.#revision,
            conversationState: copy(published) } }, source);
      return true;
    } catch { this.#followers.delete(source); return false; }
  }

  #broadcastReceived(message: IpcObject): void {
    if (this.#state === 'disconnected' && this.#reconnectPromise) {
      const params = message.params;
      const scopedFollow = message.method === 'thread-stream-following-changed' &&
        message.version === 1 && object(params) &&
        params.conversationId === this.#options.taskId && params.hostId === 'local' &&
        typeof params.following === 'boolean' && typeof message.sourceClientId === 'string';
      const scopedStatus = message.method === 'client-status-changed' &&
        message.version === 0 && object(params) && params.status === 'disconnected' &&
        typeof message.sourceClientId === 'string' && params.clientId === message.sourceClientId;
      if (!scopedFollow && !scopedStatus) return;
      if (this.#deferredBroadcasts.length >= 128) { this.#fail('broadcast-overflow'); return; }
      this.#deferredBroadcasts.push(copy(message)); return;
    }
    if (this.#state !== 'connected' || !this.#ownerCurrent()) return;
    if (message.method === 'client-status-changed') {
      const params = message.params;
      if (message.version === 0 && object(params) && params.status === 'disconnected' &&
          typeof message.sourceClientId === 'string' && message.sourceClientId === params.clientId)
        this.#followers.delete(message.sourceClientId);
      return;
    }
    const params = message.params;
    if (message.method !== 'thread-stream-following-changed' || message.version !== 1 ||
        !object(params) || params.conversationId !== this.#options.taskId || params.hostId !== 'local' ||
        typeof message.sourceClientId !== 'string' || typeof params.following !== 'boolean') return;
    const source = message.sourceClientId;
    if (params.following) {
      try { if (this.#options.allowFollower(source) !== true) return; } catch { return; }
      // An explicit follow starts a new source lease even after transport EOF.
      // EOF itself does not revoke already admitted work.
      for (const grant of this.#queueGrants.values()) if (grant.sourceClientId === source)
        grant.revoked = true;
      const lease = {};
      this.#followers.set(source, lease);
      this.#sendSnapshot(source);
      const adapter = this.#queueAdapter;
      if (adapter) void adapter.hydrateFollower((messages, metadata) =>
        this.#publishQueue(messages, metadata, { source, lease }))
        .catch(() => {
          if (this.#state === 'closed' || this.#state === 'failed' ||
              this.#followers.get(source) !== lease) return;
          this.#fail('queue-hydration-failed');
        });
    } else {
      this.#followers.delete(source);
      for (const grant of this.#queueGrants.values()) if (grant.sourceClientId === source)
        grant.revoked = true;
    }
  }

  /** Gateway retirement never calls host.stop or closes the native worker. */
  close(): void {
    if (this.#state === 'closed') return;
    this.#captureColdRetirementProof();
    this.#state = 'closed'; this.#followers.clear(); this.#grants.clear();
    this.#failBridgeStateSubscribers('owner-lost');
    this.#queueGrants.clear(); this.#intentCache.clear();
    this.#deferredBroadcasts.length = 0;
    this.#detachObserver?.(); this.#detachObserver = null;
    this.#detachRequests?.(); this.#detachRequests = null;
    this.#queueAdapter?.close(); this.#startHandler?.close(); this.#client?.close();
  }
}
