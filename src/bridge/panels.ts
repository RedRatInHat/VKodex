import { randomUUID } from "node:crypto";
import path from "node:path";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, sameTask, type DesktopTasks, type TaskDetails } from "../desktop/contracts.js";
import type { Binding, BridgeChat, BridgeInput, Button, ManagerAction, OwnerAccess, PanelAction, View } from "./contracts.js";
import { taskChatTitle } from "./contracts.js";
import { AccessGate } from "./delivery.js";
import { BridgeStore } from "./store.js";

interface PanelState {
  id: string;
  messageKey: string;
  bindingId: string | null;
  view: "home" | "projects" | "moveProject" | "models" | "efforts" | "rename" | "renameConfirm" | "archive" | "share";
  page: number;
  model?: string;
  title?: string;
  note?: string;
  expiresAt: number;
  tokens: Record<string, { id: string; expiresAt: number }>;
}

interface RenameState {
  title: string;
  liveTitleUpdated: boolean;
  vkTitleUpdated: boolean;
}

const unknownDetails: TaskDetails = { status: "unavailable", workspace: null, model: null, effort: null, nextModel: null, nextEffort: null, context: null };
const statuses: Record<TaskDetails["status"], string> = { running: "Выполняется", idle: "Ожидает сообщения", failed: "Ход завершился с ошибкой", interrupted: "Ход остановлен", approval: "Нужен ответ в Codex", unavailable: "Нет связи с задачей" };
const short = (text: string, length = 120): string => text.replace(/\s+/gu, " ").trim().slice(0, length);
const number = (value: number): string => Math.round(value).toLocaleString("ru-RU");
export const taskDeepLink = (threadId: string): string => `codex://threads/${encodeURIComponent(threadId)}`;

export function taskCardText(binding: Binding, details: TaskDetails): string {
  const context = details.context ? `${details.context.percent.toFixed(1)}% · ${number(details.context.used)} / ${number(details.context.window)} токенов` : "нет данных";
  const lines = [short(binding.title), `Статус: ${statuses[details.status]}`, `Модель: ${details.model ?? "нет данных"}`, `Рассуждение: ${details.effort ?? "нет данных"}`];
  if (binding.sourceLabel) lines.splice(1, 0, `Каталог: ${binding.sourceLabel}`);
  if (details.nextModel && (details.nextModel !== details.model || details.nextEffort !== details.effort)) lines.push(`Следующий ход: ${details.nextModel} · ${details.nextEffort ?? "по умолчанию"}`);
  lines.push(`Контекст: ${context}`, "Контекст — по последним данным Codex, не суммарный расход за задачу.", "", "Сообщение в беседе продолжает эту задачу. /menu — открыть меню снова.");
  return lines.join("\n");
}

export class TaskPanels {
  private readonly startedAt = Date.now();
  private readonly live = new Map<string, TaskDetails>();
  private lastCatalogAt = 0;
  private catalogCount: number | null = null;

  constructor(private readonly access: OwnerAccess, private readonly desktop: DesktopTasks, private readonly chat: BridgeChat, private readonly store: BridgeStore, private readonly gate: AccessGate) {}

  observe(bindingId: string, details: TaskDetails): void {
    this.live.set(bindingId, details);
    const key = `task-details:${bindingId}`;
    if (JSON.stringify(this.store.getValue(key)) !== JSON.stringify(details)) this.store.setValue(key, details);
    const rename = this.store.getValue<RenameState>(`rename:${bindingId}`);
    if (rename && details.title) {
      const liveTitleUpdated = details.title === rename.title;
      if (liveTitleUpdated !== rename.liveTitleUpdated) this.store.setValue(`rename:${bindingId}`, { ...rename, liveTitleUpdated });
    }
  }

  disconnected(bindingId: string): void { this.live.delete(bindingId); }

  async tick(): Promise<void> {
    if (Date.now() - this.lastCatalogAt > 30_000) {
      this.lastCatalogAt = Date.now();
      try {
        const tasks = await this.desktop.listTasks(); this.catalogCount = tasks.length;
        for (const binding of this.store.bindings()) {
          const task = tasks.find(task => sameTask(task, binding));
          if (task && (task.title !== binding.title || task.sourceLabel !== binding.sourceLabel || task.rolloutPath !== binding.rolloutPath)) this.store.ensureBinding(task);
        }
      } catch { this.catalogCount = null; }
    }
    for (const binding of this.store.bindings()) {
      if (!binding.attached || binding.peerId === null) this.live.delete(binding.id);
    }
  }

