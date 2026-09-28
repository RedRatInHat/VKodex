import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { ActionRejectedError, UncertainActionError, type SubmitTaskRequest } from '../core/codex-tasks.js';
import type { IpcRequestFailureCategory } from './ipc-client.js';

export interface ManagedWorkerControlStatus {
  readonly hostState: string;
  readonly backendGeneration: number | null;
  readonly nativeState: string | null;
  readonly nativeRevision: number;
}
export interface ManagedWorkerControlDiagnosis {
  readonly schemaVersion: 1;
  readonly startupPhase: 'not-started' | 'private-loaded' | 'host-registered' |
    'control-listening' | 'launching' | 'backend-registered' | 'bootstrapping' |
    'owner-starting' | 'publishing-ready' | 'ready';
  readonly daemonState: 'new' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
  readonly failureCode: 'startup-unavailable' | 'backend-lost' | 'backend-loss-unconfirmed' |
    'owner-unconfirmed' | 'native-owner-unavailable' | 'stop-unconfirmed' | null;
  /** Optional v1 extension: fixed categories only; never a native error body. */
  readonly bootstrapFailureCode?: 'effective-resume-policy-mismatch' |
    'thread-read-unqualified' | 'pre-resume-history-not-empty' |
    'resume-settings-unqualified' | 'goal-or-queue-not-empty' |
    'initial-projection-unqualified' | 'actual-thread-settings-drift' |
    'config-defaults-unavailable' | 'config-defaults-unqualified' |
    'initial-history-not-empty' | 'initial-settings-drift' | 'unclassified' | null;
  readonly registryState: 'reserved' | 'host_registered' | 'backend_registered' |
    'ready' | 'lost' | 'retired' | null;
  readonly owner: Readonly<{
    startupStage: 'not-started' | 'observing' | 'reading-initial' | 'validating-initial' |
      'checking-boundary' | 'connecting' | 'ready';
    bootstrapEventCount: number;
    bootstrapNotifications: Readonly<Record<'status' | 'settings' | 'goal' | 'usage' |
      'startup-or-warning' | 'turn' | 'item' | 'other', number>>;
    bootstrapPendingRequests: number;
    bootstrapBoundary: Readonly<{ stateIsBootstrapping: boolean;
      hasEvents: boolean; ownerCurrent: boolean | null }> | null;
    lastRequestFailure?: Readonly<{ category: IpcRequestFailureCategory; count: number; atMs: number }>;
  }> | null;
}
export interface ManagedWorkerControlOptions {
  readonly ownerEpoch: string;
  readonly taskId: string;
  readonly token?: string;
  readonly authTimeoutMs?: number;
  /** Bounds authenticated connections that stop sending frames. Pending stop
   * work continues when its client times out. */
  readonly authenticatedIdleTimeoutMs?: number;
  readonly status: () => ManagedWorkerControlStatus;
  readonly diagnose?: () => ManagedWorkerControlDiagnosis;
  /** Must independently authorize stop and fence current task/family safety.
   * Resolve only after actual shutdown; a failed/unknown attempt is never retried here. */
  readonly requestStop: () => Promise<void>;
  /** Optional worker-local handoff fence; never asserts a durable bridge claim. */
  readonly handoff?: Readonly<{
    revoke: (expected: ManagedWorkerHandoffScope) => ManagedWorkerHandoffScope;
    qualify: (expected: ManagedWorkerHandoffScope) => Promise<ManagedWorkerControlHandoffProof>;
  }>;
  /** Absent by default. Callbacks retain the daemon's private in-process capability. */
  readonly vk?: Readonly<{
    submit: (request: SubmitTaskRequest) => Promise<Readonly<{ submissionId: string }>>;
    status: (request: SubmitTaskRequest) => ManagedWorkerVkStatus | null;
    statusByOperationId: (operationId: string) => ManagedWorkerVkStatus | null;
  }>;
}
export interface ManagedWorkerHandoffScope {
  readonly backendGeneration: number;
  readonly registryRevision: number;
}
export interface ManagedWorkerControlHandoffProof extends ManagedWorkerHandoffScope {
  readonly ownerEpoch: string;
  readonly taskId: string;
  readonly host: Readonly<{ pid: number; birthTicks: string }>;
  readonly backend: Readonly<{ pid: number; birthTicks: string; generation: number }>;
  readonly endpointRef: string;
  readonly nonce: string;
}
export interface ManagedWorkerVkStatus {
  readonly state: 'dispatching' | 'unknown' | 'accepted' | 'rejected';
  readonly submissionId: string | null;
}
export interface ManagedWorkerControlCapability {
  readonly host: '127.0.0.1'; readonly port: number; readonly token: string;
}
/** Caller may throw this only before any stop side effect, after proving a
 * definitive refusal such as busy or revoked authority. It must restore new
 * command admission safely if it had closed that gate. No detail is sent over
 * the control socket. Unknown failures must use an ordinary error instead. */
