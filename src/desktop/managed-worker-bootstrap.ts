import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { createProjection } from '../codex/managed-native-projection.js';
import type { NativeProjectionState } from '../codex/managed-native-projection.js';
import type { ManagedWorkerFrontendHost } from '../codex/managed-worker-frontend-host.js';

type Row = Record<string, unknown>;
type ReadMethod = 'thread/read' | 'thread/turns/list' | 'thread/goal/get' | 'thread/queue/list' | 'config/read';
const MAX_FRAME_BYTES = 2_000_000;
const RPC_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const terminalStatuses = new Set(['completed', 'failed', 'interrupted']);

export interface ManagedWorkerBootstrapOptions {
  readonly host: Pick<ManagedWorkerFrontendHost, 'metadata' | 'frontendCapability'>;
  readonly adapterKey: object;
  readonly taskId: string;
  readonly cwd: string;
  readonly initializeRequest: Row;
  /** Exact owner-authorized, immutable read-only resume params; no inferred defaults. */
  readonly resumeParams: Row;
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
  verifyIdle(): Promise<Readonly<{ turnCount: number; latestTurnId: string | null }>>;
}

function object(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code: string): never { throw new TypeError(`managed worker bootstrap: ${code}`); }
function samePath(a: unknown, b: string): boolean {
  return typeof a === 'string' &&
    path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
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
function scope(options: ManagedWorkerBootstrapOptions): { generation: number; resume: Row; initialize: Row } {
  if (!options || !options.host || !options.adapterKey || typeof options.adapterKey !== 'object' ||
    typeof options.taskId !== 'string' || !options.taskId || typeof options.cwd !== 'string' || !options.cwd ||
    !object(options.resumeParams) || !object(options.initializeRequest)) fail('invalid-options');
  const resume = jsonCopy(options.resumeParams), initialize = jsonCopy(options.initializeRequest);
  if (!strictKeys(resume, ['threadId', 'cwd', 'model', 'permissions', 'approvalPolicy', 'runtimeWorkspaceRoots', 'config']) ||
    resume.threadId !== options.taskId || !samePath(resume.cwd, options.cwd) ||
    resume.model !== 'gpt-5.6-sol' || resume.permissions !== ':read-only' ||
    resume.approvalPolicy !== 'never' || !isDeepStrictEqual(resume.runtimeWorkspaceRoots, [options.cwd]) ||
    !object(resume.config) || !strictKeys(resume.config, ['model_reasoning_effort']) ||
    resume.config.model_reasoning_effort !== 'low' || !object(initialize.clientInfo) ||
    !object(initialize.capabilities)) fail('unqualified-resume-policy');
  const metadata = options.host.metadata;
  if (metadata.state !== 'running' || metadata.taskId !== options.taskId ||
    !Number.isSafeInteger(metadata.backendGeneration) || (metadata.backendGeneration ?? 0) < 1)
    fail('host-generation-unavailable');
  return { generation: metadata.backendGeneration as number, resume, initialize };
}
function current(host: ManagedWorkerBootstrapOptions['host'], taskId: string, generation: number): void {
  const metadata = host.metadata;
  if (metadata.state !== 'running' || metadata.taskId !== taskId ||
    metadata.backendGeneration !== generation) fail('host-generation-changed');
}

/** One authenticated attachment; close detaches only this socket, never the worker. */
class FrontendReader {
  readonly #socket: Socket;
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';
  #frames: Row[] = [];
  #waiting: { resolve(frame: Row): void; reject(error: Error): void } | null = null;
  #failure: Error | null = null;
  #nextId = 1;
  readonly #guard: () => void;
  private constructor(socket: Socket, guard: () => void) {
    this.#socket = socket;
    this.#guard = guard;
    socket.on('data', chunk => this.#receive(chunk));
    socket.on('error', () => this.#fail(new Error('frontend-socket-error')));
    socket.on('close', () => this.#fail(new Error('frontend-eof')));
  }
  static async open(capability: Readonly<{ host: string; port: number; token: string }>,
    initialize: Row, guard: () => void): Promise<FrontendReader> {
    if (capability.host !== '127.0.0.1' || !Number.isSafeInteger(capability.port) ||
      capability.port < 1 || capability.port > 65535 || typeof capability.token !== 'string' ||
      capability.token.length < 32) fail('invalid-frontend-capability');
    const socket = connect({ host: capability.host, port: capability.port });
    const reader = new FrontendReader(socket, guard);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frontend-connect-timeout')), RPC_TIMEOUT_MS);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error('frontend-connect-failed')); });
      });
      guard();
      reader.#send({ token: capability.token });
      const auth = await reader.#next();
      if (auth.ok !== true) fail('frontend-auth-failed');
      guard();
      await reader.request('initialize', initialize);
      return reader;
    } catch (error) { reader.close(); throw error; }
  }
  close(): void { this.#socket.destroy(); }
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
        if (this.#waiting) { const waiting = this.#waiting; this.#waiting = null; waiting.resolve(frame); }
        else {
          if (this.#frames.length >= 32) throw new Error('frontend-frame-backlog');
          this.#frames.push(frame);
        }
      } catch { this.#fail(new Error('frontend-frame-malformed')); this.close(); return; }
    }
  }
  #send(frame: Row): void {
    if (this.#failure || this.#socket.destroyed) throw new Error('frontend-eof');
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) fail('outbound-frame-overflow');
    this.#socket.write(line);
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

function threadOf(result: Row, taskId: string, cwd: string, statuses: readonly string[]): Row {
  if (!object(result.thread) || result.thread.id !== taskId ||
    !object(result.thread.status) || !statuses.includes(result.thread.status.type as string) ||
    !Array.isArray(result.thread.turns) ||
    (result.thread.cwd !== undefined && result.thread.cwd !== null && !samePath(result.thread.cwd, cwd)))
    fail('thread-read-unqualified');
  return result.thread;
}
async function fullHistory(client: FrontendReader, taskId: string): Promise<Row[]> {
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
async function noGoalOrQueue(client: FrontendReader, taskId: string): Promise<void> {
  const goal = await client.request('thread/goal/get', { threadId: taskId });
  const queue = await client.request('thread/queue/list', { threadId: taskId, limit: PAGE_LIMIT });
  if (goal.goal !== null || !Array.isArray(queue.data) || queue.data.length !== 0 || queue.nextCursor !== null)
    fail('goal-or-queue-not-empty');
}
function qualifiedStart(start: Row, taskId: string, cwd: string): void {
  if (!object(start.thread) || start.thread.id !== taskId || !samePath(start.cwd, cwd) ||
    start.model !== 'gpt-5.6-sol' || start.reasoningEffort !== 'low' ||
    start.approvalPolicy !== 'never' || !object(start.activePermissionProfile) ||
    start.activePermissionProfile.id !== ':read-only' || !object(start.sandbox) ||
    start.sandbox.type !== 'readOnly' || start.sandbox.networkAccess !== false ||
    !isDeepStrictEqual(start.runtimeWorkspaceRoots, [cwd])) fail('resume-settings-unqualified');
}
function exposedInitialSettings(thread: Row, start: Row, cwd: string): void {
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
function initialProjection(start: Row, read: Row, taskId: string, cwd: string): NativeProjectionState {
  const thread = threadOf(read, taskId, cwd, ['idle']);
  if ((thread.turns as unknown[]).length !== 0) fail('initial-history-not-empty');
  const state = createProjection(start, { thread: { ...thread, turns: [] } },
    { hostId: 'local', workspaceKind: 'projectless', environments: [] });
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

/** Qualifies one already-running, owner-scoped backend. Never launches or stops it. */
export async function bootstrapManagedWorker(options: ManagedWorkerBootstrapOptions): Promise<ManagedWorkerBootstrap> {
  const { generation, resume, initialize } = scope(options);
  const host = options.host, adapterKey = options.adapterKey, taskId = options.taskId, cwd = options.cwd;
  const guard = () => current(host, taskId, generation);
  const withReader = async <T>(work: (reader: FrontendReader) => Promise<T>): Promise<T> => {
    guard();
    const reader = await FrontendReader.open(host.frontendCapability(adapterKey), initialize, guard);
    try { guard(); const result = await work(reader); guard(); return result; }
    finally { reader.close(); }
  };
  const qualified = await withReader(async reader => {
    const before = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
      taskId, cwd, ['notLoaded']);
    if ((before.turns as unknown[]).length !== 0 || (await fullHistory(reader, taskId)).length !== 0)
      fail('pre-resume-history-not-empty');
    await noGoalOrQueue(reader, taskId);
    const start = await reader.request('thread/resume', resume);
    qualifiedStart(start, taskId, cwd);
    const defaults = defaultsOf(await reader.request('config/read', { cwd, includeLayers: false }),
      taskId, cwd);
    const read = await reader.request('thread/read', { threadId: taskId, includeTurns: true });
    exposedInitialSettings(threadOf(read, taskId, cwd, ['idle']), start, cwd);
    await noGoalOrQueue(reader, taskId);
    if ((await fullHistory(reader, taskId)).length !== 0) fail('initial-history-not-empty');
    return { start: freezeTree(jsonCopy(start)), defaults,
      state: freezeTree(initialProjection(start, read, taskId, cwd)) };
  });
  const readInitialState = async (): Promise<NativeProjectionState> => withReader(async reader => {
    const read = await reader.request('thread/read', { threadId: taskId, includeTurns: true });
    exposedInitialSettings(threadOf(read, taskId, cwd, ['idle']), qualified.start, cwd);
    await noGoalOrQueue(reader, taskId);
    if ((await fullHistory(reader, taskId)).length !== 0) fail('initial-history-not-empty');
    const state = initialProjection(qualified.start, read, taskId, cwd);
    if (!isDeepStrictEqual(state.latestThreadSettings, qualified.state.latestThreadSettings) ||
      !isDeepStrictEqual(state.currentPermissions, qualified.state.currentPermissions) ||
      !isDeepStrictEqual(state.environments, qualified.state.environments)) fail('initial-settings-drift');
    return freezeTree(state);
  });
  const verifyIdle = async (): Promise<Readonly<{ turnCount: number; latestTurnId: string | null }>> =>
    withReader(async reader => {
      const first = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
        taskId, cwd, ['idle']);
      const turns = await fullHistory(reader, taskId);
      await noGoalOrQueue(reader, taskId);
      const last = threadOf(await reader.request('thread/read', { threadId: taskId, includeTurns: true }),
        taskId, cwd, ['idle']);
      if (!isDeepStrictEqual(first.turns, last.turns) || first.updatedAt !== last.updatedAt ||
        (last.turns as unknown[]).length !== turns.length ||
        !turns.every((turn, index) => {
          const observed = (last.turns as unknown[])[index];
          return terminalStatuses.has(turn.status as string) && object(observed) &&
            terminalStatuses.has(observed.status as string) && observed.status === turn.status &&
            observed.id === turn.id;
        }))
        fail('idle-history-unstable-or-nonterminal');
      return Object.freeze({ turnCount: turns.length, latestTurnId: turns.at(-1)?.id as string | undefined ?? null });
    });
  return Object.freeze({ generation, initialState: qualified.state,
    composerDefaults: qualified.defaults, readInitialState, verifyIdle });
}
