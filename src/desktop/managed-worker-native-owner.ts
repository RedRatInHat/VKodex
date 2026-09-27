import { isDeepStrictEqual } from 'node:util';
import type { ManagedWorkerFrontendHost, ManagedWorkerNotification } from '../codex/managed-worker-frontend-host.js';
import type { NativeProjectionState } from '../codex/managed-native-projection.js';
import { applyNotification } from '../codex/managed-native-projection.js';
import { DesktopIpcClient } from './ipc-client.js';
import type { IpcIncomingRequest, IpcObject, IpcRequestHandler } from './ipc-client.js';
import { ManagedWorkerNativeStartHandler } from './managed-worker-native-start.js';
import type { NativeStartAuthority } from './managed-worker-native-start.js';

type Host = Pick<ManagedWorkerFrontendHost, 'metadata' | 'observeNotifications' | 'executeCommandWithResponse'>;
type OwnerState = 'new' | 'bootstrapping' | 'connected' | 'disconnected' | 'failed' | 'closed';
type Grant = Readonly<{ requestId: string; sourceClientId: string }>;
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
const object = (value: unknown): value is IpcObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => structuredClone(value);
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
  readonly clientFactory?: (handler: IpcRequestHandler) => DesktopIpcClient;
}
export interface ManagedWorkerNativeOwnerMetadata {
  readonly state: OwnerState;
  readonly connected: boolean;
  readonly revision: number;
  readonly authorityRevision: number;
  readonly followerCount: number;
  readonly failure: string | null;
}

/** One existing worker, one native owner projection. No worker launch/stop or UI reopening. */
export class ManagedWorkerNativeOwner implements IpcRequestHandler {
  readonly #options: ManagedWorkerNativeOwnerOptions;
  readonly #followers = new Map<string, object>();
  readonly #grants = new Map<string, Grant>();
  readonly #deferredBroadcasts: IpcObject[] = [];
  #state: OwnerState = 'new';
  #failure: string | null = null;
  #generation: number | null = null;
  #projection: NativeProjectionState | null = null;
  #authoritySnapshot: NativeStartAuthority['snapshot'] | null = null;
  #revision = 0;
  #authorityRevision = 0;
  #bootstrapEvents = 0;
  #detachObserver: (() => void) | null = null;
  #client: DesktopIpcClient | null = null;
  #startHandler: ManagedWorkerNativeStartHandler | null = null;
  #startPromise: Promise<void> | null = null;
  #reconnectPromise: Promise<void> | null = null;

  constructor(options: ManagedWorkerNativeOwnerOptions) {
    if (!options || !options.host || typeof options.host.observeNotifications !== 'function' ||
        typeof options.host.executeCommandWithResponse !== 'function' ||
        !options.adapterKey || typeof options.adapterKey !== 'object' ||
        !options.controlKey || typeof options.controlKey !== 'object' ||
        typeof options.taskId !== 'string' || !options.taskId ||
        typeof options.ownerEpoch !== 'string' || !/^[0-9a-f-]{36}$/iu.test(options.ownerEpoch) ||
        typeof options.isOwnerCurrent !== 'function' || typeof options.allowFollower !== 'function' ||
        typeof options.readInitialState !== 'function' ||
        (options.clientFactory !== undefined && typeof options.clientFactory !== 'function')) throw refuse();
    this.#options = Object.freeze({ ...options });
  }

