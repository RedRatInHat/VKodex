import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTaskTitles, readTaskCatalog } from "../src/desktop/catalog.js";
import { ActionRejectedError, DesktopRequestRejectedError, DesktopUnavailableError, TransferPageTooLargeError, TaskNotOpenError, UncertainActionError, TransferConflictError, type DesktopTask, type DesktopTaskCreator, type TransferTaskRequest } from "../src/desktop/contracts.js";
import { ConnectedDesktopTasks } from "../src/desktop/desktop-tasks.js";
import { withVkResponseFormat } from "../src/core/task-input.js";
import { AppServerTaskCreator } from "../src/desktop/app-server-creator.js";
import { AppServerTaskTransfer, stageTransferRollout, TransferRpc, transferCompatibleRecord } from "../src/desktop/app-server-transfer.js";
import { completedHistoryDigest } from "../src/desktop/history-digest.js";
import { findAcceptedInputTurn } from "../src/desktop/input-reconciliation.js";
import { DesktopIpcClient, encodeFrame, FrameDecoder, isObject, type IpcObject } from "../src/desktop/ipc-client.js";
import { projectSnapshot } from "../src/desktop/projector.js";
import { RevisionedState } from "../src/desktop/state.js";
import { TaskSubscription } from "../src/desktop/subscription.js";
import { RolloutTailer } from "../src/desktop/rollout-tailer.js";
import { RolloutTaskHistoryRecovery, type TaskHistoryRecovery } from "../src/desktop/history-recovery.js";
import { comparablePath } from "../src/desktop/paths.js";
import { observeTaskState } from "../src/desktop/task-observation.js";
import { pendingCodexQuestions, asyncQuestionReply, parseAsyncQuestionReply } from "../src/desktop/questions.js";
import { taskDetails } from "../src/desktop/details.js";
import { DesktopBridgeRuntime } from "../src/bridge/runtime.js";
import { DesktopTaskStateTransport, TaskStateConnections, type TaskStateTransport } from "../src/desktop/state-transport.js";
import { BridgeStore } from "../src/bridge/store.js";
import { captureRestartIntent, readRestartIntent } from "../src/desktop/restart-intent.js";
import type { Binding, BridgeChat, MessageHandle, View } from "../src/bridge/contracts.js";

const ref = { hostId: "local", threadId: "fixture-task" };
const questionRequest = { id: 42, method: "item/tool/requestUserInput", params: { threadId: "fixture-task", turnId: "fixture-turn", itemId: "call-question",
  questions: [{ id: "choice", question: "Which option?", options: [{ label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }] }] } };
const state = (items: IpcObject[] = [], status = "inProgress"): IpcObject => ({ id: ref.threadId, hostId: ref.hostId, turns: [], turnHistory: { history: { entitiesByKey: {
  tail: { turnId: "fixture-turn", turnStartedAtMs: 100, status, items },
} } } });

class Server extends Duplex {
  readonly received: IpcObject[] = [];
  private readonly decoder = new FrameDecoder();
  dataState = state();
  ownerId = "owner";
  answerWrites = true;
  disconnectOnStart = false;
  rejectStart = false;
  rejectDiscovery = false;
  discoveryError = "no-client-found";
  startResult: IpcObject = { turn: { id: "next-turn", status: "inProgress", items: [] } };
  onFollow: (() => void) | null = null;
  onDiscovery: (() => void) | null = null;
  settingsReply: IpcObject = { applied: true };
  settingsVersion = 2;
  settingsVersionError = "request-version-mismatch";
  readonly interruptReplies: ("success" | "error" | "malformed-stopped")[] = [];
  interruptReply: (() => "success" | "error" | "malformed-stopped") | null = null;
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    for (const message of this.decoder.push(chunk)) {
      this.received.push(message);
      queueMicrotask(() => this.respond(message));
    }
    callback();
  }
  send(message: IpcObject): void { if (!this.destroyed) this.push(encodeFrame(message)); }
  snapshot(version = 11, source = this.ownerId, threadId = ref.threadId): void {
    this.send({ type: "broadcast", method: "thread-stream-state-changed", version, sourceClientId: source, targetClientIds: ["bridge-client"],
      params: { hostId: "local", conversationId: threadId, change: { type: "snapshot", revision: 1, conversationState: this.dataState } } });
  }
  private respond(message: IpcObject): void {
    if (message.type === "request") {
      let result: IpcObject = {};
      if (message.method === "initialize") result = { clientId: "bridge-client" };
      if (message.method === "thread-owner-discovery") {
        this.onDiscovery?.();
        if (this.rejectDiscovery) {
          this.send({ type: "response", requestId: message.requestId, resultType: "error", error: this.discoveryError });
          return;
        }
      }
      if (message.method === "thread-follower-steer-turn") {
        if (!this.answerWrites) return;
        result = { result: { turnId: "fixture-turn" } };
      }
      if (message.method === "thread-follower-submit-user-input") {
        if (!this.answerWrites) return;
        result = { ok: true };
        this.dataState = { ...this.dataState, requests: [] }; this.snapshot();
      }
      if (message.method === "thread-follower-start-turn") {
        if (this.disconnectOnStart) { this.destroy(); return; }
        if (!this.answerWrites) return;
        if (this.rejectStart) {
          this.send({ type: "response", requestId: message.requestId, resultType: "error", error: "private backend error" });
          return;
        }
        result = { result: this.startResult };
      }
      if (message.method === "thread-follower-update-thread-settings") {
        if (message.version !== this.settingsVersion) {
          this.send({ type: "response", requestId: message.requestId, resultType: "error", error: this.settingsVersionError });
          return;
        }
        result = this.settingsReply;
        this.dataState = { ...this.dataState, latestThreadSettings: (message.params as IpcObject).threadSettings };
        this.snapshot();
      }
      if (message.method === "thread-follower-interrupt-turn") {
        const reply = this.interruptReply?.() ?? this.interruptReplies.shift() ?? "success";
        if (reply === "error") {
          this.send({ type: "response", requestId: message.requestId, resultType: "error", error: "private backend error" });
          return;
        }
        if (reply === "malformed-stopped") {
          this.dataState = state([], "interrupted"); this.snapshot(); result = { result: { ok: true } };
        } else result = { result: { ok: true, interruptedTurnId: "fixture-turn" } };
      }
      if (message.method === "thread-follower-edit-last-user-turn") {
        result = { ok: true };
        this.dataState = { id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "active" }, turns: [{
          turnId: "replacement-turn", turnStartedAtMs: 200, status: "inProgress",
          params: { clientUserMessageId: "replacement-operation", input: [{ type: "text", text: (message.params as IpcObject).message }] }, items: [],
        }] };
        this.snapshot();
      }
      this.send({ type: "response", requestId: message.requestId, resultType: "success", result, handledByClientId: this.ownerId });
    } else if (message.method === "thread-stream-following-changed" && isObject(message.params) && message.params.following) {
      if (this.onFollow) this.onFollow(); else this.snapshot();
    }
  }
}

class FakeStateTransport implements TaskStateTransport {
  subscriptions = 0;
  closed = false;
  constructor(private readonly snapshot: IpcObject) {}
  subscribe(task: typeof ref, onState: (state: IpcObject, initial: boolean) => void) {
    this.subscriptions++;
    let closed = false;
    return {
      task,
      start: async () => { if (!closed) onState(this.snapshot, true); },
      verifyOwner: async () => { if (closed) throw new Error("closed"); },
      close: () => { closed = true; },
    };
  }
  close(): void { this.closed = true; }
}

const runtimeAdapters = (states: TaskStateTransport) => ({
  states,
  observe: observeTaskState,
  history: new RolloutTaskHistoryRecovery(),
});

function runtimeSetup(t: TestContext, healthCheckOverride?: (force: boolean) => Promise<import("../src/bridge/contracts.js").BridgeHealthSnapshot>,
  streamTransport?: TaskStateTransport,
  inspectExternalOwner?: (task: import("../src/core/codex-tasks.js").TaskRef) => Promise<"idle" | "active" | "systemError" | null>,
  goals?: import("../src/desktop/contracts.js").DesktopGoals,
  history?: TaskHistoryRecovery) {
  const access = { ownerId: 101, groupId: 202 }; const peerId = 2_000_000_017;
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const server = new Server(); const client = new DesktopIpcClient(() => server, 100);
  const store = new BridgeStore(); const binding = store.ensureBinding(task);
  store.setChat(binding.id, peerId, 17);
  const sent: { peerId: number; view: View }[] = [];
  const edits: { handle: MessageHandle; view: View }[] = [];
  const chat: BridgeChat = {
    send: async (peerId, view) => { sent.push({ peerId, view }); return { peerId, conversationMessageId: sent.length }; },
    edit: async (handle, view) => { edits.push({ handle, view }); },
    delete: async () => {},
    createConversation: async () => { throw new Error("Unexpected chat creation"); },
    renameConversation: async () => { throw new Error("Unexpected chat rename"); },
    inviteLink: async () => { throw new Error("Unexpected invitation"); },
    uploadDocument: async () => { throw new Error("Unexpected upload"); },
  };
  const desktop = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => client,
    undefined, undefined, goals);
  let now = 100_000;
  const runtime = new DesktopBridgeRuntime(access, desktop, chat, store,
    { ...runtimeAdapters(streamTransport ?? new DesktopTaskStateTransport(client)), ...(history ? { history } : {}),
      ...(inspectExternalOwner ? { inspectExternalOwner } : {}) },
    () => now, undefined, undefined, 60_000, healthCheckOverride);
  t.after(async () => { await runtime.stop(); store.close(); });
  const follows = () => server.received.filter(message => message.method === "thread-stream-following-changed").map(message => (message.params as IpcObject).following);
  return { access, peerId, server, store, binding, desktop, chat, sent, edits, runtime, follows, advance: (ms = 30_001) => { now += ms; } };
}

test("restart recovery does not resume a turn still active in a UI owner", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-recovery-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const s = runtimeSetup(t, undefined, undefined, async () => "active");
  s.server.onFollow = () => s.server.snapshot();
  s.store.setValue(`task-details:${s.binding.id}`, { status: "running" });
  const intent = await captureRestartIntent(s.store, root, 1234);
  let inspected = false;
  s.desktop.inspectTask = async () => { inspected = true; throw new Error("Native resume must not run"); };
  await s.runtime.recoverRestartIntent(root);
  assert.equal(inspected, false);
  assert.equal(await readRestartIntent(root), null);
  assert.equal(s.store.inputSettled(JSON.stringify([s.peerId, `restart-recovery:${intent.id}:${s.binding.id}`])), false);
});

test("a slow native resume does not stall the bridge update or start duplicate subscriptions", async t => {
  let release!: () => void;
  const resumed = new Promise<void>(resolve => { release = resolve; });
  let subscriptions = 0;
  const transport: TaskStateTransport = {
    subscribe(task, onState) {
      subscriptions++;
      let closed = false;
      return {
        task,
        start: async () => { await resumed; if (!closed) onState(state([], "completed"), true); },
        verifyOwner: async () => { if (closed) throw new Error("closed"); },
        close: () => { closed = true; },
      };
    },
    close() {},
  };
  const s = runtimeSetup(t, undefined, transport);
  t.after(release);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge tick waited for native resume")), 250));
  await Promise.race([s.runtime.tick(false), timeout]);
  await s.runtime.tick(false);
  assert.equal(subscriptions, 1);
  release();
});

test("bridge publishes agent-initiated commentary without a user item or goal lookup", async t => {
  let publish!: (state: IpcObject, initial: boolean) => void;
  const transport: TaskStateTransport = {
    subscribe(task, onState) {
      publish = onState;
      return { task, start: async () => onState(state(), true), verifyOwner: async () => {}, close: () => {} };
    },
    close() {},
  };
  const s = runtimeSetup(t, undefined, transport);
  await s.runtime.tick();
  publish(state([{ type: "functionCallOutput", id: "agent-signal" },
    { type: "agentMessage", id: "signal-progress", phase: "commentary", text: "Agent-triggered progress" }]), false);
  s.advance(3_000);
  await s.runtime.tick();
  assert.ok(s.sent.some(item => item.view.text === "Agent-triggered progress"));
  assert.equal(s.sent.some(item => item.view.text.startsWith("## user request")), false);
});

test("bridge releases goal continuation commentary without inventing a user request", async t => {
  let publish!: (state: IpcObject, initial: boolean) => void;
  const transport: TaskStateTransport = {
    subscribe(task, onState) {
      publish = onState;
      return { task, start: async () => onState(state(), true), verifyOwner: async () => {}, close: () => {} };
    },
    close() {},
  };
  const goal: import("../src/desktop/contracts.js").TaskGoal = {
    threadId: ref.threadId, objective: "Finish the fixture", status: "active", tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
  };
  const s = runtimeSetup(t, undefined, transport, undefined, {
    get: async () => goal,
    set: async () => goal,
    clear: async () => true,
  });
  await s.runtime.tick();
  publish(state([{ type: "agentMessage", id: "goal-progress", phase: "commentary", text: "Autonomous progress" }]), false);
  s.advance(3_000);
  for (let attempt = 0; attempt < 20 && !s.sent.some(item => item.view.text === "Autonomous progress"); attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    await s.runtime.tick(false);
  }
  assert.ok(s.sent.some(item => item.view.text === "Autonomous progress"));
  assert.equal(s.sent.some(item => item.view.text.startsWith("## user request")), false);
});

test("bridge publishes direct app progress with no accessible rollout and explains a late input", async t => {
  let publish!: (state: IpcObject, initial: boolean) => void;
  const transport: TaskStateTransport = {
    subscribe(task, onState) {
      publish = onState;
      return { task, start: async () => onState(state(), true), verifyOwner: async () => {}, close: () => {} };
    },
    close() {},
  };
  const s = runtimeSetup(t, undefined, transport);
  await s.runtime.tick();
  publish(state([{ type: "agentMessage", id: "app-progress", phase: "commentary", text: "Direct app progress" }]), false);
  s.advance(3_000);
  for (let attempt = 0; attempt < 20 && !s.sent.some(item => item.view.text === "Direct app progress"); attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    await s.runtime.tick(false);
  }
  assert.ok(s.sent.some(item => item.view.text === "Direct app progress"));
  assert.equal(s.sent.some(item => item.view.text.startsWith("## user request")), false);
  publish(state([{ type: "userMessage", id: "different-native-id", content: [{ type: "text", text: "Continue the task" }] },
    { type: "agentMessage", id: "app-progress", phase: "commentary", text: "Direct app progress" }]), false);
  await s.runtime.tick(false);
  assert.equal(s.sent.filter(item => item.view.text === "Вход этого хода:\n\nContinue the task").length, 1);
});

test("rollout fallback publishes commentary without knowing the initiation source", async t => {
  const turnId = "goal-turn";
  let polled = false;
  const history: TaskHistoryRecovery = {
    enable() {}, disable() {},
    async poll() {
      if (polled) return null;
      polled = true;
      return { events: [{ type: "progress" as const, id: "goal-progress", turnId, text: "Fallback progress" }],
        historyRebuilt: false, checkpoint: { since: 100_000, activeAtAttach: [], active: [], seen: {} }, failure: null };
    },
  };
  const s = runtimeSetup(t, undefined, undefined, undefined, undefined, history);
  s.store.setValue(`task-details:${s.binding.id}`, { title: "Fixture", status: "running", workspace: "/fixture",
    model: null, effort: null, nextModel: null, nextEffort: null, context: null });
  await (s.runtime as unknown as { mirrorRolloutFallback(binding: Binding): Promise<void> })
    .mirrorRolloutFallback(s.store.getBinding(s.binding.id)!);
  s.advance(3_000);
  await s.runtime.tick();
  for (let attempt = 0; attempt < 20 && !s.sent.some(item => item.view.text === "Fallback progress"); attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(s.sent.some(item => item.view.text === "Fallback progress"));
});

const rolloutFinal = (timestamp: number, id: string, turnId: string, text: string) => JSON.stringify({
  timestamp: new Date(timestamp).toISOString(), type: "response_item",
  payload: { type: "message", id, role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } },
}) + "\n";

