import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { parseTaskTitles, readTaskCatalog } from "../src/desktop/catalog.js";
import { ActionRejectedError, UncertainActionError } from "../src/desktop/contracts.js";
import { ConnectedDesktopTasks } from "../src/desktop/desktop-tasks.js";
import { DesktopIpcClient, encodeFrame, FrameDecoder, isObject, type IpcObject } from "../src/desktop/ipc-client.js";
import { projectSnapshot } from "../src/desktop/projector.js";
import { RevisionedState } from "../src/desktop/state.js";
import { TaskSubscription } from "../src/desktop/subscription.js";
import { DesktopBridgeRuntime } from "../src/bridge/runtime.js";
import { BridgeStore } from "../src/bridge/store.js";
import type { BridgeChat, View } from "../src/bridge/contracts.js";

const ref = { hostId: "local", threadId: "fixture-task" };
const state = (items: IpcObject[] = [], status = "inProgress"): IpcObject => ({ id: ref.threadId, hostId: ref.hostId, turns: [], turnHistory: { history: { entitiesByKey: {
  tail: { turnId: "fixture-turn", turnStartedAtMs: 100, status, items },
} } } });

class Server extends Duplex {
  readonly received: IpcObject[] = [];
  private readonly decoder = new FrameDecoder();
  dataState = state();
  answerWrites = true;
  disconnectOnStart = false;
  rejectStart = false;
  startResult: IpcObject = { turn: { id: "next-turn", status: "inProgress", items: [] } };
  onFollow: (() => void) | null = null;
  onDiscovery: (() => void) | null = null;
  settingsReply: IpcObject = { ok: true };
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    for (const message of this.decoder.push(chunk)) {
      this.received.push(message);
      queueMicrotask(() => this.respond(message));
    }
    callback();
  }
  send(message: IpcObject): void { if (!this.destroyed) this.push(encodeFrame(message)); }
  snapshot(version = 11, source = "owner", threadId = ref.threadId): void {
    this.send({ type: "broadcast", method: "thread-stream-state-changed", version, sourceClientId: source, targetClientIds: ["bridge-client"],
      params: { hostId: "local", conversationId: threadId, change: { type: "snapshot", revision: 1, conversationState: this.dataState } } });
  }
  private respond(message: IpcObject): void {
    if (message.type === "request") {
      let result: IpcObject = {};
      if (message.method === "initialize") result = { clientId: "bridge-client" };
      if (message.method === "thread-owner-discovery") this.onDiscovery?.();
      if (message.method === "thread-follower-steer-turn") {
        if (!this.answerWrites) return;
        result = { result: { turnId: "fixture-turn" } };
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
        result = this.settingsReply;
        this.dataState = { ...this.dataState, latestThreadSettings: (message.params as IpcObject).threadSettings };
        this.snapshot();
      }
      this.send({ type: "response", requestId: message.requestId, resultType: "success", result, handledByClientId: "owner" });
    } else if (message.method === "thread-stream-following-changed" && isObject(message.params) && message.params.following) {
      if (this.onFollow) this.onFollow(); else this.snapshot();
    }
  }
}

function runtimeSetup(t: TestContext) {
  const access = { ownerId: 101, groupId: 202 }; const peerId = 2_000_000_017;
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const server = new Server(); const client = new DesktopIpcClient(() => server, 100);
  const store = new BridgeStore(); const binding = store.ensureBinding(task);
  store.setChat(binding.id, peerId, 17);
  const participants = [access.ownerId, -access.groupId];
  const sent: { peerId: number; view: View }[] = [];
  const chat: BridgeChat = {
    members: async () => [...participants],
    send: async (peerId, view) => { sent.push({ peerId, view }); return { peerId, conversationMessageId: sent.length }; },
    edit: async () => { throw new Error("Unexpected edit"); },
    createConversation: async () => { throw new Error("Unexpected chat creation"); },
    renameConversation: async () => { throw new Error("Unexpected chat rename"); },
    inviteLink: async () => { throw new Error("Unexpected invitation"); },
    uploadDocument: async () => { throw new Error("Unexpected upload"); },
  };
  const desktop = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => client);
  let now = 100_000;
  const runtime = new DesktopBridgeRuntime(access, desktop, chat, store, client, () => now);
  t.after(async () => { await runtime.stop(); store.close(); });
  const follows = () => server.received.filter(message => message.method === "thread-stream-following-changed").map(message => (message.params as IpcObject).following);
  return { access, peerId, server, store, binding, participants, sent, runtime, follows, advance: () => { now += 30_001; } };
}

