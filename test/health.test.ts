import assert from "node:assert/strict";
import test from "node:test";
import { BridgeHealthMonitor, type RuntimeHealthState } from "../src/bridge/health.js";
import { BridgeStore } from "../src/bridge/store.js";
import { TaskMirror } from "../src/bridge/mirror.js";
import { STAGED_FILE_PILOT_DISABLED, type StagedFilePilot } from "../src/bridge/config.js";
import { taskKey } from "../src/core/codex-tasks.js";
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

function setup(t: { after(fn: () => void): void }, stagedFilePilot: StagedFilePilot = STAGED_FILE_PILOT_DISABLED,
  stageLedgerAudit?: { lastAttemptAt: number; eligibleCount: number; ineligibleCount: number; failed: boolean }) {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop(); let now = 100_000;
  const runtime = () => ({ startedAt: 40_000, lastTickAt: now, updateStartedAt: null, stopped: false, stagedFilePilot,
    ...(stageLedgerAudit ? { stageLedgerAudit } : {}), activeBindings: 0, connectedBindings: 0, requiredBindings: 0,
    connectedRequiredBindings: 0 });
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, runtime, undefined, () => now, undefined, () => true);
  return { store, chat, desktop, monitor, advance: (ms: number) => { now += ms; } };
}

function setupWithBindings(t: { after(fn: () => void): void }, bindings: () => RuntimeHealthState["bindings"]) {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop(); const now = 100_000;
  const runtime = (): RuntimeHealthState => {
    const current = bindings() ?? [];
    return { startedAt: 40_000, lastTickAt: now, updateStartedAt: null,
      stopped: false, activeBindings: current.length, connectedBindings: current.filter(item => item.connected).length,
      requiredBindings: current.filter(item => ["running", "approval"].includes(item.status)).length,
      connectedRequiredBindings: current.filter(item => item.connected && ["running", "approval"].includes(item.status)).length,
      bindings: current };
  };
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, runtime, undefined, () => now, undefined, () => true);
  return { store, chat, desktop, monitor };
}

test("health monitor verifies the complete healthy bridge and persists its snapshot", async t => {
  const s = setup(t);
  const report = await s.monitor.check(true);
  assert.equal(report.state, "ok");
  assert.deepEqual(report.checks.map(check => check.name), ["sqlite", "runtime", "stage_pilot", "stage_storage", "stage_ledger", "vk_delivery", "codex_mirror", "codex_streams", "codex_tasks", "codex_uncertain_inputs", "vk_inbound_batches", "vk_inbound_journal", "task_transfers", "vk_long_poll", "vk_api", "codex_catalog", "codex_goals", "codex_live_api"]);
  assert.match(report.checks.find(check => check.name === "stage_pilot")!.detail, /пилот отключена/u);
  assert.equal(s.desktop.compatibilityChecks, 1);
  assert.equal(s.desktop.goalReads, 1);
  assert.deepEqual(s.store.getValue("health:latest"), report);
  assert.equal(s.store.pendingDeliveries().length, 0);
});

test("routine health reuses a recent SQLite integrity verdict but explicit checks refresh it", async t => {
  const s = setup(t);
  let integrityChecks = 0;
  let intact = true;
  t.mock.method(s.store, "quickCheck", () => { integrityChecks++; return intact; });
  assert.equal((await s.monitor.check()).checks.find(item => item.name === "sqlite")?.state, "ok");
  assert.equal(integrityChecks, 1);

  s.advance(60_000);
  assert.equal((await s.monitor.check()).checks.find(item => item.name === "sqlite")?.state, "ok");
  assert.equal(integrityChecks, 1, "minute health must not rescan the entire database");

  intact = false;
  assert.equal((await s.monitor.check(true)).checks.find(item => item.name === "sqlite")?.state, "failed");
  assert.equal(integrityChecks, 2, "an explicit check must refresh the integrity verdict");
  s.advance(60_000);
  assert.equal((await s.monitor.check()).checks.find(item => item.name === "sqlite")?.state, "failed");
  assert.equal(integrityChecks, 2, "a failed verdict must not silently turn green between deep checks");

  intact = true;
  s.advance(15 * 60_000);
  assert.equal((await s.monitor.check()).checks.find(item => item.name === "sqlite")?.state, "ok");
  assert.equal(integrityChecks, 3, "the periodic deep check must eventually refresh integrity");
});

test("health does not report a future-dated runtime tick as fresh after clock rollback", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop();
  let now = 100_000;
  const runtime = () => ({ startedAt: 40_000, lastTickAt: 100_000,
    updateStartedAt: null, stopped: false, activeBindings: 0, connectedBindings: 0,
    requiredBindings: 0, connectedRequiredBindings: 0 });
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, runtime,
    undefined, () => now, undefined, () => true);
  assert.equal((await monitor.check()).checks.find(check => check.name === "runtime")?.state, "ok");
  now = 99_999;
  const rolledBack = (await monitor.check()).checks.find(check => check.name === "runtime")!;
  assert.equal(rolledBack.state, "degraded");
  assert.match(rolledBack.detail, /Системное время/u);
});

