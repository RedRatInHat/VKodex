import assert from "node:assert/strict";
import test from "node:test";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { APIError, VK } from "vk-io";
import type { BridgeChat, BridgeInput, MessageHandle, View, VkDocumentRecord } from "../src/bridge/contracts.js";
import { ChatRateLimitError, FileUploadRejectedError, FileUploadStorageFullError, MENU_BUTTON } from "../src/bridge/contracts.js";
import { AccessGate, DeliveryWorker } from "../src/bridge/delivery.js";
import { TaskManager } from "../src/bridge/manager.js";
import { TaskTransfers, transferStatus } from "../src/bridge/transfers.js";
import { ArchiveOwnerRequiredError, DesktopUnavailableError, TransferConflictError } from "../src/desktop/contracts.js";
import { TaskNotOpenError } from "../src/desktop/contracts.js";
import { TaskMirror } from "../src/bridge/mirror.js";
import { TaskActivity } from "../src/bridge/activity.js";
import { TaskFiles, downloadVkFileToPath } from "../src/bridge/files.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeStore, migrateInboxJournal } from "../src/bridge/store.js";
import { loadDesktopBridgeConfig } from "../src/bridge/config.js";
import { ActionRejectedError, UncertainActionError, type AccountUsage, type CreateTaskRequest, type DesktopProject, type DesktopTask, type DesktopTasks, type EditLastUserTurnRequest, type SubmitTaskReceipt, type SubmitTaskRequest, type TaskRef, type TaskDetails, type DesktopModel, type TaskGoal, type TaskGoalUpdate, type TaskRenameResult, type TransferTaskRequest, type UsageResetOutcome } from "../src/desktop/contracts.js";
import { collectVkFiles, DesktopVkGateway, hasVkAttachments, vkKeyboard, vkSendParams } from "../src/platforms/vk/desktop-gateway.js";
import { projectSnapshot } from "../src/desktop/projector.js";
import { taskInput as desktopTaskInput } from "../src/core/task-input.js";
import { pendingCodexQuestions, type CodexQuestions } from "../src/desktop/questions.js";

// Deliberately fictional fixture IDs; production identity is supplied only through local configuration.
const access = { ownerId: 101, groupId: 202 };
const task: DesktopTask = { hostId: "local", threadId: "task-a", title: "Existing desktop task", workspace: "/project", projectId: "project-a", updatedAt: 10 };
const peerId = 2_000_000_017;

class Chat implements BridgeChat {
  participants = [access.ownerId, -access.groupId];
  readonly sent: { peerId: number; view: View; randomId: number; handle: MessageHandle }[] = [];
  readonly sendAttempts: { peerId: number; view: View; randomId: number }[] = [];
  readonly edits: { handle: MessageHandle; view: View }[] = [];
  readonly deletes: MessageHandle[] = [];
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
  failDeletes = false;
  messageSequence = 0;
  memberError = false;
  memberReads = 0;
  readonly uploads: { peerId: number; name: string; contents: string }[] = [];
  readonly binaryUploads: { name: string; contents: Buffer; kind: string }[] = [];
  readonly cleanupCalls: VkDocumentRecord[][] = [];
  cleanupResult: readonly string[] = [];
  async uploadFile(_peerId: number, name: string, contents: Buffer, kind: "image" | "file"): Promise<string> { this.binaryUploads.push({ name, contents, kind }); return `doc-202_${this.binaryUploads.length}`; }
  async cleanupDocuments(records: readonly VkDocumentRecord[]): Promise<readonly string[]> { this.cleanupCalls.push([...records]); return this.cleanupResult; }
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
  async delete(handle: MessageHandle): Promise<void> { if (this.failDeletes) throw new Error("delete failed"); this.deletes.push(handle); }
}

class Desktop implements DesktopTasks {
  questions: readonly CodexQuestions[] = [];
  readonly questionAnswers: { task: TaskRef; question: CodexQuestions; answers: Readonly<Record<string, string>> }[] = [];
  questionError: Error | null = null;
  async pendingQuestions() { return this.questions; }
  async answerQuestions(task: TaskRef, question: CodexQuestions, answers: Readonly<Record<string, string>>, _operationId: string, beforeSend: () => Promise<void>): Promise<void> {
    await beforeSend(); this.questionAnswers.push({ task, question, answers });
    if (this.questionError) throw this.questionError;
    this.questions = this.questions.filter(q => q.key !== question.key);
  }
  capabilities = { createTask: true, startTurn: true, steerTurn: true, interruptTurn: true, selectModel: true, renameTask: true, archiveTask: true, exportMarkdown: true, moveTask: true, transferTask: false, accountUsage: true, usageReset: false, goals: false, editLastUserTurn: true };
  tasks: DesktopTask[] = [task];
  sources = [{ id: "", label: ".codex" }];
  projects: DesktopProject[] = [{ id: "project-a", title: "Project", workspace: "/project" }];
  sourceProjects: Record<string, DesktopProject[]> | null = null;
  projectsError: Error | null = null;
  readonly creations: CreateTaskRequest[] = [];
  readonly submissions: SubmitTaskRequest[] = [];
  readonly queued: SubmitTaskRequest[] = [];
  queueError: Error | null = null;
  async queue(request: SubmitTaskRequest): Promise<string> {
    await request.beforeSend?.();
    this.queued.push(request);
    if (this.queueError) throw this.queueError;
    return "native-queue-id";
  }
  readonly messageEdits: EditLastUserTurnRequest[] = [];
  submitReceipt: SubmitTaskReceipt = { mode: "start", turnId: "submitted-turn" };
  readonly stops: TaskRef[] = [];
  createError: Error | null = null;
  submitError: Error | null = null;
  reconciledTurnId: string | null = null;
  async findAcceptedInput(_task: TaskRef, _operationId: string): Promise<string | null> { return this.reconciledTurnId; }
  submitHook: (() => Promise<void>) | null = null;
  details: TaskDetails = { status: "idle", workspace: "/project", model: "model-a", effort: "medium", nextModel: "model-a", nextEffort: "medium", context: { used: 25_000, window: 100_000, percent: 25 } };
  models: DesktopModel[] = [{ id: "model-a", title: "Model A", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "model-b", title: "Model B", efforts: ["high"], defaultEffort: "high" }];
  readonly modelSources: (TaskRef | undefined)[] = [];
  readonly selections: { task: TaskRef; model: string; effort: string }[] = [];
  readonly renames: { task: TaskRef; title: string }[] = [];
  readonly archives: TaskRef[] = [];
  readonly transfers: TransferTaskRequest[] = [];
  readonly opened: TaskRef[] = [];
  readonly moves: { task: TaskRef; projectId: string | null }[] = [];
  goal: TaskGoal | null = null;
  readonly goalUpdates: TaskGoalUpdate[] = [];
  goalClears = 0;
  goalContinuations = 0;
  usageReads = 0;
  readonly usageTasks: (TaskRef | undefined)[] = [];
  usage: AccountUsage = { planType: "pro", limits: [
    { id: "codex", name: null, primary: { usedPercent: 9, windowMinutes: 10_080, resetsAt: 1_788_643_425 }, secondary: null },
    { id: "base_model_inference", name: "gpt-reserve", primary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1_788_643_425 }, secondary: null },
  ], accountLabel: "owner@example.com", sourceLabel: ".codex", sourceId: "", credits: { hasCredits: false, unlimited: false, balance: "0" }, resetCredits: 0 };
  readonly usageResets: { task: TaskRef; idempotencyKey: string }[] = [];
  usageResetOutcome: UsageResetOutcome = "reset";
  usageResetError: Error | null = null;
  selectError: Error | null = null;
  inspectError: Error | null = null;
  renameError: Error | null = null;
  liveTitleUpdated = true;
  renameHook: (() => void) | null = null;
  exportHook: (() => void) | null = null;
  async inspectTask(_ref?: TaskRef) { if (this.inspectError) throw this.inspectError; return this.details; }
  async listModels(source?: TaskRef) { this.modelSources.push(source); return this.models; }
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
  async archiveTransferredSource(ref: TaskRef): Promise<void> { await this.archiveTask(ref); }
  archiveRetryReady?: (ref: TaskRef) => Promise<boolean>;
  verifyLegacyArchivedPair?: (source: TaskRef, target: DesktopTask, checkpoint: import("../src/desktop/contracts.js").TransferCheckpoint) => Promise<void>;
  async isTaskArchived(ref: TaskRef, _checkpoint?: import("../src/desktop/contracts.js").TransferCheckpoint): Promise<boolean> {
    return this.archives.some(task => task.threadId === ref.threadId);
  }
  async transferCheckpoint() { return { lastTurnId: "boundary", rolloutPath: "/source.jsonl", size: 1, mtimeMs: 1 }; }
  async verifyTransferSource(): Promise<void> {}
  async verifyTransferTarget(): Promise<void> {}
  async exportMarkdown(): Promise<string> { this.exportHook?.(); return "# Fixture\n\nVisible conversation"; }
  async accountUsage(task?: TaskRef): Promise<readonly AccountUsage[]> { this.usageReads++; this.usageTasks.push(task); return [this.usage]; }
  async consumeUsageReset(task: TaskRef, idempotencyKey: string): Promise<UsageResetOutcome> {
    this.usageResets.push({ task, idempotencyKey });
    if (this.usageResetError) throw this.usageResetError;
    return this.usageResetOutcome;
  }
  async getGoal(_ref?: TaskRef): Promise<TaskGoal | null> { return this.goal; }
  async setGoal(ref: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> {
    this.goalUpdates.push(update);
    const previous = this.goal;
    this.goal = {
      threadId: ref.threadId,
      objective: update.objective ?? previous?.objective ?? "Fixture goal",
      status: update.status ?? previous?.status ?? "active",
      tokenBudget: update.tokenBudget !== undefined ? update.tokenBudget : previous?.tokenBudget ?? null,
      tokensUsed: previous?.tokensUsed ?? 0,
      timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
      createdAt: previous?.createdAt ?? 1_788_000_000,
      updatedAt: 1_788_000_100,
    };
    return this.goal;
  }
  async clearGoal(): Promise<boolean> { this.goalClears++; const existed = this.goal !== null; this.goal = null; return existed; }
  async continueGoal(): Promise<void> { this.goalContinuations++; }
  async listTasks() { return this.tasks; }
  listSources() { return this.sources; }
  async listProjects(sourceId?: string) { if (this.projectsError) throw this.projectsError; return sourceId !== undefined && this.sourceProjects ? (this.sourceProjects[sourceId] ?? []) : this.projects; }
  async createTask(request: CreateTaskRequest): Promise<DesktopTask> {
    this.creations.push(request);
    if (this.createError) throw this.createError;
    const created = { ...task, threadId: "new-task", title: request.title, projectId: request.projectId,
      workspace: request.workspace ?? this.projects.find(project => project.id === request.projectId)?.workspace ?? task.workspace,
      ...(request.sourceId ? { sourceId: request.sourceId } : {}) };
    this.tasks.push(created);
    return created;
  }
  async submit(request: SubmitTaskRequest): Promise<void> { await this.submitWithReceipt(request); }
  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> { this.submissions.push(request); if (this.submitHook) await this.submitHook(); if (this.submitError) throw this.submitError; return this.submitReceipt; }
  async editLastUserTurn(request: EditLastUserTurnRequest) { this.messageEdits.push(request); return { turnId: "replacement-turn", operationId: "replacement-operation" }; }
  async interrupt(ref: TaskRef): Promise<void> { this.stops.push(ref); }
  async moveTask(ref: TaskRef, projectId: string | null): Promise<void> {
    this.moves.push({ task: ref, projectId });
    this.tasks = this.tasks.map(item => item.threadId === ref.threadId ? { ...item, projectId } : item);
  }
  async transferTask(request: TransferTaskRequest): Promise<DesktopTask> {
    this.transfers.push(request);
    if (request.existingTarget) return request.existingTarget;
    request.onForkSubmitted?.();
    const target: DesktopTask = { hostId: "local", threadId: `moved-${request.targetSourceId || "primary"}`, title: request.task.title,
      workspace: task.workspace, projectId: request.projectId, rolloutPath: `/target/${request.targetSourceId || "primary"}.jsonl`, updatedAt: 20,
      ...(request.targetSourceId ? { sourceId: request.targetSourceId, sourceLabel: ".codex-work" } : { sourceLabel: ".codex" }) };
    this.tasks.push(target); request.onForkCreated?.(target); return target;
  }
  async ensureOpen(ref: TaskRef): Promise<void> { this.opened.push(ref); }
  async revealTask(ref: TaskRef): Promise<void> { this.opened.push(ref); }
}

function setup(t: { after(fn: () => void): void }, enableHealth = false) {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new Chat(); const desktop = new Desktop();
  let time = 100_000;
  const gate = new AccessGate(access, store);
  let healthChecks = 0;
  let loadChecks = 0;
  const healthCheck = enableHealth ? async () => {
    healthChecks++;
    const report = { state: "ok" as const, checkedAt: time, pid: 42, uptimeSeconds: 60,
      checks: [{ name: "fixture", state: "ok" as const, detail: "All components respond." }] };
    store.setValue("health:latest", report); return report;
  } : undefined;
  const loadReport = async () => { loadChecks++; return "Нагрузка ПК\nCPU: 12.5%\nRAM: 8.0 ГБ из 32.0 ГБ"; };
  const manager = new TaskManager(access, desktop, chat, store, gate, undefined, healthCheck, loadReport);
  // Most unit tests assert a completely drained fixture queue. Production uses
  // the default bounded batch, covered by a dedicated backlog test below.
  const worker = new DeliveryWorker(chat, store, gate, 3_000, () => time, 100);
  const mirror = new TaskMirror(store, 3_500, () => time);
  let sequence = 0;
  const input = (text: string, peer = access.ownerId, action?: string): BridgeInput => ({ eventId: `e${sequence++}`, senderId: access.ownerId, peerId: peer, text, ...(action ? { action } : {}) });
  const handle = async (text: string, peer = access.ownerId, action?: string) => { await manager.handle(input(text, peer, action)); await worker.flush(); };
  const attach = () => { const binding = store.ensureBinding(task); store.setChat(binding.id, peerId, 17); return store.getBinding(binding.id)!; };
  return { store, chat, desktop, gate, manager, worker, mirror, input, handle, attach, now: () => time,
    healthChecks: () => healthChecks, loadChecks: () => loadChecks, advance: (ms = 6_000) => { time += ms; } };
}

test("split VK prompt reaches Codex once and original fragments cannot replay or replace it", async t => {
  const s = setup(t); const binding = s.attach();
  const parts = ["a".repeat(8000), "b".repeat(8000), "last part"].map((text, i) => ({ ...s.input(text, peerId), eventId: `message:${900 + i}` }));
  const pending = parts.map(input => s.manager.handle(input));
  await s.manager.idle(); await Promise.all(pending);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.text, parts.map(input => input.text).join("\n"));
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  for (const input of parts) await restarted.handle(input);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.store.editableRequest(binding.id), null);
});

function panelView(s: ReturnType<typeof setup>, peer = peerId): View {
  const sent = s.chat.sent.filter(message => message.peerId === peer && message.view.buttons?.length).at(-1)!;
  return s.chat.edits.filter(edit => edit.handle.peerId === peer && edit.handle.conversationMessageId === sent.handle.conversationMessageId).at(-1)?.view ?? sent.view;
}

function assertThinking(text: string, frame: "думаю..." | "думаю.." | "думаю."): void {
  assert.match(text, new RegExp(`^${frame.replaceAll(".", "\\.")} · обновлено \\d{2}:\\d{2}:\\d{2}$`, "u"));
}

