import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "better-sqlite3";
import { APIError, VK } from "vk-io";
import type { BridgeChat, BridgeInput, MessageHandle, View } from "../src/bridge/contracts.js";
import { ChatRateLimitError, MENU_BUTTON } from "../src/bridge/contracts.js";
import { AccessGate, DeliveryWorker } from "../src/bridge/delivery.js";
import { TaskManager } from "../src/bridge/manager.js";
import { TaskMirror } from "../src/bridge/mirror.js";
import { TaskActivity } from "../src/bridge/activity.js";
import { TaskFiles } from "../src/bridge/files.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeStore } from "../src/bridge/store.js";
import { loadDesktopBridgeConfig } from "../src/bridge/config.js";
import { ActionRejectedError, UncertainActionError, type AccountUsage, type CreateTaskRequest, type DesktopProject, type DesktopTask, type DesktopTasks, type SubmitTaskRequest, type TaskRef, type TaskDetails, type DesktopModel, type TaskRenameResult } from "../src/desktop/contracts.js";
import { collectVkFiles, DesktopVkGateway, hasVkAttachments, vkKeyboard, vkSendParams } from "../src/platforms/vk/desktop-gateway.js";
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
  renameHook: (() => void) | null = null;
  renameBlock: Promise<void> | null = null;
  createError: Error | null = null;
  inviteError: Error | null = null;
  lostSendResponse = false;
  failEdits = false;
  messageSequence = 0;
  memberError = false;
  memberReads = 0;
  readonly uploads: { peerId: number; name: string; contents: string }[] = [];
  readonly binaryUploads: { name: string; contents: Buffer; kind: string }[] = [];
  async uploadFile(_peerId: number, name: string, contents: Buffer, kind: "image" | "file"): Promise<string> { this.binaryUploads.push({ name, contents, kind }); return `doc-202_${this.binaryUploads.length}`; }
  async uploadDocument(peerId: number, name: string, contents: string): Promise<string> { this.uploads.push({ peerId, name, contents }); return "doc-202_42_fixture"; }
  async members(): Promise<readonly number[]> { this.memberReads++; if (this.memberError) throw new Error("offline"); return this.participants; }
  async createConversation(): Promise<{ peerId: number; chatId: number }> {
    this.creates++;
    if (this.createError) throw this.createError;
    return { peerId, chatId: 17 };
  }
  async inviteLink(): Promise<string> { this.invites++; if (this.inviteError) throw this.inviteError; return "https://vk.me/join/fixture"; }
  async renameConversation(peerId: number, title: string, beforeWrite: () => Promise<void>): Promise<void> {
    if (this.renameBlock) await this.renameBlock;
    this.renameHook?.(); await beforeWrite(); this.renames.push({ peerId, title });
    if (this.renameError) throw this.renameError;
  }
  async send(peer: number, view: View, randomId: number): Promise<MessageHandle> {
    this.sendAttempts.push({ peerId: peer, view, randomId });
    const previous = this.sent.find(item => item.randomId === randomId);
    if (previous) return previous.handle;
    const handle = { peerId: peer, conversationMessageId: ++this.messageSequence };
    this.sent.push({ peerId: peer, view, randomId, handle });
    if (this.lostSendResponse) { this.lostSendResponse = false; throw new Error("timeout after delivery"); }
    return handle;
  }
  async edit(handle: MessageHandle, view: View): Promise<void> { if (this.failEdits) throw new Error("edit expired"); this.edits.push({ handle, view }); }
}

class Desktop implements DesktopTasks {
  capabilities = { createTask: true, startTurn: true, steerTurn: true, interruptTurn: true, selectModel: true, renameTask: true, archiveTask: true, exportMarkdown: true, moveTask: true, accountUsage: true };
  tasks: DesktopTask[] = [task];
  projects: DesktopProject[] = [{ id: "project-a", title: "Project", workspace: "/project" }];
  projectsError: Error | null = null;
  readonly creations: CreateTaskRequest[] = [];
  readonly submissions: SubmitTaskRequest[] = [];
  readonly stops: TaskRef[] = [];
  createError: Error | null = null;
  submitError: Error | null = null;
  submitHook: (() => Promise<void>) | null = null;
  details: TaskDetails = { status: "idle", workspace: "/project", model: "model-a", effort: "medium", nextModel: "model-a", nextEffort: "medium", context: { used: 25_000, window: 100_000, percent: 25 } };
  models: DesktopModel[] = [{ id: "model-a", title: "Model A", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "model-b", title: "Model B", efforts: ["high"], defaultEffort: "high" }];
  readonly selections: { task: TaskRef; model: string; effort: string }[] = [];
  readonly renames: { task: TaskRef; title: string }[] = [];
  readonly archives: TaskRef[] = [];
  usageReads = 0;
  readonly usageTasks: (TaskRef | undefined)[] = [];
  usage: AccountUsage = { planType: "pro", limits: [
    { id: "codex", name: null, primary: { usedPercent: 9, windowMinutes: 10_080, resetsAt: 1_788_643_425 }, secondary: null },
    { id: "base_model_inference", name: "gpt-reserve", primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1_788_643_425 }, secondary: null },
  ], accountLabel: "owner@example.com", sourceLabel: ".codex", credits: { hasCredits: false, unlimited: false, balance: "0" }, resetCredits: 0 };
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
  async accountUsage(task?: TaskRef): Promise<readonly AccountUsage[]> { this.usageReads++; this.usageTasks.push(task); return [this.usage]; }
  async listTasks() { return this.tasks; }
  async listProjects() { if (this.projectsError) throw this.projectsError; return this.projects; }
  async createTask(request: CreateTaskRequest): Promise<DesktopTask> {
    this.creations.push(request);
    if (this.createError) throw this.createError;
    const created = { ...task, threadId: "new-task", title: request.title };
    this.tasks.push(created);
    return created;
  }
  async submit(request: SubmitTaskRequest): Promise<void> { this.submissions.push(request); if (this.submitHook) await this.submitHook(); if (this.submitError) throw this.submitError; }
  async interrupt(ref: TaskRef): Promise<void> { this.stops.push(ref); }
  async moveTask(ref: TaskRef, projectId: string | null): Promise<void> {
    this.tasks = this.tasks.map(item => item.threadId === ref.threadId ? { ...item, projectId } : item);
  }
}

