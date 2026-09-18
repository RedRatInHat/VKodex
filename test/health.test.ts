import assert from "node:assert/strict";
import test from "node:test";
import { BridgeHealthMonitor } from "../src/bridge/health.js";
import { BridgeStore } from "../src/bridge/store.js";
import type { BridgeChat, HealthCheckResult, MessageHandle, View } from "../src/bridge/contracts.js";
import type { CreateTaskRequest, DesktopCompatibility, DesktopModel, DesktopProject, DesktopTask, DesktopTasks, SubmitTaskRequest, TaskDetails, TaskGoalUpdate, TaskRef, TaskRenameResult } from "../src/desktop/contracts.js";

const access = { ownerId: 101, groupId: 202 };

class HealthChat implements BridgeChat {
  checks: readonly HealthCheckResult[] = [
    { name: "vk_long_poll", state: "ok", detail: "Long Poll active." },
    { name: "vk_api", state: "ok", detail: "VK API active." },
  ];
  async health() { return this.checks; }
  async createConversation() { return { peerId: 2_000_000_001, chatId: 1 }; }
  async renameConversation(_peerId: number, _title: string, beforeWrite: () => Promise<void>) { await beforeWrite(); }
  async inviteLink() { return "https://vk.me/join/fixture"; }
  async send(peerId: number, _view: View, randomId: number): Promise<MessageHandle> { return { peerId, conversationMessageId: randomId }; }
  async edit() {}
  async delete() {}
  async uploadDocument() { return "doc-202_1_fixture"; }
}

class HealthDesktop implements DesktopTasks {
  readonly capabilities = { createTask: false, startTurn: true, steerTurn: true, interruptTurn: true, selectModel: false, goals: true };
  compatibilityState: DesktopCompatibility = { state: "ok", message: "protocol v11 confirmed" };
  compatibilityChecks = 0;
  goalReads = 0;
  async listTasks(): Promise<readonly DesktopTask[]> { return [{ hostId: "local", threadId: "fixture", title: "Fixture", workspace: "/fixture", updatedAt: 1 }]; }
  async isTaskArchived(_task: TaskRef): Promise<boolean> { return false; }
  async listProjects(): Promise<readonly DesktopProject[]> { return []; }
  async createTask(_request: CreateTaskRequest): Promise<DesktopTask> { throw new Error("not used"); }
  async submit(_request: SubmitTaskRequest): Promise<void> { throw new Error("not used"); }
  async interrupt(_task: TaskRef): Promise<void> { throw new Error("not used"); }
  async moveTask(_task: TaskRef, _projectId: string | null): Promise<void> { throw new Error("not used"); }
  async inspectTask(_task: TaskRef): Promise<TaskDetails> { throw new Error("not used"); }
  async listModels(_task?: TaskRef): Promise<readonly DesktopModel[]> { return []; }
  async selectModel(_task: TaskRef, _model: string, _effort: string): Promise<void> { throw new Error("not used"); }
  async renameTask(_task: TaskRef, _title: string): Promise<TaskRenameResult> { throw new Error("not used"); }
  async archiveTask(_task: TaskRef): Promise<void> { throw new Error("not used"); }
  async exportMarkdown(_task: TaskRef): Promise<string> { throw new Error("not used"); }
  async getGoal(_task: TaskRef) { this.goalReads++; return null; }
  async setGoal(_task: TaskRef, _update: TaskGoalUpdate): Promise<never> { throw new Error("not used"); }
  async clearGoal(_task: TaskRef): Promise<never> { throw new Error("not used"); }
  compatibility() { return this.compatibilityState; }
  async checkCompatibility() { this.compatibilityChecks++; return this.compatibilityState; }
}

function setup(t: { after(fn: () => void): void }) {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop(); let now = 100_000;
  const runtime = () => ({ startedAt: 40_000, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 0, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0 });
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, runtime, undefined, () => now, undefined, () => true);
  return { store, chat, desktop, monitor, advance: (ms: number) => { now += ms; } };
}

test("health monitor verifies the complete healthy bridge and persists its snapshot", async t => {
  const s = setup(t);
  const report = await s.monitor.check(true);
  assert.equal(report.state, "ok");
  assert.deepEqual(report.checks.map(check => check.name), ["sqlite", "runtime", "vk_delivery", "codex_streams", "codex_tasks", "codex_uncertain_inputs", "vk_inbound_batches", "vk_inbound_journal", "task_transfers", "vk_long_poll", "vk_api", "codex_catalog", "codex_goals", "codex_live_api"]);
  assert.equal(s.desktop.compatibilityChecks, 1);
  assert.equal(s.desktop.goalReads, 1);
  assert.deepEqual(s.store.getValue("health:latest"), report);
  assert.equal(s.store.pendingDeliveries().length, 0);
});

