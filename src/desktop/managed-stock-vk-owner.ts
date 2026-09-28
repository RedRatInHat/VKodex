import { ActionRejectedError, UncertainActionError, type SubmitTaskReceipt,
  type SubmitTaskRequest, type TaskRef } from '../core/codex-tasks.js';
import type { CodexTaskOwner } from '../core/codex-task-router.js';
import { validManagedVkControlRequest, type ManagedWorkerVkStatus } from './managed-worker-control.js';
import { ManagedWorkerControlRefusedError, ManagedWorkerControlUnknownError,
  type ManagedWorkerControlClient } from './managed-worker-control-client.js';

type Client = Pick<ManagedWorkerControlClient, 'submitVk' | 'vkSubmissionStatusByOperationId'>;

/** Read-only durable journal outcome. Null means no scoped operation row. */
export type ManagedQueuedSubmissionOutcome =
  | Readonly<{ state: 'accepted'; submissionId: string }>
  | Readonly<{ state: 'rejected' | 'unknown' }>;

export interface ManagedStockVkOwnerOptions {
  /** Caller-established durable claim; endpoint availability never changes owns(). */
  readonly binding: Readonly<{ hostId: 'local'; threadId: string; sourceId: string; ownerEpoch: string }>;
  /** An actual scoped control client, or an injected client with the same narrow contract. */
  readonly client: Client;
  /** These are fail-closed admission checks, not a server-side writer grant. */
  readonly isReady: () => boolean;
  /** Must compare the exact durable claim revision, not merely its task ID. */
  readonly isCurrent: () => boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const rejected = (): never => { throw new ActionRejectedError('Managed stock route unavailable'); };
const unsupported = (): never => { throw new ActionRejectedError('Managed stock route does not support this action'); };

/** One exact exclusive binding. This adapter never creates/resumes a worker,
 * checks another owner, or turns a queue submission ID into a turn ID. */
export class ManagedStockVkOwner implements CodexTaskOwner {
  readonly routingPolicy = 'exclusive' as const;
  readonly #binding: Readonly<ManagedStockVkOwnerOptions['binding']>;
  readonly #submit: Client['submitVk'];
  readonly #status: Client['vkSubmissionStatusByOperationId'];
  readonly #ready: () => boolean;
  readonly #current: () => boolean;