export class ManagedWorkerStopRefusedError extends Error {
  constructor() { super('Managed worker stop definitively refused'); this.name = 'ManagedWorkerStopRefusedError'; }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const ticks = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]*$/u.test(v);
const handoffScope = (v: unknown): v is ManagedWorkerHandoffScope => object(v) &&
  exact(v, ['backendGeneration', 'registryRevision']) &&
  positive(v.backendGeneration) && positive(v.registryRevision);
export function validManagedWorkerHandoffProof(value: unknown, ownerEpoch: string,
  taskId: string, expected: ManagedWorkerHandoffScope): value is ManagedWorkerControlHandoffProof {
  if (!object(value) || !exact(value, ['ownerEpoch', 'taskId', 'backendGeneration',
    'registryRevision', 'host', 'backend', 'endpointRef', 'nonce']) ||
    value.ownerEpoch !== ownerEpoch || value.taskId !== taskId ||
    value.backendGeneration !== expected.backendGeneration ||
    value.registryRevision !== expected.registryRevision ||
    typeof value.endpointRef !== 'string' || !uuid.test(value.endpointRef) ||
    typeof value.nonce !== 'string' || !uuid.test(value.nonce) ||
    !object(value.host) || !exact(value.host, ['pid', 'birthTicks']) ||
    !positive(value.host.pid) || !ticks(value.host.birthTicks) ||
    !object(value.backend) || !exact(value.backend, ['pid', 'birthTicks', 'generation']) ||
    !positive(value.backend.pid) || !ticks(value.backend.birthTicks) ||
    value.backend.generation !== expected.backendGeneration) return false;
  return true;
}
const pathText = (value: unknown): value is string => text(value, 4096) && path.win32.isAbsolute(value);
/** The socket carries only the serializable, text-only subset of SubmitTaskRequest. */
export function validManagedVkControlRequest(value: unknown, taskId: string): value is SubmitTaskRequest {
  if (!object(value) || Object.keys(value).some(key =>
      !['operationId', 'task', 'text', 'author', 'inputFiles', 'outboxDir'].includes(key)) ||
    typeof value.operationId !== 'string' || !uuid.test(value.operationId) ||
    typeof value.text !== 'string' || !value.text.trim() ||
    value.text.length > 64_000 || Buffer.byteLength(value.text, 'utf8') > 64 * 1024 ||
    !object(value.task)) return false;
  const task = value.task;
  if (Object.keys(task).some(key => !['hostId', 'threadId', 'sourceId', 'rolloutPath'].includes(key)) ||
    task.hostId !== 'local' || task.threadId !== taskId ||
    Object.hasOwn(task, 'sourceId') && (typeof task.sourceId !== 'string' ||
      task.sourceId.length > 256 || /[\u0000-\u001f\u007f]/u.test(task.sourceId)) ||
    Object.hasOwn(task, 'rolloutPath') && !pathText(task.rolloutPath) ||
    Object.hasOwn(value, 'outboxDir') && !pathText(value.outboxDir) ||
    Object.hasOwn(value, 'inputFiles') && (!Array.isArray(value.inputFiles) || value.inputFiles.length !== 0))
    return false;
  if (Object.hasOwn(value, 'author')) {
    if (!object(value.author) || !exact(value.author, ['id', 'name']) ||
      !Number.isSafeInteger(value.author.id) || value.author.id === 0 ||
      !text(value.author.name, 120)) return false;
  }
  return true;
}
const validVkStatus = (value: unknown): value is ManagedWorkerVkStatus | null =>
  value === null || object(value) && exact(value, ['state', 'submissionId']) &&
  ['dispatching', 'unknown', 'accepted', 'rejected'].includes(String(value.state)) &&
  (value.submissionId === null || text(value.submissionId, 256)) &&
  (value.state === 'accepted' ? value.submissionId !== null : value.submissionId === null);
