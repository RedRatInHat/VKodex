import { createHash } from "node:crypto";
import type { CodexQuestion, CodexQuestions } from "../core/codex-questions.js";
import { ActionRejectedError, DesktopUnavailableError, ProjectAssignmentUnconfirmedError, TaskNotOpenError, TaskOwnedByClientError, UncertainActionError, taskKey,
  type SubmitTaskReceipt, type SubmitTaskRequest, type TaskDetails, type TaskGoal, type TaskGoalUpdate, type TaskRef, type TaskRenameResult } from "../core/codex-tasks.js";
import { goalMatchesUpdate, normalizeTaskGoalUpdate, parseTaskGoal } from "../core/task-goals.js";
import { taskInput } from "../core/task-input.js";
import { AppServerRejectedError, AppServerUnavailableError, AppServerUncertainError,
  type AppServerEnvelope, type AppServerRpc } from "./app-server-connection.js";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

interface LoadedTask {
  activeTurnId: string | null;
  model: string | null;
  effort: string | null;
}

interface PendingQuestion {
  readonly question: CodexQuestions;
  resolve(result: JsonObject): void;
  reject(error: Error): void;
}

const operationError = (error: unknown, action = "команду"): Error => error instanceof AppServerUncertainError ? new UncertainActionError()
  : error instanceof AppServerRejectedError && error.reason === "active-writer" ? new TaskOwnedByClientError()
  : error instanceof AppServerRejectedError ? new ActionRejectedError(
    `Codex отклонил ${action}${typeof error.code === "number" ? ` (код ${error.code})` : ""}. Состояние задачи не изменено.`)
  // AppServerUnavailableError is produced only by reads or before a mutating
  // request is accepted. Mutating timeouts use AppServerUncertainError. Keep
  // the distinction here so the bridge can mark a broken owner route for
  // health/self-healing without risking an automatic duplicate mutation.
  : error instanceof AppServerUnavailableError ? new TaskNotOpenError()
  : error instanceof Error ? error : new ActionRejectedError("Codex не выполнил команду.");

function idOf(value: unknown): string | null { return typeof value === "string" && value ? value : null; }

/** Command-side prototype for a VKodex-owned, profile-scoped App Server. */
export class AppServerTaskExecutor {
  private readonly loaded = new Map<string, LoadedTask>();
  private readonly resuming = new Map<string, Promise<JsonObject>>();
  private readonly releasing = new Map<string, Promise<boolean>>();
  private readonly uncertainReleases = new Set<string>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly archiving = new Set<string>();
  private readonly archiveGroups = new Map<string, Set<string>>();
  private readonly questionListeners = new Set<(threadId: string) => void>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeDisconnect: () => void;

  constructor(private readonly rpc: AppServerRpc) {
    this.unsubscribe = rpc.onNotification(notification => this.observe(notification));
    this.unsubscribeDisconnect = rpc.onDisconnect?.(error => this.connectionLost(error)) ?? (() => {});
    rpc.onServerRequest(request => this.serverRequest(request));
  }

  /** Invalidate the command subscription cache after observation is released.
   * Unsubscribe does not unload the writer or cancel its pending questions. */
  forget(task: TaskRef): void {
    this.loaded.delete(taskKey(task));
    this.uncertainReleases.delete(taskKey(task));
  }

  /** Keep a possibly still-owned writer usable until unsubscribe is confirmed.
   * A failed/expired release is ambiguous: the next command checks native
   * ownership before deciding whether to reuse or resume the task. */
  release(task: TaskRef, pending: Promise<void> | null): void {
    if (!pending) return;
    const key = taskKey(task);
    const work = pending.then(() => true, () => false).then(released => {
      if (this.releasing.get(key) === work) {
        if (released) this.forget(task);
        else this.uncertainReleases.add(key);
      }
      return released;
    }).finally(() => { if (this.releasing.get(key) === work) this.releasing.delete(key); });
    this.releasing.set(key, work);
  }

  private async waitForRelease(task: TaskRef): Promise<boolean> {
    const key = taskKey(task);
    await this.releasing.get(key);
    if (!this.uncertainReleases.has(key) || !this.loaded.has(key)) return false;
    const result = await this.rpc.request("thread/read", { threadId: task.threadId, includeTurns: false });
    const thread = isObject(result.thread) ? result.thread : null;
    if (!thread || thread.id !== task.threadId) throw new AppServerUnavailableError();
    if (isObject(thread.status) && thread.status.type === "notLoaded") {
      this.forget(task); this.retireQuestion(task.threadId, new Error("Task unloaded"));
    }
    else this.uncertainReleases.delete(key);
    return true;
  }