test("Codex task failures degrade health even with a connected stream", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1, connectedBindings: 1,
    requiredBindings: 0, connectedRequiredBindings: 0, failedBindings: 1,
  }), undefined, () => now);
  const report = await monitor.check(true);
  assert.equal(report.state, "degraded");
  assert.equal(report.checks.find(check => check.name === "codex_streams")!.state, "ok");
  assert.equal(report.checks.find(check => check.name === "codex_tasks")!.state, "degraded");
});

test("health identifies a blocked rollout recovery without exposing its history", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  store.setValue("rollout-failure:fixture", { at: now, kind: "recordTooLarge" });
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 1, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0,
    bindings: [{ id: "fixture", title: "Fixture", source: ".codex", status: "idle", connected: false,
      lastConfirmedAt: null, failure: null }],
  }), undefined, () => now);
  const check = (await monitor.check(true)).checks.find(item => item.name === "rollout_recovery:fixture")!;
  assert.equal(check.state, "failed");
  assert.match(check.detail, /Fixture.*безопасного предела/u);
  assert.doesNotMatch(check.detail, /[{}]/u);
  store.setValue("rollout-failure:fixture", null);
  assert.equal((await monitor.check(true)).checks.some(item => item.name === "rollout_recovery:fixture"), false);
});

test("health escalates a prompt whose Codex acceptance remains unconfirmed", async t => {
  const s = setup(t);
  const task = (await s.desktop.listTasks())[0]!;
  const binding = s.store.ensureBinding(task);
  s.store.recordOperation("unknown-prompt", binding, "inbox-key", binding.id, 100_000);
  s.store.finishOperation("unknown-prompt", "uncertain");
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "codex_uncertain_inputs")?.state, "degraded");
  s.advance(11 * 60_000);
  const report = await s.monitor.check(true);
  assert.equal(report.checks.find(check => check.name === "codex_uncertain_inputs")?.state, "failed");
});

test("health reports a saved VK burst that remains unprocessed", async t => {
  const s = setup(t);
  s.store.saveInputBatch({ id: "stuck-burst", peerId: 2_000_000_001,
    parts: [{ eventId: "message:1", peerId: 2_000_000_001, senderId: 101, text: "x".repeat(3000) }],
    startedAt: 100_000, updatedAt: 100_000, state: "collecting" });
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_inbound_batches")?.state, "ok");
  s.advance(31_000);
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_inbound_batches")?.state, "degraded");
  s.advance(2 * 60_000);
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_inbound_batches")?.state, "failed");
});

test("health escalates unprocessed durable VK input without exposing its text", async t => {
  const s = setup(t);
  const input = { eventId: "message:99", peerId: 2_000_000_001, senderId: 101, text: "private fixture prompt" };
  s.store.receiveInput(input, 100_000);
  let check = (await s.monitor.check(true)).checks.find(item => item.name === "vk_inbound_journal")!;
  assert.equal(check.state, "degraded");
  assert.doesNotMatch(check.detail, /private fixture/u);
  s.advance(11 * 60_000);
  check = (await s.monitor.check(true)).checks.find(item => item.name === "vk_inbound_journal")!;
  assert.equal(check.state, "failed");
  s.store.setValue("inbound-recovery-error", { at: 100_000 });
  assert.equal((await s.monitor.check(true)).checks.find(item => item.name === "vk_inbound_journal")?.state, "failed");
});

test("health identifies each failed task and alerts when a second task fails", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  let now = 100_000;
  const bindings = [
    { id: "first", title: "First", source: ".codex", status: "failed", connected: true, lastConfirmedAt: 90_000, failure: "systemError" as const },
  ];
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: bindings.length,
    connectedBindings: bindings.length, requiredBindings: 0, connectedRequiredBindings: 0,
    failedBindings: bindings.length, bindings,
  }), undefined, () => now);
  await monitor.check(true);
  now += 60_000; await monitor.check(true);
  const initial = store.pendingDeliveries()[0]!;
  assert.match(initial.view.text, /First/u);
  store.delivered(initial, { peerId: access.ownerId, conversationMessageId: 1 });
  bindings.push({ id: "second", title: "Second", source: ".codex-work", status: "failed", connected: true,
    lastConfirmedAt: 120_000, failure: "systemError" });
  now += 60_000; await monitor.check(true);
  now += 60_000; await monitor.check(true);
  const later = store.pendingDeliveries();
  assert.equal(later.length, 1);
  assert.match(later[0]!.view.text, /Second/u);
});