test("health retries native compatibility after clock rollback", async t => {
  const s = setup(t);
  await s.monitor.check(true);
  assert.equal(s.desktop.compatibilityChecks, 1);
  s.advance(-1);
  await s.monitor.check();
  assert.equal(s.desktop.compatibilityChecks, 2);
});

test("explicit integrity check arriving during routine health runs after that snapshot", async t => {
  const s = setup(t);
  let integrityChecks = 0;
  t.mock.method(s.store, "quickCheck", () => { integrityChecks++; return true; });
  let releaseHealth!: () => void;
  const heldHealth = new Promise<readonly HealthCheckResult[]>(resolve => {
    releaseHealth = () => resolve(s.chat.checks);
  });
  t.mock.method(s.chat, "health", () => heldHealth);

  const routine = s.monitor.check();
  const explicit = s.monitor.check(true);
  assert.equal(s.monitor.check(true), explicit, "concurrent explicit callers share one deferred scan");
  releaseHealth();
  await routine;
  await explicit;
  assert.equal(integrityChecks, 2, "explicit request must not inherit a routine cached verdict");
});

test("health reports an enabled staging pilot's exact peer scope without storage paths", async t => {
  const s = setup(t, Object.freeze({ mode: "single-chat" as const, peerId: 2_000_000_017 }));
  const check = (await s.monitor.check()).checks.find(item => item.name === "stage_pilot")!;
  assert.match(check.detail, /включена только для VK peer 2000000017/u);
  assert.match(check.detail, /автоматическая уборка staged-копий отключена/u);
  assert.doesNotMatch(check.detail, /[\\/]|token|secret/i);
});

test("health reports all-chat immutable staging without storage paths", async t => {
  const s = setup(t, Object.freeze({ mode: "all-chats" as const }));
  const check = (await s.monitor.check()).checks.find(item => item.name === "stage_pilot")!;
  assert.match(check.detail, /staged-копий включена для всех бесед/u);
  assert.match(check.detail, /автоматическая уборка staged-копий отключена/u);
  assert.doesNotMatch(check.detail, /[\\/]|token|secret/i);
});

test("stage storage health distinguishes normal retention from stale pending recycle and never exposes paths", async t => {
  const s = setup(t);
  let clock = 1_000;
  t.mock.method(Date, "now", () => clock);
  const secretPath = "C:/private/retained-customer-file.txt";
  assert.equal(s.store.reserveStage("stage-health", "binding", "operation", 5, secretPath), "reserved");
  s.store.markStageReady("stage-health", secretPath);
  let check = (await s.monitor.check()).checks.find(item => item.name === "stage_storage")!;
  assert.equal(check.state, "ok");
  assert.match(check.detail, /1, 5 байт/u);
  assert.doesNotMatch(check.detail, /private|retained-customer-file/u);
  clock = 100_000;
  assert.equal(s.store.markStageRecyclePending("stage-health", secretPath), true);
  s.advance(10 * 60_000 + 1);
  check = (await s.monitor.check()).checks.find(item => item.name === "stage_storage")!;
  assert.equal(check.state, "degraded");
  assert.match(check.detail, /подтвержд/u);
  assert.doesNotMatch(check.detail, /private|retained-customer-file/u);
  s.store.markStageRecycled("stage-health", secretPath);
  assert.equal((await s.monitor.check()).checks.find(item => item.name === "stage_storage")?.state, "ok");
});

test("stage storage health reports admission quota exhaustion even when maintenance is healthy", async t => {
  const s = setup(t);
  for (let i = 0; i < 10; i++) assert.equal(s.store.reserveStage(`full-${i}`, "binding", `operation-${i}`, 200 * 1024 * 1024, `C:/stage-${i}`), "reserved");
  assert.equal(s.store.reserveStage("full-10", "binding", "operation-10", 48 * 1024 * 1024, "C:/stage-10"), "reserved");
  const check = (await s.monitor.check()).checks.find(item => item.name === "stage_storage")!;
  assert.equal(check.state, "degraded");
  assert.match(check.detail, /квот/u);
});

test("stage ledger health exposes only bounded scalar audit aggregates", async t => {
  const s = setup(t, STAGED_FILE_PILOT_DISABLED, { lastAttemptAt: 99_000, eligibleCount: 2, ineligibleCount: 6, failed: false });
  const check = (await s.monitor.check()).checks.find(item => item.name === "stage_ledger")!;
  assert.equal(check.state, "ok");
  assert.match(check.detail, /2/u);
  assert.match(check.detail, /6/u);
  assert.match(check.detail, /Read-only|только чтение/u);
  assert.doesNotMatch(check.detail, /[\\/]|private|content|C:/iu);
});

