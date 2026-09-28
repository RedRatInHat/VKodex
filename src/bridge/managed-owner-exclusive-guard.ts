import type { CodexQuestions } from '../core/codex-questions.js';
import { ActionRejectedError, type QueuedSubmissionOutcome, type SubmitTaskReceipt,
  type SubmitTaskRequest, type TaskDetails, type TaskGoal, type TaskGoalUpdate,
  type TaskRef, type TaskRenameResult } from '../core/codex-tasks.js';
import type { CodexTaskOwner } from '../core/codex-task-router.js';
import type { TaskStateOwnerRoute, TaskStateStream, TaskStateTransport } from '../core/task-state.js';
import type { BridgeStore } from './store.js';
import { ManagedOwnerObservedTaskStateTransport,
  type ManagedOwnerRouteObserver } from './managed-owner-observed-task-state-transport.js';

const refuse = (): never => {
  throw new ActionRejectedError('Управляемый маршрут задачи пока недоступен.');
};

/** A durable route claim, not an ingress or physical writer grant. It is safe
 * to register before a worker exists: every operation remains unavailable. */
export class ManagedOwnerExclusiveRouteGuard implements CodexTaskOwner, TaskStateOwnerRoute {
  readonly routingPolicy = 'exclusive' as const;
  readonly states: TaskStateTransport;

  constructor(private readonly store: Pick<BridgeStore, 'managedOwner'>,
    observer?: ManagedOwnerRouteObserver) {
    const observations = new Set<ManagedOwnerObservedTaskStateTransport>();
    this.states = Object.freeze({
      subscribe: (task: TaskRef, onState: Parameters<TaskStateTransport['subscribe']>[1],
        onError: Parameters<TaskStateTransport['subscribe']>[2]): TaskStateStream => {
        if (!observer || !this.owns(task)) return { task: { ...task },
          start: async () => refuse(), verifyOwner: async () => refuse(), close: () => {} };
        const transport = new ManagedOwnerObservedTaskStateTransport(observer, task);
        observations.add(transport);
        const stream = transport.subscribe(task, onState, onError);
        return { task: stream.task, start: timeoutMs => stream.start(timeoutMs),
          verifyOwner: timeoutMs => stream.verifyOwner(timeoutMs),
          diagnostic: () => stream.diagnostic?.() ?? { kind: 'unknown' },
          close: () => { stream.close(); transport.close(); observations.delete(transport); } };
      },
      close: () => { for (const transport of observations) transport.close(); observations.clear(); },
    });
  }

  /** BridgeStore excludes retired rows and matches host/thread/source exactly. */
  owns(task: TaskRef): boolean { return this.store.managedOwner(task) !== null; }
  isReady(_task: TaskRef): boolean { return false; }
  async ensureOpen(_task: TaskRef): Promise<void> { refuse(); }
  async submitWithReceipt(_request: SubmitTaskRequest): Promise<SubmitTaskReceipt> { return refuse(); }
  async interrupt(_task: TaskRef): Promise<void> { refuse(); }
  async queue(_request: SubmitTaskRequest): Promise<string> { return refuse(); }
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
  async findAcceptedInput(_task: TaskRef, _operationId: string): Promise<string | null> { return refuse(); }
  async findQueuedSubmission(_task: TaskRef, _operationId: string): Promise<string | null> { return refuse(); }
  async findQueuedSubmissionOutcome(_task: TaskRef, _operationId: string): Promise<QueuedSubmissionOutcome | null> {
    return refuse();
  }
  async inspectTask(_task: TaskRef): Promise<TaskDetails> { return refuse(); }
  async archiveTask(_task: TaskRef): Promise<void> { refuse(); }
  async archiveRetryReady(_task: TaskRef): Promise<boolean> { return refuse(); }
}