async function clickPanel(s: ReturnType<typeof setup>, label: string, peer = peerId): Promise<void> {
  const button = panelView(s, peer).buttons!.find(button => button.label === label);
  assert.ok(button, `Missing button ${label}`);
  s.advance(); await s.handle("", peer, button.action); await s.manager.panels.transfers.idle(); s.advance(); await s.worker.flush();
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

test("editing the latest standalone VK request replaces its Codex turn and deletes the discarded bot branch", async t => {
  const s = setup(t); const binding = s.attach();
  await s.manager.handle({ eventId: "message:41", peerId, senderId: access.ownerId, text: "Old request" });
  assert.equal(s.store.editableRequest(binding.id)?.mode, "start");
  s.mirror.accept(binding.id, { type: "progress", id: "old-progress", turnId: "submitted-turn", text: "Old progress" });
  await s.worker.flush();
  s.mirror.accept(binding.id, { type: "final", id: "old-final", turnId: "submitted-turn", text: "Old answer" });
  await s.worker.flush();
  const oldHandles = s.chat.sent.filter(item => /Old progress|Old answer/u.test(item.view.text)).map(item => item.handle.conversationMessageId);

  await s.manager.handle({ eventId: "message-edit:41:fixture", peerId, senderId: access.ownerId, text: "Corrected request", editOfMessageId: 41 });
  await s.worker.flush();
  assert.equal(s.desktop.messageEdits.length, 1);
  assert.equal(s.desktop.messageEdits[0]!.expectedTurnId, "submitted-turn");
  assert.deepEqual(s.chat.deletes.map(handle => handle.conversationMessageId).sort((a, b) => a - b), oldHandles.sort((a, b) => a - b));
  assert.match(s.chat.sent.at(-1)!.view.text, /Запрос обновлён в Codex/u);

  s.mirror.accept(binding.id, { type: "user", id: "replacement-user", turnId: "replacement-turn", text: desktopTaskInput(s.desktop.messageEdits[0]!).text, operationId: "replacement-operation" });
  await s.worker.flush();
  assert.equal(s.chat.sent.some(item => item.view.text.includes("## user request")), false);
  assert.equal(s.store.editableRequest(binding.id)?.turnId, "replacement-turn");
});

test("editing a VK steering message never rewrites the containing Codex turn", async t => {
  const s = setup(t); const binding = s.attach(); s.desktop.submitReceipt = { mode: "steer", turnId: "active-turn" };
  await s.manager.handle({ eventId: "message:42", peerId, senderId: 999, text: "Steering request" });
  await s.manager.handle({ eventId: "message-edit:42:fixture", peerId, senderId: 999, text: "Changed steering", editOfMessageId: 42 });
  await s.worker.flush();
  assert.equal(s.desktop.messageEdits.length, 0);
  assert.match(s.chat.sent.at(-1)!.view.text, /уточнение внутри уже идущего хода/u);
  assert.equal(s.store.editableRequest(binding.id)?.text, "Steering request");
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

test("manager load command reports the PC snapshot without reaching a Codex task", async t => {
  const s = setup(t); s.attach();
  await s.handle("/load");
  assert.equal(s.loadChecks(), 1);
  assert.match(s.chat.sent.at(-1)!.view.text, /^Нагрузка ПК\nCPU: 12\.5%\nRAM:/u);
  assert.deepEqual(s.chat.sent.at(-1)!.view.buttons, [MENU_BUTTON]);
  await s.handle("/pc"); assert.equal(s.loadChecks(), 2);
  await s.handle("/load", peerId);
  assert.equal(s.loadChecks(), 2);
  assert.match(s.chat.sent.at(-1)!.view.text, /VKodex · команды задачи/u);
  assert.equal(s.desktop.submissions.length, 0);
});

test("account limits are available from the manager and task chat without reaching the agent", async t => {
  const s = setup(t); s.attach(); s.desktop.capabilities.usageReset = true; await s.handle("/menu");
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

test("usage reset requires confirmation and safely retries an uncertain response", async t => {
  const s = setup(t); s.attach();
  s.desktop.capabilities.usageReset = true;
  s.desktop.usage = { ...s.desktop.usage, resetCredits: 2 };
  await s.handle("/limits", peerId);
  assert.deepEqual(panelView(s).buttons!.map(button => button.label), ["Сбросить лимит", "Обновить лимиты", "Меню"]);
  await clickPanel(s, "Сбросить лимит");
  assert.match(panelView(s).text, /Аккаунт: owner@example\.com[\s\S]*Доступно кредитов: 2[\s\S]*Операция необратима/u);

  s.desktop.usageResetError = new UncertainActionError();
  await clickPanel(s, "Сбросить лимит");
  assert.match(panelView(s).text, /Неизвестно, был ли списан кредит[\s\S]*прежний idempotency key/u);
  assert.equal(s.desktop.usageResets.length, 1);
  const operationId = s.desktop.usageResets[0]!.idempotencyKey;
  assert.match(operationId, /^[0-9a-f-]{36}$/u);

  s.desktop.usageResetError = null; s.desktop.usageResetOutcome = "alreadyRedeemed";
  await clickPanel(s, "Проверить тот же запрос");
  assert.equal(s.desktop.usageResets.length, 2);
  assert.equal(s.desktop.usageResets[1]!.idempotencyKey, operationId);
  assert.equal(s.desktop.usageResets[1]!.task.threadId, task.threadId);
  assert.match(panelView(s).text, /второй кредит не списан[\s\S]*Лимиты Codex/u);
});

test("task goals can be inspected, budgeted, paused, resumed and cleared without becoming prompts", async t => {
  const s = setup(t); s.attach(); s.desktop.capabilities.goals = true;
  await s.handle("/goal", peerId);
  assert.match(panelView(s).text, /Цель Codex не задана/u);
  assert.equal(s.desktop.submissions.length, 0);

  await clickPanel(s, "Задать цель");
  assert.match(panelView(s).text, /Пришли формулировку цели/u);
  await s.handle("Довести релиз до проверенного результата", peerId);
  assert.match(panelView(s).text, /Выбери общий бюджет токенов/u);
  assert.equal(s.desktop.submissions.length, 0);
  await clickPanel(s, "250 000");
  assert.deepEqual(s.desktop.goalUpdates[0], { objective: "Довести релиз до проверенного результата", tokenBudget: 250_000, status: "active" });
  assert.equal(s.desktop.goalContinuations, 1);
  assert.match(panelView(s).text, /Статус: Выполняется[\s\S]*Бюджет: 250 000 · осталось 250 000/u);

  await clickPanel(s, "Пауза");
  assert.deepEqual(s.desktop.goalUpdates[1], { status: "paused" });
  assert.match(panelView(s).text, /Статус: На паузе/u);
  await clickPanel(s, "Возобновить");
  assert.deepEqual(s.desktop.goalUpdates[2], { status: "active" });
  assert.equal(s.desktop.goalContinuations, 2);

  await clickPanel(s, "Снять цель");
  assert.match(panelView(s).text, /История задачи, файлы и VK-беседа сохранятся/u);
  await clickPanel(s, "Снять цель");
  assert.equal(s.desktop.goalClears, 1);
  assert.match(panelView(s).text, /Цель Codex не задана[\s\S]*Цель снята/u);
  assert.equal(s.desktop.submissions.length, 0);
});

test("custom goal budgets are validated and preserve a paused goal while editing", async t => {
  const s = setup(t); s.attach(); s.desktop.capabilities.goals = true;
  s.desktop.goal = { threadId: task.threadId, objective: "Old", status: "paused", tokenBudget: 50_000, tokensUsed: 12_500, timeUsedSeconds: 3_700, createdAt: 1_788_000_000, updatedAt: 1_788_000_100 };
  await s.handle("/goal", peerId);
  assert.match(panelView(s).text, /Израсходовано: 12 500[\s\S]*осталось 37 500[\s\S]*1 ч\. 1 мин\./u);
  await clickPanel(s, "Изменить"); await s.handle("Updated objective", peerId); await clickPanel(s, "Другой лимит");
  await s.handle("0", peerId); assert.match(s.chat.sent.at(-1)!.view.text, /Лимит цели должен быть/u);
  await s.handle("750_000", peerId);
  assert.deepEqual(s.desktop.goalUpdates.at(-1), { objective: "Updated objective", tokenBudget: 750_000 });
  assert.equal(s.desktop.goal!.status, "paused");
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

test("menu remains usable offline and invalidates a former mutation confirmation", async t => {
  const s = setup(t); s.attach();
  await s.handle("/menu", peerId); await clickPanel(s, "Архивировать");
  const staleAction = panelView(s).buttons!.find(button => button.label === "Архивировать")!.action;
  s.desktop.inspectError = new TaskNotOpenError();
  await s.handle("/menu", peerId);
  const menu = panelView(s);
  assert.match(menu.text, /Нет связи с задачей/u);
  assert.match(menu.text, /\/open/u);
  assert.ok(menu.buttons!.some(button => button.label === "Открыть в Codex"));
  assert.equal(s.desktop.opened.length, 0);
  await s.handle("", peerId, staleAction);
  assert.equal(s.desktop.archives.length, 0);
  assert.match(s.chat.sent.at(-1)!.view.text, /устарело/u);
  s.desktop.inspectError = null;
  await s.handle("/menu", peerId);
  assert.match(panelView(s).text, /Ожидает сообщения/u);
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
  assert.ok(panelView(s).buttons!.length <= 10);
  await clickPanel(s, "Переместить"); await clickPanel(s, "В проект");
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

test("a reacquired owner does not resend a final already mirrored with another item ID", async t => {
  const s = setup(t); const binding = s.attach();
  const oldId = "msg-from-rollout";
  const turnId = "completed-turn";
  const text = "Previously delivered answer";
  // Simulate a final journaled before semantic IDs existed. Its VK message
  // was split into chunks and the native owner later names it differently.
  s.store.rememberEvent(binding.id, oldId);
  s.store.enqueue(`event:${binding.id}:${oldId}:0`, peerId, { text: "Previously " }, binding.id, false, turnId);
  s.store.enqueue(`event:${binding.id}:${oldId}:1`, peerId, { text: "delivered answer\n\nМеню задачи:", buttons: [MENU_BUTTON] }, binding.id, false, turnId);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 2);

  s.mirror.accept(binding.id, { type: "final", id: "item-441", turnId, text });
  s.mirror.accept(binding.id, { type: "final", id: "item-442", turnId, text });
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 2);
  assert.equal(s.store.hasEvent(binding.id, "item-441"), true);

  s.mirror.accept(binding.id, { type: "final", id: "corrected", turnId, text: "Corrected answer" });
  s.mirror.accept(binding.id, { type: "final", id: "same-text-next-turn", turnId: "next-turn", text });
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 4);
});

test("a native owner VK title change renames the linked Codex task and strips the bridge prefix", async t => {
  const s = setup(t); const binding = s.attach();
  await s.manager.handle({ ...s.input("", peerId), eventId: "chat-title:2000000017:41:fixture", conversationTitle: "[VKodex] ARC : NeuroDynTruss - WORKER" });
  assert.deepEqual(s.desktop.renames, [{ task: binding, title: "ARC : NeuroDynTruss - WORKER" }]);
  assert.equal(s.store.getBinding(binding.id)!.title, "ARC : NeuroDynTruss - WORKER");
  assert.deepEqual(s.store.getValue(`rename:${binding.id}`), {
    title: "ARC : NeuroDynTruss - WORKER", liveTitleUpdated: true, vkTitleUpdated: true, origin: "vk", attempts: 0, retryAt: 0,
  });
  assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.chat.renames.length, 0);
});

test("a native VK title change from another participant cannot rename the Codex task", async t => {
  const s = setup(t); s.attach();
  await s.manager.handle({ ...s.input("", peerId), senderId: 303, eventId: "chat-title:2000000017:42:fixture", conversationTitle: "[VKodex] Malicious rename" });
  assert.equal(s.desktop.renames.length, 0);
  assert.equal(s.store.getBinding(s.attach().id)!.title, task.title);
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

test("catalog transfer keeps the VK conversation, retargets streaming and archives the source", async t => {
  const s = setup(t); const original = s.attach();
  // Simulate a legacy marker inherited from an earlier transfer. It is not a
  // pending turn of the current source and must neither block nor reach target.
  s.store.recordOperation("source-operation", { ...original, threadId: "older-source" });
  s.store.finishOperation("source-operation", "accepted");
  s.store.rememberAcceptedTurn(original.id, "source-turn", "source-operation");
  s.store.recordOperation("queued-source-operation", { ...original, threadId: "older-source" });
  s.store.finishOperation("queued-source-operation", "accepted");
  s.store.rememberQueuedInput(original.id, "queued-source-operation", "old-native-queue");
  s.store.recordOperation("uncertain-source-operation", { ...original, threadId: "older-source" }, "old-inbox", original.id);
  s.store.finishOperation("uncertain-source-operation", "uncertain");
  s.store.setValue(`health:legacy-accepted:${original.id}`, { signature: "old", firstSeenAt: 1 });
  s.desktop.capabilities.transferTask = true;
  s.desktop.sources = [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }];
  s.desktop.sourceProjects = { "": s.desktop.projects, work: [] };
  await s.handle("/menu", peerId);
  await clickPanel(s, "Переместить");
  await clickPanel(s, "В другой каталог");
  await clickPanel(s, ".codex-work");
  await clickPanel(s, "Без проекта");
  // The App Server transfer contract validates the last terminal turn itself;
  // an unloaded or failed source must not depend on a live desktop snapshot.
  s.desktop.inspectTask = async ref => { assert.notEqual(ref?.threadId, original.threadId); return s.desktop.details; };
  await clickPanel(s, "Перенести");

  const moved = s.store.byPeer(peerId)!;
  assert.equal(moved.id, original.id); assert.equal(moved.threadId, "moved-work"); assert.equal(moved.sourceId, "work");
  assert.equal(s.desktop.transfers.length, 1); assert.equal(s.desktop.opened.length, 1);
  assert.equal(s.desktop.archives.length, 1); assert.equal(s.desktop.archives[0]!.threadId, task.threadId);
  assert.equal(s.store.transfer(original.id)!.phase, "complete");
  const projection = s.store.getValue<import("../src/core/task-observation.js").TaskObservationCheckpoint>(`projection:${original.id}`);
  assert.ok(projection && projection.since > 0);
  assert.deepEqual(projection.seen, {});
  assert.deepEqual(s.store.acceptedTurns(original.id), []);
  assert.deepEqual(s.store.getValue(`accepted-turns:${original.id}`), []);
  assert.deepEqual(s.store.queuedInputs(original.id), []);
  assert.deepEqual(s.store.getValue(`queued-inputs:${original.id}`), []);
  assert.equal(s.store.getValue(`health:legacy-accepted:${original.id}`), null);
  assert.equal(s.store.streamGeneration(original.id), 2);
});

test("automation notifications do not append a task menu", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.accept(binding.id, { type: "final", id: "automation-final", turnId: "automation-turn",
    text: "Needs attention.", showMenu: false });
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "Needs attention." }]);
});

test("catalog transfer reapplies the target project after opening its Codex client", async t => {
  const s = setup(t); const original = s.attach();
  s.desktop.capabilities.transferTask = true;
  s.desktop.sources = [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }];
  s.desktop.sourceProjects = { "": s.desktop.projects, work: [{ id: "work-project", title: "Target project", workspace: "/project" }] };
  await s.handle("/menu", peerId);
  await clickPanel(s, "Переместить");
  await clickPanel(s, "В другой каталог");
  await clickPanel(s, ".codex-work");
  await clickPanel(s, "Target project");
  await clickPanel(s, "Перенести");

  assert.equal(s.desktop.opened.length, 1);
  assert.deepEqual(s.desktop.moves, [{ task: s.desktop.opened[0]!, projectId: "work-project" }]);
  assert.equal(s.store.transfer(original.id)!.target?.projectId, "work-project");
  assert.equal(s.store.transfer(original.id)!.phase, "complete");
});

test("a switched transfer retries only source archiving and completes", async t => {
  const s = setup(t); const original = s.attach();
  s.desktop.capabilities.transferTask = true;
  s.desktop.sources = [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }];
  s.desktop.sourceProjects = { "": s.desktop.projects, work: [] };
  let rejectArchive = true;
  s.desktop.archiveTask = async ref => {
    if (rejectArchive) throw new ActionRejectedError("source busy");
    s.desktop.archives.push(ref); s.desktop.tasks = s.desktop.tasks.filter(task => task.threadId !== ref.threadId);
  };
  await s.handle("/menu", peerId); await clickPanel(s, "Переместить"); await clickPanel(s, "В другой каталог");
  await clickPanel(s, ".codex-work"); await clickPanel(s, "Без проекта"); await clickPanel(s, "Перенести");
  assert.equal(s.store.byPeer(peerId)!.threadId, "moved-work");
  assert.equal(s.store.transfer(original.id)!.phase, "switched");
  await s.handle("/menu", peerId);
  assert.ok(panelView(s).buttons?.some(button => button.label === "Повторить архивацию"));
  await s.handle("/menu", peerId);
  assert.match(panelView(s).text, /Не завершена архивация источника/u);
  assert.match(panelView(s).text, /source busy/u);
  rejectArchive = false;
  s.desktop.tasks = s.desktop.tasks.map(task => task.threadId === "moved-work" ? { ...task, projectId: "wrong-project" } : task);
  await clickPanel(s, "Повторить архивацию");
  await s.handle("/menu", peerId);
  assert.equal(s.desktop.transfers.length, 1);
  assert.equal(s.desktop.archives.length, 1);
  assert.equal(s.store.transfer(original.id)!.phase, "complete");
  assert.equal(panelView(s).buttons?.some(button => button.label === "Повторить архивацию"), false);
  assert.doesNotMatch(panelView(s).text, /source busy/u);
});