test("health detects commentary stuck before the VK queue and clears after mirror recovery", async t => {
  const s = setup(t);
  const binding = s.store.ensureBinding((await s.desktop.listTasks())[0]!);
  s.store.setChat(binding.id, 2_000_000_001, 1);
  const mirror = new TaskMirror(s.store, 3_500, () => 100_000);
  mirror.acceptObservation(binding.id, [{ type: "progress", id: "held", turnId: "turn", text: "PRIVATE COMMENTARY" }], []);
  assert.equal((await s.monitor.check()).checks.find(item => item.name === "codex_mirror")?.state, "ok");
  s.advance(11_000);
  const delayed = (await s.monitor.check()).checks.find(item => item.name === "codex_mirror")!;
  assert.equal(delayed.state, "degraded");
  assert.doesNotMatch(delayed.detail, /PRIVATE COMMENTARY/u);
  new TaskMirror(s.store, 3_500, () => 111_000).tick();
  assert.equal((await s.monitor.check()).checks.find(item => item.name === "codex_mirror")?.state, "ok");
});

test("legacy progress buffers do not claim a current delivery delay", async t => {
  const s = setup(t);
  const binding = s.store.ensureBinding((await s.desktop.listTasks())[0]!);
  s.store.setChat(binding.id, 2_000_000_001, 1);
  s.store.setValue(`deferred-mirror:${binding.id}:old-turn`, [
    { type: "progress", id: "historic", turnId: "old-turn", text: "HISTORIC PROGRESS" },
  ]);
  assert.equal(s.store.deferredMirrors().length, 1, "legacy data remains available for active-turn adoption");
  const mirror = (await s.monitor.check()).checks.find(item => item.name === "codex_mirror")!;
  assert.equal(mirror.state, "ok");
  assert.doesNotMatch(mirror.detail, /HISTORIC PROGRESS/u);
});

test("health retains the age and stage of isolated maintenance while scheduler ticks stay healthy", async t => {
  const s = setup(t); let now = 100_000;
  let maintenance = [{ phase: "history" as const, bindingId: "slow-binding", startedAt: 90_000 }];
  const monitor = new BridgeHealthMonitor(access, s.desktop, s.chat, s.store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 0, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0, maintenance,
  }), undefined, () => now);
  assert.equal((await monitor.check()).checks.find(item => item.name === "runtime_maintenance")?.state, "ok");
  now += 10_000;
  const delayed = await monitor.check();
  assert.equal(delayed.checks.find(item => item.name === "runtime")?.state, "ok");
  assert.equal(delayed.checks.find(item => item.name === "runtime_maintenance")?.state, "degraded");
  assert.match(delayed.checks.find(item => item.name === "runtime_maintenance")!.detail, /history.*slow-binding.*20/u);
  now += 50_000;
  assert.equal((await monitor.check()).checks.find(item => item.name === "runtime_maintenance")?.state, "failed");
  maintenance = [];
  assert.equal((await monitor.check()).checks.find(item => item.name === "runtime_maintenance")?.state, "ok");
});

test("health records the failing phase and retries after an internal exception", async t => {
  const s = setup(t);
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  let broken = true;
  t.mock.method(s.store, "transfers", () => {
    if (broken) throw Object.assign(new Error("fixture failure"), { code: "E_FIXTURE" });
    return [];
  });
  await assert.rejects(s.monitor.check(true), /fixture failure/);
  const failure = JSON.parse(diagnostics[0]!) as { phase: string; errorName: string; errorCode: string };
  assert.equal(failure.phase, "runtime-and-store");
  assert.equal(failure.errorName, "Error");
  assert.equal(failure.errorCode, "E_FIXTURE");
  broken = false;
  assert.equal((await s.monitor.check(true)).state, "ok");
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

test("health describes a connected historical usage limit without claiming the account is still exhausted", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1, connectedBindings: 1,
    requiredBindings: 0, connectedRequiredBindings: 0, failedBindings: 1,
    bindings: [{ id: "limited", title: "Limited task", source: ".codex", status: "failed", connected: true,
      lastConfirmedAt: 90_000, failure: "usageLimit" as const }],
  }), undefined, () => now);
  const check = (await monitor.check(true)).checks.find(item => item.name === "codex_task:limited")!;
  assert.equal(check.state, "degraded");
  assert.match(check.detail, /последний ход завершился.*лимита.*Связь с задачей подтверждена.*\/limits/u);
  assert.doesNotMatch(check.detail, /исчерпан лимит|повторяет подключение/u);
});

