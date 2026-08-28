import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "better-sqlite3";
import { VK } from "vk-io";
import type { BridgeChat, BridgeInput, MessageHandle, View } from "../src/bridge/contracts.js";
import { AccessGate, DeliveryWorker } from "../src/bridge/delivery.js";
import { TaskManager } from "../src/bridge/manager.js";
import { TaskMirror } from "../src/bridge/mirror.js";
import { BridgeStore } from "../src/bridge/store.js";
import { loadDesktopBridgeConfig } from "../src/bridge/config.js";
import { ActionRejectedError, UncertainActionError, type CreateTaskRequest, type DesktopProject, type DesktopTask, type DesktopTasks, type SubmitTaskRequest, type TaskRef, type TaskDetails, type DesktopModel, type TaskRenameResult } from "../src/desktop/contracts.js";
import { DesktopVkGateway, hasVkAttachments, vkKeyboard, vkSendParams } from "../src/platforms/vk/desktop-gateway.js";
import { projectSnapshot } from "../src/desktop/projector.js";

// Deliberately fictional fixture IDs; production identity is supplied only through local configuration.
const access = { ownerId: 101, groupId: 202 };
const task: DesktopTask = { hostId: "local", threadId: "task-a", title: "Existing desktop task", workspace: "/project", projectId: "project-a", updatedAt: 10 };
const peerId = 2_000_000_017;

class Chat implements BridgeChat {
  participants = [access.ownerId, -access.groupId];
  readonly sent: { peerId: number; view: View; randomId: number; handle: MessageHandle }[] = [];
  readonly sendAttempts: { peerId: number; view: View; randomId: number }[] = [];
  readonly edits: { handle: MessageHandle; view: View }[] = [];
  creates = 0;
  invites = 0;
  readonly renames: { peerId: number; title: string }[] = [];
  renameError: Error | null = null;
  createError: Error | null = null;
  inviteError: Error | null = null;
  lostSendResponse = false;
  failEdits = false;
  memberError = false;
  readonly uploads: { peerId: number; name: string; contents: string }[] = [];
  async uploadDocument(peerId: number, name: string, contents: string): Promise<string> { this.uploads.push({ peerId, name, contents }); return "doc-202_42_fixture"; }
  async members(): Promise<readonly number[]> { if (this.memberError) throw new Error("offline"); return this.participants; }
  async createConversation(): Promise<{ peerId: number; chatId: number }> {
    this.creates++;
    if (this.createError) throw this.createError;
    return { peerId, chatId: 17 };
  }
  async inviteLink(): Promise<string> { this.invites++; if (this.inviteError) throw this.inviteError; return "https://vk.me/join/fixture"; }
  async renameConversation(peerId: number, title: string, beforeWrite: () => Promise<void>): Promise<void> {
    await beforeWrite(); this.renames.push({ peerId, title });
    if (this.renameError) throw this.renameError;
  }
  async send(peer: number, view: View, randomId: number): Promise<MessageHandle> {
    this.sendAttempts.push({ peerId: peer, view, randomId });
    const previous = this.sent.find(item => item.randomId === randomId);
    if (previous) return previous.handle;
    const handle = { peerId: peer, conversationMessageId: this.sent.length + 1 };
    this.sent.push({ peerId: peer, view, randomId, handle });
    if (this.lostSendResponse) { this.lostSendResponse = false; throw new Error("timeout after delivery"); }
    return handle;
  }
  async edit(handle: MessageHandle, view: View): Promise<void> { if (this.failEdits) throw new Error("edit expired"); this.edits.push({ handle, view }); }
}

class Desktop implements DesktopTasks {
  capabilities = { createTask: true, startTurn: true, steerTurn: true, interruptTurn: true, selectModel: true, renameTask: true, archiveTask: true, exportMarkdown: true };
  tasks: DesktopTask[] = [task];
  projects: DesktopProject[] = [{ id: "project-a", title: "Project", workspace: "/project" }];
  projectsError: Error | null = null;
  readonly creations: CreateTaskRequest[] = [];
  readonly submissions: SubmitTaskRequest[] = [];
  readonly stops: TaskRef[] = [];
  createError: Error | null = null;
  submitError: Error | null = null;
  details: TaskDetails = { status: "idle", workspace: "/project", model: "model-a", effort: "medium", nextModel: "model-a", nextEffort: "medium", context: { used: 25_000, window: 100_000, percent: 25 } };
  models: DesktopModel[] = [{ id: "model-a", title: "Model A", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "model-b", title: "Model B", efforts: ["high"], defaultEffort: "high" }];
  readonly selections: { task: TaskRef; model: string; effort: string }[] = [];
  readonly renames: { task: TaskRef; title: string }[] = [];
  readonly archives: TaskRef[] = [];
  selectError: Error | null = null;
  renameError: Error | null = null;
  liveTitleUpdated = true;
  renameHook: (() => void) | null = null;
  exportHook: (() => void) | null = null;
  async inspectTask() { return this.details; }
  async listModels() { return this.models; }
  async selectModel(task: TaskRef, model: string, effort: string): Promise<void> {
    if (!this.models.find(item => item.id === model)?.efforts.includes(effort)) throw new ActionRejectedError("Invalid model");
    this.selections.push({ task, model, effort }); if (this.selectError) throw this.selectError;
    this.details = { ...this.details, nextModel: model, nextEffort: effort };
  }
  async renameTask(ref: TaskRef, title: string): Promise<TaskRenameResult> {
    this.renames.push({ task: ref, title }); this.renameHook?.();
    if (this.renameError) throw this.renameError;
    this.tasks = this.tasks.map(task => task.threadId === ref.threadId ? { ...task, title } : task);
    return { liveTitleUpdated: this.liveTitleUpdated };
  }
  async archiveTask(ref: TaskRef): Promise<void> { this.archives.push(ref); this.tasks = this.tasks.filter(task => task.threadId !== ref.threadId); }
  async exportMarkdown(): Promise<string> { this.exportHook?.(); return "# Fixture\n\nVisible conversation"; }
  async listTasks() { return this.tasks; }
  async listProjects() { if (this.projectsError) throw this.projectsError; return this.projects; }
  async createTask(request: CreateTaskRequest): Promise<DesktopTask> {
    this.creations.push(request);
    if (this.createError) throw this.createError;
    const created = { ...task, threadId: "new-task", title: request.title };
    this.tasks.push(created);
    return created;
  }
  async submit(request: SubmitTaskRequest): Promise<void> { this.submissions.push(request); if (this.submitError) throw this.submitError; }
  async interrupt(ref: TaskRef): Promise<void> { this.stops.push(ref); }
}

function setup(t: { after(fn: () => void): void }) {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new Chat(); const desktop = new Desktop();
  const gate = new AccessGate(access, chat, store);
  const manager = new TaskManager(access, desktop, chat, store, gate);
  let time = 100_000;
  const worker = new DeliveryWorker(chat, store, gate, 3_000, () => time);
  const mirror = new TaskMirror(store);
  let sequence = 0;
  const input = (text: string, peer = access.ownerId, action?: string): BridgeInput => ({ eventId: `e${sequence++}`, senderId: access.ownerId, peerId: peer, text, ...(action ? { action } : {}) });
  const handle = async (text: string, peer = access.ownerId, action?: string) => { await manager.handle(input(text, peer, action)); await worker.flush(); };
  const attach = () => { const binding = store.ensureBinding(task); store.setChat(binding.id, peerId, 17); return store.getBinding(binding.id)!; };
  return { store, chat, desktop, gate, manager, worker, mirror, input, handle, attach, advance: () => { time += 3_000; } };
}