test("a reverse transfer cannot overwrite a legacy operation without a saved boundary", async t => {
  const s = setup(t); const current = s.attach();
  s.desktop.capabilities.transferTask = true;
  s.desktop.sources = [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }];
  s.desktop.sourceProjects = { "": s.desktop.projects, work: [] };
  const oldSource: DesktopTask = { ...task, threadId: "old-work", sourceId: "work", sourceLabel: ".codex-work", projectId: null };
  s.desktop.tasks.push(oldSource);
  s.store.markTransfer({
    id: "previous-transfer", bindingId: current.id, startedAt: 1, source: oldSource,
    targetSourceId: "", targetProjectId: "project-a", phase: "switched", target: task,
    detail: "source was busy",
  });

  await s.handle("/menu", peerId); await clickPanel(s, "Переместить"); await clickPanel(s, "В другой каталог");
  await clickPanel(s, ".codex-work"); await clickPanel(s, "Без проекта"); await clickPanel(s, "Перенести");

  assert.equal(s.store.byPeer(peerId)!.threadId, task.threadId);
  assert.equal(s.desktop.archives.length, 0);
  assert.equal(s.desktop.transfers.length, 0);
  assert.equal(s.store.transfer(current.id)!.id, "previous-transfer");
});

test("a rejected transfer retains its fork and offers a recovery action instead of starting over", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.capabilities.transferTask = true;
  const target = { ...task, threadId: "existing-fork", sourceId: "work", sourceLabel: ".codex-work", projectId: null };
  s.desktop.tasks.push(target);
  const record = { id: "original-operation", bindingId: binding.id, startedAt: 1, source: task, targetSourceId: "work", targetProjectId: null, phase: "failed" as const,
    version: 2 as const, checkpoint: await s.desktop.transferCheckpoint(), goal: null };
  s.store.markTransfer(record);
  let attempts = 0;
  s.desktop.transferTask = async request => {
    attempts++; assert.equal(request.operationId, record.id);
    if (attempts === 1) {
      request.onForkCreated?.(target);
      throw new ActionRejectedError("metadata failed after fork");
    }
    assert.equal(request.existingTarget?.threadId, target.threadId);
    return target;
  };
  await s.handle("/menu", peerId); await clickPanel(s, "Продолжить перенос");
  assert.equal(s.store.transfer(binding.id)?.phase, "preparingTarget");
  assert.equal(s.store.transfer(binding.id)?.target?.threadId, target.threadId);
  assert.equal(s.store.byPeer(peerId)!.threadId, task.threadId);
  await s.handle("/menu", peerId);
  await clickPanel(s, "Продолжить перенос");
  assert.equal(s.store.transfer(binding.id)?.phase, "complete");
  assert.equal(s.store.byPeer(peerId)!.threadId, target.threadId);
  assert.equal(s.desktop.archives.length, 1);
});

function transferFixture(s: ReturnType<typeof setup>) {
  const binding = s.attach();
  return { id: "durable-transfer", bindingId: binding.id, startedAt: s.now(), source: { ...task },
    targetSourceId: "work", targetProjectId: null, phase: "forking" as const };
}

test("transfer switches the VK observation epoch after copied history", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.store.setValue(`projection:${record.bindingId}`, { since: 1, lastObservedAt: 2,
    activeAtAttach: ["old-turn"], active: [], seen: { old: "hash" }, rolloutPath: "/source.jsonl" });
  s.advance(5_000);
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  const boundary = s.store.getValue<import("../src/core/task-observation.js").TaskObservationCheckpoint>(`projection:${record.bindingId}`);
  assert.equal(boundary?.since, s.now());
  assert.equal(boundary?.lastObservedAt, s.now());
  assert.deepEqual(boundary?.seen, {});
  assert.deepEqual(boundary?.activeAtAttach, []);
  assert.match(boundary?.rolloutPath ?? "", /target[\\/]work\.jsonl$/u);
});

test("background transfer retains its lock while the handler, manager and other conversations remain usable", async t => {
  const s = setup(t); const record = transferFixture(s);
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  const original = s.desktop.transferTask.bind(s.desktop);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  s.desktop.transferTask = async request => { calls++; entered(); await released; return original(request); };
  transfers.start(record); await started;
  transfers.resume(record.bindingId); transfers.tick();
  const secondWorker = new TaskTransfers(s.store, s.desktop, s.now);
  secondWorker.tick(); await secondWorker.idle();
  await s.handle("/help");
  await s.handle("Do not send this to the old source", peerId);
  assert.equal(calls, 1);
  assert.equal(s.desktop.submissions.length, 0);
  assert.ok(s.chat.sent.some(message => message.peerId === access.ownerId && message.view.text.includes("команды менеджера")));
  assert.ok(s.chat.sent.some(message => message.peerId === peerId && message.view.text.includes("задача переносится")));
  release(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
});

test("a stopped executor resumes its saved target after client recovery without another fork or foreground launch", async t => {
  const s = setup(t); const record = transferFixture(s);
  let unavailable = true;
  s.desktop.ensureOpen = async ref => { s.desktop.opened.push(ref); if (unavailable) throw new TaskNotOpenError(); };
  const first = new TaskTransfers(s.store, s.desktop, s.now);
  first.start(record); await first.idle(); await first.stop();
  const pending = s.store.transfer(record.bindingId)!;
  assert.equal(pending.phase, "targetCreated"); assert.equal(pending.launchAttempted, true);
  assert.equal(s.store.byPeer(peerId)?.threadId, task.threadId);
  unavailable = false; s.advance(30_000);
  const restarted = new TaskTransfers(s.store, s.desktop, s.now);
  restarted.tick(); await restarted.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(s.desktop.transfers.length, 1); assert.equal(s.desktop.opened.length, 1);
});

test("a new executor recovers a saved launch intent that never reached the target client", async t => {
  const s = setup(t); const record = transferFixture(s);
  let launchCalls = 0;
  s.desktop.inspectError = new TaskNotOpenError();
  s.desktop.ensureOpen = async ref => {
    s.desktop.opened.push(ref);
    launchCalls++;
    if (launchCalls === 1) throw new TaskNotOpenError();
    s.desktop.inspectError = null;
  };
  const first = new TaskTransfers(s.store, s.desktop, s.now);
  first.start(record); await first.idle(); await first.stop();
  const pending = s.store.transfer(record.bindingId)!;
  assert.equal(pending.phase, "targetCreated");
  assert.equal(pending.launchAttempted, true);
  assert.ok(pending.launchOwner);
  s.advance(30_000);
  const restarted = new TaskTransfers(s.store, s.desktop, s.now);
  restarted.tick(); await restarted.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(s.desktop.transfers.length, 1);
  assert.equal(s.desktop.opened.length, 2);
});

test("every durable transfer stage resumes after executor loss without another target copy", async t => {
  for (const crashStep of ["snapshot", "fork", "open", "metadata", "goal", "verify", "archive"] as const) {
    const s = setup(t); const record = transferFixture(s);
    const update = s.store.updateTransfer.bind(s.store);
    let crashed = false;
    s.store.updateTransfer = (previous, changes, now) => {
      const saved = update(previous, changes, now);
      if (!crashed && changes.step === crashStep) {
        crashed = true;
        throw new Error(`simulated executor loss after ${crashStep}`);
      }
      return saved;
    };
    const first = new TaskTransfers(s.store, s.desktop, s.now);
    first.start(record); await first.idle(); await first.stop();
    assert.equal(crashed, true, `stage ${crashStep} was not reached`);
    assert.notEqual(s.store.transfer(record.bindingId)?.phase, "complete");
    s.store.updateTransfer = update;
    const restarted = new TaskTransfers(s.store, s.desktop, s.now);
    restarted.tick(); await restarted.idle();
    assert.equal(s.store.transfer(record.bindingId)?.phase, "complete", `stage ${crashStep} did not recover`);
    assert.equal(s.store.byPeer(peerId)?.threadId, "moved-work");
    assert.equal(s.desktop.tasks.filter(candidate => candidate.threadId === "moved-work").length, 1);
    assert.equal(s.desktop.archives.length, 1);
  }
});

test("a lost fork submission remains uncertain instead of sending another fork", async t => {
  const s = setup(t); const record = transferFixture(s);
  const update = s.store.updateTransfer.bind(s.store);
  let crashed = false;
  s.store.updateTransfer = (previous, changes, now) => {
    const saved = update(previous, changes, now);
    if (!crashed && changes.forkSubmitted) {
      crashed = true;
      throw new Error("simulated executor loss before fork dispatch");
    }
    return saved;
  };
  const fork = s.desktop.transferTask.bind(s.desktop);
  s.desktop.transferTask = async request => {
    if (request.forkSubmitted && !request.existingTarget) throw new TransferConflictError("fork outcome unconfirmed");
    return fork(request);
  };
  const first = new TaskTransfers(s.store, s.desktop, s.now);
  first.start(record); await first.idle(); await first.stop();
  assert.equal(crashed, true);
  s.store.updateTransfer = update;
  const restarted = new TaskTransfers(s.store, s.desktop, s.now);
  restarted.tick(); await restarted.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blocked, true);
  assert.equal(s.store.byPeer(peerId)?.threadId, task.threadId);
  assert.equal(s.desktop.transfers.length, 1);
  assert.equal(s.desktop.archives.length, 0);
});

test("a saved fork target and an atomic VK switch survive lost acknowledgments", async t => {
  for (const crashAt of ["target", "switch"] as const) {
    const s = setup(t); const record = transferFixture(s);
    if (crashAt === "target") {
      const update = s.store.updateTransfer.bind(s.store);
      let crashed = false;
      s.store.updateTransfer = (previous, changes, now) => {
        const saved = update(previous, changes, now);
        if (!crashed && changes.phase === "preparingTarget" && changes.target) {
          crashed = true;
          throw new Error("simulated executor loss after target identity was saved");
        }
        return saved;
      };
      const first = new TaskTransfers(s.store, s.desktop, s.now);
      first.start(record); await first.idle(); await first.stop();
      assert.equal(crashed, true);
      assert.equal(s.store.transfer(record.bindingId)?.target?.threadId, "moved-work");
      s.store.updateTransfer = update;
    } else {
      const switched = s.store.switchTransfer.bind(s.store);
      let crashed = false;
      s.store.switchTransfer = (previous, target, now) => {
        const binding = switched(previous, target, now);
        if (!crashed) { crashed = true; throw new Error("simulated executor loss after VK switch"); }
        return binding;
      };
      const first = new TaskTransfers(s.store, s.desktop, s.now);
      first.start(record); await first.idle(); await first.stop();
      assert.equal(crashed, true);
      assert.equal(s.store.transfer(record.bindingId)?.phase, "switched");
      s.store.switchTransfer = switched;
    }
    const restarted = new TaskTransfers(s.store, s.desktop, s.now);
    restarted.tick(); await restarted.idle();
    assert.equal(s.store.transfer(record.bindingId)?.phase, "complete", `${crashAt} did not recover`);
    assert.equal(s.store.byPeer(peerId)?.threadId, "moved-work");
    assert.equal(s.desktop.tasks.filter(candidate => candidate.threadId === "moved-work").length, 1);
    assert.equal(s.desktop.archives.length, 1);
  }
});

test("a changed source snapshot blocks switching and archival instead of hiding newer work", async t => {
  const s = setup(t); const record = transferFixture(s);
  let checks = 0;
  s.desktop.verifyTransferSource = async () => { if (++checks === 2) throw new TransferConflictError("source advanced"); };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.byPeer(peerId)?.threadId, task.threadId);
  assert.equal(s.desktop.archives.length, 0);
  assert.equal(s.store.transfer(record.bindingId)?.blocked, true);
  s.advance(900_000); transfers.tick(); await transfers.idle();
  assert.equal(s.desktop.transfers.length, 1);
});

test("source archival retries autonomously and ignores absence from a broken display catalog", async t => {
  const s = setup(t); const record = transferFixture(s);
  let failing = true;
  s.desktop.archiveRetryReady = async () => !failing;
  const archive = s.desktop.archiveTask.bind(s.desktop);
  s.desktop.archiveTransferredSource = async ref => { if (failing) throw new TaskNotOpenError(); await archive(ref); };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "switched");
  s.desktop.tasks = []; s.advance(30_000);
  transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "switched");
  failing = false; s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(s.desktop.transfers.length, 1); assert.equal(s.desktop.archives.length, 1);
});

test("goal transfer preserves objective, remaining budget and accounting without activating two agents", async t => {
  const s = setup(t); const record = transferFixture(s);
  const sourceGoal: TaskGoal = { threadId: task.threadId, objective: "Finish the requested fixture", status: "active", tokenBudget: 100_000,
    tokensUsed: 60_000, timeUsedSeconds: 120, createdAt: 1, updatedAt: 2 };
  const goals = new Map<string, TaskGoal>([[task.threadId, sourceGoal]]);
  const writes: { threadId: string; update: TaskGoalUpdate }[] = [];
  let loseReply = true;
  s.desktop.getGoal = async ref => goals.get(ref!.threadId) ?? null;
  s.desktop.setGoal = async (ref, update) => {
    writes.push({ threadId: ref.threadId, update });
    const next = { ...(goals.get(ref.threadId) ?? { threadId: ref.threadId, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 3, updatedAt: 3 }), ...update } as TaskGoal;
    goals.set(ref.threadId, next);
    if (ref.threadId !== task.threadId && loseReply) { loseReply = false; throw new UncertainActionError(); }
    return next;
  };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.byPeer(peerId)?.threadId, task.threadId);
  s.advance(30_000); transfers.tick(); await transfers.idle();
  const moved = s.store.byPeer(peerId)!;
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.deepEqual(writes, [{ threadId: task.threadId, update: { status: "paused" } },
    { threadId: moved.threadId, update: { objective: sourceGoal.objective, tokenBudget: 40_000, status: "paused" } }]);
  const saved = s.store.getValue<{ tokensUsed: number; timeUsedSeconds: number }>(`transferred-goal:${JSON.stringify([moved.hostId, moved.threadId, moved.sourceId])}`)!;
  assert.equal(saved.tokensUsed, 60_000); assert.equal(saved.timeUsedSeconds, 120);
  assert.equal(s.desktop.goalContinuations, 0);
});

