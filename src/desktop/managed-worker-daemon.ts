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
import { bootstrapManagedWorker,
  type ManagedWorkerBootstrap, type ContinuationOwnerFence } from './managed-worker-bootstrap.js';
import { ManagedWorkerNativeOwner, type ManagedWorkerNativeOwnerMetadata } from './managed-worker-native-owner.js';
import { ManagedWorkerControlServer, ManagedWorkerStopRefusedError,
  type ManagedWorkerControlOptions, type ManagedWorkerControlDiagnosis } from './managed-worker-control.js';
import { loadManagedWorkerPrivateState, type ManagedWorkerPrivateState } from './managed-worker-private-state.js';
import { readWindowsProcessIdentity } from './windows-process-identity.js';
import { buildBackendWorkerSpawnOptions } from './managed-worker-environment.js';
import { createManagedStockSettingsInitializer, type ManagedStockSettingsInitializer } from './managed-stock-settings-initializer.js';
import { createManagedStockQueueRuntimeFactory } from './managed-stock-queue-runtime.js';
import { confirmManagedNativeOwner } from './managed-native-owner-confirmation.js';
import { managedStockCommandId } from './managed-native-stock-queue-adapter.js';
import { ManagedStockVkSubmitter, type ManagedStockVkLease } from './managed-stock-vk-submit.js';
import type { SubmitTaskRequest } from '../core/codex-tasks.js';
import type { DesktopIpcClient, IpcRequestHandler } from './ipc-client.js';

type State = 'new' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
type Row = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: ProcessIdentity | null, b: ProcessIdentity | null): boolean =>
  !!a && !!b && a.pid === b.pid && a.birthTicks === b.birthTicks;
type BootstrapFailureCode = NonNullable<ManagedWorkerControlDiagnosis['bootstrapFailureCode']>;
const recognizedBootstrapCodes = new Set<BootstrapFailureCode>([
  'thread-read-unqualified', 'pre-resume-history-not-empty',
  'resume-settings-unqualified', 'goal-or-queue-not-empty',
  'initial-projection-unqualified', 'actual-thread-settings-drift',
  'config-defaults-unavailable', 'config-defaults-unqualified',
  'initial-history-not-empty', 'initial-settings-drift',
]);
function bootstrapFailureCode(error: unknown): BootstrapFailureCode {
  if (error instanceof TypeError &&
      error.message === 'Native effective resume differs from approved task policy')
    return 'effective-resume-policy-mismatch';
  if (error instanceof TypeError && error.message.startsWith('managed worker bootstrap: ')) {
    const code = error.message.slice('managed worker bootstrap: '.length) as BootstrapFailureCode;
    if (recognizedBootstrapCodes.has(code)) return code;
  }
  return 'unclassified';
}

export interface ManagedWorkerDaemonOptions {
  readonly baseDirectory: string;
  readonly epoch: string;
  /** Local peer policy is routing only, never physical owner proof. */
  readonly allowFollower: (sourceClientId: string) => boolean;
  readonly clientFactory: (handler: IpcRequestHandler) => DesktopIpcClient;
  /** Separate trusted family evidence. A folder or single idle thread is insufficient. */
  readonly verifyFamilyQuiescent: (scope: Readonly<{ taskId: string; generation: number;
    idle: Readonly<{ turnCount: number; latestTurnId: string | null }> }>) => Promise<boolean>;
  /** Explicit, controlled native stock queue route. Absent preserves the legacy canary. */
  readonly nativeStockQueue?: Readonly<{
    sourceGeneration: string;
    assertControlledNativeBaseline: (scope: Readonly<{ taskId: string; ownerEpoch: string;
      backendGeneration: number; sourceGeneration: string }>) => boolean | Promise<boolean>;
    createProbeClient: () => DesktopIpcClient;
    /** Internal capability only. No daemon control or native IPC route is added. */
    headlessVk?: Readonly<{ capability: object; sourceId: string }>;
  }>;
  /** Injectable seams for isolated tests, not remote control methods. */
  readonly dependencies?: Readonly<{
    loadPrivateState?: typeof loadManagedWorkerPrivateState;
    observeProcess?: typeof readWindowsProcessIdentity;
    launch?: (cliPath: string, cwd: string, home: string) => ChildProcessWithoutNullStreams;
    createControl?: (options: ManagedWorkerControlOptions) => ManagedWorkerControlServer;
    backendTimeoutMs?: number;
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
  readonly bootstrapFailureCode: BootstrapFailureCode | null;
  readonly startupPhase: ManagedWorkerControlDiagnosis['startupPhase'];
  readonly nativeStartup: Pick<ManagedWorkerNativeOwnerMetadata,
    'startupStage' | 'bootstrapEventCount' | 'bootstrapNotifications' |
    'bootstrapPendingRequests' | 'bootstrapBoundary'> | null;
}

/** Explicit single-use managed worker. The optional native stock queue route
 * requires its own approved task policy, owner discovery and controlled baseline.
 * Neither parent EOF nor frontend EOF stops the worker. */
export class ManagedWorkerDaemon {
  readonly #options: ManagedWorkerDaemonOptions;
  #state: State = 'new';
  #failure: ManagedWorkerControlDiagnosis['failureCode'] = null;
  #bootstrapFailureCode: BootstrapFailureCode | null = null;
  #startupPhase: ManagedWorkerControlDiagnosis['startupPhase'] = 'not-started';
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
  #stockInitializer: ManagedStockSettingsInitializer | null = null;
  #vkSubmitter: ManagedStockVkSubmitter | null = null;
  #headlessPending = 0;
  #admissionOpen = false;
  #everReady = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconnectPending = false;
  #reconnectDelayMs = 1_000;
  #currentOwner: (() => boolean) | null = null;