  async text(input: BridgeInput): Promise<boolean> {
    const text = input.text.trim();
    if (["/menu", "/status", "Меню"].includes(text) || (input.peerId === this.access.ownerId && ["/start", "/help"].includes(text))) {
      const binding = this.store.byPeer(input.peerId);
      const state = this.newState(input.peerId, binding?.id ?? null, "home", true);
      if (binding) { await this.refresh(binding); this.renderTask(binding, state); }
      else { this.lastCatalogAt = 0; await this.tick(); this.renderManager(state); }
      return true;
    }
    const state = this.state(input.peerId);
    if (!state || !["rename", "renameConfirm"].includes(state.view)) return false;
    if (text === "/cancel") { await this.home(input.peerId); return true; }
    if (state.expiresAt <= Date.now()) { await this.home(input.peerId); throw new ActionRejectedError("Время ввода названия истекло. Текст не отправлен агенту; открой переименование заново."); }
    if (state.view === "renameConfirm") throw new ActionRejectedError("Подтверди название кнопкой или отправь /cancel. Текст не отправлен агенту.");
    if (!text || text.length > 120 || /[\r\n\x00-\x1f]/u.test(text)) throw new ActionRejectedError("Название должно быть одной строкой от 1 до 120 символов. /cancel — отмена.");
    const binding = this.bound(input.peerId, state.bindingId);
    const next = this.newState(input.peerId, binding.id, "renameConfirm"); next.title = text;
    this.show(input.peerId, next, { text: `Переименовать задачу Codex и связанную VK-беседу?\n\n${short(binding.title)}\n→ ${text}\n\nВ VK сохранится префикс [VKodex]. Открытое окно Codex может продолжить показывать старое имя; его состояние проверяется отдельно.`, buttons: [this.button(input.peerId, next, "Переименовать", "renameApply", { title: text }), this.button(input.peerId, next, "Отмена", "home")] });
    return true;
  }