test("rollout fallback catches a final written between stream failure and the first poll", async t => {
  const s = runtimeSetup(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-fallback-"));
  const rolloutPath = path.join(root, "rollout.jsonl");
  await writeFile(rolloutPath, rolloutFinal(80_000, "old-final", "old-turn", "Old answer"));
  const binding = s.store.ensureBinding({ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1, rolloutPath });
  s.store.setValue(`task-details:${binding.id}`, {
    title: "Fixture", status: "failed", failure: "systemError", workspace: "/fixture",
    model: "gpt-5.6-sol", effort: "high", nextModel: "gpt-5.6-sol", nextEffort: "high", context: null,
  });
  const fallback = s.runtime as unknown as {
    enableRolloutFallback(binding: Binding): void;
    mirrorRolloutFallback(binding: Binding): Promise<void>;
  };
  fallback.enableRolloutFallback(binding); // Stream fails at 100_000.
  await appendFile(rolloutPath, rolloutFinal(101_000, "new-final", "new-turn", "Recovered answer"));
  s.advance(2_000); // First disk poll happens after the final was written.
  await fallback.mirrorRolloutFallback(binding);
  const deliveries = s.store.pendingDeliveries().map(delivery => delivery.view.text);
  assert.ok(deliveries.some(text => text.includes("Recovered answer")));
  assert.ok(deliveries.every(text => !text.includes("Old answer")));
  const details = s.store.getValue<{ status: string; failure?: string }>(`task-details:${binding.id}`);
  assert.equal(details?.status, "idle");
  assert.equal(details?.failure, undefined);
});

test("rollout fallback recovers an accepted VK turn that finished before reconnection", async t => {
  const s = runtimeSetup(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-fallback-"));
  const rolloutPath = path.join(root, "rollout.jsonl");
  await writeFile(rolloutPath, rolloutFinal(80_000, "old-final", "old-turn", "Old answer")
    + rolloutFinal(95_000, "accepted-final", "accepted-turn", "Accepted answer"));
  const binding = s.store.ensureBinding({ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1, rolloutPath });
  s.store.recordOperation("accepted-operation", binding, "vk-inbox", binding.id, 90_000);
  s.store.finishOperation("accepted-operation", "accepted");
  s.store.rememberAcceptedTurn(binding.id, "accepted-turn", "accepted-operation");
  assert.equal(s.store.oldestAcceptedTurnAt(binding.id), 90_000);
  const fallback = s.runtime as unknown as {
    enableRolloutFallback(binding: Binding): void;
    mirrorRolloutFallback(binding: Binding): Promise<void>;
  };
  fallback.enableRolloutFallback(binding); // Fresh process only notices the failure at 100_000.
  await fallback.mirrorRolloutFallback(binding);
  const deliveries = s.store.pendingDeliveries().map(delivery => delivery.view.text);
  assert.ok(deliveries.some(text => text.includes("Accepted answer")));
  assert.ok(deliveries.every(text => !text.includes("Old answer")));
  assert.deepEqual(s.store.acceptedTurns(binding.id), []);
});

test("rollout fallback rebases a rebuilt branch and resumes new events without replay", async t => {
  const s = runtimeSetup(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-fallback-"));
  const originalPath = path.join(root, "original.jsonl");
  const rebuiltPath = path.join(root, "rebuilt.jsonl");
  await writeFile(rebuiltPath, rolloutFinal(101_000, "rewritten-final", "rewritten-turn", "Previously delivered answer")
    + rolloutFinal(102_000, "accepted-final", "accepted-turn", "New accepted answer")
    + rolloutFinal(103_000, "direct-final", "direct-turn", "New direct answer during rebase"));
  const binding = s.store.ensureBinding({ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1, rolloutPath: rebuiltPath });
  s.store.setValue(`projection:${binding.id}`, {
    since: 80_000, lastObservedAt: 90_000, activeAtAttach: [],
    // The rebuilt branch repeats this previously projected turn under the
    // same item identity. A later direct turn must still cross the rebase.
    seen: { '["rewritten-turn","final","rewritten-final"]': "known" }, semanticByIdentity: {}, rolloutPath: originalPath,
  });
  s.store.recordOperation("accepted-operation", binding, "vk-inbox", binding.id, 95_000);
  s.store.finishOperation("accepted-operation", "accepted");
  s.store.rememberAcceptedTurn(binding.id, "accepted-turn", "accepted-operation");
  const fallback = s.runtime as unknown as {
    enableRolloutFallback(binding: Binding): void;
    mirrorRolloutFallback(binding: Binding): Promise<void>;
  };
  fallback.enableRolloutFallback(binding);
  s.advance(3_000);
  await fallback.mirrorRolloutFallback(binding);
  const deliveries = s.store.pendingDeliveries().map(delivery => delivery.view.text);
  assert.ok(deliveries.every(text => !text.includes("Previously delivered answer")));
  assert.ok(deliveries.some(text => text.includes("New accepted answer")));
  assert.ok(deliveries.some(text => text.includes("New direct answer during rebase")));
  assert.deepEqual(s.store.acceptedTurns(binding.id), []);
  assert.equal(s.store.getValue(`rollout-failure:${binding.id}`), null);
  assert.equal(s.store.getValue<{ rolloutPath?: string }>(`projection:${binding.id}`)?.rolloutPath, comparablePath(rebuiltPath));

  await appendFile(rebuiltPath, rolloutFinal(106_000, "new-direct-final", "new-direct-turn", "New direct answer"));
  s.advance(1_001);
  await fallback.mirrorRolloutFallback(binding);
  assert.ok(s.store.pendingDeliveries().some(delivery => delivery.view.text.includes("New direct answer")));
});

test("rollout fallback reports an oversized record and recovers after the file is corrected", async t => {
  const s = runtimeSetup(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-fallback-"));
  const rolloutPath = path.join(root, "rollout.jsonl");
  await writeFile(rolloutPath, rolloutFinal(101_000, "large", "turn", "x".repeat(1024)));
  const binding = s.store.ensureBinding({ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1, rolloutPath });
  const fallback = s.runtime as unknown as {
    historyRecovery: TaskHistoryRecovery;
    enableRolloutFallback(binding: Binding): void;
    mirrorRolloutFallback(binding: Binding): Promise<void>;
  };
  fallback.historyRecovery = new RolloutTaskHistoryRecovery(new RolloutTailer(128, 128, 300));
  fallback.enableRolloutFallback(binding);
  for (let attempt = 0; attempt < 4; attempt++) { await fallback.mirrorRolloutFallback(binding); s.advance(1_001); }
  assert.equal(s.store.getValue<{ kind: string }>(`rollout-failure:${binding.id}`)?.kind, "recordTooLarge");
  await writeFile(rolloutPath, rolloutFinal(102_000, "fixed", "turn", "Recovered"));
  for (let attempt = 0; attempt < 3; attempt++) { await fallback.mirrorRolloutFallback(binding); s.advance(1_001); }
  assert.equal(s.store.getValue(`rollout-failure:${binding.id}`), null);
  assert.ok(s.store.pendingDeliveries().some(delivery => delivery.view.text.includes("Recovered")));
});

test("a transferred binding never replays copied history from its old fallback epoch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-fallback-"));
  const rolloutPath = path.join(root, "target.jsonl");
  await writeFile(rolloutPath, rolloutFinal(101_000, "copied", "source-turn", "Copied source answer")
    + rolloutFinal(111_000, "new", "target-turn", "New target answer"));
  const recovery = new RolloutTaskHistoryRecovery();
  recovery.enable("stable-vk-binding", 90_000); // In-memory source boundary.
  const checkpoint = { since: 105_000, lastObservedAt: 105_000, activeAtAttach: [], seen: {},
    rolloutPath: comparablePath(rolloutPath) };
  const result = await recovery.poll("stable-vk-binding", { ...ref, rolloutPath }, checkpoint,
    null, new Set(), 115_000);
  assert.deepEqual(result?.events.filter(event => event.type === "final").map(event => event.text), ["New target answer"]);
});

test("runtime reconciles an uncertain prompt from Codex history after restart", async t => {
  const s = runtimeSetup(t);
  const operationId = "recovered-vk-operation";
  const inboxKey = JSON.stringify([s.peerId, "message:123"]);
  s.store.claimInput(inboxKey);
  s.store.recordOperation(operationId, s.binding, inboxKey, s.binding.id);
  s.store.finishOperation(operationId, "uncertain");
  s.store.finishInput(inboxKey, true);
  s.desktop.findAcceptedInput = async (_task, id) => id === operationId ? "native-turn" : null;
  (s.runtime as unknown as { reconcileUncertainOperation(): void }).reconcileUncertainOperation();
  for (let i = 0; i < 100 && s.store.operationState(operationId) !== "accepted"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.store.operationState(operationId), "accepted");
  assert.equal(s.store.inputState(inboxKey), "done");
  assert.deepEqual(s.store.acceptedTurns(s.binding.id), [{ turnId: "native-turn", operationId }]);
  assert.match(s.store.pendingDeliveries().at(-1)!.view.text, /Codex подтвердил ранее неопределённый запрос/u);
});

test("runtime follows a native queued request into its actual Codex turn", async t => {
  const s = runtimeSetup(t);
  const operationId = "native-queued-operation";
  s.store.recordOperation(operationId, s.binding, "vk-inbox", s.binding.id, 90_000);
  s.store.finishOperation(operationId, "accepted");
  s.store.rememberQueuedInput(s.binding.id, operationId, "native-queue-id", 90_000);
  await s.runtime.tick();
  assert.equal(s.store.queuedInputs(s.binding.id).length, 1);

  s.server.dataState = state([{ type: "userMessage", id: "queued-user", clientId: operationId,
    content: [{ type: "text", text: "Queued request" }] }]);
  s.server.snapshot();
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(s.store.queuedInputs(s.binding.id), []);
  assert.deepEqual(s.store.acceptedTurns(s.binding.id), [{ turnId: "fixture-turn", operationId }]);
});

test("bridge core consumes task state through a transport without Desktop IPC", async t => {
  const transport = new FakeStateTransport(state([{ id: "progress", type: "agentMessage", phase: "commentary", text: "Working" }]));
  const s = runtimeSetup(t, undefined, transport);
  await s.runtime.tick();
  assert.equal(transport.subscriptions, 1);
  assert.equal(s.server.received.length, 0);
  assert.match(s.sent.at(-1)!.view.text, /^думаю\.\.\. · обновлено/u);
  await s.runtime.stop();
  assert.equal(transport.closed, true);
});

test("task observation normalizes client snapshots for the bridge core", () => {
  const snapshot = { ...state([{ type: "userMessage", id: "user", clientId: "vk-operation",
    content: [{ type: "text", text: "Fixture prompt" }] }]), requests: [questionRequest] };
  const observed = observeTaskState(snapshot, null, 200);
  assert.deepEqual(observed.inputs, [{ turnId: "fixture-turn", status: "inProgress", operationIds: ["vk-operation"] }]);
  assert.equal(observed.details.status, "approval");
  assert.equal(observed.activeTurnId, "fixture-turn");
  assert.equal(observed.latestTurnId, "fixture-turn");
  assert.equal(observed.questions.length, 1);
  assert.equal(observed.checkpoint.since, 200);
});

test("task state connections classify one start failure only once", async () => {
  const failure = new Error("fixture disconnect");
  let closed = 0;
  const transport: TaskStateTransport = {
    subscribe: (task, _onState, onError) => ({
      task,
      start: async () => { onError(failure); throw failure; },
      verifyOwner: async () => {},
      close: () => { closed++; },
    }),
    close: () => {},
  };
  const connections = new TaskStateConnections(transport, () => 100);
  const failures: Error[] = [];
  await connections.connect("binding", ref, () => {}, result => failures.push(result.error));
  assert.deepEqual(failures, [failure]);
  assert.equal(connections.has("binding"), false);
  assert.equal(closed, 1);
  await connections.stop();
});

test("task state connections ignore snapshots from a replaced generation", async () => {
  const snapshots: ((state: IpcObject, initial: boolean) => void)[] = [];
  const transport: TaskStateTransport = {
    subscribe: (task, onState) => {
      snapshots.push(onState);
      return { task, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
    },
    close: () => {},
  };
  const connections = new TaskStateConnections(transport, () => 100);
  const observed: string[] = [];
  await connections.connect("binding", ref, value => observed.push(String(value.generation)), () => {});
  const replacement = { ...ref, threadId: "replacement-task" };
  await connections.connect("binding", replacement, value => observed.push(String(value.generation)), () => {});
  snapshots[0]!({ generation: "old" }, false);
  snapshots[1]!({ generation: "current" }, false);
  assert.deepEqual(observed, ["current"]);
  assert.equal(connections.matches("binding", replacement), true);
  await connections.stop();
});

test("a rejected scheduled health report cannot terminate the runtime", async t => {
  let checks = 0;
  const s = runtimeSetup(t, async () => {
    checks++;
    throw new Error("fixture health writer failure");
  });
  s.runtime.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  const initialChecks = checks;
  assert.ok(initialChecks >= 1);

  s.advance(60_001);
  await s.runtime.tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(checks > initialChecks);
});

test("health keeps checking while the initial task subscription is still pending", async t => {
  let checks = 0;
  const s = runtimeSetup(t, async () => {
    checks++;
    throw new Error("fixture health writer failure");
  });
  s.server.onFollow = () => {}; // The owner does not deliver its initial snapshot.
  s.runtime.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(s.follows().includes(true));
  const initialChecks = checks;
  assert.ok(initialChecks >= 1, "health reports even while native resume is pending");
  let settled = false;
  s.advance(60_001);
  void s.runtime.tick().then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok(checks > initialChecks);
});

test("reconnection shares one catalog read across subscriptions and starts them concurrently", async t => {
  const s = runtimeSetup(t);
  const tasks = [{ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }];
  for (let index = 1; index <= 2; index++) {
    const task = { ...ref, threadId: `fixture-task-${index}`, title: `Fixture ${index}`, workspace: "/fixture", updatedAt: 1 };
    tasks.push(task);
    const binding = s.store.ensureBinding(task);
    s.store.setChat(binding.id, s.peerId + index, 17 + index);
  }
  let catalogReads = 0;
  s.desktop.listTasks = async () => { catalogReads++; return tasks; };
  s.server.onFollow = () => {}; // All three owners are slow to provide a snapshot.
  const pending = s.runtime.tick();
  for (let attempt = 0; attempt < 100 && s.follows().filter(Boolean).length < 3; attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  // Panels and health may each read the catalog independently; the reconnect
  // batch itself must not add one read per attached conversation.
  assert.ok(catalogReads <= 3, `Too many catalog reads: ${catalogReads}`);
  assert.equal(s.follows().filter(Boolean).length, 3);
  await pending;
});

test("a stalled VK send does not hold up task reconciliation", async t => {
  const s = runtimeSetup(t);
  let release!: () => void;
  let sending = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  s.chat.send = async peerId => { sending = true; await gate; return { peerId, conversationMessageId: 1 }; };
  s.store.enqueue("stalled-vk-send", s.peerId, { text: "Fixture reply" }, s.binding.id);
  try {
    await Promise.race([
      s.runtime.tick(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("VK send blocked runtime update")), 200)),
    ]);
    assert.equal(sending, true);
  } finally { release(); }
});

test("IPC decoding accepts fragmented headers and multiple frames without trusting frame lengths", () => {
  const decoder = new FrameDecoder(); const one = encodeFrame({ type: "one" }); const two = encodeFrame({ type: "two" });
  assert.deepEqual(decoder.push(one.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(Buffer.concat([one.subarray(2), two])), [{ type: "one" }, { type: "two" }]);
  const huge = Buffer.alloc(4); huge.writeUInt32LE(256 * 1024 * 1024 + 1);
  assert.throws(() => new FrameDecoder().push(huge), /256 МиБ/u);
  assert.throws(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 0])), /размер/u);
  const invalid = Buffer.from("[]"); const header = Buffer.alloc(4); header.writeUInt32LE(invalid.length);
  assert.throws(() => new FrameDecoder().push(Buffer.concat([header, invalid])), /Invalid IPC frame/u);
});

test("IPC decoding accepts large UTF-8 frames in chunks and continues with the next frame", () => {
  const text = "я".repeat(5 * 1024 * 1024) + "end";
  const payload = Buffer.from(JSON.stringify({ text })); const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  // Construct the desktop's wire frame independently of the bridge's encoder.
  const input = Buffer.concat([header, payload, encodeFrame({ type: "after-large-frame" })]);
  const decoder = new FrameDecoder(); const messages: IpcObject[] = [];
  for (let offset = 0; offset < input.length; offset += 65_537) messages.push(...decoder.push(input.subarray(offset, offset + 65_537)));
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.text, text);
  assert.deepEqual(messages[1], { type: "after-large-frame" });
});

test("runtime connects a large task and mirrors progress without forwarding tool output", async t => {
  const s = runtimeSetup(t);
  s.server.dataState = state([
    { id: "prompt", type: "userMessage", content: [{ type: "text", text: "Inspect this task" }] },
    { id: "command", type: "commandExecution", output: "x".repeat(24 * 1024 * 1024) },
    { id: "old-progress", type: "agentMessage", phase: "commentary", text: "Progress before connecting" },
  ]);
  await s.runtime.tick();
  assert.deepEqual(s.follows(), [true]);
  assert.equal(s.server.destroyed, false);
  assert.match(s.sent[0]!.view.text, /^думаю\.\.\. · обновлено \d{2}:\d{2}:\d{2}$/u);
  s.server.send({ type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: "owner", targetClientIds: ["bridge-client"], params: {
    hostId: ref.hostId, conversationId: ref.threadId, change: { type: "patches", baseRevision: 1, revision: 2, patches: [
      { op: "add", path: ["turnHistory", "history", "entitiesByKey", "tail", "items", 3], value: { id: "progress", type: "agentMessage", phase: "commentary", text: "Progress after connecting" } },
    ] },
  } });
  await new Promise(resolve => setImmediate(resolve));
  await s.runtime.tick();
  assert.equal(s.sent.at(-2)!.view.text, "Progress after connecting");
  assert.match(s.sent.at(-1)!.view.text, /^думаю\.\.\. · обновлено \d{2}:\d{2}:\d{2}$/u);
});

test("runtime reports the actual connection failure without leaking malformed IPC contents", async t => {
  const s = runtimeSetup(t);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(256 * 1024 * 1024 + 1);
  s.server.onFollow = () => s.server.push(oversized);
  await s.runtime.tick();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0]!.view.text, /256 МиБ/u);
  assert.doesNotMatch(s.sent[0]!.view.text, /Открой её/u);

  const broken = new Server(); const client = new DesktopIpcClient(() => broken, 50); t.after(() => client.close());
  const content = Buffer.from('{"private-data"'); const header = Buffer.alloc(4); header.writeUInt32LE(content.length);
  broken.onFollow = () => broken.push(Buffer.concat([header, content]));
  const subscription = new TaskSubscription(client, ref, () => assert.fail("Malformed state accepted"), () => {});
  await assert.rejects(subscription.start(100), error => error instanceof DesktopUnavailableError && /прочитать/u.test(error.message) && !error.message.includes("private-data"));
});

test("runtime silently retries desktop discovery while a task owner is loading", async t => {
  const s = runtimeSetup(t); s.server.rejectDiscovery = true;
  s.store.setValue(`task-details:${s.binding.id}`, { status: "running", workspace: "/fixture", model: null, effort: null, nextModel: null, nextEffort: null, context: null });
  await s.runtime.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.store.getBinding(s.binding.id)!.attached, true);
  assert.equal(s.store.getValue<{ status: string }>(`task-details:${s.binding.id}`)!.status, "unavailable");
  assert.equal(s.server.received.filter(message => message.method === "thread-owner-discovery").length, 1);

  s.advance(5_001); await s.runtime.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.server.received.filter(message => message.method === "thread-owner-discovery").length, 2);
});

test("runtime animates an active task between desktop events and stops when its turn completes", async t => {
  const s = runtimeSetup(t); await s.runtime.tick();
  s.advance(20_000); await s.runtime.tick();
  assert.match(s.edits.at(-1)!.view.text, /^думаю\.\. · обновлено \d{2}:\d{2}:\d{2}$/u);
  s.server.dataState = state([], "completed"); s.server.snapshot();
  await new Promise(resolve => setImmediate(resolve)); s.advance(3_000); await s.runtime.tick();
  assert.equal(s.edits.at(-1)!.view.text, "Готово.");
  const count = s.edits.length; s.advance(); await s.runtime.tick(); assert.equal(s.edits.length, count);
});

test("revision patches apply atomically and reject gaps, invalid paths, and prototype pollution", () => {
  const revision = new RevisionedState();
  revision.accept({ type: "snapshot", revision: 1, conversationState: { rows: [{ text: "a" }] } });
  revision.accept({ type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace", path: ["rows", 0, "text"], value: "b" }, { op: "add", path: ["rows", 1], value: { text: "c" } }] });
  assert.deepEqual(revision.current, { rows: [{ text: "b" }, { text: "c" }] });
  assert.throws(() => revision.accept({ type: "patches", baseRevision: 1, revision: 3, patches: [] }), /gap/u);
  assert.throws(() => revision.accept({ type: "patches", baseRevision: 2, revision: 3, patches: [{ op: "replace", path: ["rows", 0, "text"], value: "corrupt" }, { op: "add", path: ["__proto__", "polluted"], value: true }] }));
  assert.equal(revision.currentRevision, 2); assert.deepEqual(revision.current, { rows: [{ text: "b" }, { text: "c" }] });
  assert.equal(Object.hasOwn({}, "polluted"), false);
});

test("subscription uses honest client registration and filters other tasks and owners", async t => {
  const server = new Server(); const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  let updates = 0;
  const subscription = new TaskSubscription(client, ref, () => { updates++; }, () => {});
  server.onFollow = () => { server.snapshot(11, "other-owner"); server.snapshot(11, "owner", "other-task"); server.snapshot(); };
  await subscription.start(100); assert.equal(updates, 1);
  assert.deepEqual(server.received[0]!.params, { clientType: "vkodex" });
  subscription.close();
  assert.ok(server.received.some(message => message.method === "thread-stream-following-changed" && isObject(message.params) && message.params.following === false));
});

test("runtime rediscovers a replaced owner on a surviving IPC broker and recovers only its final", async t => {
  const s = runtimeSetup(t);
  s.server.dataState = state([{ id: "old-progress", type: "agentMessage", phase: "commentary", text: "Old progress" }]);
  await s.runtime.tick();
  s.server.ownerId = "replacement-owner";
  s.server.dataState = state([
    { id: "old-progress", type: "agentMessage", phase: "commentary", text: "Old progress" },
    { id: "final", type: "agentMessage", phase: "final_answer", text: "Recovered final" },
  ], "completed");
  s.advance(); await s.runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.server.destroyed, false);
  s.advance(5_001); await s.runtime.tick();
  assert.equal(s.store.getValue<{ status: string }>(`task-details:${s.binding.id}`)?.status, "idle");
  assert.equal(s.sent.filter(message => message.view.text.startsWith("Recovered final")).length, 1);
  assert.equal(s.sent.some(message => message.view.text === "Old progress"), false);
  // A delayed snapshot from the former owner cannot revive its running turn.
  s.server.dataState = state(); s.server.snapshot(11, "owner");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.store.getValue<{ status: string }>(`task-details:${s.binding.id}`)?.status, "idle");
  assert.equal(s.server.received.some(message => String(message.method).startsWith("thread-follower-")), false);
});

test("a missing owner stops the thinking indicator although the broker socket is still open", async t => {
  const s = runtimeSetup(t); await s.runtime.tick();
  s.server.rejectDiscovery = true;
  s.advance(); await s.runtime.tick();
  await new Promise(resolve => setImmediate(resolve));
  s.advance(1_000); await s.runtime.tick();
  assert.equal(s.server.destroyed, false);
  assert.equal(s.store.getValue<{ status: string }>(`activity:${s.binding.id}`)?.status, "unavailable");
  assert.equal(s.store.getValue<{ status: string }>(`task-details:${s.binding.id}`)?.status, "unavailable");
});

test("events from a closed IPC socket cannot close or corrupt the replacement connection", async t => {
  const old = new Server(); const next = new Server(); let connects = 0;
  const client = new DesktopIpcClient(() => connects++ === 0 ? old : next, 100); t.after(() => client.close());
  await client.connect(); client.close(); await client.connect();
  old.emit("data", Buffer.from([0, 0, 0, 0]));
  old.emit("error", new Error("late socket error"));
  const reply = await client.request("thread-owner-discovery", 1, { hostId: ref.hostId, conversationId: ref.threadId });
  assert.equal(reply.handledByClientId, "owner"); assert.equal(next.destroyed, false);
});