function setup(t: { after(fn: () => void): void }, enableHealth = false) {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new Chat(); const desktop = new Desktop();
  let time = 100_000;
  const gate = new AccessGate(access, store);
  let healthChecks = 0;
  const healthCheck = enableHealth ? async () => {
    healthChecks++;
    const report = { state: "ok" as const, checkedAt: time, pid: 42, uptimeSeconds: 60,
      checks: [{ name: "fixture", state: "ok" as const, detail: "All components respond." }] };
    store.setValue("health:latest", report); return report;
  } : undefined;
  const manager = new TaskManager(access, desktop, chat, store, gate, undefined, healthCheck);
  const worker = new DeliveryWorker(chat, store, gate, 3_000, () => time);
  const mirror = new TaskMirror(store);
  let sequence = 0;
  const input = (text: string, peer = access.ownerId, action?: string): BridgeInput => ({ eventId: `e${sequence++}`, senderId: access.ownerId, peerId: peer, text, ...(action ? { action } : {}) });
  const handle = async (text: string, peer = access.ownerId, action?: string) => { await manager.handle(input(text, peer, action)); await worker.flush(); };
  const attach = () => { const binding = store.ensureBinding(task); store.setChat(binding.id, peerId, 17); return store.getBinding(binding.id)!; };
  return { store, chat, desktop, gate, manager, worker, mirror, input, handle, attach, now: () => time,
    healthChecks: () => healthChecks, advance: (ms = 6_000) => { time += ms; } };
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

const settleTitleSync = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test("manager replies carry menu navigation and obsolete standalone greetings are not resumed", async t => {
  const s = setup(t); const binding = s.attach();
  s.store.enqueue("welcome:manager", access.ownerId, { text: "Old welcome", buttons: [MENU_BUTTON] });
  s.store.enqueue(`welcome:task:${binding.id}:0`, peerId, { text: "Old welcome", buttons: [MENU_BUTTON] }, binding.id);
  s.store.recover(); await s.worker.flush(); assert.equal(s.chat.sent.length, 0);
  await s.handle("Hello");
  assert.equal(s.chat.sent.length, 1); assert.deepEqual(s.chat.sent[0]!.view.buttons, [MENU_BUTTON]);
  assert.equal(s.store.getValue(`panel:${access.ownerId}`), null);
});

test("help is chat-specific and unknown owner commands redirect to it without reaching Codex", async t => {
  const s = setup(t); s.attach();
  await s.handle("/help");
  assert.match(s.chat.sent.at(-1)!.view.text, /VKodex · команды менеджера[\s\S]*\/health[\s\S]*\/new/u);
  assert.deepEqual(s.chat.sent.at(-1)!.view.buttons, [MENU_BUTTON]);

  await s.handle("/unknown-manager");
  assert.match(s.chat.sent.at(-1)!.view.text, /^Команда не найдена\.[\s\S]*команды менеджера/u);

  await s.handle("/help", peerId);
  assert.equal(s.chat.sent.at(-1)!.peerId, peerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /VKodex · команды задачи[\s\S]*\/files[\s\S]*\/detach/u);

  await s.handle("/unknown-task", peerId);
  assert.equal(s.chat.sent.at(-1)!.peerId, peerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /^Команда не найдена\.[\s\S]*команды задачи/u);
  assert.equal(s.desktop.submissions.length, 0);

  await s.manager.handle({ ...s.input("/still-a-prompt", peerId), senderId: 999 });
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.text, "/still-a-prompt");
});

test("help and unknown commands cannot become a pending rename value", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  await s.handle("/help", peerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /VKodex · команды задачи/u);
  await s.handle("/not-a-title", peerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /^Команда не найдена\./u);
  assert.equal(s.desktop.renames.length, 0);
  assert.equal(s.desktop.submissions.length, 0);
});

test("final menu shortcut is on the last chunk and opens fresh peer-scoped panels", async t => {
  const s = setup(t); const binding = s.attach(); const mirror = new TaskMirror(s.store, 40);
  const final = { type: "final", id: "final", turnId: "turn", text: "answer".repeat(24) } as const;
  mirror.accept(binding.id, final); mirror.accept(binding.id, final); await s.worker.flush();
  assert.ok(s.chat.sent.length > 1);
  assert.ok(s.chat.sent.slice(0, -1).every(item => item.view.buttons === undefined));
  assert.deepEqual(s.chat.sent.at(-1)!.view.buttons, [MENU_BUTTON]);
  assert.equal(s.chat.sent.map(item => item.view.text).join(""), final.text + "\n\nМеню задачи:");
  assert.ok(s.chat.sent.every(item => item.view.text.length <= 40));
  await s.handle("", peerId, MENU_BUTTON.action);
  assert.equal(s.store.getValue<{ bindingId: string }>(`panel:${peerId}`)!.bindingId, binding.id);
  await clickPanel(s, "Модель / рассуждение");
  const old = s.store.getValue<Record<string, unknown>>(`panel:${peerId}`)!;
  s.store.setValue(`panel:${peerId}`, { ...old, expiresAt: 1 }); s.store.recover();
  await s.handle("", peerId, MENU_BUTTON.action); assert.match(panelView(s).text, /Контекст/u);
  await s.handle("", access.ownerId, MENU_BUTTON.action); assert.match(panelView(s, access.ownerId).text, /Мост работает/u);
  const count = s.chat.sent.length;
  await s.manager.handle({ ...s.input("", peerId, MENU_BUTTON.action), senderId: 999 }); await s.worker.flush();
  assert.equal(s.chat.sent.length, count); assert.equal(s.desktop.submissions.length, 0);
});

test("manager menu separates the project overview from task browsing", async t => {
  const s = setup(t); s.attach();
  await s.handle("/menu");
  const dashboard = panelView(s, access.ownerId);
  assert.match(dashboard.text, /VKodex · менеджер/u);
  assert.match(dashboard.text, /Связанных бесед: 1/u);
  assert.equal(dashboard.silent, true);
  assert.deepEqual(dashboard.buttons!.map(button => button.label), ["Задачи Codex", "Новая задача", "Проекты", "Лимиты Codex", "Обновить"]);
  await clickPanel(s, "Проекты", access.ownerId);
  const projects = panelView(s, access.ownerId);
  assert.match(projects.text, /^Проекты Codex · 1\n\nProject\n\/project/u);
  assert.deepEqual(projects.buttons!.map(button => button.label), ["Меню"]);
  await clickPanel(s, "Меню", access.ownerId);
  await clickPanel(s, "Задачи Codex", access.ownerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /В каком проекте/u);
  assert.doesNotMatch(s.chat.sent.at(-1)!.view.text, /Existing desktop task/u);
  await clickPanel(s, "1. Project", access.ownerId);
  assert.match(s.chat.sent.at(-1)!.view.text, /Existing desktop task/u);
});

test("manager health button runs a fresh check and renders its component report", async t => {
  const s = setup(t, true);
  await s.handle("/menu");
  assert.equal(s.healthChecks(), 0);
  assert.ok(panelView(s, access.ownerId).buttons!.some(button => button.label === "Проверить здоровье"));
  await clickPanel(s, "Проверить здоровье", access.ownerId);
  assert.equal(s.healthChecks(), 1);
  assert.match(panelView(s, access.ownerId).text, /Health: OK[\s\S]*fixture: All components respond/u);
  await s.handle("/health");
  assert.equal(s.healthChecks(), 2);
});