  async action(input: BridgeInput, action: PanelAction): Promise<void> {
    const state = this.state(input.peerId);
    if (!state || state.id !== action.screenId || state.expiresAt <= Date.now()) throw new ActionRejectedError("Это меню устарело. Открой /menu заново.");
    if ((action.bindingId ?? null) !== state.bindingId) throw new ActionRejectedError("Кнопка относится к другой задаче.");
    if (action.command === "home") { await this.home(input.peerId); return; }
    if (action.command === "projects" && input.peerId === this.access.ownerId) {
      const projects = await this.desktop.listProjects();
      const next = this.newState(input.peerId, null, "projects");
      this.show(input.peerId, next, { text: `Проекты Codex · ${projects.length}\n\n${projects.map(project => `${short(project.title)}\n${project.workspace}`).join("\n\n").slice(0, 3_000)}\n\n${this.desktop.capabilities.createTask ? "Новая задача создаётся через меню менеджера." : "Создание новых задач через это подключение пока недоступно."}`, buttons: [this.button(input.peerId, next, "Меню", "home")] }); return;
    }
    const binding = this.bound(input.peerId, state.bindingId);
    switch (action.command) {
      case "moveProject": {
        if (!this.desktop.capabilities.moveTask) throw new ActionRejectedError("Перенос между проектами недоступен в текущем подключении.");
        const projects = await this.desktop.listProjects();
        const page = Math.max(0, Math.min(Math.floor(action.page ?? 0), Math.max(0, Math.ceil(projects.length / 6) - 1)));
        const visible = projects.slice(page * 6, page * 6 + 6);
        const next = this.newState(input.peerId, binding.id, "moveProject");
        next.page = page;
        const buttons = visible.map(project => this.button(input.peerId, next, project.title, "moveProjectApply", { projectId: project.id }));
        buttons.push(this.button(input.peerId, next, "Без проекта", "moveProjectApply", { projectId: null }));
        if (page > 0) buttons.push(this.button(input.peerId, next, "Предыдущие", "moveProject", { page: page - 1 }));
        if ((page + 1) * 6 < projects.length) buttons.push(this.button(input.peerId, next, "Следующие", "moveProject", { page: page + 1 }));
        buttons.push(this.button(input.peerId, next, "Назад", "home"));
        this.show(input.peerId, next, {
          text: `Переместить «${short(binding.title)}» в проект · ${page + 1}/${Math.max(1, Math.ceil(projects.length / 6))}\n\n${visible.map(project => `${short(project.title)}\n${project.workspace}`).join("\n\n") || "Проектов нет."}\n\nМеняется принадлежность задачи проекту в Codex. Рабочая директория текущей задачи не переносится.`,
          buttons,
        }); break;
      }
      case "moveProjectApply": {
        if (!this.desktop.capabilities.moveTask || state.view !== "moveProject" || action.projectId === undefined) throw new ActionRejectedError("Выбор проекта устарел.");
        this.consume(input); this.waiting(binding, "Проверяю перенос задачи в Codex…");
        await this.desktop.moveTask(binding, action.projectId);
        const moved = (await this.desktop.listTasks()).find(task => sameTask(task, binding));
        if (!moved || moved.projectId !== action.projectId) throw new UncertainActionError();
        this.store.ensureBinding(moved);
        const project = action.projectId === null ? null : (await this.desktop.listProjects()).find(item => item.id === action.projectId);
        await this.home(input.peerId, project ? `Задача перемещена в проект «${short(project.title)}».` : "Задача теперь без проекта.");
        break;
      }
      case "models": await this.models(binding, action.page ?? 0); break;
      case "efforts": {
        const model = (await this.desktop.listModels(binding)).find(model => model.id === action.model);
        if (!model) throw new ActionRejectedError("Модель больше не доступна. Обнови список.");
        const next = this.newState(input.peerId, binding.id, "efforts"); next.model = model.id;
        this.show(input.peerId, next, { text: `${model.title}\nВыбери уровень рассуждения. Настройки применятся со следующего хода; текущий ход не прерывается.\nПо умолчанию: ${model.defaultEffort}`, buttons: model.efforts.slice(0, 8).map(effort => this.button(input.peerId, next, effort, "select", { model: model.id, effort })).concat(this.button(input.peerId, next, "Модели", "models"), this.button(input.peerId, next, "Отмена", "home")) }); break;
      }
      case "select": {
        if (!this.desktop.capabilities.selectModel || !action.model || !action.effort || state.model !== action.model) throw new ActionRejectedError("Выбор модели недоступен.");
        this.consume(input);
        this.waiting(binding, "Проверяю применение модели в Codex…");
        await this.desktop.selectModel(binding, action.model, action.effort);
        await this.home(input.peerId, `Для следующего хода: ${action.model} · ${action.effort}.`); break;
      }
      case "rename": {
        if (!this.desktop.capabilities.renameTask) throw new ActionRejectedError("Переименование недоступно в текущем подключении.");
        const next = this.newState(input.peerId, binding.id, "rename");
        this.show(input.peerId, next, { text: `Текущее название: ${short(binding.title)}\n\nПришли новое название одной строкой (до 120 символов). Этот текст не будет передан агенту. /cancel — отмена.`, buttons: [this.button(input.peerId, next, "Отмена", "home")] }); break;
      }
      case "renameApply": {
        if (state.view !== "renameConfirm" || !action.title || action.title !== state.title) throw new ActionRejectedError("Подтверждение переименования устарело.");
        const generation = this.store.streamGeneration(binding.id);
        this.consume(input); this.waiting(binding, "Проверяю переименование в Codex…");
        const result = await this.desktop.renameTask(binding, action.title);
        const renamed = (await this.desktop.listTasks()).find(task => sameTask(task, binding));
        if (!renamed || renamed.title !== action.title) throw new UncertainActionError();
        this.store.ensureBinding(renamed);
        this.store.setValue(`rename:${binding.id}`, { title: action.title, liveTitleUpdated: result.liveTitleUpdated, vkTitleUpdated: false } satisfies RenameState);
        await this.renameVk(binding, action.title, generation);
        await this.home(input.peerId); break;
      }
      case "renameVk": {
        const rename = this.renameState(binding);
        if (state.view !== "home" || !rename || rename.vkTitleUpdated || action.title !== rename.title) throw new ActionRejectedError("Повтор переименования устарел. Открой /menu заново.");
        const generation = this.store.streamGeneration(binding.id);
        this.consume(input); this.waiting(binding, "Проверяю название VK-беседы…");
        const current = (await this.desktop.listTasks()).find(task => sameTask(task, binding));
        if (!current || current.title !== rename.title) {
          if (current) this.store.ensureBinding(current);
          throw new ActionRejectedError("Имя задачи уже изменилось. Открой /menu и повтори переименование с новым именем.");
        }
        await this.renameVk(binding, rename.title, generation);
        await this.home(input.peerId); break;
      }
      case "archive": {
        if (!this.desktop.capabilities.archiveTask) throw new ActionRejectedError("Архивирование недоступно в текущем подключении.");
        await this.refresh(binding); this.canArchive(binding);
        const next = this.newState(input.peerId, binding.id, "archive");
        this.show(input.peerId, next, { text: `Архивировать «${short(binding.title)}» в Codex?\n\nТрансляция будет отключена. VK-беседа и рабочие файлы сохранятся. Вернуть задачу из архива можно в десктопе.`, buttons: [this.button(input.peerId, next, "Архивировать", "archiveApply"), this.button(input.peerId, next, "Отмена", "home")] }); break;
      }
      case "archiveApply": {
        if (state.view !== "archive") throw new ActionRejectedError("Подтверждение архива устарело.");
        await this.refresh(binding); this.canArchive(binding);
        this.consume(input); this.waiting(binding, "Запрос на архивирование отправлен. Результат появится в менеджере; после архива трансляция сюда отключится.");
        await this.desktop.archiveTask(binding);
        this.store.setAttached(binding.id, false); this.live.delete(binding.id);
        this.store.enqueue(`archive:${input.action}`, this.access.ownerId, { text: `Задача «${short(binding.title)}» архивирована в Codex. Трансляция отключена; VK-беседа и файлы сохранены.` }); break;
      }
      case "share": {
        const next = this.newState(input.peerId, binding.id, "share");
        this.show(input.peerId, next, { text: "Можно получить локальную ссылку на задачу или файл с видимой перепиской.\n\nДиплинк открывает задачу в твоём Codex и не даёт другим людям доступ. Публичную ссылку этот мост не создаёт — для неё используй «Поделиться» в десктопе.", buttons: [this.button(input.peerId, next, "Диплинк", "link"), ...(this.desktop.capabilities.exportMarkdown ? [this.button(input.peerId, next, "Markdown-файл", "export")] : []), this.button(input.peerId, next, "Назад", "home")] }); break;
      }
      case "path": {
        await this.refresh(binding);
        const workspace = this.details(binding.id).workspace;
        if (!workspace) throw new ActionRejectedError("Codex не сообщил рабочую директорию.");
        this.reply(input, { text: `Рабочая директория из Codex:\n${workspace}\n\nСкопируй текст средствами VK.` }); break;
      }
      case "link": this.reply(input, { text: `Локальная ссылка на задачу:\n${taskDeepLink(binding.threadId)}\n\nОткрывается в Codex на устройстве с этой задачей. Это не публичная ссылка.` }); break;
      case "export": {
        if (!this.desktop.capabilities.exportMarkdown) throw new ActionRejectedError("Экспорт недоступен в этом подключении.");
        this.consume(input); this.waiting(binding, "Готовлю Markdown-файл видимой переписки…");
        const markdown = await this.desktop.exportMarkdown(binding);
        if (!await this.gate.check(input.peerId, true)) throw new ActionRejectedError("Экспорт остановлен: изменился доступ к беседе.");
        const attachment = await this.chat.uploadDocument(input.peerId, "codex-conversation.md", markdown);
        // Persist the upload result before sending. Delivery retries never upload a second document.
        this.reply(input, { text: "Видимая переписка Codex в Markdown. Снимок на момент запроса; без команд и скрытых рассуждений.", attachments: [attachment] });
        await this.home(input.peerId, "Markdown-файл подготовлен."); break;
      }
      default: throw new ActionRejectedError("Кнопка недоступна в этой беседе.");
    }
  }

