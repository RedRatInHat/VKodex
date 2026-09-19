import { ActionRejectedError, type SubmitTaskReceipt, type SubmitTaskRequest, type TaskRef } from "../core/codex-tasks.js";
import type { CodexQuestions } from "../core/codex-questions.js";
import type { TaskState, TaskStateStream, TaskStateTransport } from "../core/task-state.js";
import type { AppServerRpc } from "./app-server-connection.js";
import { AppServerTaskExecutor } from "./app-server-task-executor.js";
import { AppServerTaskStateTransport, observeAppServerTaskState } from "./app-server-task-state.js";

/** One explicit task owner: one CODEX_HOME, one long-lived App Server connection. */
export class AppServerProfileOwner {
  readonly observe = observeAppServerTaskState;
  readonly states: TaskStateTransport;
  private readonly executor: AppServerTaskExecutor;
  private readonly nativeStates: AppServerTaskStateTransport;
  private readonly unsubscribeQuestions: () => void;

  constructor(readonly sourceId: string, private readonly rpc: AppServerRpc) {
    this.executor = new AppServerTaskExecutor(rpc);
    this.nativeStates = new AppServerTaskStateTransport(rpc, threadId => this.executor.questionSnapshot(threadId));
    this.unsubscribeQuestions = this.executor.onQuestionsChanged(threadId => this.nativeStates.refresh(threadId));
    this.states = {
      subscribe: (task, onState, onError) => {
        this.assertOwner(task);
        return this.nativeStates.subscribe(task, onState, onError);
      },
      close: () => this.nativeStates.close(),
    };
  }

  owns(task: TaskRef): boolean { return (task.sourceId ?? "") === this.sourceId; }

  private assertOwner(task: TaskRef): void {
    if (!this.owns(task)) throw new ActionRejectedError("Задача относится к другому аккаунту Codex.");
  }

  submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    this.assertOwner(request.task); return this.executor.submitWithReceipt(request);
  }
  interrupt(task: TaskRef): Promise<void> { this.assertOwner(task); return this.executor.interrupt(task); }
  queue(request: SubmitTaskRequest): Promise<string> { this.assertOwner(request.task); return this.executor.queue(request); }
  selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    this.assertOwner(task); return this.executor.selectModel(task, model, effort);
  }
  pendingQuestions(task: TaskRef): Promise<readonly CodexQuestions[]> {
    this.assertOwner(task); return this.executor.pendingQuestions(task);
  }
  answerQuestions(task: TaskRef, question: CodexQuestions, answers: Readonly<Record<string, string>>,
    operationId: string, beforeSend: () => Promise<void>): Promise<void> {
    this.assertOwner(task); return this.executor.answerQuestions(task, question, answers, operationId, beforeSend);
  }

  async close(): Promise<void> {
    this.unsubscribeQuestions(); this.nativeStates.close(); this.executor.close(); await this.rpc.close();
  }
}

/** Routes state subscriptions to an explicit profile owner without fallback. */
export class AppServerOwnerStateRouter implements TaskStateTransport {
  constructor(private readonly owners: readonly AppServerProfileOwner[]) {}
  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void,
    onError: (error: Error) => void): TaskStateStream {
    const owner = this.owners.find(candidate => candidate.owns(task));
    if (!owner) throw new ActionRejectedError("Для каталога задачи не настроен владелец Codex.");
    return owner.states.subscribe(task, onState, onError);
  }
  close(): void { for (const owner of this.owners) owner.states.close(); }
}
