import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { AppServerRequestOptions, AppServerInitializedSession,
  AppServerResponseEnvelope } from './app-server-connection.js';
import type { WorkerCommandResponse } from './managed-worker-command-dispatcher.js';

type JsonObject = Record<string, unknown>;
type Frame = JsonObject;
type RequestId = string | number;
type Kind = 'bootstrap' | 'catalog' | 'read' | 'rejoin';
interface FrontendBackend {
  initializedSession(): Promise<AppServerInitializedSession>;
  isSessionCurrent(generation: number): boolean;
  onNotification(listener: (notification: { method: string; params: JsonObject }) => void): () => void;
  request(method: string, params?: JsonObject, options?: AppServerRequestOptions): Promise<unknown>;
}
type ResumeAuthority = (context: Readonly<{ taskId: string; generation: number }>) => unknown;
interface FrontendStart {
  readonly ownerEpoch: string;
  /** The pinned backend's actual successful ID-only resume result, before CLI delivery. */
  readonly observeResume: (context: Readonly<{ taskId: string; generation: number;
    result: JsonObject }>) => void;
  /** Owner-controlled durable dispatcher only. Never call backend.request directly. */
  readonly run: (context: Readonly<{ taskId: string; generation: number;
    params: JsonObject }>) => Promise<WorkerCommandResponse>;
}
interface SessionOptions {
  readonly backendFactory: (initializeRequest: Readonly<JsonObject>) => FrontendBackend;
  readonly initializeRequest: JsonObject;
  readonly taskId: string;
  readonly bootstrapReadMethods?: readonly string[];
  readonly ownCwd?: string | null;
  readonly trustedLocalFrontend?: boolean;
  readonly resumeAuthority?: ResumeAuthority | null;
  readonly frontendStart?: FrontendStart | null;
  readonly requestInbox?: FrontendRequestInbox | null;
}
interface FrontendAttachment {
  readonly generation: number;
  detach(): void;
  receive(frame: unknown): Promise<string>;
}
interface InboxLease {
  detach(): void;
  answer(id: RequestId, result: JsonObject): boolean;
  reject(id: RequestId, error: JsonObject): boolean;
}
interface FrontendRequestInbox {
  readonly owner: Readonly<{ threadId: string; generation: number }>;
  attach(send: (frame: Readonly<{ id: RequestId; method: string; params: JsonObject }>) => void): InboxLease;
}
interface EarlyAnswer { frame: Frame; resolve: (status: string) => void }

// Prepare-only attachment layer. No listener, executable shim or live worker is
// started here. The injected factory receives the immutable initialize request
// to pass to AppServerConnection; its initializedSession response does not echo
// negotiated capabilities and cannot establish compatibility by itself.
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const idValid = (id: unknown): id is RequestId => (typeof id === 'string' && id.length > 0) ||
  (typeof id === 'number' && Number.isSafeInteger(id));
const keysOnly = (value: unknown, allowed: readonly string[]): value is JsonObject => object(value) &&
  Object.keys(value).every(key => allowed.includes(key));
const error = (id: RequestId, code: number, message: string): Frame => ({ id, error: { code, message } });
const bootstrapMethods = Object.freeze([
  'config/read', 'configRequirements/read', 'model/list', 'permissionProfile/list',
  'account/read', 'account/rateLimits/read', 'getAuthStatus',
  'thread/turns/list', 'thread/list', 'thread/loaded/list',
  'collaborationMode/list', 'hooks/list', 'skills/list', 'plugin/list',
  'app/installed', 'app/list', 'app/read',
]);
const maxReadyRequests = 128;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const nullable = (value: unknown, check: (value: unknown) => boolean): boolean => value === null || check(value);
const textValue = (value: unknown): value is string => typeof value === 'string';
const cursorValue = (value: unknown): boolean => nullable(value, textValue);
const limitValue = (value: unknown): boolean => nullable(value, n =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 1000);
const optional = (value: JsonObject, key: string, check: (value: unknown) => boolean): boolean =>
  !own(value, key) || check(value[key]);
const oneOf = (value: unknown, choices: readonly string[]): boolean =>
  nullable(value, item => typeof item === 'string' && choices.includes(item));
const stringArray = (value: unknown): boolean => nullable(value, items => Array.isArray(items) &&
  items.every(textValue));
