import { createHash } from "node:crypto";
import type { CodexQuestion, CodexQuestions } from "../core/codex-questions.js";
import { ActionRejectedError, UncertainActionError, taskKey,
  type SubmitTaskReceipt, type SubmitTaskRequest, type TaskRef } from "../core/codex-tasks.js";
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

const operationError = (error: unknown): Error => error instanceof AppServerUncertainError ? new UncertainActionError()
  : error instanceof AppServerRejectedError ? new ActionRejectedError("Codex отклонил команду. Состояние задачи не изменено.")
  : error instanceof AppServerUnavailableError ? new ActionRejectedError("Владелец задачи Codex недоступен. Команда не отправлена.")
  : error instanceof Error ? error : new ActionRejectedError("Codex не выполнил команду.");

function idOf(value: unknown): string | null { return typeof value === "string" && value ? value : null; }

/** Command-side prototype for a VKodex-owned, profile-scoped App Server. */
export class AppServerTaskExecutor {
  private readonly loaded = new Map<string, LoadedTask>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly questionListeners = new Set<(threadId: string) => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly rpc: AppServerRpc) {
    this.unsubscribe = rpc.onNotification(notification => this.observe(notification));
    rpc.onServerRequest(request => this.serverRequest(request));
  }

  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    const prepared = taskInput(request);
    const loaded = await this.resume(request.task);
    if (this.questions.has(request.task.threadId)) throw new ActionRejectedError("В задаче открыт вопрос Codex. Сначала ответь на него; сообщение не отправлено.");
    await request.beforeSend?.();
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
    } catch (error) { throw operationError(error); }
  }

  async interrupt(task: TaskRef): Promise<void> {
    const loaded = await this.resume(task);
    if (!loaded.activeTurnId) throw new ActionRejectedError("У задачи нет активного хода.");
    try {
      await this.rpc.request("turn/interrupt", { threadId: task.threadId, turnId: loaded.activeTurnId }, { mutating: true });
    } catch (error) { throw operationError(error); }
  }

  async queue(request: SubmitTaskRequest): Promise<string> {
    const prepared = taskInput(request);
    await this.resume(request.task);
    await request.beforeSend?.();
    try {
      const result = await this.rpc.request("thread/queue/add", {
        threadId: request.task.threadId, clientUserMessageId: request.operationId, input: [...prepared.input],
      }, { mutating: true });
      const id = isObject(result.queuedSubmission) ? idOf(result.queuedSubmission.id) : null;
      if (!id) throw new UncertainActionError();
      return id;
    } catch (error) { throw operationError(error); }
  }

  async selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    if (!model || !effort) throw new ActionRejectedError("Модель и уровень рассуждения обязательны.");
    await this.resume(task);
    try {
      await this.rpc.request("thread/settings/update", { threadId: task.threadId, model, effort }, { mutating: true });
      const loaded = this.loaded.get(taskKey(task));
      if (loaded) this.loaded.set(taskKey(task), { ...loaded, model, effort });
    } catch (error) { throw operationError(error); }
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
    const key = task.threadId; const pending = this.questions.get(key);
    if (!pending || pending.question.fingerprint !== question.fingerprint) throw new ActionRejectedError("Вопрос уже закрыт или изменился.");
    const result: Record<string, { answers: string[] }> = {};
    for (const item of question.questions) {
      const answer = answers[item.id];
      if (!answer) throw new ActionRejectedError("Ответь на все вопросы Codex.");
      result[item.id] = { answers: [answer] };
    }
    await beforeSend();
    this.questions.delete(key);
    this.notifyQuestions(key);
    pending.resolve({ answers: result });
  }

  private async resume(task: TaskRef): Promise<LoadedTask> {
    try {
      const result = await this.rpc.request("thread/resume", {
        threadId: task.threadId, excludeTurns: true,
        initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
      });
      if (!isObject(result.thread) || result.thread.id !== task.threadId) throw new AppServerUnavailableError();
      const page = isObject(result.initialTurnsPage) && Array.isArray(result.initialTurnsPage.data) ? result.initialTurnsPage.data : [];
      const active = page.find(turn => isObject(turn) && turn.status === "inProgress");
      const loaded = {
        activeTurnId: isObject(active) ? idOf(active.id) : null,
        model: idOf(result.model), effort: idOf(result.reasoningEffort),
      };
      this.loaded.set(taskKey(task), loaded);
      return loaded;
    } catch (error) { throw operationError(error); }
  }

  private observe(notification: AppServerEnvelope): void {
    const threadId = idOf(notification.params.threadId);
    if (!threadId) return;
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
    for (const listener of this.questionListeners) listener(threadId);
  }

  close(): void {
    this.unsubscribe(); this.rpc.onServerRequest(null);
    for (const pending of this.questions.values()) pending.reject(new Error("Executor closed"));
    this.questions.clear(); this.loaded.clear(); this.questionListeners.clear();
  }
}