function panelView(s: ReturnType<typeof setup>, peer = peerId): View {
  const sent = s.chat.sent.filter(message => message.peerId === peer && message.view.buttons?.length).at(-1)!;
  return s.chat.edits.filter(edit => edit.handle.peerId === peer && edit.handle.conversationMessageId === sent.handle.conversationMessageId).at(-1)?.view ?? sent.view;
}

async function clickPanel(s: ReturnType<typeof setup>, label: string, peer = peerId): Promise<void> {
  const button = panelView(s, peer).buttons!.find(button => button.label === label);
  assert.ok(button, `Missing button ${label}`);
  s.advance(); await s.handle("", peer, button.action); s.advance(); await s.worker.flush();
}

test("manager menu shows bridge information and routes task list buttons", async t => {
  const s = setup(t); s.attach();
  await s.handle("/menu");
  const dashboard = panelView(s, access.ownerId);
  assert.match(dashboard.text, /VKodex · менеджер/u);
  assert.match(dashboard.text, /Связанных бесед: 1/u);
  assert.equal(dashboard.silent, true);
  assert.deepEqual(dashboard.buttons!.map(button => button.label), ["Задачи Codex", "Новая задача", "Проекты", "Обновить"]);
  await clickPanel(s, "Задачи Codex", access.ownerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /В каком проекте/u);
  assert.doesNotMatch(s.chat.sent.at(-1)!.view.text, /Existing desktop task/u);
  await clickPanel(s, "1. Project", access.ownerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /Existing desktop task/u);
});

test("task card only refreshes on request and never replaces an open model chooser", async t => {
  const s = setup(t); const binding = s.attach();
  await s.handle("/menu", peerId);
  assert.equal(s.desktop.submissions.length, 0);
  assert.match(panelView(s).text, /25.0%/u); assert.equal(panelView(s).silent, true);
  const count = s.chat.sent.length; const actions = panelView(s).buttons;
  s.desktop.details = { ...s.desktop.details, context: { used: 40_000, window: 100_000, percent: 40 } };
  s.manager.panels.observe(binding.id, s.desktop.details);
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, count); assert.match(panelView(s).text, /25.0%/u);
  assert.deepEqual(panelView(s).buttons, actions);
  assert.equal(s.chat.edits.length, 0);
  await clickPanel(s, "Обновить");
  assert.equal(s.chat.sent.length, count); assert.match(panelView(s).text, /40.0%/u);
  await clickPanel(s, "Модель / рассуждение");
  const chooser = panelView(s);
  s.manager.panels.observe(binding.id, { ...s.desktop.details, status: "running" });
  await s.manager.panels.tick(); s.advance(); await s.worker.flush();
  assert.deepEqual(panelView(s), chooser);
});

test("ticks, snapshots and restarts never open or revive menus", async t => {
  const s = setup(t); const binding = s.attach();
  s.manager.panels.observe(binding.id, s.desktop.details);
  await s.manager.panels.tick(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);
  assert.equal(s.store.getValue(`panel:${peerId}`), null);
  assert.equal(s.store.getValue(`panel:${access.ownerId}`), null);
  await s.manager.handle(s.input("/menu", peerId));
  assert.ok(s.store.pendingDeliveries().some(item => item.kind === "panel"));
  s.store.recover(); await s.manager.panels.tick(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);
  await s.handle("/menu", peerId);
  assert.equal(s.chat.sent.length, 1);
  const state = s.store.getValue<Record<string, unknown>>(`panel:${peerId}`)!;
  s.store.setValue(`panel:${peerId}`, { ...state, expiresAt: 1 });
  await s.manager.panels.tick(); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 1); assert.equal(s.chat.edits.length, 0);
});

test("normal message errors do not update a previously requested menu", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId);
  s.desktop.submitError = new ActionRejectedError("Task unavailable");
  await s.handle("Continue", peerId); s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.length, 0);
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 1);
  assert.match(s.chat.sent.at(-1)!.view.text, /Task unavailable/u);
});

test("project move option explains the desktop requirement without faking a successful move", async t => {
  const s = setup(t); const binding = s.attach();
  await s.handle("/menu", peerId);
  assert.ok(panelView(s).buttons!.length <= 12);
  await clickPanel(s, "Переместить в проект");
  assert.match(panelView(s).text, /Автоматический перенос через VK пока недоступен/u);
  const instructions = panelView(s);
  s.manager.panels.observe(binding.id, { ...s.desktop.details, status: "running" });
  await s.manager.panels.tick(); s.advance(); await s.worker.flush();
  assert.deepEqual(panelView(s), instructions);
  await clickPanel(s, "Диплинк");
  assert.match(s.chat.sent.at(-1)!.view.text, /codex:\/\/threads\/task-a/u);
  assert.equal(s.desktop.creations.length, 0); assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.desktop.stops.length, 0); assert.deepEqual(s.store.getBinding(binding.id), binding);
});

test("model selection stays in the same task, preserves the running model and is one-shot", async t => {
  const s = setup(t); s.attach(); s.desktop.details = { ...s.desktop.details, status: "running" };
  await s.handle("/menu", peerId); await clickPanel(s, "Модель / рассуждение"); await clickPanel(s, "Model B");
  const action = panelView(s).buttons!.find(button => button.label === "high")!.action;
  await clickPanel(s, "high");
  assert.equal(s.desktop.selections.length, 1);
  assert.equal(s.desktop.selections[0]!.task.threadId, task.threadId);
  assert.equal(s.desktop.submissions.length, 0);
  assert.match(panelView(s).text, /Модель: model-a/u);
  assert.match(panelView(s).text, /Следующий ход: model-b · high/u);
  await s.handle("", peerId, action);
  assert.equal(s.desktop.selections.length, 1);
});

test("model buttons cannot cross conversations or be replayed after cancellation", async t => {
  const s = setup(t); s.attach();
  const other = s.store.ensureBinding({ ...task, threadId: "other" }); s.store.setChat(other.id, peerId + 1, 18);
  await s.handle("/menu", peerId); await clickPanel(s, "Модель / рассуждение"); await clickPanel(s, "Model B");
  const action = panelView(s).buttons!.find(button => button.label === "high")!.action;
  await s.handle("", peerId + 1, action); await s.handle("", access.ownerId, action);
  assert.equal(s.desktop.selections.length, 0);
  await clickPanel(s, "Отмена"); await s.handle("", peerId, action);
  assert.equal(s.desktop.selections.length, 0);
  const managerOnly = s.store.action({ type: "open", task });
  await s.handle("", peerId, managerOnly); assert.equal(s.chat.creates, 0);
});

test("a lost model acknowledgment cannot repeat a mutation after recovery", async t => {
  const s = setup(t); s.attach(); s.desktop.selectError = new UncertainActionError();
  await s.handle("/menu", peerId); await clickPanel(s, "Модель / рассуждение"); await clickPanel(s, "Model B");
  const action = panelView(s).buttons!.find(button => button.label === "high")!.action;
  await clickPanel(s, "high"); s.store.recover(); await s.handle("", peerId, action);
  assert.equal(s.desktop.selections.length, 1);
});