const cwdValue = (value: unknown, ownCwd: string | null): boolean => nullable(value, cwd => {
  if (typeof ownCwd !== 'string' || typeof cwd !== 'string') return false;
  // The gateway can run on either host OS. Windows roots are case-insensitive;
  // POSIX roots are not. A root-relative Windows path or a foreign path must
  // never be treated as evidence of the worker's own workspace.
  const windowsOwn = path.win32.isAbsolute(ownCwd) && path.win32.parse(ownCwd).root.length > 1;
  if (windowsOwn) return path.win32.isAbsolute(cwd) && path.win32.parse(cwd).root.length > 1 &&
    path.win32.resolve(cwd).toLowerCase() === path.win32.resolve(ownCwd).toLowerCase();
  const posixAbsolute = (value: string): boolean => path.posix.isAbsolute(value) &&
    !value.startsWith('//') && !/[\\\u0000-\u001f\u007f]/u.test(value);
  return posixAbsolute(ownCwd) && posixAbsolute(cwd) &&
    path.posix.resolve(cwd) === path.posix.resolve(ownCwd);
});
const ownCwds = (value: unknown, ownCwd: string | null): boolean =>
  Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' &&
  cwdValue(value[0], ownCwd);
const appIds = (value: unknown): boolean => Array.isArray(value) &&
  value.length > 0 && value.length <= 100 &&
  value.every(id => typeof id === 'string' && id.length <= 128 &&
    /^(?:asdk_app_[A-Za-z0-9]+|connector_[A-Za-z0-9_]+)$/u.test(id)) &&
  new Set(value).size === value.length;