  constructor(options: ManagedStockVkOwnerOptions) {
    const binding = options?.binding;
    if (!binding || binding.hostId !== 'local' || typeof binding.threadId !== 'string' ||
      !binding.threadId || binding.threadId.length > 256 ||
      typeof binding.sourceId !== 'string' || binding.sourceId.length > 256 ||
      !uuid.test(binding.ownerEpoch) ||
      Reflect.ownKeys(binding).some(key => typeof key !== 'string' ||
        !['hostId', 'threadId', 'sourceId', 'ownerEpoch'].includes(key)) ||
      !options.client || typeof options.client.submitVk !== 'function' ||
      typeof options.client.vkSubmissionStatusByOperationId !== 'function' ||
      typeof options.isReady !== 'function' || typeof options.isCurrent !== 'function')
      throw new TypeError('Exact managed stock owner binding required');
    this.#binding = Object.freeze({ hostId: 'local', threadId: binding.threadId,
      sourceId: binding.sourceId, ownerEpoch: binding.ownerEpoch });
    this.#submit = options.client.submitVk.bind(options.client);
    this.#status = options.client.vkSubmissionStatusByOperationId.bind(options.client);
    this.#ready = options.isReady;
    this.#current = options.isCurrent;
  }

  owns(task: TaskRef): boolean {
    return !!task && task.hostId === this.#binding.hostId &&
      task.threadId === this.#binding.threadId &&
      (task.sourceId ?? '') === this.#binding.sourceId;
  }

  isReady(task: TaskRef): boolean {
    if (!this.owns(task)) return false;
    try { return this.#ready() === true && this.#current() === true; } catch { return false; }
  }

  async ensureOpen(task: TaskRef): Promise<void> {
    this.#assertOwn(task);
    if (!this.isReady(task)) rejected();
  }

  #assertOwn(task: TaskRef): void { if (!this.owns(task)) rejected(); }

  #serializable(request: SubmitTaskRequest): Readonly<{
    request: SubmitTaskRequest; beforeSend: SubmitTaskRequest['beforeSend'];
  }> {
    this.#assertOwn(request?.task);
    if (Reflect.ownKeys(request).some(key => typeof key !== 'string' ||
      !['operationId', 'task', 'text', 'author', 'inputFiles', 'outboxDir', 'beforeSend'].includes(key)) ||
      request.beforeSend !== undefined && typeof request.beforeSend !== 'function') rejected();
    const beforeSend = request.beforeSend;
    let copy: SubmitTaskRequest | undefined;
    try {
      copy = structuredClone({ operationId: request.operationId,
        task: { hostId: request.task.hostId, threadId: request.task.threadId,
          ...(request.task.sourceId !== undefined ? { sourceId: request.task.sourceId } : {}),
          ...(request.task.rolloutPath !== undefined ? { rolloutPath: request.task.rolloutPath } : {}) },
        text: request.text,
        ...(request.author !== undefined ? { author: request.author } : {}),
        ...(request.inputFiles !== undefined ? { inputFiles: request.inputFiles } : {}),
        ...(request.outboxDir !== undefined ? { outboxDir: request.outboxDir } : {}) });
    } catch { rejected(); }
    if (!copy) return rejected();
    if (!validManagedVkControlRequest(copy, this.#binding.threadId) ||
      (copy.task.sourceId ?? '') !== this.#binding.sourceId) return rejected();
    return { request: copy, beforeSend };
  }

  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    const payload = this.#serializable(request);
    if (!this.isReady(request.task)) rejected();
    // This callback is bridge-local. It is never sent over the control socket.
    try { await payload.beforeSend?.(); } catch { rejected(); }
    // A callback may await durable inbox work while the claim enters handoff.
    // This narrows the race; the worker's ingress revocation remains mandatory.
    if (!this.isReady(request.task)) rejected();
    try {
      const receipt = await this.#submit(payload.request);
      if (!receipt || typeof receipt.submissionId !== 'string' || !receipt.submissionId)
        throw new ManagedWorkerControlUnknownError();
      return { mode: 'queue', submissionId: receipt.submissionId };
    } catch (error) {
      if (error instanceof ManagedWorkerControlRefusedError) rejected();
      throw new UncertainActionError();
    }
  }

  async queue(request: SubmitTaskRequest): Promise<string> {
    const receipt = await this.submitWithReceipt(request);
    if (receipt.mode !== 'queue') throw new UncertainActionError();
    return receipt.submissionId;
  }

  async findQueuedSubmissionOutcome(task: TaskRef, operationId: string): Promise<ManagedQueuedSubmissionOutcome | null> {
    this.#assertOwn(task);
    if (!uuid.test(operationId)) rejected();
    let status: ManagedWorkerVkStatus | null;
    try { status = await this.#status(operationId); }
    catch (error) {
      if (error instanceof ManagedWorkerControlRefusedError) rejected();
      throw new UncertainActionError();
    }
    if (status === null) return null;
    if (status.state === 'rejected') return { state: 'rejected' };
    if (status.state === 'accepted' && typeof status.submissionId === 'string' && status.submissionId)
      return { state: 'accepted', submissionId: status.submissionId };
    if (status.state === 'dispatching' || status.state === 'unknown') return { state: 'unknown' };
    throw new UncertainActionError();
  }

  async findQueuedSubmission(task: TaskRef, operationId: string): Promise<string | null> {
    const outcome = await this.findQueuedSubmissionOutcome(task, operationId);
    if (outcome?.state === 'accepted') return outcome.submissionId;
    if (outcome?.state === 'unknown') throw new UncertainActionError();
    return null;
  }

  async findAcceptedInput(task: TaskRef, _operationId: string): Promise<null> { this.#assertOwn(task); return null; }
  async interrupt(_task: TaskRef): Promise<void> { return unsupported(); }
  async selectModel(_task: TaskRef, _model: string, _effort: string): Promise<void> { return unsupported(); }
  async renameTask(_task: TaskRef, _title: string): Promise<never> { return unsupported(); }
  async moveTask(_task: TaskRef, _projectId: string | null): Promise<void> { return unsupported(); }
  async getGoal(_task: TaskRef): Promise<never> { return unsupported(); }
  async setGoal(..._args: Parameters<CodexTaskOwner['setGoal']>): Promise<never> { return unsupported(); }
  async clearGoal(_task: TaskRef): Promise<never> { return unsupported(); }
  async pendingQuestions(_task: TaskRef): Promise<never> { return unsupported(); }
  async answerQuestions(..._args: Parameters<CodexTaskOwner['answerQuestions']>): Promise<void> { return unsupported(); }
  async inspectTask(_task: TaskRef): Promise<never> { return unsupported(); }
  async archiveTask(_task: TaskRef): Promise<void> { return unsupported(); }
  async archiveRetryReady(_task: TaskRef): Promise<never> { return unsupported(); }
}