test("systemError overrides orphaned history, reports usage limits once and permits a new turn", async t => {
  const s = runtimeSetup(t); await s.runtime.tick();
  s.server.dataState = {
    id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "systemError" },
    turns: [
      { turnId: "orphan", turnStartedAtMs: 10, status: "inProgress", items: [] },
      { turnId: "fixture-turn", turnStartedAtMs: 100, status: "failed", items: [{ type: "error", errorInfo: "usageLimitExceeded", message: "PRIVATE ERROR SENTINEL" }] },
    ],
  };
  s.server.snapshot(); await new Promise(resolve => setImmediate(resolve)); await s.runtime.tick();
  const details = taskDetails(s.server.dataState);
  assert.equal(details.status, "failed"); assert.equal(details.failure, "usageLimit");
  assert.equal(s.store.getValue<{ status: string }>(`activity:${s.binding.id}`)?.status, "failed");
  s.server.snapshot(); await new Promise(resolve => setImmediate(resolve)); s.advance(); await s.runtime.tick();
  assert.equal(s.sent.filter(message => message.view.text.includes("исчерпан лимит")).length, 1);
  assert.equal(JSON.stringify(s.sent).includes("PRIVATE ERROR SENTINEL"), false);
  const server = new Server(); server.dataState = s.server.dataState;
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 100));
  await adapter.submit({ operationId: "retry", task, text: "Continue" });
  assert.equal(server.received.filter(message => message.method === "thread-follower-start-turn").length, 1);
  assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn"), false);
});

test("runtime waits for a delayed owner user item before mirroring its answer", async t => {
  const s = runtimeSetup(t);
  s.server.dataState = state();
  await s.runtime.tick();
  s.server.send({ type: "broadcast", method: "thread-stream-state-changed", version: 11,
    sourceClientId: "owner", targetClientIds: ["bridge-client"], params: {
      hostId: ref.hostId, conversationId: ref.threadId,
      change: { type: "patches", baseRevision: 1, revision: 2, patches: [
        { op: "add", path: ["turnHistory", "history", "entitiesByKey", "tail", "items", 0],
          value: { id: "early-answer", type: "agentMessage", phase: "commentary", text: "Answer first in snapshot" } },
      ] },
    } });
  await new Promise(resolve => setImmediate(resolve));
  await s.runtime.tick();
  assert.equal(s.sent.some(item => item.view.text === "Answer first in snapshot"), false);

  s.server.send({ type: "broadcast", method: "thread-stream-state-changed", version: 11,
    sourceClientId: "owner", targetClientIds: ["bridge-client"], params: {
      hostId: ref.hostId, conversationId: ref.threadId,
      change: { type: "patches", baseRevision: 2, revision: 3, patches: [
        { op: "add", path: ["turnHistory", "history", "entitiesByKey", "tail", "items", 0],
          value: { id: "late-input", type: "userMessage", content: [{ type: "text", text: "Original request" }] } },
      ] },
    } });
  await new Promise(resolve => setImmediate(resolve));
  await s.runtime.tick();
  assert.deepEqual(s.sent.map(item => item.view.text).filter(text => text.includes("Original request") || text.includes("Answer first")), [
    "## user request\n\nOriginal request", "Answer first in snapshot",
  ]);
});

test("server overload is reported separately from a generic Codex system error", () => {
  const details = taskDetails({
    id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "systemError" },
    turns: [{ turnId: "fixture-turn", turnStartedAtMs: 100, status: "failed",
      items: [{ type: "error", errorInfo: "server_overloaded", message: "PRIVATE CAPACITY DETAIL" }] }],
  });
  assert.equal(details.status, "failed");
  assert.equal(details.failure, "serverOverloaded");
});

test("first-turn creation output survives a runtime restart before its VK binding exists", async () => {
  const access = { ownerId: 101, groupId: 202 };
  const peerId = 2_000_000_017;
  const task: DesktopTask = { ...ref, title: "Created through VK", workspace: "/fixture", projectId: null, updatedAt: 1 };
  const listeners = new Set<(update: import("../src/desktop/contracts.js").TaskCreationUpdate) => void>();
  const creator: DesktopTaskCreator = {
    createTask: async () => task,
    interrupt: async () => false,
    details: () => null,
    isActive: () => false,
    onUpdate: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const desktop = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => new Server(), 100), undefined, undefined, undefined, { creator });
  const store = new BridgeStore();
  const sent: View[] = [];
  const chat: BridgeChat = {
    send: async (sentPeerId, view) => { assert.equal(sentPeerId, peerId); sent.push(view); return { peerId, conversationMessageId: sent.length }; },
    edit: async () => {}, delete: async () => {},
    createConversation: async () => { throw new Error("Unexpected chat creation"); },
    renameConversation: async () => { throw new Error("Unexpected chat rename"); },
    inviteLink: async () => { throw new Error("Unexpected invitation"); },
    uploadDocument: async () => { throw new Error("Unexpected upload"); },
  };
  const runtime1 = new DesktopBridgeRuntime(access, desktop, chat, store,
    runtimeAdapters(new DesktopTaskStateTransport(new DesktopIpcClient(() => new Server(), 100))));
  const update = { task, event: { type: "final" as const, id: "creation-final", turnId: "creation-turn", text: "Durable first answer" },
    details: { status: "idle" as const, workspace: "/fixture", model: "model-a", effort: "high", nextModel: null, nextEffort: null, context: null } };
  for (const listener of listeners) listener(update);
  assert.equal(store.pendingCreation(task).length, 1);
  await runtime1.stop();

  const binding = store.ensureBinding(task); store.setChat(binding.id, peerId, 17);
  const server = new Server(); server.dataState = { ...state([], "completed"), threadRuntimeStatus: { type: "idle" } };
  const runtime2 = new DesktopBridgeRuntime(access, desktop, chat, store,
    runtimeAdapters(new DesktopTaskStateTransport(new DesktopIpcClient(() => server, 100))));
  try {
    await runtime2.tick();
    assert.ok(sent.some(view => view.text.includes("Durable first answer")));
    assert.equal(store.pendingCreation(task).length, 0);
  } finally {
    await runtime2.stop(); store.close();
  }
});

test("a transient command subscription cannot disable the durable task stream when it closes", async t => {
  const server = new Server(); const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, ref, () => {}, () => {}, false);
  server.onFollow = () => server.snapshot();
  await subscription.start(100); subscription.close();
  const follows = server.received.filter(message => message.method === "thread-stream-following-changed")
    .map(message => (message.params as IpcObject).following);
  assert.deepEqual(follows, [true]);
});

test("closing a subscription during connection, discovery or its first snapshot cannot reopen it", async t => {
  for (const phase of ["connect", "discovery", "snapshot"]) {
    const server = new Server(); const client = new DesktopIpcClient(() => server, 100);
    t.after(() => client.close());
    const subscription = new TaskSubscription(client, ref, () => assert.fail("Cancelled subscription delivered state"), () => assert.fail("Explicit cancellation is not a disconnection"));
    if (phase === "discovery") server.onDiscovery = () => subscription.close();
    if (phase === "snapshot") server.onFollow = () => subscription.close();
    const starting = subscription.start(1_000);
    if (phase === "connect") subscription.close();
    await assert.rejects(starting, /отменена/u);
    server.snapshot();
    await new Promise(resolve => setImmediate(resolve));
    const follows = server.received.filter(message => message.method === "thread-stream-following-changed").map(message => (message.params as IpcObject).following);
    assert.deepEqual(follows, phase === "snapshot" ? [true, false] : []);
  }
});

test("periodic ticks keep an attached task subscribed", async t => {
  const s = runtimeSetup(t);
  await s.runtime.tick();
  s.advance(); await s.runtime.tick();
  assert.equal(s.store.getBinding(s.binding.id)!.attached, true);
  assert.deepEqual(s.follows(), [true]);
});

test("runtime clears a legacy privacy pause without checking membership", async t => {
  const s = runtimeSetup(t);
  s.store.setPaused(s.binding.id, true);
  await s.runtime.tick();
  assert.equal(s.store.getBinding(s.binding.id)!.paused, false);
  assert.deepEqual(s.follows(), [true]);
});

test("unsupported stream version fails closed without silently accepting state", async t => {
  const server = new Server(); const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  server.onFollow = () => server.snapshot(999);
  const subscription = new TaskSubscription(client, ref, () => assert.fail("Unsupported state was delivered"), () => {});
  await assert.rejects(subscription.start(100), /Версия событий/u);
});

test("a source-bound subscription rejects a different rollout before exposing any events", async t => {
  const server = new Server(); server.dataState = { ...state(), rolloutPath: "C:/profiles/primary/sessions/task.jsonl" };
  const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, { ...ref, sourceId: "work", rolloutPath: "C:/profiles/work/sessions/task.jsonl" }, () => assert.fail("Wrong-source events leaked"), () => {});
  await assert.rejects(subscription.start(100), /другой копии/u);
  assert.equal(server.received.some(message => ["thread-follower-start-turn", "thread-follower-steer-turn"].includes(String(message.method))), false);
});

test("source matching accepts equivalent Windows paths and rejects unknown rollout locations", async () => {
  const server = new Server(); server.dataState = { ...state(), rolloutPath: "\\\\?\\C:\\Profiles\\WORK\\sessions\\task.jsonl" };
  const client = new DesktopIpcClient(() => server, 50);
  const subscription = new TaskSubscription(client, { ...ref, sourceId: "work", rolloutPath: "c:/profiles/work/sessions/task.jsonl" }, () => {}, () => {});
  try { await subscription.start(100); assert.ok(subscription.current); } finally { subscription.close(); client.close(); }
  const unavailable = new Server(); const otherClient = new DesktopIpcClient(() => unavailable, 50);
  const withoutPath = new TaskSubscription(otherClient, { ...ref, sourceId: "work" }, () => assert.fail("Unverified source"), () => {});
  try { await assert.rejects(withoutPath.start(100), /путь её истории/u); } finally { withoutPath.close(); otherClient.close(); }
});

test("source matching accepts a new rollout file for the same thread and CODEX_HOME", async t => {
  const selected = "C:/Users/test/.codex/sessions/2026/08/29/rollout-thread.jsonl";
  const live = "C:/Users/test/.codex/sessions/2026/08/29/rollout-thread_continuation.jsonl";
  const server = new Server(); server.dataState = { ...state(), rolloutPath: live }; let updates = 0;
  const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, { ...ref, rolloutPath: selected }, () => { updates++; }, () => {});
  try {
    await subscription.start(100);
    assert.equal(updates, 1);
    assert.equal(subscription.current?.rolloutPath, live);
  } finally { subscription.close(); }
});

test("source matching accepts active and archived rollouts from the same CODEX_HOME", async t => {
  const selected = "C:/Users/test/.codex/archived_sessions/rollout-thread.jsonl";
  const live = "C:/Users/test/.codex/sessions/2026/08/29/rollout-thread.jsonl";
  const server = new Server(); server.dataState = { ...state(), rolloutPath: live };
  const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, { ...ref, rolloutPath: selected }, () => {}, () => {});
  try { await subscription.start(100); assert.ok(subscription.current); } finally { subscription.close(); }
});

test("a transient pathless snapshot refreshes once before accepting the selected task copy", async t => {
  const expected = "C:/profiles/work/sessions/task.jsonl";
  const server = new Server(); let follows = 0; let updates = 0;
  server.dataState = { ...state() };
  server.onFollow = () => {
    follows++;
    if (follows === 2) server.dataState = { ...server.dataState, rolloutPath: "\\\\?\\C:\\Profiles\\WORK\\sessions\\task.jsonl" };
    server.snapshot();
  };
  const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, { ...ref, sourceId: "work", rolloutPath: expected }, () => { updates++; }, () => {});
  try {
    await subscription.start(100);
    assert.equal(follows, 2); assert.equal(updates, 1);
    assert.equal(subscription.current?.rolloutPath, "\\\\?\\C:\\Profiles\\WORK\\sessions\\task.jsonl");
  } finally { subscription.close(); }
});

test("a transient mismatched snapshot is never exposed and refreshes to the selected task copy", async t => {
  const expected = "C:/profiles/work/sessions/task.jsonl";
  const server = new Server(); let follows = 0; let updates = 0;
  server.dataState = { ...state(), rolloutPath: "C:/profiles/other/sessions/task.jsonl" };
  server.onFollow = () => {
    follows++;
    if (follows === 2) server.dataState = { ...server.dataState, rolloutPath: expected };
    server.snapshot();
  };
  const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, { ...ref, sourceId: "work", rolloutPath: expected }, () => { updates++; }, () => {});
  try {
    await subscription.start(100);
    assert.equal(follows, 2); assert.equal(updates, 1);
    assert.equal(subscription.current?.rolloutPath, expected);
  } finally { subscription.close(); }
});

test("a verified subscription tolerates a reduced rename snapshot without changing task identity", async t => {
  const expected = "C:/profiles/work/sessions/task.jsonl";
  const server = new Server(); server.dataState = { ...state(), rolloutPath: expected }; let updates = 0;
  const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, { ...ref, sourceId: "work", rolloutPath: expected }, () => { updates++; }, () => {});
  try {
    await subscription.start(100);
    server.dataState = { ...server.dataState }; delete server.dataState.rolloutPath; server.snapshot();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updates, 2);
    assert.equal(server.received.filter(message => message.method === "thread-stream-following-changed" && isObject(message.params) && message.params.following === true).length, 1);
  } finally { subscription.close(); }
});

test("a task copy that never reports its rollout path remains blocked", async t => {
  const server = new Server(); server.dataState = { ...state() }; let follows = 0;
  server.onFollow = () => { follows++; server.snapshot(); };
  const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  const subscription = new TaskSubscription(client, { ...ref, sourceId: "work", rolloutPath: "C:/profiles/work/sessions/task.jsonl" }, () => assert.fail("Unverified source leaked"), () => {});
  try {
    await assert.rejects(subscription.start(50), /не сообщил путь истории/u);
    assert.equal(follows, 2);
  } finally { subscription.close(); }
});

test("duplicate IDs route by source and never send into the other loaded copy", async () => {
  const primary = { ...ref, title: "Primary", workspace: "/project-a", updatedAt: 1, rolloutPath: "C:/profiles/primary/task.jsonl" };
  const extra = { ...primary, sourceId: "work", title: "Work", workspace: "/project-b", rolloutPath: "C:/profiles/work/task.jsonl" };
  for (const selected of [primary, extra]) {
    const server = new Server(); server.dataState = { ...state(), rolloutPath: extra.rolloutPath };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [primary, extra], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
    const request = adapter.submit({ task: selected, operationId: "fixture-operation", text: "Follow up" });
    if (selected === primary) await assert.rejects(request, /другой копии/u); else await request;
    assert.equal(server.received.filter(message => message.method === "thread-follower-steer-turn").length, selected === extra ? 1 : 0);
  }
});

test("revision gap requests a fresh snapshot instead of continuing a corrupted stream", async t => {
  const server = new Server(); const client = new DesktopIpcClient(() => server, 50); t.after(() => client.close());
  let updates = 0; const subscription = new TaskSubscription(client, ref, () => { updates++; }, () => {});
  await subscription.start(100);
  server.send({ type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: "owner", targetClientIds: ["bridge-client"], params: { hostId: "local", conversationId: ref.threadId, change: { type: "patches", baseRevision: 900, revision: 901, patches: [] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates, 2);
  assert.equal(server.received.filter(message => message.method === "thread-stream-following-changed" && isObject(message.params) && message.params.following).length, 2);
  subscription.close();
});

test("timeouts and disconnected writes are uncertain and never retried by IPC", async t => {
  const server = new Server(); server.answerWrites = false;
  const client = new DesktopIpcClient(() => server, 10); t.after(() => client.close()); await client.connect();
  await assert.rejects(client.request("thread-follower-steer-turn", 1, {}, { mutating: true }), UncertainActionError);
  assert.equal(server.received.filter(message => message.method === "thread-follower-steer-turn").length, 1);
  const pending = client.request("thread-follower-steer-turn", 1, {}, { mutating: true }); client.close();
  await assert.rejects(pending, UncertainActionError);
});

test("active-task submit uses the existing task and inherits its model and permissions", async () => {
  const server = new Server();
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
  await adapter.submit({ operationId: "client-message-fixture", task: ref, text: "A follow-up", author: { id: 999, name: "Second User" } });
  const request = server.received.find(message => message.method === "thread-follower-steer-turn")!;
  assert.equal(request.targetClientId, "owner");
  assert.equal((request.params as IpcObject).conversationId, ref.threadId);
  assert.equal((request.params as IpcObject).clientUserMessageId, "client-message-fixture");
  const attributed = ((request.params as IpcObject).input as IpcObject[])[0]!.text;
  assert.match(String(attributed), /VK author: "Second User"/u); assert.match(String(attributed), /VK sender ID: 999/u);
  assert.match(String(attributed), /# User request\nA follow-up/u);
  assert.match(String(attributed), /Не используй Markdown-таблицы/u);
  assert.match(String(attributed), /Если последним станет запрос, отправленный напрямую через Codex.*полностью игнорируй/u);
  for (const forbidden of ["model", "approvalPolicy", "sandbox", "permissions", "serviceTier"]) assert.equal(Object.hasOwn(request.params as object, forbidden), false);
  assert.ok(server.destroyed);
});

test("desktop submits image and document attachments in both active and idle tasks", async () => {
  for (const status of ["inProgress", "completed"]) {
    const server = new Server(); server.dataState = state([], status);
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
    const imagePath = path.resolve("fixture-image.png"), filePath = path.resolve("fixture-notes.txt"), outboxDir = path.resolve("fixture-outbox");
    await adapter.submit({ task: ref, operationId: "files-fixture", text: "", outboxDir, inputFiles: [
      { path: imagePath, originalName: "image.png", kind: "image", sizeBytes: 1 },
      { path: filePath, originalName: "notes.txt", kind: "file", sizeBytes: 1 },
    ] });
    const request = server.received.find(message => message.method === (status === "inProgress" ? "thread-follower-steer-turn" : "thread-follower-start-turn"))!;
    const params = request.params as IpcObject;
    const input = (status === "inProgress" ? params.input : ((params.turnStart as IpcObject).request as IpcObject).input) as IpcObject[];
    assert.deepEqual(input[1], { type: "localImage", path: imagePath });
    assert.ok(String(input[0]!.text).includes(JSON.stringify(filePath))); assert.ok(String(input[0]!.text).includes(JSON.stringify(outboxDir)));
    if (status === "inProgress") assert.deepEqual(params.attachments, [{ label: "notes.txt", path: filePath, fsPath: filePath }]);
  }
});

test("desktop rechecks access immediately before forwarding a prepared request", async () => {
  const server = new Server(); const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
  await assert.rejects(adapter.submit({ task: ref, operationId: "fixture", text: "Text", beforeSend: async () => { throw new ActionRejectedError("Detached"); } }), /Detached/u);
  assert.equal(server.received.some(message => /thread-follower-(?:start|steer)-turn/u.test(String(message.method))), false);
});

test("model choice updates only next-turn model and effort through the actual owner", async () => {
  const server = new Server(); const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [], listModels: async () => [{ id: "fixture-model", title: "Fixture", efforts: ["high"], defaultEffort: "high" }] }, () => new DesktopIpcClient(() => server, 50));
  await adapter.selectModel(ref, "fixture-model", "high");
  const request = server.received.find(message => message.method === "thread-follower-update-thread-settings")!;
  assert.equal(request.targetClientId, "owner"); assert.equal(request.version, 2);
  assert.deepEqual(request.params, { conversationId: ref.threadId, threadSettings: { model: "fixture-model", effort: "high" } });
  assert.equal(server.received.filter(message => ["thread-follower-start-turn", "thread-follower-steer-turn"].includes(String(message.method))).length, 0);
  assert.ok(server.destroyed);
});

test("unavailable model/effort is rejected before IPC and malformed settings reply is uncertain", async () => {
  const server = new Server(); const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [], listModels: async () => [{ id: "fixture-model", title: "Fixture", efforts: ["high"], defaultEffort: "high" }] }, () => new DesktopIpcClient(() => server, 50));
  await assert.rejects(adapter.selectModel(ref, "unknown", "high"), ActionRejectedError);
  await assert.rejects(adapter.selectModel(ref, "fixture-model", "invalid"), ActionRejectedError);
  assert.equal(server.received.length, 0);
  server.settingsReply = {};
  await assert.rejects(adapter.selectModel(ref, "fixture-model", "high"), UncertainActionError);
  assert.equal(server.received.filter(message => message.method === "thread-follower-update-thread-settings").length, 1);
});

