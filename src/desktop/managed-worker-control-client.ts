import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { SubmitTaskRequest, QueuedInputHistoryCursor, QueuedInputHistoryScan } from '../core/codex-tasks.js';
import { validManagedVkControlRequest, type ManagedWorkerControlStatus,
  validManagedWorkerHandoffProof, validNativeCliCanaryEvidence,
  validManagedWorkerVkScope, managedWorkerVkScopeKeys,
  validManagedWorkerClaimedVkScope, type ManagedWorkerClaimedVkScope,
  validManagedQueueCursor, validManagedQueueScan,
  type ManagedWorkerHandoffScope,
  type ManagedWorkerControlHandoffProof, type ManagedWorkerVkStatus,
  type ManagedWorkerVkScope, type ManagedWorkerScopedVkIngressStatus,
  type ManagedWorkerScopedVkReceipt, type ManagedWorkerScopedVkStatus } from './managed-worker-control.js';
import type { NativeCliCanaryEvidence } from './managed-worker-daemon.js';

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
export class ManagedWorkerHandoffUnknownError extends Error {
  constructor() { super('Managed worker handoff outcome unknown; do not transition the durable claim'); }
}
export class ManagedWorkerHandoffRefusedError extends Error {
  constructor() { super('Managed worker handoff request refused'); }
}

export interface ManagedWorkerScopedControlStatus extends ManagedWorkerControlStatus {
  readonly ownerEpoch: string;
  readonly taskId: string;
}