  private async models(binding: Binding, requestedPage: number): Promise<void> {
    if (!this.desktop.capabilities.selectModel) throw new ActionRejectedError("Выбор модели недоступен в текущем подключении.");
    const models = await this.desktop.listModels(binding);
    const page = Math.max(0, Math.min(Math.floor(requestedPage), Math.ceil(models.length / 6) - 1));
    const next = this.newState(binding.peerId!, binding.id, "models"); next.page = page;
    const visible = models.slice(page * 6, page * 6 + 6);
    const buttons = visible.map(model => this.button(binding.peerId!, next, model.title, "efforts", { model: model.id }));
    if (page > 0) buttons.push(this.button(binding.peerId!, next, "Предыдущие", "models", { page: page - 1 }));
    if ((page + 1) * 6 < models.length) buttons.push(this.button(binding.peerId!, next, "Следующие", "models", { page: page + 1 }));
    buttons.push(this.button(binding.peerId!, next, "Отмена", "home"));
    this.show(binding.peerId!, next, { text: `Модели Codex · ${page + 1}/${Math.ceil(models.length / 6)}\n\n${visible.map(model => `${model.title}\n${model.id}`).join("\n\n")}\n\nПосле модели выбери уровень рассуждения. Текущий ход продолжит работу со старыми настройками.`, buttons });
  }