test("account limits are available from the manager and task chat without reaching the agent", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu");
  await clickPanel(s, "Лимиты Codex", access.ownerId);
  assert.equal(s.desktop.usageReads, 1);
  assert.match(panelView(s, access.ownerId).text, /Лимиты Codex[\s\S]*Каталог: \.codex[\s\S]*Аккаунт: owner@example\.com[\s\S]*Тариф: pro[\s\S]*7 дн\.: использовано 9\.0% · осталось 91\.0%/u);
  assert.match(panelView(s, access.ownerId).text, /Luna Reserve[\s\S]*Резерв GPT-5\.6 Luna после исчерпания обычного лимита/u);
  assert.doesNotMatch(panelView(s, access.ownerId).text, /Базовые модели/u);
  assert.deepEqual(panelView(s, access.ownerId).buttons!.map(button => button.label), ["Обновить лимиты", "Меню"]);
  await clickPanel(s, "Обновить лимиты", access.ownerId); assert.equal(s.desktop.usageReads, 2);
  await s.handle("/limits", peerId);
  assert.equal(s.desktop.usageReads, 3); assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.desktop.usageTasks[0], undefined); assert.equal(s.desktop.usageTasks[1], undefined);
  assert.equal(s.desktop.usageTasks[2]!.threadId, task.threadId);
  assert.match(panelView(s).text, /Заполнение контекста конкретной задачи/u);
  await clickPanel(s, "Меню"); assert.match(panelView(s).text, /Контекст:/u);
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
  assert.equal(s.chat.sent.filter(item => item.peerId === peerId).length, 2);
  assert.equal(s.chat.sent.filter(item => item.peerId === access.ownerId).length, 0);
  assert.match(s.chat.sent.at(-1)!.view.text, /Task unavailable/u);
});

test("project move option persists the selected project without creating a task", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.projects.push({ id: "project-b", title: "Second project", workspace: "/other" });
  await s.handle("/menu", peerId);
  assert.ok(panelView(s).buttons!.length <= 12);
  await clickPanel(s, "Переместить в проект");
  assert.match(panelView(s).text, /Second project/u);
  await clickPanel(s, "Second project");
  assert.equal(s.desktop.tasks[0]!.projectId, "project-b");
  assert.match(panelView(s).text, /перемещена в проект «Second project»/u);
  assert.equal(s.desktop.creations.length, 0); assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.desktop.stops.length, 0); assert.equal(s.store.getBinding(binding.id)!.threadId, binding.threadId);
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

test("a Codex title change automatically renames the linked VK conversation once", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.tasks = [{ ...task, title: "Renamed in Codex" }];
  await s.manager.panels.tick(); await settleTitleSync();
  assert.equal(s.store.getBinding(binding.id)!.title, "Renamed in Codex");
  assert.deepEqual(s.chat.renames, [{ peerId, title: "[VKodex] Renamed in Codex" }]);
  assert.deepEqual(s.store.getValue(`rename:${binding.id}`), {
    title: "Renamed in Codex", liveTitleUpdated: false, vkTitleUpdated: true, origin: "codex", attempts: 0, retryAt: 0,
  });
  await s.manager.panels.tick(); await settleTitleSync();
  assert.equal(s.chat.renames.length, 1);
  assert.equal(s.chat.sent.length, 0); assert.equal(s.chat.edits.length, 0);
  assert.equal(s.desktop.renames.length, 0); assert.equal(s.desktop.submissions.length, 0);
});

test("upgrade verifies an existing linked chat even when the old bridge already cached the Codex title", async t => {
  const s = setup(t); const binding = s.attach();
  assert.equal(s.store.getValue(`rename:${binding.id}`), null);
  await s.manager.panels.tick(); await settleTitleSync();
  assert.deepEqual(s.chat.renames, [{ peerId, title: "[VKodex] Existing desktop task" }]);
  await s.manager.panels.tick();
  assert.equal(s.chat.renames.length, 1);
});