test("IPC decoding accepts fragmented headers and multiple frames without trusting frame lengths", () => {
  const decoder = new FrameDecoder(); const one = encodeFrame({ type: "one" }); const two = encodeFrame({ type: "two" });
  assert.deepEqual(decoder.push(one.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(Buffer.concat([one.subarray(2), two])), [{ type: "one" }, { type: "two" }]);
  const huge = Buffer.alloc(4); huge.writeUInt32LE(9 * 1024 * 1024);
  assert.throws(() => new FrameDecoder().push(huge), /frame size/u);
  assert.throws(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 0])), /frame size/u);
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

test("runtime immediately unsubscribes after departure and never interrupts or reattaches the task", async t => {
  const s = runtimeSetup(t);
  await s.runtime.tick(); assert.deepEqual(s.follows(), [true]);
  await s.runtime.membershipChanged({ peerId: s.peerId, eventId: "membership:leave", removedMemberId: s.access.ownerId });
  assert.deepEqual(s.follows(), [true, false]);
  assert.equal(s.store.getBinding(s.binding.id)!.attached, false);
  s.server.dataState = state([{ id: "later", type: "agentMessage", phase: "commentary", text: "Do not mirror" }]);
  s.server.snapshot();
  await s.runtime.tick();
  await s.runtime.membershipChanged({ peerId: s.peerId, eventId: "membership:return" });
  await s.runtime.tick();
  assert.deepEqual(s.follows(), [true, false]);
  assert.equal(s.sent.filter(item => item.peerId === s.peerId).length, 0);
  assert.equal(s.sent.length, 1);
  assert.ok(s.server.received.every(message => ["initialize", "thread-owner-discovery", "thread-stream-following-changed"].includes(String(message.method))));
});

test("periodic membership checks catch a missed departure even when the task sends no new events", async t => {
  const s = runtimeSetup(t);
  await s.runtime.tick();
  s.participants.splice(0, 1);
  s.advance(); await s.runtime.tick();
  assert.equal(s.store.getBinding(s.binding.id)!.attached, false);
  assert.deepEqual(s.follows(), [true, false]);
  assert.equal(s.sent.filter(item => item.peerId === s.peerId).length, 0);
  s.store.recover(); await s.runtime.tick();
  assert.deepEqual(s.follows(), [true, false]);
});

test("departure before the first Codex snapshot cancels startup without unavailable alerts or retries", async t => {
  const s = runtimeSetup(t); let departure: Promise<void> | undefined;
  s.server.onFollow = () => {
    departure = s.runtime.membershipChanged({ peerId: s.peerId, eventId: "membership:leave", removedMemberId: s.access.ownerId });
  };
  await s.runtime.tick(); await departure;
  assert.deepEqual(s.follows(), [true, false]);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0]!.view.text, /отключена/u);
  s.advance(); await s.runtime.tick();
  assert.deepEqual(s.follows(), [true, false]);
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
  await adapter.submit({ operationId: "client-message-fixture", task: ref, text: "A follow-up" });
  const request = server.received.find(message => message.method === "thread-follower-steer-turn")!;
  assert.equal(request.targetClientId, "owner");
  assert.equal((request.params as IpcObject).conversationId, ref.threadId);
  assert.equal((request.params as IpcObject).clientUserMessageId, "client-message-fixture");
  for (const forbidden of ["model", "approvalPolicy", "sandbox", "permissions", "serviceTier"]) assert.equal(Object.hasOwn(request.params as object, forbidden), false);
  assert.ok(server.destroyed);
});