test("health distinguishes a live task stream from a missing native owner adapter", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const task = (await new HealthDesktop().listTasks())[0]!;
  const binding = store.ensureBinding(task);
  store.setChat(binding.id, 2_000_000_001, 1);
  store.setAttached(binding.id, true);
  const otherTask = { ...task, threadId: "other", title: "Other task" };
  const other = store.ensureBinding(otherTask);
  store.setChat(other.id, 2_000_000_002, 2);
  store.setAttached(other.id, true);
  let adapter: "ready" | "missing" = "missing";
  const desktop = Object.assign(new HealthDesktop(), { ownerAdapterStatus: async (ref: TaskRef) => ref.threadId === otherTask.threadId ? adapter : "ready" as const });
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, desktop, new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 2, connectedBindings: 2, requiredBindings: 2, connectedRequiredBindings: 2,
    bindings: [binding, other].map(item => ({ id: item.id, title: item.title, source: ".codex", status: "running", connected: true,
      lastConfirmedAt: now, failure: null })),
  }), undefined, () => now, undefined, () => true);
  const missing = await monitor.check(true);
  assert.equal(missing.checks.find(check => check.name === "codex_streams")?.state, "ok");
  assert.equal(missing.checks.find(check => check.name === "codex_owner_adapter:primary")?.state, "degraded");
  assert.match(missing.checks.find(check => check.name === "codex_owner_adapter:primary")!.detail, /Other task/u);
  adapter = "ready";
  const recovered = await monitor.check(true);
  assert.equal(recovered.checks.find(check => check.name === "codex_owner_adapter:primary")?.state, "ok");
});

test("idle disconnected legacy acquisition uncertainty remains visible without an owner probe", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const task = (await new HealthDesktop().listTasks())[0]!;
  const binding = store.ensureBinding(task);
  store.setChat(binding.id, 2_000_000_001, 1); store.setAttached(binding.id, true);
  let probes = 0;
  const desktop = Object.assign(new HealthDesktop(), {
    ownerAdapterStatus: async () => { probes++; return "ready" as const; },
  });
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, desktop, new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 1, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0,
    bindings: [{ id: binding.id, title: binding.title, source: ".codex-work", status: "idle", connected: false,
      lastConfirmedAt: null, failure: null, legacyAcquisition: "unknown" as const,
      route: { kind: "native-observer" as const, routeGeneration: 2 } }],
  }), undefined, () => now, undefined, () => true);
  const report = await monitor.check(true);
  const check = report.checks.find(item => item.name === `codex_legacy_acquisition:${binding.id}`);
  assert.equal(probes, 0, "diagnostic uses local state without starting an owner probe");
  assert.equal(check?.state, "degraded");
  assert.match(check?.detail ?? "", /исход.*подключен|результат.*подключен|неизвест/u);
  assert.match(check?.detail ?? "", /не доказательство физического native writer/u);
  assert.equal(report.checks.some(item => item.name === `codex_native_access:${binding.id}`), false,
    "a read-only observer stays an observer while the old legacy ticket is diagnosed");
  assert.equal(report.state, "degraded");
});

test("publishing task execution lifecycle warns independently of task status and queued ACK age", async t => {
  const s = setupWithBindings(t, () => bindings);
  const specs = [
    { threadId: "01a07930-dbba-77c2-8910-17bd61638e6f", title: "RaceLineCalc : work new 5 - MS/Steam publishing",
      status: "running", executionLifecycle: { state: "checking", at: 99_900, generation: 4 } },
    { threadId: "01a06325-d3d0-7052-b495-371fcb7a2887", title: "RaceLineCalc : work new 5 - android publishing",
      status: "idle", executionLifecycle: { state: "waiting-unload", at: 99_950, generation: 8 } },
  ] as const;
  const bindings = specs.map((spec, index) => {
    const task = { hostId: "local", threadId: spec.threadId, title: spec.title, workspace: "/fixture", updatedAt: 1 };
    const stored = s.store.ensureBinding(task); s.store.setChat(stored.id, 2_000_000_001 + index, 1 + index); s.store.setAttached(stored.id, true);
    if (spec.title.includes("android publishing")) {
      const operationId = "android-old-accepted-ack";
      s.store.recordOperation(operationId, stored, "android-ack-inbox", stored.id, 1);
      s.store.finishOperation(operationId, "accepted");
      s.store.rememberQueuedInput(stored.id, operationId, "android-old-native-queue", 1);
    }
    return { id: stored.id, title: stored.title, source: ".codex-work", status: spec.status,
      connected: true, streamMode: "attached" as const, lastConfirmedAt: 99_900, failure: null,
      executionLifecycle: spec.executionLifecycle };
  });
  const report = await s.monitor.check(true);
  const lifecycle = bindings.map(binding => report.checks.find(check => check.name === `codex_execution_lifecycle:${binding.id}`));
  assert.equal(lifecycle.length, 2);
  assert.ok(lifecycle.every(check => check?.state === "degraded"),
    "running MS checking and idle Android waiting-unload both remain visible warnings");
  assert.match(lifecycle[0]?.detail ?? "", /MS\/Steam publishing/u);
  assert.match(lifecycle[1]?.detail ?? "", /android publishing/u);
  assert.equal(s.store.queuedInputs(bindings[1]!.id).length, 1, "health reporting never consumes the accepted ACK");
  assert.ok(lifecycle.every(check => !/физический writer освобождён|все native окна разблокированы/u.test(check?.detail ?? "")),
    "checking or waiting for unload is not reported as native unlock");
});