test("rename confirms the catalog and live title separately without executing a turn", async () => {
  for (const liveUpdate of [false, true]) {
    const server = new Server(); server.dataState = { ...state(), title: "Old title" };
    let task = { ...ref, title: "Old title", workspace: "/fixture", updatedAt: 1 }; let writes = 0;
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50), {
      rename: async (_ref, title) => {
        writes++; task = { ...task, title };
        if (liveUpdate) { server.dataState = { ...server.dataState, title }; server.snapshot(); }
      }, archive: async () => {}, markdown: async () => "", assignProject: async () => {},
    });
    assert.deepEqual(await adapter.renameTask(ref, "New title"), { liveTitleUpdated: liveUpdate });
    assert.equal(writes, 1);
    assert.equal(server.received.some(message => /turn|thread\/resume|thread\/start/u.test(String(message.method))), false);
  }
});

test("rename rejects an unconfirmed catalog or a mismatched source without changing another copy", async () => {
  for (const sourceMismatch of [false, true]) {
    const server = new Server(); server.dataState = { ...state(), title: "Old title", rolloutPath: "/primary/history.jsonl" };
    const task = { ...ref, title: "Old title", workspace: "/fixture", updatedAt: 1, rolloutPath: sourceMismatch ? "/extra/history.jsonl" : "/primary/history.jsonl" }; let writes = 0;
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50), {
      rename: async () => { writes++; }, archive: async () => {}, markdown: async () => "", assignProject: async () => {},
    });
    await assert.rejects(adapter.renameTask(task, "New title"));
    assert.equal(writes, sourceMismatch ? 0 : 1);
  }
});

test("metadata archive refuses an active desktop turn without invoking metadata or interruption", async () => {
  const server = new Server(); const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }; let archives = 0;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50), { rename: async () => {}, archive: async () => { archives++; }, markdown: async () => "", assignProject: async () => {} });
  await assert.rejects(adapter.archiveTask(ref), ActionRejectedError);
  assert.equal(archives, 0);
  assert.equal(server.received.some(message => String(message.method).includes("interrupt")), false);
});

test("interrupt targets the active desktop turn and requires a confirmed turn id", async () => {
  const server = new Server(); const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
  await adapter.interrupt(ref);
  const request = server.received.find(message => message.method === "thread-follower-interrupt-turn")!;
  assert.equal(request.version, 4); assert.equal(request.targetClientId, "owner");
  assert.deepEqual(request.params, { conversationId: ref.threadId, mode: "user-stop", expectedTurnId: "fixture-turn" });
});

test("model settings v2 refusal is rejected without retry or starting a turn", async () => {
  const server = new Server(); server.settingsReply = { applied: false };
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [], listModels: async () => [{ id: "fixture-model", title: "Fixture", efforts: ["high"], defaultEffort: "high" }] }, () => new DesktopIpcClient(() => server, 50));
  await assert.rejects(adapter.selectModel(ref, "fixture-model", "high"), ActionRejectedError);
  assert.equal(server.received.filter(message => message.method === "thread-follower-update-thread-settings").length, 1);
  assert.equal(server.received.some(message => /thread-follower-(?:start|steer)-turn/u.test(String(message.method))), false);
});

test("model settings fall back to v1 only after explicit pre-dispatch version rejection", async () => {
  for (const rejection of ["request-version-mismatch", "no-client-found"]) {
  const server = new Server(); server.settingsVersion = 1; server.settingsReply = { ok: true };
  server.settingsVersionError = rejection;
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [], listModels: async () => [{ id: "fixture-model", title: "Fixture", efforts: ["high"], defaultEffort: "high" }] }, () => new DesktopIpcClient(() => server, 50));
  await adapter.selectModel(ref, "fixture-model", "high");
  assert.deepEqual(server.received.filter(message => message.method === "thread-follower-update-thread-settings").map(message => message.version), [2, 1]);
  assert.equal(server.received.some(message => /thread-follower-(?:start|steer)-turn/u.test(String(message.method))), false);
  }
});

test("interrupt reaches a unique task when owner discovery works but snapshots are silent", async () => {
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const servers: Server[] = [];
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
    const server = new Server(); server.onFollow = () => {}; servers.push(server);
    return new DesktopIpcClient(() => server, 30);
  });
  await adapter.interrupt(ref);
  const requests = servers.flatMap(server => server.received).filter(message => message.method === "thread-follower-interrupt-turn");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.version, 3);
  assert.deepEqual(requests[0]!.params, { conversationId: ref.threadId, mode: "user-stop" });
});

test("snapshot-free interrupt refuses an ambiguous thread copied across catalogs", async () => {
  const primary = { ...ref, title: "Primary", workspace: "/fixture", updatedAt: 1 };
  const copy = { ...primary, sourceId: "work", title: "Work copy" };
  const servers: Server[] = [];
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [primary, copy], listProjects: async () => [] }, () => {
    const server = new Server(); server.onFollow = () => {}; servers.push(server);
    return new DesktopIpcClient(() => server, 30);
  });
  await assert.rejects(adapter.interrupt(primary), error => error instanceof ActionRejectedError && /копии/u.test(error.message));
  assert.equal(servers.flatMap(server => server.received).some(message => message.method === "thread-follower-interrupt-turn"), false);
});

function interruptSetup(replies: ("success" | "error" | "malformed-stopped")[]) {
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const servers: Server[] = []; const plan = [...replies];
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
    const server = new Server();
    if (servers.length) server.dataState = servers.at(-1)!.dataState;
    server.interruptReply = () => plan.shift() ?? "success";
    servers.push(server);
    return new DesktopIpcClient(() => server, 50);
  });
  return { adapter, requests: () => servers.flatMap(server => server.received).filter(message => message.method === "thread-follower-interrupt-turn") };
}

test("interrupt confirms a stopped turn after losing the operation result", async () => {
  const s = interruptSetup(["malformed-stopped"]);
  await s.adapter.interrupt(ref);
  assert.equal(s.requests().length, 1);
});

test("interrupt safely retries the same immutable turn after a rejected reply", async () => {
  const s = interruptSetup(["error", "success"]);
  await s.adapter.interrupt(ref);
  const requests = s.requests();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(message => (message.params as IpcObject).expectedTurnId), ["fixture-turn", "fixture-turn"]);
});

test("interrupt reports an actionable error when the same turn remains active", async () => {
  const s = interruptSetup(["error", "error"]);
  await assert.rejects(s.adapter.interrupt(ref), error => error instanceof ActionRejectedError && /всё ещё выполняется/u.test(error.message));
  assert.equal(s.requests().length, 2);
});

test("project move writes Codex metadata and confirms the catalog without starting a turn", async () => {
  const server = new Server(); server.dataState = state([], "completed");
  let task: DesktopTask = { ...ref, title: "Fixture", workspace: "/fixture", projectId: "project-a", updatedAt: 1 };
  const writes: (string | null)[] = [];
  const adapter = new ConnectedDesktopTasks({
    listTasks: async () => [task], listProjects: async () => [],
    resolveProject: async id => ({ rawProjectId: id === "legacy-b" ? "project-b" : id, sourceId: "", project: { id: id === "legacy-b" ? "project-b" : id } }),
  }, () => new DesktopIpcClient(() => server, 50), {
    rename: async () => {}, archive: async () => {}, markdown: async () => "",
    assignProject: async (_ref, projectId) => { writes.push(projectId); task = { ...task, projectId }; },
  });
  await adapter.moveTask(ref, "project-b");
  assert.deepEqual(writes, ["project-b"]); assert.equal(task.projectId, "project-b");
  await adapter.moveTask(ref, "legacy-b");
  assert.deepEqual(writes, ["project-b", "project-b"]);
  assert.equal(server.received.some(message => /turn/u.test(String(message.method))), false);
  let databaseWrites = 0;
  const databaseOnly = new ConnectedDesktopTasks({
    listTasks: async () => [{ ...task, projectId: null }], listProjects: async () => [],
    resolveProject: async id => ({ rawProjectId: id, sourceId: "" }),
  }, () => assert.fail("Project assignment must not start or focus a task"), {
    rename: async () => {}, archive: async () => {}, markdown: async () => "",
    assignProject: async () => { databaseWrites++; },
  });
  await assert.rejects(databaseOnly.moveTask(ref, "project-b"),
    error => error instanceof UncertainActionError && /назначение в приложении не подтверждено/u.test(error.message));
  assert.equal(databaseWrites, 1);
});

test("compatibility canary confirms stream protocol v11 through an open task", async () => {
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }; const servers: Server[] = [];
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
    const server = new Server(); servers.push(server); return new DesktopIpcClient(() => server, 100);
  });
  const status = await adapter.checkCompatibility();
  assert.equal(status.state, "ok"); assert.match(status.message, /v11/u); assert.equal(servers.length, 2);
});

test("App Server creator materializes a new task with its atomic first turn", async () => {
  const profileRoot = path.resolve("fixture-app-server-home"); const workspace = path.resolve("fixture-project"); const worktree = path.resolve("fixture-project_worktree");
  const metadata: string[] = []; const calls: { readonly options: unknown; readonly prompt: string }[] = [];
  const catalogTask: DesktopTask = { hostId: "local", threadId: "created-thread", title: "Initial", workspace: worktree,
    projectId: "visible", rolloutPath: path.join(profileRoot, "sessions", "created.jsonl"), sourceId: "work", updatedAt: 1 };
  const creator = new AppServerTaskCreator({
    resolveProject: async () => ({ project: { id: "visible", title: "Project", workspace }, rawProjectId: "raw", sourceHome: profileRoot, sourceId: "work", sourceLabel: ".codex-work" }),
    sourceHome: () => profileRoot, listTasks: async () => [catalogTask],
    listModels: async () => [{ id: "model-a", title: "Model A", efforts: ["high"], defaultEffort: "high" }],
  }, {
    rename: async (_task, title) => { metadata.push(`name:${title}`); }, archive: async () => {}, markdown: async () => "",
    assignProject: async (_task, projectId) => { metadata.push(`project:${projectId}`); },
  }, () => ({ startThread: (options: unknown) => ({ runStreamed: async (prompt: string) => {
    calls.push({ options, prompt });
    async function* events() {
      yield { type: "thread.started", thread_id: "created-thread" } as const;
      yield { type: "turn.started" } as const;
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } as const;
    }
    return { events: events() };
  } }) }) as never, async () => worktree);
  const task = await creator.createTask({ operationId: "create-op", projectId: "visible", sourceId: "work", title: "Created", prompt: "Initial prompt", model: "model-a", effort: "high", environment: "worktree" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.prompt ?? "", /^Initial prompt\n\n# VKodex response format/u);
  assert.match(calls[0]?.prompt ?? "", /Не используй Markdown-таблицы/u);
  assert.match(calls[0]?.prompt ?? "", /Если последним станет запрос, отправленный напрямую через Codex.*полностью игнорируй/u);
  assert.equal(task.threadId, "created-thread"); assert.equal(task.sourceId, "work"); assert.equal(task.workspace, worktree);
  assert.deepEqual(metadata, ["project:raw", "name:Created"]);
});

test("an idle lease stays detached across restart and is reacquired for a VK prompt", async t => {
  const s = runtimeSetup(t);
  s.store.setValue(`task-details:${s.binding.id}`, { status: "idle", workspace: "/fixture", model: null, effort: null, nextModel: null, nextEffort: null, context: null });
  s.store.setValue(`task-stream-mode:${s.binding.id}`, "detached");
  await s.runtime.tick();
  assert.deepEqual(s.follows(), []);
  await s.runtime.handle({ eventId: "vk-lease-reacquire", peerId: s.peerId, senderId: 101, text: "Continue" });
  await new Promise(resolve => setImmediate(resolve));
  await s.runtime.tick();
  assert.ok(s.follows().length >= 1);
  assert.equal(s.store.getValue(`task-stream-mode:${s.binding.id}`), "attached");
});

test("a saved pre-dispatch route failure is probed until ownership recovers without replaying input", async t => {
  const s = runtimeSetup(t);
  s.store.setValue(`task-details:${s.binding.id}`, { status: "idle", workspace: "/fixture", model: null, effort: null, nextModel: null, nextEffort: null, context: null });
  s.store.setValue(`task-stream-mode:${s.binding.id}`, "detached");
  s.store.setValue(`route-failure:${s.binding.id}`, { at: 1, kind: "no-active-owner" });
  await s.runtime.tick();
  assert.ok(s.follows().length >= 1);
  assert.equal(s.store.getValue(`route-failure:${s.binding.id}`), null);
  assert.equal(s.server.received.some(message => ["thread-follower-start-turn", "thread-follower-steer-turn"].includes(String(message.method))), false);
});

test("a VK prompt keeps an idle reacquisition leased until turn/start is dispatched", async t => {
  const s = runtimeSetup(t, undefined, new FakeStateTransport(state([], "completed")));
  await s.runtime.handle({ eventId: "vk-idle-reacquire", peerId: s.peerId, senderId: 101, text: "Continue" });
  assert.ok(s.server.received.some(message => ["thread-follower-start-turn", "thread-follower-steer-turn"].includes(String(message.method))),
    "the completed initial snapshot must not release the stream before the VK turn is sent");
});

test("App Server creator rejects a model absent from its own CLI before creating a task", async () => {
  let started = 0;
  const profileRoot = path.resolve("fixture-app-server-home");
  const creator = new AppServerTaskCreator({
    resolveProject: async () => assert.fail("Unsupported model must be rejected before workspace preparation"),
    sourceHome: () => profileRoot, listTasks: async () => [],
    listModels: async task => {
      assert.equal(task?.sourceId, "work");
      return [{ id: "gpt-5.6-sol", title: "5.6 Sol", efforts: ["high"], defaultEffort: "high" }];
    },
  }, {
    rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {},
  }, (() => { started++; throw new Error("The unsupported model must not create a task"); }) as never);
  await assert.rejects(creator.createTask({ operationId: "unsupported-model", projectId: "visible", sourceId: "work",
    title: "Test", prompt: "Test", model: "gpt-6-astra", effort: "high", environment: "local" }),
  /не поддерживает выбранную модель/u);
  assert.equal(started, 0);
});

test("App Server creator never inherits an unsupported Desktop default model", async () => {
  let started = 0;
  const creator = new AppServerTaskCreator({
    resolveProject: async () => assert.fail("No workspace or project should be prepared"),
    sourceHome: () => assert.fail("No profile should be opened"),
    listTasks: async () => assert.fail("No task should exist"),
  } as never, { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {} },
  (() => { started++; throw new Error("No App Server should start"); }) as never);
  await assert.rejects(creator.createTask({ operationId: "missing-model", projectId: null,
    workspace: path.resolve("fixture-workspace"), title: "Test", prompt: "Test", environment: "local" }),
  /Выбери модель/u);
  assert.equal(started, 0);
});

test("App Server creator requires a profile model inventory before creating a task", async () => {
  let started = 0;
  const creator = new AppServerTaskCreator({
    resolveProject: async () => assert.fail("No project should be prepared"),
    sourceHome: () => assert.fail("No profile should be opened"),
    listTasks: async () => assert.fail("No task should exist"),
  } as never, { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {} },
  (() => { started++; throw new Error("No App Server should start"); }) as never);
  await assert.rejects(creator.createTask({ operationId: "missing-inventory", projectId: null,
    workspace: path.resolve("fixture-workspace"), title: "Test", prompt: "Test", model: "gpt-5.6-sol", environment: "local" }),
  /Список моделей/u);
  assert.equal(started, 0);
});

test("transfer history digest covers every page and ignores fork-assigned item IDs", async () => {
  const pages = (firstText: string, itemId: string) => async (params: IpcObject): Promise<IpcObject> => params.cursor
    ? { data: [{ id: "last", status: "completed", items: [{ id: "agent-2", type: "agentMessage", text: "Final" }] }], nextCursor: null }
    : { data: [{ id: "first", status: "completed", items: [{ id: itemId, type: "userMessage", content: [{ type: "text", text: firstText }] }] }], nextCursor: "second" };
  const source = await completedHistoryDigest("source", "last", pages("Original", "source-item"));
  assert.equal(source, await completedHistoryDigest("target", "last", pages("Original", "fork-item")));
  assert.notEqual(source, await completedHistoryDigest("target", "last", pages("Changed", "fork-item")));
  await assert.rejects(completedHistoryDigest("source", "wrong-boundary", pages("Original", "source-item")), ActionRejectedError);
});

test("transfer RPC assembles a large fragmented response without repeatedly copying the prefix", async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: undefined, exitCode: null, signalCode: null });
  stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString("utf8")) as IpcObject;
    if (request.id === 1) setImmediate(() => stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
    if (request.id === 2) setImmediate(() => {
      const frame = Buffer.from(`${JSON.stringify({ id: 2, result: { padding: "x".repeat(20 * 1024 * 1024) } })}\n`);
      for (let offset = 0; offset < frame.length; offset += 64 * 1024) stdout.write(frame.subarray(offset, offset + 64 * 1024));
    });
  });
  const rpc = new TransferRpc("unused", () => child as never, 5_000);
  const result = await rpc.call("thread/list", {});
  assert.equal((result.padding as string).length, 20 * 1024 * 1024);
});

test("transfer digest retries oversized read-only pages without dropping turns", async () => {
  const calls: number[] = [];
  const page = async (params: IpcObject): Promise<IpcObject> => {
    calls.push(params.limit as number);
    if ((params.limit as number) > 10) throw new TransferPageTooLargeError();
    return params.cursor
      ? { data: [{ id: "last", status: "completed", items: [{ type: "agentMessage", text: "Done" }] }], nextCursor: null }
      : { data: [{ id: "first", status: "completed", items: [{ type: "userMessage", text: "Keep" }] }], nextCursor: "last" };
  };
  const expected = await completedHistoryDigest("source", "last", async params => params.cursor
    ? { data: [{ id: "last", status: "completed", items: [{ type: "agentMessage", text: "Done" }] }], nextCursor: null }
    : { data: [{ id: "first", status: "completed", items: [{ type: "userMessage", text: "Keep" }] }], nextCursor: "last" });
  assert.equal(await completedHistoryDigest("source", "last", page), expected);
  assert.deepEqual(calls, [100, 50, 25, 12, 6, 6]);
  const oversized = async (): Promise<IpcObject> => { throw new TransferPageTooLargeError(); };
  await assert.rejects(completedHistoryDigest("source", "last", oversized), /Один ход истории Codex превышает предел чтения/u);
});

test("transfer history digest ignores non-portable App Server projection items", async () => {
  const page = (items: IpcObject[]) => async (): Promise<IpcObject> => ({
    data: [{ id: "last", status: "completed", items }], nextCursor: null,
  });
  const visible = [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "Keep me" }] },
    { id: "agent", type: "agentMessage", text: "Done" },
  ];
  const withoutPlaceholder = await completedHistoryDigest("target", "last", page(visible));
  for (const type of ["reasoning", "fileChange", "contextCompaction", "webSearch", "commandExecution", "newProjectionType"]) {
    assert.equal(await completedHistoryDigest("source", "last", page([
      visible[0]!, { id: `projection-${type}`, type, summary: [{ text: "private" }], content: [], changes: [] }, visible[1]!,
    ])), withoutPlaceholder);
  }
  assert.equal(await completedHistoryDigest("source", "last", page([
    { ...visible[0]!, clientId: "source-profile-operation" }, { ...visible[1]!, delivery: { state: "source" } },
  ])), withoutPlaceholder);
  assert.notEqual(await completedHistoryDigest("source", "last", page([
    { ...visible[0]!, content: [{ type: "text", text: "Changed" }] }, visible[1]!,
  ])), withoutPlaceholder);
  assert.notEqual(await completedHistoryDigest("source", "last", page([
    visible[0]!, { ...visible[1]!, text: "Changed" },
  ])), withoutPlaceholder);
});