const hostStates = new Set(['new', 'starting', 'running', 'restarting', 'frontend-unavailable',
  'failed', 'lost', 'stopping', 'stopped']);
const nativeStates = new Set(['new', 'bootstrapping', 'connected', 'disconnected', 'failed', 'closed']);
const startupPhases = new Set(['not-started', 'private-loaded', 'host-registered',
  'control-listening', 'launching', 'backend-registered', 'bootstrapping',
  'owner-starting', 'publishing-ready', 'ready']);
const daemonStates = new Set(['new', 'starting', 'ready', 'failed', 'stopping', 'stopped']);
const failureCodes = new Set(['startup-unavailable', 'backend-lost', 'backend-loss-unconfirmed',
  'owner-unconfirmed', 'native-owner-unavailable', 'stop-unconfirmed']);
const bootstrapFailureCodes = new Set(['effective-resume-policy-mismatch',
  'thread-read-unqualified', 'pre-resume-history-not-empty', 'resume-settings-unqualified',
  'goal-or-queue-not-empty', 'initial-projection-unqualified',
  'actual-thread-settings-drift', 'config-defaults-unavailable',
  'config-defaults-unqualified', 'initial-history-not-empty', 'initial-settings-drift',
  'unclassified']);
const registryStates = new Set(['reserved', 'host_registered', 'backend_registered',
  'ready', 'lost', 'retired']);
const startupStages = new Set(['not-started', 'observing', 'reading-initial',
  'validating-initial', 'checking-boundary', 'connecting', 'ready']);
const notificationKeys = ['status', 'settings', 'goal', 'usage', 'startup-or-warning',
  'turn', 'item', 'other'] as const;
const requestFailureCategories = new Set<IpcRequestFailureCategory>([
  'owner-refused', 'queue-gate-refused', 'queue-shape-refused', 'queue-baseline-refused',
  'settings-refused', 'queue-state-refused',
  'entry-refused', 'worker-not-written', 'unclassified',
]);
const boundedCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 255;
function validDiagnosis(value: unknown): value is ManagedWorkerControlDiagnosis {
  if (!object(value) || !(exact(value, ['schemaVersion', 'startupPhase', 'daemonState',
    'failureCode', 'registryState', 'owner']) || exact(value, ['schemaVersion', 'startupPhase',
    'daemonState', 'failureCode', 'bootstrapFailureCode', 'registryState', 'owner'])) ||
    value.schemaVersion !== 1 ||
    typeof value.startupPhase !== 'string' || !startupPhases.has(value.startupPhase) ||
    typeof value.daemonState !== 'string' || !daemonStates.has(value.daemonState) ||
    value.failureCode !== null && (typeof value.failureCode !== 'string' || !failureCodes.has(value.failureCode)) ||
    Object.hasOwn(value, 'bootstrapFailureCode') && value.bootstrapFailureCode !== null &&
      (typeof value.bootstrapFailureCode !== 'string' ||
        !bootstrapFailureCodes.has(value.bootstrapFailureCode)) ||
    value.registryState !== null && (typeof value.registryState !== 'string' || !registryStates.has(value.registryState))) return false;
  const owner = value.owner;
  if (owner === null) return true;
  const ownerKeys = ['startupStage', 'bootstrapEventCount',
    'bootstrapNotifications', 'bootstrapPendingRequests', 'bootstrapBoundary'];
  if (!object(owner) || !(exact(owner, ownerKeys) || exact(owner, [...ownerKeys, 'lastRequestFailure'])) ||
    typeof owner.startupStage !== 'string' || !startupStages.has(owner.startupStage) ||
    !boundedCount(owner.bootstrapEventCount) ||
    !boundedCount(owner.bootstrapPendingRequests) || !object(owner.bootstrapNotifications) ||
    !exact(owner.bootstrapNotifications, notificationKeys) ||
    !notificationKeys.every(key => boundedCount((owner.bootstrapNotifications as Record<string, unknown>)[key])) ||
    Object.hasOwn(owner, 'lastRequestFailure') &&
      (!object(owner.lastRequestFailure) || !exact(owner.lastRequestFailure, ['category', 'count', 'atMs']) ||
        typeof owner.lastRequestFailure.category !== 'string' ||
        !requestFailureCategories.has(owner.lastRequestFailure.category as IpcRequestFailureCategory) ||
        !boundedCount(owner.lastRequestFailure.count) || owner.lastRequestFailure.count === 0 ||
        !Number.isSafeInteger(owner.lastRequestFailure.atMs) ||
        (owner.lastRequestFailure.atMs as number) <= 0))
    return false;
  const boundary = owner.bootstrapBoundary;
  return boundary === null || object(boundary) &&
    exact(boundary, ['stateIsBootstrapping', 'hasEvents', 'ownerCurrent']) &&
    typeof boundary.stateIsBootstrapping === 'boolean' && typeof boundary.hasEvents === 'boolean' &&
    (boundary.ownerCurrent === null || typeof boundary.ownerCurrent === 'boolean');
}

