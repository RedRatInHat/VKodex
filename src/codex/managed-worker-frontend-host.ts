import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { AppServerConnection } from './app-server-connection.js';
import type { AppServerEnvelope } from './app-server-connection.js';
import { AppServerRequestInbox } from './app-server-request-inbox.js';
import type { PendingRequestResponder, RequestFrame, RequestInboxOptions } from './app-server-request-inbox.js';
import { PersistentFrontendSessions } from './persistent-frontend-session.js';
import { PersistentFrontendLocalTransport } from './frontend-local-transport.js';
import type { FrontendTransportMetadata } from './frontend-local-transport.js';
import { PersistentFrontendWebSocketTransport } from './frontend-websocket-transport.js';
import { ManagedWorkerCommandDispatcher, captureWorkerCommandPolicy } from './managed-worker-command-dispatcher.js';
import type { WorkerCommand, WorkerCommandPolicy, WorkerCommandResponse, WorkerCommandQuiescence,
  SettingsCommand } from './managed-worker-command-dispatcher.js';
import type { WorkerOperation, SettingsOperation } from './managed-worker-operation-journal.js';

type JsonObject = Record<string, unknown>;
type StopReason = 'owner-request' | 'test-cleanup';
type HostState = 'new' | 'starting' | 'running' | 'restarting' |
  'frontend-unavailable' | 'failed' | 'lost' | 'stopping' | 'stopped';
type ResumeAuthority = NonNullable<ConstructorParameters<typeof PersistentFrontendSessions>[0]['resumeAuthority']>;
type RequestPolicy = Pick<RequestInboxOptions, 'allowRequest' | 'allowAnswer' | 'allowError'>;
type FrontendProtocol = 'jsonl' | 'websocket';
type FrontendTransport = PersistentFrontendLocalTransport | PersistentFrontendWebSocketTransport;

export interface ManagedWorkerFrontendHostOptions extends RequestPolicy {
  /** Routing scope only; this is not proof of native writer or family ownership. */
  readonly taskId: string;
  readonly ownCwd: string;
  readonly initializeRequest: JsonObject;
  readonly bootstrapReadMethods: readonly string[];
  readonly launch: () => ChildProcessWithoutNullStreams;
  /** In-process object identity held by the authorized frontend adapter. */
  readonly adapterKey: object;
  readonly frontendPort?: number;
  /** Explicit opt-in; omitted means the existing JSONL transport. */
  readonly frontendProtocol?: FrontendProtocol;
  readonly backendTimeoutMs?: number;
  readonly trustedLocalFrontend?: boolean;
  readonly resumeAuthority?: ResumeAuthority;
  /** Explicit owner-only commands. Native frontend read/rejoin remains separate. */
  readonly commandPolicy?: WorkerCommandPolicy;
}
export interface ManagedWorkerFrontendMetadata {
  readonly taskId: string;
  readonly state: HostState;
  readonly backendGeneration: number | null;
  readonly frontend: FrontendTransportMetadata | null;
}
export interface ManagedWorkerNotification {
  readonly taskId: string;
  readonly generation: number;
  readonly notification: AppServerEnvelope;
}
export interface ManagedWorkerPendingRequest {
  readonly taskId: string;
  readonly generation: number;
  readonly request: RequestFrame;
}
export type WorkerObserverFailure = 'observer-failed' | 'backend-lost' | 'owner-stopped';

function jsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strictJsonObject(value: JsonObject): JsonObject {
  let decoded: unknown;
  try {
    const snapshot = structuredClone(value);
    const encoded = JSON.stringify(snapshot, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item))
        throw new TypeError('Non-JSON initialize request');
      return item;
    });
    decoded = JSON.parse(encoded);
    if (!isDeepStrictEqual(snapshot, decoded) || !jsonObject(decoded))
      throw new TypeError('Invalid initialize request');
  } catch { throw new TypeError('Initialize request must be strict JSON'); }
  return decoded;
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Single-thread composition host. No daemon, signal handler, or scheduler.
 * The caller must authorize explicit stop and establish live-task safety; this
 * class intentionally performs no automatic idle proof or family traversal.
 */