type Method = 'status' | 'submit-vk-v1' | 'vk-submission-status-v1' |
  'vk-submission-status-by-id-v1' | 'revoke-ingress-v1' | 'qualify-handoff-v1' |
  'cli-canary-evidence-v1' | 'vk-ingress-status-v2' | 'submit-vk-v2' |
  'vk-submission-status-by-id-v2' | 'vk-terminal-input-scan-v2' | 'vk-ingress-status-claimed-v1' | 'submit-vk-claimed-v1';
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
    const handoff = method === 'revoke-ingress-v1' || method === 'qualify-handoff-v1';
    const unknown = () => handoff ? new ManagedWorkerHandoffUnknownError() :
      new ManagedWorkerControlUnknownError();
    const refused = () => handoff ? new ManagedWorkerHandoffRefusedError() :
      new ManagedWorkerControlRefusedError();
    const id = randomUUID();
    const frame = JSON.stringify({ id, epoch: scope.ownerEpoch,
      ...(method === 'status' ? {} : { taskId: scope.taskId }), method, ...payload }) + '\n';
    if (Buffer.byteLength(frame, 'utf8') > (method === 'vk-terminal-input-scan-v2' ? 2 * 1024 * 1024 : 128 * 1024))
      throw refused();
    return new Promise((resolve, reject) => {
      const socket = connect(scope.port, scope.host);
      const decoder = new StringDecoder('utf8');
      let buffer = '', authenticated = false, settled = false;
      const end = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => end(unknown()), scope.timeoutMs);
      timer.unref();
      socket.on('error', () => end(unknown()));
      socket.on('close', () => end(unknown()));
      socket.on('connect', () => socket.write(JSON.stringify({ token: scope.token }) + '\n'));
      socket.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer, 'utf8') > (method === 'vk-terminal-input-scan-v2' ? 2 * 1024 * 1024 : 8192)) {
          end(unknown()); return;
        }
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          let reply: unknown;
          try { reply = JSON.parse(buffer.slice(0, newline)); }
          catch { end(unknown()); return; }
          buffer = buffer.slice(newline + 1);
          if (!authenticated) {
            if (!object(reply) || Object.keys(reply).length !== 1 || reply.ok !== true) {
              end(unknown()); return;
            }
            authenticated = true;
            socket.write(frame);
            continue;
          }
          if (!object(reply) || reply.id !== id || Object.keys(reply).some(key =>
            !['id', 'result', 'error'].includes(key)) ||
            Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error')) {
            end(unknown()); return;
          }
          if (reply.error !== undefined) {
            end(reply.error === 'refused' || reply.error === 'rejected' ? refused() : unknown());
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

  /** Read-only scalar evidence; never starts or resumes a native task. */
  async nativeCliCanaryEvidence(): Promise<NativeCliCanaryEvidence> {
    const result = await this.#call('cli-canary-evidence-v1', {});
    if (!validNativeCliCanaryEvidence(result, this.#options.ownerEpoch,
      this.#options.taskId)) throw new ManagedWorkerControlUnknownError();
    return result;
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

  /** Explicit v2 only. Capture authority before opening a socket; never refresh,
   * downgrade to v1 or replay on an uncertain outcome. */
  async ingressStatusV2(expected: ManagedWorkerVkScope): Promise<ManagedWorkerScopedVkIngressStatus> {
    const captured = this.#captureVkScope(expected);
    const result = await this.#call('vk-ingress-status-v2', this.#vkScopePayload(captured));
    if (!this.#scopedVkReply(result, captured, ['capability', 'admissionOpen']) ||
      result.capability !== 'stock-idle-queue-v2' || typeof result.admissionOpen !== 'boolean')
      throw new ManagedWorkerControlUnknownError();
    return Object.freeze({ ...captured, capability: 'stock-idle-queue-v2', admissionOpen: result.admissionOpen });
  }

  async submitVkV2(expected: ManagedWorkerVkScope, request: SubmitTaskRequest): Promise<ManagedWorkerScopedVkReceipt> {
    const captured = this.#captureVkScope(expected);
    if (!validManagedVkControlRequest(request, captured.taskId)) throw new ManagedWorkerControlRefusedError();
    const result = await this.#call('submit-vk-v2', { ...this.#vkScopePayload(captured), request });
    if (!this.#scopedVkReply(result, captured, ['submissionId']) ||
      typeof result.submissionId !== 'string' || !result.submissionId || result.submissionId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(result.submissionId)) throw new ManagedWorkerControlUnknownError();
    return Object.freeze({ ...captured, submissionId: result.submissionId });
  }

  async ingressStatusClaimed(expected: ManagedWorkerClaimedVkScope):
    Promise<ManagedWorkerClaimedVkScope & { capability: 'stock-idle-queue-v2'; admissionOpen: boolean }> {
    const captured = this.#captureClaimed(expected);
    const result = await this.#call('vk-ingress-status-claimed-v1', {
      ...this.#vkScopePayload(captured), claimId: captured.claimId, claimRevision: captured.claimRevision });
    if (!this.#claimedReply(result, captured, ['capability', 'admissionOpen']) ||
      result.capability !== 'stock-idle-queue-v2' || typeof result.admissionOpen !== 'boolean')
      throw new ManagedWorkerControlUnknownError();
    return Object.freeze({ ...captured, capability: 'stock-idle-queue-v2', admissionOpen: result.admissionOpen });
  }

  async submitVkClaimed(expected: ManagedWorkerClaimedVkScope, request: SubmitTaskRequest):
    Promise<ManagedWorkerClaimedVkScope & { submissionId: string }> {
    const captured = this.#captureClaimed(expected);
    if (!validManagedVkControlRequest(request, captured.taskId)) throw new ManagedWorkerControlRefusedError();
    const result = await this.#call('submit-vk-claimed-v1', { ...this.#vkScopePayload(captured),
      claimId: captured.claimId, claimRevision: captured.claimRevision, request });
    if (!this.#claimedReply(result, captured, ['submissionId']) || typeof result.submissionId !== 'string' ||
      !result.submissionId || result.submissionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(result.submissionId))
      throw new ManagedWorkerControlUnknownError();
    return Object.freeze({ ...captured, submissionId: result.submissionId });
  }

  #captureClaimed(expected: ManagedWorkerClaimedVkScope): ManagedWorkerClaimedVkScope {
    if (!validManagedWorkerClaimedVkScope(expected) || expected.ownerEpoch !== this.#options.ownerEpoch ||
      expected.taskId !== this.#options.taskId) throw new ManagedWorkerControlRefusedError();
    return Object.freeze({ ...expected });
  }
  #claimedReply(result: unknown, expected: ManagedWorkerClaimedVkScope, keys: readonly string[]):
    result is Record<string, unknown> {
    return this.#scopedVkReply(result, expected, ['claimId', 'claimRevision', ...keys]) &&
      result.claimId === expected.claimId && result.claimRevision === expected.claimRevision;
  }

  async vkSubmissionStatusByOperationIdV2(expected: ManagedWorkerVkScope,
    operationId: string): Promise<ManagedWorkerScopedVkStatus | null> {
    const captured = this.#captureVkScope(expected);
    if (typeof operationId !== 'string' || !uuid.test(operationId)) throw new ManagedWorkerControlRefusedError();
    const result = await this.#call('vk-submission-status-by-id-v2', {
      ...this.#vkScopePayload(captured), operationId });
    if (this.#scopedVkReply(result, captured, ['status']) && result.status === null) return null;
    if (!this.#scopedVkReply(result, captured, ['state', 'submissionId']))
      throw new ManagedWorkerControlUnknownError();
    const status = this.#status({ state: result.state, submissionId: result.submissionId })!;
    if (status.submissionId !== null && /[\u0000-\u001f\u007f]/u.test(status.submissionId))
      throw new ManagedWorkerControlUnknownError();
    return Object.freeze({ ...captured, ...status });
  }

  #captureVkScope(expected: ManagedWorkerVkScope): ManagedWorkerVkScope {
    if (!validManagedWorkerVkScope(expected) || expected.ownerEpoch !== this.#options.ownerEpoch ||
      expected.taskId !== this.#options.taskId) throw new ManagedWorkerControlRefusedError();
    return Object.freeze({ ownerEpoch: expected.ownerEpoch, taskId: expected.taskId,
      backendGeneration: expected.backendGeneration, registryRevision: expected.registryRevision,
      endpointRef: expected.endpointRef });
  }
  async scanTerminalQueuedInputV2(expected: ManagedWorkerVkScope, operationId: string,
    cursor: QueuedInputHistoryCursor | null): Promise<QueuedInputHistoryScan> {
    const captured = this.#captureVkScope(expected);
    if (!uuid.test(operationId) || !validManagedQueueCursor(cursor)) throw new ManagedWorkerControlRefusedError();
    const result = await this.#call('vk-terminal-input-scan-v2', { ...this.#vkScopePayload(captured), operationId, cursor });
    if (!this.#scopedVkReply(result, captured, ['scan']) || !validManagedQueueScan(result.scan))
      throw new ManagedWorkerControlUnknownError();
    return structuredClone(result.scan);
  }

  #vkScopePayload(expected: ManagedWorkerVkScope): Readonly<Record<string, unknown>> {
    return { backendGeneration: expected.backendGeneration, registryRevision: expected.registryRevision,
      endpointRef: expected.endpointRef };
  }

  #scopedVkReply(result: unknown, expected: ManagedWorkerVkScope,
    keys: readonly string[]): result is Record<string, unknown> {
    return object(result) && Object.keys(result).length === managedWorkerVkScopeKeys.length + keys.length &&
      [...managedWorkerVkScopeKeys, ...keys].every(key => Object.hasOwn(result, key)) &&
      managedWorkerVkScopeKeys.every(key => result[key] === expected[key]);
  }

  /** Worker-local monotonic revoke. EOF/timeout is unknown, never success. */
  async revokeIngress(expected: ManagedWorkerHandoffScope): Promise<ManagedWorkerHandoffScope> {
    if (!validHandoffScope(expected)) throw new ManagedWorkerHandoffRefusedError();
    const result = await this.#call('revoke-ingress-v1', {
      backendGeneration: expected.backendGeneration, registryRevision: expected.registryRevision });
    if (!validHandoffScope(result) || result.backendGeneration !== expected.backendGeneration ||
      result.registryRevision !== expected.registryRevision)
      throw new ManagedWorkerHandoffUnknownError();
    return Object.freeze({ backendGeneration: result.backendGeneration,
      registryRevision: result.registryRevision });
  }

  /** A proof for handoff_pending only; caller must fence its durable claim. */
  async qualifyHandoff(expected: ManagedWorkerHandoffScope): Promise<ManagedWorkerControlHandoffProof> {
    if (!validHandoffScope(expected)) throw new ManagedWorkerHandoffRefusedError();
    const result = await this.#call('qualify-handoff-v1', {
      backendGeneration: expected.backendGeneration, registryRevision: expected.registryRevision });
    if (!validManagedWorkerHandoffProof(result, this.#options.ownerEpoch,
      this.#options.taskId, expected)) throw new ManagedWorkerHandoffUnknownError();
    return result;
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
const validHandoffScope = (v: unknown): v is ManagedWorkerHandoffScope => object(v) &&
  Object.keys(v).length === 2 && Object.hasOwn(v, 'backendGeneration') &&
  Object.hasOwn(v, 'registryRevision') && Number.isSafeInteger(v.backendGeneration) &&
  (v.backendGeneration as number) > 0 && Number.isSafeInteger(v.registryRevision) &&
  (v.registryRevision as number) > 0;
