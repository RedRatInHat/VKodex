import { randomUUID } from "node:crypto";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, sameTask, type DesktopProject, type DesktopTask, type DesktopTasks } from "../desktop/contracts.js";
import type { Binding, BridgeChat, BridgeInput, Button, ManagerAction, OwnerAccess, TaskListFilter, View } from "./contracts.js";
import { taskChatTitle } from "./contracts.js";
import { AccessGate } from "./delivery.js";
import { BridgeStore } from "./store.js";
import { TaskPanels } from "./panels.js";

function shortTitle(title: string, maxLength: number): string {
  const text = title.replace(/\s+/gu, " ").trim() || "Без названия";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export class TaskManager {
  private tail: Promise<void> = Promise.resolve();
  readonly panels: TaskPanels;

  constructor(
    private readonly access: OwnerAccess,
    private readonly desktop: DesktopTasks,
    private readonly chat: BridgeChat,
    private readonly store: BridgeStore,
    private readonly gate: AccessGate,
  ) { this.panels = new TaskPanels(access, desktop, chat, store, gate); }

  handle(input: BridgeInput): Promise<void> {
    // A single owner has one durable wizard; serialize updates, including callback clicks.
    const work = this.tail.then(() => this.dispatch(input));
    this.tail = work.catch(() => {});
    return work;
  }

  async idle(): Promise<void> { await this.tail; }

  private reply(input: BridgeInput, view: View): void {
    this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, this.access.ownerId, view);
  }

  private async dispatch(input: BridgeInput): Promise<void> {
    if (input.senderId !== this.access.ownerId) return;
    const managerPeer = input.peerId === this.access.ownerId;
    if (!managerPeer && !await this.gate.check(input.peerId)) return;
    const inboxKey = JSON.stringify([input.peerId, input.eventId]);
    if (!this.store.claimInput(inboxKey)) return;
    let panelAction = false;
    try {
      if (input.hasAttachments) throw new ActionRejectedError("Передача вложений в десктоп ещё не подключена. Сообщение не отправлено; пришли текст отдельно.");
      if (input.action) {
        const action = this.store.scopedAction(input.action, input.peerId, managerPeer);
        if (!action) throw new ActionRejectedError("Кнопка устарела или относится к другой беседе. Открой /menu заново.");
        if (action.type === "panel") { panelAction = true; await this.panels.action(input, action); }
        else if (managerPeer) await this.handleAction(input, action);
        else throw new ActionRejectedError("Эта кнопка доступна только в менеджере.");
      } else if (!await this.panels.text(input)) {
        if (managerPeer) await this.handleManager(input);
        else await this.handleTask(input);
      }
      this.store.finishInput(inboxKey);
    } catch (error) {
      this.store.finishInput(inboxKey, !(error instanceof ActionRejectedError));
      if (panelAction) this.panels.failure(input.peerId, error);
      this.reply(input, { text: error instanceof ActionRejectedError || error instanceof DesktopUnavailableError || error instanceof UncertainActionError
        ? error.message : "Операция не завершена. Проверь подключение к Codex; автоматического повтора команды не будет." });
    }
  }

  private async handleManager(input: BridgeInput): Promise<void> {
    const text = input.text.trim();
    if (["/start", "/help", "/list"].includes(text)) { await this.chooseProject(input, 0); return; }
    if (text === "/new") { await this.newTask(input); return; }
    if (text === "/cancel") { this.cancel(input); return; }
    const draft = this.store.getDraft();
    if (draft?.stage === "title") {
      if (!text || text.length > 120) throw new ActionRejectedError("Введи название задачи длиной от 1 до 120 символов.");
      this.store.saveDraft({ ...draft, stage: "prompt", title: text });
      this.reply(input, { text: "Теперь отправь стартовый промпт.", buttons: [this.button("Отмена", { type: "cancel" })] });
      return;
    }
    if (draft?.stage === "prompt") {
      if (!text || text.length > 16_000) throw new ActionRejectedError("Стартовый промпт должен содержать от 1 до 16000 символов.");
      this.store.saveDraft({ ...draft, stage: "confirm", prompt: text });
      this.reply(input, { text: `Проект: ${draft.projectTitle}\nНазвание: ${draft.title}\n\n${text.slice(0, 2_000)}${text.length > 2_000 ? "\n… (промпт сохранён полностью)" : ""}`,
        buttons: [this.button("Создать", { type: "create", draftId: draft.id }), this.button("Отмена", { type: "cancel" })] });
      return;
    }
    this.reply(input, { text: "Это менеджер задач. /menu — меню и состояние моста, /list — задачи по проектам, /new — новая задача, /cancel — отмена ввода." });
  }

  private button(label: string, action: ManagerAction): Button { return { label: label.slice(0, 40), action: this.store.action(action, Date.now(), this.access.ownerId) }; }

  private async handleAction(input: BridgeInput, action: ManagerAction): Promise<void> {
    switch (action.type) {
      case "panel": await this.panels.action(input, action); break;
      case "browseProjects": await this.chooseProject(input, action.page); break;
      case "list":
        if (action.filter) await this.list(input, action.page, action.filter);
        else await this.chooseProject(input, 0); // Buttons from earlier versions also ask for a project.
        break;
      case "open": {
        // Re-read the catalog: titles and task availability may have changed since this button was rendered.
        const task = (await this.desktop.listTasks()).find(task => sameTask(task, action.task));
        if (!task) throw new ActionRejectedError("Задача больше не доступна в каталоге. Обнови список.");
        await this.open(input, task);
        break;
      }
      case "new": await this.newTask(input); break;
      case "project": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "project") throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        const project = (await this.desktop.listProjects()).find(project => project.id === action.id);
        if (!project) throw new ActionRejectedError("Проект больше не доступен.");
        this.store.saveDraft({ ...draft, stage: "title", projectId: project.id, projectTitle: project.title });
        this.reply(input, { text: `Проект: ${project.title}\nКак назвать задачу?`, buttons: [this.button("Отмена", { type: "cancel" })] });
        break;
      }
      case "create": await this.create(input, action.draftId); break;
      case "cancel": this.cancel(input); break;
      case "detach": {
        this.store.stopStreaming(action.bindingId);
        this.reply(input, { text: "Трансляция отключена. Задача Codex продолжает работать и не архивирована." });
        break;
      }
      case "resume": {
        const binding = this.store.getBinding(action.bindingId);
        if (!binding || binding.peerId === null) throw new ActionRejectedError("Связанная беседа не найдена.");
        const generation = this.store.streamGeneration(binding.id);
        if (!await this.gate.verifyMembers(binding.peerId, binding.id)) throw new ActionRejectedError("Беседа пока не прошла проверку участников.");
        if (generation !== this.store.streamGeneration(binding.id)) throw new ActionRejectedError("Трансляция отключена во время проверки. Подключи задачу заново после возвращения в беседу.");
        this.store.setPaused(binding.id, false);
        this.store.setAttached(binding.id, true);
        this.reply(input, { text: "Трансляция возобновлена." });
        break;
      }
    }
  }

  private async chooseProject(input: BridgeInput, page: number): Promise<void> {
    const tasks = await this.desktop.listTasks();
    let projects: readonly DesktopProject[] = [];
    const warnings = [...(this.desktop.catalogWarnings?.() ?? [])];
    try { projects = await this.desktop.listProjects(); }
    catch { warnings.push("Список проектов недоступен. Все найденные задачи можно открыть через «Все подряд»."); }
    const start = Math.max(0, Math.min(Math.floor(page), Math.max(0, Math.ceil(projects.length / 6) - 1))) * 6;
    const visible = projects.slice(start, start + 6);
    const unassigned = tasks.filter(task => task.projectId === null).length;
    const knownProjects = new Set(projects.map(project => project.id));
    const unknown = tasks.filter(task => task.projectId !== null && (!task.projectId || !knownProjects.has(task.projectId))).length;
    if (unknown) warnings.push(`Для ${unknown} задач проект не определён или недоступен. Они видны в «Все подряд».`);
    const counts = new Map<string, number>();
    for (const task of tasks) if (task.projectId) counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
    const buttons = visible.map((project, i) => this.button(shortTitle(`${start + i + 1}. ${project.title}`, 40), { type: "list", page: 0, filter: { kind: "project", projectId: project.id } }));
    buttons.push(this.button("Без проекта", { type: "list", page: 0, filter: { kind: "unassigned" } }), this.button("Все подряд", { type: "list", page: 0, filter: { kind: "all" } }));
    if (start > 0) buttons.push(this.button("Назад", { type: "browseProjects", page: start / 6 - 1 }));
    if (start + 6 < projects.length) buttons.push(this.button("Далее", { type: "browseProjects", page: start / 6 + 1 }));
    buttons.push(this.button("Обновить", { type: "browseProjects", page: start / 6 }));
    const lines = ["В каком проекте показать задачи?", "",
      ...visible.map((project, i) => `${start + i + 1}. ${shortTitle(project.title, 120)} · ${counts.get(project.id) ?? 0}`),
      ...(projects.length > 6 ? ["", `Проекты · ${start + 1}–${start + visible.length} из ${projects.length}`] : []),
      "", `Без проекта · ${unassigned}`, `Все подряд · ${tasks.length}`,
      ...(warnings.length ? ["", ...warnings] : [])];
    this.reply(input, { text: lines.join("\n"), buttons });
  }

  private async list(input: BridgeInput, page: number, filter: TaskListFilter): Promise<void> {
    const catalog = await this.desktop.listTasks();
    let tasks = catalog;
    let heading = "Все подряд";
    if (filter.kind === "project") {
      const project = (await this.desktop.listProjects()).find(project => project.id === filter.projectId);
      if (!project) throw new ActionRejectedError("Проект больше не доступен. Открой /list и выбери другой.");
      heading = `Проект: ${shortTitle(project.title, 120)}`;
      tasks = catalog.filter(task => task.projectId === project.id);
    } else if (filter.kind === "unassigned") {
      heading = "Без проекта";
      tasks = catalog.filter(task => task.projectId === null);
    }
    const start = Math.max(0, Math.min(Math.floor(page), Math.max(0, Math.ceil(tasks.length / 6) - 1))) * 6;
    const visible = tasks.slice(start, start + 6);
    const buttons = visible.map(task => this.button(shortTitle(task.sourceLabel ? `${task.sourceLabel} · ${task.title}` : task.title, 40), { type: "open", task }));
    if (start > 0) buttons.push(this.button("Назад", { type: "list", page: start / 6 - 1, filter }));
    if (start + 6 < tasks.length) buttons.push(this.button("Далее", { type: "list", page: start / 6 + 1, filter }));
    buttons.push(this.button("Выбрать проект", { type: "browseProjects", page: 0 }), this.button("Обновить", { type: "list", page: start / 6, filter }));
    buttons.push(this.button("Новая задача", { type: "new" }));
    const warnings = this.desktop.catalogWarnings?.() ?? [];
    const body = visible.length ? `Задачи Codex · ${start + 1}–${start + visible.length} из ${tasks.length}\n\n${visible.map((task, i) => `${start + i + 1}. ${shortTitle(task.title, 120)}${task.sourceLabel ? `\nКаталог: ${task.sourceLabel}` : ""}`).join("\n\n")}` : "В этом списке нет задач.";
    this.reply(input, { text: `${heading}\n\n${body}${warnings.length ? `\n\n${warnings.join("\n")}` : ""}`, buttons });
  }

  private cancel(input: BridgeInput): void {
    const draft = this.store.getDraft();
    if (draft?.stage === "creating" || draft?.stage === "uncertain") throw new ActionRejectedError("Создание уже отправлено в Codex. Сначала проверь результат в десктопе; повторное создание заблокировано.");
    this.store.saveDraft(null);
    this.reply(input, { text: "Ввод новой задачи отменён." });
  }

  private async newTask(input: BridgeInput): Promise<void> {
    if (!this.desktop.capabilities.createTask) throw new ActionRejectedError("Создание задач через этот адаптер десктопа ещё не подтверждено. Существующие задачи доступны через /list.");
    const draft = this.store.getDraft();
    if (draft && !["created", "project"].includes(draft.stage)) throw new ActionRejectedError("Сначала заверши текущий ввод или отправь /cancel.");
    const projects = await this.desktop.listProjects();
    if (projects.length === 0) throw new ActionRejectedError("В Codex нет доступных проектов.");
    this.store.saveDraft({ id: randomUUID(), stage: "project" });
    this.reply(input, { text: "В каком проекте создать задачу?", buttons: projects.slice(0, 8).map(project => this.button(project.title, { type: "project", id: project.id, title: project.title })).concat(this.button("Отмена", { type: "cancel" })) });
  }

  private async create(input: BridgeInput, draftId: string): Promise<void> {
    const existing = this.store.getDraft();
    if (existing?.id === draftId && existing.stage === "created" && existing.task) { await this.open(input, existing.task); return; }
    const draft = this.store.claimDraft(draftId);
    if (!draft || !draft.projectId || !draft.title || !draft.prompt) throw new ActionRejectedError("Создание уже выполнено, ожидает проверки или эта кнопка устарела.");
    if (!this.desktop.capabilities.createTask) {
      this.store.saveDraft({ ...draft, stage: "confirm" });
      throw new ActionRejectedError("Создание задач недоступно в текущем подключении.");
    }
    let task: DesktopTask;
    try {
      task = await this.desktop.createTask({ operationId: draft.id, projectId: draft.projectId, title: draft.title, prompt: draft.prompt, ...(draft.model ? { model: draft.model } : {}) });
    } catch (error) {
      this.store.saveDraft({ ...draft, stage: error instanceof ActionRejectedError ? "confirm" : "uncertain" });
      throw error instanceof ActionRejectedError ? error : new UncertainActionError();
    }
    // Commit the Codex result before attempting the non-idempotent VK operation.
    this.store.saveDraft({ ...draft, stage: "created", task });
    await this.open(input, task);
  }

  private async open(input: BridgeInput, task: DesktopTask): Promise<void> {
    let binding = this.store.ensureBinding(task);
    if (binding.chatState === "planned" && this.store.claimChat(binding.id)) {
      try {
        const created = await this.chat.createConversation(taskChatTitle(task.title));
        if (!Number.isSafeInteger(created.peerId) || !Number.isSafeInteger(created.chatId) || created.chatId <= 0 || created.peerId !== 2_000_000_000 + created.chatId) throw new Error("Invalid VK conversation");
        this.store.setChat(binding.id, created.peerId, created.chatId);
      } catch (error) {
        this.store.setChatState(binding.id, error instanceof ActionRejectedError ? "planned" : "uncertain");
        throw error instanceof ActionRejectedError ? error : new UncertainActionError();
      }
      binding = this.store.getBinding(binding.id)!;
    }
    if (binding.chatState !== "ready" || binding.peerId === null) throw new UncertainActionError();
    const generation = this.store.streamGeneration(binding.id);
    const membership = await this.gate.inspectMembers(binding.peerId);
    if (generation !== this.store.streamGeneration(binding.id)) throw new ActionRejectedError("Трансляция отключена во время проверки. Подключи задачу заново после возвращения в беседу.");
    if (membership === "owner_missing") {
      // VK can create a community chat without adding the requested user.
      // Send the invitation privately and keep task output paused until an explicit recheck.
      this.store.setPaused(binding.id, true);
      const url = await this.chat.inviteLink(binding.peerId);
      this.reply(input, { text: `${task.title}\nVK создал беседу, но не добавил тебя автоматически. Вступи по ссылке и нажми «Я вступил». До проверки участников трансляция выключена.\n${url}`,
        buttons: [this.button("Я вступил", { type: "resume", bindingId: binding.id }), this.button("Отключить", { type: "detach", bindingId: binding.id })] });
      return;
    }
    if (binding.paused) {
      this.reply(input, { text: "Трансляция приостановлена. Проверь участников беседы перед возобновлением.", buttons: [this.button("Возобновить", { type: "resume", bindingId: binding.id })] });
      return;
    }
    this.store.setAttached(binding.id, true);
    if (!await this.gate.check(binding.peerId)) throw new ActionRejectedError("Трансляция приостановлена после проверки участников.");
    const url = await this.chat.inviteLink(binding.peerId);
    this.reply(input, { text: `${task.title}\n${url}`, buttons: [this.button("Отключить трансляцию", { type: "detach", bindingId: binding.id })] });
  }

  private async handleTask(input: BridgeInput): Promise<void> {
    const binding: Binding | null = this.store.byPeer(input.peerId);
    if (!binding || input.action) return;
    const text = input.text.trim();
    if (text === "/detach") {
      this.store.stopStreaming(binding.id);
      this.reply(input, { text: "Трансляция отключена; задача Codex продолжает работать." });
      return;
    }
    if (text === "/stop") {
      if (!this.desktop.capabilities.interruptTurn) throw new ActionRejectedError("Остановка через текущий адаптер ещё не подтверждена. Останови ход в десктопе.");
      await this.desktop.interrupt(binding);
      this.reply(input, { text: "Запрос остановки передан в Codex." });
      return;
    }
    if (!text) throw new ActionRejectedError("Пришли текст для этой задачи.");
    if (text.startsWith("/")) throw new ActionRejectedError("В беседе задачи доступны /menu, /status, /stop и /detach. Менеджер находится в личном диалоге с ботом.");
    const operationId = randomUUID();
    this.store.recordOperation(operationId, binding);
    try {
      await this.desktop.submit({ task: binding, operationId, text });
      this.store.finishOperation(operationId, false);
    } catch (error) {
      this.store.finishOperation(operationId, true);
      throw error;
    }
  }
}