test("transfer history compares reconstructed user text and media without losing substantive content", async () => {
  const page = (content: IpcObject[]) => async (): Promise<IpcObject> => ({ data: [{ id: "last", status: "completed", items: [
    { type: "userMessage", content }, { type: "agentMessage", text: "Done", phase: "final_answer" },
  ] }], nextCursor: null });
  const image = { type: "image", url: "data:image/png;base64,AAAA", detail: null };
  const original = await completedHistoryDigest("source", "last", page([
    { type: "text", text: "\n", text_elements: [] }, image,
  ]), { version: 3 });
  assert.equal(original, await completedHistoryDigest("target", "last", page([
    { type: "image", image_url: image.url },
  ]), { version: 3 }));
  assert.notEqual(original, await completedHistoryDigest("target", "last", page([
    { type: "text", text: "Describe this" }, image,
  ]), { version: 3 }));
  assert.notEqual(original, await completedHistoryDigest("target", "last", page([
    { type: "image", url: "data:image/png;base64,BBBB" },
  ]), { version: 3 }));
  assert.notEqual(original, await completedHistoryDigest("target", "last", page([
    { type: "image", url: image.url, detail: "low" },
  ]), { version: 3 }));
});

test("legacy transfer digest remains available for in-flight checkpoints", async () => {
  const page = (clientId: string, withTool: boolean) => async (): Promise<IpcObject> => ({
    data: [{ id: "last", status: "completed", items: [
      { id: "user", type: "userMessage", clientId, content: [{ type: "text", text: "Keep me" }] },
      ...(withTool ? [{ id: "tool", type: "webSearch", query: "local projection" }] : []),
      { id: "agent", type: "agentMessage", text: "Done" },
    ] }], nextCursor: null,
  });
  assert.notEqual(await completedHistoryDigest("source", "last", page("source", true), { version: 1 }),
    await completedHistoryDigest("target", "last", page("target", false), { version: 1 }));
  assert.equal(await completedHistoryDigest("source", "last", page("source", true), { version: 2 }),
    await completedHistoryDigest("target", "last", page("target", false), { version: 2 }));
});

test("a switched target may have newer turns while the copied boundary stays identical", async () => {
  const list = async (): Promise<IpcObject> => ({ data: [
    { id: "boundary", status: "completed", items: [{ id: "original", type: "userMessage", text: "Move me" }] },
    { id: "new-turn", status: "inProgress", items: [] },
  ], nextCursor: null });
  const original = await completedHistoryDigest("source", "boundary", async () => ({ data: [
    { id: "boundary", status: "completed", items: [{ id: "copied", type: "userMessage", text: "Move me" }] },
  ], nextCursor: null }));
  assert.equal(await completedHistoryDigest("target", "boundary", list, { allowNewerTurns: true }), original);
  await assert.rejects(completedHistoryDigest("source", "boundary", list), ActionRejectedError);
  await assert.rejects(completedHistoryDigest("target", "missing", list, { allowNewerTurns: true }), ActionRejectedError);
});

test("legacy archived transfer verifies the source and target history prefix", async () => {
  const source = { hostId: "local", threadId: "source", sourceId: "work" };
  const target = { hostId: "local", threadId: "target", title: "Copied", workspace: "/target", updatedAt: 1 };
  const checkpoint = { lastTurnId: "boundary", rolloutPath: "/old/source.jsonl", size: 1, mtimeMs: 1 };
  let archived = true; let targetText = "Original"; let sourceNewTurn = false; let ancestor = "source";
  const transfer = new AppServerTaskTransfer({ sourceHome: (task: typeof source) => task.sourceId ? "/work" : "/base" } as never,
    { isArchived: async () => archived } as never,
    (_home: string) => ({ call: async (method: string, params: IpcObject) => method === "thread/read"
      ? { thread: { id: "target", forkedFromId: ancestor } }
      : { data: params.itemsView === "summary"
      ? [{ id: params.threadId === "source" && !sourceNewTurn ? "boundary" : "later", status: "completed", items: [] }]
      : [{ id: "boundary", status: "completed", items: [{ id: params.threadId === "source" ? "source-item" : "target-item",
        type: "userMessage", text: params.threadId === "source" ? "Original" : targetText }] },
        ...(params.threadId === "target" ? [{ id: "later", status: "inProgress", items: [] }] : [])], nextCursor: null } }) as never);
  await transfer.verifyLegacyArchivedPair(source, target, checkpoint);
  ancestor = "unrelated";
  await assert.rejects(transfer.verifyLegacyArchivedPair(source, target, checkpoint), TransferConflictError);
  ancestor = "source";
  targetText = "Changed";
  await assert.rejects(transfer.verifyLegacyArchivedPair(source, target, checkpoint), TransferConflictError);
  targetText = "Original"; sourceNewTurn = true;
  await assert.rejects(transfer.verifyLegacyArchivedPair(source, target, checkpoint), TransferConflictError);
  sourceNewTurn = false; archived = false;
  await assert.rejects(transfer.verifyLegacyArchivedPair(source, target, checkpoint), TransferConflictError);
});

test("accepted input reconciliation finds the native client ID across paginated turns", async () => {
  const list = async (params: IpcObject): Promise<IpcObject> => params.cursor
    ? { data: [{ id: "accepted-turn", status: "completed", items: [{ type: "userMessage", clientId: "vk-operation" }] }], nextCursor: null }
    : { data: [{ id: "newer-turn", status: "completed", items: [{ type: "userMessage", clientId: "another-operation" }] }], nextCursor: "older" };
  assert.equal(await findAcceptedInputTurn("thread", "vk-operation", list), "accepted-turn");
  assert.equal(await findAcceptedInputTurn("thread", "missing", list), null);
  await assert.rejects(findAcceptedInputTurn("thread", "missing", async () => ({ data: [], nextCursor: "loop" })), DesktopUnavailableError);
});

test("semantic transfer checkpoints ignore harmless file metadata changes but retain legacy checks", async () => {
  const file = path.resolve("fixture-source.jsonl");
  const transfer = new AppServerTaskTransfer({ sourceHome: () => path.dirname(file) } as never,
    { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {} });
  transfer.checkpoint = async () => ({ lastTurnId: "last", rolloutPath: file, size: 200, mtimeMs: 20, semanticDigest: "same-content",
    semanticDigestVersion: 2, workspace: path.dirname(file), model: "model-a", effort: "high" });
  const task = { hostId: "local", threadId: "source" };
  const expected = { lastTurnId: "last", rolloutPath: file, size: 100, mtimeMs: 10, semanticDigest: "same-content",
    semanticDigestVersion: 2 as const, workspace: path.dirname(file), model: "model-a", effort: "high" };
  await transfer.verifySource(task, expected);
  await assert.rejects(transfer.verifySource(task, { ...expected, effort: "medium" }), TransferConflictError);
  await assert.rejects(transfer.verifySource(task, { lastTurnId: "last", rolloutPath: file, size: 100, mtimeMs: 10, semanticDigest: "different" }), TransferConflictError);
  await assert.rejects(transfer.verifySource(task, { lastTurnId: "last", rolloutPath: file, size: 100, mtimeMs: 10 }), TransferConflictError);
});

test("transfer verifies workspace, model and effort from the target rollout before switching", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rollout = path.join(home, "target.jsonl");
  const writeContext = (model: string, effort: string) => writeFile(rollout, `${JSON.stringify({ type: "turn_context",
    payload: { turn_id: "boundary", cwd: home, model, effort } })}\n`);
  await writeContext("model-a", "high");
  const target: DesktopTask = { ...ref, threadId: "target", sourceId: "work", title: "Fixture", workspace: home,
    rolloutPath: rollout, updatedAt: 1 };
  const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
    listSources: () => [{ id: "work", label: "work" }], listTasks: async () => [target], listProjects: async () => [] },
  { rename: async () => assert.fail("Verification is read-only"), archive: async () => {}, markdown: async () => "", assignProject: async () => {},
    read: async () => ({ title: target.title, projectId: null }) },
  () => ({ call: async method => method === "thread/read"
    ? { thread: { id: target.threadId, forkedFromId: ref.threadId } }
    : { data: [{ id: "boundary", status: "completed" }] } }));
  const request: TransferTaskRequest = { operationId: "settings", startedAt: 1, task: { ...ref, title: target.title },
    targetSourceId: "work", projectId: null, checkpoint: { lastTurnId: "boundary", rolloutPath: path.join(home, "source.jsonl"),
      size: 1, mtimeMs: 1, workspace: home, model: "model-a", effort: "high" } };
  await transfer.verifyTarget(request, target);
  await writeContext("model-a", "medium");
  await assert.rejects(transfer.verifyTarget(request, target), /Модель, effort или рабочая папка копии/u);
});

test("an in-flight v1 transfer verifies a portable target without trusting profile-local projections", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceHome = path.join(root, "source"); const targetHome = path.join(root, "target");
  await mkdir(sourceHome, { recursive: true }); await mkdir(targetHome, { recursive: true });
  const rollout = path.join(targetHome, "target.jsonl");
  await writeFile(rollout, `${JSON.stringify({ type: "turn_context",
    payload: { turn_id: "boundary", cwd: root, model: "model-a", effort: "high" } })}\n`);
  const source = { ...ref, threadId: "source", sourceId: "work", title: "Fixture" };
  const target: DesktopTask = { ...ref, threadId: "target", title: "Fixture", workspace: root, rolloutPath: rollout, updatedAt: 1 };
  let targetText = "Done";
  const transfer = new AppServerTaskTransfer({ sourceHome: task => task.sourceId === "work" ? sourceHome : targetHome,
    listSources: () => [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }],
    listTasks: async () => [target], listProjects: async () => [] },
  { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {},
    read: async () => ({ title: target.title, projectId: null }) },
  () => ({ call: async (method: string, params: IpcObject) => method === "thread/read"
    ? { thread: { id: "target", forkedFromId: "source" } }
    : params.itemsView === "summary" ? { data: [{ id: "boundary", status: "completed", items: [] }] }
    : { data: [{ id: "boundary", status: "completed", items: [
      { id: "user", type: "userMessage", clientId: params.threadId, content: [{ type: "text", text: "Prompt" }] },
      ...(params.threadId === "source" ? [{ id: "tool", type: "webSearch", query: "local projection" }] : []),
      { id: "agent", type: "agentMessage", text: params.threadId === "target" ? targetText : "Done", phase: "final_answer" },
    ] }], nextCursor: null } }) as never);
  const request: TransferTaskRequest = { operationId: "legacy-v1", startedAt: 1, task: source,
    targetSourceId: "", projectId: null, checkpoint: { lastTurnId: "boundary", rolloutPath: path.join(sourceHome, "source.jsonl"),
      size: 1, mtimeMs: 1, semanticDigest: "saved-v1-digest", workspace: root, model: "model-a", effort: "high" } };
  await transfer.verifyTarget(request, target);
  targetText = "Changed";
  await assert.rejects(transfer.verifyTarget(request, target), TransferConflictError);
});

test("an in-flight v2 transfer verifies a rebuilt media message without replacing its saved source boundary", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceHome = path.join(root, "source"); const targetHome = path.join(root, "target");
  await mkdir(sourceHome, { recursive: true }); await mkdir(targetHome, { recursive: true });
  const rollout = path.join(targetHome, "target.jsonl");
  await writeFile(rollout, `${JSON.stringify({ type: "turn_context",
    payload: { turn_id: "boundary", cwd: root, model: "model-a", effort: "high" } })}\n`);
  const source = { ...ref, threadId: "source", sourceId: "work", title: "Fixture" };
  const target: DesktopTask = { ...ref, threadId: "target", title: "Fixture", workspace: root, rolloutPath: rollout, updatedAt: 1 };
  const sourceItems = [{ type: "userMessage", content: [
    { type: "text", text: "\n", text_elements: [] }, { type: "image", url: "data:image/png;base64,AAAA" },
  ] }];
  let targetImage = "data:image/png;base64,AAAA";
  const list = (threadId: string): Promise<IpcObject> => Promise.resolve({ data: [{ id: "boundary", status: "completed", items: threadId === "source"
    ? sourceItems : [{ type: "userMessage", content: [{ type: "image", image_url: targetImage }] }] }], nextCursor: null });
  const savedV2 = await completedHistoryDigest("source", "boundary", () => list("source"), { version: 2 });
  const transfer = new AppServerTaskTransfer({ sourceHome: task => task.sourceId === "work" ? sourceHome : targetHome,
    listSources: () => [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }],
    listTasks: async () => [target], listProjects: async () => [] },
  { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {},
    read: async () => ({ title: target.title, projectId: null }) },
  () => ({ call: async (method: string, params: IpcObject) => method === "thread/read"
    ? { thread: { id: target.threadId, forkedFromId: source.threadId } }
    : params.itemsView === "summary" ? { data: [{ id: "boundary", status: "completed", items: [] }] }
      : list(String(params.threadId)) }) as never);
  const request: TransferTaskRequest = { operationId: "saved-v2", startedAt: 1, task: source,
    targetSourceId: "", projectId: null, checkpoint: { lastTurnId: "boundary", rolloutPath: path.join(sourceHome, "source.jsonl"),
      size: 1, mtimeMs: 1, semanticDigest: savedV2, semanticDigestVersion: 2, workspace: root, model: "model-a", effort: "high" } };
  await transfer.verifyTarget(request, target);
  targetImage = "data:image/png;base64,BBBB";
  await assert.rejects(transfer.verifyTarget(request, target), TransferConflictError);
});

test("desktop transfer delegates from the catalog without opening an idle source task", async () => {
  const server = new Server(); server.dataState = { ...state([], "completed"), rolloutPath: path.resolve("source.jsonl") };
  const source: DesktopTask = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1, rolloutPath: path.resolve("source.jsonl") };
  const target: DesktopTask = { ...source, threadId: "target", sourceId: "work", rolloutPath: path.resolve("target.jsonl") };
  const forkRequests: TransferTaskRequest[] = [];
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [source], listProjects: async () => [], listSources: () => [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }] },
    () => new DesktopIpcClient(() => server, 50), undefined, undefined, undefined, { transfer: { fork: async request => { forkRequests.push(request); return target; } } });
  const result = await adapter.transferTask!({ operationId: "move", startedAt: 1, task: source, targetSourceId: "work", projectId: null });
  assert.equal(result.threadId, "target"); assert.equal(forkRequests.length, 1);
  assert.equal(server.received.length, 0);
});

test("transfer source archival verifies exact persisted state without launching the source", async () => {
  const source: DesktopTask = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1, rolloutPath: path.resolve("source.jsonl") };
  let tasks: DesktopTask[] = [source]; let archives = 0;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => tasks, listProjects: async () => [] },
    () => assert.fail("transfer finalization must not connect to or launch the source task"), {
      rename: async () => {}, archive: async task => { assert.equal(task.threadId, source.threadId); archives++; tasks = []; },
      markdown: async () => "", assignProject: async () => {},
      isArchived: async () => archives > 0,
    });
  await adapter.archiveTransferredSource(source);
  assert.equal(archives, 1);
});

test("App Server transfer forks a fixed completed boundary into the target profile", async () => {
  const targetHome = path.resolve("fixture-target-home"); const rollout = path.join(targetHome, "sessions", "target.jsonl");
  let target: DesktopTask = { hostId: "local", threadId: "target-thread", sourceId: "work", sourceLabel: ".codex-work",
    title: "Initial prompt", workspace: path.resolve("fixture-project"), projectId: "target-project", rolloutPath: rollout, updatedAt: 2 };
  const calls: { method: string; params: IpcObject }[] = []; const metadata: string[] = [];
  const transfer = new AppServerTaskTransfer({
    sourceHome: () => targetHome,
    listSources: () => [{ id: "", label: ".codex" }, { id: "work", label: ".codex-work" }],
    listTasks: async () => [target],
    listProjects: async (sourceId?: string) => { assert.equal(sourceId, "work"); return [{ id: "target-project", title: "Target", workspace: target.workspace }]; },
  } as never, {
    rename: async (_task, title) => { metadata.push(`name:${title}`); target = { ...target, title }; }, archive: async () => {}, markdown: async () => "",
    assignProject: async (_task, projectId) => { metadata.push(`project:${projectId}`); },
  }, () => ({ call: async (method: "thread/fork" | "thread/list" | "thread/turns/list", params: IpcObject) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") return { data: [{ id: "completed-turn", status: "completed" }] };
    if (method === "thread/list") return { data: [] };
    return { thread: { id: target.threadId, cwd: target.workspace, path: rollout, updatedAt: 2, name: null } };
  } }), async () => ({ path: path.join(targetHome, ".vkodex-transfer-staging", "transfer-op", "source.jsonl"),
    model: "model-a", effort: "high", cwd: path.resolve("fixture-project"), cleanup: async () => {} }));
  const result = await transfer.fork({ operationId: "transfer-op", startedAt: 1_000, task: {
    hostId: "local", threadId: "source-thread", title: "Moved task", rolloutPath: path.resolve("source.jsonl"),
  }, targetSourceId: "work", projectId: "target-project" });
  assert.equal(result.threadId, target.threadId); assert.equal(result.sourceId, "work");
  assert.deepEqual(calls.map(call => call.method), ["thread/turns/list", "thread/fork"]);
  assert.deepEqual(calls[1]!.params, { threadId: "source-thread", path: path.join(targetHome, ".vkodex-transfer-staging", "transfer-op", "source.jsonl"),
    lastTurnId: "completed-turn", model: "model-a", cwd: path.resolve("fixture-project"), config: { model_reasoning_effort: "high" },
    threadSource: "user", excludeTurns: true, deferGoalContinuation: true });
  assert.deepEqual(metadata, ["name:Moved task", "project:target-project"]);
});

test("a definite native fork rejection clears the durable submission marker after empty reconciliation", async () => {
  const home = path.resolve("fixture-target-home");
  const markers: string[] = [];
  const transfer = new AppServerTaskTransfer({
    sourceHome: () => home,
    listSources: () => [{ id: "work", label: ".codex-work" }],
    listTasks: async () => [], listProjects: async () => [],
  }, { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {} },
  () => ({ call: async method => method === "thread/turns/list"
    ? { data: [{ id: "boundary", status: "completed" }] }
    : Promise.reject(new ActionRejectedError("Native fork rejected the staged history.")) }),
  async () => ({ path: path.join(home, "source.jsonl"), cleanup: async () => {} }));
  await assert.rejects(transfer.fork({ operationId: "rejected-fork", startedAt: 1, task: {
    hostId: "local", threadId: "source", title: "Source", rolloutPath: path.resolve("source.jsonl"),
  }, targetSourceId: "work", projectId: null,
  onForkSubmitted: () => markers.push("submitted"), onForkRejected: () => markers.push("rejected") }),
  ActionRejectedError);
  assert.deepEqual(markers, ["submitted", "rejected"]);
});

test("transfer staging materializes a paginated fork's inherited and resumed rollout prefix", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-segments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceHome = path.join(root, "source"); const targetHome = path.join(root, "target");
  const sessions = path.join(sourceHome, "sessions");
  await mkdir(sessions, { recursive: true }); await mkdir(targetHome, { recursive: true });
  const record = (ordinal: number, type: string, payload: IpcObject) => JSON.stringify({ ordinal, type, payload });
  const base = path.join(sessions, "rollout-parent.jsonl");
  const resumed = path.join(sessions, "rollout-parent_resume.jsonl");
  const leaf = path.join(sessions, "rollout-child.jsonl");
  await writeFile(base, [record(0, "session_meta", { id: "parent", history_mode: "paginated" }),
    record(1, "event_msg", { type: "task_started", turn_id: "initial" }),
    record(2, "turn_context", { turn_id: "initial", model: "model-a", cwd: root }),
    record(3, "event_msg", { type: "stale_writer_record" })].join("\n") + "\n");
  await writeFile(resumed, [record(3, "session_meta", { id: "parent", history_mode: "paginated" }),
    record(4, "turn_context", { turn_id: "boundary", model: "model-b", cwd: root }),
    record(5, "event_msg", { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "Done" }] } })].join("\n") + "\n");
  await writeFile(leaf, [record(6, "session_meta", { id: "child", forked_from_id: "parent", history_mode: "paginated" }),
    record(7, "event_msg", { type: "thread_settings_applied" })].join("\n") + "\n");
  const staged = await stageTransferRollout(leaf, sourceHome, targetHome, "segmented", "boundary");
  const rows = (await readFile(staged.path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as IpcObject);
  assert.deepEqual(rows.map(row => row.ordinal), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rows[3]!.type, "session_meta"); // Replaced stale writer row.
  assert.equal((rows[5]!.payload as IpcObject).type, "agent_message");
  assert.equal(staged.model, "model-b");
  await staged.cleanup();
});