test("rename consumes title text without forwarding and requires a fresh confirmation", async t => {
  const s = setup(t); const binding = s.attach();
  await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  await s.handle("New task title", peerId); s.advance(); await s.worker.flush();
  assert.equal(s.desktop.submissions.length, 0); assert.equal(s.desktop.renames.length, 0);
  const action = panelView(s).buttons!.find(button => button.label === "Переименовать")!.action;
  await s.handle("another line", peerId); assert.equal(s.desktop.submissions.length, 0);
  await clickPanel(s, "Переименовать");
  assert.equal(s.desktop.renames.length, 1); assert.equal(s.store.getBinding(binding.id)!.title, "New task title");
  assert.deepEqual(s.chat.renames, [{ peerId, title: "[VKodex] New task title" }]);
  assert.match(panelView(s).text, /новое имя подтверждено в открытой задаче/u);
  await s.handle("", peerId, action); assert.equal(s.desktop.renames.length, 1);
  assert.equal(s.chat.renames.length, 1);
});

test("a saved title is not reported as a live desktop rename and observations do not open menus", async t => {
  const s = setup(t); const binding = s.attach(); s.desktop.liveTitleUpdated = false;
  s.desktop.details = { ...s.desktop.details, title: task.title };
  await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  await s.handle("New title", peerId); await clickPanel(s, "Переименовать");
  assert.match(panelView(s).text, /сохранено в каталоге, но открытая задача его ещё не подтвердила/u);
  assert.match(panelView(s).text, /VK: \[VKodex\] New title/u);
  const sent = s.chat.sent.length; const edits = s.chat.edits.length;
  s.desktop.details = { ...s.desktop.details, title: "New title" };
  s.manager.panels.observe(binding.id, s.desktop.details);
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, sent); assert.equal(s.chat.edits.length, edits);
  await clickPanel(s, "Обновить");
  assert.match(panelView(s).text, /новое имя подтверждено в открытой задаче/u);
  assert.doesNotMatch(panelView(s).text, /ещё не подтвердила/u);
});

test("a VK rename failure survives recovery and retries only VK with a fresh confirmation", async t => {
  const s = setup(t); const binding = s.attach(); s.chat.renameError = new Error("PRIVATE_SENTINEL");
  await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  await s.handle("New title", peerId); await clickPanel(s, "Переименовать");
  assert.equal(s.store.getBinding(binding.id)!.title, "New title");
  assert.match(panelView(s).text, /VK: переименование не подтверждено/u);
  assert.doesNotMatch(panelView(s).text, /PRIVATE_SENTINEL/u);
  s.store.recover(); s.chat.renameError = null;
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  await restarted.handle(s.input("/menu", peerId)); s.advance(); await s.worker.flush();
  const retry = panelView(s).buttons!.find(button => button.label === "Повторить для VK")!.action;
  await restarted.handle(s.input("", peerId, retry)); s.advance(); await s.worker.flush();
  assert.equal(s.desktop.renames.length, 1); assert.equal(s.chat.renames.length, 2);
  assert.match(panelView(s).text, /VK: \[VKodex\] New title/u);
  await restarted.handle(s.input("", peerId, retry));
  assert.equal(s.chat.renames.length, 2); assert.equal(s.desktop.submissions.length, 0);
});

test("an uncertain Codex rename never changes VK or repeats the metadata write", async t => {
  const s = setup(t); s.attach(); s.desktop.renameError = new UncertainActionError();
  await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  await s.handle("New title", peerId);
  const action = panelView(s).buttons!.find(button => button.label === "Переименовать")!.action;
  await clickPanel(s, "Переименовать"); await s.handle("", peerId, action);
  assert.equal(s.desktop.renames.length, 1); assert.equal(s.chat.renames.length, 0);
});

test("VK rename retry refuses an externally changed Codex title", async t => {
  const s = setup(t); s.attach(); s.chat.renameError = new Error("offline");
  await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  await s.handle("New title", peerId); await clickPanel(s, "Переименовать");
  s.desktop.tasks = [{ ...task, title: "Later title" }]; s.chat.renameError = null;
  await clickPanel(s, "Повторить для VK");
  assert.equal(s.chat.renames.length, 1); assert.equal(s.desktop.renames.length, 1);
  assert.equal(s.store.bindings()[0]!.title, "Later title");
});

test("VK title changes stop if membership or attachment changes during Codex rename", async t => {
  for (const change of ["outsider", "departure", "detach-and-resume"]) {
    const s = setup(t); const binding = s.attach();
    s.desktop.renameHook = () => {
      if (change === "outsider") s.chat.participants.push(999);
      else if (change === "departure") s.chat.participants = [-access.groupId];
      else { s.store.stopStreaming(binding.id); s.store.setAttached(binding.id, true); }
    };
    await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
    await s.handle("New title", peerId); await clickPanel(s, "Переименовать");
    assert.equal(s.chat.renames.length, 0); assert.equal(s.desktop.renames.length, 1);
    assert.equal(s.store.getBinding(binding.id)!.title, "New title");
  }
});

test("expired rename draft never leaks the intended title to the agent", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  const state = s.store.getValue<Record<string, unknown>>(`panel:${peerId}`)!;
  s.store.setValue(`panel:${peerId}`, { ...state, expiresAt: 1 });
  await s.manager.panels.tick(); await s.handle("Expired title", peerId);
  assert.equal(s.desktop.submissions.length, 0); assert.equal(s.desktop.renames.length, 0);
});

test("archive requires confirmation, rechecks current status, and only detaches after success", async t => {
  const s = setup(t); const binding = s.attach();
  await s.handle("/menu", peerId); await clickPanel(s, "Архивировать");
  assert.equal(s.desktop.archives.length, 0);
  s.desktop.details = { ...s.desktop.details, status: "running" };
  await clickPanel(s, "Архивировать");
  assert.equal(s.desktop.archives.length, 0); assert.equal(s.store.getBinding(binding.id)!.attached, true);
  s.desktop.details = { ...s.desktop.details, status: "idle" };
  await clickPanel(s, "Архивировать");
  assert.equal(s.desktop.archives.length, 1); assert.equal(s.store.getBinding(binding.id)!.attached, false);
  assert.equal(s.desktop.stops.length, 0); assert.equal(s.chat.creates, 0);
});

test("working directory, local link and Markdown export are explicit private outputs", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId);
  await clickPanel(s, "Рабочая директория"); assert.match(s.chat.sent.at(-1)!.view.text, /\/project/u);
  await clickPanel(s, "Диплинк"); assert.match(s.chat.sent.at(-1)!.view.text, /codex:\/\/threads\/task-a/u);
  const exportAction = panelView(s).buttons!.find(button => button.label === "Markdown-файл")!.action;
  await clickPanel(s, "Markdown-файл");
  assert.equal(s.chat.uploads.length, 1); assert.equal(s.chat.uploads[0]!.peerId, peerId);
  assert.ok(s.chat.sent.some(message => message.view.attachments?.[0] === "doc-202_42_fixture"));
  await s.handle("", peerId, exportAction); assert.equal(s.chat.uploads.length, 1);
});

test("an export stops before upload when another participant joins during the read", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId);
  s.desktop.exportHook = () => { s.chat.participants.push(999); };
  await clickPanel(s, "Markdown-файл");
  assert.equal(s.chat.uploads.length, 0); assert.equal(s.store.bindings()[0]!.paused, true);
});

test("task callbacks reject non-owner input and unavailable membership", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId);
  const action = panelView(s).buttons![0]!.action;
  await s.manager.handle({ ...s.input("", peerId, action), senderId: 999 });
  s.chat.memberError = true; await s.handle("", peerId, action);
  assert.equal(s.desktop.selections.length, 0); assert.equal(s.store.bindings()[0]!.paused, true);
});