test("a stalled VK title request never blocks the Codex runtime tick", async t => {
  const s = setup(t); s.attach(); s.desktop.tasks = [{ ...task, title: "Nonblocking rename" }];
  let release!: () => void;
  s.chat.renameBlock = new Promise(resolve => { release = resolve; });
  let timer!: NodeJS.Timeout;
  try {
    await Promise.race([
      s.manager.panels.tick(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("runtime tick was blocked by VK")), 100); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(s.chat.renames.length, 0);
  release(); await settleTitleSync();
  assert.deepEqual(s.chat.renames, [{ peerId, title: "[VKodex] Nonblocking rename" }]);
});

test("a Codex title changed while the bridge was offline is synchronized after restart", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.tasks = [{ ...task, title: "Offline rename" }];
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  await restarted.panels.tick(); await settleTitleSync();
  assert.equal(s.store.getBinding(binding.id)!.title, "Offline rename");
  assert.deepEqual(s.chat.renames, [{ peerId, title: "[VKodex] Offline rename" }]);
});

test("automatic Codex to VK title sync retries transient failures without duplicate metadata writes", async t => {
  const s = setup(t); const binding = s.attach(); s.chat.renameError = new Error("offline");
  s.desktop.tasks = [{ ...task, title: "Retry title" }];
  await s.manager.panels.tick(); await settleTitleSync();
  assert.equal(s.chat.renames.length, 1);
  const failed = s.store.getValue<Record<string, unknown>>(`rename:${binding.id}`)!;
  assert.equal(failed.vkTitleUpdated, false); assert.equal(failed.attempts, 1);
  assert.ok((failed.retryAt as number) > Date.now());
  await s.manager.panels.tick(); await settleTitleSync(); assert.equal(s.chat.renames.length, 1);
  s.store.setValue(`rename:${binding.id}`, { ...failed, retryAt: 0 }); s.chat.renameError = null;
  await s.manager.panels.tick(); await settleTitleSync();
  assert.equal(s.chat.renames.length, 2); assert.equal(s.desktop.renames.length, 0);
  assert.equal(s.store.getValue<Record<string, unknown>>(`rename:${binding.id}`)!.vkTitleUpdated, true);
});

test("an older automatic title cannot overwrite a newer Codex rename", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.tasks = [{ ...task, title: "First rename" }];
  s.chat.renameHook = () => {
    s.desktop.tasks = [{ ...task, title: "Latest rename" }];
    s.store.ensureBinding(s.desktop.tasks[0]!);
    s.store.setValue(`rename:${binding.id}`, {
      title: "Latest rename", liveTitleUpdated: true, vkTitleUpdated: false, origin: "codex", attempts: 0, retryAt: 0,
    });
  };
  await s.manager.panels.tick(); await settleTitleSync();
  assert.equal(s.chat.renames.length, 0);
  assert.equal(s.store.getBinding(binding.id)!.title, "Latest rename");
  assert.equal(s.store.getValue<Record<string, unknown>>(`rename:${binding.id}`)!.title, "Latest rename");
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

test("VK title changes stop if the binding is detached and reattached during Codex rename", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.renameHook = () => { s.store.stopStreaming(binding.id); s.store.setAttached(binding.id, true); };
  await s.handle("/menu", peerId); await clickPanel(s, "Переименовать");
  await s.handle("New title", peerId); await clickPanel(s, "Переименовать");
  assert.equal(s.chat.renames.length, 0); assert.equal(s.desktop.renames.length, 1);
  assert.equal(s.store.getBinding(binding.id)!.title, "New title");
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

test("an export does not inspect or restrict conversation participants", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId);
  s.desktop.exportHook = () => { s.chat.participants.push(999); };
  await clickPanel(s, "Markdown-файл");
  assert.equal(s.chat.uploads.length, 1); assert.equal(s.store.bindings()[0]!.paused, false);
  assert.equal(s.chat.memberReads, 0);
});

test("task callbacks remain owner-only and do not inspect membership", async t => {
  const s = setup(t); s.attach(); await s.handle("/menu", peerId);
  const action = panelView(s).buttons![0]!.action;
  await s.manager.handle({ ...s.input("", peerId, action), senderId: 999 });
  s.chat.memberError = true; await s.handle("", peerId, action);
  assert.equal(s.desktop.selections.length, 0); assert.equal(s.store.bindings()[0]!.paused, false);
  assert.equal(s.chat.memberReads, 0);
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
  assert.equal(JSON.parse(vkKeyboard(panelView(s, access.ownerId))).buttons.flat().length, 10);
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
  assert.match(view.text, /6–10 из 15/u);
  assert.ok(view.buttons!.some(button => button.label === "Без проекта"));
  assert.ok(view.buttons!.some(button => button.label === "Все подряд"));
  assert.equal(JSON.parse(vkKeyboard(view)).buttons.flat().length, 10);
  await clickPanel(s, "Далее", access.ownerId);
  assert.match(panelView(s, access.ownerId).text, /11–15 из 15/u);
  await clickPanel(s, "Назад", access.ownerId);
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

test("a newly created chat is linked immediately and always returns its invite link", async t => {
  const s = setup(t); s.chat.participants = [-access.groupId];
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action);
  const binding = s.store.bindings()[0]!;
  assert.equal(binding.paused, false); assert.equal(binding.attached, true);
  assert.equal(binding.chatState, "ready");
  const invitation = s.chat.sent.at(-1)!;
  assert.equal(invitation.peerId, access.ownerId);
  assert.match(invitation.view.text, /https:\/\/vk\.me\/join\/fixture/u);
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Private activity" });
  await s.handle("continue", peerId);
  assert.equal(s.desktop.submissions.length, 1);
  await s.worker.flush(); assert.ok(s.chat.sent.some(item => item.peerId === peerId));
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.creates, 1);
  assert.equal(s.chat.memberReads, 0);
});

test("failed invitation lookup preserves the chat and permits retry without recreation", async t => {
  const s = setup(t); s.chat.participants = [-access.groupId]; s.chat.inviteError = new Error("offline");
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action);
  assert.equal(s.store.bindings()[0]!.paused, false);
  assert.equal(s.store.bindings()[0]!.chatState, "ready");
  s.store.recover(); s.chat.inviteError = null;
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.creates, 1);
  assert.match(s.chat.sent.at(-1)!.view.text, /https:\/\/vk\.me\/join\/fixture/u);
});

test("opening a task never reads or restricts the conversation member list", async t => {
  const s = setup(t); s.chat.participants = [-access.groupId, 999];
  const action = s.store.action({ type: "open", task });
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.invites, 1);
  assert.equal(s.store.bindings()[0]!.paused, false);
  s.chat.memberError = true;
  await s.handle("", access.ownerId, action);
  assert.equal(s.chat.invites, 2);
  assert.equal(s.chat.memberReads, 0);
});

test("duplicate VK delivery cannot submit twice; a busy task receives a follow-up", async t => {
  const s = setup(t); s.attach();
  const input = s.input("Please continue", peerId);
  await Promise.all([s.manager.handle(input), s.manager.handle(input)]);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.task.threadId, task.threadId);
});

test("linked non-owner messages are prompts while the manager stays private", async t => {
  const s = setup(t); s.attach();
  await s.manager.handle({ ...s.input("/list"), senderId: 999 });
  await s.manager.handle({ ...s.input("do shared work", peerId), senderId: 999 });
  await s.manager.handle({ ...s.input("do not route", peerId + 1), senderId: 999 });
  await s.worker.flush();
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.text, "do shared work");
  assert.equal(s.chat.sent.length, 1);
  assert.equal(s.chat.sent[0]!.peerId, access.ownerId);
  assert.match(s.chat.sent[0]!.view.text, /не связана/u);
});

test("a blocked task conversation does not hold the manager or another conversation", async t => {
  const s = setup(t); s.attach();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  s.desktop.submitHook = () => blocked;
  const taskInput = s.manager.handle(s.input("Long operation", peerId));
  await new Promise(resolve => setImmediate(resolve));
  await s.manager.handle(s.input("/list", access.ownerId));
  await s.worker.flush();
  assert.equal(s.desktop.submissions.length, 1);
  assert.match(s.chat.sent.at(-1)!.view.text, /В каком проекте показать задачи/u);
  release(); await taskInput;
});

test("a legacy privacy pause is cleared and the same message is submitted", async t => {
  const s = setup(t); const binding = s.attach(); s.store.setPaused(binding.id, true);
  await s.handle("Continue after pause", peerId);
  assert.equal(s.store.getBinding(binding.id)!.paused, false);
  assert.equal(s.store.getBinding(binding.id)!.attached, true);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.text, "Continue after pause");
  assert.equal(s.chat.memberReads, 0);
});

test("other participants do not prevent recovery from a legacy pause", async t => {
  const s = setup(t); const binding = s.attach(); s.store.setPaused(binding.id, true); s.chat.participants.push(999);
  await s.manager.handle({ ...s.input("Forward this", peerId), senderId: 999 });
  assert.equal(s.store.getBinding(binding.id)!.paused, false);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.text, "Forward this");
  assert.equal(s.chat.memberReads, 0);
});