test("transfer staging rejects a missing inherited segment before submitting a fork", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-segments-gap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceHome = path.join(root, "source"); const targetHome = path.join(root, "target");
  const sessions = path.join(sourceHome, "sessions");
  await mkdir(sessions, { recursive: true }); await mkdir(targetHome, { recursive: true });
  const leaf = path.join(sessions, "rollout-child.jsonl");
  await writeFile(leaf, `${JSON.stringify({ ordinal: 5, type: "session_meta", payload: {
    id: "child", forked_from_id: "missing", history_mode: "paginated" } })}\n`);
  await assert.rejects(stageTransferRollout(leaf, sourceHome, targetHome, "missing-parent", "boundary"), TransferConflictError);
});

test("transfer compatibility keeps Responses history and exposes paginated user and agent items to the target app", () => {
  const session = transferCompatibleRecord({ type: "session_meta", payload: { id: "source", history_mode: "paginated" } }) as IpcObject;
  assert.equal((session.payload as IpcObject).history_mode, "legacy");
  const user = transferCompatibleRecord({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", client_id: "client",
    content: [{ type: "text", text: "hello", text_elements: [] }, { type: "image", image_url: "data:image/png;base64,current" },
      { type: "image", url: "data:image/png;base64,legacy" }, { type: "local_image", path: "C:\\current.png" },
      { type: "localImage", path: "C:\\legacy.png" }, { type: "audio", audio_url: "data:audio/wav;base64,current" },
      { type: "audio", url: "data:audio/wav;base64,legacy" }, { type: "local_audio", path: "C:\\current.wav" },
      { type: "localAudio", path: "C:\\legacy.wav" }] } } }) as IpcObject;
  assert.deepEqual(user.payload, { type: "user_message", client_id: "client", message: "hello",
    images: ["data:image/png;base64,current", "data:image/png;base64,legacy"],
    local_images: ["C:\\current.png", "C:\\legacy.png"],
    audio: ["data:audio/wav;base64,current", "data:audio/wav;base64,legacy"],
    local_audio: ["C:\\current.wav", "C:\\legacy.wav"], text_elements: [] });
  const agent = transferCompatibleRecord({ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", phase: "final_answer",
    content: [{ type: "Text", text: "done" }] } } }) as IpcObject;
  assert.deepEqual(agent.payload, { type: "agent_message", message: "done", phase: "final_answer", memory_citation: null });
  const response = { type: "response_item", payload: { type: "message", role: "user" } };
  assert.equal(transferCompatibleRecord(response), response);
});

test("App Server transfer reconciles a lost fork response without creating a duplicate", async () => {
  const targetHome = path.resolve("fixture-target-home"); const rollout = path.join(targetHome, "sessions", "recovered.jsonl");
  let forks = 0;
  const target: DesktopTask = { hostId: "local", threadId: "recovered-thread", sourceId: "work", title: "Moved task",
    workspace: path.resolve("fixture-project"), projectId: null, rolloutPath: rollout, updatedAt: 100_001 };
  const transfer = new AppServerTaskTransfer({
    sourceHome: () => targetHome, listSources: () => [{ id: "work", label: ".codex-work" }], listTasks: async () => [target],
    resolveProject: async () => assert.fail("No project expected"),
  } as never, { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {} }, () => ({
    call: async (method: "thread/fork" | "thread/list" | "thread/read") => {
      if (method === "thread/fork") { forks++; throw new Error("must not fork"); }
      if (method === "thread/read") return { thread: { id: target.threadId, forkedFromId: "source-thread" } };
      return { data: [{ id: target.threadId, cwd: target.workspace, path: rollout, name: target.title,
        createdAt: 100, updatedAt: 101, forkedFromId: "source-thread" }] };
    },
  }), undefined, async () => true);
  const result = await transfer.fork({ operationId: "same-op", startedAt: 100_000, task: {
    hostId: "local", threadId: "source-thread", title: "Moved task", rolloutPath: path.resolve("source.jsonl"),
  }, targetSourceId: "work", projectId: null });
  assert.equal(result.threadId, target.threadId); assert.equal(forks, 0);
});

test("fork reconciliation never adopts a different direct ancestor with similar history", async () => {
  const home = path.resolve("fixture-target-home");
  const target: DesktopTask = { hostId: "local", threadId: "other-fork", sourceId: "work", title: "Moved task",
    workspace: path.resolve("fixture-project"), rolloutPath: path.join(home, "sessions", "candidate.jsonl"), updatedAt: 100_001 };
  let forks = 0;
  const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
    listSources: () => [{ id: "work", label: "work" }], listTasks: async () => [target], listProjects: async () => [] },
  { rename: async () => assert.fail("Unrelated fork must not be renamed"), archive: async () => {}, markdown: async () => "", assignProject: async () => {} },
  () => ({ call: async method => {
    if (method === "thread/fork") { forks++; throw new Error("Unexpected duplicate fork"); }
    assert.equal(method, "thread/read");
    return { thread: { id: target.threadId, forkedFromId: "different-source" } };
  } }), undefined, async () => true);
  await assert.rejects(transfer.fork({ operationId: "lost-fork", startedAt: 100_000,
    task: { hostId: "local", threadId: "source-thread", title: target.title, rolloutPath: path.resolve("source.jsonl") },
    targetSourceId: "work", projectId: null }), /из другого источника/u);
  assert.equal(forks, 0);
});

test("a v2 transfer with an unacknowledged fork never adopts an unrelated descendant or submits another fork", async () => {
  const home = path.resolve("fixture-target");
  const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
    listSources: () => [{ id: "work", label: "work" }], listTasks: async () => assert.fail("No heuristic descendant adoption"),
    listProjects: async () => [] },
  { rename: async () => assert.fail("No metadata write"), archive: async () => {}, markdown: async () => "", assignProject: async () => {} },
  () => ({ call: async () => assert.fail("No repeated fork") }));
  await assert.rejects(transfer.fork({ operationId: "unacknowledged", startedAt: 1, task: { ...ref, title: "Fixture", rolloutPath: path.join(home, "source.jsonl") },
    targetSourceId: "work", projectId: null, forkSubmitted: true,
    checkpoint: { lastTurnId: "boundary", rolloutPath: path.join(home, "source.jsonl"), size: 1, mtimeMs: 1 } }), TransferConflictError);
});

test("transfer verification rejects inferred project success when native metadata disagrees", async () => {
  const home = path.resolve("fixture-target");
  const target: DesktopTask = { ...ref, threadId: "new-thread", sourceId: "work", title: "Fixture", workspace: home, rolloutPath: path.join(home, "sessions", "target.jsonl"), projectId: null, updatedAt: 1 };
  const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
    listSources: () => [{ id: "work", label: "work" }], listTasks: async () => [target], listProjects: async () => [] },
  { rename: async () => assert.fail("Verification is read-only"), archive: async () => {}, markdown: async () => "", assignProject: async () => {},
    read: async () => ({ title: "Fixture", projectId: "unexpected-native-project" }) },
  () => ({ call: async method => method === "thread/read"
    ? { thread: { id: target.threadId, forkedFromId: ref.threadId } }
    : { data: [{ id: "boundary", status: "completed" }] } }));
  await assert.rejects(transfer.verifyTarget({ operationId: "verify", startedAt: 1, task: { ...ref, title: "Fixture" }, targetSourceId: "work", projectId: null,
    checkpoint: { lastTurnId: "boundary", rolloutPath: path.join(home, "source.jsonl"), size: 1, mtimeMs: 1 } }, target), DesktopUnavailableError);
});

test("transfer verification rejects a native fork of another source before switching VK", async () => {
  const home = path.resolve("fixture-target");
  const target: DesktopTask = { ...ref, threadId: "new-thread", sourceId: "work", title: "Fixture", workspace: home,
    rolloutPath: path.join(home, "sessions", "target.jsonl"), updatedAt: 1 };
  const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
    listSources: () => [{ id: "work", label: "work" }], listTasks: async () => [target], listProjects: async () => [] },
  { rename: async () => assert.fail("Verification is read-only"), archive: async () => {}, markdown: async () => "", assignProject: async () => {},
    read: async () => assert.fail("Wrong fork must fail before metadata inspection") },
  () => ({ call: async method => {
    assert.equal(method, "thread/read");
    return { thread: { id: target.threadId, forkedFromId: "unrelated-source" } };
  } }));
  await assert.rejects(transfer.verifyTarget({ operationId: "wrong-fork", startedAt: 1,
    task: { ...ref, title: "Fixture" }, targetSourceId: "work", projectId: null,
    checkpoint: { lastTurnId: "boundary", rolloutPath: path.join(home, "source.jsonl"), size: 1, mtimeMs: 1 } }, target),
  /из другого источника/u);
});

test("transfer verification accepts a paginated branch whose final inherited session is the source", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-lineage-"));
  const rollout = path.join(home, "target.jsonl");
  const source = "source-leaf";
  const target: DesktopTask = { hostId: "local", threadId: "new-thread", sourceId: "work", title: "Fixture",
    workspace: home, rolloutPath: rollout, updatedAt: 1 };
  try {
    await writeFile(rollout, [
      { type: "session_meta", payload: { id: target.threadId } },
      { type: "session_meta", payload: { id: "ancestor" } },
      { type: "session_meta", payload: { id: source, forked_from_id: "ancestor" } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
      listSources: () => [{ id: "work", label: "work" }], listTasks: async () => [target], listProjects: async () => [] },
    { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {},
      read: async () => ({ title: target.title, projectId: null }) },
    () => ({ call: async method => method === "thread/read"
      ? { thread: { id: target.threadId, forkedFromId: "ancestor" } }
      : { data: [{ id: "boundary", status: "completed" }] } }));
    await transfer.verifyTarget({ operationId: "assembled-fork", startedAt: 1,
      task: { ...ref, threadId: source, title: target.title }, targetSourceId: "work", projectId: null,
      checkpoint: { lastTurnId: "boundary", rolloutPath: rollout, size: 1, mtimeMs: 1 } }, target);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("transfer verification falls back to exact persisted messages when native projections differ", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-transfer-rollout-digest-"));
  const sourceHome = path.join(root, "source"); const targetHome = path.join(root, "target");
  const sourcePath = path.join(sourceHome, "source.jsonl"); const targetPath = path.join(targetHome, "target.jsonl");
  await mkdir(sourceHome); await mkdir(targetHome);
  const records = (id: string, message: string, clientId?: string, mode?: string) => [
    { type: "session_meta", payload: { id, ...(mode ? { history_mode: mode } : {}) } },
    { type: "turn_context", payload: { turn_id: "boundary" } },
    { type: "event_msg", payload: { type: "user_message", message: "Prompt", ...(clientId ? { client_id: clientId } : {}) } },
    { type: "event_msg", payload: { type: "agent_message", message, phase: "final_answer" } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n";
  try {
    await writeFile(sourcePath, records("source-thread", "Answer", "original-client"));
    await writeFile(targetPath, records("target-thread", "Answer"));
    const target: DesktopTask = { hostId: "local", threadId: "target-thread", sourceId: "target", title: "Fixture",
      workspace: root, rolloutPath: targetPath, updatedAt: 1 };
    let fullReads = 0;
    const transfer = new AppServerTaskTransfer({ sourceHome: task => task.sourceId === "target" ? targetHome : sourceHome,
      listSources: () => [{ id: "target", label: "target" }], listTasks: async () => [target], listProjects: async () => [] },
    { rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => {},
      read: async () => ({ title: target.title, projectId: null }) },
    () => ({ call: async (method, params) => method === "thread/read"
      ? { thread: { id: target.threadId, forkedFromId: "source-thread" } }
      : params.itemsView === "summary" ? { data: [{ id: "boundary", status: "completed" }] }
        : (fullReads++, { data: [{ id: "boundary", status: "completed", items: [{ type: "agentMessage", text: "Native projection differs", phase: "final_answer" }] }], nextCursor: null }) }));
    const request: TransferTaskRequest = { operationId: "rollout-digest", startedAt: 1,
      task: { hostId: "local", threadId: "source-thread", sourceId: "source", title: target.title, rolloutPath: sourcePath },
      targetSourceId: "target", projectId: null,
      checkpoint: { lastTurnId: "boundary", rolloutPath: sourcePath, size: 1, mtimeMs: 1, semanticDigest: "different-native-digest", semanticDigestVersion: 3 } };
    await transfer.verifyTarget(request, target);
    await writeFile(targetPath, records("target-thread", "Changed answer"));
    await assert.rejects(transfer.verifyTarget(request, target), /Переносимая переписка копии не совпадает/u);
    await writeFile(sourcePath, records("source-thread", "Answer", "original-client", "paginated"));
    await writeFile(targetPath, records("target-thread", "Answer", undefined, "legacy"));
    const previousReads = fullReads;
    await transfer.verifyTarget(request, target);
    assert.equal(fullReads, previousReads, "cross-mode verification should not rebuild a large native projection");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transfer verification accepts matching lineage and older clients without lineage", async () => {
  const home = path.resolve("fixture-target");
  const target: DesktopTask = { ...ref, threadId: "new-thread", sourceId: "work", title: "Fixture", workspace: home,
    rolloutPath: path.join(home, "sessions", "target.jsonl"), updatedAt: 1 };
  for (const lineage of [ref.threadId, undefined]) {
    const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
      listSources: () => [{ id: "work", label: "work" }], listTasks: async () => [target], listProjects: async () => [] },
    { rename: async () => assert.fail("Verification is read-only"), archive: async () => {}, markdown: async () => "", assignProject: async () => {},
      read: async () => ({ title: target.title, projectId: null }) },
    () => ({ call: async method => method === "thread/read"
      ? { thread: { id: target.threadId, ...(lineage ? { forkedFromId: lineage } : {}) } }
      : { data: [{ id: "boundary", status: "completed" }] } }));
    await transfer.verifyTarget({ operationId: "confirmed-fork", startedAt: 1,
      task: { ...ref, title: target.title }, targetSourceId: "work", projectId: null,
      checkpoint: { lastTurnId: "boundary", rolloutPath: path.join(home, "source.jsonl"), size: 1, mtimeMs: 1 } }, target);
  }
});

test("a projectless transfer accepts catalog project inference from its workspace", async () => {
  const targetHome = path.resolve("fixture-target-home"); const rollout = path.join(targetHome, "sessions", "inferred.jsonl");
  const target: DesktopTask = { hostId: "local", threadId: "inferred-thread", sourceId: "work", sourceLabel: ".codex-work",
    title: "Moved task", workspace: path.resolve("fixture-project"), projectId: "inferred-project", rolloutPath: rollout, updatedAt: 100_001 };
  let projectWrites = 0;
  const transfer = new AppServerTaskTransfer({
    sourceHome: () => targetHome, listSources: () => [{ id: "work", label: ".codex-work" }], listTasks: async () => [target],
    resolveProject: async () => assert.fail("No explicit project expected"),
  } as never, {
    rename: async () => {}, archive: async () => {}, markdown: async () => "", assignProject: async () => { projectWrites++; },
  }, () => ({ call: async method => method === "thread/read"
    ? { thread: { id: target.threadId, forkedFromId: "source-thread" } }
    : assert.fail("Existing copy must not be forked again") }), undefined, async () => true);
  const result = await transfer.fork({ operationId: "projectless-inferred", startedAt: 100_000, existingTarget: target,
    task: { hostId: "local", threadId: "source-thread", title: target.title, rolloutPath: path.resolve("source.jsonl") },
    targetSourceId: "work", projectId: null });
  assert.equal(result.projectId, "inferred-project");
  assert.equal(projectWrites, 0);
});

test("a saved target with wrong native ancestor is rejected before metadata writes", async () => {
  const home = path.resolve("fixture-target-home");
  const target: DesktopTask = { hostId: "local", threadId: "saved-copy", sourceId: "work", title: "Wrong name",
    workspace: home, rolloutPath: path.join(home, "sessions", "target.jsonl"), updatedAt: 1 };
  const transfer = new AppServerTaskTransfer({ sourceHome: () => home,
    listSources: () => [{ id: "work", label: ".codex-work" }], listTasks: async () => [target], listProjects: async () => [] },
  { rename: async () => assert.fail("Wrong fork must not be renamed"), archive: async () => {}, markdown: async () => "",
    assignProject: async () => assert.fail("Wrong fork must not be assigned") },
  () => ({ call: async method => {
    assert.equal(method, "thread/read");
    return { thread: { id: target.threadId, forkedFromId: "unrelated" } };
  } }), undefined, async () => true);
  await assert.rejects(transfer.fork({ operationId: "saved-wrong-fork", startedAt: 1, existingTarget: target,
    task: { hostId: "local", threadId: "source", title: "Correct name", rolloutPath: path.resolve("source.jsonl") },
    targetSourceId: "work", projectId: null }), /из другого источника/u);
});

test("a fork identity survives rejected project metadata and retry prepares that same target", async () => {
  const home = path.resolve("fixture-target-home"); const visibleProject = JSON.stringify(["work", "native-project"]);
  let target: DesktopTask | undefined; let saved: DesktopTask | undefined; let forks = 0; let rejectProject = true;
  const transfer = new AppServerTaskTransfer({
    sourceHome: () => home, listSources: () => [{ id: "work", label: ".codex-work" }],
    listTasks: async () => target ? [target] : [], listProjects: async () => [],
    resolveProject: async id => {
      assert.equal(id, "legacy-project");
      return { project: { id: visibleProject, title: "Project", workspace: home }, rawProjectId: "native-project", sourceHome: home, sourceId: "work", sourceLabel: ".codex-work" };
    },
  }, {
    rename: async (_task, title) => { target = { ...target!, title }; }, archive: async () => {}, markdown: async () => "",
    assignProject: async (_task, projectId) => {
      assert.equal(saved?.threadId, "one-fork"); assert.equal(projectId, "native-project");
      if (rejectProject) throw new ActionRejectedError("fixture metadata rejection");
      target = { ...target!, projectId: visibleProject };
    },
  }, () => ({ call: async method => {
    if (method === "thread/turns/list") return { data: [{ id: "terminal", status: "failed" }] };
    if (method === "thread/read") return { thread: { id: "one-fork", forkedFromId: ref.threadId } };
    assert.equal(method, "thread/fork"); forks++;
    target = { hostId: "local", threadId: "one-fork", sourceId: "work", title: "Initial", workspace: home, rolloutPath: path.join(home, "sessions", "target.jsonl"), projectId: null, updatedAt: 100_000 };
    return { thread: { id: target.threadId, cwd: home, path: target.rolloutPath } };
  } }), async () => ({ path: path.join(home, "staged.jsonl"), cleanup: async () => {} }), async () => true);
  const request: TransferTaskRequest = { operationId: "same-operation", startedAt: 100_000, task: { ...ref, title: "Preserved title", rolloutPath: path.resolve("source.jsonl") },
    targetSourceId: "work", projectId: "legacy-project", onForkCreated: task => { saved = task; } };
  await assert.rejects(transfer.fork(request), /metadata rejection/u);
  assert.equal(forks, 1); assert.equal(saved!.threadId, "one-fork");
  assert.equal(target!.title, request.task.title, "A rejected project assignment must not leave the fork with its initial prompt as title");
  rejectProject = false;
  const result = await transfer.fork({ ...request, existingTarget: saved! });
  assert.equal(forks, 1); assert.equal(result.threadId, "one-fork");
  assert.equal(result.title, request.task.title); assert.equal(result.projectId, visibleProject);
});

test("transfer does not confirm a project from an acknowledged database write alone", async () => {
  const home = path.resolve("fixture-target-home");
  const target: DesktopTask = { ...ref, threadId: "saved-copy", sourceId: "work", sourceLabel: ".codex-work", title: "Preserved title",
    workspace: home, rolloutPath: path.join(home, "sessions", "target.jsonl"), projectId: null, updatedAt: 1 };
  let writes = 0; let saved: DesktopTask | undefined;
  const transfer = new AppServerTaskTransfer({
    sourceHome: () => home, listSources: () => [{ id: "work", label: ".codex-work" }], listTasks: async () => [target],
    listProjects: async () => [{ id: "target-project", title: "Project", workspace: home }],
  }, {
    rename: async () => {}, archive: async () => assert.fail("Unconfirmed project must not archive the source"), markdown: async () => "",
    assignProject: async () => { writes++; },
  }, () => ({ call: async method => method === "thread/read"
    ? { thread: { id: target.threadId, forkedFromId: ref.threadId } }
    : assert.fail("Existing copy must not be forked again") }),
  async () => assert.fail("Existing copy must not be staged again"), async () => true);
  await assert.rejects(transfer.fork({ operationId: "same-operation", startedAt: 1, existingTarget: target,
    task: { ...ref, title: target.title, rolloutPath: path.resolve("source.jsonl") }, targetSourceId: "work", projectId: "target-project",
    onForkCreated: task => { saved = task; } }),
  error => error instanceof UncertainActionError && /назначение в приложении не подтверждено/u.test(error.message));
  assert.equal(writes, 1); assert.equal(saved?.threadId, target.threadId);
});

function fixedCreator(created: DesktopTask, create: () => void = () => {}): DesktopTaskCreator {
  return {
    createTask: async () => { create(); return created; }, interrupt: async () => false,
    details: () => null, isActive: () => false, onUpdate: () => () => {},
  };
}

test("new task creation is delegated once to the atomic creator", async () => {
  const created: DesktopTask = { ...ref, title: "Created", workspace: "/fixture", projectId: null, rolloutPath: "/codex/sessions/created.jsonl", updatedAt: 1 };
  const server = new Server(); let creations = 0;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [created], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 100), undefined, undefined, undefined, { creator: fixedCreator(created, () => { creations++; }) });
  const task = await adapter.createTask({ operationId: "initial-op", projectId: null, workspace: "/fixture", title: "Created", prompt: "Initial prompt", model: "model-a", effort: "high", environment: "local" });
  assert.equal(task.threadId, ref.threadId); assert.equal(creations, 1);
  assert.equal(server.received.some(message => message.method === "thread-follower-start-turn"), false);
});

test("an active first turn opens its configured client without waiting for impossible follower ownership", async () => {
  const created: DesktopTask = { ...ref, title: "Created", workspace: "/fixture", projectId: null, rolloutPath: "/codex/sessions/created.jsonl", updatedAt: 1 };
  const server = new Server(); let opens = 0;
  const creator = fixedCreator(created); creator.isActive = () => true;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [created], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 50), undefined, undefined, undefined, {
      creator, launcher: { open: async task => { assert.equal(task.threadId, created.threadId); opens++; } },
    });
  await adapter.ensureOpen(created);
  assert.equal(opens, 1); assert.equal(server.received.length, 0);
});

