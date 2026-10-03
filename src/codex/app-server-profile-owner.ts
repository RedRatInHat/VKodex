import { spawn } from "node:child_process";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, type SubmitTaskReceipt, type SubmitTaskRequest, type TaskDetails, type TaskGoal,
  type TaskGoalUpdate, type TaskRef, type TaskRenameResult, type ExecutionDrainResult } from "../core/codex-tasks.js";
import type { CodexQuestions } from "../core/codex-questions.js";
import type { TaskState, TaskStateStream, TaskStateTransport } from "../core/task-state.js";
import { AppServerConnection, type AppServerRpc } from "./app-server-connection.js";
import { nativeCodexPath } from "./native-cli.js";
import { AppServerTaskExecutor } from "./app-server-task-executor.js";
import { AppServerTaskStateTransport, observeAppServerTaskState, type AppServerStreamDiagnostic } from "./app-server-task-state.js";
import { createDetachedProfileConnection, detachedProfileDirectory } from "./detached-profile-capability.js";
import { LegacyExecutionLifecycle } from "./legacy-execution-lifecycle.js";

/** One explicit task owner: one CODEX_HOME, one long-lived App Server connection. */
export class AppServerProfileOwner {
  readonly routingPolicy?: "exclusive";
  readonly observe = observeAppServerTaskState;
  readonly states: TaskStateTransport;
  private readonly executor: AppServerTaskExecutor;
  private readonly nativeStates: AppServerTaskStateTransport;
  private readonly unsubscribeQuestions: () => void;
  private readonly rpc: AppServerRpc;
  private readonly lifecycle: LegacyExecutionLifecycle;

  constructor(readonly sourceId: string, rpc: AppServerRpc,
    private readonly resolveProject?: (projectId: string) => Promise<{ readonly rawProjectId: string; readonly sourceId?: string }>,
    private readonly detachedThreadIds?: ReadonlySet<string>,
    onDiagnostic: (task: TaskRef, event: AppServerStreamDiagnostic) => void = () => {},
    now?: () => number) {
    if (detachedThreadIds) this.routingPolicy = "exclusive";
    this.lifecycle = new LegacyExecutionLifecycle(rpc, now);
    this.rpc = this.lifecycle.rpc;
    this.executor = new AppServerTaskExecutor(this.rpc);
    this.nativeStates = new AppServerTaskStateTransport(this.rpc,
      threadId => this.executor.questionSnapshot(threadId),
      (task, release) => this.executor.release(task, release),
      (task, result) => { this.executor.acceptResumedTask(task, result); },
      task => this.executor.resumeForStream(task), onDiagnostic);
    this.unsubscribeQuestions = this.executor.onQuestionsChanged(threadId => this.nativeStates.refresh(threadId));
    this.states = {
      subscribe: (task, onState, onError) => {
        this.assertOwner(task);
        this.lifecycle.assertAdmission(task);
        return this.nativeStates.subscribe(task, onState, onError);
      },
      close: () => this.nativeStates.close(),
    };
  }

  owns(task: TaskRef): boolean {
    return (task.sourceId ?? "") === this.sourceId &&
      (this.detachedThreadIds === undefined || this.detachedThreadIds.has(task.threadId));
  }

  private assertOwner(task: TaskRef): void {
    if (!this.owns(task)) throw new ActionRejectedError("Задача относится к другому аккаунту Codex.");
  }
  private async command<T>(task: TaskRef, work: () => Promise<T>, currentWorkControl = false): Promise<T> {
    this.assertOwner(task);
    const finish = this.lifecycle.beginCommand(task, currentWorkControl);
    try { return await work(); } finally { finish(); }
  }
  async ownerAdapterStatus(task: TaskRef): Promise<"ready" | "missing" | "unknown"> {
    this.assertOwner(task);
    if (this.legacyAcquisitionState(task)) return "unknown";
    if (this.lifecycle.isDraining(task)) return "unknown"; // Avoid activity that can extend the native unload grace period.
    const session = this.rpc.currentInitializedSession?.();
    if (!session) return "unknown";
    try {
      const result = await this.rpc.request("thread/read", { threadId: task.threadId, includeTurns: false },
        { expectedGeneration: session.generation, timeoutMs: 5_000 });
      if (this.legacyAcquisitionState(task) || this.lifecycle.isDraining(task)) return "unknown";
      const thread = result.thread;
      return thread && typeof thread === "object" && !Array.isArray(thread)
        && (thread as Record<string, unknown>).id === task.threadId ? "ready" : "unknown";
    } catch { return "unknown"; }
  }
  drainIdleExecution(task: TaskRef, beforeRelease: () => void, assertScope?: () => void): Promise<ExecutionDrainResult> {
    this.assertOwner(task);
    // Detached/shared executors use their own contract; never drain them through legacy health.
    if (this.routingPolicy === "exclusive") return Promise.resolve("unavailable");
    return this.lifecycle.drain(task, beforeRelease, () => this.executor.executionSnapshot(task),
      () => this.nativeStates.subscriptionSnapshot(task), assertScope);
  }
  pendingLegacyAcquisition(task: TaskRef): symbol | null {
    this.assertOwner(task);
    return this.routingPolicy === "exclusive" ? null : this.lifecycle.pendingLegacyAcquisition(task);
  }
  legacyAcquisitionState(task: TaskRef): "pending" | "unknown" | "abandoned" | null {
    this.assertOwner(task);
    return this.routingPolicy === "exclusive" ? null : this.lifecycle.legacyAcquisitionState(task);
  }
  restoreExecutionDrain(task: TaskRef): void {
    this.assertOwner(task);
    if (this.routingPolicy !== "exclusive") this.lifecycle.restore(task);
  }