test("an explicitly detached chat gives a reconnect button and never replays its rejected message", async t => {
  const s = setup(t); const binding = s.attach(); s.store.stopStreaming(binding.id);
  await s.handle("Rejected while detached", peerId);
  assert.equal(s.desktop.submissions.length, 0);
  const notice = s.chat.sent.find(item => item.peerId === access.ownerId)!;
  assert.match(notice.view.text, /трансляция отключена/u);
  assert.equal(notice.view.buttons?.[0]?.label, "Подключить снова");

  await s.handle("", access.ownerId, notice.view.buttons![0]!.action);
  assert.equal(s.store.getBinding(binding.id)!.attached, true);
  assert.equal(s.desktop.submissions.length, 0);
  await s.handle("Repeated explicitly", peerId);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.text, "Repeated explicitly");
});

test("queued output and incoming prompts never inspect conversation members", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Reading" });
  await s.worker.flush();
  s.advance(30_001);
  s.mirror.accept(binding.id, { type: "progress", id: "p", turnId: "turn", text: "Private update" });
  s.mirror.accept(binding.id, { type: "final", id: "f", turnId: "turn", text: "Private answer" });
  s.chat.participants.push(999);
  await s.worker.flush(); await s.handle("continue", peerId);
  await s.worker.flush();
  assert.ok(s.chat.sent.some(item => item.peerId === peerId && /Private answer/u.test(item.view.text)));
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.store.getBinding(binding.id)!.paused, false);
  assert.equal(s.chat.memberReads, 0);
});

test("member API availability is irrelevant to an attached binding", async t => {
  const s = setup(t); const binding = s.attach(); s.chat.memberError = true;
  assert.equal(await s.gate.check(peerId), true);
  assert.equal(s.store.getBinding(binding.id)!.paused, false);
  s.store.setPaused(binding.id, true);
  assert.equal(await s.gate.clearLegacyPause(peerId, binding.id), true);
  assert.equal(s.store.getBinding(binding.id)!.paused, false);
  assert.equal(s.chat.memberReads, 0);
});

test("binding checks never read conversation members", async t => {
  const s = setup(t); const binding = s.attach();
  assert.equal(await s.gate.check(peerId), true);
  s.advance(30_001); assert.equal(await s.gate.check(peerId, true), true);
  assert.equal(s.chat.memberReads, 0);
  assert.equal(s.store.getBinding(binding.id)!.attached, true);
  assert.equal(s.store.getBinding(binding.id)!.paused, false);
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

test("VK service events do not detach a task and every inbound non-bot user can prompt it", async t => {
  const s = setup(t); const binding = s.attach(); const inputs: BridgeInput[] = [];
  const vk = new VK({ token: "fixture-token" }); t.mock.method(vk.updates, "startPolling", async () => {});
  const config = loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" });
  const gateway = new DesktopVkGateway(config, vk);
  await gateway.start(async input => { inputs.push(input); await s.manager.handle(input); });
  const update = (id: number, senderId: number, action?: { type: string; member_id?: number }, out = 0) => ({
    type: "message_new", group_id: access.groupId, event_id: `fixture-${id}`, v: "5.199",
    object: { message: { id: 0, conversation_message_id: id, peer_id: peerId, from_id: senderId,
      date: 100, out, text: "Fixture text", attachments: [], ...(action ? { action } : {}) }, client_info: {} },
  });
  await vk.updates.handleWebhookUpdate(update(1, access.ownerId, { type: "chat_kick_user", member_id: access.ownerId }, 1));
  assert.equal(s.store.getBinding(binding.id)!.attached, true);
  await vk.updates.handleWebhookUpdate(update(2, 999));
  await vk.updates.handleWebhookUpdate(update(3, -access.groupId));
  await vk.updates.handleWebhookUpdate(update(4, access.ownerId, undefined, 1));
  assert.equal(inputs.length, 1); assert.equal(inputs[0]!.senderId, 999);
  assert.equal(s.desktop.submissions.length, 1); assert.equal(s.desktop.submissions[0]!.text, "Fixture text");
  assert.equal(s.chat.memberReads, 0); assert.equal(s.store.getBinding(binding.id)!.paused, false);
});

test("explicit detach during an ambiguous send recovery prevents follow-up edits and stale retries", async t => {
  const s = setup(t); const binding = s.attach();
  const event = { type: "progress", id: "comment", turnId: "turn", text: "First version" } as const;
  s.chat.lostSendResponse = true;
  s.mirror.accept(binding.id, event); await s.worker.flush();
  s.mirror.accept(binding.id, { ...event, text: "Never edit after leaving" });
  const send = s.chat.send.bind(s.chat);
  s.chat.send = async (peer, view, randomId) => {
    const handle = await send(peer, view, randomId);
    if (peer === peerId) s.store.stopStreaming(binding.id);
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

test("an edit already in flight cannot revive a newer revision cancelled by detach", async t => {
  const s = setup(t); const binding = s.attach();
  const event = { type: "progress", id: "comment", turnId: "turn", text: "Initial" } as const;
  s.mirror.accept(binding.id, event); await s.worker.flush();
  s.mirror.accept(binding.id, { ...event, text: "Edit in flight" });
  s.chat.edit = async () => {
    s.mirror.accept(binding.id, { ...event, text: "Newer queued revision" });
    s.store.stopStreaming(binding.id);
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
  assert.equal(s.chat.sent.length, 3); assert.deepEqual(s.chat.sent[2]!.view, { text: "Done\n\nМеню задачи:", buttons: [MENU_BUTTON] });
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
  assert.deepEqual(s.chat.sent.map(item => item.view), []);
  snapshot.turns[0]!.status = "completed";
  snapshot.turns[0]!.items.at(-1)!.text = "Finished.";
  const completed = projectSnapshot(snapshot, initial.checkpoint);
  for (const event of completed.events) s.mirror.accept(binding.id, event);
  for (const status of ["running", "completed", "failed", "interrupted", "approval"] as const) {
    s.mirror.accept(binding.id, { type: "status", id: `status:${status}`, turnId: "turn", status });
  }
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "Finished.\n\nМеню задачи:", buttons: [MENU_BUTTON] }]);
  assert.equal(s.chat.edits.length, 0);
});

test("thinking cycles one silent message and leaves the final answer separate", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(message => message.view), [{ text: "думаю...", silent: true }]);
  for (const text of ["думаю..", "думаю.", "думаю..."]) {
    activity.observe(binding.id, "running", "turn");
    activity.tick(); await s.worker.flush();
    s.advance(); activity.tick(); await s.worker.flush();
    assert.equal(s.chat.edits.at(-1)!.view.text, text);
    assert.deepEqual(s.chat.edits.at(-1)!.handle, s.chat.sent[0]!.handle);
  }
  assert.equal(s.chat.sent.length, 1); assert.equal(s.chat.edits.length, 3);
  assert.ok(s.chat.edits.every(edit => edit.view.silent));
  s.mirror.accept(binding.id, { type: "final", id: "answer", turnId: "turn", text: "Final answer" });
  activity.observe(binding.id, "idle"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "Готово.");
  assert.equal(s.chat.sent[1]!.view.text, "Final answer\n\nМеню задачи:"); assert.ok(!s.chat.sent[1]!.view.silent);
  const edits = s.chat.edits.length; s.advance(); activity.tick(); await s.worker.flush(); assert.equal(s.chat.edits.length, edits);
});

test("thinking uses a flood-safe twenty-second interval by default", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now);
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  s.advance(19_999); activity.tick(); await s.worker.flush(); assert.equal(s.chat.edits.length, 0);
  s.advance(1); activity.tick(); await s.worker.flush(); assert.equal(s.chat.edits.length, 1);
  assert.equal(s.chat.edits[0]!.view.text, "думаю..");
});