test("execution lifecycle reports blocked and unavailable as degraded, then scopes released as OK", async t => {
  const s = setupWithBindings(t, () => runtimeBindings);
  const task = { hostId: "local", threadId: "01a07930-dbba-77c2-8910-17bd61638e6f",
    title: "RaceLineCalc : work new 5 - MS/Steam publishing", workspace: "/fixture", updatedAt: 1 };
  const stored = s.store.ensureBinding(task); s.store.setChat(stored.id, 2_000_000_001, 1); s.store.setAttached(stored.id, true);
  let state: "checking" | "waiting-unload" | "blocked" | "unavailable" | "released" = "waiting-unload";
  let generation = 3;
  const makeRuntimeBinding = (connected: boolean): NonNullable<RuntimeHealthState["bindings"]>[number] => ({
    id: stored.id, title: stored.title, source: ".codex-work", status: "running", connected,
    streamMode: connected ? "attached" : "detached", lastConfirmedAt: 99_900, failure: null,
    executionLifecycle: { state, at: 99_900 + generation, generation },
  });
  let runtimeBindings: NonNullable<RuntimeHealthState["bindings"]> = [makeRuntimeBinding(true)];
  const read = async () => {
    const report = await s.monitor.check(true);
    return report.checks.find(check => check.name === `codex_execution_lifecycle:${stored.id}`);
  };
  let check = await read();
  assert.equal(check?.state, "degraded", "waiting for the native unload is not a release proof");
  for (const next of ["blocked", "unavailable"] as const) {
    state = next; generation++;
    runtimeBindings = [makeRuntimeBinding(true)];
    check = await read();
    assert.equal(check?.state, "degraded", `${next} must remain a visible lifecycle warning`);
  }
  state = "released"; generation++;
  runtimeBindings = [makeRuntimeBinding(false)];
  check = await read();
  assert.equal(check?.state, "ok", "a scoped proof of release can clear the lifecycle warning even if native task status is running");
  assert.match(check?.detail ?? "", /MS\/Steam publishing/u);
  assert.doesNotMatch(check?.detail ?? "", /все native окна разблокированы|вся Desktop-сессия свободна/u,
    "one binding release does not assert global UI health");
});

test("health flags an attached App Server route without lifecycle proof but not a passive native observer", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const chat = new HealthChat(); const desktop = new HealthDesktop(); const now = 100_000;
  const taskA = { hostId: "local", threadId: "legacy-app-server", title: "Legacy attached", workspace: "/fixture", updatedAt: 1 };
  const taskB = { hostId: "local", threadId: "native-observer", title: "Passive native observer", workspace: "/fixture", updatedAt: 1 };
  const a = store.ensureBinding(taskA), b = store.ensureBinding(taskB);
  store.setChat(a.id, 2_000_000_001, 1); store.setAttached(a.id, true);
  store.setChat(b.id, 2_000_000_002, 2); store.setAttached(b.id, true);
  const runtime = (): RuntimeHealthState => ({ startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 2, connectedBindings: 2, requiredBindings: 0, connectedRequiredBindings: 0,
    bindings: [
      { id: a.id, title: a.title, source: ".codex-work", status: "idle", connected: true,
        lastConfirmedAt: now, failure: null, streamMode: "attached", route: { kind: "app-server", routeGeneration: 9 } },
      { id: b.id, title: b.title, source: ".codex", status: "idle", connected: true,
        lastConfirmedAt: now, failure: null, streamMode: "attached", route: { kind: "native-observer", routeGeneration: 10 } },
    ] });
  const monitor = new BridgeHealthMonitor(access, desktop, chat, store, runtime, undefined, () => now, undefined, () => true);
  const report = await monitor.check(true);
  const appServer = report.checks.find(check => check.name === `codex_native_access:${a.id}`);
  assert.equal(appServer?.state, "degraded");
  assert.match(appServer?.detail ?? "", /Legacy attached/u);
  assert.match(appServer?.detail ?? "", /не подтверждает совместный native доступ/u);
  assert.equal(report.checks.some(check => check.name === `codex_native_access:${b.id}`), false,
    "an explicit read-only native observer does not receive the legacy execution-route warning");
});

