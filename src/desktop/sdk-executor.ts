import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { Codex, type ModelReasoningEffort, type ThreadEvent, type UserInput } from "@openai/codex-sdk";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { taskInput } from "./desktop-tasks.js";
import { nativeCodexPath } from "./metadata.js";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, sameTask, taskKey,
  type CreateTaskRequest, type DesktopMetadata, type DesktopTask, type DirectTaskExecutor, type DirectTaskUpdate,
  type SubmitTaskRequest, type TaskDetails, type TaskEvent, type TaskRef } from "./contracts.js";
import type { MultiDesktopCatalog, ResolvedDesktopProject } from "./multi-catalog.js";

const execFileAsync = promisify(execFile);
const efforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

interface RunState {
  readonly task: DesktopTask;
  readonly operationId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
  details: TaskDetails;
  latestAgentText: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    throw new ActionRejectedError("Для worktree нужен локальный Git-репозиторий с доступной базовой ревизией.");
  }
}

async function createWorktree(project: ResolvedDesktopProject, operationId: string): Promise<string> {
  if (!path.isAbsolute(project.project.workspace)) throw new ActionRejectedError("У проекта нет локальной рабочей папки для worktree.");
  const root = path.resolve(await git(project.project.workspace, ["rev-parse", "--show-toplevel"]));
  let startPoint: string;
  try { startPoint = await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]); }
  catch { startPoint = await git(root, ["rev-parse", "HEAD"]); }
  const name = `${path.basename(root)}_VKodex_${operationId.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 8) || randomUUID().slice(0, 8)}_worktree`;
  const destination = path.join(path.dirname(root), name);
  try {
    await execFileAsync("git", ["-C", root, "worktree", "add", "--detach", destination, startPoint], { encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch {
    throw new ActionRejectedError("Git не смог создать отдельный worktree. Проверь занятое имя, состояние репозитория и базовую ветку.");
  }
  return destination;
}

export class SdkTaskExecutor implements DirectTaskExecutor {
  private readonly runs = new Map<string, RunState>();
  private readonly latest = new Map<string, TaskDetails>();
  private readonly listeners = new Set<(update: DirectTaskUpdate) => void>();

  constructor(
    private readonly catalog: Pick<MultiDesktopCatalog, "resolveProject" | "sourceHome" | "listTasks">,
    private readonly metadata: DesktopMetadata,
    private readonly createCodex: (home: string) => Codex = home => new Codex({ codexPathOverride: nativeCodexPath(), env: { ...buildCodexEnvironment(process.env), CODEX_HOME: home } }),
    private readonly makeWorktree: (project: ResolvedDesktopProject, operationId: string) => Promise<string> = createWorktree,
  ) {}

  onUpdate(listener: (update: DirectTaskUpdate) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  details(task: TaskRef): TaskDetails | null { return this.runs.get(taskKey(task))?.details ?? this.latest.get(taskKey(task)) ?? null; }
  isRunning(task: TaskRef): boolean { return this.runs.has(taskKey(task)); }

  async createTask(request: CreateTaskRequest): Promise<DesktopTask> {
    const project = await this.catalog.resolveProject(request.projectId);
    const model = request.model?.trim();
    const effort = request.effort?.trim();
    if (effort && !efforts.has(effort)) throw new ActionRejectedError("Выбранный уровень рассуждения не поддерживается Codex SDK.");
    const workspace = request.environment === "worktree" ? await this.makeWorktree(project, request.operationId) : project.project.workspace;
    if (!path.isAbsolute(workspace)) throw new ActionRejectedError("У проекта нет локальной рабочей папки.");
    const codex = this.codex(project.sourceHome);
    const controller = new AbortController();
    const thread = codex.startThread({ workingDirectory: workspace, threadSource: "user", skipGitRepoCheck: false,
      ...(model ? { model } : {}), ...(effort ? { modelReasoningEffort: effort as ModelReasoningEffort } : {}) });
    const stream = await thread.runStreamed(request.prompt, { signal: controller.signal });
    const started = deferred<DesktopTask>();
    const turnStarted = deferred<void>();
    const consume = this.consume(stream.events, {
      operationId: request.operationId, controller, started, turnStarted,
      initialTask: null, title: request.title, workspace, projectId: request.projectId,
      ...(project.sourceId ? { sourceId: project.sourceId } : {}),
    });
    void consume.catch(() => {});
    const task = await accepted(started.promise);
    try {
      await this.metadata.assignProject(task, project.rawProjectId);
      await this.metadata.rename(task, request.title);
    } catch (error) {
      throw error instanceof ActionRejectedError ? new UncertainActionError() : error;
    }
    return task;
  }

  async submit(request: SubmitTaskRequest): Promise<void> {
    const existing = this.runs.get(taskKey(request.task));
    if (existing) throw new ActionRejectedError("Эта задача уже выполняется через резервный Codex-процесс. Дождись завершения или отправь /stop.");
    const task = await this.resolveTask(request.task);
    const prepared = taskInput(request);
    const input: UserInput[] = [{ type: "text", text: prepared.text }, ...(request.inputFiles ?? []).filter(file => file.kind === "image").map(file => ({ type: "local_image" as const, path: file.path }))];
    const controller = new AbortController();
    const thread = this.codex(this.catalog.sourceHome(task)).resumeThread(task.threadId, { workingDirectory: task.workspace, threadSource: "user" });
    await request.beforeSend?.();
    const stream = await thread.runStreamed(input, { signal: controller.signal });
    const started = deferred<DesktopTask>(); started.resolve(task);
    const turnStarted = deferred<void>();
    const consume = this.consume(stream.events, { operationId: request.operationId, controller, started, turnStarted, initialTask: task,
      title: task.title, workspace: task.workspace, projectId: task.projectId ?? null, ...(task.sourceId ? { sourceId: task.sourceId } : {}) });
    void consume.catch(() => {});
    await accepted(turnStarted.promise);
  }

  async interrupt(task: TaskRef): Promise<boolean> {
    const run = this.runs.get(taskKey(task));
    if (!run) return false;
    run.controller.abort();
    await Promise.race([run.done.catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 5_000); timer.unref(); })]);
    return true;
  }

  private codex(home: string): Codex {
    return this.createCodex(home);
  }

  private async resolveTask(ref: TaskRef): Promise<DesktopTask> {
    const tasks = await this.catalog.listTasks();
    const task = tasks.find(candidate => sameTask(candidate, ref));
    if (!task) throw new ActionRejectedError("Задача не найдена в настроенных каталогах Codex.");
    return task;
  }

  private async consume(events: AsyncGenerator<ThreadEvent>, options: {
    readonly operationId: string;
    readonly controller: AbortController;
    readonly started: Deferred<DesktopTask>;
    readonly turnStarted: Deferred<void>;
    readonly initialTask: DesktopTask | null;
    readonly title: string;
    readonly workspace: string;
    readonly projectId: string | null;
    readonly sourceId?: string;
  }): Promise<void> {
    let task = options.initialTask;
    let state: RunState | null = null;
    let acceptedTurn = false;
    const failBeforeStart = (error: Error): void => { if (!task) options.started.reject(error); if (!acceptedTurn) options.turnStarted.reject(error); };
    try {
      for await (const event of events) {
        if (event.type === "thread.started" && !task) {
          task = { hostId: "local", threadId: event.thread_id, title: options.title, workspace: options.workspace,
            projectId: options.projectId, updatedAt: Date.now(), ...(options.sourceId ? { sourceId: options.sourceId } : {}) };
          const details = this.makeDetails(task, "running");
          const done = deferred<void>();
          state = { task, operationId: options.operationId, controller: options.controller, done: done.promise, finish: () => done.resolve(), details, latestAgentText: "" };
          this.runs.set(taskKey(task), state); this.latest.set(taskKey(task), details);
          options.started.resolve(task);
        }
        if (!task) continue;
        if (!state) {
          const details = this.makeDetails(task, "running"); const done = deferred<void>();
          state = { task, operationId: options.operationId, controller: options.controller, done: done.promise, finish: () => done.resolve(), details, latestAgentText: "" };
          this.runs.set(taskKey(task), state); this.latest.set(taskKey(task), details);
        }
        if (event.type === "turn.started") {
          acceptedTurn = true; options.turnStarted.resolve();
          this.emit(state, { type: "status", id: `status:${options.operationId}`, turnId: options.operationId, status: "running" });
        } else if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.item.type === "reasoning" && event.item.text.trim()) {
          this.emit(state, { type: "progress", id: event.item.id, turnId: options.operationId, text: event.item.text });
        } else if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
          state.latestAgentText = event.item.text;
          if (event.type !== "item.completed" && event.item.text.trim()) this.emit(state, { type: "progress", id: event.item.id, turnId: options.operationId, text: event.item.text });
        } else if (event.type === "turn.completed") {
          if (state.latestAgentText.trim()) this.emit(state, { type: "final", id: `final:${options.operationId}`, turnId: options.operationId, text: state.latestAgentText });
          state.details = this.makeDetails(task, "idle"); this.latest.set(taskKey(task), state.details);
          this.emit(state, { type: "status", id: `status:${options.operationId}`, turnId: options.operationId, status: "completed" });
        } else if (event.type === "turn.failed" || event.type === "error") {
          const message = event.type === "turn.failed" ? event.error.message : event.message;
          state.details = this.makeDetails(task, "failed"); this.latest.set(taskKey(task), state.details);
          this.emit(state, { type: "final", id: `failure:${options.operationId}`, turnId: options.operationId, text: `Codex не завершил ход: ${message.slice(0, 1_000)}` });
          this.emit(state, { type: "status", id: `status:${options.operationId}`, turnId: options.operationId, status: "failed" });
        }
      }
      if (!acceptedTurn) options.turnStarted.reject(new UncertainActionError());
    } catch (error) {
      const safe = error instanceof ActionRejectedError || error instanceof DesktopUnavailableError ? error : new UncertainActionError();
      failBeforeStart(safe);
      if (task && state) {
        const status = options.controller.signal.aborted ? "interrupted" : "failed";
        state.details = this.makeDetails(task, status); this.latest.set(taskKey(task), state.details);
        this.emit(state, { type: "status", id: `status:${options.operationId}`, turnId: options.operationId, status });
      }
    } finally {
      if (task && state) {
        if (state.details.status === "running") {
          const status = options.controller.signal.aborted ? "interrupted" : "failed";
          state.details = this.makeDetails(task, status); this.latest.set(taskKey(task), state.details);
          this.emit(state, { type: "status", id: `status:${options.operationId}`, turnId: options.operationId, status });
        }
        this.runs.delete(taskKey(task));
        state.finish();
      }
    }
  }

  private makeDetails(task: DesktopTask, status: TaskDetails["status"]): TaskDetails {
    return { title: task.title, status, workspace: task.workspace, model: null, effort: null, nextModel: null, nextEffort: null, context: null };
  }

  private emit(state: RunState, event: TaskEvent): void {
    const update = { task: state.task, event, details: state.details } satisfies DirectTaskUpdate;
    for (const listener of this.listeners) listener(update);
  }
}
