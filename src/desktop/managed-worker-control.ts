import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

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
const hostStates = new Set(['new', 'starting', 'running', 'restarting', 'frontend-unavailable',
  'failed', 'lost', 'stopping', 'stopped']);
const nativeStates = new Set(['new', 'bootstrapping', 'connected', 'disconnected', 'failed', 'closed']);
const startupPhases = new Set(['not-started', 'private-loaded', 'host-registered',
  'control-listening', 'launching', 'backend-registered', 'bootstrapping',
  'owner-starting', 'publishing-ready', 'ready']);
const daemonStates = new Set(['new', 'starting', 'ready', 'failed', 'stopping', 'stopped']);
const failureCodes = new Set(['startup-unavailable', 'backend-lost', 'backend-loss-unconfirmed',
  'owner-unconfirmed', 'native-owner-unavailable', 'stop-unconfirmed']);
const registryStates = new Set(['reserved', 'host_registered', 'backend_registered',
  'ready', 'lost', 'retired']);
const startupStages = new Set(['not-started', 'observing', 'reading-initial',
  'validating-initial', 'checking-boundary', 'connecting', 'ready']);
const notificationKeys = ['status', 'settings', 'goal', 'usage', 'startup-or-warning',
  'turn', 'item', 'other'] as const;
const boundedCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 255;
function validDiagnosis(value: unknown): value is ManagedWorkerControlDiagnosis {
  if (!object(value) || !exact(value, ['schemaVersion', 'startupPhase', 'daemonState',
    'failureCode', 'registryState', 'owner']) || value.schemaVersion !== 1 ||
    typeof value.startupPhase !== 'string' || !startupPhases.has(value.startupPhase) ||
    typeof value.daemonState !== 'string' || !daemonStates.has(value.daemonState) ||
    value.failureCode !== null && (typeof value.failureCode !== 'string' || !failureCodes.has(value.failureCode)) ||
    value.registryState !== null && (typeof value.registryState !== 'string' || !registryStates.has(value.registryState))) return false;
  const owner = value.owner;
  if (owner === null) return true;
  if (!object(owner) || !exact(owner, ['startupStage', 'bootstrapEventCount',
    'bootstrapNotifications', 'bootstrapPendingRequests', 'bootstrapBoundary']) ||
    typeof owner.startupStage !== 'string' || !startupStages.has(owner.startupStage) ||
    !boundedCount(owner.bootstrapEventCount) ||
    !boundedCount(owner.bootstrapPendingRequests) || !object(owner.bootstrapNotifications) ||
    !exact(owner.bootstrapNotifications, notificationKeys) ||
    !notificationKeys.every(key => boundedCount((owner.bootstrapNotifications as Record<string, unknown>)[key])))
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
        typeof options.requestStop !== 'function' || !/^[A-Za-z0-9_-]{43,128}$/u.test(token) ||
        !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 60_000 ||
        !Number.isSafeInteger(idleTimeout) || idleTimeout < 10 || idleTimeout > 60_000)
      throw new TypeError('Invalid managed worker control configuration');
    this.#options = Object.freeze({ ...options, authTimeoutMs: timeout,
      authenticatedIdleTimeoutMs: idleTimeout });
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
      if (Buffer.byteLength(buffer) > 8192) { socket.destroy(); return; }
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
        if (!exact(frame, ['id', 'epoch', 'method']) || frame.epoch !== this.#options.ownerEpoch ||
            !['status', 'diagnose-v1', 'stop'].includes(String(frame.method)) || ids.has(id) || ids.size >= 1024 || outstanding >= 16) {
          send({ id, error: 'refused' }); continue;
        }
        ids.add(id);
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
