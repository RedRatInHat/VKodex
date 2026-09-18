import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Codex, type ModelReasoningEffort, type ThreadEvent } from "@openai/codex-sdk";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, sameTask, taskKey,
  type CreateTaskRequest, type DesktopMetadata, type DesktopTask, type DesktopTaskCreator,
  type TaskCreationUpdate, type TaskDetails, type TaskEvent, type TaskRef } from "./contracts.js";
import { nativeCodexPath } from "./metadata.js";
import type { MultiDesktopCatalog, ResolvedDesktopProject } from "./multi-catalog.js";
import { createTaskWorktree } from "./task-workspaces.js";
import { withVkResponseFormat } from "./vk-response-format.js";

const efforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface CreationRun {
  readonly task: DesktopTask;
  readonly operationId: string;
  readonly controller: AbortController;
  details: TaskDetails;
  latestAgentText: string;
  pendingAgent: { readonly id: string; readonly text: string } | null;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function accepted<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UncertainActionError()), timeoutMs); timer.unref();
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Materializes a brand-new task with its atomic first App Server turn.
 * Existing tasks never pass through this class; after this turn the configured
 * Desktop/VS Code owner is the only executor used by VKodex.
 */
export class AppServerTaskCreator implements DesktopTaskCreator {
  private readonly runs = new Map<string, CreationRun>();
  private readonly listeners = new Set<(update: TaskCreationUpdate) => void>();

  constructor(
    private readonly catalog: Pick<MultiDesktopCatalog, "resolveProject" | "sourceHome" | "listTasks"> & Partial<Pick<MultiDesktopCatalog, "listModels">>,
    private readonly metadata: DesktopMetadata,
    private readonly createCodex: (home: string) => Codex = home => new Codex({
      codexPathOverride: nativeCodexPath(),
      env: { ...buildCodexEnvironment(process.env), CODEX_HOME: home },
    }),
    private readonly makeWorktree: (project: ResolvedDesktopProject, operationId: string) => Promise<string> = createTaskWorktree,
  ) {}