test("manager lists desktop tasks and reuses one binding across repeated clicks and title changes", async t => {
  const s = setup(t);
  await s.handle("/list");
  await clickPanel(s, "Все подряд", access.ownerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /Existing desktop task/u);
  const button = s.chat.sent.at(-1)!.view.buttons![0]!;
  await Promise.all([s.handle("", access.ownerId, button.action), s.handle("", access.ownerId, button.action)]);
  assert.equal(s.chat.creates, 1);
  s.desktop.tasks[0] = { ...task, title: "Renamed" };
  await s.handle("", access.ownerId, button.action);
  assert.equal(s.chat.creates, 1);
  assert.equal(s.store.bindings()[0]!.title, "Renamed");
  assert.equal(s.desktop.creations.length, 0);
});

test("manager titles are concise single lines separated by blank lines", async t => {
  const s = setup(t);
  s.desktop.tasks = [
    { ...task, title: "  First\n\tname  " },
    { ...task, threadId: "long-title", title: "a".repeat(250) },
    { ...task, threadId: "blank-title", title: "  " },
  ];
  await s.handle("/list");
  await clickPanel(s, "Все подряд", access.ownerId);
  const view = s.chat.sent.at(-1)!.view;
  assert.equal(view.text, `Все подряд\n\nЗадачи Codex · 1–3 из 3\n\n1. First name\n\n2. ${"a".repeat(119)}…\n\n3. Без названия`);
  assert.equal(view.buttons![0]!.label, "First name");
  assert.equal(view.buttons![1]!.label, `${"a".repeat(39)}…`);
  assert.equal(view.buttons![2]!.label, "Без названия");
  const action = s.store.getAction(view.buttons![0]!.action);
  assert.equal(action?.type, "open");
  if (action?.type === "open") assert.equal(action.task.threadId, task.threadId);
});

test("project selection filters by assignment, and both no-project and all scopes remain available", async t => {
  const s = setup(t);
  s.desktop.projects.push({ id: "other-project", title: "Other", workspace: "/project" });
  s.desktop.tasks = [task,
    { ...task, threadId: "other", title: "Other task", projectId: "other-project" },
    { ...task, threadId: "loose", title: "Loose task", projectId: null },
    { hostId: "local", threadId: "unknown", title: "Unknown task", workspace: "/project", updatedAt: 1 },
  ];
  await s.handle("/list");
  assert.match(panelView(s, access.ownerId).text, /Без проекта · 1/u);
  assert.match(panelView(s, access.ownerId).text, /Все подряд · 4/u);
  assert.doesNotMatch(panelView(s, access.ownerId).text, /Existing desktop task|Loose task/u);
  await clickPanel(s, "1. Project", access.ownerId);
  const openedIds = () => panelView(s, access.ownerId).buttons!.map(button => s.store.getAction(button.action)).filter(action => action?.type === "open").map(action => action.task.threadId);
  assert.deepEqual(openedIds(), [task.threadId]);
  await clickPanel(s, "Выбрать проект", access.ownerId);
  await clickPanel(s, "Без проекта", access.ownerId);
  assert.deepEqual(openedIds(), ["loose"]);
  await clickPanel(s, "Выбрать проект", access.ownerId);
  await clickPanel(s, "Все подряд", access.ownerId);
  assert.deepEqual(openedIds(), [task.threadId, "other", "loose", "unknown"]);
  assert.equal(s.chat.creates, 0); assert.equal(s.desktop.creations.length, 0);
});

test("filtered pagination survives restart, keeps its scope, and refreshes membership", async t => {
  const s = setup(t);
  s.desktop.tasks = Array.from({ length: 13 }, (_, i) => ({ ...task, threadId: `selected-${i}`, title: `Selected ${i}` }));
  s.desktop.tasks.push({ ...task, threadId: "loose", title: "Not in project", projectId: null });
  await s.handle("/list"); await clickPanel(s, "1. Project", access.ownerId);
  const next = panelView(s, access.ownerId).buttons!.find(button => button.label === "Далее")!;
  s.store.recover();
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  await restarted.handle(s.input("", access.ownerId, next.action)); await s.worker.flush();
  assert.match(panelView(s, access.ownerId).text, /7–12 из 13/u);
  assert.doesNotMatch(panelView(s, access.ownerId).text, /Not in project/u);
  assert.equal(JSON.parse(vkKeyboard(panelView(s, access.ownerId))).buttons.length, 6);
  await clickPanel(s, "Далее", access.ownerId);
  assert.match(panelView(s, access.ownerId).text, /13–13 из 13/u);
  s.desktop.tasks = [{ ...task, title: "Remaining" }];
  await clickPanel(s, "Обновить", access.ownerId);
  assert.match(panelView(s, access.ownerId).text, /1–1 из 1/u);
  assert.match(panelView(s, access.ownerId).text, /Remaining/u);
});

test("project picker paginates without losing special scopes or confusing equal names", async t => {
  const s = setup(t);
  s.desktop.projects = Array.from({ length: 15 }, (_, i) => ({ id: `project-${i}`, title: "Same name", workspace: `/project-${i}` }));
  s.desktop.tasks = [{ ...task, projectId: "project-7" }];
  await s.handle("/list"); await clickPanel(s, "Далее", access.ownerId);
  const view = panelView(s, access.ownerId);
  assert.match(view.text, /7–12 из 15/u);
  assert.ok(view.buttons!.some(button => button.label === "Без проекта"));
  assert.ok(view.buttons!.some(button => button.label === "Все подряд"));
  assert.ok(JSON.parse(vkKeyboard(view)).buttons.length <= 6);
  await clickPanel(s, "8. Same name", access.ownerId);
  assert.match(panelView(s, access.ownerId).text, /Existing desktop task/u);
  assert.equal(s.chat.creates, 0);
});

test("empty scopes allow changing the project, and stale projects are revalidated", async t => {
  const s = setup(t);
  await s.handle("/list");
  const projectButton = panelView(s, access.ownerId).buttons![0]!;
  await clickPanel(s, "Без проекта", access.ownerId);
  assert.match(panelView(s, access.ownerId).text, /В этом списке нет задач/u);
  await clickPanel(s, "Выбрать проект", access.ownerId);
  s.desktop.projects = [];
  await s.handle("", access.ownerId, projectButton.action);
  assert.match(s.chat.sent.at(-1)!.view.text, /Проект больше не доступен/u);
  assert.equal(s.chat.creates, 0);
});

test("unavailable project metadata preserves all tasks and old list buttons open the picker", async t => {
  const s = setup(t); s.desktop.projectsError = new Error("PRIVATE_SENTINEL");
  const oldButton = s.store.action({ type: "list", page: 5 }, Date.now(), access.ownerId);
  await s.handle("", access.ownerId, oldButton);
  assert.match(panelView(s, access.ownerId).text, /В каком проекте/u);
  assert.match(panelView(s, access.ownerId).text, /Список проектов недоступен/u);
  assert.doesNotMatch(panelView(s, access.ownerId).text, /PRIVATE_SENTINEL/u);
  await clickPanel(s, "Все подряд", access.ownerId);
  assert.match(panelView(s, access.ownerId).text, /Existing desktop task/u);
});

test("same task title on different hosts does not share a binding", t => {
  const s = setup(t);
  assert.notEqual(s.store.ensureBinding(task).id, s.store.ensureBinding({ ...task, hostId: "other-host" }).id);
});