test("legacy unfinished transfers are reported but never automatically replayed", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.store.markTransfer({ ...record, phase: "preparingTarget" });
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.tick(); await transfers.idle();
  assert.equal(s.desktop.transfers.length, 0);
  transfers.resume(record.bindingId); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blocked, true);
  assert.equal(s.desktop.transfers.length, 0); assert.equal(s.desktop.archives.length, 0);
});

test("a completed goal stays complete even when its final usage exceeded its budget", async t => {
  const s = setup(t); const record = transferFixture(s);
  const source: TaskGoal = { threadId: task.threadId, objective: "Completed fixture", status: "complete", tokenBudget: 1000,
    tokensUsed: 1100, timeUsedSeconds: 5, createdAt: 1, updatedAt: 2 };
  const goals = new Map([[task.threadId, source]]);
  s.desktop.getGoal = async ref => goals.get(ref!.threadId) ?? null;
  s.desktop.setGoal = async (ref, update) => {
    const goal = { ...source, ...update, threadId: ref.threadId, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 3 };
    goals.set(ref.threadId, goal); return goal;
  };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  const target = s.store.transfer(record.bindingId)!.target!;
  assert.equal(goals.get(target.threadId)?.status, "complete");
  assert.equal(s.desktop.goalContinuations, 0);
});

test("an owner-held archive is not retried; read-only confirmation completes it after restart", async t => {
  const s = setup(t); const record = transferFixture(s);
  let archiveCalls = 0; let reads = 0;
  s.desktop.archiveTransferredSource = async () => { archiveCalls++; throw new ArchiveOwnerRequiredError(); };
  const archived = s.desktop.isTaskArchived.bind(s.desktop);
  s.desktop.isTaskArchived = async ref => { reads++; return archived(ref); };
  const first = new TaskTransfers(s.store, s.desktop, s.now);
  first.start(record); await first.idle(); await first.stop();
  assert.equal(s.store.transfer(record.bindingId)?.blockedReason, "archiveOwner");
  assert.equal(s.store.transferBlocksInput(record.bindingId), false);
  const restarted = new TaskTransfers(s.store, s.desktop, s.now);
  restarted.tick(); await restarted.idle(); const firstReads = reads;
  restarted.tick(); await restarted.idle(); assert.equal(reads, firstReads);
  s.advance(60_000); restarted.tick(); await restarted.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "switched");
  s.desktop.archives.push(task); s.advance(60_000); restarted.tick(); await restarted.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(archiveCalls, 1); assert.equal(s.desktop.transfers.length, 1);
  assert.equal(s.store.transfer(record.bindingId)?.attempt, 1);
});

test("a returned idle owner resumes only the saved archive stage", async t => {
  const s = setup(t); const record = transferFixture(s);
  let ownerReady = false; let archiveCalls = 0;
  const archive = s.desktop.archiveTransferredSource.bind(s.desktop);
  s.desktop.archiveRetryReady = async () => ownerReady;
  s.desktop.archiveTransferredSource = async ref => {
    archiveCalls++;
    if (!ownerReady) throw new ArchiveOwnerRequiredError();
    await archive(ref);
  };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "switched");
  assert.equal(archiveCalls, 1);
  s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(archiveCalls, 1);
  ownerReady = true; s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(archiveCalls, 2);
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(s.desktop.transfers.length, 1);
});

test("a rejected archive preflight retries the saved stage after the source becomes ready", async t => {
  const s = setup(t); const record = transferFixture(s);
  let ready = false; let archives = 0;
  const archive = s.desktop.archiveTransferredSource.bind(s.desktop);
  s.desktop.archiveRetryReady = async () => ready;
  s.desktop.archiveTransferredSource = async ref => {
    archives++;
    if (!ready) throw new ActionRejectedError("Исходная и дочерние задачи должны быть завершены перед архивацией.");
    await archive(ref);
  };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blockedReason, "archiveRejected");
  assert.equal(archives, 1);
  ready = true; s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(archives, 2); assert.equal(s.desktop.transfers.length, 1);
});

test("an old read timeout at archive is reconciled before retrying without another fork", async t => {
  const s = setup(t); const record = transferFixture(s);
  let ready = false; let archives = 0;
  const archive = s.desktop.archiveTransferredSource.bind(s.desktop);
  s.desktop.archiveRetryReady = async () => ready;
  s.desktop.archiveTransferredSource = async ref => {
    archives++;
    if (!ready) throw new DesktopUnavailableError("Процесс переноса Codex не завершился вовремя.");
    await archive(ref);
  };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blockedReason, "archiveReadUnavailable");
  const current = s.store.transfer(record.bindingId)!;
  s.store.updateTransfer(current, { blockedReason: null }, s.now()); // persisted legacy record
  ready = true; s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(archives, 2); assert.equal(s.desktop.transfers.length, 1);
});

test("transfer cannot discard an accepted VK turn whose completion is still unknown", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.store.recordOperation("accepted-operation", record.source, "vk-inbox", record.bindingId, s.now());
  s.store.finishOperation("accepted-operation", "accepted");
  s.store.rememberAcceptedTurn(record.bindingId, "accepted-turn", "accepted-operation");
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  const saved = s.store.transfer(record.bindingId)!;
  assert.equal(saved.blocked, true);
  assert.match(saved.detail ?? "", /принятый VK-ход без подтверждённого завершения/u);
  assert.equal(saved.checkpoint, undefined);
  assert.equal(s.desktop.transfers.length, 0);
  assert.equal(s.store.byPeer(peerId)?.threadId, task.threadId);
});

test("transfer waits for an unresolved VK prompt instead of racing its Codex acceptance", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.store.recordOperation("uncertain-operation", record.source, "vk-inbox", record.bindingId, s.now());
  s.store.finishOperation("uncertain-operation", "uncertain");
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  const saved = s.store.transfer(record.bindingId)!;
  assert.equal(saved.blocked, true);
  assert.match(saved.detail ?? "", /неподтверждённым результатом отправки/u);
  assert.equal(saved.checkpoint, undefined);
  assert.equal(s.desktop.transfers.length, 0);
  assert.equal(s.store.byPeer(peerId)?.threadId, task.threadId);
});

test("transfer waits for the native Codex queue instead of losing queued VK input", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.store.recordOperation("queued-operation", record.source, "vk-inbox", record.bindingId, s.now());
  s.store.finishOperation("queued-operation", "accepted");
  s.store.rememberQueuedInput(record.bindingId, "queued-operation", "native-queue-id", s.now());
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  const saved = s.store.transfer(record.bindingId)!;
  assert.equal(saved.blocked, true);
  assert.match(saved.detail ?? "", /штатной очереди исходной задачи/u);
  assert.equal(saved.checkpoint, undefined);
  assert.equal(s.desktop.transfers.length, 0);
  assert.equal(s.store.byPeer(peerId)?.threadId, task.threadId);
});

test("native queue recovery retains every accepted item until Codex starts it", t => {
  const s = setup(t); const binding = s.attach();
  for (let index = 0; index < 40; index++) {
    const operationId = `queued-operation-${index}`;
    s.store.recordOperation(operationId, binding, `vk-inbox-${index}`, binding.id, s.now() + index);
    s.store.finishOperation(operationId, "accepted");
    s.store.rememberQueuedInput(binding.id, operationId, `native-queue-${index}`, s.now() + index);
  }
  assert.equal(s.store.queuedInputs(binding.id).length, 40);
});

test("an uncertain archive is read-only until native state confirms it", async t => {
  const s = setup(t); const record = transferFixture(s);
  let archiveCalls = 0;
  s.desktop.archiveRetryReady = async () => true;
  s.desktop.archiveTransferredSource = async () => { archiveCalls++; throw new UncertainActionError(); };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blockedReason, "archiveUnknown");
  assert.equal(archiveCalls, 1);
  assert.throws(() => transfers.resume(record.bindingId), /не повторит/u);
  s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(archiveCalls, 1);
  assert.equal(s.store.transfer(record.bindingId)?.phase, "switched");
  s.desktop.archives.push(task); s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(archiveCalls, 1);
});

test("a legacy archived source can finish after semantic comparison with the switched target", async t => {
  const s = setup(t); const record = transferFixture(s);
  let archived = false; let pairChecks = 0;
  s.desktop.isTaskArchived = async (_ref, checkpoint) => {
    if (archived && checkpoint) throw new TransferConflictError("Archived rollout path changed");
    return archived;
  };
  s.desktop.archiveTransferredSource = async () => { archived = true; };
  s.desktop.verifyLegacyArchivedPair = async (source, target, checkpoint) => {
    pairChecks++;
    assert.equal(source.threadId, task.threadId);
    assert.notEqual(target.threadId, source.threadId);
    assert.equal(checkpoint.lastTurnId, "boundary");
  };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(pairChecks, 1);
  assert.equal(s.desktop.transfers.length, 1);
});

test("an older blocked switched transfer reconciles an archived source without retrying its write", async t => {
  const s = setup(t); const record = transferFixture(s);
  let writes = 0; let archived = false;
  s.desktop.archiveTransferredSource = async () => { writes++; throw new TransferConflictError("Legacy owner refused"); };
  s.desktop.isTaskArchived = async (_ref, checkpoint) => {
    if (archived && checkpoint) throw new TransferConflictError("Rollout moved during archival");
    return archived;
  };
  s.desktop.verifyLegacyArchivedPair = async () => {};
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blockedReason, null);
  assert.equal(writes, 1);
  archived = true; s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.phase, "complete");
  assert.equal(writes, 1);
});

test("an older blocked transfer reports a changed source instead of retrying its archive", async t => {
  const s = setup(t); const record = transferFixture(s);
  let writes = 0;
  s.desktop.archiveTransferredSource = async () => { writes++; throw new TransferConflictError("Legacy owner refused"); };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blockedReason, null);
  s.desktop.verifyTransferSource = async () => { throw new TransferConflictError("Source received another completed turn"); };
  s.advance(60_000); transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.blockedReason, "sourceChanged");
  assert.match(s.store.transfer(record.bindingId)?.detail ?? "", /another completed turn/u);
  assert.equal(writes, 1);
  assert.throws(() => transfers.resume(record.bindingId), /автоматическая архивация запрещена/u);
  const target = s.store.byPeer(peerId)!;
  await s.handle("/menu", peerId);
  await clickPanel(s, "Разрешить конфликт");
  assert.match(panelView(s).text, /Оставить обе копии/u);
  await clickPanel(s, "Оставить обе копии");
  const resolved = s.store.transfer(record.bindingId)!;
  assert.equal(resolved.phase, "cancelled");
  assert.equal(resolved.conflictResolution, "keptBoth");
  assert.equal(resolved.blockedReason, null);
  assert.equal(s.store.byPeer(peerId)!.threadId, target.threadId);
  assert.equal(writes, 1);
  assert.match(transferStatus(resolved), /источник сохранён.*не архивирован/u);
});

test("archive confirmation does not close a transfer after its goal or binding changes", async t => {
  for (const change of ["goal", "binding"] as const) {
    const s = setup(t); const record = transferFixture(s);
    s.desktop.archiveTransferredSource = async () => { throw new ArchiveOwnerRequiredError(); };
    const transfers = new TaskTransfers(s.store, s.desktop, s.now);
    transfers.start(record); await transfers.idle();
    s.desktop.archives.push(task);
    if (change === "goal") s.desktop.goal = { threadId: task.threadId, objective: "New goal", status: "paused", tokenBudget: null,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    else {
      const originalGet = s.store.getBinding.bind(s.store);
      s.store.getBinding = id => { const value = originalGet(id); return value ? { ...value, threadId: "different-target" } : value; };
    }
    transfers.tick(); await transfers.idle();
    assert.equal(s.store.transfer(record.bindingId)?.phase, "switched");
  }
});

test("legacy switched records reconcile only native archived sources without inventing a history checkpoint", async t => {
  const s = setup(t); const binding = s.attach();
  const oldSource = { ...task, threadId: "archived-source", sourceId: "work" };
  s.store.markTransfer({ id: "legacy-switched", bindingId: binding.id, startedAt: 1, source: oldSource,
    target: task, targetSourceId: "", targetProjectId: task.projectId ?? null, phase: "switched" });
  s.desktop.archives.push(oldSource);
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.resume(binding.id); await transfers.idle();
  const reconciled = s.store.transfer(binding.id)!;
  assert.equal(reconciled.phase, "complete"); assert.equal(reconciled.legacyReconciled, true);
  assert.equal(reconciled.checkpoint, undefined);
  assert.match(transferStatus(reconciled), /Граница старой истории не была записана/u);
  assert.equal(s.desktop.transfers.length, 0); assert.equal(s.desktop.opened.length, 0);
  assert.equal(s.desktop.archives.length, 1);
});

test("cancelling a blocked pre-commit transfer releases input without deleting the saved copy", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.desktop.ensureOpen = async () => { throw new TaskNotOpenError(); };
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  assert.equal(s.store.transferBlocksInput(record.bindingId), true);
  const target = s.store.transfer(record.bindingId)!.target;
  transfers.cancel(record.bindingId);
  assert.equal(s.store.transfer(record.bindingId)?.phase, "cancelled");
  assert.equal(s.store.transfer(record.bindingId)?.target?.threadId, target?.threadId);
  assert.equal(s.store.transferBlocksInput(record.bindingId), false);
  await s.handle("Continue the original", peerId);
  assert.equal(s.desktop.submissions.at(-1)?.task.threadId, task.threadId);
  assert.equal(s.desktop.archives.length, 0);
});

test("repeated recoverable errors use bounded backoff and never cycle the foreground window", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.desktop.ensureOpen = async ref => { s.desktop.opened.push(ref); throw new TaskNotOpenError(); };
  s.desktop.inspectError = new TaskNotOpenError();
  const transfers = new TaskTransfers(s.store, s.desktop, s.now);
  transfers.start(record); await transfers.idle();
  const firstRetryAt = s.store.transfer(record.bindingId)!.retryAt!;
  transfers.tick(); await transfers.idle();
  assert.equal(s.store.transfer(record.bindingId)?.attempt, 1);
  for (let attempt = 2; attempt <= 8; attempt++) {
    s.advance(700_000); transfers.tick(); await transfers.idle();
  }
  const blocked = s.store.transfer(record.bindingId)!;
  assert.ok(firstRetryAt > record.startedAt); assert.equal(blocked.blocked, true);
  assert.equal(blocked.attempt, 8); assert.equal(s.desktop.opened.length, 1);
  assert.equal(s.desktop.transfers.length, 1); assert.equal(s.desktop.archives.length, 0);
});

test("late transfer callbacks cannot overwrite a newer revision or a later operation", async t => {
  const s = setup(t); const record = transferFixture(s);
  s.store.beginTransfer(record);
  const current = s.store.updateTransfer(record, { step: "snapshot" }, s.now());
  assert.throws(() => s.store.updateTransfer(record, { step: "archive" }), /Stale/u);
  const completed = s.store.updateTransfer(current, { phase: "complete" }, s.now());
  s.store.beginTransfer({ ...record, id: "later-operation" });
  assert.throws(() => s.store.updateTransfer(completed, { phase: "switched" }), /Stale/u);
  assert.equal(s.store.getValue<{ phase: string }>(`transfer-operation:${record.id}`)?.phase, "complete");
});

