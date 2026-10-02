import type { CodexQuestions } from '../core/codex-questions.js';
import { ActionRejectedError, type QueuedSubmissionOutcome, type SubmitTaskReceipt,
  type SubmitTaskRequest, type TaskDetails, type TaskGoal, type TaskGoalUpdate,
  type TaskRef, type TaskRenameResult } from '../core/codex-tasks.js';
import type { QueuedInputHistoryCursor, QueuedInputHistoryScan } from '../core/codex-tasks.js';
import type { CodexTaskOwner } from '../core/codex-task-router.js';
import type { TaskStateOwnerRoute, TaskStateStream, TaskStateTransport } from '../core/task-state.js';
import type { BridgeStore } from './store.js';
import { ManagedOwnerObservedTaskStateTransport,
  type ManagedOwnerRouteObserver } from './managed-owner-observed-task-state-transport.js';

const refuse = (): never => {
  throw new ActionRejectedError('Управляемый маршрут задачи пока недоступен.');
};
/** An optional narrow same-worker delegate, never a second exclusive owner. */
export interface ManagedOwnerIngress {
  isReady(task: TaskRef): boolean;
  ensureOpen(task: TaskRef): Promise<void>;
  submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt>;
  ownsOperation(task: TaskRef, operationId: string): boolean;
  findQueuedSubmissionOutcome(task: TaskRef, operationId: string): Promise<QueuedSubmissionOutcome | null>;
  scanTerminalQueuedInput(task: TaskRef, operationId: string, cursor: QueuedInputHistoryCursor | null): Promise<QueuedInputHistoryScan>;
}

/** A durable route claim, not an ingress or physical writer grant. It is safe
 * to register before a worker exists: every operation remains unavailable. */
export class ManagedOwnerExclusiveRouteGuard implements CodexTaskOwner, TaskStateOwnerRoute {
  readonly routingPolicy = 'exclusive' as const;
  readonly states: TaskStateTransport;

  constructor(private readonly store: Pick<BridgeStore, 'managedOwner'>,
    observer?: ManagedOwnerRouteObserver, private readonly ingress?: ManagedOwnerIngress) {
    const observations = new Set<ManagedOwnerObservedTaskStateTransport>();
    this.states = Object.freeze({
      readOnly: true as const,
      subscribe: (task: TaskRef, onState: Parameters<TaskStateTransport['subscribe']>[1],
        onError: Parameters<TaskStateTransport['subscribe']>[2]): TaskStateStream => {
        if (!observer || !this.owns(task)) return { task: { ...task }, readOnly: true as const,
          start: async () => refuse(), verifyOwner: async () => refuse(), close: () => {} };
        const transport = new ManagedOwnerObservedTaskStateTransport(observer, task);
        observations.add(transport);
        let stream: TaskStateStream | null = null;
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          stream?.close(); transport.close(); observations.delete(transport);
        };
        try { stream = transport.subscribe(task, onState, error => { close(); onError(error); }); }
        catch (error) { close(); throw error; }
        if (closed) stream.close();
        const active = stream;
        return { task: active.task, readOnly: true as const,
          start: async timeoutMs => { try { await active.start(timeoutMs); } catch (error) { close(); throw error; } },
          verifyOwner: async timeoutMs => {
            try { await active.verifyOwner(timeoutMs); } catch (error) { close(); throw error; }
          },
          diagnostic: () => active.diagnostic?.() ?? { kind: 'unknown' }, close };
      },
      close: () => { for (const transport of observations) transport.close(); observations.clear(); },
    });
  }

  /** BridgeStore excludes retired rows and matches host/thread/source exactly. */
  owns(task: TaskRef): boolean { return this.store.managedOwner(task) !== null; }
  isReady(task: TaskRef): boolean { return this.owns(task) && this.ingress?.isReady(task) === true; }
  ownsOperation(task: TaskRef, operationId: string): boolean { return this.ingress?.ownsOperation(task, operationId) === true; }
  async ensureOpen(task: TaskRef): Promise<void> {
    const ingress = this.ingress;
    if (!this.owns(task) || !ingress) return refuse();
    return ingress.ensureOpen(task);
  }
  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    if (!this.owns(request.task) || !this.ingress) return refuse();
    return this.ingress.submitWithReceipt(request);
  }
  async interrupt(_task: TaskRef): Promise<void> { refuse(); }
  async queue(request: SubmitTaskRequest): Promise<string> {
    const receipt = await this.submitWithReceipt(request);
    return receipt.mode === 'queue' ? receipt.submissionId : refuse();
  }
  async selectModel(_task: TaskRef, _model: string, _effort: string): Promise<void> { refuse(); }
  async renameTask(_task: TaskRef, _title: string): Promise<TaskRenameResult> { return refuse(); }
  async moveTask(_task: TaskRef, _projectId: string | null): Promise<void> { refuse(); }
  async getGoal(_task: TaskRef): Promise<TaskGoal | null> { return refuse(); }
  async setGoal(_task: TaskRef, _update: TaskGoalUpdate): Promise<TaskGoal> { return refuse(); }
  async clearGoal(_task: TaskRef): Promise<boolean> { return refuse(); }
  async pendingQuestions(_task: TaskRef): Promise<readonly CodexQuestions[]> { return refuse(); }
  async answerQuestions(_task: TaskRef, _question: CodexQuestions,
    _answers: Readonly<Record<string, string>>, _operationId: string,
    _beforeSend: () => Promise<void>): Promise<void> { refuse(); }
  async findAcceptedInput(task: TaskRef, operationId: string): Promise<string | null> {
    return this.ownsOperation(task, operationId) ? null : refuse();
  }
  async findQueuedSubmission(task: TaskRef, operationId: string): Promise<string | null> {
    const result = await this.findQueuedSubmissionOutcome(task, operationId);
    return result?.state === 'accepted' ? result.submissionId : null;
  }
  async findQueuedSubmissionOutcome(task: TaskRef, operationId: string): Promise<QueuedSubmissionOutcome | null> {
    if (!this.ownsOperation(task, operationId) || !this.ingress) return refuse();
    return this.ingress.findQueuedSubmissionOutcome(task, operationId);
  }
  async scanTerminalQueuedInput(task: TaskRef, operationId: string, cursor: QueuedInputHistoryCursor | null): Promise<QueuedInputHistoryScan> {
    if (!this.ownsOperation(task, operationId) || !this.ingress) return refuse();
    return this.ingress.scanTerminalQueuedInput(task, operationId, cursor);
  }
  async inspectTask(_task: TaskRef): Promise<TaskDetails> { return refuse(); }
  async archiveTask(_task: TaskRef): Promise<void> { refuse(); }
  async archiveRetryReady(_task: TaskRef): Promise<boolean> { return refuse(); }
}