  get metadata(): ManagedWorkerNativeOwnerMetadata {
    return Object.freeze({ state: this.#state, connected: this.#state === 'connected',
      revision: this.#revision, authorityRevision: this.#authorityRevision,
      followerCount: this.#followers.size, failure: this.#failure });
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
    this.#state = 'failed'; this.#failure = reason;
    this.#followers.clear(); this.#grants.clear(); this.#deferredBroadcasts.length = 0;
    this.#detachObserver?.(); this.#detachObserver = null;
    this.#startHandler?.close(); this.#client?.close();
  }

  #observe(event: ManagedWorkerNotification): void {
    if (this.#state === 'bootstrapping') { this.#bootstrapEvents++; return; }
    if (this.#state !== 'connected' && this.#state !== 'disconnected') return;
    if (!this.#ownerCurrent() || event.taskId !== this.#options.taskId ||
        event.generation !== this.#generation || !this.#projection) {
      this.#fail('owner-changed'); return;
    }
    try {
      const next = applyNotification(this.#projection, event.notification);
      if (next === this.#projection) return;
      const settings = this.#snapshot(next);
      if (!isDeepStrictEqual(settings, this.#authoritySnapshot)) {
        this.#authoritySnapshot = settings; this.#authorityRevision++;
      }
      this.#projection = next; this.#revision++;
      for (const source of this.#followers.keys()) this.#sendSnapshot(source);
    } catch { this.#fail('projection-failed'); }
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
    try {
      const meta = this.#options.host.metadata;
      if (meta.taskId !== this.#options.taskId || meta.state !== 'running' ||
          !Number.isSafeInteger(meta.backendGeneration) || !this.#options.isOwnerCurrent()) throw refuse();
      this.#generation = meta.backendGeneration;
      this.#detachObserver = this.#options.host.observeNotifications(this.#options.adapterKey,
        event => this.#observe(event), () => this.#fail('observer-failed'));
      const initial = this.#validateInitial(await this.#options.readInitialState());
      if (this.#state !== 'bootstrapping' || this.#bootstrapEvents !== 0 || !this.#ownerCurrent()) throw refuse();
      this.#projection = initial;
      this.#authoritySnapshot = this.#snapshot(initial);
      this.#revision = 1; this.#authorityRevision = 1;
      this.#startHandler = new ManagedWorkerNativeStartHandler({
        host: this.#options.host, controlKey: this.#options.controlKey,
        taskId: this.#options.taskId, ownerEpoch: this.#options.ownerEpoch,
        authority: () => this.#authority(),
        authorizeFollower: request => {
          const grant = this.#grants.get(request.requestId);
          return grant?.sourceClientId === request.sourceClientId && this.#ownerCurrent();
        },
      });
      this.#client = (this.#options.clientFactory ??
        (handler => new DesktopIpcClient(undefined, 15_000, handler)))(this);
      this.#client.onBroadcast(message => this.#broadcastReceived(message));
      this.#client.onDisconnect(() => {
        if (this.#state === 'connected') this.#state = 'disconnected';
        this.#followers.clear(); // Admitted grants survive this transport EOF.
        this.#deferredBroadcasts.length = 0;
      });
      this.#state = 'disconnected';
      await this.reconnect();
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
    return { ownerEpoch: this.#options.ownerEpoch, backendGeneration: this.#generation,
      authorityRevision: this.#authorityRevision, snapshot: copy(this.#authoritySnapshot) };
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
    if (request.method !== 'thread-follower-start-turn') throw refuse();
    if (!this.#followerCurrent(request.sourceClientId) || !this.#startHandler ||
        this.#grants.size >= 128 || this.#grants.has(request.requestId)) throw refuse();
    const grant: Grant = Object.freeze({ requestId: request.requestId,
      sourceClientId: request.sourceClientId });
    this.#grants.set(request.requestId, grant);
    try {
      // The incoming IPC signal controls response delivery only. Once admitted,
      // EOF cannot revoke a native write; owner/projection revocation still can.
      return await this.#startHandler.handle(request, new AbortController().signal);
    } finally { if (this.#grants.get(request.requestId) === grant) this.#grants.delete(request.requestId); }
  }

  #followerCurrent(source: string): boolean {
    try { return this.#followers.has(source) && this.#options.allowFollower(source) === true; }
    catch { return false; }
  }

  #sendSnapshot(source: string): boolean {
    if (!this.#projection || !this.#client || this.#state !== 'connected' || !this.#ownerCurrent()) return false;
    try {
      this.#client.broadcast('thread-stream-state-changed', 11,
        { hostId: 'local', conversationId: this.#options.taskId,
          change: { type: 'snapshot', revision: this.#revision,
            conversationState: copy(this.#projection) } }, source);
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
      this.#followers.set(source, {});
      this.#sendSnapshot(source);
    } else this.#followers.delete(source);
  }

  /** Gateway retirement never calls host.stop or closes the native worker. */
  close(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed'; this.#followers.clear(); this.#grants.clear();
    this.#deferredBroadcasts.length = 0;
    this.#detachObserver?.(); this.#detachObserver = null;
    this.#startHandler?.close(); this.#client?.close();
  }
}
