import { randomUUID } from "node:crypto";
import { InputBatcher } from "./input-batcher.js";
import { ActionRejectedError, DesktopUnavailableError, TaskNotOpenError, UncertainActionError, sameTask, type DesktopProject, type DesktopSource, type DesktopTask, type CodexTasks, type TaskRef } from "../core/codex-tasks.js";
import type { Binding, BridgeChat, BridgeHealthSnapshot, BridgeInput, Button, ManagerAction, NewTaskDraft, OwnerAccess, TaskListFilter, View } from "./contracts.js";
import { MENU_BUTTON, taskChatTitle } from "./contracts.js";
import { AccessGate } from "./delivery.js";
import { BridgeStore } from "./store.js";
import { TaskPanels } from "./panels.js";
import { TaskFiles } from "./files.js";
import { systemLoadText } from "./system-load.js";
import { taskInput } from "../core/task-input.js";
import path from "node:path";
import os from "node:os";
import { comparablePath } from "../desktop/paths.js";
import { TaskQuestions } from "./questions.js";

// Leave room for both page arrows, the two special scopes and refresh.
const PROJECT_PAGE_SIZE = 5;
const NEW_SOURCE_PAGE_SIZE = 7;
const NEW_PROJECT_PAGE_SIZE = 6;
const NEW_WORKSPACE_PAGE_SIZE = 5;

interface WorkspaceChoice { readonly workspace: string; readonly label: string; readonly updatedAt: number }

const managerHelp = [
  "VKodex · команды менеджера",
  "",
  "/menu, /start, /status — меню и состояние моста",
  "/help — эта справка",
  "/health — полная проверка моста",
  "/load, /pc — текущая нагрузка компьютера",
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
  "/open — явно открыть эту задачу в настроенном Codex",
  "/stop — остановить текущий ход",
  "/queue <промпт> — добавить запрос в штатную очередь Codex",
  "/questions — показать открытые вопросы Codex и обновить кнопки",
  "/detach — отключить трансляцию, не останавливая задачу",
  "",
  "Обычный текст, фотографии и документы продолжают эту задачу.",
  "Правка последнего сообщения VK заменяет отдельный live-ход; уточнения внутри идущего хода не переписываются.",
].join("\n");

const unknownCommand = (help: string): string => `Команда не найдена.\n\n${help}`;

function shortTitle(title: string, maxLength: number): string {
  const text = title.replace(/\s+/gu, " ").trim() || "Без названия";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function enteredPath(text: string): string {
  const trimmed = text.trim();
  const unquoted = trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1).trim() : trimmed;
  if (!unquoted || unquoted.length > 1_000 || /[\x00-\x1f]/u.test(unquoted)
    || (!path.isAbsolute(unquoted) && !path.win32.isAbsolute(unquoted))) {
    throw new ActionRejectedError("Укажи абсолютный путь к рабочей папке, например D:\\Projects\\MyApp.");
  }
  return path.normalize(unquoted);
}

export class TaskManager {
  private readonly inputBatcher: InputBatcher;
  private readonly activeInputs = new Set<string>();
  private readonly tails = new Map<number, Promise<void>>();
  readonly panels: TaskPanels;
  readonly questions: TaskQuestions;

  constructor(
    private readonly access: OwnerAccess,
    private readonly desktop: CodexTasks,
    private readonly chat: BridgeChat,
    private readonly store: BridgeStore,
    private readonly gate: AccessGate,
    private readonly files?: TaskFiles,
    healthCheck?: () => Promise<BridgeHealthSnapshot>,
    private readonly loadReport: () => Promise<string> = systemLoadText,
    private readonly projectlessRoot: string = path.join(os.tmpdir(), "VKodex", "workspaces"),
  ) {
    this.inputBatcher = new InputBatcher(input => this.enqueueInput(input), input => input.peerId !== access.ownerId
      && ![access.groupId, -access.groupId].includes(input.senderId) && !!store.byPeer(input.peerId)?.attached,
      1500, 3000, store);
    this.panels = new TaskPanels(access, desktop, chat, store, gate, healthCheck);
    this.questions = new TaskQuestions(desktop, store, gate, access.ownerId);
  }

  handle(input: BridgeInput): Promise<void> {
    const managerPeer = input.peerId === this.access.ownerId;
    if (managerPeer && input.senderId !== this.access.ownerId) return Promise.resolve();
    if (!managerPeer && [this.access.groupId, -this.access.groupId].includes(input.senderId)) return Promise.resolve();
    if (input.action && input.senderId !== this.access.ownerId) return Promise.resolve();
    const key = JSON.stringify([input.peerId, input.eventId]);
    if (this.activeInputs.has(key) || !this.store.receiveInput(input)) return Promise.resolve();
    this.activeInputs.add(key);
    try { return this.inputBatcher.handle(input).finally(() => this.activeInputs.delete(key)); }
    catch (error) { this.activeInputs.delete(key); throw error; }
  }

