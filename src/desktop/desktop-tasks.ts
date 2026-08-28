import { ActionRejectedError, UncertainActionError, sameTask, type CreateTaskRequest, type DesktopMetadata, type DesktopTasks, type SubmitTaskRequest, type TaskRef } from "./contracts.js";
import { LocalDesktopCatalog } from "./catalog.js";
import { DesktopIpcClient, isObject, type IpcObject } from "./ipc-client.js";
import { TaskSubscription } from "./subscription.js";
import { taskDetails } from "./details.js";

function submissionMode(state: IpcObject): "start" | "steer" {
  const turns: unknown[] = Array.isArray(state.turns) ? [...state.turns] : [];
  const history = isObject(state.turnHistory) ? state.turnHistory.history : undefined;
  const entities = isObject(history) ? history.entitiesByKey : undefined;
  if (isObject(entities)) turns.push(...Object.values(entities));
  // A starting turn can still have a null turnId. The owner can wait for its ID
  // when steering; treating that placeholder as idle would start a second turn.
  if (turns.some(turn => isObject(turn) && turn.status === "inProgress")) return "steer";
  const runtimeStatus = isObject(state.threadRuntimeStatus) ? state.threadRuntimeStatus.type : undefined;
  if ((state.resumeState !== undefined && state.resumeState !== "resumed") || (runtimeStatus !== undefined && runtimeStatus !== "idle")) {
    throw new ActionRejectedError("Десктоп ещё не подтвердил готовность задачи к следующему ходу. Сообщение не отправлено; повтори после восстановления состояния.");
  }
  if (Array.isArray(state.requests) && state.requests.length > 0) {
    throw new ActionRejectedError("В задаче осталось подтверждение или вопрос. Сначала ответь на него в Codex; сообщение не отправлено.");
  }
  if (runtimeStatus !== "idle" && !turns.some(turn => isObject(turn) && ["completed", "failed", "interrupted"].includes(String(turn.status)))) {
    throw new ActionRejectedError("Не удалось определить состояние задачи. Сообщение не отправлено; открой задачу в Codex и повтори.");
  }
  return "start";
}

export class ConnectedDesktopTasks implements DesktopTasks {
  get capabilities() {
    return { createTask: false, startTurn: true, steerTurn: true, interruptTurn: false, selectModel: !!this.catalog.listModels,
      renameTask: !!this.metadata, archiveTask: !!this.metadata, exportMarkdown: !!this.metadata };
  }

  constructor(
    private readonly catalog: Pick<LocalDesktopCatalog, "listTasks" | "listProjects"> & Partial<Pick<LocalDesktopCatalog, "listModels">> & { catalogWarnings?: () => readonly string[] },
    private readonly createClient: () => DesktopIpcClient = () => new DesktopIpcClient(),
    private readonly metadata?: DesktopMetadata,
  ) {}

  listTasks() { return this.catalog.listTasks(); }
  listProjects() { return this.catalog.listProjects(); }
  catalogWarnings() { return this.catalog.catalogWarnings?.() ?? []; }

  async listModels(task?: TaskRef) {
    if (!this.catalog.listModels) throw new ActionRejectedError("Список моделей недоступен в этом подключении.");
    return this.catalog.listModels(task);
  }

  private async follow<T>(task: TaskRef, work: (subscription: TaskSubscription, client: DesktopIpcClient) => Promise<T>): Promise<T> {
    const resolved = (await this.listTasks()).find(candidate => sameTask(candidate, task));
    if (!resolved) throw new ActionRejectedError("Задача не найдена в настроенных каталогах Codex.");
    const client = this.createClient();
    const subscription = new TaskSubscription(client, resolved, () => {}, () => {});
    try {
      await subscription.start();
      if (!subscription.current || !subscription.owner) throw new ActionRejectedError("Не удалось подключиться к задаче.");
      return await work(subscription, client);
    } finally { subscription.close(); client.close(); }
  }

  inspectTask(task: TaskRef) { return this.follow(task, async subscription => taskDetails(subscription.current!)); }

  async selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    const available = (await this.listModels(task)).find(item => item.id === model);
    if (!available?.efforts.includes(effort)) throw new ActionRejectedError("Модель или уровень рассуждения больше не доступны. Обнови меню моделей.");
    await this.follow(task, async (subscription, client) => {
      const reply = await client.request("thread-follower-update-thread-settings", 1, {
        conversationId: task.threadId, threadSettings: { model, effort },
      }, { targetClientId: subscription.owner!, timeoutMs: 30_000, mutating: true });
      if (!isObject(reply.result) || reply.result.ok !== true) throw new UncertainActionError();
      const deadline = Date.now() + 3_000;
      do {
        const current = subscription.current && taskDetails(subscription.current);
        if (current?.nextModel === model && current.nextEffort === effort) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new UncertainActionError();
    });
  }