  /** A state stream and the command executor share one profile App Server.
   * Record the stream's confirmed resume so the immediately following VK
   * command does not resume the same (potentially very large) task twice. */
  acceptResumedTask(task: TaskRef, result: JsonObject): LoadedTask {
    if (!isObject(result.thread) || result.thread.id !== task.threadId) throw new AppServerUnavailableError();
    const page = isObject(result.initialTurnsPage) && Array.isArray(result.initialTurnsPage.data)
      ? result.initialTurnsPage.data : [];
    const active = page.find(turn => isObject(turn) && turn.status === "inProgress");
    const previous = this.loaded.get(taskKey(task));
    const loaded = {
      activeTurnId: isObject(active) ? idOf(active.id)
        : isObject(result.thread.status) && result.thread.status.type === "active" ? previous?.activeTurnId ?? null : null,
      model: idOf(result.model), effort: idOf(result.reasoningEffort),
    };
    this.loaded.set(taskKey(task), loaded);
    return loaded;
  }

  /** Inspect an already subscribed task without another thread/resume.
   * Resume may replay pending requests; read-only diagnostics must not change
   * the subscription lifecycle or rely on reacquisition being harmless. */
  async inspectLoadedTask(task: TaskRef): Promise<TaskDetails | null> {
    if (!this.loaded.has(taskKey(task))) return null;
    return this.inspectTask(task);
  }