test("a community-only chat gets an owner invitation without starting the task mirror", async t => {
  const s = setup(t); s.chat.participants = [-access.groupId];
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action);
  const binding = s.store.bindings()[0]!;
  assert.equal(binding.paused, true);
  assert.equal(binding.chatState, "ready");
  const invitation = s.chat.sent.at(-1)!;
  assert.equal(invitation.peerId, access.ownerId);
  assert.match(invitation.view.text, /https:\/\/vk\.me\/join\/fixture/u);
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Private activity" });
  await s.handle("continue", peerId);
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 0);
  assert.equal(s.desktop.submissions.length, 0);
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.creates, 1);
  s.chat.participants = [access.ownerId, -access.groupId];
  await s.handle("", access.ownerId, invitation.view.buttons![0]!.action);
  assert.equal(s.store.getBinding(binding.id)!.paused, false);
  await s.handle("continue", peerId);
  assert.equal(s.desktop.submissions.length, 1);
});

test("failed invitation lookup preserves the chat and permits retry without recreation", async t => {
  const s = setup(t); s.chat.participants = [-access.groupId]; s.chat.inviteError = new Error("offline");
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action);
  assert.equal(s.store.bindings()[0]!.paused, true);
  assert.equal(s.store.bindings()[0]!.chatState, "ready");
  s.store.recover(); s.chat.inviteError = null;
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.creates, 1);
  assert.match(s.chat.sent.at(-1)!.view.text, /https:\/\/vk\.me\/join\/fixture/u);
});

test("unsafe or unreadable membership never produces an invitation", async t => {
  const s = setup(t); s.chat.participants = [-access.groupId, 999];
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.invites, 0);
  assert.equal(s.store.bindings()[0]!.paused, true);
  s.chat.memberError = true;
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.invites, 0);
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 0);
});

test("duplicate VK delivery cannot submit twice; a busy task receives a follow-up", async t => {
  const s = setup(t); s.attach();
  const input = s.input("Please continue", peerId);
  await Promise.all([s.manager.handle(input), s.manager.handle(input)]);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.task.threadId, task.threadId);
});

test("non-owner and unbound peers cannot read or control tasks", async t => {
  const s = setup(t); s.attach();
  await s.manager.handle({ ...s.input("/list"), senderId: 999 });
  await s.manager.handle(s.input("do work", peerId + 1));
  await s.worker.flush();
  assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.chat.sent.length, 0);
});

test("membership change pauses queued text, edits, and input, and only alerts the owner", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Reading" });
  await s.worker.flush();
  s.advance();
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Private update" });
  s.mirror.accept(binding.id, { type: "final", id: "f", turnId: "turn", text: "Private answer" });
  s.chat.participants.push(999);
  await s.worker.flush(); await s.handle("continue", peerId);
  await s.worker.flush();
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 1);
  assert.equal(s.chat.edits.length, 0);
  assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.store.getBinding(binding.id)!.paused, true);
  assert.ok(s.chat.sent.some(item => item.peerId === access.ownerId));
});

test("unavailable membership fails closed", async t => {
  const s = setup(t); const binding = s.attach(); s.chat.memberError = true;
  assert.equal(await s.gate.check(peerId), false);
  assert.equal(s.store.getBinding(binding.id)!.paused, true);
});

test("VK rename uses the local chat ID, verifies the new title and does not repeat a lost write", async t => {
  for (const loseReply of [false, true]) {
    const vk = new VK({ token: "fixture-token" });
    const config = loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" });
    const gateway = new DesktopVkGateway(config, vk);
    let title = "Old title"; let reads = 0; let writes = 0; let checks = 0;
    const nextTitle = "[VKodex] New title";
    t.mock.method(vk.api, "callWithRequest", async ({ method, params }: { method: string; params: unknown }) => {
      if (method === "messages.getConversationsById") {
        assert.deepEqual(params, { peer_ids: [peerId], group_id: access.groupId }); reads++;
        return { count: 1, items: [{ peer: { id: peerId, type: "chat" }, chat_settings: { title } }] };
      }
      assert.equal(method, "messages.editChat");
      assert.deepEqual(params, { chat_id: 17, title: nextTitle }); writes++; title = nextTitle;
      if (loseReply) throw new Error("PRIVATE_SENTINEL");
      return 1;
    });
    const beforeWrite = async () => { checks++; assert.equal(reads, 1); };
    if (loseReply) await assert.rejects(gateway.renameConversation(peerId, nextTitle, beforeWrite), error => error instanceof UncertainActionError && !error.message.includes("PRIVATE_SENTINEL"));
    else await gateway.renameConversation(peerId, nextTitle, beforeWrite);
    await gateway.renameConversation(peerId, nextTitle, beforeWrite);
    assert.equal(writes, 1); assert.equal(checks, 1); assert.equal(reads, loseReply ? 2 : 3);
  }
});

test("VK rename refuses mismatched readback and rechecks access immediately before writing", async t => {
  for (const mode of ["wrong-chat", "stale-readback", "detached"]) {
    const vk = new VK({ token: "fixture-token" });
    const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk);
    let writes = 0;
    t.mock.method(vk.api, "callWithRequest", async ({ method }: { method: string }) => {
      if (method === "messages.getConversationsById") return { count: 1, items: [{ peer: { id: mode === "wrong-chat" ? peerId + 1 : peerId, type: "chat" }, chat_settings: { title: "Old title" } }] };
      assert.equal(method, "messages.editChat"); writes++; return 1;
    });
    await assert.rejects(gateway.renameConversation(peerId, "New title", async () => {
      if (mode === "detached") throw new ActionRejectedError("Detached");
    }), UncertainActionError);
    assert.equal(writes, mode === "stale-readback" ? 1 : 0);
    await assert.rejects(gateway.renameConversation(access.ownerId, "New title", async () => {}), ActionRejectedError);
    await assert.rejects(gateway.renameConversation(peerId, "Line\nbreak", async () => {}), ActionRejectedError);
  }
});

test("VK service events detach on owner departure or bot removal, without forwarding them as prompts", async t => {
  for (const removedMemberId of [access.ownerId, -access.groupId]) {
    const s = setup(t); const binding = s.attach();
    const inputs: BridgeInput[] = [];
    const vk = new VK({ token: "fixture-token" });
    t.mock.method(vk.updates, "startPolling", async () => {});
    const config = loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" });
    const gateway = new DesktopVkGateway(config, vk);
    await gateway.start(async input => { inputs.push(input); }, async change => { await s.gate.membershipChanged(change); });
    const update = (id: number, action?: { type: string; member_id?: number }, type = "message_new", out = 0) => ({
      type, group_id: access.groupId, event_id: `fixture-${id}`, v: "5.199",
      object: { message: { id: 0, conversation_message_id: id, peer_id: peerId, from_id: access.ownerId,
        date: 100, out, text: "Fixture text", attachments: [], ...(action ? { action } : {}) }, client_info: {} },
    });
    await vk.updates.handleWebhookUpdate(update(1, { type: "chat_title_update" }));
    assert.equal(s.store.getBinding(binding.id)!.attached, true);
    s.mirror.accept(binding.id, { type: "final", id: "queued", turnId: "turn", text: "Unsent answer" });
    const departure = update(2, { type: "chat_kick_user", member_id: removedMemberId }, "message_new", 1);
    await vk.updates.handleWebhookUpdate(departure);
    assert.equal(s.store.getBinding(binding.id)!.attached, false);
    assert.equal(s.store.pendingDeliveries().filter(item => item.peerId === peerId).length, 0);
    await s.worker.flush();
    assert.equal(s.chat.sent.length, 1);
    assert.equal(s.chat.sent[0]!.peerId, access.ownerId);
    assert.equal(s.chat.sent[0]!.view.silent, true);
    await vk.updates.handleWebhookUpdate(update(3, { type: "chat_invite_user", member_id: access.ownerId }));
    assert.equal(s.store.getBinding(binding.id)!.attached, false);
    s.store.setAttached(binding.id, true);
    s.store.recover();
    await vk.updates.handleWebhookUpdate(departure);
    assert.equal(s.store.getBinding(binding.id)!.attached, true, "a replayed departure must not undo a later explicit reconnect");
    await vk.updates.handleWebhookUpdate(update(4, undefined, "message_edit"));
    await vk.updates.handleWebhookUpdate(update(5, undefined, "message_reply", 1));
    await vk.updates.handleWebhookUpdate(update(6));
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.text, "Fixture text");
    assert.equal(s.desktop.stops.length, 0);
    assert.equal(s.desktop.archives.length, 0);
  }
});

