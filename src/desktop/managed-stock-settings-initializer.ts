import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedWorkerFrontendHost, ManagedWorkerNotification } from '../codex/managed-worker-frontend-host.js';
import type { SettingsCommand, WorkerCommandScope } from '../codex/managed-worker-command-dispatcher.js';
import type { ApprovedTaskPolicy } from '../codex/managed-task-policy.js';
import { approveTaskPolicy } from '../codex/managed-task-policy.js';
import { applyNotification, type NativeProjectionState } from '../codex/managed-native-projection.js';
import type { HomogeneousQueueSettings } from '../codex/homogeneous-queue-policy.js';
import type { ManagedWorkerBootstrap, StockReadState } from './managed-worker-bootstrap.js';

type Row = Record<string, unknown>;
type Host = Pick<ManagedWorkerFrontendHost, 'metadata' | 'observeNotifications' |
  'observePendingRequests' | 'executeSettingsCommand' | 'confirmSettingsCommand'>;
type Bootstrap = Pick<ManagedWorkerBootstrap, 'generation' | 'initialState' |
  'composerDefaults' | 'readStockState'>;
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => { throw new Error('Managed stock settings initialization unavailable'); };
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}
function copy<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 2_000_000) fail();
  let nodes = 0;
  const bounded = (item: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32) fail();
    if (item && typeof item === 'object') for (const child of Object.values(item))
      bounded(child, depth + 1);
  };
  bounded(value, 0);
  const cloned = structuredClone(value);
  if (!isDeepStrictEqual(cloned, JSON.parse(encoded))) fail();
  return freezeTree(cloned);
}

export interface ManagedStockSettingsInitializerOptions {
  readonly host: Host;
  readonly adapterKey: object;
  readonly controlKey: object;
  readonly bootstrap: Bootstrap;
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly approvedTaskPolicy: ApprovedTaskPolicy;
  readonly operationId?: string;
  readonly assertOwnerCurrent: () => void;
  /** Bounded test/diagnostic deadline; never changes dispatch or retries it. */
  readonly noticeTimeoutMs?: number;
}
export interface ManagedStockInitialized {
  readonly effectiveSettings: HomogeneousQueueSettings;
  readonly initializationReceipt: Readonly<Row> | null;
  readonly tierResolution: Readonly<Row> | null;
  readonly initialState: NativeProjectionState;
  /** Same-worker final re-read for NativeOwner bootstrap; no resume or mutation. */
  readInitialState(): Promise<NativeProjectionState>;
}

/** One settings write on an already resumed empty worker. It never creates,
 * resumes, stops, or retries a worker. Native `{}` only proves RPC ACK. */
export class ManagedStockSettingsInitializer {
  readonly #host: Host;
  readonly #adapterKey: object;
  readonly #controlKey: object;
  readonly #bootstrap: Bootstrap;
  readonly #taskId: string;
  readonly #ownerEpoch: string;
  readonly #generation: number;
  readonly #policy: ApprovedTaskPolicy;
  readonly #operationId: string;
  readonly #assertOwnerCurrent: () => void;
  readonly #command: SettingsCommand;
  readonly #noticeTimeoutMs: number;
  readonly #observeNotifications: Host['observeNotifications'];
  readonly #observePendingRequests: Host['observePendingRequests'];
  readonly #executeSettings: Host['executeSettingsCommand'];
  readonly #confirmSettings: Host['confirmSettingsCommand'];
  #detachNotifications: (() => void) | null = null;
  #detachRequests: (() => void) | null = null;
  #started = false;
  #dispatching = false;
  #closed = false;
  #faulted = false;
  #revision = 0;
  #pendingRequests = 0;
  #notice: ManagedWorkerNotification['notification'] | null = null;
  #wakeNotice: (() => void) | null = null;
  #qualified: ManagedStockInitialized | null = null;