test("transfer revision reads reserve the writer before another connection can commit", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-writer-"));
  const file = path.join(directory, "state.sqlite");
  const store = new BridgeStore(file); t.after(() => store.close());
  const other = new DatabaseConstructor(file); t.after(() => other.close());
  other.pragma("busy_timeout = 0");
  const binding = store.ensureBinding(task);
  store.beginTransfer({ id: "writer-op", bindingId: binding.id, source: task, startedAt: 1,
    targetSourceId: "work", targetProjectId: null, phase: "forking", version: 2 });
  const key = `transfer:${binding.id}`;
  store.atomic(() => {
    const current = store.transfer(binding.id)!;
    assert.throws(() => other.prepare("UPDATE bridge_values SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...current, revision: 999 }), key), { code: "SQLITE_BUSY" });
    store.updateTransfer(current, { step: "snapshot" });
  });
  const saved = JSON.parse((other.prepare("SELECT value FROM bridge_values WHERE key = ?").get(key) as { value: string }).value);
  assert.equal(saved.step, "snapshot");
  assert.equal(saved.revision, 1);
});

test("transfer checkpoints and leases survive reopening SQLite; only a dead owner can be replaced", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-journal-"));
  const file = path.join(directory, "state.sqlite");
  const first = new BridgeStore(file);
  const binding = first.ensureBinding(task);
  const record = { id: "persisted-op", bindingId: binding.id, source: task, startedAt: 1,
    targetSourceId: "work", targetProjectId: null, phase: "forking" as const, version: 2 as const,
    checkpoint: { lastTurnId: "persisted-boundary", rolloutPath: "/source.jsonl", size: 100, mtimeMs: 2 }, forkSubmitted: true };
  first.beginTransfer(record);
  first.claimTransfer(record, "old-owner", 123, () => true);
  first.close();
  const reopened = new BridgeStore(file); t.after(() => reopened.close());
  const restored = reopened.transfer(binding.id)!;
  assert.equal(restored.checkpoint?.lastTurnId, "persisted-boundary");
  assert.equal(restored.forkSubmitted, true);
  assert.equal(reopened.claimTransfer(restored, "new-owner", 124, () => true), null);
  const claimed = reopened.claimTransfer(restored, "new-owner", 124, () => false)!;
  assert.equal(claimed.lease?.owner, "new-owner");
  assert.equal(claimed.forkSubmitted, true);
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
  assert.equal(s.desktop.opened.length, 1, "reopening the VK binding must not focus Codex again");
});

test("ordinary task messages never open Codex, while /open is an explicit foreground action", async t => {
  const s = setup(t); const binding = s.attach();
  s.store.markDesktopHandoff(binding.id, binding, "live");
  await s.handle("continue in background", peerId);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.opened.length, 0);
  await s.handle("/open", peerId);
  assert.equal(s.desktop.opened.length, 1);
  assert.equal(s.desktop.submissions.length, 1);
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

test("a solo task chat omits attribution until a second author writes", async t => {
  const s = setup(t); s.attach();
  await s.manager.handle({ ...s.input("owner only", peerId), senderName: "Owner User" });
  assert.equal(s.desktop.submissions[0]!.author, undefined);
  assert.match(desktopTaskInput(s.desktop.submissions[0]!).text, /^owner only\n\n# VKodex response format/u);

  await s.manager.handle({ ...s.input("shared request", peerId), senderId: 999, senderName: "Second User" });
  assert.deepEqual(s.desktop.submissions[1]!.author, { id: 999, name: "Second User" });

  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  await restarted.handle({ ...s.input("owner after restart", peerId), senderName: "Owner User" });
  assert.deepEqual(s.desktop.submissions[2]!.author, { id: access.ownerId, name: "Owner User" });
});

test("linked non-owner messages are attributed prompts while the manager stays private", async t => {
  const s = setup(t); s.attach();
  await s.manager.handle({ ...s.input("/list"), senderId: 999 });
  await s.manager.handle({ ...s.input("do shared work", peerId), senderId: 999, senderName: "Second User" });
  await s.manager.handle({ ...s.input("do not route", peerId + 1), senderId: 999 });
  await s.worker.flush();
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]!.text, "do shared work");
  assert.deepEqual(s.desktop.submissions[0]!.author, { id: 999, name: "Second User" });
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

test("slow accepted Codex submission gets a progress notice, not a false unknown-result error", async t => {
  const s = setup(t); const binding = s.attach();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const submitted = new Promise<void>(resolve => { started = resolve; });
  s.desktop.submitHook = () => { started(); return blocked; };
  const manager = new TaskManager(access, s.desktop, s.chat, s.store, s.gate,
    undefined, undefined, undefined, undefined, undefined, 20);
  const input = s.input("Slow but successful", peerId);
  const pending = manager.handle(input);
  await submitted;
  const operation = s.store.unresolvedPromptOperations(binding.id)[0];
  assert.ok(operation);
  await new Promise(resolve => setTimeout(resolve, 50));
  await s.worker.flush();
  assert.match(s.chat.sent.at(-1)!.view.text, /Запрос всё ещё обрабатывается/u);
  assert.doesNotMatch(s.chat.sent.at(-1)!.view.text, /Результат этой операции неизвестен/u);
  release(); await pending;
  assert.equal(s.store.operationState(operation.id), "accepted");
  assert.equal(s.desktop.submissions.length, 1);
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

test("VK reconciliation recovers an unseen message once using the shared inbox gate", async t => {
  const s = setup(t); s.attach(); s.store.observePeerMessage(peerId, 100);
  const vk = new VK({ token: "fixture-token" });
  t.mock.method(vk.updates, "startPolling", async () => {});
  t.mock.method(vk.updates, "stop", async () => {});
  t.mock.method(vk.api, "callWithRequest", async () => ({ count: 1, items: [{ id: 0, conversation_message_id: 101, peer_id: peerId, from_id: access.ownerId, date: 100, out: 0, text: "Recovered prompt", attachments: [] }] }) as never);
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk, undefined, undefined, async () => "Owner");
  const inputs: BridgeInput[] = [];
  await gateway.start(async input => { inputs.push(input); await s.manager.handle(input); });
  gateway.startReconciliation(s.store);
  for (let i = 0; i < 100 && !s.store.hasInput(JSON.stringify([peerId, "message:101"])); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await gateway.stop();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.text, "Recovered prompt");
  assert.equal(s.store.getValue(`vk-inbound-cursor:${peerId}`), 101);
  gateway.startReconciliation(s.store);
  await new Promise(resolve => setTimeout(resolve, 20));
  await gateway.stop();
  assert.equal(inputs.length, 1);
});

test("VK service events do not detach a task and message edits keep their original conversation id", async t => {
  const s = setup(t); const binding = s.attach(); const inputs: BridgeInput[] = [];
  const vk = new VK({ token: "fixture-token" }); t.mock.method(vk.updates, "startPolling", async () => {});
  const config = loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" });
  const gateway = new DesktopVkGateway(config, vk, undefined, undefined, async id => id === 999 ? "Second User" : "Owner User");
  await gateway.start(async input => { inputs.push(input); await s.manager.handle(input); });
  const update = (id: number, senderId: number, action?: { type: string; member_id?: number }, out = 0, type: "message_new" | "message_edit" = "message_new", text = "Fixture text") => ({
    type, group_id: access.groupId, event_id: `fixture-${type}-${id}`, v: "5.199",
    object: { message: { id: 0, conversation_message_id: id, peer_id: peerId, from_id: senderId,
      date: 100, update_time: type === "message_edit" ? 101 : undefined, out, text, attachments: [], ...(action ? { action } : {}) }, client_info: {} },
  });
  await vk.updates.handleWebhookUpdate(update(1, access.ownerId, { type: "chat_kick_user", member_id: access.ownerId }, 1));
  assert.equal(s.store.getBinding(binding.id)!.attached, true);
  await vk.updates.handleWebhookUpdate(update(2, 999));
  await vk.updates.handleWebhookUpdate(update(3, -access.groupId));
  await vk.updates.handleWebhookUpdate(update(4, access.ownerId, undefined, 1));
  await vk.updates.handleWebhookUpdate(update(2, 999, undefined, 0, "message_edit", "Corrected text"));
  assert.equal(inputs.length, 2); assert.equal(inputs[0]!.senderId, 999);
  assert.equal(inputs[0]!.senderName, "Second User"); assert.equal(inputs[1]!.senderName, "Second User");
  assert.equal(inputs[1]!.editOfMessageId, 2); assert.match(inputs[1]!.eventId, /^message-edit:2:/u);
  assert.equal(s.desktop.submissions.length, 1); assert.equal(s.desktop.submissions[0]!.text, "Fixture text");
  assert.deepEqual(s.desktop.submissions[0]!.author, { id: 999, name: "Second User" });
  assert.equal(s.desktop.messageEdits.length, 1); assert.equal(s.desktop.messageEdits[0]!.text, "Corrected text");
  assert.deepEqual(s.desktop.messageEdits[0]!.author, { id: 999, name: "Second User" });
  assert.equal(s.chat.memberReads, 0); assert.equal(s.store.getBinding(binding.id)!.paused, false);
});

test("VK native chat title updates reach the linked task as metadata instead of a prompt", async t => {
  const s = setup(t); const binding = s.attach(); const inputs: BridgeInput[] = [];
  const vk = new VK({ token: "fixture-token" }); t.mock.method(vk.updates, "startPolling", async () => {});
  t.mock.method(vk.updates, "stop", async () => {});
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk);
  await gateway.start(async input => { inputs.push(input); await s.manager.handle(input); });
  await vk.updates.handleWebhookUpdate({ type: "message_new", group_id: access.groupId, event_id: "title-fixture", v: "5.199", object: {
    message: { id: 0, conversation_message_id: 55, peer_id: peerId, from_id: access.ownerId, date: 100, out: 0, text: "", attachments: [], action: { type: "chat_title_update", text: "[VKodex] Renamed from VK" } }, client_info: {},
  } });
  await gateway.stop();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.conversationTitle, "[VKodex] Renamed from VK");
  assert.equal(s.desktop.renames.length, 1);
  assert.equal(s.desktop.renames[0]!.title, "Renamed from VK");
  assert.equal(s.desktop.submissions.length, 0);
  assert.equal(s.store.getBinding(binding.id)!.title, "Renamed from VK");
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
  assert.deepEqual(s.chat.sent.map(item => item.view), [{ text: "## user request\n\nFrom desktop", silent: true }]);
});

test("every long user-message fragment is labeled and restart does not resend it", async t => {
  const s = setup(t); const binding = s.attach(); const mirror = new TaskMirror(s.store, 40);
  const prefix = "## user request\n\n";
  const event = { type: "user", id: "long-user", turnId: "turn", text: "д".repeat(100) } as const;
  mirror.accept(binding.id, event); mirror.accept(binding.id, event);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 5);
  assert.ok(s.chat.sent.every(item => item.view.silent === true));
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
  assert.equal(s.chat.sent[0]!.view.silent, true); assertThinking(s.chat.sent[0]!.view.text, "думаю...");
  const firstUpdatedAt = s.chat.sent[0]!.view.text.split("обновлено ")[1];
  for (const text of ["думаю..", "думаю.", "думаю..."] as const) {
    activity.observe(binding.id, "running", "turn");
    activity.tick(); await s.worker.flush();
    s.advance(); activity.tick(); await s.worker.flush();
    assertThinking(s.chat.edits.at(-1)!.view.text, text);
    assert.deepEqual(s.chat.edits.at(-1)!.handle, s.chat.sent[0]!.handle);
  }
  assert.notEqual(s.chat.edits[0]!.view.text.split("обновлено ")[1], firstUpdatedAt);
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
  assertThinking(s.chat.edits[0]!.view.text, "думаю..");
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

test("upgrade removes a legacy embedded indicator and creates a standalone one", async t => {
  const s = setup(t); const binding = s.attach();
  const key = `commentary:${binding.id}:turn:legacy:0`;
  const base = { text: "Legacy progress", silent: true };
  s.store.setValue(`commentary-base:${key}`, base);
  s.store.enqueue(key, peerId, { ...base, text: `${base.text}\n\nдумаю...` }, binding.id, true);
  s.store.setValue(`activity:${binding.id}`, { key, generation: s.store.streamGeneration(binding.id), turnId: "turn", status: "running", kind: "commentary" });
  await s.worker.flush(); s.store.recover();
  const activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "Legacy progress");
  assertThinking(s.chat.sent.at(-1)!.view.text, "думаю...");
  assert.notEqual(s.chat.sent.at(-1)!.handle.conversationMessageId, s.chat.sent[0]!.handle.conversationMessageId);
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
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk, undefined, undefined, async () => "Owner User");
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

test("thinking stays separate and follows the newest commentary", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  const initialIndicator = s.chat.sent.at(-1)!.handle;
  const first = { type: "progress", id: "first", turnId: "turn", text: "First comment" } as const;
  s.mirror.accept(binding.id, first); activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.at(-2)!.view.text, "First comment");
  assertThinking(s.chat.sent.at(-1)!.view.text, "думаю...");
  assert.deepEqual(s.chat.deletes, [initialIndicator]);
  const firstHandle = s.chat.sent.at(-2)!.handle;
  const firstIndicatorHandle = s.chat.sent.at(-1)!.handle;
  s.advance(); activity.tick(); await s.worker.flush();
  assertThinking(s.chat.edits.at(-1)!.view.text, "думаю..");
  s.mirror.accept(binding.id, { ...first, text: "First comment expanded" });
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.ok(s.chat.edits.some(item => item.handle.conversationMessageId === firstHandle.conversationMessageId && item.view.text === "First comment expanded"));
  assertThinking(s.chat.edits.filter(item => item.handle.conversationMessageId === firstIndicatorHandle.conversationMessageId).at(-1)!.view.text, "думаю..");
  s.mirror.accept(binding.id, { ...first, id: "second", text: "Second comment" });
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.at(-2)!.view.text, "Second comment"); assertThinking(s.chat.sent.at(-1)!.view.text, "думаю...");
  assert.equal(s.chat.edits.filter(item => item.handle.conversationMessageId === firstHandle.conversationMessageId).at(-1)!.view.text, "First comment expanded");
  s.mirror.accept(binding.id, { ...first, text: "Older comment corrected" });
  activity.observe(binding.id, "running", "turn"); s.advance(); activity.tick(); await s.worker.flush();
  assertThinking(s.chat.edits.at(-1)!.view.text, "думаю..");
  activity.observe(binding.id, "idle"); s.advance(); await s.worker.flush();
  assert.equal(s.chat.edits.at(-1)!.view.text, "Готово.");
  assert.ok(s.chat.sent.filter(item => item.view.text === "Second comment").length === 1);
  assert.ok(s.chat.sent.every(item => !item.view.text.includes("Работа продолжается")));
  assert.ok(s.chat.edits.every(item => !item.view.text.includes("Работа продолжается")));
});

test("old thinking deletion retries safely without duplicating an ambiguous indicator send", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now, 6_000);
  s.chat.lostSendResponse = true;
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  const oldIndicator = s.chat.sent[0]!.handle;
  s.mirror.accept(binding.id, { type: "progress", id: "comment", turnId: "turn", text: "Progress" });
  activity.observe(binding.id, "running", "turn"); s.chat.failDeletes = true; s.advance(); await s.worker.flush();
  assert.equal(s.chat.sent.filter(item => item.handle.conversationMessageId === oldIndicator.conversationMessageId).length, 1);
  assert.equal(s.store.pendingDeliveries().filter(item => item.kind === "delete").length, 1);
  s.chat.failDeletes = false; s.advance(); await s.worker.flush();
  assert.deepEqual(s.chat.deletes, [oldIndicator]);
  assert.equal(s.store.pendingDeliveries().filter(item => item.kind === "delete").length, 0);
});