  ensureOpen(task: TaskRef): Promise<void> {
    return this.command(task, () => this.executor.ensureOpen(task));
  }

  submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    this.assertOwner(request.task);
    return this.command(request.task, () => this.executor.submitWithReceipt(request));
  }
  interrupt(task: TaskRef): Promise<void> { return this.command(task, () => this.executor.interrupt(task), true); }
  queue(request: SubmitTaskRequest): Promise<string> { return this.command(request.task, () => this.executor.queue(request)); }
  selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    return this.command(task, () => this.executor.selectModel(task, model, effort));
  }
  renameTask(task: TaskRef, title: string): Promise<TaskRenameResult> {
    return this.command(task, () => this.executor.renameTask(task, title));
  }
  async moveTask(task: TaskRef, projectId: string | null): Promise<void> {
    this.assertOwner(task);
    if (projectId === null) return this.command(task, () => this.executor.assignProject(task, null));
    if (!this.resolveProject) throw new ActionRejectedError("Назначение проекта недоступно для этого владельца Codex.");
    const resolved = await this.resolveProject(projectId);
    if ((resolved.sourceId ?? "") !== this.sourceId) throw new ActionRejectedError("Нельзя перенести задачу между разными каталогами CODEX_HOME.");
    return this.command(task, () => this.executor.assignProject(task, resolved.rawProjectId));
  }
  getGoal(task: TaskRef): Promise<TaskGoal | null> { this.assertOwner(task); return this.executor.getGoal(task); }
  setGoal(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> { return this.command(task, () => this.executor.setGoal(task, update)); }
  clearGoal(task: TaskRef): Promise<boolean> { return this.command(task, () => this.executor.clearGoal(task), true); }
  archiveTask(task: TaskRef): Promise<void> {
    return this.command(task, () => this.executor.archiveIdle(task));
  }
  archiveRetryReady(task: TaskRef): Promise<boolean> {
    return this.command(task, () => this.executor.archiveRetryReady(task));
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
    return this.command(task, () => this.executor.answerQuestions(task, question, answers, operationId, beforeSend), true);
  }

  async close(): Promise<void> {
    this.unsubscribeQuestions(); this.nativeStates.close(); this.executor.close(); this.lifecycle.close(); await this.rpc.close();
  }
}

export function createAppServerProfileOwner(sourceId: string, codexHome: string,
  resolveProject?: (projectId: string) => Promise<{ readonly rawProjectId: string; readonly sourceId?: string }>,
  onDiagnostic?: (task: TaskRef, event: AppServerStreamDiagnostic) => void): AppServerProfileOwner {
  const rpc = new AppServerConnection(() => spawn(nativeCodexPath(), ["app-server", "--stdio"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...buildCodexEnvironment(process.env), CODEX_HOME: codexHome },
  }));
  return new AppServerProfileOwner(sourceId, rpc, resolveProject, undefined, onDiagnostic);
}

/** Opt-in only: the bridge obtains a client capability from the independent
 * profile server's ready record and never becomes its process owner. */
export function createDetachedAppServerProfileOwner(sourceId: string, codexHome: string,
  dataDirectory: string, threadIds: readonly string[],
  resolveProject?: (projectId: string) => Promise<{ readonly rawProjectId: string; readonly sourceId?: string }>,
  onDiagnostic?: (task: TaskRef, event: AppServerStreamDiagnostic) => void): AppServerProfileOwner {
  const privateDirectory = detachedProfileDirectory(dataDirectory, codexHome);
  return new AppServerProfileOwner(sourceId,
    createDetachedProfileConnection(privateDirectory, codexHome), resolveProject, new Set(threadIds), onDiagnostic);
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