  recoverInputs(): void { this.inputBatcher.restore(); this.replaySavedInputs(); }
  replaySavedInputs(): void {
    let inputs: readonly BridgeInput[];
    try {
      inputs = this.store.reserveReplayableInputs();
      if (this.store.getValue("inbound-recovery-error") !== null) this.store.setValue("inbound-recovery-error", null);
    } catch {
      this.store.setValue("inbound-recovery-error", { at: Date.now() });
      throw new Error("Durable VK input journal could not be replayed");
    }
    for (const input of inputs) void this.handle(input).catch(() => {});
  }

  private enqueueInput(input: BridgeInput): Promise<void> {
    // Each VK conversation is ordered independently. A disconnected Codex task
    // must never hold the manager or another linked conversation behind it.
    const previous = this.tails.get(input.peerId) ?? Promise.resolve();
    const work = previous.then(() => this.watch(input));
    const settled = work.catch(() => {});
    this.tails.set(input.peerId, settled);
    void settled.finally(() => { if (this.tails.get(input.peerId) === settled) this.tails.delete(input.peerId); });
    return work;
  }

  async idle(): Promise<void> { await this.inputBatcher.idle(); await Promise.all([...this.tails.values()]); }

  private async watch(input: BridgeInput): Promise<void> {
    const timer = setTimeout(() => {
      const binding = this.store.byPeer(input.peerId);
      this.store.enqueue(`watchdog:${input.peerId}:${input.eventId}`, input.peerId, {
        text: "VKodex не дождался ответа локального Codex за 45 секунд. Остальные беседы продолжают работать. Результат этой операции неизвестен: проверь десктоп и не повторяй изменяющую команду вслепую.",
      }, binding?.id ?? null);
    }, 45_000);
    timer.unref();
    // The watchdog reports latency but cannot cancel a mutation. Retain this
    // peer's lock until dispatch settles; other peers keep their own queues.
    try { await this.dispatch(input); }
    finally { clearTimeout(timer); }
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
    const mergedKeys = (input.mergedEventIds ?? []).map(id => JSON.stringify([input.peerId, id]));
    for (const key of mergedKeys) this.store.claimInput(key);
    const finish = (uncertain = false) => this.store.finishInputs([inboxKey, ...mergedKeys], uncertain);
    let panelAction = false;
    try {
      if (!managerPeer) {
        let binding = this.store.byPeer(input.peerId);
        if (!binding) { this.inactiveInput(input, null); finish(); return; }
        if (binding.paused) {
          await this.gate.clearLegacyPause(input.peerId, binding.id);
          binding = this.store.byPeer(input.peerId)!;
        } else if (!binding.attached) {
          this.inactiveInput(input, binding); finish(); return;
        }
        if (!await this.gate.check(input.peerId)) { finish(); return; }
      }
      const incomingId = /^message:(\d+)$/u.exec(input.eventId);
      if (incomingId) this.store.observePeerMessage(input.peerId, Number(incomingId[1]));
      if (input.hasAttachments && input.editOfMessageId === undefined) throw new ActionRejectedError(input.attachmentError ?? "Не удалось обработать вложения. Сообщение не отправлено; пришли фотографию или документ.");
      if (!managerPeer && !input.action && await this.questions.text(input)) { finish(); return; }
      if (input.attachments?.length && (!this.files || managerPeer || input.action || input.text.trim().startsWith("/"))) throw new ActionRejectedError("Вложения отправляй отдельным сообщением в связанную беседу задачи.");
      if (input.action) {
        // This read-only shortcut always opens the current peer's menu, even
        // after older panel tokens expire. Manager ownership was checked above.
        if (input.action === MENU_BUTTON.action) {
          await this.panels.text({ ...input, text: "/menu" });
          finish(); return;
        }
        const action = this.store.scopedAction(input.action, input.peerId, managerPeer);
        if (!action) throw new ActionRejectedError("Кнопка устарела или относится к другой беседе. Открой /menu заново.");
        if (action.type === "question") await this.questions.action(input, action);
        else if (action.type === "panel") { panelAction = true; await this.panels.action(input, action); }
        else if (managerPeer) await this.handleAction(input, action);
        else throw new ActionRejectedError("Эта кнопка доступна только в менеджере.");
      } else if (!managerPeer && input.senderId !== this.access.ownerId) {
        await this.handleTask(input);
      } else if (input.attachments?.length || !await this.panels.text(input)) {
        if (managerPeer) await this.handleManager(input);
        else await this.handleTask(input);
      }
      finish();
    } catch (error) {
      finish(!(error instanceof ActionRejectedError));
      if (panelAction) this.panels.failure(input.peerId, error);
      const view = { text: error instanceof ActionRejectedError || error instanceof DesktopUnavailableError || error instanceof UncertainActionError
        ? error.message : "Операция не завершена. Проверь подключение к Codex; автоматического повтора команды не будет.",
        ...(error instanceof TaskNotOpenError ? { buttons: [MENU_BUTTON] } : {}) };
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
    if (["/load", "/pc"].includes(text)) { this.reply(input, { text: await this.loadReport() }); return; }
    if (["/start", "/list"].includes(text)) { await this.chooseProject(input, 0); return; }
    if (text === "/new") { await this.newTask(input); return; }
    if (text === "/cancel") { this.cancel(input); return; }
    if (text.startsWith("/")) { this.reply(input, { text: unknownCommand(managerHelp) }); return; }
    const draft = this.store.getDraft();
    if (draft?.stage === "workspace") {
      // Drafts created by the previous mobile-hostile wizard did not carry an
      // explicit manual marker. Treat their next non-path message as the title
      // of a new isolated projectless task so an upgrade can continue in place.
      if (draft.projectId === null && draft.automaticWorkspace !== false && text && !path.isAbsolute(text) && !path.win32.isAbsolute(text)) {
        if (text.length > 120) throw new ActionRejectedError("Введи название задачи длиной от 1 до 120 символов.");
        this.store.saveDraft({ ...draft, stage: "prompt", title: text, workspace: this.automaticWorkspace(text, draft.id), automaticWorkspace: true, environment: "local" });
        this.reply(input, { text: "Теперь отправь стартовый промпт.", buttons: [this.button("Отмена", { type: "cancel" })] });
        return;
      }
      const workspace = enteredPath(text);
      const next = { ...draft, stage: "environment" as const, workspace };
      this.store.saveDraft(next);
      this.reply(input, this.environmentView(next));
      return;
    }
    if (draft?.stage === "title") {
      if (!text || text.length > 120) throw new ActionRejectedError("Введи название задачи длиной от 1 до 120 символов.");
      const workspace = draft.automaticWorkspace ? this.automaticWorkspace(text, draft.id) : draft.workspace;
      this.store.saveDraft({ ...draft, stage: "prompt", title: text, ...(workspace ? { workspace } : {}) });
      this.reply(input, { text: "Теперь отправь стартовый промпт.", buttons: [this.button("Отмена", { type: "cancel" })] });
      return;
    }
    if (draft?.stage === "prompt") {
      if (!text || text.length > 16_000) throw new ActionRejectedError("Стартовый промпт должен содержать от 1 до 16000 символов.");
      this.store.saveDraft({ ...draft, stage: "model", prompt: text });
      await this.newModels(input, 0);
      return;
    }
    this.reply(input, { text: "Это менеджер задач. /menu — меню и состояние моста, /health — полная проверка, /load — нагрузка ПК, /list — задачи по проектам, /new — новая задача, /cancel — отмена ввода.", buttons: [MENU_BUTTON] });
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
      case "newSources": await this.newSources(input, action.page); break;
      case "newSource": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "source") throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        const source = this.sources().find(source => source.id === action.sourceId);
        if (!source) throw new ActionRejectedError("Каталог больше не подключён в конфигурации VKodex.");
        this.store.saveDraft({ ...draft, stage: "project", sourceId: source.id, sourceLabel: source.label });
        await this.newProjects(input, 0);
        break;
      }
      case "newProjects": await this.newProjects(input, action.page); break;
      case "project": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "project") throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        const project = (await this.desktop.listProjects(draft.sourceId)).find(project => project.id === action.id);
        if (!project) throw new ActionRejectedError("Проект больше не доступен.");
        this.store.saveDraft({ ...draft, stage: "environment", projectId: project.id, projectTitle: project.title });
        this.reply(input, this.environmentView({ ...draft, stage: "environment", projectId: project.id, projectTitle: project.title }));
        break;
      }
      case "newProjectless": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "project") throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        this.store.saveDraft({ ...draft, stage: "title", projectId: null, projectTitle: "Без проекта", automaticWorkspace: true, environment: "local" });
        this.reply(input, { text: `Каталог: ${draft.sourceLabel}\nПроект: без проекта\nРабочая папка: VKodex создаст новую пустую папку на компьютере.\nСреда: локальная\n\nКак назвать задачу?`, buttons: [this.button("Выбрать папку", { type: "newWorkspaces", page: 0 }), this.button("Отмена", { type: "cancel" })] });
        break;
      }
      case "newWorkspaces": await this.newWorkspaces(input, action.page); break;
      case "newWorkspaceAuto": {
        const draft = this.projectlessTitleDraft();
        const { workspace, ...rest } = draft;
        void workspace;
        this.store.saveDraft({ ...rest, automaticWorkspace: true, environment: "local" });
        this.reply(input, { text: `Каталог: ${draft.sourceLabel}\nПроект: без проекта\nРабочая папка: VKodex создаст новую пустую папку на компьютере.\nСреда: локальная\n\nКак назвать задачу?`, buttons: [this.button("Выбрать папку", { type: "newWorkspaces", page: 0 }), this.button("Отмена", { type: "cancel" })] });
        break;
      }
      case "newWorkspace": {
        const draft = this.projectlessTitleDraft();
        const selected = (await this.workspaceChoices(draft.sourceId)).find(choice => comparablePath(choice.workspace) === comparablePath(action.workspace));
        if (!selected) throw new ActionRejectedError("Папка больше не доступна в списке. Обнови выбор папок.");
        const next = { ...draft, stage: "environment" as const, workspace: selected.workspace, automaticWorkspace: false };
        this.store.saveDraft(next);
        this.reply(input, this.environmentView(next));
        break;
      }
      case "newWorkspaceManual": await this.newWorkspaces(input, 0); break;
      case "newWorkspacePath": {
        const draft = this.projectlessTitleDraft();
        const { automaticWorkspace, environment, workspace, ...rest } = draft;
        void automaticWorkspace; void environment; void workspace;
        this.store.saveDraft({ ...rest, stage: "workspace", automaticWorkspace: false });
        this.reply(input, { text: `Каталог: ${draft.sourceLabel}\nПроект: без проекта\n\nДополнительный режим: отправь абсолютный путь к существующей папке на компьютере с VKodex.`, buttons: [this.button("Отмена", { type: "cancel" })] });
        break;
      }
      case "newEnvironment": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "environment" || draft.projectId === undefined || (draft.projectId === null && !draft.workspace)) throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        this.store.saveDraft({ ...draft, stage: "title", environment: action.environment });
        this.reply(input, { text: `Каталог: ${draft.sourceLabel}\nПроект: ${draft.projectTitle}${draft.workspace ? `\nРабочая папка: ${draft.workspace}` : ""}\nСреда: ${action.environment === "worktree" ? "отдельный worktree" : "локальная папка"}\n\nКак назвать задачу?`, buttons: [this.button("Отмена", { type: "cancel" })] });
        break;
      }
      case "newModels": await this.newModels(input, action.page); break;
      case "newModel": {
        const draft = this.store.getDraft();
        if (draft?.stage !== "model" || !draft.prompt) throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
        const model = (await this.desktop.listModels(this.draftSource(draft))).find(item => item.id === action.model);
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
        const model = (await this.desktop.listModels(this.draftSource(draft))).find(item => item.id === action.model);
        if (!model?.efforts.includes(action.effort)) throw new ActionRejectedError("Модель или уровень рассуждения больше не доступны.");
        const confirmed = { ...draft, stage: "confirm" as const, effort: action.effort };
        this.store.saveDraft(confirmed);
        this.reply(input, { text: `Каталог: ${draft.sourceLabel}\nПроект: ${draft.projectTitle}${draft.workspace ? `\nРабочая папка: ${draft.workspace}` : ""}\nСреда: ${draft.environment === "worktree" ? "отдельный worktree" : "локальная папка"}\nНазвание: ${draft.title}\nМодель: ${draft.model}\nРассуждение: ${action.effort}\n\n${draft.prompt.slice(0, 2_000)}${draft.prompt.length > 2_000 ? "\n… (промпт сохранён полностью)" : ""}`,
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

  private sources(): readonly DesktopSource[] {
    return this.desktop.listSources?.() ?? [{ id: "", label: "Основной" }];
  }

  private draftSource(draft: NewTaskDraft): TaskRef {
    return { hostId: "local", threadId: "", ...(draft.sourceId ? { sourceId: draft.sourceId } : {}) };
  }

  private author(input: BridgeInput): { readonly id: number; readonly name: string } {
    const resolved = input.senderName?.replace(/\s+/gu, " ").trim();
    return { id: input.senderId, name: resolved?.slice(0, 120) || (input.senderId > 0 ? "Пользователь VK" : "Сообщество VK") };
  }

  private automaticWorkspace(title: string, draftId: string): string {
    const safeTitle = title.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/gu, "-")
      .replace(/^[.\s]+|[.\s]+$/gu, "").replace(/\s+/gu, " ").slice(0, 48) || "task";
    return path.join(this.projectlessRoot, `${safeTitle}-${draftId.slice(0, 8)}`);
  }

  private sharedAuthor(binding: Binding, input: BridgeInput): { readonly id: number; readonly name: string } | undefined {
    // The configured owner is the implicit first author. This avoids a participant-list API
    // dependency while still enabling attribution on the first message from somebody else.
    this.store.observeTaskSender(binding.id, this.access.ownerId);
    return this.store.observeTaskSender(binding.id, input.senderId) > 1 ? this.author(input) : undefined;
  }

  private environmentView(draft: NewTaskDraft): View {
    return {
      text: `Каталог: ${draft.sourceLabel}\nПроект: ${draft.projectTitle}${draft.workspace ? `\nРабочая папка: ${draft.workspace}` : ""}\n\nГде создать задачу?\n\nЛокально — в выбранной папке. Worktree — в отдельной Git-копии рядом с репозиторием.`,
      buttons: [
        this.button("Локально", { type: "newEnvironment", environment: "local" }),
        this.button("Отдельный worktree", { type: "newEnvironment", environment: "worktree" }),
        this.button("Отмена", { type: "cancel" }),
      ],
    };
  }

  private async newTask(input: BridgeInput): Promise<void> {
    if (!this.desktop.capabilities.createTask) throw new ActionRejectedError("Создание задач через этот адаптер десктопа ещё не подтверждено. Существующие задачи доступны через /list.");
    const draft = this.store.getDraft();
    if (draft && !["created", "source"].includes(draft.stage)) throw new ActionRejectedError("Сначала заверши текущий ввод или отправь /cancel.");
    this.store.saveDraft({ id: randomUUID(), stage: "source" });
    await this.newSources(input, 0);
  }

  private async newSources(input: BridgeInput, requestedPage: number): Promise<void> {
    const draft = this.store.getDraft();
    if (draft?.stage !== "source") throw new ActionRejectedError("Сначала начни создание через /new.");
    const sources = this.sources();
    if (!sources.length) throw new ActionRejectedError("В конфигурации VKodex нет каталогов Codex.");
    const page = Math.max(0, Math.min(Math.floor(requestedPage), Math.ceil(sources.length / NEW_SOURCE_PAGE_SIZE) - 1));
    const visible = sources.slice(page * NEW_SOURCE_PAGE_SIZE, page * NEW_SOURCE_PAGE_SIZE + NEW_SOURCE_PAGE_SIZE);
    const buttons = visible.map(source => this.button(source.label, { type: "newSource", sourceId: source.id }));
    if (page > 0) buttons.push(this.button("Предыдущие", { type: "newSources", page: page - 1 }));
    if ((page + 1) * NEW_SOURCE_PAGE_SIZE < sources.length) buttons.push(this.button("Следующие", { type: "newSources", page: page + 1 }));
    buttons.push(this.button("Отмена", { type: "cancel" }));
    this.reply(input, { text: `В каком каталоге Codex создать задачу?${sources.length > 1 ? ` · ${page + 1}/${Math.ceil(sources.length / NEW_SOURCE_PAGE_SIZE)}` : ""}\n\n${visible.map(source => source.label).join("\n")}`, buttons });
  }

  private async newProjects(input: BridgeInput, requestedPage: number): Promise<void> {
    const draft = this.store.getDraft();
    if (draft?.stage !== "project") throw new ActionRejectedError("Сначала выбери каталог через /new.");
    const projects = await this.desktop.listProjects(draft.sourceId);
    const page = Math.max(0, Math.min(Math.floor(requestedPage), Math.max(0, Math.ceil(projects.length / NEW_PROJECT_PAGE_SIZE) - 1)));
    const visible = projects.slice(page * NEW_PROJECT_PAGE_SIZE, page * NEW_PROJECT_PAGE_SIZE + NEW_PROJECT_PAGE_SIZE);
    const buttons = visible.map(project => this.button(project.title, { type: "project", id: project.id, title: project.title }));
    buttons.push(this.button("Без проекта", { type: "newProjectless" }));
    if (page > 0) buttons.push(this.button("Предыдущие", { type: "newProjects", page: page - 1 }));
    if ((page + 1) * NEW_PROJECT_PAGE_SIZE < projects.length) buttons.push(this.button("Следующие", { type: "newProjects", page: page + 1 }));
    buttons.push(this.button("Отмена", { type: "cancel" }));
    this.reply(input, { text: `Каталог: ${draft.sourceLabel}\nВ каком проекте создать задачу?${projects.length > NEW_PROJECT_PAGE_SIZE ? ` · ${page + 1}/${Math.ceil(projects.length / NEW_PROJECT_PAGE_SIZE)}` : ""}\n\n${visible.map(project => project.title).join("\n") || "В этом каталоге нет проектов. Выбери «Без проекта»."}`, buttons });
  }

  private projectlessTitleDraft(): NewTaskDraft & { readonly stage: "title"; readonly projectId: null } {
    const draft = this.store.getDraft();
    if (draft?.stage !== "title" || draft.projectId !== null) throw new ActionRejectedError("Этот шаг уже пройден. Используй /new или /cancel.");
    return draft as NewTaskDraft & { readonly stage: "title"; readonly projectId: null };
  }

  private async workspaceChoices(sourceId?: string): Promise<WorkspaceChoice[]> {
    const key = sourceId ?? "";
    const choices = new Map<string, WorkspaceChoice>();
    const add = (workspace: string, label: string, updatedAt: number): void => {
      if (!workspace || (!path.isAbsolute(workspace) && !path.win32.isAbsolute(workspace))) return;
      const comparable = comparablePath(workspace);
      const previous = choices.get(comparable);
      if (!previous || updatedAt > previous.updatedAt || (updatedAt === previous.updatedAt && label.length < previous.label.length)) {
        choices.set(comparable, { workspace: path.normalize(workspace), label: shortTitle(label, 120), updatedAt });
      }
    };
    let projects: readonly DesktopProject[] = [];
    try { projects = await this.desktop.listProjects(sourceId); }
    catch { /* Existing task workspaces still provide a useful mobile picker. */ }
    for (const project of projects) add(project.workspace, project.title || path.basename(project.workspace), Number.MAX_SAFE_INTEGER);
    for (const task of await this.desktop.listTasks()) {
      if ((task.sourceId ?? "") !== key) continue;
      add(task.workspace, path.basename(task.workspace) || task.title, task.updatedAt);
    }
    return [...choices.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.label.localeCompare(right.label, "ru"));
  }

  private async newWorkspaces(input: BridgeInput, requestedPage: number): Promise<void> {
    const draft = this.projectlessTitleDraft();
    const choices = await this.workspaceChoices(draft.sourceId);
    const pageCount = Math.max(1, Math.ceil(choices.length / NEW_WORKSPACE_PAGE_SIZE));
    const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1));
    const start = page * NEW_WORKSPACE_PAGE_SIZE;
    const visible = choices.slice(start, start + NEW_WORKSPACE_PAGE_SIZE);
    const buttons = visible.map(choice => this.button(choice.label, { type: "newWorkspace", workspace: choice.workspace }));
    if (page > 0) buttons.push(this.button("Назад", { type: "newWorkspaces", page: page - 1 }));
    if (page + 1 < pageCount) buttons.push(this.button("Далее", { type: "newWorkspaces", page: page + 1 }));
    buttons.push(this.button("Новая пустая папка", { type: "newWorkspaceAuto" }), this.button("Ввести путь", { type: "newWorkspacePath" }), this.button("Отмена", { type: "cancel" }));
    const body = visible.length ? visible.map((choice, index) => `${start + index + 1}. ${choice.label}\n${choice.workspace}`).join("\n\n") : "Известных рабочих папок в этом каталоге пока нет.";
    this.reply(input, { text: `Каталог: ${draft.sourceLabel}\nПроект: без проекта\n\nВыбери рабочую папку${pageCount > 1 ? ` · ${page + 1}/${pageCount}` : ""}.\n\n${body}`, buttons });
  }

  private async newModels(input: BridgeInput, requestedPage: number): Promise<void> {
    const draft = this.store.getDraft();
    if (!draft || !["model", "effort"].includes(draft.stage) || !draft.prompt) throw new ActionRejectedError("Сначала начни создание через /new.");
    const models = await this.desktop.listModels(this.draftSource(draft));
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
    if (!draft || draft.projectId === undefined || !draft.title || !draft.prompt || !draft.model || !draft.effort || !draft.environment
      || (draft.projectId === null && !draft.workspace)) throw new ActionRejectedError("Создание уже выполнено, ожидает проверки или эта кнопка устарела.");
    if (!this.desktop.capabilities.createTask) {
      this.store.saveDraft({ ...draft, stage: "confirm" });
      throw new ActionRejectedError("Создание задач недоступно в текущем подключении.");
    }
    let task: DesktopTask;
    try {
      task = await this.desktop.createTask({ operationId: draft.id, projectId: draft.projectId, title: draft.title, prompt: draft.prompt, model: draft.model, effort: draft.effort, environment: draft.environment,
        ...(draft.sourceId ? { sourceId: draft.sourceId } : {}), ...(draft.workspace ? { workspace: draft.workspace } : {}),
        ...(draft.automaticWorkspace ? { automaticWorkspace: true } : {}) });
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
    let handoffNote = "";
    if (this.desktop.ensureOpen && this.store.claimInitialHandoff(binding.id, task)) {
      try {
        await this.desktop.ensureOpen(task);
        this.store.markDesktopHandoff(binding.id, task, "launched");
      } catch (error) {
        // The VK binding is already committed and remains usable. Do not turn a
        // launcher failure into a second conversation on the next click.
        handoffNote = `\n\nVK-беседа создана, но приложение Codex не открылось: ${error instanceof Error ? error.message : "неизвестная ошибка"}\nОткрой /menu и нажми «Открыть в Codex».`;
      }
    }
    this.reply(input, { text: `${task.title}\n${url}${handoffNote}`, buttons: [this.button("Отключить трансляцию", { type: "detach", bindingId: binding.id })] });
  }

  private async handleTask(input: BridgeInput): Promise<void> {
    const binding: Binding | null = this.store.byPeer(input.peerId);
    if (!binding || input.action) return;
    const queued = /^\/queue(?:\s|$)/u.test(input.text.trim());
    const text = queued ? input.text.trim().replace(/^\/queue(?:\s+|$)/u, "").trim() : input.text.trim();
    const ownerCommand = input.senderId === this.access.ownerId;
    if (this.store.transferBlocksInput(binding.id) && !["/help", "/detach", "/stop", "/files"].includes(text)) {
      throw new ActionRejectedError("Сообщение не отправлено: задача переносится между каталогами. /menu покажет текущий этап. Повтори запрос после завершения переноса.");
    }
    if (input.editOfMessageId !== undefined) {
      if (queued) throw new ActionRejectedError("Правку запроса в очереди выполняй в Codex. Новый запрос из VK добавляется отдельным сообщением /queue.");
      await this.handleTaskEdit(input, binding, text);
      return;
    }
    if (!queued && ownerCommand && text === "/help") {
      this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, input.peerId, { text: taskHelp, buttons: [MENU_BUTTON] }, binding.id);
      return;
    }
    if (!queued && ownerCommand && text === "/detach") {
      this.store.stopStreaming(binding.id);
      this.reply(input, { text: "Трансляция отключена; задача Codex продолжает работать." });
      return;
    }
    if (!queued && ownerCommand && text === "/stop") {
      if (!this.desktop.capabilities.interruptTurn) throw new ActionRejectedError("Остановка через текущий адаптер ещё не подтверждена. Останови ход в десктопе.");
      await this.desktop.interrupt(binding);
      this.reply(input, { text: "Запрос остановки передан в Codex." });
      return;
    }
    if (!queued && ownerCommand && text === "/files") {
      if (!this.files) throw new ActionRejectedError("Передача файлов не настроена.");
      const count = await this.files.collect(binding, true);
      this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, input.peerId, { text: count ? `Подготовлено к отправке файлов: ${count}.` : "Новых выходных файлов пока нет. В запросе агенту попроси сохранить результат в папку отправки VKodex." }, binding.id);
      return;
    }
    if (!text && !input.attachments?.length) throw new ActionRejectedError("Пришли текст или вложение для этой задачи.");
    if (text.length > (input.mergedEventIds ? 64_000 : 16_000)) throw new ActionRejectedError("Превышен лимит текста запроса.");
    if (!queued && ownerCommand && text.startsWith("/")) {
      this.store.enqueue(`reply:${input.peerId}:${input.eventId}`, input.peerId, { text: unknownCommand(taskHelp), buttons: [MENU_BUTTON] }, binding.id);
      return;
    }
    const operationId = randomUUID();
    const generation = this.store.streamGeneration(binding.id);
    const inboxKeys = [JSON.stringify([input.peerId, input.eventId]), ...(input.mergedEventIds ?? []).map(id => JSON.stringify([input.peerId, id]))];
    this.store.markInputPreparing(inboxKeys);
    const prepared = await this.files?.prepare(binding, operationId, input.attachments ?? []);
    this.store.beginPromptDispatch(operationId, binding, inboxKeys, binding.id);
    try {
      const author = this.sharedAuthor(binding, input);
      const request = { task: binding, operationId, text, ...(author ? { author } : {}), ...prepared, beforeSend: async () => {
        if (this.store.transferBlocksInput(binding.id) || generation !== this.store.streamGeneration(binding.id) || !await this.gate.check(input.peerId, true) || generation !== this.store.streamGeneration(binding.id)) throw new ActionRejectedError("Беседа отключена или начат перенос во время подготовки запроса. Сообщение не отправлено.");
      } };
      // A single edited VK fragment must never replace the complete merged turn.
      if (input.mergedEventIds) this.store.clearEditableRequest(binding.id);
      if (queued) {
        if (!this.desktop.queue) throw new ActionRejectedError("Штатная очередь недоступна в этом подключении Codex.");
        this.files?.markQueued(binding.id, operationId);
        const queuedId = await this.desktop.queue(request);
        this.store.rememberQueuedInput(binding.id, operationId, queuedId);
        this.store.settlePromptDispatch(operationId, "accepted");
        this.files?.finish(binding.id, operationId, "accepted");
        this.reply(input, { text: "Запрос добавлен в штатную очередь Codex. Текущий ход не изменён.", silent: true });
        return;
      }
      const receipt = this.desktop.submitWithReceipt
        ? await this.desktop.submitWithReceipt(request)
        : (await this.desktop.submit(request), null);
      if (receipt?.turnId) this.store.rememberAcceptedTurn(binding.id, receipt.turnId, operationId);
      this.store.settlePromptDispatch(operationId, "accepted");
      this.files?.finish(binding.id, operationId, "accepted", receipt?.turnId ?? undefined);
      const messageId = /^message:(\d+)$/u.exec(input.eventId)?.[1];
      if (messageId && receipt) this.store.saveEditableRequest(binding.id, {
        messageId: Number(messageId), senderId: input.senderId, operationId,
        turnId: receipt.turnId, mode: receipt.mode, text,
        ...(request.author ? { author: request.author } : {}), ...prepared,
      });
    } catch (error) {
      // A lost RPC acknowledgment is not necessarily a lost prompt. The native
      // userMessage clientId is the immutable operation ID sent to Codex.
      if (!(error instanceof ActionRejectedError) && this.desktop.findAcceptedInput) {
        const acceptedTurn = await this.desktop.findAcceptedInput(binding, operationId).catch(() => null);
        if (acceptedTurn) {
          this.store.rememberAcceptedTurn(binding.id, acceptedTurn, operationId);
          this.store.settlePromptDispatch(operationId, "accepted");
          this.files?.finish(binding.id, operationId, "accepted", acceptedTurn);
          this.store.enqueue(`accepted-after-timeout:${input.peerId}:${input.eventId}`, input.peerId,
            { text: "Codex принял запрос; подтверждение ответа задержалось. Ожидаю результат без повторной отправки.", silent: true }, binding.id);
          return;
        }
      }
      const state = error instanceof ActionRejectedError ? "rejected" : "uncertain";
      this.store.settlePromptDispatch(operationId, state);
      this.files?.finish(binding.id, operationId, state);
      throw error;
    }
  }

  private async handleTaskEdit(input: BridgeInput, binding: Binding, text: string): Promise<void> {
    if (!text) throw new ActionRejectedError("Пустой запрос нельзя передать в Codex. Изменение осталось только в VK.");
    if (text.length > 16_000) throw new ActionRejectedError("Допустим текст до 16000 символов. Изменение осталось только в VK.");
    if (input.hasAttachments || input.attachments?.length) throw new ActionRejectedError("VKodex пока синхронизирует только правку текста. Вложения и контекст Codex не изменены.");
    const previous = this.store.editableRequest(binding.id);
    if (!previous || previous.messageId !== input.editOfMessageId || previous.senderId !== input.senderId) {
      throw new ActionRejectedError("Отредактировано не последнее отправленное через VK сообщение. Изменение осталось только в VK; контекст Codex не затронут.");
    }
    if (previous.text === text) return;
    if (previous.mode === "steer") {
      throw new ActionRejectedError("Это сообщение было добавлено как уточнение внутри уже идущего хода. Codex не умеет безопасно заменить только такое уточнение; изменение осталось только в VK.");
    }
    if (previous.mode !== "start" || !previous.turnId || !this.desktop.capabilities.editLastUserTurn || !this.desktop.editLastUserTurn) {
      throw new ActionRejectedError("Для этого сообщения нет подтверждённого отдельного хода Codex. Изменение осталось только в VK.");
    }
    const request = {
      task: binding, operationId: previous.operationId, expectedOperationId: previous.operationId,
      expectedTurnId: previous.turnId, text, ...(previous.author ? { author: this.author(input) } : {}),
      ...(previous.inputFiles ? { inputFiles: previous.inputFiles } : {}),
      ...(previous.outboxDir ? { outboxDir: previous.outboxDir } : {}),
    };
    this.store.expectEditedUser(binding.id, taskInput(request).text);
    let result;
    try { result = await this.desktop.editLastUserTurn(request); }
    catch (error) { this.store.clearExpectedEditedUser(binding.id); throw error; }
    this.store.deleteTurnDeliveries(binding.id, previous.turnId);
    this.store.saveEditableRequest(binding.id, {
      ...previous, text, ...(request.author ? { author: request.author } : {}),
      operationId: result.operationId ?? previous.operationId,
      turnId: result.turnId,
      mode: result.turnId && result.operationId ? "start" : "unconfirmed",
    });
    this.store.enqueue(`edit-confirmed:${binding.id}:${input.eventId}`, input.peerId, {
      text: result.turnId ? "Запрос обновлён в Codex. Предыдущая ветка отброшена; исправленный ход запущен заново. Изменения файлов, уже сделанные старым ходом, автоматически не отменяются."
        : "Запрос обновлён в Codex и запущен заново. Состояние нового хода ещё не пришло в мост, поэтому повторное редактирование пока недоступно.",
      silent: true,
    }, binding.id);
  }
}