export class ManagedWorkerFrontendHost {
  readonly #taskId: string;
  readonly #ownCwd: string;
  readonly #initializeRequest: JsonObject;
  readonly #bootstrapReadMethods: readonly string[];
  readonly #adapterKey: object;
  readonly #frontendPort: number;
  readonly #frontendProtocol: FrontendProtocol;
  readonly #trustedLocalFrontend: boolean;
  readonly #resumeAuthority: ResumeAuthority | null;
  readonly #requestPolicy: RequestPolicy;
  readonly #rpc: AppServerConnection;
  readonly #commandPolicy: WorkerCommandPolicy | null;
  #commands: ManagedWorkerCommandDispatcher | null = null;
  #inbox: AppServerRequestInbox | null = null;
  #state: HostState = 'new';
  #launched = false;
  #stopRequested = false;
  #backendGeneration: number | null = null;
  #sessions: PersistentFrontendSessions | null = null;
  #transport: FrontendTransport | null = null;
  #startPromise: Promise<void> | null = null;
  #restartPromise: Promise<void> | null = null;
  #lossClosePromise: Promise<unknown> | null = null;
  #stopPromise: Promise<void> | null = null;
  readonly #observers = new Map<() => void, (reason: WorkerObserverFailure) => void>();

  constructor(options: ManagedWorkerFrontendHostOptions) {
    if (!options || typeof options.taskId !== 'string' || !options.taskId ||
      typeof options.ownCwd !== 'string' || !options.ownCwd ||
      !jsonObject(options.initializeRequest) ||
      !jsonObject(options.initializeRequest.clientInfo) ||
      !jsonObject(options.initializeRequest.capabilities) ||
      !Array.isArray(options.bootstrapReadMethods) ||
      !options.bootstrapReadMethods.every(method => typeof method === 'string') ||
      typeof options.launch !== 'function' ||
      !options.adapterKey || typeof options.adapterKey !== 'object' ||
      typeof options.allowRequest !== 'function' ||
      typeof options.allowAnswer !== 'function' ||
      (options.allowError !== undefined && typeof options.allowError !== 'function') ||
      (options.resumeAuthority !== undefined && typeof options.resumeAuthority !== 'function') ||
      (options.frontendProtocol !== undefined && options.frontendProtocol !== 'jsonl' &&
        options.frontendProtocol !== 'websocket') ||
      (options.trustedLocalFrontend !== undefined && typeof options.trustedLocalFrontend !== 'boolean'))
      throw new TypeError('Explicit worker/frontend host policy is required');
    const port = options.frontendPort ?? 0;
    const timeout = options.backendTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535 ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
      throw new TypeError('Invalid worker/frontend host endpoint or timeout');
    this.#taskId = options.taskId;
    this.#ownCwd = options.ownCwd;
    this.#initializeRequest = freezeTree(strictJsonObject(options.initializeRequest));
    this.#bootstrapReadMethods = Object.freeze([...options.bootstrapReadMethods]);
    this.#adapterKey = options.adapterKey;
    this.#frontendPort = port;
    this.#frontendProtocol = options.frontendProtocol ?? 'jsonl';
    this.#trustedLocalFrontend = options.trustedLocalFrontend ?? false;
    this.#resumeAuthority = options.resumeAuthority ?? null;
    this.#requestPolicy = Object.freeze({ allowRequest: options.allowRequest,
      allowAnswer: options.allowAnswer, ...(options.allowError ? { allowError: options.allowError } : {}) });
    this.#commandPolicy = options.commandPolicy === undefined ? null : captureWorkerCommandPolicy(options.commandPolicy);
    const launch = options.launch;
    this.#rpc = new AppServerConnection(() => {
      if (this.#launched) throw new Error('Worker launch is single-use');
      this.#launched = true;
      return launch();
    }, this.#initializeRequest, timeout);
    this.#rpc.onDisconnect(() => this.#loseBackend());
    // Constructor-only policy validation before any worker launch or listener.
    new PersistentFrontendSessions({ backendFactory: () => this.#rpc,
      initializeRequest: this.#initializeRequest, taskId: this.#taskId,
      ownCwd: this.#ownCwd, bootstrapReadMethods: this.#bootstrapReadMethods,
      trustedLocalFrontend: this.#trustedLocalFrontend,
      resumeAuthority: this.#resumeAuthority });
  }

  get metadata(): ManagedWorkerFrontendMetadata {
    return Object.freeze({ taskId: this.#taskId, state: this.#state,
      backendGeneration: this.#backendGeneration,
      frontend: this.#transport ? this.#transport.metadata : null });
  }

  /** Durable control outcome, not a native turn/start response. */
  executeCommand(controlKey: object, command: WorkerCommand): Promise<WorkerOperation> {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.execute(controlKey, command);
  }

  /** Sole-writer settings dispatch. Native `{}` ACK is not effective-state acceptance. */
  executeSettingsCommand(controlKey: object, command: SettingsCommand,
    beforeWrite?: () => void): Promise<SettingsOperation> {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.executeSettings(controlKey, command, beforeWrite);
  }

  settingsCommandStatus(controlKey: object, operationId: string): SettingsOperation | null {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.getSettings(controlKey, operationId);
  }

  /** Separately qualified effective-state proof; no native receipt is minted. */
  confirmSettingsCommand(controlKey: object, command: SettingsCommand): Promise<SettingsOperation> {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.confirmSettings(controlKey, command);
  }

  /** Exact native result only after durable acceptance; null means unavailable. */
  executeCommandWithResponse(controlKey: object, command: WorkerCommand,
    beforeWrite?: () => void): Promise<WorkerCommandResponse> {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.executeWithResponse(controlKey, command, beforeWrite);
  }

  commandStatus(controlKey: object, operationId: string): WorkerOperation | null {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.get(controlKey, operationId);
  }

  /** Read-only control evidence, never an idle or family-ownership proof by itself. */
  commandQuiescence(controlKey: object): WorkerCommandQuiescence {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.quiescence(controlKey);
  }

  /** Durable accepted receipt IDs, not a terminal history proof. */
  acceptedCommandReceipts(controlKey: object): ReadonlyArray<Readonly<{ method: WorkerCommand['method']; receiptId: string }>> {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.acceptedReceipts(controlKey);
  }
  /** Accepted queue identities only. The caller must prove their terminal consumption. */
  acceptedQueueInputs(controlKey: object): ReadonlyArray<Readonly<{ clientUserMessageId: string; submissionId: string }>> {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.acceptedQueueInputs(controlKey);
  }

  /** Read-only pending server-request evidence for the live generation. An
   * answered request remains counted until its responseWritten receipt. */
  requestQuiescence(controlKey: object): Readonly<{ generation: number; unresolved: number }> {
    const inbox = this.#inbox, policy = this.#commandPolicy, generation = this.#backendGeneration;
    if (!inbox || !policy || controlKey !== policy.controlKey || this.#state !== 'running' ||
        this.#stopRequested || generation === null || inbox.owner.generation !== generation ||
        !this.#rpc.isSessionCurrent(generation))
      throw new Error('Worker request control unavailable');
    return Object.freeze({ generation, unresolved: inbox.unresolvedCount() });
  }

  /** Read-only, HMAC-attested lookup of a previously reserved command intent. */
  commandStatusForIntent(controlKey: object, command: WorkerCommand): WorkerOperation | null {
    if (!this.#commands) throw new Error('Worker command control unavailable');
    return this.#commands.getForIntent(controlKey, command);
  }

  /** Same-worker scoped observation, independent of frontend socket lifetime.
   * This is a live subscription, not a durable event journal or history read.
   * Listeners must apply events synchronously; failure retires that observer.
   * Bootstrap/revision reconciliation belongs to the projection owner, which
   * must invalidate its projection on failure, not keep publishing stale state. */
  observeNotifications(adapterKey: object,
    listener: (event: ManagedWorkerNotification) => void,
    onFailure: (reason: WorkerObserverFailure) => void): () => void {
    if (adapterKey !== this.#adapterKey || typeof listener !== 'function' || typeof onFailure !== 'function')
      throw new TypeError('Unauthorized worker observer');
    const generation = this.#backendGeneration;
    if (this.#state !== 'running' || generation === null || !this.#rpc.isSessionCurrent(generation))
      throw new Error('Worker observation unavailable');
    let active = true;
    const remove = this.#rpc.onNotification(notification => {
      if (!active || this.#stopRequested || !this.#rpc.isSessionCurrent(generation) ||
          !['running', 'restarting', 'frontend-unavailable'].includes(this.#state)) return;
      const params = notification.params;
      const started = notification.method === 'thread/started' && jsonObject(params.thread)
        ? params.thread : null;
      if ((params.threadId ?? started?.id) !== this.#taskId ||
          started !== null && started.id !== this.#taskId) return;
      // A faulty renderer cannot mutate another observer's event or kill RPC.
      try {
        const result: unknown = listener({ taskId: this.#taskId, generation,
          notification: structuredClone(notification) });
        if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
            'then' in result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(() => {});
          failObserver('observer-failed');
        }
      } catch { failObserver('observer-failed'); }
    });
    const detach = () => {
      if (!active) return;
      active = false; remove(); this.#observers.delete(detach);
    };
    const failObserver = (reason: WorkerObserverFailure) => {
      if (!active) return;
      detach();
      // Even a failure reporter cannot reject into the backend's event loop.
      try { void Promise.resolve(onFailure(reason)).catch(() => {}); } catch { /* isolated callback */ }
    };
    this.#observers.set(detach, failObserver);
    return detach;
  }

  #detachObservers(reason: WorkerObserverFailure): void {
    for (const failObserver of this.#observers.values()) failObserver(reason);
  }

  /** Observe inbox requests without replacing the persistent frontend attachment. */
  observePendingRequests(adapterKey: object, listener: (event: ManagedWorkerPendingRequest) => void,
    onFailure: (reason: WorkerObserverFailure) => void): () => void {
    if (adapterKey !== this.#adapterKey || typeof listener !== 'function' || typeof onFailure !== 'function')
      throw new TypeError('Unauthorized pending-request observer');
    const inbox = this.#inbox; const generation = this.#backendGeneration;
    if (!inbox || this.#state !== 'running' || generation === null || !this.#rpc.isSessionCurrent(generation))
      throw new Error('Pending request observation unavailable');
    let active = true; let inboxDetach: (() => void) | null = null;
    const detach = () => {
      if (!active) return;
      active = false; inboxDetach?.(); this.#observers.delete(detach);
    };
    const failed = (reason: WorkerObserverFailure) => {
      if (!active) return;
      detach(); try { void Promise.resolve(onFailure(reason)).catch(() => {}); } catch { /* isolated */ }
    };
    // Register host retirement before Inbox's synchronous replay can re-enter stop/loss.
    this.#observers.set(detach, failed);
    try {
      const received = inbox.observePending(frame => {
        if (!active || !['running', 'restarting', 'frontend-unavailable'].includes(this.#state) || this.#stopRequested ||
            !this.#rpc.isSessionCurrent(generation)) return;
        try {
          const returned: unknown = listener(Object.freeze({ taskId: this.#taskId, generation, request: structuredClone(frame) }));
          if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') &&
              'then' in returned && typeof returned.then === 'function') {
            void Promise.resolve(returned).catch(() => {}); failed('observer-failed');
          }
        } catch { failed('observer-failed'); }
      }, () => failed('observer-failed'));
      inboxDetach = received;
      if (!active) received();
    } catch (error) { failed('observer-failed'); throw error; }
    return detach;
  }

  /** Capability for an owner command policy; it neither exposes Inbox nor replaces its attachment. */
  createRequestResponder(controlKey: object, isAuthorized: () => boolean = () => true): PendingRequestResponder {
    if (typeof isAuthorized !== 'function') throw new TypeError('Request responder authority required');
    const inbox = this.#inbox; const policy = this.#commandPolicy; const generation = this.#backendGeneration;
    if (!inbox || !policy || controlKey !== policy.controlKey ||
      !['running', 'restarting', 'frontend-unavailable'].includes(this.#state) || generation === null)
      throw new Error('Worker request responder unavailable');
    const authorized = (): boolean => {
      if (this.#stopRequested || !['running', 'restarting', 'frontend-unavailable'].includes(this.#state) || this.#backendGeneration !== generation ||
          !this.#rpc.isSessionCurrent(generation)) return false;
      const scope = { ownerEpoch: policy.ownerEpoch, backendGeneration: generation, threadId: this.#taskId };
      let current = false; let narrow = false;
      try { current = policy.isOwnerCurrent(scope) === true; if (current) narrow = isAuthorized() === true; }
      catch { return false; }
      if (!(current && narrow)) return false;
      try { if (policy.isOwnerCurrent(scope) !== true) return false; } catch { return false; }
      return !this.#stopRequested && ['running', 'restarting', 'frontend-unavailable'].includes(this.#state) &&
        this.#backendGeneration === generation && this.#rpc.isSessionCurrent(generation);
    };
    return inbox.createResponder(authorized);
  }

  /** The token is available only to the caller holding the constructor's key. */
  frontendCapability(adapterKey: object): Readonly<{ host: string; port: number; token: string }> {
    if (adapterKey !== this.#adapterKey) throw new TypeError('Unauthorized frontend adapter');
    if (this.#frontendProtocol !== 'jsonl') throw new Error('JSONL frontend protocol unavailable');
    if (this.#state !== 'running' || !this.#transport?.address)
      throw new Error('Frontend listener unavailable');
    const address = this.#transport.address;
    return Object.freeze({ host: address.address, port: address.port,
      token: this.#transport.authToken() });
  }

  /** Native CLI WebSocket bearer, never returned by the JSONL capability API. */
  frontendWebSocketCapability(adapterKey: object): Readonly<{
    protocol: 'websocket'; host: string; port: number; token: string;
  }> {
    if (adapterKey !== this.#adapterKey) throw new TypeError('Unauthorized frontend adapter');
    if (this.#frontendProtocol !== 'websocket') throw new Error('WebSocket frontend protocol unavailable');
    if (this.#state !== 'running' || !this.#transport?.address)
      throw new Error('Frontend listener unavailable');
    const address = this.#transport.address;
    return Object.freeze({ protocol: 'websocket', host: address.address, port: address.port,
      token: this.#transport.authToken() });
  }

  start(): Promise<void> {
    if (this.#stopRequested) return Promise.reject(new Error('Host is stopping'));
    if (this.#state === 'running') return Promise.resolve();
    if (this.#state === 'lost' || this.#state === 'frontend-unavailable' ||
      this.#state === 'failed' || this.#state === 'restarting')
      return Promise.reject(new Error('Host frontend unavailable'));
    if (!this.#startPromise) this.#startPromise = this.#startOnce();
    return this.#startPromise;
  }
  #isLost(): boolean { return this.#state === 'lost'; }

  async #startOnce(): Promise<void> {
    this.#state = 'starting';
    try {
      const session = await this.#rpc.initializedSession();
      if (this.#stopRequested || this.#isLost() ||
        !this.#rpc.isSessionCurrent(session.generation)) throw new Error('Worker startup superseded');
      this.#backendGeneration = session.generation;
      if (this.#commandPolicy) this.#commands = new ManagedWorkerCommandDispatcher(
        this.#rpc, this.#taskId, session.generation, this.#commandPolicy, () =>
          !this.#stopRequested && ['running', 'restarting', 'frontend-unavailable'].includes(this.#state));
      const inbox = new AppServerRequestInbox({ threadId: this.#taskId,
        generation: session.generation,
        isGenerationCurrent: generation => this.#rpc.isSessionCurrent(generation),
        ...this.#requestPolicy });
      this.#inbox = inbox;
      // Exactly one backend handler. This host owns its private RPC instance.
      this.#rpc.onServerRequest((request, context) => inbox.handle(request, context));
      this.#sessions = new PersistentFrontendSessions({
        backendFactory: initializeRequest => {
          if (!isDeepStrictEqual(initializeRequest, this.#initializeRequest))
            throw new TypeError('Frontend initialize request changed');
          return this.#rpc;
        },
        initializeRequest: this.#initializeRequest, taskId: this.#taskId,
        ownCwd: this.#ownCwd, bootstrapReadMethods: this.#bootstrapReadMethods,
        trustedLocalFrontend: this.#trustedLocalFrontend,
        resumeAuthority: this.#resumeAuthority, requestInbox: inbox,
      });
      await this.#listenFrontend();
    } catch (error) {
      if (!this.#stopRequested && !this.#isLost())
        this.#state = this.#backendGeneration === null ? 'failed' : 'frontend-unavailable';
      throw error;
    }
  }

  async #listenFrontend(): Promise<void> {
    const sessions = this.#sessions;
    if (!sessions || this.#stopRequested || this.#isLost())
      throw new Error('Frontend listener superseded');
    const transport = this.#frontendProtocol === 'websocket'
      ? new PersistentFrontendWebSocketTransport({ sessions, host: '127.0.0.1', port: this.#frontendPort })
      : new PersistentFrontendLocalTransport({ sessions, host: '127.0.0.1', port: this.#frontendPort });
    this.#transport = transport;
    try {
      await transport.listen();
      if (this.#stopRequested || this.#isLost() ||
        this.#backendGeneration === null || !this.#rpc.isSessionCurrent(this.#backendGeneration))
        throw new Error('Frontend listener superseded');
      this.#state = 'running';
    } catch (error) {
      await transport.close().catch(() => {});
      if (this.#transport === transport) this.#transport = null;
      throw error;
    }
  }

  restartFrontend(): Promise<void> {
    if (this.#restartPromise) return this.#restartPromise;
    if ((this.#state !== 'running' && this.#state !== 'frontend-unavailable') ||
      this.#stopRequested || !this.#startPromise || !this.#sessions ||
      this.#backendGeneration === null || !this.#rpc.isSessionCurrent(this.#backendGeneration))
      return Promise.reject(new Error('Frontend restart unavailable'));
    const work = this.#restartOnce();
    this.#restartPromise = work;
    void work.then(() => { if (this.#restartPromise === work) this.#restartPromise = null; },
      () => { if (this.#restartPromise === work) this.#restartPromise = null; });
    return work;
  }

  async #restartOnce(): Promise<void> {
    this.#state = 'restarting';
    const previous = this.#transport;
    this.#transport = null;
    try {
      await previous?.close();
      if (this.#stopRequested || this.#isLost()) throw new Error('Frontend restart superseded');
      await this.#listenFrontend();
    } catch (error) {
      if (!this.#stopRequested && !this.#isLost()) this.#state = 'frontend-unavailable';
      throw error;
    }
  }

  #loseBackend(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') return;
    this.#state = 'lost';
    this.#detachObservers('backend-lost');
    const transport = this.#transport;
    this.#transport = null;
    if (transport) this.#lossClosePromise = transport.close().then(() => null, error => error as unknown);
  }

  /** Explicit owner action only. Caller must authorize and check live-task safety. */
  stop(reason: StopReason): Promise<void> {
    if (reason !== 'owner-request' && reason !== 'test-cleanup')
      return Promise.reject(new TypeError('Explicit stop reason required'));
    if (!this.#stopPromise) {
      this.#stopRequested = true;
      this.#state = 'stopping';
      this.#stopPromise = (async () => {
        const transport = this.#transport;
        this.#transport = null;
        let closeFailure: unknown = null;
        // close() synchronously invalidates the RPC generation and rejects
        // initialize, even if listener close is still waiting on a bind race.
        const rpcClose = this.#rpc.close().then(() => null, error => error as unknown);
        try { await transport?.close(); } catch (error) { closeFailure = error; }
        const rpcCloseFailure = await rpcClose;
        try { await this.#commands?.close(); } catch (error) { closeFailure ??= error; }
        this.#commandPolicy?.fingerprintKey.fill(0);
        const lossCloseFailure = await this.#lossClosePromise;
        closeFailure ??= rpcCloseFailure;
        closeFailure ??= lossCloseFailure;
        await this.#startPromise?.catch(() => {});
        await this.#restartPromise?.catch(() => {});
        this.#state = closeFailure === null ? 'stopped' : 'failed';
        if (closeFailure !== null) throw closeFailure;
      })();
      // Publish the single stop promise before invoking caller callbacks.
      this.#detachObservers('owner-stopped');
    }
    return this.#stopPromise;
  }
}