  onUpdate(listener: (update: TaskCreationUpdate) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  details(task: TaskRef): TaskDetails | null { return this.runs.get(taskKey(task))?.details ?? null; }
  isActive(task: TaskRef): boolean { return this.runs.has(taskKey(task)); }

  async interrupt(task: TaskRef): Promise<boolean> {
    const run = this.runs.get(taskKey(task));
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  async createTask(request: CreateTaskRequest): Promise<DesktopTask> {
    const model = request.model?.trim(); const effort = request.effort?.trim();
    if (effort && !efforts.has(effort)) throw new ActionRejectedError("Выбранный уровень рассуждения не поддерживается Codex.");
    const resolved = await this.resolveWorkspace(request);
    if (model && this.catalog.listModels) {
      const models = await this.catalog.listModels({ hostId: "local", threadId: "", sourceId: resolved.sourceId ?? "" });
      const available = models.find(item => item.id === model);
      if (!available || (effort && !available.efforts.includes(effort))) {
        throw new ActionRejectedError("Версия Codex CLI, установленная с VKodex, не поддерживает выбранную модель или уровень рассуждения. Обнови VKodex или выбери доступную модель; задача не создана.");
      }
    }
    const controller = new AbortController();
    const thread = this.createCodex(resolved.sourceHome).startThread({
      workingDirectory: resolved.workspace,
      threadSource: "user",
      skipGitRepoCheck: request.projectId === null,
      ...(model ? { model } : {}),
      ...(effort ? { modelReasoningEffort: effort as ModelReasoningEffort } : {}),
    });
    let stream;
    try { stream = await thread.runStreamed(withVkResponseFormat(request.prompt), { signal: controller.signal }); }
    catch (error) {
      if (error instanceof ActionRejectedError || error instanceof DesktopUnavailableError) throw error;
      throw new UncertainActionError();
    }
    const started = deferred<DesktopTask>(); const turnStarted = deferred<void>();
    void this.consume(stream.events, { request, controller, started, turnStarted, ...resolved }).catch(() => {});
    const initialTask = await accepted(started.promise);
    await accepted(turnStarted.promise);
    const task = await this.waitForCatalog(initialTask);
    try {
      await this.metadata.assignProject(task, resolved.rawProjectId);
      await this.metadata.rename(task, request.title);
    } catch (error) {
      throw error instanceof ActionRejectedError ? new UncertainActionError() : error;
    }
    return { ...task, title: request.title, projectId: request.projectId };
  }

  private async resolveWorkspace(request: CreateTaskRequest): Promise<{
    readonly sourceHome: string;
    readonly sourceId?: string;
    readonly workspace: string;
    readonly rawProjectId: string | null;
  }> {
    let project: ResolvedDesktopProject; let sourceHome: string; let sourceId: string | undefined;
    let workspace: string; let rawProjectId: string | null;
    if (request.projectId === null) {
      const selected = request.workspace?.trim();
      if (!selected || !path.isAbsolute(selected)) throw new ActionRejectedError("Для задачи без проекта укажи абсолютный путь к рабочей папке.");
      workspace = path.normalize(selected);
      if (request.automaticWorkspace) {
        try { await mkdir(workspace, { recursive: true, mode: 0o700 }); }
        catch { throw new ActionRejectedError("Не удалось создать служебную рабочую папку VKodex."); }
      } else {
        try { if (!(await stat(workspace)).isDirectory()) throw new Error("not a directory"); }
        catch { throw new ActionRejectedError("Рабочая папка не существует или недоступна."); }
      }
      sourceId = request.sourceId || undefined;
      sourceHome = this.catalog.sourceHome({ hostId: "local", threadId: "", ...(sourceId ? { sourceId } : {}) });
      project = { project: { id: "", title: "Без проекта", workspace }, rawProjectId: "", sourceHome, sourceLabel: "", ...(sourceId ? { sourceId } : {}) };
      rawProjectId = null;
    } else {
      project = await this.catalog.resolveProject(request.projectId);
      if ((project.sourceId ?? "") !== (request.sourceId ?? "")) throw new ActionRejectedError("Проект относится к другому каталогу Codex.");
      sourceHome = project.sourceHome; sourceId = project.sourceId; workspace = project.project.workspace; rawProjectId = project.rawProjectId;
    }
    if (request.environment === "worktree") workspace = await this.makeWorktree(project, request.operationId);
    if (!path.isAbsolute(workspace)) throw new ActionRejectedError("У проекта нет локальной рабочей папки.");
    return { sourceHome, workspace, rawProjectId, ...(sourceId ? { sourceId } : {}) };
  }

  private async waitForCatalog(created: DesktopTask): Promise<DesktopTask> {
    const deadline = Date.now() + 10_000;
    do {
      const task = (await this.catalog.listTasks()).find(candidate => sameTask(candidate, created));
      if (task && (!task.sourceId || task.rolloutPath)) return task;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new UncertainActionError();
  }

  private async consume(events: AsyncGenerator<ThreadEvent>, options: {
    readonly request: CreateTaskRequest;
    readonly controller: AbortController;
    readonly started: Deferred<DesktopTask>;
    readonly turnStarted: Deferred<void>;
    readonly workspace: string;
    readonly sourceId?: string;
  }): Promise<void> {
    let task: DesktopTask | null = null; let run: CreationRun | null = null; let acceptedTurn = false; let terminal = false;
    const rejectBeforeStart = (error: Error) => { if (!task) options.started.reject(error); if (!acceptedTurn) options.turnStarted.reject(error); };
    try {
      for await (const event of events) {
        if (event.type === "thread.started" && !task) {
          task = { hostId: "local", threadId: event.thread_id, title: options.request.title, workspace: options.workspace,
            projectId: options.request.projectId, updatedAt: Date.now(), ...(options.sourceId ? { sourceId: options.sourceId } : {}) };
          run = { task, operationId: options.request.operationId, controller: options.controller,
            details: this.makeDetails(task, "running"), latestAgentText: "", pendingAgent: null };
          this.runs.set(taskKey(task), run); options.started.resolve(task);
        }
        if (!task || !run) continue;
        const item = event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed" ? event.item : null;
        if (run.pendingAgent && item && item.id !== run.pendingAgent.id) this.flushPendingAgent(run);
        if (event.type === "turn.started") {
          acceptedTurn = true; options.turnStarted.resolve();
          this.emit(run, { type: "status", id: `status:${run.operationId}`, turnId: run.operationId, status: "running" });
        } else if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.item.type === "reasoning" && event.item.text.trim()) {
          this.emit(run, { type: "progress", id: event.item.id, turnId: run.operationId, text: event.item.text });
        } else if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
          run.latestAgentText = event.item.text;
          if (event.type === "item.completed") run.pendingAgent = event.item.text.trim() ? { id: event.item.id, text: event.item.text } : null;
          else if (event.item.text.trim()) this.emit(run, { type: "progress", id: event.item.id, turnId: run.operationId, text: event.item.text });
        } else if (event.type === "turn.completed") {
          terminal = true;
          const finalText = run.pendingAgent?.text ?? run.latestAgentText; run.pendingAgent = null;
          if (finalText.trim()) this.emit(run, { type: "final", id: `final:${run.operationId}`, turnId: run.operationId, text: finalText });
          run.details = this.makeDetails(task, "idle");
          this.emit(run, { type: "status", id: `status:${run.operationId}`, turnId: run.operationId, status: "completed" });
        } else if (event.type === "turn.failed" || event.type === "error") {
          terminal = true;
          this.flushPendingAgent(run);
          run.details = this.makeDetails(task, "failed");
          this.emit(run, { type: "final", id: `failure:${run.operationId}`, turnId: run.operationId, text: "Codex не завершил первый ход новой задачи." });
          this.emit(run, { type: "status", id: `status:${run.operationId}`, turnId: run.operationId, status: "failed" });
        }
      }
      if (!acceptedTurn) options.turnStarted.reject(new UncertainActionError());
    } catch (error) {
      const safe = error instanceof ActionRejectedError || error instanceof DesktopUnavailableError ? error : new UncertainActionError();
      rejectBeforeStart(safe);
      if (task && run) {
        terminal = true;
        this.flushPendingAgent(run);
        run.details = this.makeDetails(task, options.controller.signal.aborted ? "interrupted" : "failed");
        if (!options.controller.signal.aborted) this.emit(run, { type: "final", id: `failure:${run.operationId}`, turnId: run.operationId, text: "Codex не завершил первый ход новой задачи." });
        this.emit(run, { type: "status", id: `status:${run.operationId}`, turnId: run.operationId, status: run.details.status as "failed" | "interrupted" });
      }
    } finally {
      if (task && run) {
        if (!terminal && run.details.status === "running") {
          run.details = this.makeDetails(task, options.controller.signal.aborted ? "interrupted" : "failed");
          if (!options.controller.signal.aborted) this.emit(run, { type: "final", id: `failure:${run.operationId}`, turnId: run.operationId, text: "Codex не завершил первый ход новой задачи." });
          this.emit(run, { type: "status", id: `status:${run.operationId}`, turnId: run.operationId, status: run.details.status as "failed" | "interrupted" });
        }
        this.runs.delete(taskKey(task));
      }
    }
  }

  private makeDetails(task: DesktopTask, status: TaskDetails["status"]): TaskDetails {
    return { title: task.title, status, workspace: task.workspace, model: null, effort: null, nextModel: null, nextEffort: null, context: null };
  }

  private flushPendingAgent(run: CreationRun): void {
    const pending = run.pendingAgent; if (!pending) return; run.pendingAgent = null;
    this.emit(run, { type: "progress", id: pending.id, turnId: run.operationId, text: pending.text });
  }

  private emit(run: CreationRun, event: TaskEvent): void {
    const update = { task: run.task, event, details: run.details } satisfies TaskCreationUpdate;
    for (const listener of this.listeners) listener(update);
  }
}