test("thinking restores the same message after restart and settles an interrupted finish", async t => {
  const s = setup(t); const binding = s.attach(); let activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", null); await s.worker.flush();
  activity.observe(binding.id, "running", "turn"); activity.stop(); s.store.recover();
  activity = new TaskActivity(s.store, s.now, 6_000); activity.tick(); await s.worker.flush();
  assert.equal(s.chat.edits.length, 0);
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 1);
  activity.observe(binding.id, "idle"); s.store.recover(); // Process dies before the finishing edit.
  activity = new TaskActivity(s.store, s.now, 6_000); activity.observe(binding.id, "idle"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "Готово."); assert.equal(s.chat.sent.length, 1);
  activity.observe(binding.id, "running", "next-turn"); await s.worker.flush(); assert.equal(s.chat.sent.length, 2);
});

test("VK flood control pauses the whole delivery queue across worker restart", async t => {
  const s = setup(t); const binding = s.attach();
  s.store.enqueue("first", peerId, { text: "First" }, binding.id);
  s.store.enqueue("second", peerId, { text: "Second" }, binding.id);
  let attempts = 0;
  const send = t.mock.method(s.chat, "send", async () => { attempts++; throw new ChatRateLimitError(12_000); });
  await s.worker.flush(); assert.equal(attempts, 1);
  const restarted = new DeliveryWorker(s.chat, s.store, s.gate, 3_000, s.now);
  s.advance(); await restarted.flush(); assert.equal(attempts, 1);
  send.mock.restore(); s.advance(); await restarted.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), ["First", "Second"]);
});

test("final answers and manager replies are delivered before backlogged commentary", t => {
  const s = setup(t); const binding = s.attach();
  s.store.enqueue("old-comment", peerId, { text: "Progress" }, binding.id, true);
  s.store.enqueue("final", peerId, { text: "Final answer" }, binding.id);
  assert.deepEqual(s.store.pendingDeliveries().map(item => item.kind), ["send", "commentary"]);
});

test("stream edits are coalesced for twenty seconds while requested panels stay immediate", async t => {
  const s = setup(t); const binding = s.attach(); const worker = new DeliveryWorker(s.chat, s.store, s.gate, 20_000, s.now);
  s.store.enqueue("comment", peerId, { text: "Progress 1", silent: true }, binding.id, true);
  s.store.enqueue("panel", peerId, { text: "Panel 1", silent: true }, binding.id, "panel");
  await worker.flush();
  s.store.enqueue("comment", peerId, { text: "Progress 2", silent: true }, binding.id, true);
  s.store.enqueue("panel", peerId, { text: "Panel 2", silent: true }, binding.id, "panel");
  await worker.flush();
  assert.deepEqual(s.chat.edits.map(item => item.view.text), ["Panel 2"]);
  s.advance(19_999); await worker.flush(); assert.deepEqual(s.chat.edits.map(item => item.view.text), ["Panel 2"]);
  s.advance(1); await worker.flush(); assert.deepEqual(s.chat.edits.map(item => item.view.text), ["Panel 2", "Progress 2"]);
  s.store.enqueue("comment", peerId, { text: "Готово.", silent: true }, binding.id, true);
  s.store.prioritizeDelivery("comment"); await worker.flush();
  assert.deepEqual(s.chat.edits.map(item => item.view.text), ["Panel 2", "Progress 2", "Готово."]);
});

test("gateway translates VK flood errors to a safe retry interval", async t => {
  const vk = new VK({ token: "fixture-token" });
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk);
  t.mock.method(vk.api, "callWithRequest", async () => { throw new APIError({ error_code: 9, error_msg: "private response", request_params: [{ key: "access_token", value: "private fixture" }] }); });
  await assert.rejects(gateway.edit({ peerId, conversationMessageId: 1 }, { text: "Working" }), error => error instanceof ChatRateLimitError && error.retryAfterMs === 120_000 && !error.message.includes("private"));
});

test("revisions returning to the last confirmed view do not repeat an identical VK edit", async t => {
  const s = setup(t); const binding = s.attach();
  s.store.enqueue("comment", peerId, { text: "Working\n\nдумаю...", silent: true }, binding.id, true);
  await s.worker.flush();
  s.store.enqueue("comment", peerId, { text: "Working", silent: true }, binding.id, true);
  s.store.enqueue("comment", peerId, { text: "Working\n\nдумаю...", silent: true }, binding.id, true);
  s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.length, 0); assert.equal(s.store.pendingDeliveries().length, 0);
});

test("thinking moves into the newest commentary and restores older message text", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  const first = { type: "progress", id: "first", turnId: "turn", text: "First comment" } as const;
  s.mirror.accept(binding.id, first); activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.at(-1)!.view.text, "First comment\n\nдумаю...");
  const firstHandle = s.chat.sent.at(-1)!.handle;
  s.advance(); activity.tick(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "First comment\n\nдумаю..");
  s.mirror.accept(binding.id, { ...first, text: "First comment expanded" });
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "First comment expanded\n\nдумаю..");
  s.mirror.accept(binding.id, { ...first, id: "second", text: "Second comment" });
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 3); assert.equal(s.chat.sent.at(-1)!.view.text, "Second comment\n\nдумаю...");
  assert.equal(s.chat.edits.filter(item => item.handle.conversationMessageId === firstHandle.conversationMessageId).at(-1)!.view.text, "First comment expanded");
  s.mirror.accept(binding.id, { ...first, text: "Older comment corrected" });
  activity.observe(binding.id, "running", "turn"); s.advance(); activity.tick(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "Second comment\n\nдумаю..");
  activity.observe(binding.id, "idle"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "Second comment");
});

