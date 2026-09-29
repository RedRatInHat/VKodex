import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import WebSocket from 'ws';
import { createProjection } from '../codex/managed-native-projection.js';
import type { NativeProjectionState } from '../codex/managed-native-projection.js';
import type { ManagedWorkerFrontendHost } from '../codex/managed-worker-frontend-host.js';
import { approveTaskPolicy, assertApprovedResumeIntent, assertEffectiveResume,
  type ApprovedTaskPolicy } from '../codex/managed-task-policy.js';

type Row = Record<string, unknown>;
type ReadMethod = 'thread/read' | 'thread/turns/list' | 'thread/goal/get' | 'thread/queue/list' |
  'config/read' | 'configRequirements/read';
const MAX_FRAME_BYTES = 2_000_000;
const RPC_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const terminalStatuses = new Set(['completed', 'failed', 'interrupted']);

export interface ManagedWorkerBootstrapOptions {
  readonly host: Pick<ManagedWorkerFrontendHost,
    'metadata' | 'frontendCapability'> &
    Partial<Pick<ManagedWorkerFrontendHost,
      'frontendWebSocketCapability' | 'ownerRead'>>;
  /** Defaults to the established local JSONL bootstrap. */
  readonly frontendProtocol?: 'jsonl' | 'websocket';
  /** Private owner key for non-displacing WebSocket idle reads. Never sent to a frontend. */
  readonly ownerReadControlKey?: object;
  readonly adapterKey: object;
  readonly taskId: string;
  readonly cwd: string;
  readonly initializeRequest: Row;
  /** Exact owner-authorized, immutable read-only resume params; no inferred defaults. */
  readonly resumeParams: Row;
  /** Owner-approved, immutable opt-in. Omission preserves the legacy canary policy. */
  readonly approvedTaskPolicy?: ApprovedTaskPolicy;
}
export interface ComposerDefaults {
  readonly taskId: string;
  readonly cwd: string;
  readonly summary: 'auto' | 'concise' | 'detailed' | 'none' | null;
  readonly personality: 'none' | 'friendly' | 'pragmatic' | null;
}
export interface ManagedWorkerBootstrap {
  readonly generation: number;
  readonly initialState: NativeProjectionState;
  readonly composerDefaults: ComposerDefaults;
  /** Re-read the same worker before a first owner start; never resumes or writes. */
  readInitialState(): Promise<NativeProjectionState>;
  /** Current idle evidence only; does not recertify historical permissions. */
  verifyIdle(expectedTurnIds?: readonly string[], expectedQueueClientIds?: readonly string[]):
    Promise<Readonly<{ turnCount: number; latestTurnId: string | null }>>;
  /** Actual current policy on the same loaded worker; no turn/model write. */
  qualifyContinuation(ownerFence: () => ContinuationOwnerFence): Promise<QualifiedContinuationEvidence>;
  /** Exhaustive current terminal/idle stock evidence on this same worker; no writes. */
  readStockState(assertCurrent: () => void): Promise<StockReadState>;
}
export interface StockReadState {
  readonly threadId: string;
  readonly generation: number;
  readonly turnCount: number;
  readonly terminalTurnIds: readonly string[];
  readonly historyDigest: string;
  readonly model: string;
  readonly modelProvider: string;
  readonly reasoningEffort: string | null;
  readonly cwd: string;
  readonly environments: readonly Row[];
  readonly updatedAt: number;
  /** Null means requirements were not explicit, never evidence that fast mode is disabled. */
  readonly fastModeAllowed: boolean | null;
}
export interface ContinuationOwnerFence {
  readonly threadId: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  /** Must advance on meaningful settings, turn, request, queue and owner-reconnect transitions. */
  readonly semanticRevision: number;
  readonly pendingRequests: number;
  readonly queuedFollowUps: number;
  readonly inFlightCommands: number;
  readonly unconfirmedOperations: boolean;
}
/** Definite idle-history evidence insufficient for an accepted start; not a transport failure. */
export class ManagedWorkerIdleProofRefusedError extends Error {
  readonly reason: 'accepted-turn-not-terminal' | 'accepted-queue-input-not-terminal';
  constructor(reason: 'accepted-turn-not-terminal' | 'accepted-queue-input-not-terminal' =
    'accepted-turn-not-terminal') {
    super(reason);
    this.reason = reason;
    this.name = 'ManagedWorkerIdleProofRefusedError';
  }
}
export interface QualifiedContinuationEvidence {
  readonly owner: ContinuationOwnerFence;
  readonly turnCount: number;
  readonly latestTurnId: string | null;
  readonly terminalTurnIds: readonly string[];
  /** Ephemeral history anchor; no transcript content is returned. */
  readonly historyDigest: string;
  readonly effective: Readonly<{
    model: 'gpt-5.6-sol'; effort: 'low'; cwd: string;
    activePermissionProfileId: ':read-only'; approvalPolicy: 'never' | 'on-request';
    approvalsReviewer: 'user'; sandboxType: 'readOnly'; networkAccess: false;
    serviceTier: 'default' | null;
    runtimeWorkspaceRoots: readonly string[];
    environments: readonly Row[];
  }>;
  readonly composerDefaults: ComposerDefaults;
}

