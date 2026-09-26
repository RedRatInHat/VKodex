import { spawn } from "node:child_process";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, type SubmitTaskReceipt, type SubmitTaskRequest, type TaskDetails, type TaskGoal,
  type TaskGoalUpdate, type TaskRef, type TaskRenameResult } from "../core/codex-tasks.js";
import type { CodexQuestions } from "../core/codex-questions.js";
import type { TaskState, TaskStateStream, TaskStateTransport } from "../core/task-state.js";
import { AppServerConnection, type AppServerRpc } from "./app-server-connection.js";
import { nativeCodexPath } from "./native-cli.js";
import { AppServerTaskExecutor } from "./app-server-task-executor.js";
import { AppServerTaskStateTransport, observeAppServerTaskState } from "./app-server-task-state.js";

/** One explicit task owner: one CODEX_HOME, one long-lived App Server connection. */
export class AppServerProfileOwner {
  readonly observe = observeAppServerTaskState;
  readonly states: TaskStateTransport;
  private readonly executor: AppServerTaskExecutor;
  private readonly nativeStates: AppServerTaskStateTransport;
  private readonly unsubscribeQuestions: () => void;

  constructor(readonly sourceId: string, private readonly rpc: AppServerRpc,
    private readonly resolveProject?: (projectId: string) => Promise<{ readonly rawProjectId: string; readonly sourceId?: string }>) {
    this.executor = new AppServerTaskExecutor(rpc);
    this.nativeStates = new AppServerTaskStateTransport(rpc,
      threadId => this.executor.questionSnapshot(threadId),
      (task, release) => this.executor.release(task, release),
      (task, result) => { this.executor.acceptResumedTask(task, result); },
      task => this.executor.resumeForStream(task));
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
  renameTask(task: TaskRef, title: string): Promise<TaskRenameResult> {
    this.assertOwner(task); return this.executor.renameTask(task, title);
  }
  async moveTask(task: TaskRef, projectId: string | null): Promise<void> {
    this.assertOwner(task);
    if (projectId === null) return this.executor.assignProject(task, null);
    if (!this.resolveProject) throw new ActionRejectedError("Назначение проекта недоступно для этого владельца Codex.");
    const resolved = await this.resolveProject(projectId);
    if ((resolved.sourceId ?? "") !== this.sourceId) throw new ActionRejectedError("Нельзя перенести задачу между разными каталогами CODEX_HOME.");
    return this.executor.assignProject(task, resolved.rawProjectId);
  }
  getGoal(task: TaskRef): Promise<TaskGoal | null> { this.assertOwner(task); return this.executor.getGoal(task); }
  setGoal(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> { this.assertOwner(task); return this.executor.setGoal(task, update); }
  clearGoal(task: TaskRef): Promise<boolean> { this.assertOwner(task); return this.executor.clearGoal(task); }
  archiveTask(task: TaskRef): Promise<void> {
    this.assertOwner(task); return this.executor.archiveIdle(task);
  }
  archiveRetryReady(task: TaskRef): Promise<boolean> {
    this.assertOwner(task); return this.executor.archiveRetryReady(task);
  }
  pendingQuestions(task: TaskRef): Promise<readonly CodexQuestions[]> {
    this.assertOwner(task); return this.executor.pendingQuestions(task);
  }

  async findAcceptedInput(task: TaskRef, operationId: string): Promise<string | null> {
    this.assertOwner(task);
    if (!operationId) return null;
    let cursor: string | null = null; const seen = new Set<string>();
    do {
      if (cursor) {
        if (seen.has(cursor)) throw new ActionRejectedError("Codex повторил страницу истории задачи.");
        seen.add(cursor);
      }
      const page = await this.rpc.request("thread/turns/list", {
        threadId: task.threadId, ...(cursor ? { cursor } : {}), limit: 100, sortDirection: "desc", itemsView: "full",
      });
      if (!Array.isArray(page.data)) throw new ActionRejectedError("Codex вернул неполную историю задачи.");
      for (const value of page.data) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const turn = value as Record<string, unknown>;
        if (typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
        const accepted = turn.items.some(item => !!item && typeof item === "object" && !Array.isArray(item)
          && (item as Record<string, unknown>).type === "userMessage"
          && (item as Record<string, unknown>).clientId === operationId);
        if (accepted) return turn.id;
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
    } while (cursor);
    return null;
  }

  async inspectTask(task: TaskRef): Promise<TaskDetails> {
    this.assertOwner(task);
    // Diagnostics must not acquire a writer or alter the shared subscription.
    return this.executor.inspectTask(task);
  }
  answerQuestions(task: TaskRef, question: CodexQuestions, answers: Readonly<Record<string, string>>,
    operationId: string, beforeSend: () => Promise<void>): Promise<void> {
    this.assertOwner(task); return this.executor.answerQuestions(task, question, answers, operationId, beforeSend);
  }

  async close(): Promise<void> {
    this.unsubscribeQuestions(); this.nativeStates.close(); this.executor.close(); await this.rpc.close();
  }
}

export function createAppServerProfileOwner(sourceId: string, codexHome: string,
  resolveProject?: (projectId: string) => Promise<{ readonly rawProjectId: string; readonly sourceId?: string }>): AppServerProfileOwner {
  const rpc = new AppServerConnection(() => spawn(nativeCodexPath(), ["app-server", "--stdio"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...buildCodexEnvironment(process.env), CODEX_HOME: codexHome },
  }));
  return new AppServerProfileOwner(sourceId, rpc, resolveProject);
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