  constructor(options: ManagedStockSettingsInitializerOptions) {
    if (!options || !options.host || !options.bootstrap || !options.adapterKey ||
        !options.controlKey || typeof options.assertOwnerCurrent !== 'function' ||
        typeof options.taskId !== 'string' || !options.taskId ||
        typeof options.ownerEpoch !== 'string' || !options.ownerEpoch ||
        !Number.isSafeInteger(options.bootstrap.generation) || options.bootstrap.generation < 1)
      fail();
    const policy = approveTaskPolicy(options.approvedTaskPolicy);
    if (policy.threadId !== options.taskId || policy.effort === null ||
        policy.approvalPolicy !== 'never' ||
        policy.approvalsReviewer !== 'user' ||
        policy.activePermissionProfile.id !== ':danger-full-access' ||
        policy.sandbox.type !== 'dangerFullAccess' ||
        ![null, 'default'].includes(policy.serviceTier)) fail();
    const defaults = copy(options.bootstrap.composerDefaults);
    if (defaults.taskId !== options.taskId || defaults.cwd !== policy.cwd) fail();
    this.#host = options.host; this.#adapterKey = options.adapterKey;
    this.#controlKey = options.controlKey;
    this.#bootstrap = Object.freeze({ generation: options.bootstrap.generation,
      initialState: copy(options.bootstrap.initialState),
      composerDefaults: defaults,
      readStockState: options.bootstrap.readStockState.bind(options.bootstrap) });
    this.#observeNotifications = options.host.observeNotifications.bind(options.host);
    this.#observePendingRequests = options.host.observePendingRequests.bind(options.host);
    this.#executeSettings = options.host.executeSettingsCommand.bind(options.host);
    this.#confirmSettings = options.host.confirmSettingsCommand.bind(options.host);
    this.#taskId = options.taskId; this.#ownerEpoch = options.ownerEpoch;
    this.#generation = options.bootstrap.generation; this.#policy = policy;
    this.#operationId = options.operationId ?? randomUUID();
    this.#noticeTimeoutMs = options.noticeTimeoutMs === undefined ? 10_000 :
      Number.isSafeInteger(options.noticeTimeoutMs) && options.noticeTimeoutMs >= 1 &&
      options.noticeTimeoutMs <= 10_000 ? options.noticeTimeoutMs : fail();
    this.#assertOwnerCurrent = options.assertOwnerCurrent;
    this.#command = copy({ operationId: this.#operationId, method: 'thread/settings/update',
      params: { threadId: this.#taskId, cwd: policy.cwd,
        approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer,
        permissions: policy.activePermissionProfile.id, model: policy.model,
        serviceTier: policy.serviceTier, effort: policy.effort,
        summary: defaults.summary, personality: defaults.personality,
        collaborationMode: { mode: 'default', settings: { model: policy.model,
          reasoning_effort: policy.effort, developer_instructions: null } } } }) as SettingsCommand;
  }

  #current(): void {
    if (this.#closed || this.#faulted) fail();
    const meta = this.#host.metadata;
    if (meta.taskId !== this.#taskId || meta.state !== 'running' ||
        meta.backendGeneration !== this.#generation) fail();
    this.#assertOwnerCurrent();
    if (this.#closed || this.#faulted) fail();
    const after = this.#host.metadata;
    if (after.taskId !== this.#taskId || after.state !== 'running' ||
        after.backendGeneration !== this.#generation) fail();
  }

  /** The daemon's policy admits only this pending immutable initialization,
   * not an arbitrary scoped settings mutation. No RPC or reservation here. */
  authorizesSettingsCommand(context: Readonly<WorkerCommandScope & SettingsCommand>): boolean {
    try {
      this.#current();
      return this.#dispatching && this.#qualified === null && this.#pendingRequests === 0 &&
        this.#revision === 0 && isDeepStrictEqual(context, { ...this.#command,
          threadId: this.#taskId, ownerEpoch: this.#ownerEpoch, backendGeneration: this.#generation });
    } catch { return false; }
  }

  #observe(event: ManagedWorkerNotification): void {
    if (this.#closed || this.#faulted) return;
    if (event.taskId !== this.#taskId || event.generation !== this.#generation) {
      this.#faulted = true; this.#wakeNotice?.(); return;
    }
    const method = event.notification.method, params = event.notification.params;
    if (method === 'mcpServer/startupStatus/updated' || method === 'thread/tokenUsage/updated') return;
    this.#revision++;
    if (this.#revision > 64) { this.#faulted = true; this.#wakeNotice?.(); return; }
    if (method === 'thread/settings/updated' && object(params) &&
        params.threadId === this.#taskId && object(params.threadSettings)) {
      this.#notice = copy(event.notification);
      this.#wakeNotice?.();
    }
  }

  async #noticeAfterWrite(): Promise<ManagedWorkerNotification['notification']> {
    if (this.#notice) return this.#notice;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.#wakeNotice = null;
        reject(new Error('Managed stock settings notification unavailable')); }, this.#noticeTimeoutMs);
      this.#wakeNotice = () => { clearTimeout(timer); this.#wakeNotice = null; resolve(); };
    });
    this.#current();
    return this.#notice ?? fail();
  }

  async initialize(): Promise<ManagedStockInitialized> {
    if (this.#started) fail();
    this.#started = true;
    this.#current();
    this.#detachNotifications = this.#observeNotifications(this.#adapterKey,
      event => this.#observe(event), () => { this.#faulted = true; this.#wakeNotice?.(); });
    this.#detachRequests = this.#observePendingRequests(this.#adapterKey,
      () => { this.#pendingRequests++; this.#revision++; this.#wakeNotice?.(); },
      () => { this.#faulted = true; this.#wakeNotice?.(); });
    this.#current();
    const baseline = await this.#bootstrap.readStockState(() => this.#current());
    if (baseline.threadId !== this.#taskId || baseline.generation !== this.#generation ||
        baseline.turnCount !== 0 || baseline.terminalTurnIds.length !== 0 ||
        this.#pendingRequests !== 0 || this.#revision !== 0) fail();
    this.#current();
    this.#dispatching = true;
    let sent;
    try {
      sent = await this.#executeSettings(this.#controlKey, this.#command,
        () => { this.#current(); if (this.#pendingRequests !== 0 || this.#revision !== 0) fail(); });
    } finally { this.#dispatching = false; }
    if (sent.operationId !== this.#operationId || sent.ownerEpoch !== this.#ownerEpoch ||
        sent.backendGeneration !== this.#generation || sent.threadId !== this.#taskId ||
        sent.rpcAck !== true) fail();
    await this.#noticeAfterWrite();
    this.#current();
    const confirmed = await this.#confirmSettings(this.#controlKey, this.#command);
    if (confirmed.operationId !== this.#operationId || confirmed.state !== 'confirmed' ||
        confirmed.rpcAck !== true || !this.#qualified) fail();
    return this.#qualified!;
  }

  /** Trusted dispatcher callback. It may be invoked only for this immutable
   * command after its journaled native ACK; no native RPC is sent here. */
  async qualifySettingsEffect(context: Readonly<WorkerCommandScope & SettingsCommand>,
    assertCurrent: () => void): Promise<Readonly<{ effectiveSettings: HomogeneousQueueSettings;
      assertCurrent: () => void }>> {
    this.#current(); assertCurrent();
    if (context.ownerEpoch !== this.#ownerEpoch || context.backendGeneration !== this.#generation ||
        context.threadId !== this.#taskId || !isDeepStrictEqual(context.operationId, this.#command.operationId) ||
        !isDeepStrictEqual(context.params, this.#command.params) ||
        context.method !== 'thread/settings/update' || this.#pendingRequests !== 0 || !this.#notice)
      fail();
    const revision = this.#revision, notice = copy(this.#notice as ManagedWorkerNotification['notification']);
    const check = () => {
      this.#current(); assertCurrent();
      if (this.#revision !== revision || this.#pendingRequests !== 0 ||
          !isDeepStrictEqual(this.#notice, notice)) fail();
    };
    const observed = await this.#bootstrap.readStockState(check);
    check();
    const effective = this.#effective(notice, observed);
    const next = applyNotification(this.#bootstrap.initialState, notice);
    if (next === this.#bootstrap.initialState || !Array.isArray(next.turns) || next.turns.length !== 0)
      fail();
    const frozenState = copy(next);
    const readInitialState = async () => {
      check();
      const fresh = await this.#bootstrap.readStockState(check);
      check();
      const reevaluated = this.#effective(notice, fresh);
      if (!isDeepStrictEqual(reevaluated, effective)) fail();
      return frozenState;
    };
    this.#qualified = Object.freeze({ ...effective, initialState: frozenState, readInitialState });
    return Object.freeze({ effectiveSettings: effective.effectiveSettings, assertCurrent: check });
  }

  #effective(notice: ManagedWorkerNotification['notification'], read: StockReadState):
    Pick<ManagedStockInitialized, 'effectiveSettings' | 'initializationReceipt' | 'tierResolution'> {
    const settings: Row = object(notice.params) && object(notice.params.threadSettings)
      ? notice.params.threadSettings : fail();
    const mode: Row = object(settings.collaborationMode) ? settings.collaborationMode : fail();
    const modeSettings: Row = object(mode.settings) ? mode.settings : fail();
    if (read.threadId !== this.#taskId || read.generation !== this.#generation ||
        read.turnCount !== 0 || read.terminalTurnIds.length !== 0 ||
        read.model !== this.#policy.model || read.modelProvider !== this.#policy.modelProvider ||
        read.reasoningEffort !== this.#policy.effort || read.cwd !== this.#policy.cwd ||
        !isDeepStrictEqual(read.environments, this.#policy.environments) ||
        settings.cwd !== this.#policy.cwd || settings.model !== this.#policy.model ||
        settings.modelProvider !== this.#policy.modelProvider || settings.effort !== this.#policy.effort ||
        settings.approvalPolicy !== this.#policy.approvalPolicy ||
        settings.approvalsReviewer !== this.#policy.approvalsReviewer ||
        settings.serviceTier !== this.#policy.serviceTier ||
        !isDeepStrictEqual(settings.sandboxPolicy, this.#policy.sandbox) ||
        !isDeepStrictEqual(settings.activePermissionProfile, this.#policy.activePermissionProfile) ||
        !Array.isArray(settings.disabledPluginIds) || settings.disabledPluginIds.length !== 0 ||
        settings.multiAgentMode !== 'explicitRequestOnly' ||
        settings.summary !== this.#command.params.summary ||
        settings.personality !== this.#command.params.personality ||
        mode.mode !== 'default' || modeSettings.model !== this.#policy.model ||
        modeSettings.reasoning_effort !== this.#policy.effort) fail();
    const effectiveSettings = copy({ cwd: this.#policy.cwd,
      runtimeWorkspaceRoots: [...this.#policy.runtimeWorkspaceRoots],
      approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
      permissions: this.#policy.activePermissionProfile.id,
      sandboxPolicy: settings.sandboxPolicy, model: settings.model,
      serviceTier: settings.serviceTier, effort: settings.effort,
      summary: settings.summary, personality: settings.personality,
      collaborationMode: settings.collaborationMode }) as HomogeneousQueueSettings;
    const requestedMode = this.#command.params.collaborationMode;
    const expanded = !isDeepStrictEqual(requestedMode, settings.collaborationMode);
    if (expanded && (!object(requestedMode) || !object(requestedMode.settings) ||
        requestedMode.settings.developer_instructions !== null ||
        typeof modeSettings.developer_instructions !== 'string' ||
        !modeSettings.developer_instructions)) fail();
    if (settings.serviceTier === null && read.fastModeAllowed !== false) fail();
    const initializationReceipt = expanded ? copy({ taskId: this.#taskId, ownerEpoch: this.#ownerEpoch,
      confirmed: true, expansionKind: 'builtin-default-instructions',
      requestedCollaborationMode: requestedMode,
      confirmedEffectiveCollaborationMode: settings.collaborationMode,
      requestedSettings: { ...effectiveSettings, sandboxPolicy: null, serviceTier: 'default',
        collaborationMode: requestedMode }, confirmedEffectiveSettings: effectiveSettings }) : null;
    const tierResolution = settings.serviceTier === null ? copy({ taskId: this.#taskId,
      ownerEpoch: this.#ownerEpoch, requested: 'default', effective: null,
      fastModeAllowed: false, confirmed: true }) : null;
    return { effectiveSettings, initializationReceipt, tierResolution };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#detachNotifications?.(); this.#detachRequests?.();
    this.#wakeNotice?.(); this.#wakeNotice = null;
  }
}

export function createManagedStockSettingsInitializer(options: ManagedStockSettingsInitializerOptions):
  ManagedStockSettingsInitializer { return new ManagedStockSettingsInitializer(options); }