test("health names a disconnected running task but ignores an idle detached owner", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 2, connectedBindings: 0, requiredBindings: 1, connectedRequiredBindings: 0,
    bindings: [
      { id: "running", title: "Active task", source: ".codex-work", status: "running", connected: false, lastConfirmedAt: 75_000, failure: null },
      { id: "idle", title: "Idle task", source: ".codex", status: "idle", connected: false, lastConfirmedAt: null, failure: null },
    ],
  }), undefined, () => now);
  const report = await monitor.check(true);
  assert.equal(report.checks.find(check => check.name === "codex_task:running")?.state, "degraded");
  assert.match(report.checks.find(check => check.name === "codex_task:running")!.detail, /Active task.*последнее подтверждение/u);
  assert.equal(report.checks.some(check => check.name === "codex_task:idle"), false);
});

test("health detects stuck and legacy transfers even when streams and the database are healthy", async t => {
  const s = setup(t);
  const task = (await s.desktop.listTasks())[0]!;
  const binding = s.store.ensureBinding(task);
  s.store.markTransfer({ id: "operation", bindingId: binding.id, source: task, startedAt: 90_000,
    targetSourceId: "work", targetProjectId: null, phase: "preparingTarget" });
  const report = await s.monitor.check();
  assert.equal(report.checks.find(check => check.name === "task_transfers")?.state, "degraded");
  s.store.updateTransfer(s.store.transfer(binding.id)!, { version: 2, updatedAt: 100_000 });
  const retrying = await s.monitor.check();
  assert.equal(retrying.checks.find(check => check.name === "task_transfers")?.state, "degraded");
  s.store.updateTransfer(s.store.transfer(binding.id)!, { blocked: true });
  const blocked = await s.monitor.check();
  assert.equal(blocked.checks.find(check => check.name === "task_transfers")?.state, "failed");
  assert.equal(blocked.checks.find(check => check.name === "transfer:operation")?.state, "failed");
  s.store.updateTransfer(s.store.transfer(binding.id)!, { phase: "complete" });
  assert.equal((await s.monitor.check()).checks.find(check => check.name === "task_transfers")?.state, "ok");
});

test("health names a transfer whose source changed without exposing task history", async t => {
  const s = setup(t);
  const task = (await s.desktop.listTasks())[0]!;
  const binding = s.store.ensureBinding(task);
  s.store.markTransfer({ id: "changed-source", bindingId: binding.id, source: task, startedAt: 90_000,
    targetSourceId: "work", targetProjectId: null, phase: "switched", version: 2,
    step: "archive", blocked: true, blockedReason: "sourceChanged", detail: "private history content" });
  const report = await s.monitor.check(true);
  const check = report.checks.find(item => item.name === "transfer:changed-source")!;
  assert.equal(check.state, "failed");
  assert.match(check.detail, /изменились история или цель/u);
  assert.doesNotMatch(check.detail, /private history content/u);
});

test("health monitor degrades when an attached task points to a missing workspace", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop(); const now = 100_000;
  const task = (await desktop.listTasks())[0]!;
  const binding = store.ensureBinding(task); store.setChat(binding.id, 2_000_000_001, 1);
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1, connectedBindings: 1, requiredBindings: 0, connectedRequiredBindings: 0,
  }), undefined, () => now, undefined, () => false);
  const report = await monitor.check(true);
  const catalog = report.checks.find(check => check.name === "codex_catalog")!;
  assert.equal(catalog.state, "degraded");
  assert.match(catalog.detail, /рабочая папка недоступна/u);
});

test("health fails for a VK binding left on an archived task", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const desktop = new HealthDesktop(); desktop.listTasks = async () => [];
  desktop.isTaskArchived = async task => task.threadId === "archived-task";
  const binding = store.ensureBinding({ hostId: "local", threadId: "archived-task", title: "Archived task", workspace: "/fixture", updatedAt: 1 });
  store.setChat(binding.id, 2_000_000_001, 1);
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, desktop, new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 1, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0,
  }), undefined, () => now);
  const report = await monitor.check(true);
  assert.equal(report.state, "failed");
  assert.match(report.checks.find(check => check.name === `archived_binding:${binding.id}`)!.detail, /Archived task.*архивной задаче/u);
});

test("failed checks alert after two runs and recovery waits for three healthy runs", async t => {
  const s = setup(t);
  s.chat.checks = [{ name: "vk_api", state: "failed", detail: "VK API unavailable without raw credentials." }];
  assert.equal((await s.monitor.check(true)).state, "failed");
  assert.equal(s.store.pendingDeliveries().length, 0);
  s.advance(60_000);
  assert.equal((await s.monitor.check(true)).state, "failed");
  let pending = s.store.pendingDeliveries();
  assert.equal(pending.length, 1); assert.match(pending[0]!.view.text, /health check FAILED/u);
  s.store.delivered(pending[0]!, { peerId: access.ownerId, conversationMessageId: 1 });
  s.chat.checks = [{ name: "vk_api", state: "ok", detail: "VK API active." }];
  for (let run = 1; run <= 3; run++) {
    s.advance(60_000);
    assert.equal((await s.monitor.check(true)).state, "ok");
    if (run < 3) assert.equal(s.store.pendingDeliveries().length, 0);
  }
  pending = s.store.pendingDeliveries();
  assert.equal(pending.length, 1); assert.match(pending[0]!.view.text, /снова OK/u);
});