function bootstrapKind(method: string, params: unknown, taskId: string,
  ownCwd: string | null, trustedLocalFrontend: boolean): Kind | null {
  if (method === 'configRequirements/read' &&
    (params === undefined || params === null || keysOnly(params, []))) return 'bootstrap';
  if (!object(params)) return null;
  if (method === 'collaborationMode/list' && keysOnly(params, [])) return 'bootstrap';
  if (method === 'hooks/list' && keysOnly(params, ['cwds']) &&
    ownCwds(params.cwds, ownCwd)) return 'bootstrap';
  if (method === 'skills/list' && keysOnly(params, ['cwds', 'forceReload']) &&
    ownCwds(params.cwds, ownCwd) &&
    optional(params, 'forceReload', value => typeof value === 'boolean')) return 'bootstrap';
  if (method === 'plugin/list' && keysOnly(params, ['cwds', 'marketplaceKinds']) &&
    ownCwds(params.cwds, ownCwd) &&
    optional(params, 'marketplaceKinds', value => value === null)) return 'bootstrap';
  if (method === 'app/installed' && keysOnly(params, ['threadId']) &&
    params.threadId === taskId) return 'bootstrap';
  if (method === 'app/list' && keysOnly(params, ['threadId', 'cursor', 'limit']) &&
    params.threadId === taskId && optional(params, 'cursor', cursorValue) &&
    optional(params, 'limit', limitValue)) return 'bootstrap';
  if (method === 'app/read' && keysOnly(params, ['threadId', 'appIds']) &&
    params.threadId === taskId && appIds(params.appIds)) return 'bootstrap';
  if (method === 'config/read' && keysOnly(params, ['includeLayers', 'cwd']) &&
    optional(params, 'includeLayers', value => typeof value === 'boolean') &&
    optional(params, 'cwd', value => cwdValue(value, ownCwd))) return 'bootstrap';
  if (method === 'model/list' && keysOnly(params, ['cursor', 'limit', 'includeHidden']) &&
    optional(params, 'cursor', cursorValue) && optional(params, 'limit', limitValue) &&
    optional(params, 'includeHidden', value => nullable(value, v => typeof v === 'boolean'))) return 'bootstrap';
  if (method === 'permissionProfile/list' && keysOnly(params, ['cursor', 'limit', 'cwd']) &&
    optional(params, 'cursor', cursorValue) && optional(params, 'limit', limitValue) &&
    optional(params, 'cwd', value => cwdValue(value, ownCwd))) return 'bootstrap';
  if (method === 'account/read' && keysOnly(params, ['refreshToken']) &&
    optional(params, 'refreshToken', value => value === false || value === null)) return 'bootstrap';
  if (method === 'account/rateLimits/read' &&
    keysOnly(params, ['supportsLunaReserve', 'excludeResetCreditDetails']) &&
    optional(params, 'supportsLunaReserve', value => typeof value === 'boolean') &&
    optional(params, 'excludeResetCreditDetails', value => typeof value === 'boolean')) return 'bootstrap';
  if (method === 'getAuthStatus' && trustedLocalFrontend &&
    keysOnly(params, ['includeToken', 'refreshToken']) &&
    own(params, 'includeToken') && (params.includeToken === true || params.includeToken === false ||
      params.includeToken === null) && own(params, 'refreshToken') &&
    (params.refreshToken === false || params.refreshToken === null)) return 'bootstrap';
  if (method === 'thread/turns/list' && keysOnly(params,
    ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView']) &&
    params.threadId === taskId && optional(params, 'cursor', cursorValue) &&
    optional(params, 'limit', limitValue) &&
    optional(params, 'sortDirection', value => oneOf(value, ['asc', 'desc'])) &&
    optional(params, 'itemsView', value => oneOf(value, ['notLoaded', 'summary', 'full']))) return 'bootstrap';
  if (method === 'thread/loaded/list' && keysOnly(params, ['cursor', 'limit']) &&
    optional(params, 'cursor', cursorValue) && optional(params, 'limit', limitValue)) return 'catalog';
  if (method === 'thread/list' && keysOnly(params, [
    'cursor', 'limit', 'sortKey', 'sortDirection', 'modelProviders', 'sourceKinds',
    'originators', 'archived', 'sectionId', 'projectId', 'cwd', 'useStateDbOnly',
    'searchTerm', 'parentThreadId', 'ancestorThreadId']) &&
    optional(params, 'cursor', cursorValue) && optional(params, 'limit', limitValue) &&
    optional(params, 'sortKey', value => oneOf(value,
      ['created_at', 'updated_at', 'recency_at', 'section_position'])) &&
    optional(params, 'sortDirection', value => oneOf(value, ['asc', 'desc'])) &&
    optional(params, 'modelProviders', stringArray) &&
    optional(params, 'sourceKinds', value => nullable(value, items => Array.isArray(items) &&
      items.every(item => typeof item === 'string' && ['cli', 'vscode', 'exec', 'appServer', 'subAgent',
        'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn',
        'subAgentOther', 'unknown'].includes(item)))) &&
    optional(params, 'originators', value => nullable(value, items =>
      Array.isArray(items) && items.length === 0)) &&
    optional(params, 'archived', value => nullable(value, v => typeof v === 'boolean')) &&
    optional(params, 'sectionId', cursorValue) && optional(params, 'projectId', cursorValue) &&
    optional(params, 'cwd', value => nullable(value, cwd => textValue(cwd) ||
      (Array.isArray(cwd) && cwd.every(textValue)))) &&
    optional(params, 'useStateDbOnly', value => typeof value === 'boolean') &&
    optional(params, 'searchTerm', cursorValue) &&
    optional(params, 'parentThreadId', cursorValue) &&
    optional(params, 'ancestorThreadId', cursorValue) &&
    !(params.parentThreadId && params.ancestorThreadId)) return 'catalog';
  return null;
}
function filteredCatalog(method: string, result: unknown, taskId: string): JsonObject | null {
  if (!object(result) || !Array.isArray(result.data) ||
    !own(result, 'nextCursor') || !cursorValue(result.nextCursor) ||
    (method === 'thread/list' &&
      (!own(result, 'backwardsCursor') || !cursorValue(result.backwardsCursor)))) return null;
  if (method === 'thread/list') {
    if (!result.data.every(item => object(item) && typeof item.id === 'string')) return null;
    return { data: result.data.filter(item => object(item) && item.id === taskId),
      nextCursor: result.nextCursor, backwardsCursor: result.backwardsCursor };
  }
  if (!result.data.every(item => typeof item === 'string')) return null;
  return { data: result.data.filter(item => item === taskId),
    nextCursor: result.nextCursor };
}
function freezeJson<T>(value: T): T {
  if (object(value) || Array.isArray(value)) {
    for (const nested of Object.values(value)) freezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

function requestKind(method: string, params: unknown, taskId: string): Kind | null {
  if (!object(params) || params.threadId !== taskId) return null;
  if (method === 'thread/resume' && keysOnly(params, ['threadId'])) return 'rejoin';
  if (method === 'thread/read' && keysOnly(params, ['threadId', 'includeTurns']) &&
    (!own(params, 'includeTurns') || typeof params.includeTurns === 'boolean')) return 'read';
  if (method === 'thread/goal/get' && keysOnly(params, ['threadId'])) return 'read';
  if (method === 'thread/queue/list' && keysOnly(params, ['threadId', 'cursor', 'limit']) &&
    (!own(params, 'cursor') || params.cursor === null || typeof params.cursor === 'string') &&
    (!own(params, 'limit') || (typeof params.limit === 'number' && Number.isSafeInteger(params.limit) &&
      params.limit >= 1 && params.limit <= 100))) return 'read';
  if (method === 'thread/items/list' && keysOnly(params,
    ['threadId', 'turnId', 'cursor', 'limit', 'sortDirection']) &&
    optional(params, 'turnId', cursorValue) && optional(params, 'cursor', cursorValue) &&
    optional(params, 'limit', limitValue) &&
    optional(params, 'sortDirection', value => oneOf(value, ['asc', 'desc']))) return 'read';
  return null;
}

// History supersedes threadId for stopped threads; it is never safe in this
// attachment. Every other native resume field must match a separately sourced
// authority snapshot for this exact task and backend generation.
const resumeKeys = ['threadId', 'history', 'path', 'model', 'modelProvider',
  'serviceTier', 'cwd', 'runtimeWorkspaceRoots', 'approvalPolicy',
  'approvalsReviewer', 'sandbox', 'permissions', 'config',
  'baseInstructions', 'developerInstructions', 'personality',
  'excludeTurns', 'initialTurnsPage'];
function nativeResumeShape(params: unknown, taskId: string): params is JsonObject {
  return keysOnly(params, resumeKeys) && params.threadId === taskId &&
    optional(params, 'history', value => value === null) &&
    optional(params, 'path', value => nullable(value, textValue)) &&
    optional(params, 'excludeTurns', value => typeof value === 'boolean');
}
function authorizedResume(params: unknown, taskId: string, generation: number | undefined,
  resumeAuthority: ResumeAuthority | null, forQueue = false): Kind | null {
  if (typeof resumeAuthority !== 'function' || !nativeResumeShape(params, taskId)) return null;
  if (forQueue) return 'rejoin';
  try {
    if (generation === undefined) return null;
    const authority: unknown = structuredClone(resumeAuthority({ taskId, generation }));
    if (!keysOnly(authority, ['taskId', 'generation', 'params']) ||
      authority.taskId !== taskId || authority.generation !== generation ||
      !nativeResumeShape(authority.params, taskId) ||
      !isDeepStrictEqual(params, authority.params)) return null;
    return 'rejoin';
  } catch { return null; }
}

export class PersistentFrontendSessions {
  private readonly backendInitializeRequest: JsonObject;
  private readonly backend: FrontendBackend;
  private readonly taskId: string;
  private readonly bootstrapReadMethods: Set<string>;
  private readonly ownCwd: string | null;
  private readonly trustedLocalFrontend: boolean;
  private readonly resumeAuthority: ResumeAuthority | null;
  private readonly frontendStart: FrontendStart | null;
  private readonly requestInbox: FrontendRequestInbox | null;
  private readonly inboxOwner: Readonly<{ threadId: string; generation: number }> | null;
  private nextAttachmentGeneration = 0;
  private active: FrontendAttachment | null = null;
  private sessionPromise: Promise<AppServerInitializedSession> | null = null;
  private pinnedSession: AppServerInitializedSession | null = null;
  private startInFlight = false;

  constructor({ backendFactory, initializeRequest, taskId,
    bootstrapReadMethods = [], ownCwd = null, trustedLocalFrontend = false,
    resumeAuthority = null, frontendStart = null, requestInbox = null }: SessionOptions) {
    if (typeof backendFactory !== 'function' ||
      !object(initializeRequest) || !object(initializeRequest.clientInfo) ||
      !object(initializeRequest.capabilities) ||
      typeof taskId !== 'string' || taskId.length === 0) {
      throw new TypeError('A backend factory, exact initialize request, and own task are required');
    }
    if (!Array.isArray(bootstrapReadMethods) ||
      !bootstrapReadMethods.every(method => bootstrapMethods.includes(method)) ||
      !(ownCwd === null || (typeof ownCwd === 'string' && ownCwd.length > 0)) ||
      typeof trustedLocalFrontend !== 'boolean' ||
      !(resumeAuthority === null || typeof resumeAuthority === 'function') ||
      !(frontendStart === null || (object(frontendStart) &&
        typeof frontendStart.ownerEpoch === 'string' && uuid.test(frontendStart.ownerEpoch) &&
        typeof frontendStart.observeResume === 'function' &&
        typeof frontendStart.run === 'function'))) {
      throw new TypeError('Invalid explicit bootstrap read policy');
    }
    if (requestInbox !== null && (!object(requestInbox) ||
      !object(requestInbox.owner) || !Object.isFrozen(requestInbox.owner) ||
      requestInbox.owner.threadId !== taskId ||
      !Number.isSafeInteger(requestInbox.owner.generation) ||
      requestInbox.owner.generation < 1 ||
      typeof requestInbox.attach !== 'function')) {
      throw new TypeError('Invalid request inbox owner');
    }
    this.backendInitializeRequest = freezeJson(structuredClone(initializeRequest));
    // The construction site receives the exact immutable request compared with
    // every frontend. It must pass that object to AppServerConnection once.
    this.backend = backendFactory(this.backendInitializeRequest);
    if (!this.backend || typeof this.backend.initializedSession !== 'function' ||
      typeof this.backend.isSessionCurrent !== 'function' ||
      typeof this.backend.onNotification !== 'function' ||
      typeof this.backend.request !== 'function') {
      throw new TypeError('Backend factory did not create an AppServer-compatible connection');
    }
    this.taskId = taskId;
    this.bootstrapReadMethods = new Set(bootstrapReadMethods);
    this.ownCwd = ownCwd;
    // This flag is constructor-only: the embedding launcher must establish an
    // authenticated local stdio endpoint. It is never accepted from a frame.
    this.trustedLocalFrontend = trustedLocalFrontend;
    // The embedding launcher must derive this from saved native state, never
    // from the inbound frontend frame. It is opt-in and synchronous.
    this.resumeAuthority = resumeAuthority;
    this.frontendStart = frontendStart === null ? null : Object.freeze({
      ownerEpoch: frontendStart.ownerEpoch, run: frontendStart.run,
      observeResume: frontendStart.observeResume,
    });
    this.requestInbox = requestInbox;
    this.inboxOwner = requestInbox ? structuredClone(requestInbox.owner) : null;
  }

  attach(send: (frame: Frame) => void): FrontendAttachment {
    if (typeof send !== 'function') throw new TypeError('Synchronous frontend writer required');
    this.active?.detach();
    const generation = ++this.nextAttachmentGeneration;
    const pending = new Map<RequestId, { method: string; params: unknown }>();
    let state: 'new' | 'initializing' | 'ready' | 'detached' = 'new';
    let unsubscribe: (() => void) | null = null;
    let inboxLease: InboxLease | null = null;
    let replayingInbox = false;
    let earlyInboxAnswers: EarlyAnswer[] = [];
    let initializeBarrier: Promise<boolean> | null = null;
    let releaseInitialize: ((ready: boolean) => void) | null = null;
    const current = () => this.active === attachment && state !== 'detached';
    const safeSend = (frame: Frame): boolean => {
      if (!current()) return false;
      try { send(structuredClone(frame)); return true; }
      catch { attachment.detach(); return false; }
    };
    const liveBackend = (): boolean => !!this.pinnedSession &&
      this.backend.isSessionCurrent(this.pinnedSession.generation);
    const attachment: FrontendAttachment = {
      generation,
      detach: () => {
        if (state === 'detached') return;
        state = 'detached'; pending.clear();
        releaseInitialize?.(false); releaseInitialize = null;
        unsubscribe?.(); unsubscribe = null;
        inboxLease?.detach(); inboxLease = null;
        replayingInbox = false;
        for (const answer of earlyInboxAnswers) answer.resolve('detached');
        earlyInboxAnswers = [];
        if (this.active === attachment) this.active = null;
        // Intentionally never call backend.close(): the executor outlives stdio.
      },
      receive: async (frame: unknown): Promise<string> => {
        if (!current() || !object(frame)) return 'detached-or-invalid';
        if (this.requestInbox && (own(frame, 'result') || own(frame, 'error'))) {
          if (!idValid(frame.id) || Object.keys(frame).length !== 2 ||
            (own(frame, 'result') === own(frame, 'error')) ||
            !object(own(frame, 'result') ? frame.result : frame.error))
            return 'invalid-server-request-answer';
          if (replayingInbox && !inboxLease && state === 'ready' && liveBackend()) {
            if (earlyInboxAnswers.length >= 64) return 'server-request-unavailable';
            let snapshot;
            try { snapshot = structuredClone(frame); }
            catch { return 'invalid-server-request-answer'; }
            return new Promise(resolve => earlyInboxAnswers.push({ frame: snapshot, resolve }));
          }
          if (state !== 'ready' || !liveBackend() || !inboxLease)
            return 'server-request-unavailable';
          try {
            const accepted = own(frame, 'result') ?
              inboxLease.answer(frame.id, structuredClone(frame.result) as JsonObject) :
              inboxLease.reject(frame.id, structuredClone(frame.error) as JsonObject);
            return accepted && current() && liveBackend() ?
              'server-request-answered' : 'server-request-unavailable';
          } catch { return 'server-request-unavailable'; }
        }
        if (frame.method === 'initialized' && !own(frame, 'id') &&
          state === 'ready' && object(frame.params) &&
          Object.keys(frame.params).length === 0) return 'local-initialized';
        if (!idValid(frame.id) || typeof frame.method !== 'string') return 'invalid-envelope';
        const id = frame.id;
        const previous = pending.get(id);
        if (previous) {
          if (!isDeepStrictEqual(previous, { method: frame.method, params: frame.params })) {
            attachment.detach(); return 'conflicting-pending-id';
          }
          return 'duplicate-pending-id';
        }
        if (state === 'new' && frame.method === 'initialize') {
          if (!isDeepStrictEqual(frame.params, this.backendInitializeRequest)) {
            safeSend(error(id, -32602, 'Frontend initialize request incompatible with worker'));
            attachment.detach(); return 'initialize-incompatible';
          }
          state = 'initializing';
          initializeBarrier = new Promise(resolve => { releaseInitialize = resolve; });
          pending.set(id, { method: frame.method, params: structuredClone(frame.params) });
          try {
            if (!this.sessionPromise) this.sessionPromise = this.backend.initializedSession();
            const session = await this.sessionPromise;
            if (!current()) return 'detached';
            if (!object(session) || !Number.isSafeInteger(session.generation) ||
              !object(session.initializeResult) ||
              (this.requestInbox && (!isDeepStrictEqual(this.requestInbox.owner,
                this.inboxOwner) || this.inboxOwner?.threadId !== this.taskId ||
                this.inboxOwner.generation !== session.generation)) ||
              (this.pinnedSession && (session.generation !== this.pinnedSession.generation ||
                !isDeepStrictEqual(session.initializeResult, this.pinnedSession.initializeResult))) ||
              !this.backend.isSessionCurrent(session.generation)) {
              safeSend(error(id, -32001, 'Worker connection generation changed'));
              attachment.detach(); return 'backend-generation-changed';
            }
            if (!this.pinnedSession) this.pinnedSession = structuredClone(session);
            pending.delete(id); state = 'ready';
            unsubscribe = this.backend.onNotification(notification => {
              if (!current() || state !== 'ready' || !liveBackend() ||
                !object(notification) || typeof notification.method !== 'string' ||
                (!/^(thread|turn|item)\//u.test(notification.method) &&
                  notification.method !== 'serverRequest/resolved') ||
                !object(notification.params) ||
                notification.params.threadId !== this.taskId ||
                (notification.method === 'serverRequest/resolved' &&
                  !idValid(notification.params.requestId))) return;
              safeSend(notification);
            });
            const sent = safeSend({ id, result: this.pinnedSession.initializeResult });
            if (sent && current() && this.requestInbox) {
              try {
                replayingInbox = true;
                inboxLease = this.requestInbox.attach(frame => {
                  if (!safeSend(frame)) throw new Error('Frontend detached');
                });
                replayingInbox = false;
                if (!inboxLease || typeof inboxLease.detach !== 'function' ||
                  typeof inboxLease.answer !== 'function' ||
                  typeof inboxLease.reject !== 'function') throw new TypeError('Invalid inbox lease');
                if (!current() || !liveBackend()) {
                  inboxLease.detach(); inboxLease = null;
                }
                const answers = earlyInboxAnswers;
                earlyInboxAnswers = [];
                for (const answer of answers)
                  void attachment.receive(answer.frame).then(answer.resolve);
              } catch {
                replayingInbox = false;
                for (const answer of earlyInboxAnswers) answer.resolve('server-request-unavailable');
                earlyInboxAnswers = [];
                inboxLease?.detach(); inboxLease = null;
                attachment.detach();
              }
            }
            releaseInitialize?.(sent && current() && (!this.requestInbox || !!inboxLease));
            releaseInitialize = null;
            return 'initialized';
          } catch {
            releaseInitialize?.(false); releaseInitialize = null;
            if (current()) {
              safeSend(error(id, -32001, 'Worker initialize unavailable'));
              attachment.detach();
            }
            return 'backend-initialize-failed';
          } finally { pending.delete(id); }
        }
        if (state === 'initializing') {
          const queuedKind = requestKind(frame.method, frame.params, this.taskId) ||
            (frame.method === 'thread/resume' ? authorizedResume(frame.params,
              this.taskId, this.pinnedSession?.generation, this.resumeAuthority, true) : null) ||
            (this.bootstrapReadMethods.has(frame.method) ?
              bootstrapKind(frame.method, frame.params, this.taskId,
                this.ownCwd, this.trustedLocalFrontend) : null);
          if (!queuedKind) {
            safeSend(error(id, -32601, 'Method unavailable in limited attachment'));
            return 'unsupported';
          }
          if (pending.size >= 33) {
            safeSend(error(id, -32001, 'Frontend initialize pipeline full'));
            return 'initialize-pipeline-full';
          }
          const queued = { method: frame.method, params: structuredClone(frame.params) };
          pending.set(id, queued);
          const ready = await initializeBarrier;
          if (!ready || !current() || pending.get(id) !== queued) return 'detached';
          pending.delete(id);
          return attachment.receive(frame);
        }
        if (state !== 'ready' || !liveBackend()) {
          safeSend(error(id, -32001, 'Worker connection unavailable'));
          return 'not-ready';
        }
        const pinned = this.pinnedSession;
        if (!pinned) return 'not-ready';
        const method = frame.method;
        if (method === 'turn/start' && this.frontendStart) {
          const params = frame.params;
          if (!object(params) || params.threadId !== this.taskId ||
              typeof params.clientUserMessageId !== 'string' ||
              !params.clientUserMessageId || !Array.isArray(params.input) ||
              params.input.length === 0) {
            safeSend(error(id, -32602, 'Native start request incompatible with task'));
            return 'start-invalid';
          }
          if (this.startInFlight || pending.size >= maxReadyRequests) {
            safeSend(error(id, -32001, 'Native start admission busy'));
            return 'start-busy';
          }
          const requestRecord = { method, params: structuredClone(params) };
          pending.set(id, requestRecord);
          this.startInFlight = true;
          try {
            const observed = await this.frontendStart.run({ taskId: this.taskId,
              generation: pinned.generation, params: structuredClone(params) });
            const op = observed?.operation, result = observed?.response;
            const exact = op && op.ownerEpoch === this.frontendStart.ownerEpoch &&
              op.backendGeneration === pinned.generation && op.threadId === this.taskId &&
              op.clientUserMessageId === params.clientUserMessageId && op.method === 'turn/start' &&
              uuid.test(op.operationId) && /^[a-f0-9]{64}$/u.test(op.fingerprint) &&
              Number.isSafeInteger(op.revision) && op.revision >= 1;
            if (exact && op.state === 'accepted' && object(result) &&
                object(result.turn) && typeof result.turn.id === 'string' &&
                result.turn.id === op.receiptId) {
              safeSend({ id, result: structuredClone(result) });
              return 'start-accepted';
            }
            if (exact && op.state === 'rejected' && op.receiptId === null &&
                typeof op.rejectionCode === 'number' &&
                [-32600, -32601, -32602].includes(op.rejectionCode)) {
              safeSend(error(id, op.rejectionCode, 'Native start rejected'));
              return 'start-rejected';
            }
            safeSend(error(id, -32001, 'Native start outcome unknown; do not replay blindly'));
            return 'start-unknown';
          } catch {
            safeSend(error(id, -32001, 'Native start outcome unknown; do not replay blindly'));
            return 'start-unknown';
          } finally {
            this.startInFlight = false;
            pending.delete(id);
          }
        }
        const kind = requestKind(frame.method, frame.params, this.taskId) ||
          (frame.method === 'thread/resume' ? authorizedResume(frame.params,
            this.taskId, pinned.generation, this.resumeAuthority) : null) ||
          (this.bootstrapReadMethods.has(frame.method) ?
            bootstrapKind(frame.method, frame.params, this.taskId,
              this.ownCwd, this.trustedLocalFrontend) : null);
        // A synchronous authority callback can detach this attachment. Do not
        // dispatch its previously authorized frame onto the surviving backend.
        if (!current()) return 'detached';
        if (!kind) {
          safeSend(error(id, -32601, 'Method unavailable in limited attachment'));
          return 'unsupported';
        }
        if (!liveBackend()) {
          safeSend(error(id, -32001, 'Worker connection generation changed'));
          return 'backend-generation-changed';
        }
        if (pending.size >= maxReadyRequests) {
          safeSend(error(id, -32001, 'Frontend request pipeline full'));
          return 'request-pipeline-full';
        }
        const requestRecord = { method: frame.method, params: structuredClone(frame.params) };
        pending.set(id, requestRecord);
        let responseObserved = false;
        const onResponseEnvelope = (envelope: AppServerResponseEnvelope): void => {
          if (responseObserved) return;
          responseObserved = true;
          if (!current() || pending.get(id) !== requestRecord) return;
          if (!liveBackend()) {
            safeSend(error(id, -32001, 'Worker connection generation changed'));
            attachment.detach(); return;
          }
          if (!object(envelope) ||
            (('result' in envelope) === ('error' in envelope)) ||
            Object.keys(envelope).length !== 1 ||
            !object('result' in envelope ? envelope.result : envelope.error)) {
            safeSend(error(id, -32001, 'Worker response envelope unavailable'));
            attachment.detach(); return;
          }
          if ('result' in envelope &&
            (method === 'thread/read' || method === 'thread/resume') &&
            (!object(envelope.result.thread) || envelope.result.thread.id !== this.taskId)) {
            safeSend(error(id, -32001, 'Worker returned a different task'));
            attachment.detach(); return;
          }
          const result = 'result' in envelope ? (kind === 'catalog' ?
            filteredCatalog(method, envelope.result, this.taskId) : envelope.result) : undefined;
          if ('result' in envelope && kind === 'catalog' && !result) {
            safeSend(error(id, -32001, 'Worker catalog response unavailable'));
            attachment.detach(); return;
          }
          if (kind === 'rejoin' && 'result' in envelope && this.frontendStart) {
            try {
              const returned: unknown = this.frontendStart.observeResume({
                taskId: this.taskId, generation: pinned.generation,
                result: structuredClone(envelope.result),
              });
              if (returned !== undefined) {
                if (returned && typeof returned === 'object' && 'then' in returned &&
                    typeof returned.then === 'function') void Promise.resolve(returned).catch(() => {});
                throw new TypeError('Native resume observer must be synchronous');
              }
            } catch {
              safeSend(error(id, -32001, 'Native resume evidence unavailable'));
              attachment.detach(); return;
            }
          }
          safeSend({ id, ...('result' in envelope ?
            { result } : { error: envelope.error }) });
        };
        try {
          await this.backend.request(method,
            structuredClone(frame.params) as JsonObject, { expectedGeneration: pinned.generation,
              ...(kind === 'rejoin' ? { mutating: true } : {}), onResponseEnvelope });
          if (!current() || pending.get(id) !== requestRecord) return 'detached';
          if (responseObserved) return 'forwarded';
          if (!liveBackend()) {
            safeSend(error(id, -32001, 'Worker connection generation changed'));
            attachment.detach(); return 'backend-generation-changed';
          }
          safeSend(error(id, -32001, 'Worker response envelope unavailable'));
          return 'backend-response-envelope-unavailable';
        } catch {
          if (responseObserved) return current() ? 'forwarded' : 'detached';
          if (current()) safeSend(error(id, -32001, 'Worker request unavailable'));
          return 'backend-request-failed';
        } finally { if (pending.get(id) === requestRecord) pending.delete(id); }
      },
    };
    this.active = attachment;
    return attachment;
  }
}