test("departure during a membership request cancels queued sends even if the API returns an old member list", async t => {
  const s = setup(t); const binding = s.attach();
  const other = s.store.ensureBinding({ ...task, threadId: "other-task" });
  s.store.setChat(other.id, peerId + 1, 18);
  s.mirror.accept(binding.id, { type: "final", id: "old", turnId: "turn", text: "Cancelled" });
  s.mirror.accept(other.id, { type: "final", id: "other", turnId: "turn", text: "Other chat" });
  s.chat.members = async () => {
    await s.gate.membershipChanged({ peerId, eventId: "membership:departed", removedMemberId: access.ownerId });
    return [access.ownerId, -access.groupId];
  };
  await s.worker.flush();
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 0);
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId + 1).length, 1);
  s.store.recover(); s.store.setAttached(binding.id, true);
  await s.worker.flush();
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 0);
});

test("departure wins over an open or resume request that is still checking membership", async t => {
  for (const mode of ["open", "resume"] as const) {
    const s = setup(t); const binding = s.attach();
    s.store.stopStreaming(binding.id);
    s.chat.members = async () => {
      await s.gate.membershipChanged({ peerId, eventId: "membership:new-departure", removedMemberId: access.ownerId });
      return [access.ownerId, -access.groupId];
    };
    const action = s.store.action(mode === "open" ? { type: "open", task } : { type: "resume", bindingId: binding.id });
    await s.handle("", access.ownerId, action);
    assert.equal(s.store.getBinding(binding.id)!.attached, false);
    assert.equal(s.chat.invites, 0);
    assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 0);
  }
});

test("departure during an ambiguous send recovery prevents follow-up edits and stale retries", async t => {
  const s = setup(t); const binding = s.attach();
  const event = { type: "progress", id: "comment", turnId: "turn", text: "First version" } as const;
  s.chat.lostSendResponse = true;
  s.mirror.accept(binding.id, event); await s.worker.flush();
  s.mirror.accept(binding.id, { ...event, text: "Never edit after leaving" });
  const send = s.chat.send.bind(s.chat);
  s.chat.send = async (peer, view, randomId) => {
    const handle = await send(peer, view, randomId);
    if (peer === peerId) await s.gate.membershipChanged({ peerId, eventId: "membership:leave", removedMemberId: access.ownerId });
    return handle;
  };
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 1);
  assert.equal(s.chat.edits.length, 0);
  s.store.recover(); s.store.setAttached(binding.id, true);
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.sendAttempts.filter(item => item.peerId === peerId).length, 2);
  assert.equal(s.chat.edits.length, 0);
});

test("an edit already in flight cannot revive a newer revision cancelled by departure", async t => {
  const s = setup(t); const binding = s.attach();
  const event = { type: "progress", id: "comment", turnId: "turn", text: "Initial" } as const;
  s.mirror.accept(binding.id, event); await s.worker.flush();
  s.mirror.accept(binding.id, { ...event, text: "Edit in flight" });
  s.chat.edit = async () => {
    s.mirror.accept(binding.id, { ...event, text: "Newer queued revision" });
    await s.gate.membershipChanged({ peerId, eventId: "membership:leave", removedMemberId: access.ownerId });
  };
  s.advance(); await s.worker.flush();
  s.store.recover();
  assert.equal(s.store.pendingDeliveries().filter(item => item.peerId === peerId).length, 0);
});

test("each comment has a silent message, streamed updates edit it, and final answers notify once", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "First" });
  await s.worker.flush();
  for (let i = 0; i < 20; i++) s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: `Update ${i}` });
  await s.worker.flush(); assert.equal(s.chat.edits.length, 0);
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.length, 1); assert.match(s.chat.edits[0]!.view.text, /Update 19/u);
  assert.equal(s.chat.edits[0]!.view.silent, true);
  s.mirror.accept(binding.id, { type: "progress", id: "p2", turnId: "turn", text: "Next comment" });
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "First", silent: true }, { text: "Next comment", silent: true }]);
  const final = { type: "final", id: "answer", turnId: "turn", text: "Done" } as const;
  s.mirror.accept(binding.id, final); s.mirror.accept(binding.id, final);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 3); assert.deepEqual(s.chat.sent[2]!.view, { text: "Done" });
});

test("desktop user messages are labeled; accepted VK input is not echoed", async t => {
  const s = setup(t); const binding = s.attach();
  await s.handle("From VK", peerId);
  const operationId = s.desktop.submissions[0]!.operationId;
  s.mirror.accept(binding.id, { type: "user", id: "echo", turnId: "turn", text: "From VK", operationId });
  s.mirror.accept(binding.id, { type: "user", id: "desktop-user", turnId: "turn", text: "From desktop" });
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), ["## user request\n\nFrom desktop"]);
});

test("every long user-message fragment is labeled and restart does not resend it", async t => {
  const s = setup(t); const binding = s.attach(); const mirror = new TaskMirror(s.store, 40);
  const prefix = "## user request\n\n";
  const event = { type: "user", id: "long-user", turnId: "turn", text: "д".repeat(100) } as const;
  mirror.accept(binding.id, event); mirror.accept(binding.id, event);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 5);
  assert.ok(s.chat.sent.every(item => item.view.text.startsWith(prefix) && item.view.text.length <= 40));
  assert.equal(s.chat.sent.map(item => item.view.text.slice(prefix.length)).join(""), event.text);
  s.store.recover();
  new TaskMirror(s.store, 40).accept(binding.id, event);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 5);
});

test("blank user messages do not send a label alone and chunk sizes must fit the label", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.accept(binding.id, { type: "user", id: "empty-user", turnId: "turn", text: " \n\t " });
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);
  assert.throws(() => new TaskMirror(s.store, "## user request\n\n".length), RangeError);
});