test("a rejected creation is not retried or replaced with a follower turn", async () => {
  const server = new Server(); const created: DesktopTask = { ...ref, title: "Created", workspace: "/fixture", projectId: null, updatedAt: 1 };
  let creations = 0;
  const creator = fixedCreator(created, () => { creations++; });
  creator.createTask = async () => { creations++; throw new ActionRejectedError("bad workspace"); };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [created], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 50), undefined, undefined, undefined, { creator });
  await assert.rejects(adapter.createTask({ operationId: "initial-op", projectId: null, workspace: "/fixture", title: "Created", prompt: "Initial", environment: "local" }), ActionRejectedError);
  assert.equal(creations, 1); assert.equal(server.received.some(message => message.method === "thread-follower-start-turn"), false);
});

test("a generic desktop discovery rejection never launches a client or starts a substitute turn", async () => {
  const server = new Server(); server.rejectDiscovery = true;
  server.discoveryError = "private backend error";
  const task = { ...ref, title: "New projectless task", workspace: "/fixture", updatedAt: 1 };
  let opens = 0;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 100), undefined, undefined, undefined,
    { launcher: { open: async () => { opens++; } } });
  await assert.rejects(adapter.submitWithReceipt({ operationId: "unloaded-operation", task, text: "Continue safely" }), DesktopRequestRejectedError);
  assert.equal(server.received.some(message => message.method === "thread-follower-start-turn" || message.method === "thread-follower-steer-turn"), false);
  assert.equal(opens, 0);
});

test("fresh input reopens a task after desktop restart, then reuses its live owner", async () => {
  const task = { ...ref, title: "Existing task", workspace: "/fixture", updatedAt: 1, rolloutPath: "/fixture/sessions/task.jsonl" };
  const servers: Server[] = [];
  let loaded = true;
  let opens = 0;
  let accessChecks = 0;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
    const server = new Server(); servers.push(server);
    server.rejectDiscovery = !loaded;
    server.dataState = { ...state([], "completed"), rolloutPath: task.rolloutPath, resumeState: "resumed" };
    return new DesktopIpcClient(() => server, 100);
  }, undefined, undefined, undefined, { launcher: { open: async opened => {
    assert.deepEqual(opened, task); assert.ok(accessChecks > 0); loaded = true; opens++;
  } } });
  const submit = (operationId: string) => adapter.submitWithReceipt({ operationId, task, text: "Continue", beforeSend: async () => { accessChecks++; } });
  await submit("before-restart");
  assert.equal(opens, 0);
  loaded = false; accessChecks = 0;
  assert.deepEqual(await submit("after-restart"), { mode: "start", turnId: "next-turn" });
  assert.equal(opens, 1);
  await submit("already-connected");
  assert.equal(opens, 1);
  const writes = servers.flatMap(server => server.received).filter(message => message.method === "thread-follower-start-turn");
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map(message => ((message.params as IpcObject).turnStart as IpcObject).request).map(request => (request as IpcObject).clientUserMessageId), ["before-restart", "after-restart", "already-connected"]);
});

test("reopening cannot send input to a different rollout or bypass a cancelled binding", async () => {
  const task = { ...ref, title: "Existing task", workspace: "/fixture", updatedAt: 1, rolloutPath: "/selected/sessions/task.jsonl" };
  for (const cancelled of [false, true]) {
    const servers: Server[] = [];
    let opened = false;
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
      const server = new Server(); servers.push(server); server.rejectDiscovery = !opened;
      server.dataState = { ...state([], "completed"), rolloutPath: "/other/sessions/task.jsonl" };
      return new DesktopIpcClient(() => server, 100);
    }, undefined, undefined, undefined, { launcher: { open: async () => { opened = true; } } });
    await assert.rejects(adapter.submitWithReceipt({ operationId: "blocked", task, text: "Continue", beforeSend: async () => {
      if (cancelled) throw new ActionRejectedError("binding cancelled");
    } }), cancelled ? /binding cancelled/ : /другой копии/);
    assert.equal(opened, !cancelled);
    assert.equal(servers.flatMap(server => server.received).some(message => message.method === "thread-follower-start-turn"), false);
  }
});

test("read-only task operations never invoke the configured launcher", async () => {
  const server = new Server(); server.rejectDiscovery = true;
  const task = { ...ref, title: "Unloaded", workspace: "/fixture", updatedAt: 1 };
  let opens = 0;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 100), undefined, undefined, undefined,
    { launcher: { open: async () => { opens++; } } });
  await assert.rejects(adapter.inspectTask(task), TaskNotOpenError);
  assert.equal(opens, 0);
});

test("an idle or unloaded task starts the next turn through its owner with inherited settings", async () => {
  for (const [status, runtimeStatus] of [["completed", "idle"], ["interrupted", "idle"], ["failed", "idle"], ["completed", "notLoaded"]] as const) {
    const server = new Server(); server.dataState = { ...state([], status), resumeState: "resumed", threadRuntimeStatus: { type: runtimeStatus } };
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
    await adapter.submit({ operationId: "message", task: ref, text: "Continue" });
    const request = server.received.find(message => message.method === "thread-follower-start-turn")!;
    assert.equal(adapter.capabilities.startTurn, true);
    assert.equal(adapter.capabilities.createTask, false);
    assert.equal(request.version, 2);
    assert.equal(request.targetClientId, "owner");
    assert.deepEqual(request.params, {
      conversationId: ref.threadId,
      turnStart: {
        request: { threadId: ref.threadId, clientUserMessageId: "message", input: [{ type: "text", text: withVkResponseFormat("Continue"), text_elements: [] }] },
        context: { inheritThreadSettings: true },
      },
    });
    assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn" || message.method === "thread/start" || message.method === "thread/resume"), false);
    assert.ok(server.destroyed);
  }
});

test("submission waits for a large task's delayed initial desktop snapshot", async () => {
  const server = new Server();
  server.dataState = { ...state([], "completed"), resumeState: "resumed", threadRuntimeStatus: { type: "systemError" } };
  server.onFollow = () => setTimeout(() => server.snapshot(), 2_100);
  const task = { ...ref, title: "Large task", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 100));
  await adapter.submit({ operationId: "after-large-snapshot", task, text: "Continue" });
  assert.equal(server.received.filter(message => message.method === "thread-follower-start-turn").length, 1);
});

test("submission waits for a transient active snapshot to settle before starting the next turn", async () => {
  const server = new Server();
  server.dataState = { ...state([], "completed"), resumeState: "resumed", threadRuntimeStatus: { type: "active" } };
  server.onFollow = () => {
    server.snapshot();
    setTimeout(() => {
      server.dataState = { ...state([], "completed"), resumeState: "resumed", threadRuntimeStatus: { type: "idle" } };
      server.snapshot();
    }, 20);
  };
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 100), undefined, undefined, undefined, { stateSettleMs: 200 });
  await adapter.submit({ operationId: "message", task: ref, text: "Continue" });
  assert.equal(server.received.filter(message => message.method === "thread-follower-start-turn").length, 1);
  assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn"), false);
});

test("submission waits for resynchronization between access checks and sends only from the fresh state", async () => {
  const server = new Server(); server.dataState = state([], "completed");
  let follows = 0; let checks = 0;
  server.onFollow = () => {
    if (++follows === 1) server.snapshot();
    else setTimeout(() => { server.dataState = state([], "inProgress"); server.snapshot(); }, 25);
  };
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 100));
  const receipt = await adapter.submitWithReceipt({ operationId: "resync-message", task, text: "Continue", beforeSend: async () => {
    if (++checks !== 2) return;
    for (const revision of [901, 902]) server.send({ type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: "owner", targetClientIds: ["bridge-client"],
      params: { hostId: ref.hostId, conversationId: ref.threadId, change: { type: "patches", baseRevision: revision - 1, revision, patches: [] } } });
    await new Promise(resolve => setTimeout(resolve, 1));
  } });
  assert.deepEqual(receipt, { mode: "steer", turnId: "fixture-turn" });
  assert.equal(follows, 2);
  assert.equal(server.received.filter(message => message.method === "thread-follower-start-turn").length, 0);
  assert.equal(server.received.filter(message => message.method === "thread-follower-steer-turn").length, 1);
});

test("a connection lost before writing is reattached once without reopening the application", async () => {
  const servers: Server[] = []; let checks = 0; let opens = 0;
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
    const server = new Server(); server.dataState = state([], "completed"); servers.push(server);
    return new DesktopIpcClient(() => server, 100);
  }, undefined, undefined, undefined, { launcher: { open: async () => { opens++; } } });
  const receipt = await adapter.submitWithReceipt({ operationId: "connection-loss", task, text: "Continue", beforeSend: async () => {
    if (++checks !== 2) return;
    servers[0]!.destroy();
    await new Promise<void>(resolve => setImmediate(resolve));
  } });
  assert.deepEqual(receipt, { mode: "start", turnId: "next-turn" });
  assert.equal(servers.length, 2); assert.equal(opens, 0);
  assert.equal(servers[0]!.received.some(message => message.method === "thread-follower-start-turn"), false);
  assert.equal(servers[1]!.received.filter(message => message.method === "thread-follower-start-turn").length, 1);
});

test("pre-send retries are bounded and protocol failures retain their cause", async () => {
  for (const protocolFailure of [false, true]) {
    const servers: Server[] = []; let checks = 0; let opens = 0;
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
      const server = new Server(); server.dataState = state([], "completed"); servers.push(server);
      return new DesktopIpcClient(() => server, 100);
    }, undefined, undefined, undefined, { launcher: { open: async () => { opens++; } } });
    await assert.rejects(adapter.submitWithReceipt({ operationId: "failure", task, text: "Continue", beforeSend: async () => {
      if (++checks % 2 !== 0) return;
      if (protocolFailure) servers.at(-1)!.snapshot(10);
      else servers.at(-1)!.destroy();
      await new Promise<void>(resolve => setImmediate(resolve));
    } }), protocolFailure ? /Версия событий/ : DesktopUnavailableError);
    assert.equal(servers.length, protocolFailure ? 1 : 2);
    assert.equal(opens, 0);
    assert.equal(servers.flatMap(server => server.received).some(message => message.method === "thread-follower-start-turn"), false);
  }
});

test("editing the last standalone VK turn uses the desktop owner and returns the replacement identity", async () => {
  const server = new Server();
  server.dataState = { id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "idle" }, turns: [{
    turnId: "fixture-turn", turnStartedAtMs: 100, status: "completed",
    params: { clientUserMessageId: "vk-operation", input: [{ type: "text", text: "Old request" }] },
    items: [{ type: "userMessage", id: "user", clientId: "vk-operation", content: [{ type: "text", text: "Old request" }] }],
  }] };
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 100));
  const result = await adapter.editLastUserTurn({ task: ref, operationId: "vk-operation", expectedOperationId: "vk-operation", expectedTurnId: "fixture-turn", text: "Corrected request" });
  const request = server.received.find(message => message.method === "thread-follower-edit-last-user-turn")!;
  assert.equal(request.version, 1); assert.equal(request.targetClientId, "owner");
  assert.deepEqual(request.params, { conversationId: ref.threadId, turnId: "fixture-turn", message: withVkResponseFormat("Corrected request") });
  assert.deepEqual(result, { turnId: "replacement-turn", operationId: "replacement-operation" });
});

test("editing never rewrites an older or already-steered turn", async () => {
  for (const stateOverride of [
    { turnId: "another-turn", params: { clientUserMessageId: "vk-operation" }, items: [] },
    { turnId: "fixture-turn", params: { clientUserMessageId: "vk-operation" }, items: [{ type: "steeringUserMessage" }] },
  ]) {
    const server = new Server();
    server.dataState = { id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "idle" }, turns: [{
      turnStartedAtMs: 100, status: "completed", ...stateOverride,
    }] };
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 100));
    await assert.rejects(adapter.editLastUserTurn({ task: ref, operationId: "vk-operation", expectedOperationId: "vk-operation", expectedTurnId: "fixture-turn", text: "Corrected" }), ActionRejectedError);
    assert.equal(server.received.some(message => message.method === "thread-follower-edit-last-user-turn"), false);
  }
});

test("an explicit idle runtime ignores an orphaned in-progress history turn", async () => {
  const server = new Server();
  server.dataState = {
    id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "idle" },
    turns: [
      { turnId: "orphan", turnStartedAtMs: 100, status: "inProgress", items: [] },
      { turnId: "latest", turnStartedAtMs: 200, status: "completed", items: [] },
    ],
  };
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 50), undefined, undefined, undefined, { stateSettleMs: 5 });
  await adapter.submit({ operationId: "message", task: ref, text: "Continue" });
  assert.equal(server.received.filter(message => message.method === "thread-follower-start-turn").length, 1);
  assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn"), false);
  const projected = projectSnapshot(server.dataState, null, 300);
  assert.deepEqual(projected.checkpoint.active, []);
  assert.equal(projected.events.some(event => event.type === "status" && event.status === "running"), false);
});

test("an idle runtime with a possibly current in-progress turn fails closed", async () => {
  const server = new Server();
  server.dataState = {
    id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "idle" },
    turns: [{ turnId: "possibly-current", turnStartedAtMs: 200, status: "inProgress", items: [] }],
  };
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
    () => new DesktopIpcClient(() => server, 50), undefined, undefined, undefined, { stateSettleMs: 5 });
  await assert.rejects(adapter.submit({ operationId: "message", task: ref, text: "Continue" }), error => error instanceof ActionRejectedError && /противоречивое состояние/u.test(error.message));
  assert.equal(server.received.some(message => message.method === "thread-follower-start-turn" || message.method === "thread-follower-steer-turn"), false);
});

test("resuming a goal wakes an idle live owner with an empty inherited turn and never steers an active turn", async () => {
  for (const status of ["completed", "inProgress"] as const) {
    const server = new Server(); server.dataState = { ...state([], status), resumeState: "resumed", threadRuntimeStatus: { type: status === "inProgress" ? "active" : "idle" } };
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
    await adapter.continueGoal(ref);
    const starts = server.received.filter(message => message.method === "thread-follower-start-turn");
    assert.equal(starts.length, status === "completed" ? 1 : 0);
    if (status === "completed") {
      const request = starts[0]!;
      assert.equal(request.version, 2); assert.equal(request.targetClientId, "owner");
      const params = request.params as IpcObject;
      assert.equal(params.conversationId, ref.threadId);
      assert.deepEqual(((params.turnStart as IpcObject).request as IpcObject).input, []);
      assert.equal(typeof ((params.turnStart as IpcObject).request as IpcObject).clientUserMessageId, "string");
      assert.deepEqual((params.turnStart as IpcObject).context, { inheritThreadSettings: true });
    }
    assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn"), false);
    assert.ok(server.destroyed);
  }
});

test("starting placeholders without a turn ID are steered rather than mistaken for idle tasks", async () => {
  for (const canonical of [true, false]) {
    const server = new Server();
    const placeholder = { turnId: null, status: "inProgress", items: [] };
    server.dataState = { id: ref.threadId, hostId: ref.hostId, turns: canonical ? [] : [placeholder], ...(canonical ? { turnHistory: { history: { entitiesByKey: { pending: placeholder } } } } : {}) };
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
    await adapter.submit({ operationId: "message", task: ref, text: "Follow-up" });
    assert.equal(server.received.filter(message => message.method === "thread-follower-steer-turn").length, 1);
    assert.equal(server.received.some(message => message.method === "thread-follower-start-turn"), false);
  }
});

test("pending desktop requests reject input even while a turn is active", async () => {
  const server = new Server(); server.dataState = { ...state(), requests: [{ id: "pending-approval" }] };
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
  await assert.rejects(adapter.submit({ operationId: "message", task: ref, text: "Continue" }), error => error instanceof ActionRejectedError && /подтверждение или вопрос/u.test(error.message));
  assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn" || message.method === "thread-follower-start-turn"), false);
  assert.ok(server.destroyed);
});

test("unconfirmed idle state and pending questions never start a new turn", async () => {
  for (const overrides of [
    { resumeState: "resuming" },
    { resumeState: "needs_resume" },
    { threadRuntimeStatus: { type: "active" } },
    { requests: [{ id: "pending-approval" }] },
    { turns: [], turnHistory: null },
  ]) {
    const server = new Server(); server.dataState = { ...state([], "completed"), ...overrides };
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] },
      () => new DesktopIpcClient(() => server, 50), undefined, undefined, undefined, { stateSettleMs: 5 });
    await assert.rejects(adapter.submit({ operationId: "message", task: ref, text: "Continue" }), ActionRejectedError);
    assert.equal(server.received.some(message => String(message.method).startsWith("thread-follower-")), false);
    assert.ok(server.destroyed);
  }
});

test("a failed or malformed start acknowledgment is uncertain and never retried as start or steer", async () => {
  for (const mode of ["disconnect", "rejection", "missing-turn", "empty-turn-id"] as const) {
    const server = new Server(); server.dataState = state([], "completed");
    server.disconnectOnStart = mode === "disconnect";
    server.rejectStart = mode === "rejection";
    if (mode === "missing-turn") server.startResult = { turnId: "wrong-response-shape" };
    if (mode === "empty-turn-id") server.startResult = { turn: { id: "" } };
    const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
    await assert.rejects(adapter.submit({ operationId: "message", task: ref, text: "Continue" }), error => error instanceof UncertainActionError && !error.message.includes("private backend error"));
    assert.equal(server.received.filter(message => message.method === "thread-follower-start-turn").length, 1);
    assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn"), false);
    assert.ok(server.destroyed);
  }
});

test("invalid text is rejected before opening a desktop connection", async () => {
  let connections = 0;
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => { connections++; return new DesktopIpcClient(); });
  for (const text of [" ", "x".repeat(64_001)]) await assert.rejects(adapter.submit({ operationId: "message", task: ref, text }), ActionRejectedError);
  assert.equal(connections, 0);
});

