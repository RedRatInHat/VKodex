import { randomUUID } from "node:crypto";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, sameTask, type DesktopProject, type DesktopTask, type DesktopTasks } from "../desktop/contracts.js";
import type { Binding, BridgeChat, BridgeHealthSnapshot, BridgeInput, Button, ManagerAction, OwnerAccess, TaskListFilter, View } from "./contracts.js";
import { MENU_BUTTON, taskChatTitle } from "./contracts.js";
import { AccessGate } from "./delivery.js";
import { BridgeStore } from "./store.js";
import { TaskPanels } from "./panels.js";
import { TaskFiles } from "./files.js";

// Leave room for both page arrows, the two special scopes and refresh.
const PROJECT_PAGE_SIZE = 5;

const managerHelp = [
  "VKodex · команды менеджера",
  "",
  "/menu, /start, /status — меню и состояние моста",
  "/help — эта справка",
  "/health — полная проверка моста",
  "/limits — лимиты аккаунта Codex",
  "/list — задачи по проектам",
  "/new — создать новую задачу",
  "/cancel — отменить мастер создания",
  "",
  "Остальные действия доступны кнопками меню.",
].join("\n");

const taskHelp = [
  "VKodex · команды задачи",
  "",
  "/menu, /status — карточка задачи",
  "/help — эта справка",
  "/limits — лимиты аккаунта Codex",
  "/goal — цель задачи, бюджет и управление продолжением",
  "/files — проверить готовые исходящие файлы",
  "/stop — остановить текущий ход",
  "/detach — отключить трансляцию, не останавливая задачу",
  "",
  "Обычный текст, фотографии и документы продолжают эту задачу.",
].join("\n");

const unknownCommand = (help: string): string => `Команда не найдена.\n\n${help}`;