  constructor(options: ManagedWorkerDaemonOptions) {
    if (!options || !path.isAbsolute(options.baseDirectory) || !uuid.test(options.epoch) ||
      typeof options.allowFollower !== 'function' || typeof options.clientFactory !== 'function' ||
      typeof options.verifyFamilyQuiescent !== 'function')
      throw new TypeError('Daemon requires explicit local follower, IPC, and family policies');
    const stock = options.nativeStockQueue;
    if (stock !== undefined && (!object(stock) ||
      !isDeepStrictEqual(Object.keys(stock).sort(),
        ['assertControlledNativeBaseline', 'createProbeClient', 'sourceGeneration',
          ...(stock.headlessVk === undefined ? [] : ['headlessVk'])].sort()) ||
      typeof stock.sourceGeneration !== 'string' || !stock.sourceGeneration ||
      stock.sourceGeneration.length > 128 || /[\x00-\x1f\x7f]/u.test(stock.sourceGeneration) ||
      typeof stock.assertControlledNativeBaseline !== 'function' ||
      typeof stock.createProbeClient !== 'function' ||
      stock.headlessVk !== undefined && (!object(stock.headlessVk) ||
        !isDeepStrictEqual(Object.keys(stock.headlessVk).sort(), ['capability', 'sourceId']) ||
        !stock.headlessVk.capability || typeof stock.headlessVk.capability !== 'object' ||
        typeof stock.headlessVk.sourceId !== 'string' ||
        stock.headlessVk.sourceId.length > 256 || /[\x00-\x1f\x7f]/u.test(stock.headlessVk.sourceId))))
      throw new TypeError('Explicit managed native stock queue policy invalid');
    this.#options = Object.freeze({ ...options,
      ...(stock ? { nativeStockQueue: Object.freeze({ ...stock,
        ...(stock.headlessVk ? { headlessVk: Object.freeze({ ...stock.headlessVk }) } : {}) }) } : {}) });
  }

  get metadata(): ManagedWorkerDaemonMetadata {
    const owner = this.#owner?.metadata;
    return Object.freeze({ state: this.#state, epoch: this.#options.epoch, taskId: this.#taskId,
      generation: this.#generation, nativeState: owner?.state ?? null,
      endpointRef: this.#endpointRef, failure: this.#failure,
      bootstrapFailureCode: this.#bootstrapFailureCode,
      startupPhase: this.#startupPhase,
      nativeStartup: owner ? Object.freeze({ startupStage: owner.startupStage,
        bootstrapEventCount: owner.bootstrapEventCount,
        bootstrapNotifications: owner.bootstrapNotifications,
        bootstrapPendingRequests: owner.bootstrapPendingRequests,
        bootstrapBoundary: owner.bootstrapBoundary }) : null });
  }

  /** Capability-bound in-process seam. There is deliberately no TCP/control method. */
  submitVk(capability: object, request: SubmitTaskRequest): Promise<Readonly<{ submissionId: string }>> {
    if (!this.#vkSubmitter || this.#state !== 'ready')
      return Promise.reject(new Error('Managed VK stock ingress unavailable'));
    return this.#vkSubmitter.submit(capability, request);
  }

  /** Read-only exact-intent lookup remains available for late response
   * reconciliation even when fresh command admission has closed. */
  vkSubmissionStatus(capability: object, request: SubmitTaskRequest) {
    if (!this.#vkSubmitter) throw new Error('Managed VK stock ingress unavailable');
    return this.#vkSubmitter.status(capability, request);
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
    let launchAttempted = false;
    try {
      const state = await (this.#options.dependencies?.loadPrivateState ?? loadManagedWorkerPrivateState)({
        baseDirectory: this.#options.baseDirectory, epoch: this.#options.epoch });
      const manifest = state.manifest;
      if (manifest.epoch !== this.#options.epoch || !path.isAbsolute(manifest.registryPath) ||
        !path.isAbsolute(manifest.cliPath) || !path.isAbsolute(manifest.cwd) || !path.isAbsolute(manifest.home))
        throw new Error('Private manifest scope invalid');
      if (this.#options.nativeStockQueue && !manifest.approvedTaskPolicy)
        throw new Error('Managed native stock queue requires explicit approved task policy');
      this.#taskId = manifest.taskId;
      this.#startupPhase = 'private-loaded';
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
      this.#startupPhase = 'host-registered';
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
      const currentRegistryState = (): ManagedWorkerControlDiagnosis['registryState'] => {
        try {
          const row = this.#registry?.get(manifest.home, manifest.familyRoot);
          return row?.epoch === manifest.epoch ? row.state : null;
        } catch { return null; }
      };
      this.#control = (this.#options.dependencies?.createControl ??
        (options => new ManagedWorkerControlServer(options)))({
        ownerEpoch: manifest.epoch, taskId: manifest.taskId,
        token: Buffer.from(state.keys.controlToken, 'base64').toString('base64url'),
        status: () => ({ hostState: this.#host?.metadata.state ?? 'new',
          backendGeneration: this.#host?.metadata.backendGeneration ?? null,
          nativeState: this.#owner?.metadata.state ?? null,
          nativeRevision: this.#owner?.metadata.revision ?? 0 }),
        diagnose: () => ({ schemaVersion: 1, startupPhase: this.#startupPhase,
          daemonState: this.#state, failureCode: this.#failure,
          bootstrapFailureCode: this.#bootstrapFailureCode,
          registryState: currentRegistryState(),
          owner: this.metadata.nativeStartup }),
        requestStop: () => this.#requestStop(controlKey, manifest.home, manifest.familyRoot, observe),
      });
      const controlEndpoint = await this.#control.listen();
      await writePrivateLocator(state, 'startup-control.v1.json', {
        schemaVersion: 1, epoch: manifest.epoch, host: self,
        control: { host: controlEndpoint.host, port: controlEndpoint.port },
      });
      this.#startupPhase = 'control-listening';
      const policy = (scope: Readonly<WorkerCommandScope & WorkerCommand>): boolean => {
        if (!ownerCurrent() || scope.ownerEpoch !== manifest.epoch ||
          scope.backendGeneration !== this.#generation || scope.threadId !== manifest.taskId) return false;
        if (this.#options.nativeStockQueue) {
          if (this.#vkSubmitter?.authorizes(scope) === true) return true;
          const p = scope.params;
          if (!stockInitialized || scope.method !== 'thread/queue/add' ||
              p.threadId !== manifest.taskId || typeof p.clientUserMessageId !== 'string' ||
              !uuid.test(p.clientUserMessageId) || !Array.isArray(p.input) || p.input.length !== 1 ||
              !object(p.input[0]) || p.input[0].type !== 'text' ||
              typeof p.input[0].text !== 'string' || !p.input[0].text ||
              !isDeepStrictEqual(Object.keys(p).sort(),
                ['threadId', 'clientUserMessageId', 'input'].sort()) ||
              scope.operationId !== managedStockCommandId(manifest.epoch, manifest.taskId,
                p.clientUserMessageId)) return false;
          if (this.#headlessPending !== 0) {
            const admitted = this.#host?.commandStatusForIntent(controlKey, {
              operationId: scope.operationId, method: scope.method, params: scope.params });
            return admitted?.state === 'dispatching';
          }
          if (!this.#admissionOpen) {
            const admitted = this.#host?.commandStatusForIntent(controlKey, {
              operationId: scope.operationId, method: scope.method, params: scope.params });
            return admitted?.state === 'dispatching';
          }
          return true;
        }
        if (scope.method !== 'turn/start') return false;
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
      let stockInitialized = false;
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
        ...(this.#options.dependencies?.backendTimeoutMs ?
          { backendTimeoutMs: this.#options.dependencies.backendTimeoutMs } : {}),
        bootstrapReadMethods: this.#options.nativeStockQueue ?
          ['thread/turns/list', 'config/read', 'configRequirements/read'] :
          ['thread/turns/list', 'config/read'],
        launch: () => {
          launchAttempted = true;
          this.#startupPhase = 'launching';
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
          authorize: policy, isOwnerCurrent: ownerCurrent,
          ...(this.#options.nativeStockQueue ? {
            authorizeSettings: (scope: Parameters<ManagedStockSettingsInitializer['authorizesSettingsCommand']>[0]) =>
              this.#stockInitializer?.authorizesSettingsCommand(scope) === true,
            qualifySettingsEffect: (scope: Parameters<ManagedStockSettingsInitializer['qualifySettingsEffect']>[0],
              assertCurrent: () => void) => {
              if (!this.#stockInitializer) throw new Error('Managed stock initializer unavailable');
              return this.#stockInitializer.qualifySettingsEffect(scope, assertCurrent);
            },
          } : {}) },
      });
      await this.#host.start();
      const meta = this.#host.metadata;
      if (!launched.child?.pid || !meta.backendGeneration) throw new Error('Backend identity unavailable');
      const observed = observe(launched.child.pid);
      if (!observed) throw new Error('Backend birth unavailable');
      this.#generation = meta.backendGeneration;
      this.#backend = { ...observed, generation: meta.backendGeneration };
      this.#attempt = this.#registry.registerBackend(this.#attempt, self, this.#backend);
      this.#startupPhase = 'backend-registered';
      launched.child.once('exit', () => this.#backendExited());
      this.#startupPhase = 'bootstrapping';
      this.#bootstrap = await bootstrapManagedWorker({ host: this.#host, adapterKey,
        taskId: manifest.taskId, cwd: manifest.cwd, initializeRequest: manifest.initializeRequest,
        resumeParams: manifest.resumeParams,
        ...(manifest.approvedTaskPolicy ? { approvedTaskPolicy: manifest.approvedTaskPolicy } : {}) });
      let initialized: Awaited<ReturnType<ManagedStockSettingsInitializer['initialize']>> | null = null;
      if (this.#options.nativeStockQueue) {
        this.#stockInitializer = createManagedStockSettingsInitializer({ host: this.#host,
          adapterKey, controlKey, bootstrap: this.#bootstrap, taskId: manifest.taskId,
          ownerEpoch: manifest.epoch, approvedTaskPolicy: manifest.approvedTaskPolicy!,
          assertOwnerCurrent: () => { if (!ownerCurrent()) throw new Error('Worker owner changed'); } });
        initialized = await this.#stockInitializer.initialize();
        stockInitialized = true;
      }
      this.#intentStore = new NativeStartIntentStore({ filePath: path.join(state.privateDirectory, 'start-intents.sqlite'),
        ownerEpoch: manifest.epoch, backendGeneration: meta.backendGeneration, threadId: manifest.taskId,
        encryptionKey: Buffer.from(state.keys.intentKey, 'base64') });
      let ownedClient: DesktopIpcClient | null = null;
      const confirmStockOwner = async (scope: Readonly<{taskId: string; ownerEpoch: string}>): Promise<boolean> => {
        if (!this.#options.nativeStockQueue || scope.taskId !== manifest.taskId ||
            scope.ownerEpoch !== manifest.epoch || !ownedClient || !ownerCurrent()) return false;
        try {
          await confirmManagedNativeOwner({ ownedClient, createProbeClient: this.#options.nativeStockQueue.createProbeClient,
            taskId: manifest.taskId, assertOwnerCurrent: () => {
              if (!ownerCurrent()) throw new Error('Worker owner changed');
            } });
          return ownerCurrent();
        } catch { return false; }
      };
      const stock = this.#options.nativeStockQueue;
      const stockFactory = stock && initialized ? createManagedStockQueueRuntimeFactory({
        journalPath: path.join(state.privateDirectory, 'native-stock.sqlite'),
        sourceGeneration: stock.sourceGeneration, bootstrap: this.#bootstrap,
        initialized, approvedTaskPolicy: manifest.approvedTaskPolicy!,
        assertControlledNativeBaseline: stock.assertControlledNativeBaseline,
        confirmNativeOwner: confirmStockOwner, isOwnerCurrent: ownerCurrent,
        admissionOpen: () => this.#admissionOpen && this.#headlessPending === 0,
      }) : undefined;
      let stockAuthority: Pick<Parameters<NonNullable<typeof stockFactory>>[0],
        'captureAuthority' | 'assertCurrent'> | null = null;
      const queueAdapterFactory = stockFactory ?
        (context: Parameters<typeof stockFactory>[0]) => {
          stockAuthority = Object.freeze({ captureAuthority: context.captureAuthority,
            assertCurrent: context.assertCurrent });
          return stockFactory(context);
        } : undefined;
      this.#owner = new ManagedWorkerNativeOwner({ host: this.#host, adapterKey, controlKey,
        taskId: manifest.taskId, ownerEpoch: manifest.epoch, isOwnerCurrent: ownerCurrent,
        allowFollower: this.#options.allowFollower,
        readInitialState: initialized ? initialized.readInitialState : this.#bootstrap.readInitialState,
        intentStore: this.#intentStore, composerDefaults: () => ({ ...this.#bootstrap!.composerDefaults }),
        ...(queueAdapterFactory ? { queueAdapterFactory } : {}),
        ...(manifest.approvedTaskPolicy ? {} : {
          qualifyContinuation: (fence: () => ContinuationOwnerFence) => this.#bootstrap!.qualifyContinuation(fence),
        }),
        clientFactory: handler => {
          if (ownedClient) throw new Error('Native owner client already created');
          ownedClient = this.#options.clientFactory(handler);
          return ownedClient;
        } });
      this.#startupPhase = 'owner-starting';
      try { await this.#owner.start(); }
      catch {
        const native = this.#owner.metadata;
        // Only a failed initial IPC connection after a qualified projection
        // may leave the backend ready without a native follower. A bootstrap,
        // projection, or authority failure remains fatal.
        if (native.state !== 'disconnected' || native.startupStage !== 'connecting' ||
          native.failure !== null) throw new Error('Native owner unavailable');
      }
      this.#stockInitializer?.close();
      this.#stockInitializer = null;
      const nativeOwnerConfirmed = stock ?
        this.#owner.metadata.state === 'connected' &&
          await confirmStockOwner({ taskId: manifest.taskId, ownerEpoch: manifest.epoch }) :
        ['connected', 'disconnected'].includes(this.#owner.metadata.state);
      const readyCurrent = (): boolean => {
        const hostNow = this.#host!.metadata, nativeNow = this.#owner!.metadata;
        return (stock ? nativeNow.state === 'connected' :
          ['connected', 'disconnected'].includes(nativeNow.state)) &&
          hostNow.state === 'running' && hostNow.taskId === manifest.taskId &&
          hostNow.backendGeneration === this.#generation && ownerCurrent();
      };
      if (!nativeOwnerConfirmed || !readyCurrent())
        throw new Error('Native owner unavailable');
      this.#startupPhase = 'publishing-ready';
      if (!ownerCurrent()) throw new Error('Worker owner changed before publication');
      const endpointRef = randomUUID();
      await writeEndpoint(state, { schemaVersion: 1, epoch: manifest.epoch, endpointRef,
        host: self, backend: this.#backend,
        control: { host: controlEndpoint.host, port: controlEndpoint.port } });
      if (!readyCurrent()) throw new Error('Native owner changed before registry publication');
      if (stock?.headlessVk && initialized && stockAuthority) {
        const authority = stockAuthority as Pick<Parameters<NonNullable<typeof stockFactory>>[0],
          'captureAuthority' | 'assertCurrent'>;
        const acquireLease = (): ManagedStockVkLease => {
          if (this.#state !== 'ready' || !this.#admissionOpen ||
            this.#headlessPending !== 0 || !ownerCurrent())
            throw new Error('Managed VK ingress unavailable');
          this.#headlessPending++;
          let settled = false;
          try {
            const nativeOwner = this.#owner!, host = this.#host!;
            const revision = nativeOwner.metadata.semanticRevision;
            const nativeQueue = nativeOwner.queueQuiescence();
            const initialCommands = host.commandQuiescence(controlKey);
            const initialRequests = host.requestQuiescence(controlKey);
            if (!nativeQueue || nativeQueue.unresolved || nativeQueue.unconsumed ||
              nativeOwner.metadata.pendingNativeOperations !== 0 ||
              nativeOwner.metadata.pendingEvents !== 0 ||
              initialCommands.inFlight !== 0 || initialCommands.unconfirmed ||
              initialRequests.unresolved !== 0 || initialRequests.generation !== this.#generation)
              throw new Error('Managed VK stock queue is busy');
            const assertCurrent = (): void => {
              const meta = nativeOwner.metadata;
              const queue = nativeOwner.queueQuiescence();
              const requests = host.requestQuiescence(controlKey);
              if (this.#state !== 'ready' || !ownerCurrent() ||
                host.metadata.state !== 'running' || host.metadata.taskId !== manifest.taskId ||
                host.metadata.backendGeneration !== this.#generation ||
                !['connected', 'disconnected'].includes(meta.state) ||
                meta.semanticRevision !== revision || meta.pendingNativeOperations !== 0 ||
                meta.pendingEvents !== 0 || !queue || queue.unresolved !== 0 ||
                queue.unconsumed !== 0 || queue.taskVersion !== nativeQueue.taskVersion ||
                requests.unresolved !== 0 || requests.generation !== this.#generation)
                throw new Error('Managed VK stock authority changed');
            };
            assertCurrent();
            return Object.freeze({ assertCurrent,
              finish: (outcome: 'accepted' | 'rejected' | 'unknown') => {
                if (settled || outcome === 'unknown') return;
                settled = true; this.#headlessPending--;
              } });
          } catch (error) { this.#headlessPending--; throw error; }
        };
        this.#vkSubmitter = new ManagedStockVkSubmitter({
          capability: stock.headlessVk.capability, sourceId: stock.headlessVk.sourceId,
          controlKey, taskId: manifest.taskId, ownerEpoch: manifest.epoch,
          backendGeneration: this.#generation!, approvedTaskPolicy: manifest.approvedTaskPolicy!,
          host: this.#host, readStockState: this.#bootstrap!.readStockState,
          initialState: initialized.initialState,
          captureAuthority: authority.captureAuthority,
          assertAuthorityCurrent: authority.assertCurrent,
          acquireLease,
        });
      }
      this.#attempt = this.#registry.markReady(this.#attempt, self, this.#backend, endpointRef);
      this.#endpointRef = endpointRef;
      this.#everReady = true;
      this.#state = 'ready';
      this.#startupPhase = 'ready';
      this.#admissionOpen = true;
      this.#scheduleReconnect();
    } catch (error) {
      if (this.#startupPhase === 'bootstrapping' && this.#bootstrap === null)
        this.#bootstrapFailureCode = bootstrapFailureCode(error);
      this.#stockInitializer?.close(); this.#stockInitializer = null;
      this.#state = 'failed'; this.#failure = 'startup-unavailable'; this.#admissionOpen = false;
      // A native owner may already be connected when ready publication fails.
      // Retire only that gateway; the owned backend and diagnostic control stay available.
      if (launchAttempted) {
        this.#clearReconnect();
        try { this.#owner?.close(); } catch { /* Preserve uncertain startup for explicit reconciliation. */ }
      }
      if (!launchAttempted) await this.#control?.close().catch(() => {});
      // No implicit worker shutdown on uncertain startup after launch.
      throw new Error('Managed worker daemon startup unavailable');
    }
  }

  #backendExited(): void {
    this.#stockInitializer?.close(); this.#stockInitializer = null;
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
      const nativeState = this.#owner.metadata.state;
      if (nativeState !== 'connected' && nativeState !== 'disconnected') {
        // The backend is still owned and may be active. Only native routing is
        // unavailable; retain authenticated diagnosis and never relaunch it.
        this.#admissionOpen = false; this.#state = 'failed';
        this.#failure = 'native-owner-unavailable';
        this.#clearReconnect();
        return;
      }
      if (nativeState !== 'disconnected' || this.#reconnectPending) {
        if (nativeState === 'connected') this.#reconnectDelayMs = 1_000;
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
    if (this.#state === 'failed')
      return this.#requestFailedStartStop(controlKey, home, familyRoot, observe);
    if (this.#state !== 'ready' || !this.#host || !this.#owner || !this.#bootstrap ||
      !this.#registry || !this.#attempt || !this.#self || !this.#backend)
      throw new ManagedWorkerStopRefusedError();
    const host = this.#host, owner = this.#owner, generation = this.#generation;
    this.#admissionOpen = false;
    let stopIssued = false;
    try {
      const identityCurrent = () => {
        const row = this.#registry!.get(home, familyRoot);
        return !!row && row.epoch === this.#options.epoch && row.state === 'ready' &&
          row.revision === this.#attempt!.revision && same(row.host, this.#self) &&
          same(row.backend, this.#backend) && same(observe(process.pid), this.#self) &&
          same(observe(this.#backend!.pid), this.#backend) &&
          host.metadata.state === 'running' && host.metadata.backendGeneration === generation &&
          (owner.metadata.state === 'connected' || owner.metadata.state === 'disconnected');
      };
      const stable = () => identityCurrent() && this.#headlessPending === 0 &&
        owner.metadata.pendingNativeOperations === 0 &&
        owner.metadata.pendingEvents === 0;
      if (!stable() || generation === null) throw new ManagedWorkerStopRefusedError();
      // Native reservation can precede every worker command. Empty backend
      // receipts therefore cannot prove that the native journal is drained.
      const nativeQueue = this.#options.nativeStockQueue ? owner.queueQuiescence() : null;
      if (this.#options.nativeStockQueue && (!nativeQueue ||
          nativeQueue.unresolved !== 0 || nativeQueue.unconsumed !== 0))
        throw new ManagedWorkerStopRefusedError();
      // Usage counters can advance while these read-only checks run. Fence
      // conversation/authority changes, not an unrelated display revision.
      const semanticRevision = owner.metadata.semanticRevision;
      const receipts = host.acceptedCommandReceipts(controlKey);
      const queueInputs = host.acceptedQueueInputs(controlKey);
      if (receipts.some(receipt => receipt.method !== 'turn/start' &&
          receipt.method !== 'thread/queue/add'))
        throw new ManagedWorkerStopRefusedError();
      const expectedTurnIds = receipts.filter(receipt => receipt.method === 'turn/start')
        .map(receipt => receipt.receiptId);
      const submissionIds = receipts.filter(receipt => receipt.method === 'thread/queue/add')
        .map(receipt => receipt.receiptId);
      const queueClientIds = queueInputs.map(input => input.clientUserMessageId);
      if (new Set(expectedTurnIds).size !== expectedTurnIds.length)
        throw new ManagedWorkerStopRefusedError();
      if (new Set(submissionIds).size !== submissionIds.length ||
          new Set(queueClientIds).size !== queueClientIds.length ||
          !isDeepStrictEqual(submissionIds, queueInputs.map(input => input.submissionId)))
        throw new ManagedWorkerStopRefusedError();
      const before = host.commandQuiescence(controlKey), requests = host.requestQuiescence(controlKey);
      if (before.inFlight || before.unconfirmed || requests.unresolved || requests.generation !== generation)
        throw new ManagedWorkerStopRefusedError();
      let idle: Readonly<{ turnCount: number; latestTurnId: string | null }>;
      try { idle = await this.#bootstrap.verifyIdle(expectedTurnIds, queueClientIds); }
      catch (error) {
        // A read-only proof may fail because a turn is active, queue is busy,
        // or its frontend read detached. None issued a stop. Preserve the
        // worker only while the exact registered backend is still current;
        // actual backend loss remains a failed lifecycle, not a retryable stop.
        if (identityCurrent()) throw new ManagedWorkerStopRefusedError();
        throw error;
      }
      if (await this.#options.verifyFamilyQuiescent({ taskId: this.#taskId!, generation, idle }) !== true)
        throw new ManagedWorkerStopRefusedError();
      const after = host.commandQuiescence(controlKey), pending = host.requestQuiescence(controlKey);
      if (after.inFlight || after.unconfirmed || pending.unresolved || pending.generation !== generation ||
        !isDeepStrictEqual(host.acceptedCommandReceipts(controlKey), receipts) ||
        !isDeepStrictEqual(host.acceptedQueueInputs(controlKey), queueInputs) ||
        this.#options.nativeStockQueue && !isDeepStrictEqual(owner.queueQuiescence(), nativeQueue) ||
        owner.metadata.semanticRevision !== semanticRevision || !stable()) throw new ManagedWorkerStopRefusedError();
      // Retire admitted grants before the last synchronous host-stop boundary.
      this.#state = 'stopping';
      this.#stockInitializer?.close(); this.#stockInitializer = null;
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

  /** Explicit authenticated cleanup of a never-ready, qualified zero-work
   * backend. It never infers safety from a closed native socket or an empty
   * stock queue alone. Ambiguous outcomes retain the backend for review. */
  async #requestFailedStartStop(controlKey: object, home: string, familyRoot: string,
    observe: typeof readWindowsProcessIdentity): Promise<void> {
    if (this.#state !== 'failed' || this.#failure !== 'startup-unavailable' || this.#everReady ||
      this.#admissionOpen || !this.#host || !this.#bootstrap || !this.#registry ||
      !this.#attempt || !this.#self || !this.#backend || this.#generation === null ||
      this.#endpointRef !== null) throw new ManagedWorkerStopRefusedError();
    const host = this.#host, owner = this.#owner, generation = this.#generation;
    let stopIssued = false;
    const identityCurrent = (): boolean => {
      const row = this.#registry!.get(home, familyRoot);
      const meta = host.metadata;
      return this.#state === 'failed' && this.#failure === 'startup-unavailable' &&
        !this.#everReady && !this.#admissionOpen && this.#endpointRef === null &&
        !!row && row.epoch === this.#options.epoch && row.state === 'backend_registered' &&
        row.revision === this.#attempt!.revision && same(row.host, this.#self) &&
        same(row.backend, this.#backend) && row.backend?.generation === generation &&
        same(observe(process.pid), this.#self) && same(observe(this.#backend!.pid), this.#backend) &&
        meta.state === 'running' && meta.taskId === this.#taskId &&
        meta.backendGeneration === generation;
    };
    const quiescent = (): boolean => {
      try {
        if (!identityCurrent()) return false;
        if (owner && (!owner.retiredWithoutNativeIngress() ||
            owner.metadata.pendingNativeOperations !== 0 || owner.metadata.pendingEvents !== 0)) return false;
        const receipts = host.acceptedCommandReceipts(controlKey);
        const queueInputs = host.acceptedQueueInputs(controlKey);
        const commands = host.commandQuiescence(controlKey);
        const requests = host.requestQuiescence(controlKey);
        return receipts.length === 0 && queueInputs.length === 0 &&
          commands.inFlight === 0 && !commands.unconfirmed &&
          requests.generation === generation && requests.unresolved === 0 && identityCurrent();
      } catch { return false; }
    };
    try {
      if (!quiescent()) throw new ManagedWorkerStopRefusedError();
      let idle: Readonly<{ turnCount: number; latestTurnId: string | null }>;
      try { idle = await this.#bootstrap.verifyIdle([], []); }
      catch { throw new ManagedWorkerStopRefusedError(); }
      if (idle.turnCount !== 0 || idle.latestTurnId !== null || !quiescent())
        throw new ManagedWorkerStopRefusedError();
      let familyQuiescent = false;
      try { familyQuiescent = await this.#options.verifyFamilyQuiescent({
        taskId: this.#taskId!, generation, idle }); }
      catch { throw new ManagedWorkerStopRefusedError(); }
      if (familyQuiescent !== true || !quiescent()) throw new ManagedWorkerStopRefusedError();
      this.#state = 'stopping';
      this.#clearReconnect();
      stopIssued = true;
      owner?.close();
      await host.stop('owner-request');
      if (same(observe(this.#backend.pid), this.#backend))
        throw new Error('Worker shutdown unconfirmed');
      this.#state = 'stopped';
      this.#intentStore?.close(); this.#registry?.close();
      const retireControl = setTimeout(() => { void this.#control?.close().catch(() => {}); }, 250);
      retireControl.unref();
    } catch (error) {
      if (!stopIssued) throw error instanceof ManagedWorkerStopRefusedError ?
        error : new ManagedWorkerStopRefusedError();
      this.#state = 'failed'; this.#failure = 'stop-unconfirmed';
      throw error;
    }
  }
}

function defaultLaunch(cliPath: string, cwd: string, home: string): ChildProcessWithoutNullStreams {
  return spawn(cliPath, ['app-server', '-c', 'features.code_mode_host=true'], {
    ...buildBackendWorkerSpawnOptions(cwd, home, process.env) });
}
async function pinnedCli(cliPath: string, sha256: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/iu.test(sha256)) throw new Error('CLI pin invalid');
  const stat = await lstat(cliPath);
  if (!stat.isFile() || stat.isSymbolicLink() ||
    createHash('sha256').update(await readFile(cliPath)).digest('hex') !== sha256.toLowerCase())
    throw new Error('CLI pin mismatch');
}
async function writeEndpoint(state: ManagedWorkerPrivateState, endpoint: Row): Promise<void> {
  await writePrivateLocator(state, 'endpoint.v1.json', endpoint);
}
async function writePrivateLocator(state: ManagedWorkerPrivateState, filename: string, value: Row): Promise<void> {
  const file = path.join(state.privateDirectory, filename);
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}