/** Opt-in daemon control, not an App Server proxy. Tokens stay in private owner
 * state. Client EOF and listener close never stop the execution worker. */
export class ManagedWorkerControlServer {
  readonly #options: ManagedWorkerControlOptions;
  readonly #token: Buffer;
  readonly #idleTimeout: number;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #listen: Promise<ManagedWorkerControlCapability> | null = null;
  #close: Promise<void> | null = null;
  #closed = false;
  #stop: Promise<void> | null = null;

  constructor(options: ManagedWorkerControlOptions) {
    const token = options?.token ?? randomBytes(32).toString('base64url');
    const timeout = options?.authTimeoutMs ?? 5000;
    const idleTimeout = options?.authenticatedIdleTimeoutMs ?? 30_000;
    if (!options || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(options.ownerEpoch) ||
        !text(options.taskId, 256) || typeof options.status !== 'function' ||
        options.diagnose !== undefined && typeof options.diagnose !== 'function' ||
        options.vk !== undefined && (!options.vk || typeof options.vk.submit !== 'function' ||
          typeof options.vk.status !== 'function' || typeof options.vk.statusByOperationId !== 'function') ||
        options.handoff !== undefined && (!options.handoff ||
          typeof options.handoff.revoke !== 'function' ||
          typeof options.handoff.qualify !== 'function') ||
        typeof options.requestStop !== 'function' || !/^[A-Za-z0-9_-]{43,128}$/u.test(token) ||
        !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 60_000 ||
        !Number.isSafeInteger(idleTimeout) || idleTimeout < 10 || idleTimeout > 60_000)
      throw new TypeError('Invalid managed worker control configuration');
    this.#options = Object.freeze({ ...options, authTimeoutMs: timeout,
      authenticatedIdleTimeoutMs: idleTimeout,
      ...(options.vk ? { vk: Object.freeze({ ...options.vk }) } : {}),
      ...(options.handoff ? { handoff: Object.freeze({ ...options.handoff }) } : {}) });
    this.#token = Buffer.from(token);
    this.#idleTimeout = idleTimeout;
    this.#server = createServer(socket => this.#accept(socket));
    this.#server.on('error', () => {}); // Bind errors are reported by listen; never kill the worker.
  }

  listen(): Promise<ManagedWorkerControlCapability> {
    if (this.#closed) return Promise.reject(new Error('Worker control closed'));
    if (this.#listen) return this.#listen;
    this.#listen = new Promise((resolve, reject) => {
      const failed = () => { this.#server.off('listening', ready); reject(new Error('Worker control listener unavailable')); };
      const ready = () => {
        this.#server.off('error', failed);
        const address = this.#server.address();
        if (this.#closed || !address || typeof address === 'string') { failed(); return; }
        resolve(Object.freeze({ host: '127.0.0.1', port: address.port, token: this.#token.toString() }));
      };
      this.#server.once('error', failed); this.#server.once('listening', ready);
      this.#server.listen(0, '127.0.0.1');
    });
    return this.#listen;
  }

  #accept(socket: Socket): void {
    if (this.#closed || this.#sockets.size >= 16) { socket.destroy(); return; }
    this.#sockets.add(socket);
    const decoder = new StringDecoder('utf8'); let buffer = '', authenticated = false, outstanding = 0;
    const ids = new Set<string>();
    const timer = setTimeout(() => socket.destroy(), this.#options.authTimeoutMs);
    timer.unref();
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); this.#sockets.delete(socket); });
    const send = (frame: object) => {
      if (socket.destroyed) return;
      if (socket.writableLength > 64 * 1024) { socket.destroy(); return; }
      try { socket.write(JSON.stringify(frame) + '\n'); } catch { socket.destroy(); }
    };
    socket.on('data', (chunk: Buffer) => {
      if (this.#closed) { socket.destroy(); return; }
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > (authenticated ? 128 * 1024 : 8192)) { socket.destroy(); return; }
      while (!socket.destroyed && buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); let frame: unknown;
        try { frame = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
        buffer = buffer.slice(end + 1);
        if (!object(frame)) { socket.destroy(); return; }
        if (!authenticated) {
          const presented = typeof frame.token === 'string' ? Buffer.from(frame.token) : Buffer.alloc(0);
          if (!exact(frame, ['token']) || presented.length !== this.#token.length ||
              !timingSafeEqual(presented, this.#token)) { socket.destroy(); return; }
          authenticated = true; clearTimeout(timer);
          socket.setTimeout(this.#idleTimeout, () => socket.destroy());
          send({ ok: true }); continue;
        }
        if (!text(frame.id, 128)) { socket.destroy(); return; }
        const id = frame.id;
        const vkMethod = frame.method === 'submit-vk-v1' || frame.method === 'vk-submission-status-v1' ||
          frame.method === 'vk-submission-status-by-id-v1';
        const handoffMethod = frame.method === 'revoke-ingress-v1' || frame.method === 'qualify-handoff-v1';
        if (!(handoffMethod ? exact(frame, ['id', 'epoch', 'taskId', 'method',
          'backendGeneration', 'registryRevision']) : vkMethod ? exact(frame, ['id', 'epoch', 'taskId', 'method',
          frame.method === 'vk-submission-status-by-id-v1' ? 'operationId' : 'request']) :
          exact(frame, ['id', 'epoch', 'method'])) || frame.epoch !== this.#options.ownerEpoch ||
            vkMethod && (frame.taskId !== this.#options.taskId || !this.#options.vk) ||
            handoffMethod && (frame.taskId !== this.#options.taskId || !this.#options.handoff ||
              !positive(frame.backendGeneration) || !positive(frame.registryRevision)) ||
            !['status', 'diagnose-v1', 'stop', 'submit-vk-v1', 'vk-submission-status-v1',
              'vk-submission-status-by-id-v1', 'revoke-ingress-v1',
              'qualify-handoff-v1'].includes(String(frame.method)) ||
            ids.has(id) || ids.size >= 1024 || outstanding >= 16) {
          send({ id, error: 'refused' }); continue;
        }
        ids.add(id);
        if (handoffMethod) {
          const expected = Object.freeze({ backendGeneration: frame.backendGeneration as number,
            registryRevision: frame.registryRevision as number });
          if (!handoffScope(expected)) { send({ id, error: 'refused' }); continue; }
          if (frame.method === 'revoke-ingress-v1') {
            try {
              const result = this.#options.handoff!.revoke(expected);
              if (!handoffScope(result) || result.backendGeneration !== expected.backendGeneration ||
                result.registryRevision !== expected.registryRevision) throw new Error();
              send({ id, result });
            } catch { send({ id, error: 'handoff-unknown' }); }
          } else {
            outstanding++;
            void Promise.resolve().then(() => this.#options.handoff!.qualify(expected)).then(result => {
              if (!validManagedWorkerHandoffProof(result, this.#options.ownerEpoch,
                this.#options.taskId, expected)) throw new Error();
              send({ id, result });
            }, () => send({ id, error: 'handoff-unknown' }))
              .catch(() => send({ id, error: 'handoff-unknown' }))
              .finally(() => { outstanding--; });
          }
          continue;
        }
        if (vkMethod) {
          if (!this.#options.vk || (frame.method === 'vk-submission-status-by-id-v1' ?
            typeof frame.operationId !== 'string' || !uuid.test(frame.operationId) :
            !validManagedVkControlRequest(frame.request, this.#options.taskId))) {
            send({ id, error: 'refused' }); continue;
          }
          if (frame.method === 'submit-vk-v1') {
            outstanding++;
            const request = frame.request as SubmitTaskRequest;
            void Promise.resolve().then(() => this.#options.vk!.submit(request)).then(result => {
              if (!object(result) || !exact(result, ['submissionId']) || !text(result.submissionId, 256))
                throw new Error('Malformed VK submission receipt');
              send({ id, result: { submissionId: result.submissionId } });
            }, error => { send({ id, error: error instanceof ActionRejectedError ? 'rejected' :
              error instanceof UncertainActionError ? 'unknown' : 'unknown' }); })
              .catch(() => send({ id, error: 'unknown' })).finally(() => { outstanding--; });
          } else {
            try {
              const status = frame.method === 'vk-submission-status-v1' ?
                this.#options.vk.status(frame.request as SubmitTaskRequest) :
                this.#options.vk.statusByOperationId(frame.operationId as string);
              if (!validVkStatus(status)) throw new Error();
              send({ id, result: status });
            } catch { send({ id, error: 'status-unavailable' }); }
          }
          continue;
        }
        if (frame.method === 'status') {
          try {
            const status = this.#options.status();
            if (!object(status) || !exact(status, ['hostState', 'backendGeneration', 'nativeState', 'nativeRevision']) ||
                !hostStates.has(status.hostState) || status.backendGeneration !== null &&
                  (!Number.isSafeInteger(status.backendGeneration) || status.backendGeneration < 1) ||
                status.nativeState !== null && !nativeStates.has(status.nativeState) ||
                !Number.isSafeInteger(status.nativeRevision) || status.nativeRevision < 0) throw new Error();
            send({ id, result: { ownerEpoch: this.#options.ownerEpoch, taskId: this.#options.taskId, ...status } });
          } catch { send({ id, error: 'status-unavailable' }); }
          continue;
        }
        if (frame.method === 'diagnose-v1') {
          try {
            const diagnosis = this.#options.diagnose?.();
            if (!validDiagnosis(diagnosis)) throw new Error();
            send({ id, result: { ownerEpoch: this.#options.ownerEpoch,
              taskId: this.#options.taskId, ...diagnosis } });
          } catch { send({ id, error: 'diagnosis-unavailable' }); }
          continue;
        }
        // Install the single-flight promise before invoking caller code. Only
        // a typed pre-side-effect refusal permits a later explicit attempt.
        let attempt = this.#stop;
        if (!attempt) {
          attempt = Promise.resolve().then(() => this.#options.requestStop());
          this.#stop = attempt;
          const currentAttempt = attempt;
          void attempt.then(() => {}, error => {
            if (error instanceof ManagedWorkerStopRefusedError && this.#stop === currentAttempt)
              this.#stop = null;
          });
        }
        outstanding++;
        void attempt.then(() => send({ id, result: { stopped: true } }),
          error => send({ id, error: error instanceof ManagedWorkerStopRefusedError
            ? 'stop-refused' : 'stop-unconfirmed' })).finally(() => { outstanding--; });
      }
    });
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true;
    this.#close = (async () => {
      await this.#listen?.catch(() => {});
      for (const socket of this.#sockets) socket.destroy();
      if (this.#server.listening) await new Promise<void>((resolve, reject) => {
        this.#server.close(error => error ? reject(new Error('Worker control close failed')) : resolve());
      });
      this.#token.fill(0);
    })();
    return this.#close;
  }
}
