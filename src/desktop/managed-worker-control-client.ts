import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { SubmitTaskRequest } from '../core/codex-tasks.js';
import { validManagedVkControlRequest, type ManagedWorkerControlStatus,
  type ManagedWorkerVkStatus } from './managed-worker-control.js';

export interface ManagedWorkerControlClientOptions {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly token: string;
  readonly ownerEpoch: string;
  readonly taskId: string;
  readonly timeoutMs?: number;
}

/** EOF and timeout are uncertain for submit: neither can cancel an admitted worker write. */
export class ManagedWorkerControlUnknownError extends Error {
  constructor() { super('Managed VK submission outcome unknown; query exact operation status'); }
}
export class ManagedWorkerControlRefusedError extends Error {
  constructor() { super('Managed VK submission refused'); }
}

export interface ManagedWorkerScopedControlStatus extends ManagedWorkerControlStatus {
  readonly ownerEpoch: string;
  readonly taskId: string;
}

type Method = 'status' | 'submit-vk-v1' | 'vk-submission-status-v1' | 'vk-submission-status-by-id-v1';
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const hostStates = new Set(['new', 'starting', 'running', 'restarting', 'frontend-unavailable',
  'failed', 'lost', 'stopping', 'stopped']);
const nativeStates = new Set(['new', 'bootstrapping', 'connected', 'disconnected', 'failed', 'closed']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** One authenticated call per socket; no reconnect or automatic replay. */
export class ManagedWorkerControlClient {
  readonly #options: Required<ManagedWorkerControlClientOptions>;

  constructor(options: ManagedWorkerControlClientOptions) {
    const timeoutMs = options?.timeoutMs ?? 30_000;
    if (!options || options.host !== '127.0.0.1' || !Number.isSafeInteger(options.port) ||
      options.port < 1 || options.port > 65535 || !/^[A-Za-z0-9_-]{43,128}$/u.test(options.token) ||
      !uuid.test(options.ownerEpoch) || typeof options.taskId !== 'string' ||
      !options.taskId || options.taskId.length > 256 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000)
      throw new TypeError('Invalid managed worker control client scope');
    this.#options = Object.freeze({ ...options, timeoutMs });
  }

  async #call(method: Method, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    const scope = this.#options;
    const id = randomUUID();
    const frame = JSON.stringify({ id, epoch: scope.ownerEpoch,
      ...(method === 'status' ? {} : { taskId: scope.taskId }), method, ...payload }) + '\n';
    if (Buffer.byteLength(frame, 'utf8') > 128 * 1024)
      throw new ManagedWorkerControlRefusedError();
    return new Promise((resolve, reject) => {
      const socket = connect(scope.port, scope.host);
      const decoder = new StringDecoder('utf8');
      let buffer = '', authenticated = false, settled = false;
      const end = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => end(new ManagedWorkerControlUnknownError()), scope.timeoutMs);
      timer.unref();
      socket.on('error', () => end(new ManagedWorkerControlUnknownError()));
      socket.on('close', () => end(new ManagedWorkerControlUnknownError()));
      socket.on('connect', () => socket.write(JSON.stringify({ token: scope.token }) + '\n'));
      socket.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer, 'utf8') > 8192) {
          end(new ManagedWorkerControlUnknownError()); return;
        }
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          let reply: unknown;
          try { reply = JSON.parse(buffer.slice(0, newline)); }
          catch { end(new ManagedWorkerControlUnknownError()); return; }
          buffer = buffer.slice(newline + 1);
          if (!authenticated) {
            if (!object(reply) || Object.keys(reply).length !== 1 || reply.ok !== true) {
              end(new ManagedWorkerControlUnknownError()); return;
            }
            authenticated = true;
            socket.write(frame);
            continue;
          }
          if (!object(reply) || reply.id !== id || Object.keys(reply).some(key =>
            !['id', 'result', 'error'].includes(key)) ||
            Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error')) {
            end(new ManagedWorkerControlUnknownError()); return;
          }
          if (reply.error !== undefined) {
            end(reply.error === 'refused' || reply.error === 'rejected' ?
              new ManagedWorkerControlRefusedError() : new ManagedWorkerControlUnknownError());
          } else end(undefined, reply.result);
          return;
        }
      });
    });
  }

  /** Read-only health for this exact durable binding; never starts or resumes a worker. */
  async status(): Promise<ManagedWorkerScopedControlStatus> {
    const result = await this.#call('status', {});
    if (!object(result) || Object.keys(result).length !== 6 ||
      !['ownerEpoch', 'taskId', 'hostState', 'backendGeneration',
        'nativeState', 'nativeRevision'].every(key => Object.hasOwn(result, key)) ||
      result.ownerEpoch !== this.#options.ownerEpoch || result.taskId !== this.#options.taskId ||
      (typeof result.hostState !== 'string' || !hostStates.has(result.hostState)) ||
      result.backendGeneration !== null && (!Number.isSafeInteger(result.backendGeneration) ||
        (result.backendGeneration as number) < 1) ||
      result.nativeState !== null && (typeof result.nativeState !== 'string' ||
        !nativeStates.has(result.nativeState)) ||
      !Number.isSafeInteger(result.nativeRevision) || (result.nativeRevision as number) < 0)
      throw new ManagedWorkerControlUnknownError();
    return result as unknown as ManagedWorkerScopedControlStatus;
  }

  async submitVk(request: SubmitTaskRequest): Promise<Readonly<{ submissionId: string }>> {
    if (!validManagedVkControlRequest(request, this.#options.taskId))
      throw new ManagedWorkerControlRefusedError();
    const result = await this.#call('submit-vk-v1', { request });
    if (!object(result) || Object.keys(result).length !== 1 ||
      typeof result.submissionId !== 'string' || !result.submissionId ||
      result.submissionId.length > 256) throw new ManagedWorkerControlUnknownError();
    return { submissionId: result.submissionId };
  }

  async vkSubmissionStatus(request: SubmitTaskRequest): Promise<ManagedWorkerVkStatus | null> {
    if (!validManagedVkControlRequest(request, this.#options.taskId))
      throw new ManagedWorkerControlRefusedError();
    return this.#status(await this.#call('vk-submission-status-v1', { request }));
  }

  async vkSubmissionStatusByOperationId(operationId: string): Promise<ManagedWorkerVkStatus | null> {
    if (!uuid.test(operationId)) throw new ManagedWorkerControlRefusedError();
    return this.#status(await this.#call('vk-submission-status-by-id-v1', { operationId }));
  }

  #status(result: unknown): ManagedWorkerVkStatus | null {
    if (result === null) return null;
    if (!object(result) || Object.keys(result).length !== 2 ||
      !Object.hasOwn(result, 'state') || !Object.hasOwn(result, 'submissionId') ||
      !['dispatching', 'unknown', 'accepted', 'rejected'].includes(String(result.state)) ||
      !(result.submissionId === null || typeof result.submissionId === 'string' &&
        result.submissionId.length > 0 && result.submissionId.length <= 256) ||
      (result.state === 'accepted') !== (result.submissionId !== null))
      throw new ManagedWorkerControlUnknownError();
    return result as unknown as ManagedWorkerVkStatus;
  }
}
