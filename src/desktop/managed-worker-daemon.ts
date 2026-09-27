import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ManagedWorkerRegistry, type ProcessIdentity, type BackendIdentity, type WorkerAttempt } from '../codex/managed-worker-registry.js';
import { ManagedWorkerFrontendHost } from '../codex/managed-worker-frontend-host.js';
import type { WorkerCommandScope, WorkerCommand } from '../codex/managed-worker-command-dispatcher.js';
import { NativeStartIntentStore } from '../codex/native-start-intent-store.js';
import { compileNativeRequestResponse } from '../codex/native-request-response.js';
import type { AppServerServerRequest } from '../codex/app-server-connection.js';
import { bootstrapManagedWorker, ManagedWorkerIdleProofRefusedError,
  type ManagedWorkerBootstrap } from './managed-worker-bootstrap.js';
import { ManagedWorkerNativeOwner } from './managed-worker-native-owner.js';
import { ManagedWorkerControlServer, ManagedWorkerStopRefusedError } from './managed-worker-control.js';
import { loadManagedWorkerPrivateState, type ManagedWorkerPrivateState } from './managed-worker-private-state.js';
import { readWindowsProcessIdentity } from './windows-process-identity.js';
import type { DesktopIpcClient, IpcRequestHandler } from './ipc-client.js';

type State = 'new' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
type Row = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: ProcessIdentity | null, b: ProcessIdentity | null): boolean =>
  !!a && !!b && a.pid === b.pid && a.birthTicks === b.birthTicks;

export interface ManagedWorkerDaemonOptions {
  readonly baseDirectory: string;
  readonly epoch: string;
  /** Local peer policy is routing only, never physical owner proof. */
  readonly allowFollower: (sourceClientId: string) => boolean;
  readonly clientFactory: (handler: IpcRequestHandler) => DesktopIpcClient;
  /** Separate trusted family evidence. A folder or single idle thread is insufficient. */
  readonly verifyFamilyQuiescent: (scope: Readonly<{ taskId: string; generation: number;
    idle: Readonly<{ turnCount: number; latestTurnId: string | null }> }>) => Promise<boolean>;
  /** Injectable seams for isolated tests, not remote control methods. */
  readonly dependencies?: Readonly<{
    loadPrivateState?: typeof loadManagedWorkerPrivateState;
    observeProcess?: typeof readWindowsProcessIdentity;
    launch?: (cliPath: string, cwd: string, home: string) => ChildProcessWithoutNullStreams;
  }>;
}
export interface ManagedWorkerDaemonMetadata {
  readonly state: State;
  readonly epoch: string;
  readonly taskId: string | null;
  readonly generation: number | null;
  readonly nativeState: string | null;
  readonly endpointRef: string | null;
  readonly failure: string | null;
}

/** Explicit, single-use read-only canary composition. Neither parent EOF nor frontend EOF stops its worker.
 * The caller supplies a separately qualified local peer policy and family proof. */
export class ManagedWorkerDaemon {
  readonly #options: ManagedWorkerDaemonOptions;
  #state: State = 'new';
  #failure: string | null = null;
  #taskId: string | null = null;
  #generation: number | null = null;
  #endpointRef: string | null = null;
  #startPromise: Promise<void> | null = null;
  #host: ManagedWorkerFrontendHost | null = null;
  #owner: ManagedWorkerNativeOwner | null = null;
  #bootstrap: ManagedWorkerBootstrap | null = null;
  #control: ManagedWorkerControlServer | null = null;
  #registry: ManagedWorkerRegistry | null = null;
  #attempt: WorkerAttempt | null = null;
  #self: ProcessIdentity | null = null;
  #backend: BackendIdentity | null = null;
  #intentStore: NativeStartIntentStore | null = null;
  #admissionOpen = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconnectPending = false;
  #reconnectDelayMs = 1_000;
  #currentOwner: (() => boolean) | null = null;