  async renameTask(task: TaskRef, title: string) {
    const name = title.trim();
    if (!name || name.length > 120 || /[\r\n\x00-\x1f]/u.test(name)) throw new ActionRejectedError("Название должно быть одной строкой от 1 до 120 символов.");
    if (!this.metadata) throw new ActionRejectedError("Переименование недоступно в этом подключении.");
    return this.follow(task, async subscription => {
      await this.metadata!.rename(task, name);
      let saved = false;
      try { saved = (await this.listTasks()).some(candidate => sameTask(candidate, task) && candidate.title === name); }
      catch { /* A failed read cannot confirm or undo the metadata write. */ }
      if (!saved) throw new UncertainActionError();
      // A separate app-server updates the catalog but does not notify the live
      // desktop's title cache. Do not mistake persistence for a visible update.
      return { liveTitleUpdated: subscription.current?.title === name };
    });
  }

  async archiveTask(task: TaskRef): Promise<void> {
    if (!this.metadata) throw new ActionRejectedError("Архивирование недоступно в этом подключении.");
    await this.follow(task, async subscription => {
      // Do not stop an active turn or answer outstanding requests as a side effect.
      if (submissionMode(subscription.current!) !== "start") throw new ActionRejectedError("Сначала дождись завершения хода или останови его в Codex.");
      await this.metadata!.archive(task);
    });
    if ((await this.listTasks()).some(candidate => sameTask(candidate, task))) throw new UncertainActionError();
  }

  async exportMarkdown(task: TaskRef): Promise<string> {
    if (!this.metadata) throw new ActionRejectedError("Экспорт недоступен в этом подключении.");
    return this.follow(task, async () => this.metadata!.markdown(task));
  }

  async createTask(_request: CreateTaskRequest): Promise<never> {
    throw new ActionRejectedError("Создание задач через десктоп ещё не подтверждено.");
  }

  async interrupt(_task: TaskRef): Promise<never> {
    throw new ActionRejectedError("Остановка через десктоп ещё не подтверждена.");
  }

  async submit(request: SubmitTaskRequest): Promise<void> {
    const text = request.text.trim();
    if (!text || text.length > 16_000) throw new ActionRejectedError("Допустим текст длиной от 1 до 16000 символов.");
    const task = (await this.listTasks()).find(task => sameTask(task, request.task));
    if (!task) throw new ActionRejectedError("Задача не найдена в каталоге Codex.");
    // Subscription ownership is per IPC client. Closing a temporary follower on the
    // shared event client would also unsubscribe the long-lived mirror.
    const client = this.createClient();
    const subscription = new TaskSubscription(client, task, () => {}, () => {});
    try {
      await subscription.start();
      const state = subscription.current;
      if (!state || !subscription.owner) throw new ActionRejectedError("Не удалось подключиться к задаче.");
      if (submissionMode(state) === "start") {
        const reply = await client.request("thread-follower-start-turn", 2, {
          conversationId: task.threadId,
          turnStart: {
            request: { threadId: task.threadId, clientUserMessageId: request.operationId, input: [{ type: "text", text, text_elements: [] }] },
            context: { inheritThreadSettings: true },
          },
        }, { targetClientId: subscription.owner, timeoutMs: 30_000, mutating: true });
        const result = isObject(reply.result) && isObject(reply.result.result) ? reply.result.result : null;
        if (!isObject(result?.turn) || typeof result.turn.id !== "string" || !result.turn.id) throw new UncertainActionError();
        return;
      }
      const reply = await client.request("thread-follower-steer-turn", 1, {
        conversationId: task.threadId,
        clientUserMessageId: request.operationId,
        input: [{ type: "text", text, text_elements: [] }],
        attachments: [],
        restoreMessage: {
          id: request.operationId, text, createdAt: Date.now(),
          context: { prompt: text, addedFiles: [], fileAttachments: [], imageAttachments: [], commentAttachments: [], ideContext: null },
        },
      }, { targetClientId: subscription.owner, timeoutMs: 30_000, mutating: true });
      if (!isObject(reply.result) || !isObject(reply.result.result) || typeof reply.result.result.turnId !== "string" || !reply.result.result.turnId) throw new UncertainActionError();
    } finally { subscription.close(); client.close(); }
  }
}