  private async refresh(binding: Binding): Promise<void> {
    try { this.observe(binding.id, await this.desktop.inspectTask(binding)); }
    catch (error) { this.disconnected(binding.id); throw error; }
  }
  private renameState(binding: Binding): RenameState | null {
    const rename = this.store.getValue<RenameState>(`rename:${binding.id}`);
    return rename?.title === binding.title ? rename : null;
  }
  private async renameVk(binding: Binding, title: string, generation: number): Promise<void> {
    const beforeWrite = async () => {
      if (generation !== this.store.streamGeneration(binding.id) || !await this.gate.check(binding.peerId!, true)) {
        throw new ActionRejectedError("Имя сохранено в Codex, но VK-беседа не изменена: трансляция отключена.");
      }
      this.bound(binding.peerId!, binding.id);
      if (generation !== this.store.streamGeneration(binding.id)) throw new ActionRejectedError("Трансляция отключена во время переименования. VK-беседа не изменена.");
    };
    await beforeWrite();
    let vkTitleUpdated = false;
    try { await this.chat.renameConversation(binding.peerId!, taskChatTitle(title), beforeWrite); vkTitleUpdated = true; }
    catch { /* Keep the confirmed Codex rename; only VK may be retried explicitly. */ }
    const current = this.store.getValue<RenameState>(`rename:${binding.id}`);
    if (current?.title === title) this.store.setValue(`rename:${binding.id}`, { ...current, vkTitleUpdated });
  }
  private details(bindingId: string): TaskDetails { return this.live.get(bindingId) ?? { ...(this.store.getValue<TaskDetails>(`task-details:${bindingId}`) ?? unknownDetails), status: "unavailable" }; }
  private canArchive(binding: Binding): void {
    if (!["idle", "failed", "interrupted"].includes(this.details(binding.id).status)) throw new ActionRejectedError("Архив доступен после завершения хода и ответов на вопросы Codex.");
  }
  private bound(peerId: number, bindingId: string | null): Binding {
    const binding = bindingId && this.store.getBinding(bindingId);
    if (!binding || binding.peerId !== peerId || !binding.attached) throw new ActionRejectedError("Эта кнопка не относится к активной связи беседы.");
    return binding;
  }
  private consume(input: BridgeInput): void {
    if (!input.action || !this.store.consumeAction(input.action, input.peerId)) throw new ActionRejectedError("Операция уже отправлена или кнопка устарела. Автоматического повтора не будет.");
  }
  private reply(input: BridgeInput, view: View): void {
    const binding = this.store.byPeer(input.peerId);
    this.store.enqueue(`panel-reply:${input.peerId}:${input.eventId}`, input.peerId, { ...view, silent: true }, binding?.id ?? null);
  }
  private state(peerId: number): PanelState | null { return this.store.getValue<PanelState>(`panel:${peerId}`); }
  private newState(peerId: number, bindingId: string | null, view: PanelState["view"], fresh = false): PanelState {
    const state: PanelState = { id: randomUUID(), messageKey: (!fresh && this.state(peerId)?.messageKey) || `panel:${peerId}:${randomUUID()}`, bindingId, view, page: 0, expiresAt: Date.now() + 30 * 60_000, tokens: {} };
    this.store.setValue(`panel:${peerId}`, state); return state;
  }
  private token(peerId: number, state: PanelState, label: string, action: ManagerAction): Button {
    const key = JSON.stringify(action); let token = state.tokens[key];
    if (!token || token.expiresAt - Date.now() < 5 * 60_000) {
      token = { id: this.store.action(action, Date.now(), peerId), expiresAt: Date.now() + 30 * 60_000 }; state.tokens[key] = token;
    }
    return { label: short(label, 40), action: token.id };
  }
  private button(peerId: number, state: PanelState, label: string, command: PanelAction["command"], extra: Partial<Pick<PanelAction, "page" | "model" | "effort" | "title" | "projectId">> = {}): Button {
    return this.token(peerId, state, label, { type: "panel", screenId: state.id, command, ...(state.bindingId ? { bindingId: state.bindingId } : {}), ...extra });
  }
  private show(peerId: number, state: PanelState, view: View): void {
    if (state.view === "home") state.expiresAt = Date.now() + 30 * 60_000;
    this.store.setValue(`panel:${peerId}`, state);
    this.store.enqueue(state.messageKey, peerId, { ...view, silent: true }, state.bindingId, "panel");
  }
  private renderTask(binding: Binding, state: PanelState): void {
    if (binding.peerId === null) return;
    const button = (label: string, command: PanelAction["command"]) => this.button(binding.peerId!, state, label, command);
    const buttons = [button("Модель / рассуждение", "models"), button("Обновить", "home")];
    if (this.desktop.capabilities.renameTask) buttons.push(button("Переименовать", "rename"));
    if (this.desktop.capabilities.archiveTask) buttons.push(button("Архивировать", "archive"));
    if (this.desktop.capabilities.moveTask) buttons.push(button("Переместить в проект", "moveProject"));
    buttons.push(button("Поделиться", "share"), button("Рабочая директория", "path"), button("Диплинк", "link"));
    if (this.desktop.capabilities.exportMarkdown) buttons.push(button("Markdown-файл", "export"));
    const rename = this.renameState(binding);
    if (rename && !rename.vkTitleUpdated) buttons.push(this.button(binding.peerId, state, "Повторить для VK", "renameVk", { title: rename.title }));
    const renameStatus = rename ? [
      rename.liveTitleUpdated ? "Codex: новое имя подтверждено в открытой задаче." : "Codex: новое имя сохранено в каталоге, но открытая задача его ещё не подтвердила. Для немедленного обновления окна используй переименование в самом Codex.",
      rename.vkTitleUpdated ? `VK: ${taskChatTitle(rename.title)}` : "VK: переименование не подтверждено. «Повторить для VK» проверит название и повторит только этот шаг.",
    ].join("\n") : "";
    this.show(binding.peerId, state, { text: [taskCardText(binding, this.details(binding.id)), renameStatus, state.note].filter(Boolean).join("\n\n"), buttons });
  }
  private renderManager(state: PanelState): void {
    const bindings = this.store.bindings(); const active = bindings.filter(binding => binding.attached && binding.peerId !== null);
    const text = [
      "VKodex · менеджер",
      `Процесс: ${path.basename(process.execPath)}`,
      `Мост работает: ${number((Date.now() - this.startedAt) / 60_000)} мин`,
      `Задач в каталоге: ${this.catalogCount ?? "нет данных"}`,
      `Связанных бесед: ${bindings.filter(binding => binding.peerId !== null).length}`,
      `Трансляция включена: ${active.length}`,
      `Подключено к Codex: ${active.filter(binding => this.live.has(binding.id)).length}`,
      `Сообщений в очереди: ${this.store.pendingCount()}`, "",
      ...(this.desktop.compatibility ? [`Live API: ${this.desktop.compatibility().state}`, this.desktop.compatibility().message, ""] : []),
      ...(this.desktop.catalogWarnings?.() ?? []),
      "Комментарии — тихо; готовые ответы — с уведомлением.", "Команды и изменения файлов не пересылаются.", "",
      "Выбери проект, затем задачу, чтобы открыть связанную VK-беседу. /menu — открыть меню снова.",
    ];
    this.show(this.access.ownerId, state, { text: text.join("\n"), buttons: [this.token(this.access.ownerId, state, "Задачи Codex", { type: "browseProjects", page: 0 }), this.token(this.access.ownerId, state, "Новая задача", { type: "new" }), this.button(this.access.ownerId, state, "Проекты", "projects"), this.button(this.access.ownerId, state, "Обновить", "home")] });
  }
  private waiting(binding: Binding, note: string): void { const state = this.newState(binding.peerId!, binding.id, "home"); state.note = note; this.renderTask(binding, state); }
  private async home(peerId: number, note?: string): Promise<void> {
    const binding = this.store.byPeer(peerId); const state = this.newState(peerId, binding?.id ?? null, "home");
    if (note) state.note = note;
    if (binding) { await this.refresh(binding); this.renderTask(this.store.getBinding(binding.id)!, state); }
    else { this.lastCatalogAt = 0; await this.tick(); this.renderManager(state); }
  }

  failure(peerId: number, error: unknown): void {
    const state = this.state(peerId); const binding = this.store.byPeer(peerId);
    if (state?.view !== "home" || !binding || !binding.attached) return;
    state.note = error instanceof ActionRejectedError || error instanceof DesktopUnavailableError || error instanceof UncertainActionError ? error.message : "Операция не подтверждена. Проверь результат в Codex; автоматического повтора не будет.";
    this.renderTask(binding, state);
  }
}