test("health probes a bounded disconnected running source without calling rollout readers", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const task = (await new HealthDesktop().listTasks())[0]!;
  const binding = store.ensureBinding({ ...task, sourceId: "work-source", title: "Disconnected task" });
  store.setChat(binding.id, 2_000_000_004, 4);
  store.setAttached(binding.id, true);
  const peers = [binding];
  for (let index = 1; index <= 2; index++) {
    const extra = store.ensureBinding({ ...task, threadId: `disconnected-${index}`,
      sourceId: "work-source", title: `Disconnected task ${index}` });
    store.setChat(extra.id, 2_000_000_004 + index, 4 + index);
    store.setAttached(extra.id, true);
    peers.push(extra);
  }
  let probes = 0;
  const desktop = Object.assign(new HealthDesktop(), {
    ownerAdapterStatus: async () => { probes++; return "missing" as const; },
  });
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, desktop, new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 3, connectedBindings: 0, requiredBindings: 3, connectedRequiredBindings: 0,
    bindings: peers.map(item => ({ id: item.id, title: item.title, source: ".codex-work", status: "running", connected: false,
      lastConfirmedAt: null, failure: null })),
  }), undefined, () => now, undefined, () => true);
  const report = await monitor.check(true);
  const probe = report.checks.find(check => check.name === "codex_owner_probe:work-source");
  assert.equal(probes, 2);
  assert.equal(probe?.state, "ok");
  assert.match(probe?.detail ?? "", /2.*не заявлен/u);
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
  store.setValue("rollout-failure:fixture", { at: now, kind: "historyRebuilt" });
  const rebuilt = (await monitor.check(true)).checks.find(item => item.name === "rollout_recovery:fixture")!;
  assert.equal(rebuilt.state, "failed");
  assert.match(rebuilt.detail, /пересобранную ветку.*подтверждённые VK-ходы/u);
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

test("health ignores a stale terminal failure on a detached task", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 1, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0,
    failedBindings: 0, bindings: [{ id: "stale", title: "Stale task", source: ".codex", status: "failed",
      connected: false, streamMode: "detached" as const, lastConfirmedAt: 90_000, failure: "systemError" as const }],
  }), undefined, () => now);
  const report = await monitor.check(true);
  assert.equal(report.checks.find(check => check.name === "codex_tasks")?.state, "ok");
  assert.equal(report.checks.some(check => check.name === "codex_task:stale"), false);
});

test("health reports a detached task whose command routes rejected before dispatch", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const task = (await new HealthDesktop().listTasks())[0]!;
  const binding = store.ensureBinding(task); store.setChat(binding.id, 2_000_000_001, 1); store.setAttached(binding.id, true);
  store.setValue(`route-failure:${binding.id}`, { at: 90_000, kind: "no-active-owner" });
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false,
    activeBindings: 1, connectedBindings: 0, requiredBindings: 0, connectedRequiredBindings: 0,
    failedBindings: 0, bindings: [{ id: binding.id, title: binding.title, source: ".codex", status: "idle",
      connected: false, streamMode: "detached" as const, lastConfirmedAt: null, failure: null }],
  }), undefined, () => now);
  const report = await monitor.check(true);
  const route = report.checks.find(check => check.name === `codex_route:${binding.id}`)!;
  assert.equal(route.state, "failed");
  assert.match(route.detail, /отклонён до отправки.*адаптер/u);
});

test("health detects an accepted VK turn stranded behind an idle or unavailable task", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const task = (await new HealthDesktop().listTasks())[0]!;
  const binding = store.ensureBinding(task);
  store.setChat(binding.id, 2_000_000_001, 1);
  store.setAttached(binding.id, true);
  store.recordOperation("accepted-op", binding, "vk-inbox", binding.id, 100_000);
  store.finishOperation("accepted-op", "accepted");
  store.rememberAcceptedTurn(binding.id, "accepted-turn", "accepted-op");
  let status = "running";
  let now = 300_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1,
    connectedBindings: 1, requiredBindings: status === "running" ? 1 : 0,
    connectedRequiredBindings: status === "running" ? 1 : 0,
    bindings: [{ id: binding.id, title: binding.title, source: ".codex", status, connected: true,
      lastConfirmedAt: now, failure: null }],
  }), undefined, () => now);
  assert.equal((await monitor.check(true)).checks.some(check => check.name === `codex_pending_final:${binding.id}`), false);
  status = "idle";
  const stranded = (await monitor.check(true)).checks.find(check => check.name === `codex_pending_final:${binding.id}`)!;
  assert.equal(stranded.state, "failed");
  assert.match(stranded.detail, /Fixture.*без подтверждения завершения/u);
  status = "unavailable";
  assert.equal((await monitor.check(true)).checks.find(check => check.name === `codex_pending_final:${binding.id}`)?.state, "degraded");
  store.settleAcceptedTurn(binding.id, "accepted-turn");
  assert.equal((await monitor.check(true)).checks.some(check => check.name === `codex_pending_final:${binding.id}`), false);
  store.recordOperation("legacy-op", binding);
  store.finishOperation("legacy-op", "accepted");
  store.rememberAcceptedTurn(binding.id, "legacy-turn", "legacy-op");
  status = "idle";
  assert.equal((await monitor.check(true)).checks.some(check => check.name === `codex_pending_final:${binding.id}`), false);
  now += 6 * 60_000;
  assert.equal((await monitor.check(true)).checks.find(check => check.name === `codex_pending_final:${binding.id}`)?.state, "failed");
  store.settleAcceptedTurn(binding.id, "legacy-turn");
  assert.equal((await monitor.check(true)).checks.some(check => check.name === `codex_pending_final:${binding.id}`), false);
});

