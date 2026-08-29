import assert from "node:assert/strict";
import test from "node:test";
import { BridgeHealthMonitor } from "../src/bridge/health.js";
import { BridgeStore } from "../src/bridge/store.js";
import type { BridgeChat, HealthCheckResult, MessageHandle, View } from "../src/bridge/contracts.js";
import type { CreateTaskRequest, DesktopCompatibility, DesktopModel, DesktopProject, DesktopTask, DesktopTasks, SubmitTaskRequest, TaskDetails, TaskRef, TaskRenameResult } from "../src/desktop/contracts.js";

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
  async uploadDocument() { return "doc-202_1_fixture"; }
}

class HealthDesktop implements DesktopTasks {
  readonly capabilities = { createTask: false, startTurn: true, steerTurn: true, interruptTurn: true, selectModel: false };
  compatibilityState: DesktopCompatibility = { state: "ok", message: "protocol v11 confirmed" };
  compatibilityChecks = 0;
  async listTasks(): Promise<readonly DesktopTask[]> { return []; }
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
  compatibility() { return this.compatibilityState; }
  async checkCompatibility() { this.compatibilityChecks++; return this.compatibilityState; }
}

function setup(t: { after(fn: () => void): void }) {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop(); let now = 100_000;
  const runtime = () => ({ startedAt: 40_000, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 0, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0 });
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, runtime, undefined, () => now);
  return { store, chat, desktop, monitor, advance: (ms: number) => { now += ms; } };
}

test("health monitor verifies the complete healthy bridge and persists its snapshot", async t => {
  const s = setup(t);
  const report = await s.monitor.check(true);
  assert.equal(report.state, "ok");
  assert.deepEqual(report.checks.map(check => check.name), ["sqlite", "runtime", "vk_delivery", "codex_streams", "vk_long_poll", "vk_api", "codex_catalog", "codex_live_api"]);
  assert.equal(s.desktop.compatibilityChecks, 1);
  assert.deepEqual(s.store.getValue("health:latest"), report);
  assert.equal(s.store.pendingDeliveries().length, 0);
});

test("two failed checks alert once and recovery emits a separate notification", async t => {
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
  s.advance(60_000);
  assert.equal((await s.monitor.check(true)).state, "ok");
  pending = s.store.pendingDeliveries();
  assert.equal(pending.length, 1); assert.match(pending[0]!.view.text, /снова OK/u);
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