function object(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code: string): never { throw new TypeError(`managed worker bootstrap: ${code}`); }
function samePath(a: unknown, b: string): boolean {
  return typeof a === 'string' &&
    path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}
function samePaths(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length &&
    a.every((value, index) => samePath(value, b[index]!));
}
function sameEnvironments(a: unknown, policy: ApprovedTaskPolicy): boolean {
  return Array.isArray(a) && a.length === policy.environments.length &&
    a.every((value, index) => object(value) &&
      strictKeys(value, ['environmentId', 'cwd', 'runtimeWorkspaceRoots']) &&
      value.environmentId === policy.environments[index]!.environmentId &&
      samePath(value.cwd, policy.environments[index]!.cwd) &&
      samePaths(value.runtimeWorkspaceRoots, policy.environments[index]!.runtimeWorkspaceRoots));
}
function jsonCopy<T>(value: T): T {
  let decoded: unknown;
  try {
    const snapshot = structuredClone(value);
    decoded = JSON.parse(JSON.stringify(snapshot, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'bigint' || typeof item === 'function' ||
        typeof item === 'symbol' || typeof item === 'number' && !Number.isFinite(item)) fail('non-json-input');
      return item;
    }));
    if (!isDeepStrictEqual(snapshot, decoded)) fail('non-json-input');
  } catch { fail('non-json-input'); }
  return decoded as T;
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}
function strictKeys(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function scope(options: ManagedWorkerBootstrapOptions): { generation: number; resume: Row; initialize: Row;
  policy: ApprovedTaskPolicy | undefined } {
  if (!options || !options.host || !options.adapterKey || typeof options.adapterKey !== 'object' ||
    typeof options.taskId !== 'string' || !options.taskId || typeof options.cwd !== 'string' || !options.cwd ||
    !object(options.resumeParams) || !object(options.initializeRequest) ||
    options.frontendProtocol !== undefined &&
      options.frontendProtocol !== 'jsonl' && options.frontendProtocol !== 'websocket')
    fail('invalid-options');
  const resume = jsonCopy(options.resumeParams), initialize = jsonCopy(options.initializeRequest);
  const policy = Object.hasOwn(options, 'approvedTaskPolicy')
    ? approveTaskPolicy(options.approvedTaskPolicy) : undefined;
  if (policy) assertApprovedResumeIntent(policy, resume, options.taskId, options.cwd);
  if (!policy && (!strictKeys(resume, ['threadId', 'cwd', 'model', 'permissions', 'approvalPolicy', 'runtimeWorkspaceRoots', 'config']) ||
    resume.threadId !== options.taskId || !samePath(resume.cwd, options.cwd) ||
    resume.model !== 'gpt-5.6-sol' || resume.permissions !== ':read-only' ||
    resume.approvalPolicy !== 'never' || !isDeepStrictEqual(resume.runtimeWorkspaceRoots, [options.cwd]) ||
    !object(resume.config) || !strictKeys(resume.config, ['model_reasoning_effort']) ||
    resume.config.model_reasoning_effort !== 'low') ||
    !object(initialize.clientInfo) ||
    !object(initialize.capabilities)) fail('unqualified-resume-policy');
  const metadata = options.host.metadata;
  if (metadata.state !== 'running' || metadata.taskId !== options.taskId ||
    !Number.isSafeInteger(metadata.backendGeneration) || (metadata.backendGeneration ?? 0) < 1)
    fail('host-generation-unavailable');
  return { generation: metadata.backendGeneration as number, resume, initialize, policy };
}
function current(host: ManagedWorkerBootstrapOptions['host'], taskId: string, generation: number): void {
  const metadata = host.metadata;
  if (metadata.state !== 'running' || metadata.taskId !== taskId ||
    metadata.backendGeneration !== generation) fail('host-generation-changed');
}

/** One authenticated attachment; close detaches only this socket, never the worker. */
class FrontendReader {
  readonly #socket: Socket | WebSocket;
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';
  #frames: Row[] = [];
  #waiting: { resolve(frame: Row): void; reject(error: Error): void } | null = null;
  #failure: Error | null = null;
  #nextId = 1;
  readonly #guard: () => void;
  private constructor(socket: Socket | WebSocket, guard: () => void) {
    this.#socket = socket;
    this.#guard = guard;
    if (socket instanceof WebSocket) {
      socket.on('message', (data, isBinary) => {
        if (isBinary) { this.#fail(new Error('frontend-frame-malformed')); this.close(); return; }
        const raw = data.toString();
        if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
          this.#fail(new Error('frontend-frame-overflow')); this.close(); return;
        }
        try {
          const frame: unknown = JSON.parse(raw);
          if (!object(frame)) throw new Error('frontend-frame-malformed');
          this.#push(frame);
        } catch { this.#fail(new Error('frontend-frame-malformed')); this.close(); }
      });
    } else socket.on('data', chunk => this.#receive(chunk));
    socket.on('error', () => this.#fail(new Error('frontend-socket-error')));
    socket.on('close', () => this.#fail(new Error('frontend-eof')));
  }
  static async open(capability: Readonly<{ protocol?: 'websocket'; host: string; port: number; token: string }>,
    initialize: Row, guard: () => void): Promise<FrontendReader> {
    if (capability.host !== '127.0.0.1' || !Number.isSafeInteger(capability.port) ||
      capability.port < 1 || capability.port > 65535 || typeof capability.token !== 'string' ||
      capability.token.length < 32) fail('invalid-frontend-capability');
    const websocket = capability.protocol === 'websocket';
    const socket = websocket ? new WebSocket(`ws://${capability.host}:${capability.port}/`, {
      headers: { Authorization: `Bearer ${capability.token}` },
      perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES,
    }) : connect({ host: capability.host, port: capability.port });
    const reader = new FrontendReader(socket, guard);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frontend-connect-timeout')), RPC_TIMEOUT_MS);
        socket.once(websocket ? 'open' : 'connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error('frontend-connect-failed')); });
      });
      guard();
      if (!websocket) {
        reader.#send({ token: capability.token });
        const auth = await reader.#next();
        if (auth.ok !== true) fail('frontend-auth-failed');
        guard();
      }
      await reader.request('initialize', initialize);
      return reader;
    } catch (error) { reader.close(); throw error; }
  }
  close(): void {
    if (this.#socket instanceof WebSocket) this.#socket.terminate();
    else this.#socket.destroy();
  }
  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    if (this.#waiting) { const waiting = this.#waiting; this.#waiting = null; waiting.reject(error); }
  }
  #receive(chunk: Buffer): void {
    if (this.#failure) return;
    this.#buffer += this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_FRAME_BYTES) { this.#fail(new Error('frontend-frame-overflow')); this.close(); return; }
    while (this.#buffer.includes('\n')) {
      const end = this.#buffer.indexOf('\n');
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      try {
        if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('frontend-frame-overflow');
        const frame: unknown = JSON.parse(line);
        if (!object(frame)) throw new Error('frontend-frame-malformed');
        this.#push(frame);
      } catch { this.#fail(new Error('frontend-frame-malformed')); this.close(); return; }
    }
  }
  #push(frame: Row): void {
    if (this.#failure) return;
    if (this.#waiting) { const waiting = this.#waiting; this.#waiting = null; waiting.resolve(frame); }
    else {
      if (this.#frames.length >= 32) throw new Error('frontend-frame-backlog');
      this.#frames.push(frame);
    }
  }
  #send(frame: Row): void {
    if (this.#failure || this.#socket instanceof WebSocket &&
      this.#socket.readyState !== WebSocket.OPEN ||
      this.#socket instanceof WebSocket === false && this.#socket.destroyed)
      throw new Error('frontend-eof');
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) fail('outbound-frame-overflow');
    if (this.#socket instanceof WebSocket) this.#socket.send(encoded);
    else this.#socket.write(encoded + '\n');
  }
  #next(deadline = Date.now() + RPC_TIMEOUT_MS): Promise<Row> {
    if (Date.now() >= deadline) return Promise.reject(new Error('frontend-response-timeout'));
    if (this.#frames.length) return Promise.resolve(this.#frames.shift()!);
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#waiting) return Promise.reject(new Error('concurrent-frontend-read'));
    return new Promise<Row>((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { reject(new Error('frontend-response-timeout')); return; }
      const timer = setTimeout(() => { this.#waiting = null; reject(new Error('frontend-response-timeout')); }, remaining);
      this.#waiting = { resolve: frame => { clearTimeout(timer); resolve(frame); },
        reject: error => { clearTimeout(timer); reject(error); } };
    });
  }
  async request(method: ReadMethod | 'initialize' | 'thread/resume', params: Row): Promise<Row> {
    this.#guard();
    const deadline = Date.now() + RPC_TIMEOUT_MS;
    const id = this.#nextId++;
    this.#send({ id, method, params });
    for (let skipped = 0; skipped < 32; skipped++) {
      const frame = await this.#next(deadline);
      if (!Object.hasOwn(frame, 'id')) {
        if (typeof frame.method !== 'string') fail('frontend-unrelated-frame');
        continue; // Bounded notifications; never interpreted as an RPC result.
      }
      if (frame.id !== id) fail('frontend-response-id-mismatch');
      if (Object.hasOwn(frame, 'error')) {
        const error = frame.error;
        if (!object(error) || !Number.isSafeInteger(error.code)) fail('frontend-rpc-error-malformed');
        throw new Error(`frontend-rpc-error:${error.code}`); // No native message or payload in diagnostics.
      }
      if (!Object.hasOwn(frame, 'result') || !object(frame.result)) fail('frontend-result-malformed');
      this.#guard();
      return frame.result;
    }
    fail('frontend-notification-overflow');
  }
}

type ReadClient = Pick<FrontendReader, 'request'>;

function threadOf(result: Row, taskId: string, cwd: string, statuses: readonly string[]): Row {
  if (!object(result.thread) || result.thread.id !== taskId ||
    !object(result.thread.status) || !statuses.includes(result.thread.status.type as string) ||
    !Array.isArray(result.thread.turns) ||
    (result.thread.cwd !== undefined && result.thread.cwd !== null && !samePath(result.thread.cwd, cwd)))
    fail('thread-read-unqualified');
  return result.thread;
}
async function fullHistory(client: ReadClient, taskId: string): Promise<Row[]> {
  const turns: Row[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const result = await client.request('thread/turns/list', { threadId: taskId, limit: PAGE_LIMIT,
      sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) fail('history-page-malformed');
    for (const turn of result.data) {
      if (!object(turn) || typeof turn.id !== 'string' || !turn.id || ids.has(turn.id) ||
        turn.itemsView !== 'full' || !Array.isArray(turn.items)) fail('history-turn-malformed');
      ids.add(turn.id); turns.push(turn);
    }
    if (result.nextCursor === null) return turns;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor))
      fail('history-cursor-malformed');
    cursor = result.nextCursor; cursors.add(cursor);
  }
  fail('history-page-limit');
}
async function noGoalOrQueue(client: ReadClient, taskId: string): Promise<void> {
  const goal = await client.request('thread/goal/get', { threadId: taskId });
  const queue = await client.request('thread/queue/list', { threadId: taskId, limit: PAGE_LIMIT });
  if (goal.goal !== null || !Array.isArray(queue.data) || queue.data.length !== 0 || queue.nextCursor !== null)
    fail('goal-or-queue-not-empty');
}
function qualifiedStart(start: Row, taskId: string, cwd: string,
  policy?: ApprovedTaskPolicy): void {
  if (policy) { assertEffectiveResume(policy, start); return; }
  if (!object(start.thread) || start.thread.id !== taskId || !samePath(start.cwd, cwd) ||
    start.model !== 'gpt-5.6-sol' || start.reasoningEffort !== 'low' ||
    start.approvalPolicy !== 'never' || !object(start.activePermissionProfile) ||
    start.activePermissionProfile.id !== ':read-only' || !object(start.sandbox) ||
    start.sandbox.type !== 'readOnly' || start.sandbox.networkAccess !== false ||
    !isDeepStrictEqual(start.runtimeWorkspaceRoots, [cwd])) fail('resume-settings-unqualified');
}
function exposedInitialSettings(thread: Row, start: Row, cwd: string,
  policy?: ApprovedTaskPolicy): void {
  if (policy && (thread.model !== policy.model || thread.modelProvider !== policy.modelProvider ||
    thread.reasoningEffort !== policy.effort || !samePath(thread.cwd, cwd) ||
    !sameEnvironments(thread.environments, policy))) fail('actual-thread-settings-drift');
  if ((Object.hasOwn(thread, 'model') && thread.model !== start.model) ||
    (Object.hasOwn(thread, 'reasoningEffort') && thread.reasoningEffort !== start.reasoningEffort) ||
    (Object.hasOwn(thread, 'cwd') && !samePath(thread.cwd, cwd)) ||
    (Object.hasOwn(thread, 'activePermissionProfile') &&
      !isDeepStrictEqual(thread.activePermissionProfile, start.activePermissionProfile)) ||
    (Object.hasOwn(thread, 'sandbox') && !isDeepStrictEqual(thread.sandbox, start.sandbox)) ||
    (Object.hasOwn(thread, 'approvalPolicy') && thread.approvalPolicy !== start.approvalPolicy) ||
    (Object.hasOwn(thread, 'runtimeWorkspaceRoots') &&
      !isDeepStrictEqual(thread.runtimeWorkspaceRoots, start.runtimeWorkspaceRoots)))
    fail('actual-thread-settings-drift');
}
function defaultsOf(configResult: Row, taskId: string, cwd: string): ComposerDefaults {
  const config = configResult.config;
  if (!object(config) || !Object.hasOwn(config, 'model_reasoning_summary') ||
    !Object.hasOwn(config, 'personality')) fail('config-defaults-unavailable');
  const summary = config.model_reasoning_summary, personality = config.personality;
  if (summary !== null && !['auto', 'concise', 'detailed', 'none'].includes(summary as string) ||
    personality !== null && !['none', 'friendly', 'pragmatic'].includes(personality as string))
    fail('config-defaults-unqualified');
  return Object.freeze({ taskId, cwd, summary: summary as ComposerDefaults['summary'],
    personality: personality as ComposerDefaults['personality'] });
}
function initialProjection(start: Row, read: Row, taskId: string, cwd: string,
  policy?: ApprovedTaskPolicy): NativeProjectionState {
  const thread = threadOf(read, taskId, cwd, ['idle']);
  if ((thread.turns as unknown[]).length !== 0) fail('initial-history-not-empty');
  const state = createProjection(start, { thread: { ...thread, turns: [] } },
    { hostId: 'local', workspaceKind: 'projectless', environments: [] });
  if (policy) {
    const permissions = state.currentPermissions, settings = state.latestThreadSettings;
    if (state.id !== taskId || state.resumeState !== 'resumed' || !samePath(state.cwd, cwd) ||
      state.latestModel !== policy.model || state.latestReasoningEffort !== policy.effort ||
      state.modelProvider !== policy.modelProvider ||
      settings.model !== policy.model || settings.effort !== policy.effort ||
      settings.approvalPolicy !== policy.approvalPolicy ||
      settings.approvalsReviewer !== policy.approvalsReviewer ||
      settings.serviceTier !== policy.serviceTier ||
      !isDeepStrictEqual(settings.activePermissionProfile, policy.activePermissionProfile) ||
      !isDeepStrictEqual(settings.sandboxPolicy, start.sandbox) ||
      !isDeepStrictEqual(permissions.activePermissionProfile, policy.activePermissionProfile) ||
      !isDeepStrictEqual(permissions.runtimeWorkspaceRoots, start.runtimeWorkspaceRoots) ||
      permissions.approvalPolicy !== policy.approvalPolicy ||
      permissions.approvalsReviewer !== policy.approvalsReviewer ||
      !isDeepStrictEqual(permissions.sandboxPolicy, start.sandbox) ||
      !sameEnvironments(state.environments, policy))
      fail('initial-projection-unqualified');
    return state;
  }
  if (state.id !== taskId || state.resumeState !== 'resumed' || !samePath(state.cwd, cwd) ||
    state.latestModel !== 'gpt-5.6-sol' || state.latestReasoningEffort !== 'low' ||
    !object(state.currentPermissions.activePermissionProfile) ||
    state.currentPermissions.activePermissionProfile.id !== ':read-only' ||
    !object(state.currentPermissions.sandboxPolicy) ||
    state.currentPermissions.sandboxPolicy.type !== 'readOnly' ||
    state.currentPermissions.sandboxPolicy.networkAccess !== false ||
    !isDeepStrictEqual(state.currentPermissions.runtimeWorkspaceRoots, [cwd]) ||
    !Array.isArray(state.environments) || state.environments.length > 1)
    fail('initial-projection-unqualified');
  if (state.environments.length === 1) {
    const environment = state.environments[0];
    if (!object(environment) || environment.environmentId !== 'local' ||
      !samePath(environment.cwd, cwd) ||
      !isDeepStrictEqual(environment.runtimeWorkspaceRoots, [cwd]))
      fail('initial-environment-unqualified');
  }
  return state;
}

function ownerFenceSnapshot(value: unknown, taskId: string, generation: number): ContinuationOwnerFence {
  if (!object(value) || value.threadId !== taskId || typeof value.ownerEpoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.ownerEpoch) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(value.ownerEpoch) ||
    value.backendGeneration !== generation || !Number.isSafeInteger(value.semanticRevision) ||
    (value.semanticRevision as number) < 0 ||
    ![value.pendingRequests, value.queuedFollowUps, value.inFlightCommands].every(count =>
      Number.isSafeInteger(count) && (count as number) === 0) ||
    value.unconfirmedOperations !== false)
    fail('continuation-owner-fence-unqualified');
  return freezeTree(jsonCopy(value as unknown as ContinuationOwnerFence));
}
function currentThreadTuple(thread: Row, cwd: string): Row {
  if (thread.model !== 'gpt-5.6-sol' || thread.reasoningEffort !== 'low' ||
    !samePath(thread.cwd, cwd) || !Array.isArray(thread.environments) || thread.environments.length > 1)
    fail('continuation-current-thread-unqualified');
  if (thread.environments.length === 1) {
    const environment = thread.environments[0];
    if (!object(environment) || environment.environmentId !== 'local' ||
      !strictKeys(environment, ['environmentId', 'cwd', 'runtimeWorkspaceRoots']) ||
      !samePath(environment.cwd, cwd) || !isDeepStrictEqual(environment.runtimeWorkspaceRoots, [cwd]))
      fail('continuation-current-environment-unqualified');
  }
  return { model: thread.model, effort: thread.reasoningEffort, cwd,
    environments: jsonCopy(thread.environments) };
}
function effectiveContinuation(resume: Row, taskId: string, cwd: string): QualifiedContinuationEvidence['effective'] {
  const thread = threadOf(resume, taskId, cwd, ['idle']);
  const current = currentThreadTuple(thread, cwd);
  if (resume.model !== current.model || resume.reasoningEffort !== current.effort ||
    !samePath(resume.cwd, cwd) || !object(resume.activePermissionProfile) ||
    resume.activePermissionProfile.id !== ':read-only' || !object(resume.sandbox) ||
    resume.sandbox.type !== 'readOnly' || resume.sandbox.networkAccess !== false ||
    !strictKeys(resume.sandbox, ['type', 'networkAccess']) ||
    !isDeepStrictEqual(resume.runtimeWorkspaceRoots, [cwd]) ||
    (resume.serviceTier !== null && resume.serviceTier !== 'default') ||
    !['never', 'on-request'].includes(resume.approvalPolicy as string) ||
    resume.approvalsReviewer !== 'user') fail('continuation-effective-policy-unqualified');
  return freezeTree({ model: 'gpt-5.6-sol' as const, effort: 'low' as const, cwd,
    activePermissionProfileId: ':read-only' as const,
    approvalPolicy: resume.approvalPolicy as 'never' | 'on-request',
    approvalsReviewer: 'user' as const, sandboxType: 'readOnly' as const,
    networkAccess: false as const, serviceTier: resume.serviceTier as 'default' | null,
    runtimeWorkspaceRoots: [cwd],
    environments: current.environments as Row[] });
}
interface ContinuationPhase {
  readonly turns: Row[];
  readonly historyDigest: string;
  readonly current: Row;
}
async function continuationPhase(reader: FrontendReader, taskId: string, cwd: string): Promise<ContinuationPhase> {
  const first = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
    taskId, cwd, ['idle']);
  const before = currentThreadTuple(first, cwd);
  const turns = await fullHistory(reader, taskId);
  await noGoalOrQueue(reader, taskId);
  const last = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
    taskId, cwd, ['idle']);
  if (!isDeepStrictEqual(before, currentThreadTuple(last, cwd)) ||
    !isDeepStrictEqual(first.turns, last.turns) || (last.turns as unknown[]).length !== turns.length ||
    !turns.every((turn, index) => {
      const observed = (last.turns as unknown[])[index];
      return terminalStatuses.has(turn.status as string) && object(observed) &&
        terminalStatuses.has(observed.status as string) && observed.status === turn.status &&
        observed.id === turn.id;
    })) fail('continuation-history-unstable-or-nonterminal');
  return { turns, historyDigest: createHash('sha256').update(JSON.stringify(turns)).digest('hex'),
    current: before };
}

/** Qualifies one already-running, owner-scoped backend. Never launches or stops it. */
export async function bootstrapManagedWorker(options: ManagedWorkerBootstrapOptions): Promise<ManagedWorkerBootstrap> {
  const { generation, resume, initialize, policy } = scope(options);
  const host = options.host, adapterKey = options.adapterKey, taskId = options.taskId, cwd = options.cwd;
  const guard = () => current(host, taskId, generation);
  const withReader = async <T>(work: (reader: FrontendReader) => Promise<T>,
    extraGuard: () => void = () => {}): Promise<T> => {
    const check = () => { guard(); extraGuard(); };
    check();
    const capability = options.frontendProtocol === 'websocket'
      ? (typeof host.frontendWebSocketCapability === 'function'
        ? host.frontendWebSocketCapability(adapterKey)
        : fail('websocket-frontend-unavailable'))
      : host.frontendCapability(adapterKey);
    const reader = await FrontendReader.open(capability, initialize, check);
    try { check(); const result = await work(reader); check(); return result; }
    finally { reader.close(); }
  };
  const withIdleReader = async <T>(work: (reader: ReadClient) => Promise<T>): Promise<T> => {
    if (options.frontendProtocol !== 'websocket') return withReader(work);
    const key = options.ownerReadControlKey;
    if (!key || typeof key !== 'object' || typeof host.ownerRead !== 'function')
      return fail('owner-read-unavailable');
    guard();
    const reader: ReadClient = { request: async (method, params) => {
      guard();
      if (method === 'initialize' || method === 'thread/resume')
        return fail('owner-read-mutation-refused');
      const result = await host.ownerRead!(key, generation, method, params);
      guard();
      return result;
    } };
    const result = await work(reader);
    guard();
    return result;
  };
  const qualified = await withReader(async reader => {
    const before = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
      taskId, cwd, ['notLoaded']);
    if ((before.turns as unknown[]).length !== 0 || (await fullHistory(reader, taskId)).length !== 0)
      fail('pre-resume-history-not-empty');
    await noGoalOrQueue(reader, taskId);
    const start = await reader.request('thread/resume', resume);
    qualifiedStart(start, taskId, cwd, policy);
    const defaults = defaultsOf(await reader.request('config/read', { cwd, includeLayers: false }),
      taskId, cwd);
    const read = await reader.request('thread/read', { threadId: taskId, includeTurns: true });
    exposedInitialSettings(threadOf(read, taskId, cwd, ['idle']), start, cwd, policy);
    await noGoalOrQueue(reader, taskId);
    if ((await fullHistory(reader, taskId)).length !== 0) fail('initial-history-not-empty');
    return { start: freezeTree(jsonCopy(start)), defaults,
      state: freezeTree(initialProjection(start, read, taskId, cwd, policy)) };
  });
  const readInitialState = async (): Promise<NativeProjectionState> => withReader(async reader => {
    const read = await reader.request('thread/read', { threadId: taskId, includeTurns: true });
    exposedInitialSettings(threadOf(read, taskId, cwd, ['idle']), qualified.start, cwd, policy);
    await noGoalOrQueue(reader, taskId);
    if ((await fullHistory(reader, taskId)).length !== 0) fail('initial-history-not-empty');
    const state = initialProjection(qualified.start, read, taskId, cwd, policy);
    if (!isDeepStrictEqual(state.latestThreadSettings, qualified.state.latestThreadSettings) ||
      !isDeepStrictEqual(state.currentPermissions, qualified.state.currentPermissions) ||
      !isDeepStrictEqual(state.environments, qualified.state.environments)) fail('initial-settings-drift');
    return freezeTree(state);
  });
  const verifyIdle = async (expectedTurnIds: readonly string[] = [],
    expectedQueueClientIds: readonly string[] = []):
    Promise<Readonly<{ turnCount: number; latestTurnId: string | null }>> => {
    const expected = jsonCopy(expectedTurnIds);
    if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string' || !id) ||
      new Set(expected).size !== expected.length) fail('invalid-expected-turn-ids');
    const queueClients = jsonCopy(expectedQueueClientIds);
    if (!Array.isArray(queueClients) || queueClients.some(id => typeof id !== 'string' || !id) ||
        new Set(queueClients).size !== queueClients.length) fail('invalid-expected-queue-clients');
    return withIdleReader(async reader => {
      const first = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
        taskId, cwd, ['idle']);
      const turns = await fullHistory(reader, taskId);
      await noGoalOrQueue(reader, taskId);
      const last = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
        taskId, cwd, ['idle']);
      const finalTurns = await fullHistory(reader, taskId);
      await noGoalOrQueue(reader, taskId);
      if (!isDeepStrictEqual(first.turns, last.turns) || first.updatedAt !== last.updatedAt ||
        !isDeepStrictEqual(turns, finalTurns) ||
        (last.turns as unknown[]).length !== turns.length ||
        !turns.every((turn, index) => {
          const observed = (last.turns as unknown[])[index];
          return terminalStatuses.has(turn.status as string) && object(observed) &&
            terminalStatuses.has(observed.status as string) && observed.status === turn.status &&
            observed.id === turn.id;
        }))
        fail('idle-history-unstable-or-nonterminal');
      const terminalIds = new Set(turns.map(turn => turn.id));
      if (expected.some(id => !terminalIds.has(id))) throw new ManagedWorkerIdleProofRefusedError();
      if (queueClients.length) {
        const clientCounts = new Map<string, number>();
        for (const turn of turns) for (const item of turn.items as unknown[]) {
          if (!object(item) || item.type !== 'userMessage') continue;
          if (typeof item.clientId === 'string' && item.clientId.length > 0)
            clientCounts.set(item.clientId, (clientCounts.get(item.clientId) ?? 0) + 1);
        }
        if (queueClients.some(id => clientCounts.get(id) !== 1))
          throw new ManagedWorkerIdleProofRefusedError('accepted-queue-input-not-terminal');
      }
      return Object.freeze({ turnCount: turns.length, latestTurnId: turns.at(-1)?.id as string | undefined ?? null });
    });
  };
  const qualifyContinuation = async (ownerFence: () => ContinuationOwnerFence): Promise<QualifiedContinuationEvidence> => {
    // The typed continuation compiler still admits the legacy read-only tuple only.
    if (policy) fail('opt-in-continuation-not-qualified');
    if (typeof ownerFence !== 'function') fail('continuation-owner-fence-required');
    // The caller owns this semantic counter: settings, turn, pending-request,
    // queue and owner-reconnect transitions must advance it. Token usage and
    // an already-null goal notification alone need not advance it.
    const admitted = ownerFenceSnapshot(ownerFence(), taskId, generation);
    const checkOwner = () => {
      if (!isDeepStrictEqual(admitted, ownerFenceSnapshot(ownerFence(), taskId, generation)))
        fail('continuation-owner-fence-changed');
    };
    return withReader(async reader => {
      const before = await continuationPhase(reader, taskId, cwd);
      if (before.turns.length === 0) fail('continuation-requires-prior-turn');
      // Exact ID-only rejoin on the already-loaded same worker. No history,
      // path, model, permission, config, or other override is ever sent.
      const resumeCurrent = await reader.request('thread/resume', { threadId: taskId });
      const effective = effectiveContinuation(resumeCurrent, taskId, cwd);
      if (!isDeepStrictEqual(before.current, { model: effective.model, effort: effective.effort,
        cwd, environments: effective.environments })) fail('continuation-resume-read-differs');
      const after = await continuationPhase(reader, taskId, cwd);
      if (before.historyDigest !== after.historyDigest || !isDeepStrictEqual(before.current, after.current))
        fail('continuation-state-changed-during-rejoin');
      const defaults = defaultsOf(await reader.request('config/read', { cwd, includeLayers: false }), taskId, cwd);
      checkOwner();
      return freezeTree({ owner: admitted, turnCount: after.turns.length,
        latestTurnId: after.turns.at(-1)?.id as string | undefined ?? null,
        terminalTurnIds: after.turns.map(turn => turn.id as string),
        historyDigest: after.historyDigest, effective, composerDefaults: defaults });
    }, checkOwner);
  };
  const readStockState = async (assertCurrent: () => void): Promise<StockReadState> => {
    if (typeof assertCurrent !== 'function') fail('stock-current-fence-required');
    return withReader(async reader => {
      const first = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
        taskId, cwd, ['idle']);
      const turns = await fullHistory(reader, taskId);
      await noGoalOrQueue(reader, taskId);
      const requirements = await reader.request('configRequirements/read', {});
      const last = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
        taskId, cwd, ['idle']);
      const finalTurns = await fullHistory(reader, taskId);
      await noGoalOrQueue(reader, taskId);
      if (!isDeepStrictEqual(first, last) || (last.turns as unknown[]).length !== turns.length ||
          !isDeepStrictEqual(turns, finalTurns) ||
          !turns.every((turn, index) => {
            const observed = (last.turns as unknown[])[index];
            return terminalStatuses.has(turn.status as string) && object(observed) &&
              terminalStatuses.has(observed.status as string) && observed.status === turn.status &&
              observed.id === turn.id;
          })) fail('stock-history-unstable-or-nonterminal');
      if (typeof last.model !== 'string' || !last.model ||
          typeof last.modelProvider !== 'string' || !last.modelProvider ||
          !(last.reasoningEffort === null || typeof last.reasoningEffort === 'string') ||
          !samePath(last.cwd, cwd) || !Array.isArray(last.environments) ||
          !Number.isFinite(last.updatedAt)) fail('stock-thread-tuple-unqualified');
      const feature = object(requirements.requirements) &&
        object(requirements.requirements.featureRequirements)
        ? requirements.requirements.featureRequirements.fast_mode ?? null : null;
      if (feature !== null && feature !== true && feature !== false) fail('stock-tier-requirement-unqualified');
      return freezeTree({ threadId: taskId, generation, turnCount: turns.length,
        terminalTurnIds: turns.map(turn => turn.id as string),
        historyDigest: createHash('sha256').update(JSON.stringify(turns)).digest('hex'),
        model: last.model as string, modelProvider: last.modelProvider as string,
        reasoningEffort: last.reasoningEffort as string | null, cwd,
        environments: jsonCopy(last.environments as Row[]),
        updatedAt: last.updatedAt as number, fastModeAllowed: feature as boolean | null });
    }, assertCurrent);
  };
  return Object.freeze({ generation, initialState: qualified.state,
    composerDefaults: qualified.defaults, readInitialState, verifyIdle, qualifyContinuation,
    readStockState });
}