test("a new failed check alerts even while another failure keeps overall health FAILED", async t => {
  const s = setup(t);
  s.chat.checks = [{ name: "vk_api", state: "failed", detail: "API unavailable" }];
  await s.monitor.check(true);
  s.advance(60_000); await s.monitor.check(true);
  const first = s.store.pendingDeliveries()[0]!;
  s.store.delivered(first, { peerId: access.ownerId, conversationMessageId: 1 });
  s.chat.checks = [
    { name: "vk_api", state: "failed", detail: "API unavailable" },
    { name: "vk_long_poll", state: "failed", detail: "No incoming messages" },
  ];
  s.advance(60_000); assert.equal((await s.monitor.check(true)).state, "failed");
  assert.equal(s.store.pendingDeliveries().length, 0);
  s.advance(60_000); assert.equal((await s.monitor.check(true)).state, "failed");
  const second = s.store.pendingDeliveries();
  assert.equal(second.length, 1);
  assert.match(second[0]!.view.text, /vk_long_poll: No incoming messages/u);
  s.store.delivered(second[0]!, { peerId: access.ownerId, conversationMessageId: 2 });
  s.advance(60_000); await s.monitor.check(true);
  assert.equal(s.store.pendingDeliveries().length, 0);
});

test("a delivery backlog becomes degraded and then failed instead of looking healthy forever", async t => {
  const s = setup(t);
  s.store.enqueue("stuck", access.ownerId, { text: "fixture" });
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_delivery")!.state, "ok");
  s.advance(31_000);
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_delivery")!.state, "degraded");
  s.advance(5 * 60_000);
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_delivery")!.state, "failed");
});

test("different critical deliveries do not inherit the age of a completed message", async t => {
  const s = setup(t);
  s.store.enqueue("first", access.ownerId, { text: "first" });
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_delivery")!.state, "ok");
  const first = s.store.pendingDeliveries()[0]!;
  s.store.delivered(first, { peerId: access.ownerId, conversationMessageId: 1 });
  s.advance(6 * 60_000);
  s.store.enqueue("second", access.ownerId, { text: "second" });
  assert.equal((await s.monitor.check(true)).checks.find(check => check.name === "vk_delivery")!.state, "ok");
});

test("ordinary background revisions never accumulate a false delivery age", async t => {
  const s = setup(t);
  s.store.enqueue("thinking", access.ownerId, { text: "думаю...", silent: true }, null, "activity");
  for (let run = 0; run < 7; run++) {
    const check = (await s.monitor.check(true)).checks.find(item => item.name === "vk_delivery")!;
    assert.equal(check.state, "ok");
    s.advance(60_000);
    s.store.enqueue("thinking", access.ownerId, { text: `думаю${".".repeat(run % 3 + 1)}`, silent: true }, null, "activity");
  }
});

test("a stuck activity edit stays degraded and does not page during a short VK throttle", async t => {
  const s = setup(t);
  s.store.enqueue("thinking", access.ownerId, { text: "думаю...", silent: true }, null, "activity");
  const delivery = s.store.pendingDeliveries()[0]!;
  s.store.recordDeliveryFailure(delivery, "rate_limit", 120_000, 100_000);
  s.store.setValue("vk-delivery-paused-until", 220_000);
  for (let run = 1; run <= 9; run++) {
    const report = await s.monitor.check(true);
    const check = report.checks.find(item => item.name === "vk_delivery")!;
    assert.equal(check.state, "degraded");
    assert.match(check.detail, /0 важных, 1 фоновых/u);
    assert.notEqual(report.state, "failed");
    assert.equal(s.store.pendingDeliveries().filter(item => item.key.startsWith("health-alert:")).length, 0);
    s.advance(60_000);
  }
  assert.equal((await s.monitor.check(true)).state, "degraded");
  const alerts = s.store.pendingDeliveries().filter(item => item.key.startsWith("health-alert:"));
  assert.equal(alerts.length, 1); assert.match(alerts[0]!.view.text, /health check DEGRADED/u);
});

test("stalled runtime updates and missing Codex streams are visible independently", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop(); const now = 200_000;
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, () => ({
    startedAt: 1, lastTickAt: now - 11_000, updateStartedAt: now - 61_000, stopped: false, activeBindings: 3, connectedBindings: 1, requiredBindings: 2, connectedRequiredBindings: 1,
  }), undefined, () => now);
  const report = await monitor.check(true);
  assert.equal(report.state, "failed");
  assert.equal(report.checks.find(check => check.name === "runtime")!.state, "failed");
  assert.equal(report.checks.find(check => check.name === "codex_streams")!.state, "degraded");
});