test("unsupported indicator deletion is abandoned without blocking the delivery queue", async t => {
  const s = setup(t); const binding = s.attach(); const activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  s.mirror.accept(binding.id, { type: "progress", id: "comment", turnId: "turn", text: "Progress" });
  activity.observe(binding.id, "running", "turn"); s.chat.failDeletes = true;
  for (let attempt = 0; attempt < 3; attempt++) { s.advance(70_000); await s.worker.flush(); }
  assert.equal(s.store.pendingDeliveries().filter(item => item.kind === "delete").length, 0);
  s.store.enqueue("after-delete", peerId, { text: "Still delivering" }, binding.id);
  await s.worker.flush(); assert.equal(s.chat.sent.at(-1)!.view.text, "Still delivering");
});

test("user messages and menus move thinking to the bottom while restart reuses its latest handle", async t => {
  const s = setup(t); const binding = s.attach(); let activity = new TaskActivity(s.store, s.now, 6_000);
  s.mirror.accept(binding.id, { type: "progress", id: "comment", turnId: "turn", text: "Working" });
  activity.observe(binding.id, "running", "turn"); await s.worker.flush();
  const incomingId = ++s.chat.messageSequence;
  await s.manager.handle({ ...s.input("Follow up", peerId), eventId: `message:${incomingId}` });
  activity.tick(); s.advance(); await s.worker.flush();
  assertThinking(s.chat.sent.at(-1)!.view.text, "думаю...");
  assert.ok(s.chat.sent.at(-1)!.handle.conversationMessageId > incomingId);
  await s.handle("/menu", peerId);
  const menuId = s.chat.sent.at(-1)!.handle.conversationMessageId;
  activity.tick(); s.advance(); await s.worker.flush();
  assertThinking(s.chat.sent.at(-1)!.view.text, "думаю...");
  assert.ok(s.chat.sent.at(-1)!.handle.conversationMessageId > menuId);
  s.mirror.accept(binding.id, { type: "progress", id: "new-comment", turnId: "turn", text: "New progress" });
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  const count = s.chat.sent.length, latest = s.chat.sent.at(-1)!.handle;
  s.store.recover(); activity = new TaskActivity(s.store, s.now, 6_000);
  activity.observe(binding.id, "running", "turn"); s.advance(); await s.worker.flush();
  s.advance(); activity.tick(); await s.worker.flush();
  assert.equal(s.chat.sent.length, count); assert.deepEqual(s.chat.edits.at(-1)!.handle, latest);
  assertThinking(s.chat.edits.at(-1)!.view.text, "думаю..");
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
  const recovered = projectSnapshot(completed, JSON.parse(JSON.stringify(initial.checkpoint)), 300, { rebaseline: true });
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

test("a reconnect does not replay an unseen completed turn from desktop history", async t => {
  const s = setup(t); const binding = s.attach();
  const checkpoint = { since: 100, activeAtAttach: [], seen: {} };
  const snapshot = { turns: [{ turnId: "missed", turnStartedAtMs: 101, status: "completed", items: [{ type: "agentMessage", id: "missed-final", phase: "final_answer", text: "Missed final" }] }] };
  const recovered = projectSnapshot(snapshot, checkpoint, 200, { rebaseline: true });
  for (const event of recovered.events) s.mirror.accept(binding.id, event);
  s.store.recover(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);
  assert.equal(projectSnapshot(snapshot, recovered.checkpoint).events.length, 0);
});

test("a final retires unsent commentary from the same turn before delivery", async t => {
  const s = setup(t); const binding = s.attach();
  for (let index = 0; index < 100; index++) s.mirror.accept(binding.id, { type: "progress", id: `old-${index}`, turnId: "turn", text: `Old ${index}` });
  s.mirror.accept(binding.id, { type: "final", id: "answer", turnId: "turn", text: "Current answer" });
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 1);
  assert.equal(s.chat.sent[0]!.view.text, "Current answer\n\nМеню задачи:");
  assert.equal(s.store.pendingDeliveries().filter(delivery => delivery.kind === "commentary").length, 0);
  s.mirror.accept(binding.id, { type: "progress", id: "recovered-old", turnId: "turn", text: "Recovered old progress" });
  s.mirror.accept(binding.id, { type: "final", id: "answer", turnId: "turn", text: "Current answer" });
  assert.equal(s.store.pendingDeliveries().filter(delivery => delivery.kind === "commentary").length, 0);
});

test("delivery flushes are bounded so a large stream backlog cannot hold the runtime loop", async t => {
  const s = setup(t); const binding = s.attach();
  for (let index = 0; index < 20; index++) s.store.enqueue(`backlog:${index}`, peerId, { text: `Progress ${index}`, silent: true }, binding.id, true);
  const bounded = new DeliveryWorker(s.chat, s.store, s.gate, 0, s.now, 3);
  await bounded.flush();
  assert.equal(s.chat.sent.length, 3);
  assert.equal(s.store.pendingDeliveries().length, 17);
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

test("VK deletes a retired indicator for everyone using its conversation message id", async t => {
  const vk = new VK({ token: "fixture-token" });
  let params: unknown;
  t.mock.method(vk.api, "callWithRequest", async ({ method, params: value }: { method: string; params: unknown }) => {
    assert.equal(method, "messages.delete"); params = value; return [];
  });
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk, 0);
  await gateway.delete({ peerId, conversationMessageId: 42 });
  assert.deepEqual(params, { peer_id: peerId, cmids: 42, delete_for_all: 1, group_id: access.groupId });
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

test("new-task wizard selects a Codex catalog and creates a projectless chat in an explicit folder", async t => {
  const s = setup(t); const workspace = path.resolve("fixture-projectless-workspace");
  s.desktop.sources = [{ id: "", label: ".codex" }, { id: "extra-source", label: ".codex-work" }];
  s.desktop.sourceProjects = { "": s.desktop.projects, "extra-source": [] };
  await s.handle("/new");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === ".codex-work")!.action);
  assert.match(s.chat.sent.at(-1)!.view.text, /нет проектов/u);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Без проекта")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Выбрать папку")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Ввести путь")!.action);
  await s.handle(workspace);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Локально")!.action);
  await s.handle("Loose task"); await s.handle("Initial prompt");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Model A")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "medium")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Создать")!.action);
  assert.deepEqual(s.desktop.creations, [{
    operationId: s.desktop.creations[0]!.operationId, projectId: null, sourceId: "extra-source", workspace,
    title: "Loose task", prompt: "Initial prompt", model: "model-a", effort: "medium", environment: "local",
  }]);
  assert.equal(s.desktop.modelSources.at(-1)!.sourceId, "extra-source");
  assert.equal(s.desktop.tasks.at(-1)!.projectId, null);
  assert.equal(s.desktop.tasks.at(-1)!.sourceId, "extra-source");
});

test("projectless task creation from a phone uses an automatic isolated workspace", async t => {
  const s = setup(t);
  await s.handle("/new");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === ".codex")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Без проекта")!.action);
  assert.match(s.chat.sent.at(-1)!.view.text, /создаст новую пустую папку/u);
  assert.doesNotMatch(s.chat.sent.at(-1)!.view.text, /Отправь абсолютный путь/u);
  await s.handle("Phone task"); await s.handle("Initial prompt");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Model A")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "medium")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Создать")!.action);
  const request = s.desktop.creations[0]!;
  assert.equal(request.projectId, null); assert.equal(request.environment, "local"); assert.equal(request.automaticWorkspace, true);
  assert.equal(path.dirname(request.workspace!), path.join(os.tmpdir(), "VKodex", "workspaces"));
  assert.match(path.basename(request.workspace!), /^Phone task-[0-9a-f]{8}$/u);
});

test("projectless task creation offers known workspaces as phone buttons", async t => {
  const s = setup(t);
  await s.handle("/new");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === ".codex")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Без проекта")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Выбрать папку")!.action);
  assert.match(s.chat.sent.at(-1)!.view.text, /Выбери рабочую папку/u);
  assert.ok(s.chat.sent.at(-1)!.view.buttons!.some(button => button.label === "Project"));
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Project")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Локально")!.action);
  await s.handle("Folder task"); await s.handle("Initial prompt");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Model A")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "medium")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Создать")!.action);
  const request = s.desktop.creations[0]!;
  assert.equal(request.projectId, null); assert.equal(request.workspace, path.normalize("/project"));
  assert.equal(request.automaticWorkspace, undefined);
});

test("a legacy other-folder button opens the new phone workspace picker", async t => {
  const s = setup(t);
  await s.handle("/new");
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === ".codex")!.action);
  await s.handle("", access.ownerId, s.chat.sent.at(-1)!.view.buttons!.find(button => button.label === "Без проекта")!.action);
  const legacyAction = s.store.action({ type: "newWorkspaceManual" }, Date.now(), access.ownerId);
  await s.handle("", access.ownerId, legacyAction);
  assert.match(s.chat.sent.at(-1)!.view.text, /Выбери рабочую папку/u);
  assert.ok(s.chat.sent.at(-1)!.view.buttons!.some(button => button.label === "Ввести путь"));
});

test("an old projectless path prompt upgrades to the mobile title flow", async t => {
  const s = setup(t);
  s.store.saveDraft({ id: "12345678-legacy", stage: "workspace", sourceLabel: ".codex", projectId: null, projectTitle: "Без проекта" });
  await s.handle("Recovered phone task");
  const draft = s.store.getDraft()!;
  assert.equal(draft.stage, "prompt"); assert.equal(draft.title, "Recovered phone task"); assert.equal(draft.environment, "local");
  assert.equal(draft.automaticWorkspace, true); assert.match(path.basename(draft.workspace!), /^Recovered phone task-12345678$/u);
  assert.match(s.chat.sent.at(-1)!.view.text, /стартовый промпт/u);
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
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk, undefined, undefined, async () => "Owner User");
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
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk, undefined, undefined, async () => "Owner User");
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
  files.observe(binding.id, "idle", "submitted-turn"); await files.tick(); await s.worker.flush();
  assert.equal(s.chat.binaryUploads.length, 1); assert.equal(s.chat.binaryUploads[0]!.contents.toString(), "result bytes");
  assert.deepEqual(s.chat.sent[0]!.view.attachments, ["doc-202_1"]); assert.equal(s.chat.sent[0]!.peerId, peerId);
  await files.collect(binding, true); s.store.recover(); const restored = new TaskFiles(root, s.store, s.chat, s.gate);
  await restored.collect(binding, true); await s.worker.flush(); assert.equal(s.chat.binaryUploads.length, 1); assert.equal(s.chat.sent.length, 1);
  await writeFile(path.join(request.outboxDir!, "manual.txt"), "later output");
  await manager.handle(s.input("/files", peerId));
  // /files acknowledges immediately; wait for its durable background
  // collection before asserting the upload.
  await files.collect(binding, true); await s.worker.flush();
  assert.equal(s.chat.binaryUploads.length, 2); assert.ok(s.chat.sent.some(message => /Файлы поставлены в очередь VK: 1/u.test(message.view.text)));
  assert.equal(s.desktop.submissions.length, 1);
});

test("large VK documents stream to disk and incomplete oversized downloads are removed", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-stream-test-"));
  const target = path.join(root, "streamed.bin");
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  })));
  assert.equal(await downloadVkFileToPath("https://sun1.userapi.com/file", target, 5), 5);
  assert.deepEqual(await readFile(target), Buffer.from([1, 2, 3, 4, 5]));

  const oversized = path.join(root, "oversized.bin");
  await assert.rejects(downloadVkFileToPath("https://sun1.userapi.com/file", oversized, 4), /лимит размера/u);
  await assert.rejects(readFile(oversized), /ENOENT/u);
});

test("VK document viewer pages resolve their temporary CDN file instead of becoming corrupt attachments", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-stream-test-"));
  const target = path.join(root, "video.mp4"); let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    requests++;
    if (String(input).startsWith("https://vk.ru/doc")) return new Response(
      '<script>Docs.initDoc({"docOwnerId":1,"docId":2,"docSize":5,"docUrl":"https:\\/\\/psv4.vkuserphoto.ru\\/video"})</script>',
      { headers: { "content-type": "text/html; charset=windows-1251" } });
    return new Response(new Uint8Array([0, 0, 0, 1, 2]), { headers: { "content-type": "video/mp4" } });
  });
  assert.equal(await downloadVkFileToPath("https://vk.ru/doc1_2?hash=fixture", target, 10, 1_000, 5), 5);
  assert.equal(requests, 2);
  assert.deepEqual(await readFile(target), Buffer.from([0, 0, 0, 1, 2]));
});

test("expired VK document pages and size mismatches never reach Codex as named files", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-stream-test-"));
  const expired = path.join(root, "expired.mp4");
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(
    '<script>Docs.initDoc({"docSize":160000000,"docUrl":"\\/err404.php"})</script>',
    { headers: { "content-type": "text/html" } }));
  await assert.rejects(downloadVkFileToPath("https://vk.ru/doc1_2", expired, 200 * 1024 * 1024), /уже недоступна/u);
  await assert.rejects(readFile(expired), /ENOENT/u);
  mock.mock.restore();

  const truncated = path.join(root, "truncated.mp4");
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }));
  await assert.rejects(downloadVkFileToPath("https://psv4.vkuserphoto.ru/video", truncated, 10, 1_000, 5), /неполное или неверное/u);
  await assert.rejects(readFile(truncated), /ENOENT/u);
});

test("a failed streamed download never removes a pre-existing inbox file", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-stream-test-"));
  const target = path.join(root, "existing.bin");
  await writeFile(target, "keep me");
  t.mock.method(globalThis, "fetch", async () => new Response("replacement"));
  await assert.rejects(downloadVkFileToPath("https://sun1.userapi.com/file", target, 100), /Не удалось скачать/u);
  assert.equal(await readFile(target, "utf8"), "keep me");
});

test("a stale idle snapshot cannot collect a new turn's outbox before that exact turn finishes", async t => {
  const s = setup(t); const binding = s.attach(); const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const prepared = await files.prepare(binding, "operation", []);
  files.finish(binding.id, "operation", "accepted", "accepted-turn");
  await writeFile(path.join(prepared.outboxDir, "result.txt"), "result");

  files.observe(binding.id, "idle"); await files.tick(); await s.worker.flush();
  assert.equal(s.chat.binaryUploads.length, 0);

  files.observe(binding.id, "idle", "accepted-turn"); await files.tick(); await s.worker.flush();
  assert.equal(s.chat.binaryUploads.length, 1);
  assert.equal(s.chat.binaryUploads[0]!.contents.toString(), "result");
});

test("an outbox with more than ten files is delivered in batches without blocking newer turns", async t => {
  const s = setup(t); const binding = s.attach(); const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const invalid = await files.prepare(binding, "invalid-output", []); files.finish(binding.id, "invalid-output", "accepted");
  for (let index = 0; index <= 10; index++) await writeFile(path.join(invalid.outboxDir, `${index}.txt`), "fixture");
  const valid = await files.prepare(binding, "valid-output", []); files.finish(binding.id, "valid-output", "accepted");
  await writeFile(path.join(valid.outboxDir, "result.txt"), "new result");

  files.observe(binding.id, "idle"); await files.tick(); await s.worker.flush();

  assert.equal(s.chat.binaryUploads.length, 12);
  assert.ok(s.chat.binaryUploads.some(item => item.contents.toString() === "new result"));
  assert.equal(s.chat.sent.some(item => /не больше 10 файлов/u.test(item.view.text)), false);
  assert.ok(s.chat.sent.some(item => item.view.attachments?.length === 10));
  assert.ok(s.chat.sent.some(item => item.view.attachments?.length === 1));
  const jobs = s.store.getValue<{ operationId: string; done: boolean }[]>(`file-jobs:${binding.id}`)!;
  assert.deepEqual(jobs.map(job => [job.operationId, job.done]), [["invalid-output", true], ["valid-output", true]]);

  await files.tick(); await s.worker.flush();
  assert.equal(s.chat.binaryUploads.length, 12);
});