test("snapshot projection baselines all initial history and reasoning, then emits stable new events", () => {
  const initial = state([
    { type: "userMessage", id: "initial", content: [{ type: "text", text: "Initial prompt" }] },
    { type: "reasoning", id: "private", content: "Never mirror reasoning" },
    { type: "agentMessage", id: "progress", phase: "commentary", text: "Working" },
    { type: "agentMessage", id: "answer", phase: "final_answer", text: "Partial" },
  ]);
  const first = projectSnapshot(initial, null, 200);
  assert.equal(first.events.some(event => event.type === "user" || event.type === "progress" || event.type === "final"), false);
  assert.equal(JSON.stringify(first.events).includes("reasoning"), false);
  assert.equal(projectSnapshot(initial, first.checkpoint).events.length, 0);
  const completed = state([
    { type: "userMessage", id: "new-user", clientId: "operation", content: [{ type: "text", text: "Desktop message" }] },
    { type: "agentMessage", id: "answer", phase: "final_answer", text: "Full answer" },
  ], "completed");
  const next = projectSnapshot(completed, first.checkpoint);
  assert.ok(next.events.some(event => event.type === "final" && event.text === "Full answer"));
  assert.ok(next.events.some(event => event.type === "user" && event.operationId === "operation"));
  assert.equal(projectSnapshot(completed, next.checkpoint).events.length, 0);
});

test("a reconnected subscription recovers new finals but not accumulated progress", () => {
  const attached = projectSnapshot(state([], "completed"), null, 100);
  const missed = {
    id: ref.threadId, hostId: ref.hostId, turns: [], turnHistory: { history: { entitiesByKey: {
      old: { turnId: "old", turnStartedAtMs: 50, status: "completed", items: [
        { type: "agentMessage", id: "old-final", phase: "final_answer", text: "Before linking" },
      ] },
      missed: { turnId: "missed", turnStartedAtMs: 200, status: "completed", items: [
        { type: "userMessage", id: "direct-user", content: [{ type: "text", text: "Sent in Codex while offline" }] },
        ...Array.from({ length: 100 }, (_, index) => (
          { type: "agentMessage", id: `old-${index}`, phase: index === 99 ? "final_answer" : "commentary", text: `Old ${index}` }
        )),
      ] },
      current: { turnId: "current", turnStartedAtMs: 300, status: "inProgress", items: [
        { type: "agentMessage", id: "accumulated", phase: "commentary", text: "Accumulated while offline" },
      ] },
    } } },
  };
  const reconnected = projectSnapshot(missed, attached.checkpoint, 400, { rebaseline: true });
  assert.deepEqual(reconnected.events.filter(event => event.type !== "status"), [
    { type: "user", id: "direct-user", turnId: "missed", text: "Sent in Codex while offline" },
    { type: "final", id: "old-99", turnId: "missed", text: "Old 99" },
  ]);
  assert.equal(projectSnapshot(missed, reconnected.checkpoint, 450, { rebaseline: true }).events.length, 0);
  const updated = structuredClone(missed);
  const current = (updated.turnHistory as IpcObject).history as IpcObject;
  const entities = current.entitiesByKey as IpcObject;
  (entities.current as IpcObject).items = [...((entities.current as IpcObject).items as unknown[]),
    { type: "agentMessage", id: "fresh", phase: "commentary", text: "Fresh after reconnect" }];
  const next = projectSnapshot(updated, reconnected.checkpoint, 500);
  assert.deepEqual(next.events.filter(event => event.type === "progress").map(event => event.text), ["Fresh after reconnect"]);
});

test("a reconnect recovers only the undelivered final of a turn accepted from VK", () => {
  const attached = projectSnapshot(state([], "completed"), null, 100);
  const completed = state([
    { type: "userMessage", id: "request", clientId: "operation", content: [{ type: "text", text: "From VK" }] },
    { type: "agentMessage", id: "progress", phase: "commentary", text: "Accumulated progress" },
    { type: "agentMessage", id: "answer", phase: "final_answer", text: "Recovered answer" },
  ], "completed");
  const completedHistory = (completed.turnHistory as IpcObject).history as IpcObject;
  ((completedHistory.entitiesByKey as IpcObject).tail as IpcObject).turnId = "accepted-turn";
  const baseline = projectSnapshot(completed, attached.checkpoint, 300, { rebaseline: true });
  assert.equal(baseline.events.length, 0);
  const recovered = projectSnapshot(completed, baseline.checkpoint, 400, {
    rebaseline: true, recoverFinalTurnIds: ["accepted-turn"], finalRecorded: () => false,
  });
  assert.deepEqual(recovered.events.filter(event => event.type !== "status"), [
    { type: "final", id: "answer", turnId: "accepted-turn", text: "Recovered answer" },
  ]);
  assert.equal(projectSnapshot(completed, recovered.checkpoint, 500, {
    rebaseline: true, recoverFinalTurnIds: ["accepted-turn"], finalRecorded: () => true,
  }).events.length, 0);
});

test("a newer failed turn stops an older thinking indicator despite a stale active runtime", async t => {
  const s = runtimeSetup(t); await s.runtime.tick();
  s.server.dataState = {
    id: ref.threadId, hostId: ref.hostId, resumeState: "resumed", threadRuntimeStatus: { type: "active" },
    turns: [
      { turnId: "orphan", turnStartedAtMs: 100, status: "inProgress", items: [] },
      { turnId: "latest", turnStartedAtMs: 200, status: "failed", items: [{ type: "error", errorInfo: "internal" }] },
    ],
  };
  s.server.snapshot(); await new Promise(resolve => setImmediate(resolve)); await s.runtime.tick();
  assert.equal(taskDetails(s.server.dataState).status, "failed");
  assert.deepEqual(projectSnapshot(s.server.dataState, null, 300).checkpoint.active, []);
  assert.equal(s.store.getValue<{ status: string }>(`activity:${s.binding.id}`)?.status, "failed");
  const edits = s.edits.length;
  s.advance(20_000); await s.runtime.tick();
  assert.equal(s.edits.length, edits);
});

test("snapshot projection does not mirror quiet scheduler heartbeats", () => {
  const initial = projectSnapshot(state([], "completed"), null, 100);
  const prompt = `<heartbeat><automation_id>monitor</automation_id><current_time_iso>2026-09-19T17:00:00Z</current_time_iso><instructions>Check.</instructions></heartbeat>`;
  const completed = state([
    { type: "userMessage", id: "scheduler", content: [{ type: "text", text: prompt }] },
    { type: "agentMessage", id: "progress", phase: "commentary", text: "Internal progress" },
    { type: "agentMessage", id: "answer", phase: "final_answer", text: "<heartbeat><automation_id>monitor</automation_id><decision>DONT_NOTIFY</decision><message>Quiet.</message></heartbeat>" },
  ], "completed");
  const next = projectSnapshot(completed, initial.checkpoint, 200);
  assert.deepEqual(next.events.filter(event => event.type !== "status"), []);
  const partial = projectSnapshot(state([
    { type: "agentMessage", id: "partial-progress", phase: "commentary", text: "Still quiet" },
  ]), next.checkpoint, 300);
  assert.deepEqual(partial.events.filter(event => event.type !== "status"), []);
});

test("a reconnect recovers the terminal status of an accepted interrupted turn", () => {
  const attached = projectSnapshot(state([], "completed"), null, 100);
  const interrupted = state([
    { type: "userMessage", id: "request", clientId: "operation", content: [{ type: "text", text: "From VK" }] },
  ], "interrupted");
  const history = (interrupted.turnHistory as IpcObject).history as IpcObject;
  ((history.entitiesByKey as IpcObject).tail as IpcObject).turnId = "accepted-turn";
  const baseline = projectSnapshot(interrupted, attached.checkpoint, 300, { rebaseline: true });
  assert.equal(baseline.events.length, 0);
  const recovered = projectSnapshot(interrupted, baseline.checkpoint, 400, {
    rebaseline: true, recoverFinalTurnIds: ["accepted-turn"], finalRecorded: () => false,
  });
  assert.deepEqual(recovered.events, [
    { type: "status", id: "status:accepted-turn", turnId: "accepted-turn", status: "interrupted" },
  ]);
});

test("editing a Codex message does not replay history rebuilt with new item ids", () => {
  const attached = projectSnapshot({ id: ref.threadId, hostId: ref.hostId, rolloutPath: "C:/profiles/work/sessions/base.jsonl", turns: [] }, null, 100);
  const beforeEdit = { id: ref.threadId, hostId: ref.hostId, rolloutPath: "C:/profiles/work/sessions/base.jsonl", turns: [{
    turnId: "live-turn", turnStartedAtMs: 200, status: "completed", items: [
      { type: "userMessage", id: "01a-live-user", content: [{ type: "text", text: "Original request" }] },
      { type: "agentMessage", id: "msg_live_progress", phase: "commentary", text: "Existing progress" },
      { type: "agentMessage", id: "msg_live_final", phase: "final_answer", text: "Existing final" },
    ],
  }] };
  const delivered = projectSnapshot(beforeEdit, attached.checkpoint, 300);
  assert.deepEqual(delivered.events.filter(event => event.type !== "status").map(event => event.type), ["user", "progress", "final"]);

  // The desktop edit route serializes the already delivered live msg_* events
  // again as canonical item-* events. Only genuinely changed content may pass.
  const afterEdit = { id: ref.threadId, hostId: ref.hostId, rolloutPath: "C:/profiles/work/sessions/edited.jsonl", turns: [{
    turnId: "rebuilt-turn", turnStartedAtMs: 200, status: "completed", items: [
      { type: "userMessage", id: "item-7597", content: [{ type: "text", text: "Original request" }] },
      { type: "agentMessage", id: "item-7599", phase: "commentary", text: "Existing progress" },
      { type: "agentMessage", id: "item-7809", phase: "final_answer", text: "Existing final" },
    ],
  }, {
    turnId: "edited-turn", turnStartedAtMs: 400, status: "completed", items: [
      { type: "userMessage", id: "01a-edited-user", content: [{ type: "text", text: "Original request" }] },
      { type: "agentMessage", id: "msg_edited_final", phase: "final_answer", text: "New final" },
    ],
  }] };
  const rebuilt = projectSnapshot(afterEdit, delivered.checkpoint, 500);
  assert.deepEqual(rebuilt.events.filter(event => event.type !== "status").map(event => [event.type, event.text]), [
    ["final", "New final"],
  ]);
  assert.equal(projectSnapshot(afterEdit, rebuilt.checkpoint, 600).events.length, 0);

  const secondEdit = structuredClone(afterEdit);
  secondEdit.rolloutPath = "C:/profiles/work/sessions/edited-again.jsonl";
  secondEdit.turns[1]!.items = [
    { type: "userMessage", id: "01a-second-edit-user", content: [{ type: "text", text: "Edited request" }] },
    { type: "agentMessage", id: "msg_second_edit_final", phase: "final_answer", text: "Newest final" },
  ];
  const editedAgain = projectSnapshot(secondEdit, rebuilt.checkpoint, 650);
  assert.deepEqual(editedAgain.events.filter(event => event.type !== "status").map(event => [event.type, event.text]), [
    ["user", "Edited request"], ["final", "Newest final"],
  ]);

  const repeated = structuredClone(secondEdit);
  repeated.turns.push({ turnId: "legitimate-repeat", turnStartedAtMs: 700, status: "inProgress", items: [
    { type: "userMessage", id: "new-repeat", content: [{ type: "text", text: "Edited request" }] },
  ] });
  assert.deepEqual(projectSnapshot(repeated, editedAgain.checkpoint, 800).events.filter(event => event.type === "user").map(event => event.id), ["new-repeat"]);
});

test("accepted steering metadata correlates a server message with the originating VK operation", () => {
  const initial = projectSnapshot(state(), null, 200);
  const next = projectSnapshot(state([
    { type: "userMessage", id: "server-message", content: [{ type: "text", text: "Follow-up" }] },
    { type: "steeringUserMessage", id: "steer", status: "accepted", serverUserMessageId: "server-message", clientUserMessageId: "operation" },
  ]), initial.checkpoint);
  assert.ok(next.events.some(event => event.type === "user" && event.operationId === "operation"));
});

test("projection excludes commands, tool calls and file changes entirely", () => {
  const result = projectSnapshot(state([
    { type: "commandExecution", id: "command", command: "secret-command", aggregatedOutput: "secret-output", status: "completed", exitCode: 0 },
    { type: "mcpToolCall", id: "tool", arguments: { secret: "secret-argument" } },
    { type: "fileChange", id: "files", changes: [{ path: "/fixture/source.ts", diff: "secret-diff" }], status: "completed" },
  ]), null, 200);
  assert.doesNotMatch(JSON.stringify(result.events), /secret/u);
  assert.doesNotMatch(JSON.stringify(result.events), /source\.ts|Команда|Файлы/u);
  assert.equal(result.events.some(event => event.type === "progress"), false);
});

test("catalog includes API-created user tasks but excludes archived and subagent tasks", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, thread_source TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER, is_pinned INTEGER, recency_at_ms INTEGER);
    INSERT INTO threads VALUES ('main', 'Renamed by user', 'Old title', '/fixture', 'user', 'vscode', 0, 1000, 1, 0, 1000);
    INSERT INTO threads VALUES ('api', 'Created through API', '', '/fixture', 'agent_created_thread', 'vscode', 0, 900, 1, 0, 900);
    INSERT INTO threads VALUES ('agent', 'Agent', 'Agent', '/fixture', 'subagent', 'vscode', 0, 2000, 2, 0, 2000);
    INSERT INTO threads VALUES ('archived', 'Archived', 'Archived', '/fixture', 'user', 'vscode', 1, 3000, 3, 0, 3000);`);
  const tasks = readTaskCatalog(db);
  assert.deepEqual(tasks.map(task => [task.threadId, task.title]), [["main", "Renamed by user"], ["api", "Created through API"]]);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM threads").get(), { n: 4 });
  assert.equal(tasks[0]!.hostId, "local");
});

test("session index selects the newest title even if its records arrive out of order", () => {
  const index = [
    { id: "task", thread_name: "Latest desktop title", updated_at: "2026-01-03T12:00:00Z" },
    { id: "task", thread_name: "Older title", updated_at: "2026-01-01T12:00:00Z" },
    { id: "other", thread_name: "Other task", updated_at: "2026-01-02T12:00:00Z" },
    { id: "task", thread_name: "Final desktop title", updated_at: "2026-01-03T12:00:00Z" },
  ].map(row => JSON.stringify(row)).join("\n");
  assert.deepEqual([...parseTaskTitles(index)], [["task", "Final desktop title"], ["other", "Other task"]]);
});

test("session index ignores blank, malformed and incomplete records without losing valid names", () => {
  const index = [
    JSON.stringify({ id: "task", thread_name: "Desktop title", updated_at: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ id: "task", thread_name: "   ", updated_at: "2026-01-02T00:00:00Z" }),
    JSON.stringify({ id: "task", thread_name: "Invalid date", updated_at: "broken" }),
    JSON.stringify({ id: "other", thread_name: 42, updated_at: "2026-01-01T00:00:00Z" }),
    "null", "[]", "", "malformed", '{"id":"partial"',
  ].join("\n");
  assert.deepEqual([...parseTaskTitles(index)], [["task", "Desktop title"]]);
});

test("desktop index overrides SQLite names and initial prompts without changing the database", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, thread_source TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER, is_pinned INTEGER, recency_at_ms INTEGER)");
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, '/fixture', 'user', 'vscode', 0, 1000, 1, 0, 1000)");
  insert.run("indexed", "Stale database name", "private initial prompt\nwith details");
  insert.run("unnamed", null, "private initial prompt\nwith details");
  insert.run("long", "  ", "x".repeat(300));
  insert.run("short", null, "Short legacy title");
  const before = db.prepare("SELECT * FROM threads ORDER BY id").all();
  const titles = parseTaskTitles(JSON.stringify({ id: "indexed", thread_name: "Renamed in desktop", updated_at: "2026-01-01T00:00:00Z" }));
  const tasks = readTaskCatalog(db, 100, titles);
  const names = new Map(tasks.map(task => [task.threadId, task.title]));
  assert.equal(names.get("indexed"), "Renamed in desktop");
  assert.equal(names.get("unnamed"), "Без названия · unnamed");
  assert.equal(names.get("long"), "Без названия · long");
  assert.equal(names.get("short"), "Short legacy title");
  assert.doesNotMatch(JSON.stringify(tasks), /private initial prompt/u);
  assert.deepEqual(db.prepare("SELECT * FROM threads ORDER BY id").all(), before);
});


test("native questions distinguish blocking requests, async questions, and approvals", () => {
  const snapshot = { ...state([{ type: "agentMessage", id: "ask-1", delivery: "async", text: "", questions: [{ title: "Choose", options: ["One", "Two"] }] }]),
    requests: [questionRequest, { ...questionRequest, id: 43, completed: true }, { id: 99, method: "item/commandExecution/requestApproval", params: {} }] };
  const questions = pendingCodexQuestions(snapshot);
  assert.equal(questions.length, 2);
  assert.equal(questions[0]!.requestId, 42);
  assert.equal(questions[1]!.kind, "async");
  const q = questions[1]!.questions[0]!;
  assert.equal(q.id, JSON.stringify(["request_user_input_async", "ask-1", 0]));
  const text = asyncQuestionReply([{ questionItemId: q.id, question: q.title, answer: "Two" }]);
  assert.equal(parseAsyncQuestionReply([{ type: "text", text }])[0]!.answer, "Two");
  const asyncItem = { type: "agentMessage", id: "ask-1", delivery: "async", text: "", questions: [{ title: "Choose", options: ["One", "Two"] }] };
  assert.equal(pendingCodexQuestions(state([asyncItem, { type: "steeringUserMessage", status: "pending", input: [{ type: "text", text }] }])).length, 1);
  assert.equal(pendingCodexQuestions(state([asyncItem, { type: "steeringUserMessage", status: "accepted", input: [{ type: "text", text }] }])).length, 0);
  assert.equal(pendingCodexQuestions(state([asyncItem], "completed")).length, 0);
  assert.equal(taskDetails(state([asyncItem])).status, "running");
});

test("blocking question answers use the owner request ID and native answer map", async () => {
  const server = new Server(); server.dataState = { ...state(), requests: [questionRequest] };
  const desktop = new ConnectedDesktopTasks({ listTasks: async () => [{ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 100));
  let gated = false;
  await desktop.answerQuestions(ref, pendingCodexQuestions(server.dataState)[0]!, { choice: "custom answer" }, "answer-op", async () => { gated = true; });
  assert.ok(gated);
  const write = server.received.find(m => m.method === "thread-follower-submit-user-input")!;
  assert.equal(write.version, 1);
  assert.deepEqual(write.params, { conversationId: ref.threadId, requestId: 42, response: { answers: { choice: { answers: ["custom answer"] } } } });
  assert.equal(server.received.some(m => m.method === "thread-follower-start-turn" || m.method === "thread-follower-steer-turn"), false);
});

test("async answers use Codex's question-reply envelope and never start a new turn", async () => {
  const server = new Server(); server.dataState = state([{ type: "agentMessage", id: "async-q", delivery: "async", text: "Question?" }]);
  const question = pendingCodexQuestions(server.dataState)[0]!;
  const desktop = new ConnectedDesktopTasks({ listTasks: async () => [{ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 100));
  await desktop.answerQuestions(ref, question, { "async-q": "Yes" }, "async-op", async () => {});
  const write = server.received.find(m => m.method === "thread-follower-steer-turn")!;
  const p = write.params as IpcObject;
  assert.equal(p.clientUserMessageId, "async-op");
  assert.deepEqual(parseAsyncQuestionReply(p.input), [{ questionItemId: "async-q", question: "Question?", answer: "Yes" }]);
  assert.equal(server.received.some(m => m.method === "thread-follower-start-turn"), false);
});

test("closed or changed native questions cannot become ordinary prompts", async () => {
  for (const changed of [false, true]) {
    const server = new Server();
    const question = pendingCodexQuestions({ ...state(), requests: [questionRequest] })[0]!;
    server.dataState = { ...state(), requests: changed ? [{ ...questionRequest, params: { ...questionRequest.params, questions: [{ id: "choice", question: "Changed question?", options: [] }] } }] : [] };
    const desktop = new ConnectedDesktopTasks({ listTasks: async () => [{ ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 100));
    await assert.rejects(desktop.answerQuestions(ref, question, { choice: "Yes" }, "op", async () => {}), ActionRejectedError);
    assert.equal(server.received.some(m => String(m.method).startsWith("thread-follower-")), false);
  }
});