test("technical events and turn statuses never create VK messages", async t => {
  const s = setup(t); const binding = s.attach();
  const snapshot = { turns: [{ turnId: "turn", turnStartedAtMs: 100, status: "inProgress", items: [
    { type: "commandExecution", id: "command", command: "private command", aggregatedOutput: "private output", status: "completed", exitCode: 0 },
    { type: "fileChange", id: "files", changes: [{ path: "/fixture/hidden.ts", diff: "private diff" }] },
    { type: "mcpToolCall", id: "tool", arguments: { text: "private argument" } },
    { type: "reasoning", id: "reasoning", text: "private reasoning" },
    { type: "agentMessage", id: "comment", phase: "commentary", text: "I am checking the change." },
    { type: "agentMessage", id: "answer", phase: "final_answer", text: "Incomplete answer" },
  ] }] };
  const initial = projectSnapshot(snapshot, null, 200);
  for (const event of initial.events) s.mirror.accept(binding.id, event);
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "I am checking the change.", silent: true }]);
  snapshot.turns[0]!.status = "completed";
  snapshot.turns[0]!.items.at(-1)!.text = "Finished.";
  const completed = projectSnapshot(snapshot, initial.checkpoint);
  for (const event of completed.events) s.mirror.accept(binding.id, event);
  for (const status of ["running", "completed", "failed", "interrupted", "approval"] as const) {
    s.mirror.accept(binding.id, { type: "status", id: `status:${status}`, turnId: "turn", status });
  }
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "I am checking the change.", silent: true }, { text: "Finished." }]);
  assert.equal(s.chat.edits.length, 0);
});

test("native final_answer recovers after reconnect, notifies once, and does not replay old history", async t => {
  const s = setup(t); const binding = s.attach();
  const old = { turnId: "old", turnStartedAtMs: 50, status: "completed", items: [{ type: "agentMessage", id: "old-answer", phase: "final_answer", text: "Before attachment" }] };
  const active = { turnId: "current", turnStartedAtMs: 100, status: "inProgress", items: [{ type: "agentMessage", id: "answer", phase: "final_answer", text: "Partial" }] };
  const initial = projectSnapshot({ turns: [old, active] }, null, 200);
  for (const event of initial.events) s.mirror.accept(binding.id, event);
  await s.worker.flush(); assert.equal(s.chat.sent.length, 0);
  // The process disconnects while Codex finishes; the saved checkpoint survives.
  const completed = { turns: [old], turnHistory: { history: { entitiesByKey: { current: { ...active, status: "completed", items: [{ ...active.items[0], text: "Complete answer" }] } } } } };
  const recovered = projectSnapshot(completed, JSON.parse(JSON.stringify(initial.checkpoint)));
  for (const event of recovered.events) s.mirror.accept(binding.id, event);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 1); assert.equal(s.chat.sent[0]!.view.text, "Complete answer");
  assert.equal(s.chat.sent[0]!.view.silent, undefined);
  assert.equal(vkSendParams(peerId, s.chat.sent[0]!.view, 1).silent, undefined);
  s.store.recover();
  for (const event of recovered.events) new TaskMirror(s.store).accept(binding.id, event);
  for (const event of projectSnapshot(completed, recovered.checkpoint).events) s.mirror.accept(binding.id, event);
  await s.worker.flush(); assert.equal(s.chat.sent.length, 1);
});

test("unseen native finals from an existing checkpoint are recovered on upgrade", async t => {
  const s = setup(t); const binding = s.attach();
  const checkpoint = { since: 100, activeAtAttach: [], seen: {} };
  const snapshot = { turns: [{ turnId: "missed", turnStartedAtMs: 101, status: "completed", items: [{ type: "agentMessage", id: "missed-final", phase: "final_answer", text: "Missed final" }] }] };
  const recovered = projectSnapshot(snapshot, checkpoint);
  for (const event of recovered.events) s.mirror.accept(binding.id, event);
  s.store.recover(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 1); assert.equal(s.chat.sent[0]!.view.text, "Missed final");
  assert.equal(projectSnapshot(snapshot, recovered.checkpoint).events.length, 0);
});

test("long comments retain their text in silent chunks and stable handles", async t => {
  const s = setup(t); const binding = s.attach(); const mirror = new TaskMirror(s.store, 20);
  const event = { type: "progress", id: "long", turnId: "turn", text: "a".repeat(55) } as const;
  mirror.accept(binding.id, event); mirror.accept(binding.id, event);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 3);
  assert.equal(s.chat.sent.map(item => item.view.text).join(""), event.text);
  assert.ok(s.chat.sent.every(item => item.view.silent === true && item.view.text.length <= 20));
  const afterRestart = new TaskMirror(s.store, 20);
  afterRestart.accept(binding.id, { ...event, text: "b".repeat(55) });
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 3);
  assert.equal(s.chat.edits.map(item => item.view.text).join(""), "b".repeat(55));
});

test("shortening or clearing an unsent comment cancels its stale chunks, which can be restored", async t => {
  const s = setup(t); const binding = s.attach(); const mirror = new TaskMirror(s.store, 20);
  const event = { type: "progress", id: "long", turnId: "turn", text: "a".repeat(55) } as const;
  mirror.accept(binding.id, event);
  mirror.accept(binding.id, { ...event, text: "" });
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);
  mirror.accept(binding.id, event);
  mirror.accept(binding.id, { ...event, text: "Short" });
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "Short", silent: true }]);
  mirror.accept(binding.id, event);
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 3);
  assert.equal(s.chat.sent.slice(1).map(item => item.view.text).join(""), "a".repeat(35));
});

test("shortening a delivered comment edits away stale fragments without new messages", async t => {
  const s = setup(t); const binding = s.attach(); const mirror = new TaskMirror(s.store, 20);
  const event = { type: "progress", id: "long", turnId: "turn", text: "a".repeat(55) } as const;
  mirror.accept(binding.id, event); await s.worker.flush();
  mirror.accept(binding.id, { ...event, text: "Short" });
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 3);
  assert.equal(s.chat.edits.length, 3);
  assert.equal(s.chat.edits[0]!.view.text, "Short");
  assert.ok(s.chat.edits.every(item => item.view.silent === true && !item.view.text.includes("aaaa")));
});

test("a reused item ID in another turn still creates a separate comment", async t => {
  const s = setup(t); const binding = s.attach();
  for (const turnId of ["first-turn", "second-turn"]) s.mirror.accept(binding.id, { type: "progress", id: "same", turnId, text: "Working" });
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 2);
  assert.notEqual(s.chat.sent[0]!.randomId, s.chat.sent[1]!.randomId);
});

test("old technical outbox entries are retired on recovery without deleting history", async t => {
  const s = setup(t); const binding = s.attach();
  const db = Reflect.get(s.store, "db") as Database;
  db.prepare("INSERT INTO bridge_delivery(key, binding_id, peer_id, kind, view) VALUES (?, ?, ?, 'technical', ?)").run("technical:fixture", binding.id, peerId, JSON.stringify({ text: "Old command/file summary" }));
  assert.equal(s.store.pendingDeliveries().length, 0);
  s.mirror.accept(binding.id, { type: "progress", id: "comment", turnId: "turn", text: "New comment" });
  s.store.recover(); await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "New comment", silent: true }]);
  assert.deepEqual(db.prepare("SELECT revision, delivered_revision, handle FROM bridge_delivery WHERE key = ?").get("technical:fixture"), { revision: 1, delivered_revision: 1, handle: null });
});

test("VK serialization enables silent only for messages explicitly marked quiet", () => {
  const quiet = vkSendParams(peerId, { text: "Comment", silent: true }, 42);
  assert.equal(quiet.silent, 1);
  assert.equal(quiet.random_id, 42);
  assert.deepEqual(quiet.peer_ids, [peerId]);
  assert.equal(quiet.dont_parse_links, 1); assert.equal(quiet.disable_mentions, 1);
  assert.equal(Object.hasOwn(vkSendParams(peerId, { text: "Final" }, 43), "silent"), false);
  assert.equal(Object.hasOwn(vkSendParams(peerId, { text: "Final", silent: false }, 44), "silent"), false);
});