test("late owner input is delivered before already observed commentary", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.acceptObservation(binding.id, [
    { type: "progress", id: "first", turnId: "late-turn", text: "Checking" },
    { type: "progress", id: "second", turnId: "late-turn", text: "Still checking" },
  ], []);
  await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);

  // Reconstructing the mirror must not drop the held assistant messages.
  const afterRestart = new TaskMirror(s.store);
  afterRestart.acceptObservation(binding.id, [
    { type: "user", id: "prompt", turnId: "late-turn", text: "Direct prompt" },
  ], ["late-turn"]);
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), [
    "## user request\n\nDirect prompt", "Checking", "Still checking",
  ]);
});

test("goal continuation publishes commentary without waiting for a user message", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.acceptObservation(binding.id, [
    { type: "progress", id: "goal-progress", turnId: "goal-turn", text: "Autonomous progress" },
  ], [], ["goal-turn"]);
  s.advance(3_000); s.mirror.tick();
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), ["Autonomous progress"]);
});

test("commentary deadline survives restart and repeated deltas never postpone it", async t => {
  const s = setup(t); const binding = s.attach();
  const progress = { type: "progress" as const, id: "agent-reply", turnId: "unrecognized-origin", text: "First fragment" };
  s.mirror.acceptObservation(binding.id, [progress], []);
  s.advance(1_500);
  s.mirror.acceptObservation(binding.id, [{ ...progress, text: "Complete fragment" }], []);
  const restarted = new TaskMirror(s.store, 3_500, s.now);
  s.advance(501); restarted.tick(); await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), ["Complete fragment"]);
  restarted.acceptObservation(binding.id, [{ ...progress, id: "next", text: "Next progress" }], []);
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), ["Complete fragment", "Next progress"]);
  restarted.tick(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 2);
  assert.equal(s.store.deferredMirrors().length, 0);
});

test("terminal turns and replaced bindings cannot replay a deferred commentary buffer", async t => {
  for (const change of ["completed", "interrupted", "detach", "rollout"] as const) {
    const s = setup(t); const binding = s.attach();
    const progress = { type: "progress" as const, id: "held", turnId: "turn", text: "Obsolete progress" };
    s.mirror.acceptObservation(binding.id, [progress], []);
    if (change === "detach") { s.store.stopStreaming(binding.id); s.store.setAttached(binding.id, true); }
    else if (change === "rollout") s.store.ensureBinding({ ...task, rolloutPath: "C:/new-branch.jsonl" });
    else {
      s.mirror.acceptObservation(binding.id, [{ type: "status", id: "terminal", turnId: "turn", status: change }], []);
      s.mirror.acceptObservation(binding.id, [progress], []);
    }
    s.advance(3_000); s.mirror.tick(); await s.worker.flush();
    assert.equal(s.chat.sent.length, 0, change);
    assert.equal(s.store.deferredMirrors().length, 0, change);
  }
});

test("legacy deferred progress is adopted only after a fresh active-turn observation", async t => {
  const s = setup(t); const binding = s.attach();
  s.store.setValue(`deferred-mirror:${binding.id}:turn`, [{ type: "progress", id: "legacy", turnId: "turn", text: "Still working" }]);
  s.advance(10_000); s.mirror.tick(); await s.worker.flush();
  assert.equal(s.chat.sent.length, 0);
  s.mirror.acceptObservation(binding.id, [], [], ["turn"]);
  s.advance(2_001); s.mirror.tick(); await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), ["Still working"]);
});

test("baseline or VK accepted input releases held commentary without echoing a prompt", async t => {
  const s = setup(t); const binding = s.attach();
  s.mirror.acceptObservation(binding.id, [
    { type: "progress", id: "comment", turnId: "known-turn", text: "Working" },
  ], []);
  s.mirror.acceptObservation(binding.id, [], ["known-turn"]);
  await s.worker.flush();
  assert.deepEqual(s.chat.sent.map(item => item.view.text), ["Working"]);
});

test("attachment transfer stops on explicit detach during download or upload and never replays old jobs", async t => {
  const s = setup(t); const binding = s.attach(); const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const download = t.mock.method(globalThis, "fetch", async () => { s.store.stopStreaming(binding.id); return new Response("file"); });
  await assert.rejects(files.prepare(binding, "download", [{ key: "a", kind: "file", fileName: "a.txt", url: "https://sun1.userapi.com/file" }]), /остановлена/u);
  assert.equal(s.desktop.submissions.length, 0);
  download.mock.restore(); s.store.setAttached(binding.id, true);
  const prepared = await files.prepare(binding, "upload", []); files.finish(binding.id, "upload", "accepted");
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
  const defaults = loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101" });
  assert.equal(defaults.access.ownerId, 101);
  assert.deepEqual(defaults.inboundFileLimits, {
    maxFiles: 10,
    maxFileBytes: 200 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
    timeoutMs: 600_000,
  });
  assert.deepEqual(loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", MAX_INBOUND_FILES: "2", MAX_INBOUND_FILE_BYTES: "1048576", MAX_INBOUND_TOTAL_BYTES: "2097152", DOWNLOAD_TIMEOUT_MS: "90000" }).inboundFileLimits,
    { maxFiles: 2, maxFileBytes: 1_048_576, maxTotalBytes: 2_097_152, timeoutMs: 90_000 });
  assert.equal(loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", HEALTH_CHECK_INTERVAL_MS: "30000" }).healthIntervalMs, 30_000);
  assert.equal(loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", VKODEX_PROJECTLESS_ROOT: "fixture-workspaces" }).projectlessRoot, path.resolve("fixture-workspaces"));
  assert.throws(() => loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", HEALTH_CHECK_INTERVAL_MS: "29999" }));
  assert.throws(() => loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", MAX_INBOUND_FILE_BYTES: String(200 * 1024 * 1024 + 1) }));
  assert.throws(() => loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", MAX_INBOUND_FILE_BYTES: "2097152", MAX_INBOUND_TOTAL_BYTES: "1048576" }));
  assert.throws(() => loadDesktopBridgeConfig({ ...env, VK_OWNER_ID: "101", VKODEX_PROJECTLESS_ROOT: "private\u0000path" }), error => error instanceof Error && !error.message.includes("private"));
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


test("queue strips only its prefix, preserves command-like prompt, and never steers or duplicates", async t => {
  const s = setup(t); s.attach(); s.desktop.details = { ...s.desktop.details, status: "running" };
  const input = { ...s.input("/queue\n/stop\nDo this later", peerId), senderId: 999 };
  await s.manager.handle(input); await s.manager.handle(input); await s.worker.flush();
  assert.equal(s.desktop.queued.length, 1);
  assert.equal(s.desktop.queued[0]!.text, "/stop\nDo this later");
  assert.deepEqual(s.store.queuedInputs(s.store.byPeer(peerId)!.id).map(item => item.operationId), [s.desktop.queued[0]!.operationId]);
  assert.equal(s.desktop.submissions.length, 0); assert.equal(s.desktop.stops.length, 0);
  await s.handle("/queue", peerId);
  assert.equal(s.desktop.queued.length, 1);
});

test("uncertain native queue insertion never falls back to a turn or retries", async t => {
  const s = setup(t); s.attach(); s.desktop.queueError = new UncertainActionError();
  const input = s.input("/queue later", peerId);
  await s.manager.handle(input); await s.manager.handle(input);
  assert.equal(s.desktop.queued.length, 1); assert.equal(s.desktop.submissions.length, 0);
  assert.deepEqual(s.store.queuedInputs(s.store.byPeer(peerId)!.id), []);
});

test("queued outbox waits for its actual native turn, not the current turn completion", async t => {
  const s = setup(t); const binding = s.attach();
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-queue-files-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const prepared = await files.prepare(binding, "queued-op", []);
  files.markQueued(binding.id, "queued-op"); files.finish(binding.id, "queued-op", "accepted");
  await writeFile(path.join(prepared.outboxDir, "result.txt"), "result");
  files.observe(binding.id, "idle", "previous-turn");
  assert.equal(await files.collect(binding), 0);
  files.associateTurn(binding.id, "queued-op", "queued-turn");
  assert.equal(await files.collect(binding), 0);
  files.observe(binding.id, "idle", "queued-turn");
  assert.equal(await files.collect(binding), 1);
  assert.equal(await files.collect(binding), 0);
});

test("MP4 document uploads declare type, byte length and a large-file timeout", async t => {
  const vk = new VK({ token: "fixture-token" });
  const bytes = Buffer.from("fixture-mp4");
  const upload = t.mock.method(vk.upload, "conduct", async ({ params }: Parameters<typeof vk.upload.conduct>[0]) => {
    assert.deepEqual(params.source, { values: [{ value: bytes, filename: "trailer.MP4", contentLength: bytes.length, contentType: "video/mp4" }], timeout: 600_000 });
    return { type: "doc", doc: { owner_id: -202, id: 17 } };
  });
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk);
  assert.equal(await gateway.uploadFile(peerId, "trailer.MP4", bytes, "file"), "doc-202_17");
  assert.equal(upload.mock.callCount(), 1);
});

test("manager restores a persisted VK burst into one task turn after restart", async t => {
  const s = setup(t); s.attach();
  const parts = ["x".repeat(3500), "y".repeat(3500), "done"].map((text, index) => ({
    ...s.input(text, peerId), eventId: `message:${1200 + index}`,
  }));
  for (const [index, input] of parts.entries()) s.store.receiveInput(input, Date.now() - 20_000 + index);
  s.store.saveInputBatch({ id: "crashed-burst", peerId, parts, startedAt: Date.now() - 20_000,
    updatedAt: Date.now() - 20_000, state: "collecting" });
  s.store.recover();
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  restarted.recoverInputs();
  await restarted.idle();
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]?.text, parts.map(item => item.text).join("\n"));
  assert.deepEqual(s.store.inputBatches(), []);
  for (const part of parts) await restarted.handle(part);
  assert.equal(s.desktop.submissions.length, 1);
});

test("an archived binding explains detach or rebind instead of offering a useless open", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.archives.push(binding);
  s.desktop.submitError = new TaskNotOpenError();
  await s.handle("continue old task", peerId);
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.store.operationState(s.desktop.submissions[0]!.operationId), "rejected");
  assert.match(s.chat.sent.at(-1)!.view.text, /архивной задаче.*\/detach.*менеджере/u);
  s.desktop.opened.length = 0;
  await s.handle("/open", peerId);
  assert.equal(s.desktop.opened.length, 0);
  assert.match(s.chat.sent.at(-1)!.view.text, /архивной задаче.*\/open архив не восстановит.*\/detach/u);
});

test("a missing task owner is a known rejection and persists a health-visible route failure", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.submitError = new TaskNotOpenError();
  const input = { ...s.input("continue task", peerId), eventId: "message:1249" };
  await s.manager.handle(input);
  await s.worker.flush();
  const operation = s.desktop.submissions[0]!;
  assert.equal(s.store.operationState(operation.operationId), "rejected");
  assert.equal(s.store.inputState(JSON.stringify([peerId, input.eventId])), "done");
  const failure = s.store.getValue<{ at: number; kind: string }>(`route-failure:${binding.id}`)!;
  assert.equal(failure.kind, "no-active-owner");
  assert.ok(Number.isSafeInteger(failure.at) && failure.at > 0);
  assert.match(s.chat.sent.at(-1)!.view.text, /нет активного подключения/u);
});

test("an incoming VK event saved before dispatch recovers without duplicate submission", async t => {
  const s = setup(t); s.attach();
  const input = { ...s.input("Recovered prompt", peerId), eventId: "message:1250" };
  assert.equal(s.store.receiveInput(input, 100_000), true);
  assert.equal(s.store.inputState(JSON.stringify([peerId, input.eventId])), "received");
  s.store.recover();
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  restarted.recoverInputs();
  await restarted.handle(input); // Concurrent VK Long Poll replay of the same ID.
  await restarted.idle();
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.desktop.submissions[0]?.text, input.text);
  assert.equal(s.store.inputState(JSON.stringify([peerId, input.eventId])), "done");
  assert.deepEqual(s.store.reserveReplayableInputs(), []);
});

test("a claimed VK operation is never replayed merely because the process restarted", t => {
  const s = setup(t);
  const input = { ...s.input("Possibly handled"), eventId: "message:1260" };
  assert.equal(s.store.receiveInput(input, 100_000), true);
  const key = JSON.stringify([input.peerId, input.eventId]);
  assert.equal(s.store.claimInput(key), true);
  s.store.recover();
  assert.equal(s.store.inputState(key), "uncertain");
  assert.deepEqual(s.store.reserveReplayableInputs(), []);
});