test("user messages and menus move thinking to the bottom while restart reuses its latest handle", async t => {
  const s = setup(t); const binding = s.attach(); let activity = new TaskActivity(s.store, s.now, 6_000);
  s.mirror.accept(binding.id, { type: "progress", id: "comment", turnId: "turn", text: "Working" });
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  const incomingId = ++s.chat.messageSequence;
  await s.manager.handle({ ...s.input("Follow up", peerId), eventId: `message:${incomingId}` });
  activity.tick(); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.at(-1)!.view.text, "думаю...");
  assert.ok(s.chat.sent.at(-1)!.handle.conversationMessageId > incomingId);
  await s.handle("/menu", peerId);
  const menuId = s.chat.sent.at(-1)!.handle.conversationMessageId;
  activity.tick(); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.at(-1)!.view.text, "думаю...");
  assert.ok(s.chat.sent.at(-1)!.handle.conversationMessageId > menuId);
  s.mirror.accept(binding.id, { type: "progress", id: "new-comment", turnId: "turn", text: "New progress" });
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  const count = s.chat.sent.length, latest = s.chat.sent.at(-1)!.handle;
  s.store.recover(); activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  s.advance(); activity.tick(); await s.worker.flush();
  assert.equal(s.chat.sent.length, count); assert.deepEqual(s.chat.edits.at(-1)!.handle, latest);
  assert.equal(s.chat.edits.at(-1)!.view.text, "New progress\n\nдумаю..");
  s.store.stopStreaming(binding.id); const edits = s.chat.edits.length;
  s.advance(); activity.tick(); await s.worker.flush(); assert.equal(s.chat.edits.length, edits);
});

test("thinking stops for approval, disconnection and failure without creating extra status messages", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "idle"); await s.worker.flush(); assert.equal(s.chat.sent.length, 0);
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  for (const [status, label] of [["approval", "Нужен ответ в Codex."], ["unavailable", "Нет связи с Codex."], ["failed", "Ход завершился с ошибкой."]] as const) {
    activity.observe(binding.id, status); s.advance(); await s.worker.flush();
    assert.equal(s.chat.edits.at(-1)!.view.text, label);
    const count = s.chat.edits.length; s.advance(); activity.tick(); await s.worker.flush(); assert.equal(s.chat.edits.length, count);
  }
  assert.equal(s.chat.sent.length, 1);
});

test("thinking cancels unsent indicators and stale frames after completion or detach", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "fast"); activity.observe(binding.id, "idle"); await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  activity.observe(binding.id, "idle"); s.advance(3_001); await s.worker.flush(); assert.equal(s.chat.edits.length, 1);
  await s.worker.flush(); assert.equal(s.chat.edits.at(-1)!.view.text, "Готово.");
  activity.observe(binding.id, "running", "third"); await s.worker.flush(); s.advance(); activity.tick();
  const count = s.chat.edits.length; s.store.stopStreaming(binding.id);
  await s.worker.flush(); activity.tick();
  assert.equal(s.store.getBinding(binding.id)!.attached, false); assert.equal(s.chat.edits.length, count);
  assert.equal(s.store.pendingDeliveries().filter(item => item.kind === "activity").length, 0);
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
  assert.equal(s.chat.sent.length, 1); assert.equal(s.chat.sent[0]!.view.text, "Complete answer\n\nМеню задачи:");
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
  assert.equal(s.chat.sent.length, 1); assert.equal(s.chat.sent[0]!.view.text, "Missed final\n\nМеню задачи:");
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

test("recovery retires unsent oversized manager keyboards without changing their frozen payloads", async t => {
  const s = setup(t); const binding = s.attach();
  const buttons = Array.from({ length: 11 }, (_, i) => ({ label: `Button ${i}`, action: `fixture-${i}` }));
  s.store.enqueue("old-menu", access.ownerId, { text: "Unsendable page", buttons });
  const pending = s.store.pendingDeliveries()[0]!; s.store.sending(pending);
  const db = Reflect.get(s.store, "db") as Database;
  const before = db.prepare("SELECT * FROM bridge_delivery WHERE key='old-menu'").get() as Record<string, unknown>;
  s.store.enqueue("valid-menu", access.ownerId, { text: "Valid page", buttons: buttons.slice(0, 10) });
  s.store.enqueue("final", peerId, { text: "Final answer" }, binding.id);
  s.store.recover(); s.store.recover();
  assert.deepEqual(db.prepare("SELECT * FROM bridge_delivery WHERE key='old-menu'").get(), { ...before, delivered_revision: before.revision });
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(message => message.view.text), ["Valid page", "Final answer"]);
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
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons![0]!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Локально")!.action);
  await s.handle("New title"); await s.handle("Initial prompt");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Model A")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "medium")!.action);
  return s.chat.sent.at(-1)!.view.buttons![0]!.action;
}

test("new-task wizard creates a desktop task once even when VK chat creation fails", async t => {
  const s = setup(t); const action = await draft(s); s.chat.createError = new Error("timeout");
  await s.handle("", access.ownerId, action); await s.handle("", access.ownerId, action);
  assert.equal(s.desktop.creations.length, 1); assert.equal(s.chat.creates, 1);
  assert.equal(s.desktop.creations[0]!.projectId, "project-a");
  assert.equal(s.desktop.creations[0]!.prompt, "Initial prompt");
  assert.equal(s.desktop.creations[0]!.environment, "local");
  assert.equal(s.desktop.creations[0]!.model, "model-a");
  assert.equal(s.desktop.creations[0]!.effort, "medium");
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
  await s.worker.flush();
  assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.chat.sent.at(-1)!.peerId, peerId);
});

test("VK link previews keep the original URL prompt and errors stay in the originating chat", async t => {
  const s = setup(t); s.attach();
  const vk = new VK({ token: "fixture-token" }); t.mock.method(vk.updates, "startPolling", async () => {});
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk);
  await gateway.start(input => s.manager.handle(input));
  const text = "Review https://example.com/guide";
  await vk.updates.handleWebhookUpdate({ type: "message_new", group_id: access.groupId, event_id: "fixture-preview", v: "5.199", object: {
    message: { id: 0, conversation_message_id: 21, peer_id: peerId, from_id: access.ownerId, date: 100, out: 0, text,
      attachments: [{ type: "link", link: { url: "https://example.com/guide", title: "Preview" } }] }, client_info: {},
  } });
  assert.equal(s.desktop.submissions.length, 1); assert.equal(s.desktop.submissions[0]!.text, text);
  assert.equal(hasVkAttachments({ text, attachments: [{ type: "link", link: { url: "https://example.com/guide" } }] }), false);
  assert.equal(hasVkAttachments({ text, attachments: [{ type: "link", url: "https://example.com/other" }] }), true);
  assert.equal(hasVkAttachments({ text, attachments: [{ type: "photo" }] }), true);
});

test("forwarded and replied attachments are not silently stripped from a prompt", () => {
  assert.equal(hasVkAttachments({ attachments: [], forwards: [{ attachments: [{}] }] }), true);
  assert.equal(hasVkAttachments({ attachments: [], replyMessage: { attachments: [{}] } }), true);
  const cyclic: Record<string, unknown> = { attachments: [] }; cyclic.replyMessage = cyclic;
  assert.equal(hasVkAttachments(cyclic), false);
});