test("model choice updates only next-turn model and effort through the actual owner", async () => {
  const server = new Server(); const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 };
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [], listModels: async () => [{ id: "fixture-model", title: "Fixture", efforts: ["high"], defaultEffort: "high" }] }, () => new DesktopIpcClient(() => server, 50));
  await adapter.selectModel(ref, "fixture-model", "high");
  const request = server.received.find(message => message.method === "thread-follower-update-thread-settings")!;
  assert.equal(request.targetClientId, "owner"); assert.equal(request.version, 1);
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
      }, archive: async () => {}, markdown: async () => "",
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
      rename: async () => { writes++; }, archive: async () => {}, markdown: async () => "",
    });
    await assert.rejects(adapter.renameTask(task, "New title"));
    assert.equal(writes, sourceMismatch ? 0 : 1);
  }
});

test("metadata archive refuses an active desktop turn without invoking metadata or interruption", async () => {
  const server = new Server(); const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }; let archives = 0;
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50), { rename: async () => {}, archive: async () => { archives++; }, markdown: async () => "" });
  await assert.rejects(adapter.archiveTask(ref), ActionRejectedError);
  assert.equal(archives, 0);
  assert.equal(server.received.some(message => String(message.method).includes("interrupt")), false);
});

test("an idle task starts the next turn through its owner with inherited settings", async () => {
  for (const status of ["completed", "interrupted", "failed"]) {
    const server = new Server(); server.dataState = { ...state([], status), resumeState: "resumed", threadRuntimeStatus: { type: "idle" } };
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
        request: { threadId: ref.threadId, clientUserMessageId: "message", input: [{ type: "text", text: "Continue", text_elements: [] }] },
        context: { inheritThreadSettings: true },
      },
    });
    assert.equal(server.received.some(message => message.method === "thread-follower-steer-turn" || message.method === "thread/start" || message.method === "thread/resume"), false);
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
    const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => new DesktopIpcClient(() => server, 50));
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
  for (const text of [" ", "x".repeat(16_001)]) await assert.rejects(adapter.submit({ operationId: "message", task: ref, text }), ActionRejectedError);
  assert.equal(connections, 0);
});

test("snapshot projection skips initial history and reasoning, then emits stable final and user events", () => {
  const initial = state([
    { type: "userMessage", id: "initial", content: [{ type: "text", text: "Initial prompt" }] },
    { type: "reasoning", id: "private", content: "Never mirror reasoning" },
    { type: "agentMessage", id: "progress", phase: "commentary", text: "Working" },
    { type: "agentMessage", id: "answer", phase: "final_answer", text: "Partial" },
  ]);
  const first = projectSnapshot(initial, null, 200);
  assert.equal(first.events.some(event => event.type === "user" || event.type === "final"), false);
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

test("catalog excludes archived and subagent tasks, and uses the user's canonical title", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, thread_source TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER, is_pinned INTEGER, recency_at_ms INTEGER);
    INSERT INTO threads VALUES ('main', 'Renamed by user', 'Old title', '/fixture', 'user', 'vscode', 0, 1000, 1, 0, 1000);
    INSERT INTO threads VALUES ('agent', 'Agent', 'Agent', '/fixture', 'subagent', 'vscode', 0, 2000, 2, 0, 2000);
    INSERT INTO threads VALUES ('archived', 'Archived', 'Archived', '/fixture', 'user', 'vscode', 1, 3000, 3, 0, 3000);`);
  const tasks = readTaskCatalog(db);
  assert.equal(tasks.length, 1); assert.equal(tasks[0]!.title, "Renamed by user");
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM threads").get(), { n: 3 });
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