test("outbox retries an ambiguous send with the same random_id and retains edit handles", async t => {
  const s = setup(t); const binding = s.attach(); s.chat.lostSendResponse = true;
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "First" });
  await s.worker.flush(); assert.equal(s.store.pendingDeliveries().length, 1);
  s.advance();
  await s.worker.flush(); assert.equal(s.chat.sent.length, 1);
  const restartedWorker = new DeliveryWorker(s.chat, s.store, s.gate, 0);
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "After restart" });
  await restartedWorker.flush();
  assert.equal(s.chat.edits[0]!.handle.conversationMessageId, s.chat.sent[0]!.handle.conversationMessageId);
});

test("failed edits never degrade into a stream of new messages", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "First" }); await s.worker.flush();
  s.chat.failEdits = true; s.advance();
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Second" });
  await s.worker.flush(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 1); assert.equal(s.store.pendingDeliveries().length, 1);
});

test("progress arriving after a lost send response is edited onto the recovered message", async t => {
  const s = setup(t); const binding = s.attach(); s.chat.lostSendResponse = true;
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Before timeout" });
  await s.worker.flush();
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "After timeout" });
  const firstAttempt = s.store.pendingDeliveries()[0]!;
  assert.deepEqual(firstAttempt.firstView, { text: "Before timeout", silent: true });
  const restartedWorker = new DeliveryWorker(s.chat, s.store, s.gate, 0);
  await restartedWorker.flush();
  assert.equal(s.chat.sent.length, 1);
  assert.deepEqual(s.chat.sendAttempts.map(item => ({ randomId: item.randomId, view: item.view })), [
    { randomId: firstAttempt.id, view: { text: "Before timeout", silent: true } },
    { randomId: firstAttempt.id, view: { text: "Before timeout", silent: true } },
  ]);
  assert.match(s.chat.edits.at(-1)!.view.text, /After timeout/u);
  assert.equal(s.chat.edits.at(-1)!.view.silent, true);
  assert.equal(s.store.pendingDeliveries().length, 0);
});

test("an existing database cannot silently change its configured owner", t => {
  const s = setup(t); s.store.assertOwner(101, 202); s.store.assertOwner(101, 202);
  assert.throws(() => s.store.assertOwner(303, 202), /another configured account/u);
});

test("unknown chat creation result blocks automatic recreation, including after recovery", async t => {
  const s = setup(t); s.chat.createError = new Error("timeout");
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action); s.store.recover(); await s.handle("", access.ownerId, action);
  assert.equal(s.chat.creates, 1); assert.equal(s.store.bindings()[0]!.chatState, "uncertain");
});

test("a known rejection allows an explicit retry, without an automatic fallback chat", async t => {
  const s = setup(t); s.chat.createError = new ActionRejectedError("No permission");
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action);
  assert.equal(s.store.bindings()[0]!.chatState, "planned");
  s.chat.createError = null; await s.handle("", access.ownerId, action);
  assert.equal(s.chat.creates, 2); assert.equal(s.store.bindings()[0]!.peerId, peerId);
});

async function draft(s: ReturnType<typeof setup>): Promise<string> {
  await s.handle("/new");
  const action = s.chat.sent.at(-1)!.view.buttons![0]!.action;
  await s.handle("", access.ownerId, action); await s.handle("New title"); await s.handle("Initial prompt");
  return s.chat.sent.at(-1)!.view.buttons![0]!.action;
}

test("new-task wizard creates a desktop task once even when VK chat creation fails", async t => {
  const s = setup(t); const action = await draft(s); s.chat.createError = new Error("timeout");
  await s.handle("", access.ownerId, action); await s.handle("", access.ownerId, action);
  assert.equal(s.desktop.creations.length, 1); assert.equal(s.chat.creates, 1);
  assert.equal(s.desktop.creations[0]!.projectId, "project-a");
  assert.equal(s.desktop.creations[0]!.prompt, "Initial prompt");
  assert.equal(s.store.getDraft()!.stage, "created");
});

test("unknown desktop creation result stays blocked after restart and repeated clicks", async t => {
  const s = setup(t); const action = await draft(s); s.desktop.createError = new Error("lost response");
  await s.handle("", access.ownerId, action); s.store.recover();
  await s.handle("", access.ownerId, action); await s.handle("/new");
  assert.equal(s.desktop.creations.length, 1); assert.equal(s.store.getDraft()!.stage, "uncertain");
});

test("restart marks interrupted non-idempotent operations as uncertain", t => {
  const s = setup(t); const binding = s.store.ensureBinding(task); s.store.claimChat(binding.id);
  s.store.saveDraft({ id: "draft", stage: "creating" });
  s.store.recover();
  assert.equal(s.store.getBinding(binding.id)!.chatState, "uncertain");
  assert.equal(s.store.getDraft()!.stage, "uncertain");
});

test("detach does not interrupt or archive the actual Codex task", async t => {
  const s = setup(t); const binding = s.attach(); await s.handle("/detach", peerId);
  assert.equal(s.store.getBinding(binding.id)!.attached, false);
  assert.equal(s.desktop.stops.length, 0); assert.equal(s.desktop.tasks.length, 1);
});

test("attachments are explicitly rejected rather than silently dropped", async t => {
  const s = setup(t); s.attach();
  await s.manager.handle({ ...s.input("Use attachment", peerId), hasAttachments: true });
  assert.equal(s.desktop.submissions.length, 0);
});

test("forwarded and replied attachments are not silently stripped from a prompt", () => {
  assert.equal(hasVkAttachments({ attachments: [], forwards: [{ attachments: [{}] }] }), true);
  assert.equal(hasVkAttachments({ attachments: [], replyMessage: { attachments: [{}] } }), true);
  const cyclic: Record<string, unknown> = { attachments: [] }; cyclic.replyMessage = cyclic;
  assert.equal(hasVkAttachments(cyclic), false);
});

test("unsupported desktop operations fail before trying a substitute CLI session", async t => {
  const s = setup(t); s.desktop.capabilities.createTask = false; await s.handle("/new");
  assert.equal(s.desktop.creations.length, 0); assert.equal(s.chat.creates, 0);
});

test("config accepts one owner and never includes private values in validation errors", () => {
  const env = { VK_GROUP_TOKEN: "private-token-fixture", VK_GROUP_ID: "202", VK_OWNER_ID: "private-id-fixture" };
  assert.throws(() => loadDesktopBridgeConfig(env), error => error instanceof Error && !error.message.includes("private-id-fixture") && !error.message.includes("private-token-fixture"));
  assert.throws(() => loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101,102" }));
  assert.equal(loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101" }).access.ownerId, 101);
});

test("callback payloads contain opaque tokens, not identity, thread IDs, or paths", () => {
  const keyboard = JSON.parse(vkKeyboard({ text: "text", buttons: [{ label: "Open", action: "opaque-fixture" }] })) as { buttons: { action: { payload: string } }[][] };
  assert.deepEqual(JSON.parse(keyboard.buttons[0]![0]!.action.payload), { action: "opaque-fixture" });
});

test("manager navigation fits VK's six-row inline keyboard limit", () => {
  const keyboard = JSON.parse(vkKeyboard({ text: "tasks", buttons: Array.from({ length: 9 }, (_, i) => ({ label: `Task ${i}`, action: `action-${i}` })) })) as { buttons: unknown[][] };
  assert.equal(keyboard.buttons.length, 5);
  assert.equal(keyboard.buttons.flat().length, 9);
});