test("VK reconciliation does not advance past an uncommitted prompt and replays it after recovery", async t => {
  const s = setup(t); s.attach(); s.store.observePeerMessage(peerId, 200);
  const vk = new VK({ token: "fixture-token" });
  t.mock.method(vk.updates, "startPolling", async () => {});
  t.mock.method(vk.updates, "stop", async () => {});
  t.mock.method(vk.api, "callWithRequest", async () => ({ count: 1, items: [
    { id: 0, conversation_message_id: 201, peer_id: peerId, from_id: access.ownerId, date: 100, out: 0, text: "Not sent yet", attachments: [] },
  ] }) as never);
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk, undefined, undefined, async () => "Owner");
  const key = JSON.stringify([peerId, "message:201"]);
  let attempts = 0;
  await gateway.start(async () => {
    attempts++;
    assert.equal(s.store.claimInput(key), true);
    if (attempts === 1) s.store.markInputPreparing([key]);
    else s.store.finishInput(key);
  });
  gateway.startReconciliation(s.store);
  for (let i = 0; i < 100 && attempts === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await gateway.stop();
  assert.equal(attempts, 1);
  assert.equal(s.store.getValue(`vk-inbound-cursor:${peerId}`), 200);
  // An older process could have observed the VK ID, or even checkpointed it,
  // before the local preparation was interrupted. Recovery must rewind both.
  s.store.observePeerMessage(peerId, 201);
  s.store.setValue(`vk-inbound-cursor:${peerId}`, 201);
  s.store.recover();
  assert.equal(s.store.inputState(key), "retryable");
  gateway.startReconciliation(s.store);
  for (let i = 0; i < 100 && attempts < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await gateway.stop();
  assert.equal(attempts, 2);
  assert.equal(s.store.getValue(`vk-inbound-cursor:${peerId}`), 201);
});

test("inbox recovery replays only prompts stopped before Codex submission", t => {
  const s = setup(t);
  const prepared = JSON.stringify([peerId, "message:10"]);
  const submitted = JSON.stringify([peerId, "message:11"]);
  const generic = JSON.stringify([peerId, "callback:12"]);
  assert.equal(s.store.claimInput(prepared), true);
  assert.equal(s.store.claimInput(submitted), true);
  assert.equal(s.store.claimInput(generic), true);
  s.store.markInputPreparing([prepared, submitted]);
  s.store.markInputSending([submitted]);
  assert.equal(s.store.inputSettled(prepared), false);
  s.store.recover();
  assert.equal(s.store.inputState(prepared), "retryable");
  assert.equal(s.store.hasInput(prepared), false);
  assert.equal(s.store.claimInput(prepared), true);
  assert.equal(s.store.claimInput(prepared), false);
  assert.equal(s.store.inputState(submitted), "uncertain");
  assert.equal(s.store.claimInput(submitted), false);
  assert.equal(s.store.inputState(generic), "uncertain");
  assert.equal(s.store.claimInput(generic), false);
});

test("legacy inbox schema upgrades without losing deduplication records", () => {
  const db = new DatabaseConstructor(":memory:");
  try {
    db.exec("CREATE TABLE bridge_inbox (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
    db.prepare("INSERT INTO bridge_inbox(id, state) VALUES (?, 'done')").run("legacy-event");
    migrateInboxJournal(db);
    migrateInboxJournal(db);
    const row = db.prepare("SELECT state, payload, received_at, replay_after FROM bridge_inbox WHERE id = ?")
      .get("legacy-event") as { state: string; payload: string | null; received_at: number | null; replay_after: number | null };
    assert.deepEqual(row, { state: "done", payload: null, received_at: null, replay_after: null });
  } finally { db.close(); }
});

test("prompt journal and inbox leave the replayable state in one transaction", t => {
  const s = setup(t); const binding = s.attach();
  const keys = [JSON.stringify([peerId, "message:31"]), JSON.stringify([peerId, "message:32"])];
  for (const key of keys) assert.equal(s.store.claimInput(key), true);
  s.store.markInputPreparing(keys);
  assert.throws(() => s.store.beginPromptDispatch("bad-operation", binding, [...keys, "missing"], binding.id));
  assert.equal(s.store.operationState("bad-operation"), null);
  assert.deepEqual(keys.map(key => s.store.inputState(key)), ["preparing", "preparing"]);
  s.store.beginPromptDispatch("one-operation", binding, keys, binding.id);
  assert.deepEqual(keys.map(key => s.store.inputState(key)), ["sending", "sending"]);
  assert.equal(s.store.operationState("one-operation"), "sending");
  s.store.recover();
  assert.deepEqual(keys.map(key => s.store.inputState(key)), ["uncertain", "uncertain"]);
  assert.equal(s.store.operationState("one-operation"), "uncertain");
});

test("prompt result settles every merged VK fragment in the same durable commit", t => {
  const s = setup(t); const binding = s.attach();
  const keys = [JSON.stringify([peerId, "merged:message:41,message:42"]),
    JSON.stringify([peerId, "message:41"]), JSON.stringify([peerId, "message:42"])];
  for (const key of keys) assert.equal(s.store.claimInput(key), true);
  s.store.markInputPreparing(keys);
  s.store.beginPromptDispatch("merged-operation", binding, keys, binding.id);
  s.store.settlePromptDispatch("merged-operation", "accepted");
  assert.equal(s.store.operationState("merged-operation"), "accepted");
  assert.deepEqual(keys.map(key => s.store.inputState(key)), ["done", "done", "done"]);
  s.store.recover();
  assert.equal(s.store.operationState("merged-operation"), "accepted");
  assert.deepEqual(keys.map(key => s.store.inputState(key)), ["done", "done", "done"]);
});

test("a detached chat settles every merged VK fragment atomically", async t => {
  const s = setup(t); const binding = s.attach(); s.store.setAttached(binding.id, false);
  await s.manager.handle({ ...s.input("part one\npart two", peerId), eventId: "merged:message:20,message:21",
    mergedEventIds: ["message:20", "message:21"] });
  assert.equal(s.store.inputSettled(JSON.stringify([peerId, "message:20"])), true);
  assert.equal(s.store.inputSettled(JSON.stringify([peerId, "message:21"])), true);
  assert.equal(s.desktop.submissions.length, 0);
});

test("a known Codex refusal is rejected in the journal while a lost result stays uncertain", async t => {
  const s = setup(t); s.attach();
  s.desktop.submitError = new ActionRejectedError("Unsupported model");
  await s.handle("First request", peerId);
  const rejectedId = s.desktop.submissions[0]!.operationId;
  assert.equal(s.store.operationState(rejectedId), "rejected");
  assert.match(s.chat.sent.at(-1)!.view.text, /Unsupported model/u);
  s.desktop.submitError = new UncertainActionError();
  await s.handle("Second request", peerId);
  const uncertainId = s.desktop.submissions[1]!.operationId;
  assert.equal(s.store.operationState(uncertainId), "uncertain");
  s.store.recover();
  assert.equal(s.store.operationState(rejectedId), "rejected");
  assert.equal(s.store.operationState(uncertainId), "uncertain");
});

test("a lost Codex acknowledgment is confirmed from native history without resubmitting", async t => {
  const s = setup(t); const binding = s.attach();
  s.desktop.submitError = new UncertainActionError();
  s.desktop.reconciledTurnId = "accepted-turn";
  await s.handle("One prompt", peerId);
  const operationId = s.desktop.submissions[0]!.operationId;
  assert.equal(s.desktop.submissions.length, 1);
  assert.equal(s.store.operationState(operationId), "accepted");
  assert.deepEqual(s.store.acceptedTurns(binding.id), [{ turnId: "accepted-turn", operationId }]);
  assert.match(s.chat.sent.at(-1)!.view.text, /Codex принял запрос/u);
});

test("VK upload errors are checked before docs.save and a later retry can succeed", async t => {
  const vk = new VK({ token: "fixture-token" });
  const calls: string[] = [];
  t.mock.method(vk.api, "callWithRequest", async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === "docs.getMessagesUploadServer") return { upload_url: "https://upload.vk.com/fixture" } as never;
    if (method === "docs.save") return { type: "doc", doc: { owner_id: -202, id: 17, access_key: "fixture" } } as never;
    throw new Error("Unexpected API call");
  });
  const responses: unknown[] = [{ error: "no_free_space/var/www/pi", error_descr: "private server response" }, {}, { error: "wrong_file" }, { file: "fixture-upload-token" }];
  t.mock.method(vk.upload, "upload", async () => responses.shift());
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk);
  const send = () => gateway.uploadFile(peerId, "installer.exe", Buffer.from("fixture"), "file");
  await assert.rejects(send, /На сервере загрузки VK закончилось свободное место/u);
  await assert.rejects(send, /Сервер загрузки VK не подтвердил приём файла/u);
  await assert.rejects(send, FileUploadRejectedError);
  assert.equal(calls.filter(method => method === "docs.save").length, 0);
  assert.equal(await send(), "doc-202_17_fixture");
  assert.equal(calls.filter(method => method === "docs.getMessagesUploadServer").length, 4);
  assert.equal(calls.filter(method => method === "docs.save").length, 1);
});

test("a rejected output does not block other files or retry automatically after restart", async t => {
  const s = setup(t); const binding = s.attach();
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rejected-files-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const prepared = await files.prepare(binding, "rejected-op", []); files.finish(binding.id, "rejected-op", "accepted");
  await writeFile(path.join(prepared.outboxDir, "installer.exe"), "fixture");
  await writeFile(path.join(prepared.outboxDir, "readme.txt"), "readme");
  const upload = t.mock.method(s.chat, "uploadFile", async (_peer: number, name: string) => {
    if (name.endsWith(".exe")) throw new FileUploadRejectedError("VK rejected wrong_file");
    return "doc-202_1";
  });
  files.observe(binding.id, "idle"); assert.equal(await files.collect(binding), 1);
  assert.equal(upload.mock.callCount(), 2);
  const restarted = new TaskFiles(root, s.store, s.chat, s.gate); restarted.observe(binding.id, "idle");
  assert.equal(await restarted.collect(binding), 0); assert.equal(upload.mock.callCount(), 2);
  await s.worker.flush(); assert.ok(s.chat.sent.some(message => message.view.text.includes("wrong_file")));
  assert.equal(await restarted.collect(binding, true), 0); assert.equal(upload.mock.callCount(), 3);
});

test("a full VK document store is cleaned once and the same file is retried", async t => {
  const s = setup(t); const binding = s.attach();
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-document-cleanup-"));
  const files = new TaskFiles(root, s.store, s.chat, s.gate);
  const prepared = await files.prepare(binding, "cleanup-op", []); files.finish(binding.id, "cleanup-op", "accepted");
  await writeFile(path.join(prepared.outboxDir, "installer.exe"), "fixture");
  s.store.setValue("vk-document-registry", [{ attachment: "doc-202_7", ownerId: -202, documentId: 7, name: "old.zip", uploadedAt: 1, fileKey: "old" }]);
  s.chat.cleanupResult = ["doc-202_7"];
  let attempts = 0;
  t.mock.method(s.chat, "uploadFile", async () => {
    attempts++;
    if (attempts === 1) throw new FileUploadStorageFullError("storage full");
    return "doc-202_8";
  });
  files.observe(binding.id, "idle");
  assert.equal(await files.collect(binding), 1);
  assert.equal(attempts, 2);
  assert.equal(s.chat.cleanupCalls.length, 1);
  assert.deepEqual(s.chat.cleanupCalls[0]!.map(record => record.attachment), ["doc-202_7"]);
  assert.deepEqual(s.store.getValue<VkDocumentRecord[]>("vk-document-registry")?.map(record => record.attachment), ["doc-202_8"]);
});


const questionState = (count = 1) => ({ requests: [{ id: "question-request", method: "item/tool/requestUserInput", params: { turnId: "question-turn", itemId: "question-call",
  questions: Array.from({ length: count }, (_, i) => ({ id: `q${i}`, question: `Question ${i + 1}?`, options: [{ label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }] })) } }] });

test("VK question buttons and quoted free text produce one complete native response", async t => {
  const s = setup(t); const binding = s.attach();
  const state = questionState(2); s.desktop.questions = pendingCodexQuestions(state);
  s.manager.questions.observeQuestions(binding, pendingCodexQuestions(state)); await s.worker.flush();
  const card = s.chat.sent.find(m => m.view.buttons?.some(b => b.label.startsWith("1. Alpha")))!;
  assert.ok(card);
  const first = card.view.buttons![0]!.action;
  await s.handle("", peerId, first);
  assert.equal(s.desktop.questionAnswers.length, 0);
  await s.handle("", peerId, first); // Previous step's button cannot answer the next question.
  assert.equal(s.desktop.questionAnswers.length, 0);
  await s.manager.handle({ ...s.input("Late reply to first question", peerId), replyToMessageId: card.handle.conversationMessageId });
  assert.equal(s.desktop.questionAnswers.length, 0);
  const second = s.chat.sent.find(m => m.view.text.includes("Question 2?"))!;
  await s.manager.handle({ ...s.input("My own answer", peerId), replyToMessageId: second.handle.conversationMessageId });
  await s.worker.flush();
  assert.deepEqual(s.desktop.questionAnswers[0]!.answers, { q0: "Alpha", q1: "My own answer" });
  await s.manager.handle({ ...s.input("Duplicate", peerId), replyToMessageId: card.handle.conversationMessageId });
  assert.equal(s.desktop.questionAnswers.length, 1);
  assert.equal(s.desktop.submissions.length, 0);
  assert.ok(s.chat.edits.some(m => m.view.buttons?.length === 0));
});

test("questions recover without duplicate cards, close when answered elsewhere, and stay owner scoped", async t => {
  const s = setup(t); const binding = s.attach(); const state = questionState();
  s.desktop.questions = pendingCodexQuestions(state);
  s.manager.questions.observeQuestions(binding, pendingCodexQuestions(state)); await s.worker.flush();
  const card = s.chat.sent[0]!;
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  restarted.questions.observeQuestions(binding, pendingCodexQuestions(state)); await s.worker.flush();
  assert.equal(s.chat.sent.length, 1);
  await restarted.handle({ ...s.input("No", peerId), senderId: 999, replyToMessageId: card.handle.conversationMessageId });
  await restarted.handle({ ...s.input("", peerId, card.view.buttons![0]!.action), senderId: 999 });
  assert.equal(s.desktop.questionAnswers.length, 0);
  s.desktop.questions = [];
  restarted.questions.observeQuestions(binding, []);
  await restarted.handle(s.input("", peerId, card.view.buttons![0]!.action));
  await s.worker.flush();
  assert.equal(s.desktop.questionAnswers.length, 0);
  assert.equal(s.desktop.submissions.length, 0);
  assert.ok(s.chat.edits.some(m => m.view.buttons?.length === 0));
});

test("uncertain question answer is never replayed by another button or after restart", async t => {
  const s = setup(t); const binding = s.attach(); const state = questionState();
  s.desktop.questions = pendingCodexQuestions(state); s.desktop.questionError = new UncertainActionError();
  s.manager.questions.observeQuestions(binding, pendingCodexQuestions(state)); await s.worker.flush();
  const action = s.chat.sent[0]!.view.buttons![0]!.action;
  await s.handle("", peerId, action);
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  restarted.questions.observeQuestions(binding, pendingCodexQuestions(state));
  await restarted.handle(s.input("", peerId, action));
  assert.equal(s.desktop.questionAnswers.length, 1);
  assert.equal(s.desktop.submissions.length, 0);
});

test("secret questions expose no answer buttons and refresh does not start a turn", async t => {
  const s = setup(t); s.attach(); const state = questionState();
  Object.assign(state.requests[0]!.params.questions[0]!, { isSecret: true });
  s.desktop.questions = pendingCodexQuestions(state);
  await s.handle("/questions", peerId);
  const card = s.chat.sent[0]!;
  assert.equal(card.view.buttons?.length, 0);
  await s.manager.handle({ ...s.input("do not send", peerId), replyToMessageId: card.handle.conversationMessageId });
  assert.equal(s.desktop.questionAnswers.length, 0);
  assert.equal(s.desktop.submissions.length, 0);
});


test("VK Long Poll replies and callback buttons use the native question handler", async t => {
  const s = setup(t); const binding = s.attach(); const state = questionState(2);
  s.desktop.questions = pendingCodexQuestions(state);
  s.manager.questions.observeQuestions(binding, pendingCodexQuestions(state)); await s.worker.flush();
  const first = s.chat.sent[0]!;
  const vk = new VK({ token: "fixture-token" }); t.mock.method(vk.updates, "startPolling", async () => {});
  t.mock.method(vk.api, "call", async () => 1);
  const gateway = new DesktopVkGateway(loadDesktopBridgeConfig({ VK_GROUP_TOKEN: "fixture-token", VK_GROUP_ID: "202", VK_OWNER_ID: "101" }), vk, undefined, undefined, async () => "Owner User");
  await gateway.start(input => s.manager.handle(input));
  await vk.updates.handleWebhookUpdate({ type: "message_event", group_id: access.groupId, event_id: "callback-test", v: "5.199", object: {
    user_id: access.ownerId, peer_id: peerId, event_id: "question-callback", conversation_message_id: first.handle.conversationMessageId,
    payload: { action: first.view.buttons![1]!.action },
  } });
  await s.worker.flush();
  const second = s.chat.sent.find(m => m.view.text.includes("Question 2?"))!;
  await vk.updates.handleWebhookUpdate({ type: "message_new", group_id: access.groupId, event_id: "reply-test", v: "5.199", object: {
    message: { id: 0, conversation_message_id: 50, peer_id: peerId, from_id: access.ownerId, date: 100, out: 0, text: "Free answer", attachments: [],
      reply_message: { id: 0, conversation_message_id: second.handle.conversationMessageId, peer_id: peerId, from_id: -access.groupId, date: 100, text: second.view.text, attachments: [] } }, client_info: {},
  } });
  assert.deepEqual(s.desktop.questionAnswers[0]!.answers, { q0: "Beta", q1: "Free answer" });
  assert.equal(s.desktop.submissions.length, 0);
});

test("a process crash during question submission preserves the uncertain state", async t => {
  const s = setup(t); const binding = s.attach(); const state = questionState();
  s.desktop.questions = pendingCodexQuestions(state);
  s.manager.questions.observeQuestions(binding, pendingCodexQuestions(state)); await s.worker.flush();
  const action = s.chat.sent[0]!.view.buttons![0]!.action;
  const key = `questions:${binding.id}`;
  const cards = s.store.getValue<Record<string, unknown>[]>(key)!;
  s.store.setValue(key, cards.map(c => ({ ...c, status: "sending", operationId: "lost-operation" })));
  const restarted = new TaskManager(access, s.desktop, s.chat, s.store, s.gate);
  restarted.questions.observeQuestions(binding, pendingCodexQuestions(state));
  assert.equal(s.store.getValue<Record<string, unknown>[]>(key)![0]!.status, "uncertain");
  await restarted.handle(s.input("", peerId, action));
  assert.equal(s.desktop.questionAnswers.length, 0);
  assert.equal(s.desktop.submissions.length, 0);
});