test("health detects native queued VK input stranded behind an idle task", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const task = (await new HealthDesktop().listTasks())[0]!;
  const binding = store.ensureBinding(task);
  store.setChat(binding.id, 2_000_000_001, 1);
  store.setAttached(binding.id, true);
  store.recordOperation("queued-op", binding, "vk-inbox", binding.id, 100_000);
  store.finishOperation("queued-op", "accepted");
  store.rememberQueuedInput(binding.id, "queued-op", "native-queue-id", 100_000);
  let status = "running";
  const now = 300_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1,
    connectedBindings: 1, requiredBindings: status === "running" ? 1 : 0,
    connectedRequiredBindings: status === "running" ? 1 : 0,
    bindings: [{ id: binding.id, title: binding.title, source: ".codex", status, connected: true,
      lastConfirmedAt: now, failure: null }],
  }), undefined, () => now);
  assert.equal((await monitor.check(true)).checks.some(check => check.name === `codex_native_queue:${binding.id}`), false);
  status = "idle";
  const stranded = (await monitor.check(true)).checks.find(check => check.name === `codex_native_queue:${binding.id}`)!;
  assert.equal(stranded.state, "failed");
  assert.match(stranded.detail, /Fixture.*локальные подтверждения thread\/queue\/add/u);
  assert.match(stranded.detail, /Текущее наличие в очереди Codex не проверено/u);
  assert.doesNotMatch(stranded.detail, /остаются в штатной очереди/u);
  store.settleQueuedInput(binding.id, "queued-op");
  assert.equal((await monitor.check(true)).checks.some(check => check.name === `codex_native_queue:${binding.id}`), false);
});

test("health exposes bounded per-operation queue scan progress without native history content", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const binding = store.ensureBinding((await new HealthDesktop().listTasks())[0]!);
  store.setChat(binding.id, 2_000_000_001, 1);
  store.setAttached(binding.id, true);
  store.recordOperation("queued-op", binding, "queue-scan-inbox", binding.id, 100_000);
  store.finishOperation("queued-op", "accepted");
  store.rememberQueuedInput(binding.id, "queued-op", "secret native queue item", 100_000);
  store.setValue(`queue-history:${binding.id}:queued-op`, {
    taskKey: taskKey(binding), cursor: { cursor: "secret cursor", headDigest: "secret digest", pages: 3 },
    pages: 3, lastAttemptAt: 190_000, lastFailure: "history_unavailable", nextAt: 3_790_000,
    lastCompletedNoTerminalProofAt: 180_000,
  });
  const now = 200_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1,
    connectedBindings: 1, requiredBindings: 0, connectedRequiredBindings: 0,
    bindings: [{ id: binding.id, title: binding.title, source: ".codex", status: "idle", connected: true,
      lastConfirmedAt: now, failure: null }],
  }), undefined, () => now, undefined, () => true);
  const report = await monitor.check(true);
  const progress = report.checks.find(check => check.name === `codex_queue_scan:${binding.id}:1`)!;
  assert.equal(progress.state, "ok");
  assert.match(progress.detail, /3.*1970-01-01T00:03:10\.000Z.*history_unavailable.*1970-01-01T01:03:10\.000Z/u);
  assert.match(progress.detail, /полный проход.*1970-01-01T00:03:00\.000Z.*без терминального доказательства/u);
  assert.doesNotMatch(JSON.stringify(report), /secret/u);
  assert.equal(report.state, "ok", JSON.stringify(report.checks.filter(check => check.state !== "ok")));
  for (let index = 2; index <= 5; index++) {
    const id = `queued-op-${index}`;
    store.recordOperation(id, binding, `queue-scan-inbox-${index}`, binding.id, 100_000);
    store.finishOperation(id, "accepted");
    store.rememberQueuedInput(binding.id, id, `native-queue-${index}`, 100_000);
  }
  const bounded = await monitor.check(true);
  assert.equal(bounded.checks.filter(check => check.name.startsWith(`codex_queue_scan:${binding.id}:`)).length, 4);
  assert.match(bounded.checks.find(check => check.name === `codex_queue_scan_more:${binding.id}`)?.detail ?? "", /Ещё 1 ACK/u);
  store.setValue(`queue-history:${binding.id}:queued-op`, "malformed legacy checkpoint");
  const malformed = await monitor.check(true);
  assert.equal(malformed.checks.find(check => check.name === `codex_queue_scan:${binding.id}:1`)?.state, "ok");
  assert.doesNotMatch(JSON.stringify(malformed), /malformed legacy checkpoint/u);
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
  assert.match(report.checks.find(check => check.name === `archived_binding:${binding.id}`)!.detail, /\/detach/u);
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