  /** Read-only inspection also works without our own writer/subscription.
   * A stored thread is not proof that this connection owns its execution. */
  async inspectTask(task: TaskRef): Promise<TaskDetails> {
    const loaded = this.loaded.get(taskKey(task));
    try {
      const response = await this.rpc.request("thread/read", { threadId: task.threadId, includeTurns: false });
      const thread = isObject(response.thread) && response.thread.id === task.threadId ? response.thread : null;
      if (!thread || !isObject(thread.status)) throw new AppServerUnavailableError();
      const nativeStatus = String(thread.status.type ?? "");
      // turn/start is acknowledged before thread/read is guaranteed to expose
      // the new active status. The accepted turn ID is stronger evidence and
      // remains authoritative while the runtime is healthy. Native unload or
      // system failure is stronger evidence than this cached acceptance.
      const knownLoadedStatus = ["idle", "active", "systemError"].includes(nativeStatus);
      const status = !knownLoadedStatus ? "unavailable" as const
        : nativeStatus === "systemError" ? "failed" as const
        : loaded?.activeTurnId || nativeStatus === "active" ? "running" as const
        : "idle" as const;
      return {
        title: typeof thread.name === "string" && thread.name ? thread.name : null,
        status, workspace: typeof thread.cwd === "string" && thread.cwd ? thread.cwd : null,
        model: loaded?.model ?? null, effort: loaded?.effort ?? null,
        nextModel: loaded?.model ?? null, nextEffort: loaded?.effort ?? null, context: null,
        ...(status === "failed" ? { failure: "systemError" as const } : {}),
      };
    } catch (error) { throw operationError(error, "проверку состояния задачи"); }
  }

  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    this.assertWritable(request.task.threadId);
    const prepared = taskInput(request);
    const loaded = await this.resume(request.task);
    if (this.questions.has(request.task.threadId)) throw new ActionRejectedError("В задаче открыт вопрос Codex. Сначала ответь на него; сообщение не отправлено.");
    await request.beforeSend?.();
    this.assertWritable(request.task.threadId);
    try {
      if (loaded.activeTurnId) {
        const result = await this.rpc.request("turn/steer", {
          threadId: request.task.threadId, clientUserMessageId: request.operationId,
          input: [...prepared.input], expectedTurnId: loaded.activeTurnId,
        }, { mutating: true });
        const turnId = idOf(result.turnId);
        if (!turnId || turnId !== loaded.activeTurnId) throw new UncertainActionError();
        return { mode: "steer", turnId };
      }
      const result = await this.rpc.request("turn/start", {
        threadId: request.task.threadId, clientUserMessageId: request.operationId, input: [...prepared.input],
      }, { mutating: true });
      const turnId = isObject(result.turn) ? idOf(result.turn.id) : null;
      if (!turnId) throw new UncertainActionError();
      this.loaded.set(taskKey(request.task), { ...loaded, activeTurnId: turnId });
      return { mode: "start", turnId };
    } catch (error) { throw operationError(error, loaded.activeTurnId ? "добавление сообщения в текущий ход" : "запуск нового хода"); }
  }

  async interrupt(task: TaskRef): Promise<void> {
    this.assertWritable(task.threadId);
    const loaded = await this.resume(task);
    if (!loaded.activeTurnId) throw new ActionRejectedError("У задачи нет активного хода.");
    const expectedTurnId = loaded.activeTurnId;
    this.assertWritable(task.threadId);
    const send = () => this.rpc.request("turn/interrupt", { threadId: task.threadId, turnId: expectedTurnId }, { mutating: true });
    try {
      await send();
    } catch (error) {
      const state = await this.interruptState(task.threadId, expectedTurnId);
      if (state === "stopped") return;
      // A lost reply is never replayed. The immutable turn ID makes one retry
      // safe only after an explicit rejection proves that the first request was
      // not accepted and a read confirms that same turn is still running.
      if (error instanceof AppServerUncertainError) throw new UncertainActionError();
      if (!(error instanceof AppServerRejectedError) || state !== "running") throw operationError(error);
      try { await send(); return; }
      catch (retryError) {
        const retryState = await this.interruptState(task.threadId, expectedTurnId);
        if (retryState === "stopped") return;
        if (retryError instanceof AppServerUncertainError) throw new UncertainActionError();
        if (retryError instanceof AppServerRejectedError && retryState === "running") {
          throw new ActionRejectedError("Codex отклонил остановку; этот ход всё ещё выполняется.");
        }
        throw operationError(retryError);
      }
    }
  }

  private async interruptState(threadId: string, expectedTurnId: string): Promise<"running" | "stopped" | "unknown"> {
    try {
      const response = await this.rpc.request("thread/turns/list", {
        threadId, limit: 20, sortDirection: "desc", itemsView: "summary",
      });
      if (!Array.isArray(response.data)) return "unknown";
      const turn = response.data.find(value => isObject(value) && value.id === expectedTurnId);
      if (!isObject(turn)) return "unknown";
      if (turn.status === "inProgress") return "running";
      return ["completed", "failed", "interrupted"].includes(String(turn.status)) ? "stopped" : "unknown";
    } catch { return "unknown"; }
  }

  async queue(request: SubmitTaskRequest): Promise<string> {
    this.assertWritable(request.task.threadId);
    const prepared = taskInput(request);
    await this.resume(request.task);
    await request.beforeSend?.();
    this.assertWritable(request.task.threadId);
    try {
      const result = await this.rpc.request("thread/queue/add", {
        threadId: request.task.threadId, clientUserMessageId: request.operationId, input: [...prepared.input],
      }, { mutating: true });
      const id = isObject(result.queuedSubmission) ? idOf(result.queuedSubmission.id) : null;
      if (!id) throw new UncertainActionError();
      return id;
    } catch (error) { throw operationError(error, "добавление сообщения в очередь"); }
  }

  async selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    if (!model || !effort) throw new ActionRejectedError("Модель и уровень рассуждения обязательны.");
    this.assertWritable(task.threadId);
    await this.resume(task);
    this.assertWritable(task.threadId);
    try {
      const update = () => this.rpc.request("thread/settings/update", { threadId: task.threadId, model, effort }, { mutating: true });
      try { await update(); }
      catch (error) {
        // Settings are an idempotent assignment. A confirmed transient rejection
        // can be retried once, unlike turn/start or an outcome-unknown timeout.
        // Protocol/parameter errors and a competing writer cannot heal this way.
        if (!(error instanceof AppServerRejectedError) || error.reason === "active-writer"
          || error.code === -32601 || error.code === -32602) throw error;
        await new Promise(resolve => setTimeout(resolve, 300));
        this.assertWritable(task.threadId);
        await update();
      }
      const loaded = this.loaded.get(taskKey(task));
      if (loaded) this.loaded.set(taskKey(task), { ...loaded, model, effort });
    } catch (error) { throw operationError(error); }
  }

  async renameTask(task: TaskRef, title: string): Promise<TaskRenameResult> {
    const name = title.trim();
    if (!name || name.length > 120 || /[\r\n\x00-\x1f]/u.test(name)) {
      throw new ActionRejectedError("Название должно быть одной строкой от 1 до 120 символов.");
    }
    this.assertWritable(task.threadId);
    try {
      await this.rpc.request("thread/name/set", { threadId: task.threadId, name }, { mutating: true });
    } catch (error) {
      const mapped = operationError(error);
      try { if ((await this.readMetadata(task)).title === name) return { liveTitleUpdated: true }; }
      catch { /* Preserve the mutation outcome when readback is unavailable. */ }
      throw mapped;
    }
    if ((await this.readMetadata(task)).title !== name) throw new UncertainActionError();
    return { liveTitleUpdated: true };
  }

  async assignProject(task: TaskRef, projectId: string | null): Promise<void> {
    this.assertWritable(task.threadId);
    try {
      await this.rpc.request("thread/metadata/update", { threadId: task.threadId, projectId: projectId ?? "" }, { mutating: true });
    } catch (error) {
      const mapped = operationError(error);
      try { if ((await this.readMetadata(task)).projectId === projectId) return; }
      catch { /* Preserve the mutation outcome when readback is unavailable. */ }
      throw mapped;
    }
    if ((await this.readMetadata(task)).projectId !== projectId) throw new ProjectAssignmentUnconfirmedError();
  }

  async getGoal(task: TaskRef): Promise<TaskGoal | null> {
    try {
      const response = await this.rpc.request("thread/goal/get", { threadId: task.threadId });
      return parseTaskGoal(response.goal ?? null, task.threadId);
    } catch (error) { throw operationError(error); }
  }

  async setGoal(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> {
    const normalized = normalizeTaskGoalUpdate(update);
    this.assertWritable(task.threadId);
    try {
      const response = await this.rpc.request("thread/goal/set", { threadId: task.threadId, ...normalized }, { mutating: true });
      const goal = parseTaskGoal(response.goal, task.threadId);
      if (!goal) throw new DesktopUnavailableError("Codex не подтвердил состояние цели.");
      return goal;
    } catch (error) {
      const mapped = operationError(error);
      try {
        const goal = await this.getGoal(task);
        if (goalMatchesUpdate(goal, normalized)) return goal;
      } catch { /* Preserve the mutation outcome when readback is unavailable. */ }
      throw mapped;
    }
  }

  async clearGoal(task: TaskRef): Promise<boolean> {
    this.assertWritable(task.threadId);
    try {
      const response = await this.rpc.request("thread/goal/clear", { threadId: task.threadId }, { mutating: true });
      if (typeof response.cleared !== "boolean") throw new DesktopUnavailableError("Codex не подтвердил снятие цели.");
      return response.cleared;
    } catch (error) {
      const mapped = operationError(error);
      try { if (await this.getGoal(task) === null) return true; }
      catch { /* Preserve the mutation outcome when readback is unavailable. */ }
      throw mapped;
    }
  }

  async pendingQuestions(task: TaskRef): Promise<readonly CodexQuestions[]> {
    const pending = this.questions.get(task.threadId);
    return pending ? [pending.question] : [];
  }

  questionSnapshot(threadId: string): readonly CodexQuestions[] {
    const pending = this.questions.get(threadId); return pending ? [pending.question] : [];
  }

  onQuestionsChanged(listener: (threadId: string) => void): () => void {
    this.questionListeners.add(listener); return () => { this.questionListeners.delete(listener); };
  }

  async answerQuestions(task: TaskRef, question: CodexQuestions, answers: Readonly<Record<string, string>>,
    _operationId: string, beforeSend: () => Promise<void>): Promise<void> {
    this.assertWritable(task.threadId);
    const key = task.threadId; const pending = this.questions.get(key);
    if (!pending || pending.question.fingerprint !== question.fingerprint) throw new ActionRejectedError("Вопрос уже закрыт или изменился.");
    const result: Record<string, { answers: string[] }> = {};
    for (const item of question.questions) {
      const answer = answers[item.id];
      if (!answer) throw new ActionRejectedError("Ответь на все вопросы Codex.");
      result[item.id] = { answers: [answer] };
    }
    await beforeSend();
    this.assertWritable(task.threadId);
    if (this.questions.get(key) !== pending) throw new ActionRejectedError("Вопрос уже закрыт или изменился. Ответ не отправлен.");
    this.questions.delete(key);
    this.notifyQuestions(key);
    pending.resolve({ answers: result });
  }

  async archiveRetryReady(task: TaskRef): Promise<boolean> {
    if (this.archiving.has(task.threadId)) return false;
    try { return !(await this.resume(task)).activeTurnId; }
    catch (error) {
      if (error instanceof TaskOwnedByClientError) return false;
      throw error;
    }
  }

  /** Archive through the same profile connection that owns the task. The
   * preflight mirrors the client adapter: source and every descendant must be
   * idle and have no active goal, the descendant set must stay stable, and an
   * uncertain mutation is never retried. */
  async archiveIdle(task: TaskRef): Promise<void> {
    const root = task.threadId;
    if (!root || root.length > 128 || /[\r\n\x00-\x1f]/u.test(root) || this.archiving.has(root)) {
      throw new ActionRejectedError("Задача уже архивируется или имеет некорректный идентификатор.");
    }
    const group = new Set([root]);
    this.archiving.add(root); this.archiveGroups.set(root, group);
    let uncertain = false;
    try {
      const loaded = await this.resume(task);
      if (loaded.activeTurnId) throw new ActionRejectedError("Сначала дождись завершения хода или останови его в Codex.");
      const descendants = await this.listDescendants(root);
      for (const id of descendants) {
        if (this.archiving.has(id)) throw new ActionRejectedError("Дочерняя задача уже архивируется.");
        this.archiving.add(id); group.add(id);
      }
      for (const id of group) {
        const read = await this.rpc.request("thread/read", { threadId: id, includeTurns: false });
        const thread = isObject(read.thread) && read.thread.id === id ? read.thread : null;
        let idle = !!thread && isObject(thread.status) && ["idle", "systemError"].includes(String(thread.status.type));
        if (thread && isObject(thread.status) && thread.status.type === "notLoaded") {
          // A finished descendant need not be open in this owner's App Server.
          // Resuming it here could steal another client's active turn. Confirm
          // its persisted terminal boundary without taking a writer lease.
          const page = await this.rpc.request("thread/turns/list", {
            threadId: id, limit: 1, sortDirection: "desc", itemsView: "summary",
          });
          const last = Array.isArray(page.data) && isObject(page.data[0]) ? page.data[0] : null;
          // Spawned children can be left without a first turn. An old,
          // unloaded, empty child has no work to finish; a newly created one
          // may still be starting in another client, so keep that blocked.
          const oldEmptyChild = id !== root && Array.isArray(page.data) && page.data.length === 0
            && page.nextCursor === null && typeof thread.updatedAt === "number"
            && Number.isFinite(thread.updatedAt) && thread.updatedAt <= Math.floor(Date.now() / 1000) - 120;
          idle = (!!last && ["completed", "failed", "interrupted"].includes(String(last.status))) || oldEmptyChild;
        }
        if (!idle) {
          throw new ActionRejectedError("Исходная и дочерние задачи должны быть завершены перед архивацией.");
        }
        const response = await this.rpc.request("thread/goal/get", { threadId: id });
        const goal = response.goal;
        if (goal !== null && (!isObject(goal) || !["paused", "complete", "blocked", "usageLimited", "budgetLimited"].includes(String(goal.status)))) {
          throw new ActionRejectedError("Перед архивацией приостанови цели исходной и дочерних задач.");
        }
      }
      const confirmed = await this.listDescendants(root);
      if (confirmed.size !== descendants.size || [...confirmed].some(id => !descendants.has(id))) {
        throw new ActionRejectedError("Список дочерних задач изменился во время проверки архивации.");
      }
      await this.rpc.request("thread/archive", { threadId: root }, { mutating: true });
    } catch (error) {
      const mapped = operationError(error);
      uncertain = mapped instanceof UncertainActionError;
      throw mapped;
    } finally {
      if (!uncertain) this.releaseArchive(root);
    }
  }

  private async listDescendants(threadId: string): Promise<Set<string>> {
    const ids = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const response = await this.rpc.request("thread/list", {
        ancestorThreadId: threadId, archived: false, limit: 100, ...(cursor ? { cursor } : {}),
        sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact",
          "subAgentThreadSpawn", "subAgentOther", "unknown"],
      });
      if (!Array.isArray(response.data)) throw new ActionRejectedError("Codex не вернул список дочерних задач.");
      for (const value of response.data) {
        if (!isObject(value) || typeof value.id !== "string" || !value.id || value.id === threadId || ids.has(value.id)) {
          throw new ActionRejectedError("Codex вернул нестабильный список дочерних задач.");
        }
        ids.add(value.id);
      }
      if (response.nextCursor == null) break;
      if (typeof response.nextCursor !== "string" || !response.nextCursor || cursors.has(response.nextCursor)) {
        throw new ActionRejectedError("Codex повторил страницу дочерних задач.");
      }
      cursor = response.nextCursor; cursors.add(cursor);
    } while (true);
    return ids;
  }

  private async readMetadata(task: TaskRef): Promise<{ readonly title: string | null; readonly projectId: string | null }> {
    try {
      const response = await this.rpc.request("thread/read", { threadId: task.threadId, includeTurns: false });
      const thread = isObject(response.thread) && response.thread.id === task.threadId ? response.thread : null;
      if (!thread || !(thread.name === null || typeof thread.name === "string" || thread.name === undefined)
        || !(thread.projectId === null || typeof thread.projectId === "string" || thread.projectId === undefined)) {
        throw new DesktopUnavailableError("Codex не подтвердил метаданные выбранной задачи.");
      }
      return {
        title: typeof thread.name === "string" && thread.name ? thread.name : null,
        projectId: typeof thread.projectId === "string" && thread.projectId ? thread.projectId : null,
      };
    } catch (error) { throw operationError(error); }
  }

  private assertWritable(threadId: string): void {
    if (this.archiving.has(threadId)) throw new ActionRejectedError("Задача архивируется; новая команда не отправлена.");
  }

  private releaseArchive(threadId: string): void {
    const group = this.archiveGroups.get(threadId);
    if (group) for (const id of group) this.archiving.delete(id);
    this.archiveGroups.delete(threadId);
  }

  private async resume(task: TaskRef): Promise<LoadedTask> {
    try {
      const verified = await this.waitForRelease(task);
      const cached = this.loaded.get(taskKey(task));
      if (cached) {
        if (cached.activeTurnId || verified) return cached;
        // The native owner may unload an idle task without closing this App
        // Server connection. A stale local cache then makes turn/start fail
        // with -32600 even though thread/read and a fresh resume both work.
        const read = await this.rpc.request("thread/read", { threadId: task.threadId, includeTurns: false });
        const thread = isObject(read.thread) && read.thread.id === task.threadId ? read.thread : null;
        if (!thread || !isObject(thread.status)) throw new AppServerUnavailableError();
        if (thread.status.type !== "notLoaded") return cached;
        this.forget(task);
        this.retireQuestion(task.threadId, new Error("Task unloaded"));
      }
      const result = await this.resumeNative(task);
      return this.loaded.get(taskKey(task)) ?? this.acceptResumedTask(task, result);
    } catch (error) { throw operationError(error, "подключение к задаче"); }
  }

  /** A stream and a VK command must never resume the same task twice. A
   * second resume may abort a turn that the first request just started. */
  private async resumeNative(task: TaskRef): Promise<JsonObject> {
    const key = taskKey(task);
    const pending = this.resuming.get(key);
    if (pending) return pending;
    const work = this.rpc.request("thread/resume", {
      threadId: task.threadId, excludeTurns: true,
      initialTurnsPage: { limit: 20, sortDirection: "desc", itemsView: "full" },
    }, { timeoutMs: 180_000 }).then(result => {
      this.acceptResumedTask(task, result);
      return result;
    });
    this.resuming.set(key, work);
    try { return await work; }
    finally { if (this.resuming.get(key) === work) this.resuming.delete(key); }
  }

  /** A stream starting after a VK command already loaded the task uses reads
   * on that writer instead of resuming again and interrupting its new turn. */
  async resumeForStream(task: TaskRef): Promise<JsonObject> {
    await this.waitForRelease(task);
    const key = taskKey(task);
    const pending = this.resuming.get(key);
    if (pending) return pending;
    const loaded = this.loaded.get(key);
    if (!loaded) return this.resumeNative(task);
    const [read, turns] = await Promise.all([
      this.rpc.request("thread/read", { threadId: task.threadId, includeTurns: false }, { timeoutMs: 120_000 }),
      this.rpc.request("thread/turns/list", { threadId: task.threadId, limit: 20, sortDirection: "desc", itemsView: "full" }, { timeoutMs: 120_000 }),
    ]);
    if (!isObject(read.thread) || read.thread.id !== task.threadId || !Array.isArray(turns.data)) throw new AppServerUnavailableError();
    // turn/start can be acknowledged before thread/read and turns/list expose
    // its active state. Keep that accepted ID visible to the new observer.
    const activeId = this.loaded.get(key)?.activeTurnId;
    const active = activeId ? turns.data.find(turn => isObject(turn) && turn.id === activeId) : null;
    const inProgress = !!activeId && (!isObject(active) || active.status === "inProgress");
    const thread = inProgress ? { ...read.thread, status: { type: "active" } } : read.thread;
    const page = inProgress && !active
      ? { ...turns, data: [{ id: activeId, status: "inProgress", startedAt: Date.now() / 1_000, items: [] }, ...turns.data] }
      : turns;
    return { thread, initialTurnsPage: page, model: loaded.model, reasoningEffort: loaded.effort, cwd: read.thread.cwd };
  }

  private observe(notification: AppServerEnvelope): void {
    const threadId = idOf(notification.params.threadId);
    if (!threadId) return;
    if (notification.method === "thread/archived" || notification.method === "thread/closed" || notification.method === "thread/deleted") {
      this.releaseArchive(threadId);
      this.retireQuestion(threadId, new Error("Task closed"));
      for (const key of this.loaded.keys()) {
        try { if ((JSON.parse(key) as unknown[])[1] === threadId) this.loaded.delete(key); } catch { /* Ignore malformed private cache keys. */ }
      }
    }
    const entries = [...this.loaded.entries()].filter(([key]) => {
      try { return (JSON.parse(key) as unknown[])[1] === threadId; } catch { return false; }
    });
    for (const [key, loaded] of entries) {
      if (notification.method === "turn/started" && isObject(notification.params.turn)) {
        const turnId = idOf(notification.params.turn.id);
        if (turnId) this.loaded.set(key, { ...loaded, activeTurnId: turnId });
      } else if (notification.method === "turn/completed") this.loaded.set(key, { ...loaded, activeTurnId: null });
    }
  }

  private serverRequest(request: AppServerEnvelope): Promise<JsonObject> {
    if (request.method !== "item/tool/requestUserInput") return Promise.reject(new Error("Unsupported server request"));
    const threadId = idOf(request.params.threadId); const turnId = idOf(request.params.turnId); const itemId = idOf(request.params.itemId);
    if (!threadId || !turnId || !itemId || !Array.isArray(request.params.questions) || !request.params.questions.length) {
      return Promise.reject(new Error("Malformed question"));
    }
    const questions: CodexQuestion[] = [];
    for (const value of request.params.questions) {
      if (!isObject(value) || !idOf(value.id) || typeof value.question !== "string" || !value.question.trim()) return Promise.reject(new Error("Malformed question"));
      const options = Array.isArray(value.options) ? value.options.map(option => isObject(option) && typeof option.label === "string"
        ? { label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) } : null).filter((option): option is NonNullable<typeof option> => !!option) : [];
      questions.push({ id: String(value.id), title: value.question, options, secret: value.isSecret === true });
    }
    const body = { kind: request.params.isBlocking === false ? "async" as const : "blocking" as const,
      key: JSON.stringify(["app-server", threadId, turnId, itemId]), turnId, questions };
    const question = { ...body, fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    const key = threadId;
    const previous = this.questions.get(key);
    previous?.reject(new Error("Question replaced"));
    return new Promise((resolve, reject) => {
      this.questions.set(key, { question, resolve, reject }); this.notifyQuestions(key);
    });
  }

  private notifyQuestions(threadId: string): void {
    for (const listener of this.questionListeners) {
      try { listener(threadId); } catch { /* A display failure cannot reject or orphan a native question. */ }
    }
  }

  private retireQuestion(threadId: string, error: Error): void {
    const pending = this.questions.get(threadId);
    if (!pending) return;
    this.questions.delete(threadId);
    pending.reject(error);
    this.notifyQuestions(threadId);
  }

  private connectionLost(error: Error): void {
    this.loaded.clear();
    this.uncertainReleases.clear();
    for (const threadId of this.questions.keys()) this.retireQuestion(threadId, error);
  }

  close(): void {
    this.unsubscribe(); this.unsubscribeDisconnect(); this.rpc.onServerRequest(null);
    for (const pending of this.questions.values()) pending.reject(new Error("Executor closed"));
    this.questions.clear(); this.loaded.clear(); this.uncertainReleases.clear(); this.archiving.clear(); this.archiveGroups.clear(); this.questionListeners.clear();
  }
}