  constructor(options: ManagedWorkerDaemonOptions) {
    if (!options || !path.isAbsolute(options.baseDirectory) || !uuid.test(options.epoch) ||
      typeof options.allowFollower !== 'function' || typeof options.clientFactory !== 'function' ||
      typeof options.verifyFamilyQuiescent !== 'function')
      throw new TypeError('Daemon requires explicit local follower, IPC, and family policies');
    this.#options = Object.freeze({ ...options });
  }

  get metadata(): ManagedWorkerDaemonMetadata {
    return Object.freeze({ state: this.#state, epoch: this.#options.epoch, taskId: this.#taskId,
      generation: this.#generation, nativeState: this.#owner?.metadata.state ?? null,
      endpointRef: this.#endpointRef, failure: this.#failure });
  }

  start(): Promise<void> {
    if (this.#state === 'ready') return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== 'new') return Promise.reject(new Error('Daemon is single-use'));
    this.#startPromise = this.#startOnce();
    return this.#startPromise;
  }

  async #startOnce(): Promise<void> {
    this.#state = 'starting';
    try {
      const state = await (this.#options.dependencies?.loadPrivateState ?? loadManagedWorkerPrivateState)({
        baseDirectory: this.#options.baseDirectory, epoch: this.#options.epoch });
      const manifest = state.manifest;
      if (manifest.epoch !== this.#options.epoch || !path.isAbsolute(manifest.registryPath) ||
        !path.isAbsolute(manifest.cliPath) || !path.isAbsolute(manifest.cwd) || !path.isAbsolute(manifest.home))
        throw new Error('Private manifest scope invalid');
      this.#taskId = manifest.taskId;
      this.#registry = new ManagedWorkerRegistry(manifest.registryPath);
      const reserved = this.#registry.get(manifest.home, manifest.familyRoot);
      if (!reserved || reserved.epoch !== manifest.epoch || reserved.state !== 'reserved')
        throw new Error('Exact reserved worker epoch unavailable');
      this.#attempt = reserved;
      const observe = this.#options.dependencies?.observeProcess ?? readWindowsProcessIdentity;
      const self = observe(process.pid);
      if (!self) throw new Error('Host process birth unavailable');
      this.#self = self;
      this.#attempt = this.#registry.registerHost(reserved, self);
      await pinnedCli(manifest.cliPath, manifest.cliSha256);
      const adapterKey = {}, controlKey = {};
      const launched: { child: ChildProcessWithoutNullStreams | null } = { child: null };
      const ownerCurrent = (): boolean => {
        const row = this.#registry?.get(manifest.home, manifest.familyRoot);
        return !!row && row.epoch === manifest.epoch &&
          (row.state === 'backend_registered' || row.state === 'ready') &&
          same(row.host, this.#self) && same(row.backend, this.#backend) &&
          row.backend?.generation === this.#generation &&
          !!launched.child?.pid && launched.child.pid === this.#backend?.pid &&
          launched.child.exitCode === null && launched.child.signalCode === null;
      };
      this.#currentOwner = ownerCurrent;
      const policy = (scope: Readonly<WorkerCommandScope & WorkerCommand>): boolean => {
        if (!ownerCurrent() || scope.ownerEpoch !== manifest.epoch ||
          scope.backendGeneration !== this.#generation || scope.threadId !== manifest.taskId ||
          scope.method !== 'turn/start') return false;
        const p = scope.params;
        const environment = this.#bootstrap?.initialState.environments;
        const inheritedEnvironment = Array.isArray(environment) && environment.length === 1 &&
          isDeepStrictEqual(environment[0], { environmentId: 'local', cwd: manifest.cwd,
            runtimeWorkspaceRoots: [manifest.cwd] });
        const ordinaryLocation = p.cwd === manifest.cwd &&
          isDeepStrictEqual(p.runtimeWorkspaceRoots, [manifest.cwd]) && p.environments === undefined;
        const composerLocation = inheritedEnvironment && p.cwd === null &&
          p.runtimeWorkspaceRoots === null && isDeepStrictEqual(p.environments, environment);
        const inheritedModel = p.model === null && p.effort === null &&
          isDeepStrictEqual(p.collaborationMode, { mode: 'default', settings: {
            model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } });
        const directModel = p.model === 'gpt-5.6-sol' && p.effort === 'low';
        if (p.threadId !== manifest.taskId || !(ordinaryLocation || composerLocation) ||
          p.permissions !== ':read-only' || !(inheritedModel || directModel) ||
          p.approvalPolicy !== 'never' && p.approvalPolicy !== 'on-request' ||
          p.sandboxPolicy !== undefined && p.sandboxPolicy !== null) return false;
        // A journal-reserved dispatch may finish after new admission closes.
        if (!this.#admissionOpen) {
          const admitted = this.#host?.commandStatusForIntent(controlKey, {
            operationId: scope.operationId, method: scope.method, params: scope.params });
          return admitted?.state === 'dispatching';
        }
        return true;
      };
      const allowAnswer = (request: AppServerServerRequest, result: Row): boolean => {
        const routes: Record<string, string> = {
          'item/tool/requestUserInput': 'thread-follower-submit-user-input',
          'item/permissions/requestApproval': 'thread-follower-permissions-request-approval-response',
          'item/commandExecution/requestApproval': 'thread-follower-command-approval-decision',
          'item/fileChange/requestApproval': 'thread-follower-file-approval-decision',
        };
        const route = routes[request.method];
        if (!route || !object(request.params) || request.params.threadId !== manifest.taskId) return false;
        try {
          const params: Row = { conversationId: manifest.taskId, requestId: request.id };
          if (route.includes('decision')) params.decision = result.decision;
          else params.response = result;
          return isDeepStrictEqual(compileNativeRequestResponse(route, params, request), result);
        } catch { return false; }
      };
      this.#host = new ManagedWorkerFrontendHost({
        taskId: manifest.taskId, ownCwd: manifest.cwd, initializeRequest: manifest.initializeRequest,
        bootstrapReadMethods: ['thread/turns/list', 'config/read'],
        launch: () => {
          launched.child = (this.#options.dependencies?.launch ?? defaultLaunch)(manifest.cliPath, manifest.cwd, manifest.home);
          return launched.child;
        }, adapterKey, resumeAuthority: ({ taskId, generation }) => ({
          taskId, generation, params: manifest.resumeParams }),
        allowRequest: request => object(request.params) && request.params.threadId === manifest.taskId &&
          ['item/tool/requestUserInput', 'item/permissions/requestApproval',
            'item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method),
        allowAnswer, allowError: () => false,
        commandPolicy: { controlKey, ownerEpoch: manifest.epoch,
          journalPath: path.join(state.privateDirectory, 'operations.sqlite'),
          fingerprintKey: Buffer.from(state.keys.fingerprintKey, 'base64'),
          authorize: policy, isOwnerCurrent: ownerCurrent },
      });
      await this.#host.start();
      const meta = this.#host.metadata;
      if (!launched.child?.pid || !meta.backendGeneration) throw new Error('Backend identity unavailable');
      const observed = observe(launched.child.pid);
      if (!observed) throw new Error('Backend birth unavailable');
      this.#generation = meta.backendGeneration;
      this.#backend = { ...observed, generation: meta.backendGeneration };
      this.#attempt = this.#registry.registerBackend(this.#attempt, self, this.#backend);
      launched.child.once('exit', () => this.#backendExited());
      this.#bootstrap = await bootstrapManagedWorker({ host: this.#host, adapterKey,
        taskId: manifest.taskId, cwd: manifest.cwd, initializeRequest: manifest.initializeRequest,
        resumeParams: manifest.resumeParams });
      this.#intentStore = new NativeStartIntentStore({ filePath: path.join(state.privateDirectory, 'start-intents.sqlite'),
        ownerEpoch: manifest.epoch, backendGeneration: meta.backendGeneration, threadId: manifest.taskId,
        encryptionKey: Buffer.from(state.keys.intentKey, 'base64') });
      this.#owner = new ManagedWorkerNativeOwner({ host: this.#host, adapterKey, controlKey,
        taskId: manifest.taskId, ownerEpoch: manifest.epoch, isOwnerCurrent: ownerCurrent,
        allowFollower: this.#options.allowFollower, readInitialState: this.#bootstrap.readInitialState,
        intentStore: this.#intentStore, composerDefaults: () => ({ ...this.#bootstrap!.composerDefaults }),
        qualifyContinuation: fence => this.#bootstrap!.qualifyContinuation(fence),
        clientFactory: this.#options.clientFactory });
      await this.#owner.start();
      if (this.#owner.metadata.state !== 'connected' || !ownerCurrent()) throw new Error('Native owner unavailable');
      this.#control = new ManagedWorkerControlServer({ ownerEpoch: manifest.epoch, taskId: manifest.taskId,
        token: Buffer.from(state.keys.controlToken, 'base64').toString('base64url'),
        status: () => ({ hostState: this.#host?.metadata.state ?? 'failed',
          backendGeneration: this.#host?.metadata.backendGeneration ?? null,
          nativeState: this.#owner?.metadata.state ?? null, nativeRevision: this.#owner?.metadata.revision ?? 0 }),
        requestStop: () => this.#requestStop(controlKey, manifest.home, manifest.familyRoot, observe),
      });
      const endpoint = await this.#control.listen();
      if (!ownerCurrent()) throw new Error('Worker owner changed before publication');
      const endpointRef = randomUUID();
      await writeEndpoint(state, { schemaVersion: 1, epoch: manifest.epoch, endpointRef,
        host: self, backend: this.#backend, control: { host: endpoint.host, port: endpoint.port } });
      this.#attempt = this.#registry.markReady(this.#attempt, self, this.#backend, endpointRef);
      this.#endpointRef = endpointRef;
      this.#state = 'ready';
      this.#admissionOpen = true;
      this.#scheduleReconnect();
    } catch {
      this.#state = 'failed'; this.#failure = 'startup-unavailable';
      // No implicit worker shutdown on uncertain startup after launch.
      throw new Error('Managed worker daemon startup unavailable');
    }
  }

  #backendExited(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped' || !this.#registry ||
      !this.#attempt || !this.#self || !this.#backend) return;
    this.#admissionOpen = false;
    this.#clearReconnect();
    this.#state = 'failed'; this.#failure = 'backend-lost';
    this.#owner?.close();
    try {
      this.#attempt = this.#registry.markLost(this.#attempt, this.#self, this.#backend,
        'backend_unavailable');
    } catch { this.#failure = 'backend-loss-unconfirmed'; }
    void this.#control?.close().catch(() => {});
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  /** Rejoins only the native transport. Never launches or resumes a backend. */
  #scheduleReconnect(): void {
    this.#clearReconnect();
    if (this.#state !== 'ready') return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#state !== 'ready' || !this.#owner) return;
      let current = false;
      try { current = this.#currentOwner?.() === true; } catch { /* authority query failed closed */ }
      if (!current) {
        this.#admissionOpen = false; this.#state = 'failed'; this.#failure = 'owner-unconfirmed';
        this.#owner.close(); this.#clearReconnect();
        void this.#control?.close().catch(() => {});
        return;
      }
      if (this.#owner.metadata.state !== 'disconnected' || this.#reconnectPending) {
        if (this.#owner.metadata.state === 'connected') this.#reconnectDelayMs = 1_000;
        if (this.#owner.metadata.state === 'connected' || this.#owner.metadata.state === 'disconnected')
          this.#scheduleReconnect();
        return;
      }
      this.#reconnectPending = true;
      let reconnect: Promise<void>;
      try { reconnect = this.#owner.reconnect(); }
      catch {
        this.#reconnectPending = false; this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, 30_000);
        this.#scheduleReconnect(); return;
      }
      void reconnect.then(() => { this.#reconnectDelayMs = 1_000; }, () => {
        this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, 30_000);
      }).finally(() => { this.#reconnectPending = false; this.#scheduleReconnect(); });
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref();
  }

  async #requestStop(controlKey: object, home: string, familyRoot: string,
    observe: typeof readWindowsProcessIdentity): Promise<void> {
    if (this.#state !== 'ready' || !this.#host || !this.#owner || !this.#bootstrap ||
      !this.#registry || !this.#attempt || !this.#self || !this.#backend)
      throw new ManagedWorkerStopRefusedError();
    const host = this.#host, owner = this.#owner, generation = this.#generation;
    this.#admissionOpen = false;
    let stopIssued = false;
    try {
      const stable = () => {
        const row = this.#registry!.get(home, familyRoot);
        return !!row && row.epoch === this.#options.epoch && row.state === 'ready' &&
          row.revision === this.#attempt!.revision && same(row.host, this.#self) &&
          same(row.backend, this.#backend) && same(observe(process.pid), this.#self) &&
          same(observe(this.#backend!.pid), this.#backend) &&
          host.metadata.state === 'running' && host.metadata.backendGeneration === generation &&
          (owner.metadata.state === 'connected' || owner.metadata.state === 'disconnected');
      };
      if (!stable() || generation === null) throw new ManagedWorkerStopRefusedError();
      const revision = owner.metadata.revision;
      const receipts = host.acceptedCommandReceipts(controlKey);
      if (receipts.some(receipt => receipt.method !== 'turn/start'))
        throw new ManagedWorkerStopRefusedError();
      const expectedTurnIds = receipts.map(receipt => receipt.receiptId);
      if (new Set(expectedTurnIds).size !== expectedTurnIds.length)
        throw new ManagedWorkerStopRefusedError();
      const before = host.commandQuiescence(controlKey), requests = host.requestQuiescence(controlKey);
      if (before.inFlight || before.unconfirmed || requests.unresolved || requests.generation !== generation)
        throw new ManagedWorkerStopRefusedError();
      let idle: Readonly<{ turnCount: number; latestTurnId: string | null }>;
      try { idle = await this.#bootstrap.verifyIdle(expectedTurnIds); }
      catch (error) {
        if (error instanceof ManagedWorkerIdleProofRefusedError) throw new ManagedWorkerStopRefusedError();
        throw error;
      }
      if (await this.#options.verifyFamilyQuiescent({ taskId: this.#taskId!, generation, idle }) !== true)
        throw new ManagedWorkerStopRefusedError();
      const after = host.commandQuiescence(controlKey), pending = host.requestQuiescence(controlKey);
      if (after.inFlight || after.unconfirmed || pending.unresolved || pending.generation !== generation ||
        !isDeepStrictEqual(host.acceptedCommandReceipts(controlKey), receipts) ||
        owner.metadata.revision !== revision || !stable()) throw new ManagedWorkerStopRefusedError();
      // Retire admitted grants before the last synchronous host-stop boundary.
      this.#state = 'stopping';
      this.#clearReconnect();
      owner.close(); stopIssued = true;
      await host.stop('owner-request');
      if (same(observe(this.#backend.pid), this.#backend))
        throw new Error('Worker shutdown unconfirmed');
      this.#state = 'stopped';
      this.#intentStore?.close(); this.#registry?.close();
      // Let the control server deliver the successful stop receipt before it
      // closes the authenticated socket. EOF itself never requests shutdown.
      const retireControl = setTimeout(() => { void this.#control?.close().catch(() => {}); }, 250);
      retireControl.unref();
    } catch (error) {
      if (!stopIssued && error instanceof ManagedWorkerStopRefusedError) this.#admissionOpen = true;
      else { this.#state = 'failed'; this.#failure = 'stop-unconfirmed'; }
      throw error;
    }
  }
}

function defaultLaunch(cliPath: string, cwd: string, home: string): ChildProcessWithoutNullStreams {
  return spawn(cliPath, ['app-server', '-c', 'features.code_mode_host=true'], {
    cwd, env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}
async function pinnedCli(cliPath: string, sha256: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/iu.test(sha256)) throw new Error('CLI pin invalid');
  const stat = await lstat(cliPath);
  if (!stat.isFile() || stat.isSymbolicLink() ||
    createHash('sha256').update(await readFile(cliPath)).digest('hex') !== sha256.toLowerCase())
    throw new Error('CLI pin mismatch');
}
async function writeEndpoint(state: ManagedWorkerPrivateState, endpoint: Row): Promise<void> {
  const file = path.join(state.privateDirectory, 'endpoint.v1.json');
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(endpoint)); await handle.sync(); }
  finally { await handle.close(); }
}