test("VK collects photos and documents, removes duplicate previews and rejects unsupported media", async () => {
  const photo = { type: "photo", sizes: [{ width: 10, height: 10, url: "https://sun1.userapi.com/small" }, { width: 100, height: 100, url: "https://sun1.userapi.com/large" }] };
  const files = await collectVkFiles({ attachments: [photo], replyMessage: { attachments: [photo, { type: "doc", url: "https://vk.com/doc", title: "notes.txt", size: 5 }] } });
  assert.equal(files.length, 2); assert.equal(files[0]!.url, "https://sun1.userapi.com/large"); assert.equal(files[1]!.kind, "file");
  await assert.rejects(collectVkFiles({ attachments: [{ type: "video" }] }), /документы/u);
});

test("VK Long Poll photo and reply-document payloads reach the linked task through SDK getters", async t => {
  const s = setup(t); s.attach(); const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const manager = new TaskManager(access, s.desktop, s.chat, s.store, s.gate, files);
  const vk = new VK({ token: "fixture-token" }); t.mock.method(vk.updates, "startPolling", async () => {});
  t.mock.method(globalThis, "fetch", async () => new Response("fixture bytes"));
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk);
  await gateway.start(input => manager.handle(input));
  await vk.updates.handleWebhookUpdate({ type: "message_new", group_id: access.groupId, event_id: "fixture-files", v: "5.199", object: {
    message: { id: 0, conversation_message_id: 22, peer_id: peerId, from_id: access.ownerId, date: 100, out: 0, text: "Read these files",
      attachments: [{ type: "photo", photo: { id: 1, owner_id: 101, album_id: -3, date: 100, sizes: [{ type: "x", width: 100, height: 100, url: "https://sun1.userapi.com/photo" }] } }],
      reply_message: { id: 0, conversation_message_id: 20, peer_id: peerId, from_id: access.ownerId, date: 100, text: "Document",
        attachments: [{ type: "doc", doc: { id: 2, owner_id: 101, date: 100, ext: "txt", title: "notes.txt", size: 13, url: "https://sun1.userapi.com/doc" } }] },
    }, client_info: {},
  } });
  assert.equal(s.desktop.submissions.length, 1, JSON.stringify(s.store.pendingDeliveries().map(item => item.view.text)));
  const request = s.desktop.submissions[0]!;
  assert.deepEqual(request.inputFiles!.map(file => file.kind), ["image", "file"]);
  assert.equal(await readFile(request.inputFiles![1]!.path, "utf8"), "fixture bytes");
});

test("files enter the same task and completed output is uploaded once across retries and restart", async t => {
  const s = setup(t); const binding = s.attach(); const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate); const manager = new TaskManager(access, s.desktop, s.chat, s.store, s.gate, files);
  t.mock.method(globalThis, "fetch", async () => new Response("source bytes"));
  await manager.handle({ ...s.input("", peerId), attachments: [{ key: "doc", kind: "file", fileName: "notes.txt", url: "https://sun1.userapi.com/file" }] });
  const request = s.desktop.submissions[0]!; assert.equal(request.task.threadId, task.threadId);
  assert.equal(await readFile(request.inputFiles![0]!.path, "utf8"), "source bytes");
  await writeFile(path.join(request.outboxDir!, "reply.txt"), "result bytes");
  files.observe(binding.id, "idle"); await files.tick(); await s.worker.flush();
  assert.equal(s.chat.binaryUploads.length, 1); assert.equal(s.chat.binaryUploads[0]!.contents.toString(), "result bytes");
  assert.deepEqual(s.chat.sent[0]!.view.attachments, ["doc-202_1"]); assert.equal(s.chat.sent[0]!.peerId, peerId);
  await files.collect(binding, true); s.store.recover(); const restored = new TaskFiles(root, s.store, s.chat, s.gate);
  await restored.collect(binding, true); await s.worker.flush(); assert.equal(s.chat.binaryUploads.length, 1); assert.equal(s.chat.sent.length, 1);
  await writeFile(path.join(request.outboxDir!, "manual.txt"), "later output");
  await manager.handle(s.input("/files", peerId)); await s.worker.flush();
  assert.equal(s.chat.binaryUploads.length, 2); assert.match(s.chat.sent.at(-1)!.view.text, /файлов: 1/u);
  assert.equal(s.desktop.submissions.length, 1);
});

test("attachment transfer stops on explicit detach during download or upload and never replays old jobs", async t => {
  const s = setup(t); const binding = s.attach(); const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const download = t.mock.method(globalThis, "fetch", async () => { s.store.stopStreaming(binding.id); return new Response("file"); });
  await assert.rejects(files.prepare(binding, "download", [{ key: "a", kind: "file", fileName: "a.txt", url: "https://sun1.userapi.com/file" }]), /остановлена/u);
  assert.equal(s.desktop.submissions.length, 0);
  download.mock.restore(); s.store.setAttached(binding.id, true);
  const prepared = await files.prepare(binding, "upload", []); files.finish(binding.id, "upload", false);
  await writeFile(path.join(prepared.outboxDir, "result.txt"), "result");
  t.mock.method(s.chat, "uploadFile", async () => { s.store.stopStreaming(binding.id); return "doc-202_1"; });
  await assert.rejects(files.collect(binding, true), /остановлена/u); await s.worker.flush(); assert.equal(s.chat.sent.length, 0);
  s.store.setAttached(binding.id, true); assert.equal(await files.collect(binding, true), 0);
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
  assert.equal(loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", HEALTH_CHECK_INTERVAL_MS: "30000" }).healthIntervalMs, 30_000);
  assert.throws(() => loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", HEALTH_CHECK_INTERVAL_MS: "29999" }));
});

test("callback payloads contain opaque tokens, not identity, thread IDs, or paths", () => {
  const keyboard = JSON.parse(vkKeyboard({ text: "text", buttons: [{ label: "Open", action: "opaque-fixture" }] })) as { buttons: { action: { payload: string } }[][] };
  assert.deepEqual(JSON.parse(keyboard.buttons[0]![0]!.action.payload), { action: "opaque-fixture" });
});

test("VK inline keyboards reject more than ten buttons even if they fit within six rows", () => {
  const buttons = Array.from({ length: 11 }, (_, i) => ({ label: `Task ${i}`, action: `action-${i}` }));
  const keyboard = JSON.parse(vkKeyboard({ text: "tasks", buttons: buttons.slice(0, 10) })) as { buttons: unknown[][] };
  assert.equal(keyboard.buttons.length, 5);
  assert.equal(keyboard.buttons.flat().length, 10);
  assert.throws(() => vkKeyboard({ text: "tasks", buttons }), /ten buttons/u);
});