test("health labels route evidence without equating it to physical native writer ownership", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1, connectedBindings: 1,
    requiredBindings: 0, connectedRequiredBindings: 0, bindings: [{ id: "route", title: "Route", source: ".codex", status: "idle", connected: true,
      lastConfirmedAt: now, failure: null, route: { kind: "native-observer" as const, nativeOwnerClientId: "native-client", routeGeneration: 3 } }],
  }), undefined, () => now);
  const report = await monitor.check(true);
  const route = report.checks.find(check => check.name === "codex_route_evidence:route")!;
  assert.match(route.detail, /наблюдатель native.*3.*native-client/u);
  assert.match(route.detail, /не физического writer/u);
  assert.match(report.checks.find(check => check.name === "codex_streams")!.detail, /локальных аренд потока VKodex.*не подтверждает физического native writer/u);
});

test("connection journal is bounded and health exposes the last disconnected lifecycle stage", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  for (let index = 0; index < 40; index++) store.recordConnectionDiagnostic("task", {
    at: 1_000 + index, phase: "verify", outcome: "failed", reason: "app-server-unavailable", routeGeneration: index,
  });
  assert.equal(store.connectionDiagnostics("task").length, 32);
  assert.equal(store.connectionDiagnostics("task")[0]?.routeGeneration, 8);
  const last = store.connectionDiagnostics("task").at(-1)!;
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1, connectedBindings: 0,
    requiredBindings: 1, connectedRequiredBindings: 0, bindings: [{ id: "task", title: "Task", source: ".codex-work",
      status: "running", connected: false, lastConfirmedAt: null, failure: null, lastConnectionDiagnostic: last }],
  }), undefined, () => now);
  const report = await monitor.check(true);
  const check = report.checks.find(item => item.name === "codex_connection_diagnostic:task")!;
  assert.equal(check.state, "degraded");
  assert.match(check.detail, /verify.*failed.*app-server-unavailable.*39/u);
});

test("connection diagnostics cannot follow a VK binding into another physical task", t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const source = { hostId: "local", threadId: "source", sourceId: "work", title: "Source",
    workspace: "C:/fixture", updatedAt: 1 };
  const target = { ...source, threadId: "target", title: "Target" };
  const binding = store.ensureBinding(source);
  store.recordConnectionDiagnostic(binding.id, { at: 1_000, phase: "resume", outcome: "failed" }, source);
  const transfer = { id: "connection-diagnostic-transfer", bindingId: binding.id, startedAt: 1_001,
    source, targetSourceId: "work", targetProjectId: null, phase: "forking" as const };
  store.beginTransfer(transfer);
  store.switchTransfer(transfer, target, 1_002);
  assert.deepEqual(store.connectionDiagnostics(binding.id, target), []);
  store.recordConnectionDiagnostic(binding.id, { at: 1_003, phase: "verify", outcome: "failed" }, source);
  assert.deepEqual(store.connectionDiagnostics(binding.id, target), []);
  store.recordConnectionDiagnostic(binding.id, { at: 1_004, phase: "resume", outcome: "confirmed" }, target);
  assert.deepEqual(store.connectionDiagnostics(binding.id, target).map(event => event.at), [1_004]);
});

test("invalid durable connection timestamp does not crash health", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1, connectedBindings: 0,
    requiredBindings: 1, connectedRequiredBindings: 0, bindings: [{ id: "task", title: "Task", source: ".codex-work",
      status: "running", connected: false, lastConfirmedAt: null, failure: null,
      lastConnectionDiagnostic: { at: Number.MAX_SAFE_INTEGER, phase: "verify", outcome: "failed" } }],
  }), undefined, () => now);
  const report = await monitor.check(true);
  assert.match(report.checks.find(item => item.name === "codex_connection_diagnostic:task")!.detail, /время неизвестно/u);
});

test("health explains a failed route attempt without exposing transport exception text", async t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const now = 100_000;
  const monitor = new BridgeHealthMonitor(access, new HealthDesktop(), new HealthChat(), store, () => ({
    startedAt: 1, lastTickAt: now, updateStartedAt: null, stopped: false, activeBindings: 1, connectedBindings: 0,
    requiredBindings: 1, connectedRequiredBindings: 0, bindings: [{ id: "route", title: "Route", source: ".codex-work",
      status: "running", connected: false, lastConfirmedAt: null, failure: null,
      route: { kind: "unknown" as const, selection: "native-after-owner-rejection" as const,
        failureClass: "desktop-unavailable" as const, routeGeneration: 7 } }],
  }), undefined, () => now);
  const report = await monitor.check(true);
  const route = report.checks.find(check => check.name === "codex_route_attempt:route")!;
  assert.equal(route.state, "degraded");
  assert.match(route.detail, /native.*отказа профильного владельца.*недоступен.*7/u);
  assert.doesNotMatch(route.detail, /token|pipe|exception/u);
});