function shortTitle(title: string, maxLength: number): string {
  const text = title.replace(/\s+/gu, " ").trim() || "Без названия";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export class TaskManager {
  private readonly tails = new Map<number, Promise<void>>();
  readonly panels: TaskPanels;

  constructor(
    private readonly access: OwnerAccess,
    private readonly desktop: DesktopTasks,
    private readonly chat: BridgeChat,
    private readonly store: BridgeStore,
    private readonly gate: AccessGate,
    private readonly files?: TaskFiles,
    healthCheck?: () => Promise<BridgeHealthSnapshot>,
  ) { this.panels = new TaskPanels(access, desktop, chat, store, gate, healthCheck); }

  handle(input: BridgeInput): Promise<void> {
    // Each VK conversation is ordered independently. A disconnected Codex task
    // must never hold the manager or another linked conversation behind it.
    const previous = this.tails.get(input.peerId) ?? Promise.resolve();
    const work = previous.then(() => this.watch(input));
    const settled = work.catch(() => {});
    this.tails.set(input.peerId, settled);
    void settled.finally(() => { if (this.tails.get(input.peerId) === settled) this.tails.delete(input.peerId); });
    return work;
  }

  async idle(): Promise<void> { await Promise.all([...this.tails.values()]); }

  private async watch(input: BridgeInput): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        const binding = this.store.byPeer(input.peerId);
        this.store.enqueue(`watchdog:${input.peerId}:${input.eventId}`, input.peerId, {
          text: "VKodex не дождался ответа локального Codex за 45 секунд. Остальные беседы продолжают работать. Результат этой операции неизвестен: проверь десктоп и не повторяй изменяющую команду вслепую.",
        }, binding?.id ?? null);
        resolve();
      }, 45_000);
      timer.unref();
    });
    try { await Promise.race([this.dispatch(input), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private reply(input: BridgeInput, view: View): void {
    this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, this.access.ownerId, view.buttons ? view : { ...view, buttons: [MENU_BUTTON] });
  }

  private inactiveInput(input: BridgeInput, binding: Binding | null): void {
    const text = binding
      ? `Новое сообщение в беседе задачи «${shortTitle(binding.title, 200)}» не отправлено: трансляция отключена. Нажми «Подключить снова» в менеджере, затем повтори сообщение.`
      : "Сообщение пришло из VK-беседы, которая не связана с задачей Codex. Открой список задач в менеджере и подключи нужную задачу; затем повтори сообщение в созданной для неё беседе.";
    const buttons = binding
      ? [this.button("Подключить снова", { type: "resume", bindingId: binding.id })]
      : [this.button("Открыть список задач", { type: "browseProjects", page: 0 })];
    this.store.enqueue(`inactive-input:${input.peerId}:${input.eventId}`, this.access.ownerId, { text, buttons });
  }

  private async dispatch(input: BridgeInput): Promise<void> {
    const managerPeer = input.peerId === this.access.ownerId;
    // The private manager remains owner-only. A linked task conversation is a
    // shared prompt surface: every inbound message not sent by the community
    // itself is accepted, regardless of its VK user ID.
    if (managerPeer && input.senderId !== this.access.ownerId) return;
    if (!managerPeer && [this.access.groupId, -this.access.groupId].includes(input.senderId)) return;
    if (input.action && input.senderId !== this.access.ownerId) return;
    const inboxKey = JSON.stringify([input.peerId, input.eventId]);
    if (!this.store.claimInput(inboxKey)) return;
    let panelAction = false;
    try {
      if (!managerPeer) {
        let binding = this.store.byPeer(input.peerId);
        if (!binding) { this.inactiveInput(input, null); this.store.finishInput(inboxKey); return; }
        if (binding.paused) {
          await this.gate.clearLegacyPause(input.peerId, binding.id);
          binding = this.store.byPeer(input.peerId)!;
        } else if (!binding.attached) {
          this.inactiveInput(input, binding); this.store.finishInput(inboxKey); return;
        }
        if (!await this.gate.check(input.peerId)) { this.store.finishInput(inboxKey); return; }
      }
      const incomingId = /^message:(\d+)$/u.exec(input.eventId);
      if (incomingId) this.store.observePeerMessage(input.peerId, Number(incomingId[1]));
      if (input.hasAttachments) throw new ActionRejectedError(input.attachmentError ?? "Не удалось обработать вложения. Сообщение не отправлено; пришли фотографию или документ.");
      if (input.attachments?.length && (!this.files || managerPeer || input.action || input.text.trim().startsWith("/"))) throw new ActionRejectedError("Вложения отправляй отдельным сообщением в связанную беседу задачи.");
      if (input.action) {
        // This read-only shortcut always opens the current peer's menu, even
        // after older panel tokens expire. Manager ownership was checked above.
        if (input.action === MENU_BUTTON.action) {
          await this.panels.text({ ...input, text: "/menu" });
          this.store.finishInput(inboxKey); return;
        }
        const action = this.store.scopedAction(input.action, input.peerId, managerPeer);
        if (!action) throw new ActionRejectedError("Кнопка устарела или относится к другой беседе. Открой /menu заново.");
        if (action.type === "panel") { panelAction = true; await this.panels.action(input, action); }
        else if (managerPeer) await this.handleAction(input, action);
        else throw new ActionRejectedError("Эта кнопка доступна только в менеджере.");
      } else if (!managerPeer && input.senderId !== this.access.ownerId) {
        await this.handleTask(input);
      } else if (input.attachments?.length || !await this.panels.text(input)) {
        if (managerPeer) await this.handleManager(input);
        else await this.handleTask(input);
      }
      this.store.finishInput(inboxKey);
    } catch (error) {
      this.store.finishInput(inboxKey, !(error instanceof ActionRejectedError));
      if (panelAction) this.panels.failure(input.peerId, error);
      const view = { text: error instanceof ActionRejectedError || error instanceof DesktopUnavailableError || error instanceof UncertainActionError
        ? error.message : "Операция не завершена. Проверь подключение к Codex; автоматического повтора команды не будет." };
      if (managerPeer) this.reply(input, view);
      else {
        const binding = this.store.byPeer(input.peerId);
        if (binding?.attached) this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, input.peerId, view, binding.id);
      }
    }
  }

  private async handleManager(input: BridgeInput): Promise<void> {
    const text = input.text.trim();
    if (text === "/help") { this.reply(input, { text: managerHelp }); return; }
    if (["/start", "/list"].includes(text)) { await this.chooseProject(input, 0); return; }
    if (text === "/new") { await this.newTask(input); return; }
    if (text === "/cancel") { this.cancel(input); return; }
    if (text.startsWith("/")) { this.reply(input, { text: unknownCommand(managerHelp) }); return; }
    const draft = this.store.getDraft();
    if (draft?.stage === "title") {
      if (!text || text.length > 120) throw new ActionRejectedError("Введи название задачи длиной от 1 до 120 символов.");
      this.store.saveDraft({ ...draft, stage: "prompt", title: text });
      this.reply(input, { text: "Теперь отправь стартовый промпт.", buttons: [this.button("Отмена", { type: "cancel" })] });
      return;
    }
    if (draft?.stage === "prompt") {
      if (!text || text.length > 16_000) throw new ActionRejectedError("Стартовый промпт должен содержать от 1 до 16000 символов.");
      this.store.saveDraft({ ...draft, stage: "model", prompt: text });
      await this.newModels(input, 0);
      return;
    }
    this.reply(input, { text: "Это менеджер задач. /menu — меню и состояние моста, /health — полная проверка, /list — задачи по проектам, /new — новая задача, /cancel — отмена ввода.", buttons: [MENU_BUTTON] });
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
        this.store.saveDraft({ ...draft, stage: "environment", projectId: project.id, projectTitle: project.title });
        this.reply(input, { text: `Проект: ${project.title}\nГде создать задачу?\n\nЛокально — в сохранённой папке проекта. Worktree — в отдельной Git-копии рядом с репозиторием.`, buttons: [
          this.button("Локально", { type: "newEnvironment", environment: "local" }),
          this.button("Отдельный worktree", { type: "newEnvironment", environment: "worktree" }),
          this.button("Отмена", { type: "cancel" }),
        ] });
        break;
      }
      case "newEnvironment": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "environment" || !draft.projectId) throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        this.store.saveDraft({ ...draft, stage: "title", environment: action.environment });
        this.reply(input, { text: `Проект: ${draft.projectTitle}\nСреда: ${action.environment === "worktree" ? "отдельный worktree" : "локальная папка"}\n\nКак назвать задачу?`, buttons: [this.button("Отмена", { type: "cancel" })] });
        break;
      }
      case "newModels": await this.newModels(input, action.page); break;
      case "newModel": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "model" || !draft.prompt) throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        const model = (await this.desktop.listModels()).find(item => item.id === action.model);
        if (!model) throw new ActionRejectedError("Модель больше не доступна. Обнови список.");
        this.store.saveDraft({ ...draft, stage: "effort", model: model.id });
        const buttons = model.efforts.slice(0, 8).map(effort => this.button(effort, { type: "newEffort", model: model.id, effort }));
        buttons.push(this.button("Назад к моделям", { type: "newModels", page: 0 }), this.button("Отмена", { type: "cancel" }));
        this.reply(input, { text: `${model.title}\nВыбери уровень рассуждения. По умолчанию: ${model.defaultEffort}`, buttons });
        break;
      }
      case "newEffort": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "effort" || draft.model !== action.model || !draft.prompt) throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        const model = (await this.desktop.listModels()).find(item => item.id === action.model);
        if (!model?.efforts.includes(action.effort)) throw new ActionRejectedError("Модель или уровень рассуждения больше не доступны.");
        const confirmed = { ...draft, stage: "confirm" as const, effort: action.effort };
        this.store.saveDraft(confirmed);
        this.reply(input, { text: `Проект: ${draft.projectTitle}\nСреда: ${draft.environment === "worktree" ? "отдельный worktree" : "локальная папка"}\nНазвание: ${draft.title}\nМодель: ${draft.model}\nРассуждение: ${action.effort}\n\n${draft.prompt.slice(0, 2_000)}${draft.prompt.length > 2_000 ? "\n… (промпт сохранён полностью)" : ""}`,
          buttons: [this.button("Создать", { type: "create", draftId: draft.id }), this.button("Отмена", { type: "cancel" })] });
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
        if (!(await this.desktop.listTasks()).some(task => sameTask(task, binding))) throw new ActionRejectedError("Задача больше не доступна в каталоге Codex. Открой список и выбери доступную задачу.");
        this.store.setPaused(binding.id, false);
        this.store.setAttached(binding.id, true);
        this.reply(input, { text: "Трансляция включена. Подключаюсь к задаче Codex." });
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
    const start = Math.max(0, Math.min(Math.floor(page), Math.max(0, Math.ceil(projects.length / PROJECT_PAGE_SIZE) - 1))) * PROJECT_PAGE_SIZE;
    const visible = projects.slice(start, start + PROJECT_PAGE_SIZE);
    const unassigned = tasks.filter(task => task.projectId === null).length;
    const knownProjects = new Set(projects.map(project => project.id));
    const unknown = tasks.filter(task => task.projectId !== null && (!task.projectId || !knownProjects.has(task.projectId))).length;
    if (unknown) warnings.push(`Для ${unknown} задач проект не определён или недоступен. Они видны в «Все подряд».`);
    const counts = new Map<string, number>();
    for (const task of tasks) if (task.projectId) counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
    const buttons = visible.map((project, i) => this.button(shortTitle(`${start + i + 1}. ${project.title}`, 40), { type: "list", page: 0, filter: { kind: "project", projectId: project.id } }));
    buttons.push(this.button("Без проекта", { type: "list", page: 0, filter: { kind: "unassigned" } }), this.button("Все подряд", { type: "list", page: 0, filter: { kind: "all" } }));
    if (start > 0) buttons.push(this.button("Назад", { type: "browseProjects", page: start / PROJECT_PAGE_SIZE - 1 }));
    if (start + PROJECT_PAGE_SIZE < projects.length) buttons.push(this.button("Далее", { type: "browseProjects", page: start / PROJECT_PAGE_SIZE + 1 }));
    buttons.push(this.button("Обновить", { type: "browseProjects", page: start / PROJECT_PAGE_SIZE }));
    const lines = ["В каком проекте показать задачи?", "",
      ...visible.map((project, i) => `${start + i + 1}. ${shortTitle(project.title, 120)} · ${counts.get(project.id) ?? 0}`),
      ...(projects.length > PROJECT_PAGE_SIZE ? ["", `Проекты · ${start + 1}–${start + visible.length} из ${projects.length}`] : []),
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

  private async newModels(input: BridgeInput, requestedPage: number): Promise<void> {
    const draft = this.store.getDraft();
    if (!draft || !["model", "effort"].includes(draft.stage) || !draft.prompt) throw new ActionRejectedError("Сначала начни создание через /new.");
    const models = await this.desktop.listModels();
    if (!models.length) throw new ActionRejectedError("Codex не сообщил доступные модели.");
    const page = Math.max(0, Math.min(Math.floor(requestedPage), Math.ceil(models.length / 6) - 1));
    const { model, effort, ...rest } = draft;
    void model; void effort;
    this.store.saveDraft({ ...rest, stage: "model" });
    const visible = models.slice(page * 6, page * 6 + 6);
    const buttons = visible.map(model => this.button(model.title, { type: "newModel", model: model.id }));
    if (page > 0) buttons.push(this.button("Предыдущие", { type: "newModels", page: page - 1 }));
    if ((page + 1) * 6 < models.length) buttons.push(this.button("Следующие", { type: "newModels", page: page + 1 }));
    buttons.push(this.button("Отмена", { type: "cancel" }));
    this.reply(input, { text: `Выбери модель для новой задачи · ${page + 1}/${Math.ceil(models.length / 6)}\n\n${visible.map(model => `${model.title}\n${model.id}`).join("\n\n")}`, buttons });
  }

  private async create(input: BridgeInput, draftId: string): Promise<void> {
    const existing = this.store.getDraft();
    if (existing?.id === draftId && existing.stage === "created" && existing.task) { await this.open(input, existing.task); return; }
    const draft = this.store.claimDraft(draftId);
    if (!draft || !draft.projectId || !draft.title || !draft.prompt || !draft.model || !draft.effort || !draft.environment) throw new ActionRejectedError("Создание уже выполнено, ожидает проверки или эта кнопка устарела.");
    if (!this.desktop.capabilities.createTask) {
      this.store.saveDraft({ ...draft, stage: "confirm" });
      throw new ActionRejectedError("Создание задач недоступно в текущем подключении.");
    }
    let task: DesktopTask;
    try {
      task = await this.desktop.createTask({ operationId: draft.id, projectId: draft.projectId, title: draft.title, prompt: draft.prompt, model: draft.model, effort: draft.effort, environment: draft.environment });
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
    this.store.setPaused(binding.id, false);
    this.store.setAttached(binding.id, true);
    const url = await this.chat.inviteLink(binding.peerId);
    this.reply(input, { text: `${task.title}\n${url}`, buttons: [this.button("Отключить трансляцию", { type: "detach", bindingId: binding.id })] });
  }

  private async handleTask(input: BridgeInput): Promise<void> {
    const binding: Binding | null = this.store.byPeer(input.peerId);
    if (!binding || input.action) return;
    const text = input.text.trim();
    const ownerCommand = input.senderId === this.access.ownerId;
    if (ownerCommand && text === "/help") {
      this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, input.peerId, { text: taskHelp, buttons: [MENU_BUTTON] }, binding.id);
      return;
    }
    if (ownerCommand && text === "/detach") {
      this.store.stopStreaming(binding.id);
      this.reply(input, { text: "Трансляция отключена; задача Codex продолжает работать." });
      return;
    }
    if (ownerCommand && text === "/stop") {
      if (!this.desktop.capabilities.interruptTurn) throw new ActionRejectedError("Остановка через текущий адаптер ещё не подтверждена. Останови ход в десктопе.");
      await this.desktop.interrupt(binding);
      this.reply(input, { text: "Запрос остановки передан в Codex." });
      return;
    }
    if (ownerCommand && text === "/files") {
      if (!this.files) throw new ActionRejectedError("Передача файлов не настроена.");
      const count = await this.files.collect(binding, true);
      this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, input.peerId, { text: count ? `Подготовлено к отправке файлов: ${count}.` : "Новых выходных файлов пока нет. В запросе агенту попроси сохранить результат в папку отправки VKodex." }, binding.id);
      return;
    }
    if (!text && !input.attachments?.length) throw new ActionRejectedError("Пришли текст или вложение для этой задачи.");
    if (text.length > 16_000) throw new ActionRejectedError("Допустим текст до 16000 символов.");
    if (ownerCommand && text.startsWith("/")) {
      this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, input.peerId, { text: unknownCommand(taskHelp), buttons: [MENU_BUTTON] }, binding.id);
      return;
    }
    const operationId = randomUUID();
    const generation = this.store.streamGeneration(binding.id);
    const prepared = await this.files?.prepare(binding, operationId, input.attachments ?? []);
    this.store.recordOperation(operationId, binding);
    try {
      await this.desktop.submit({ task: binding, operationId, text, ...prepared, beforeSend: async () => {
        if (generation !== this.store.streamGeneration(binding.id) || !await this.gate.check(input.peerId, true) || generation !== this.store.streamGeneration(binding.id)) throw new ActionRejectedError("Беседа отключена во время подготовки запроса. Сообщение не отправлено.");
      } });
      this.store.finishOperation(operationId, false);
      this.files?.finish(binding.id, operationId, false);
    } catch (error) {
      this.store.finishOperation(operationId, true);
      this.files?.finish(binding.id, operationId, true);
      throw error;
    }
  }
}
