import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import path from "node:path";
import { parseTaskTitles, readTaskCatalog } from "../src/desktop/catalog.js";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, type DesktopTask } from "../src/desktop/contracts.js";
import { ConnectedDesktopTasks } from "../src/desktop/desktop-tasks.js";
import { SdkTaskExecutor } from "../src/desktop/sdk-executor.js";
import type { Codex } from "@openai/codex-sdk";
import { DesktopIpcClient, encodeFrame, FrameDecoder, isObject, type IpcObject } from "../src/desktop/ipc-client.js";
import { projectSnapshot } from "../src/desktop/projector.js";
import { RevisionedState } from "../src/desktop/state.js";
import { TaskSubscription } from "../src/desktop/subscription.js";
import { DesktopBridgeRuntime } from "../src/bridge/runtime.js";
import { BridgeStore } from "../src/bridge/store.js";
import type { BridgeChat, MessageHandle, View } from "../src/bridge/contracts.js";

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
  const sent: { peerId: number; view: View }[] = [];
  const edits: { handle: MessageHandle; view: View }[] = [];
  const chat: BridgeChat = {
    send: async (peerId, view) => { sent.push({ peerId, view }); return { peerId, conversationMessageId: sent.length }; },
    edit: async (handle, view) => { edits.push({ handle, view }); },
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
  return { access, peerId, server, store, binding, sent, edits, runtime, follows, advance: (ms = 30_001) => { now += ms; } };
}

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
    { id: "command", type: "commandExecution", output: "x".repeat(24 * 1024 * 1024) },
    { id: "old-progress", type: "agentMessage", phase: "commentary", text: "Progress before connecting" },
  ]);
  await s.runtime.tick();
  assert.deepEqual(s.follows(), [true]);
  assert.equal(s.server.destroyed, false);
  assert.deepEqual(s.sent.map(item => item.view.text), ["думаю..."]);
  s.server.send({ type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: "owner", targetClientIds: ["bridge-client"], params: {
    hostId: ref.hostId, conversationId: ref.threadId, change: { type: "patches", baseRevision: 1, revision: 2, patches: [
      { op: "add", path: ["turnHistory", "history", "entitiesByKey", "tail", "items", 2], value: { id: "progress", type: "agentMessage", phase: "commentary", text: "Progress after connecting" } },
    ] },
  } });
  await new Promise(resolve => setImmediate(resolve));
  await s.runtime.tick();
  assert.deepEqual(s.sent.map(item => item.view.text), ["думаю...", "Progress after connecting\n\nдумаю..."]);
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

test("runtime animates an active task between desktop events and stops when its turn completes", async t => {
  const s = runtimeSetup(t); await s.runtime.tick();
  s.advance(20_000); await s.runtime.tick();
  assert.equal(s.edits.at(-1)!.view.text, "думаю..");
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
  await adapter.submit({ operationId: "client-message-fixture", task: ref, text: "A follow-up" });
  const request = server.received.find(message => message.method === "thread-follower-steer-turn")!;
  assert.equal(request.targetClientId, "owner");
  assert.equal((request.params as IpcObject).conversationId, ref.threadId);
  assert.equal((request.params as IpcObject).clientUserMessageId, "client-message-fixture");
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
    resolveProject: async id => ({ rawProjectId: id, sourceId: "" }),
  }, () => new DesktopIpcClient(() => server, 50), {
    rename: async () => {}, archive: async () => {}, markdown: async () => "",
    assignProject: async (_ref, projectId) => { writes.push(projectId); task = { ...task, projectId }; },
  });
  await adapter.moveTask(ref, "project-b");
  assert.deepEqual(writes, ["project-b"]); assert.equal(task.projectId, "project-b");
  assert.equal(server.received.some(message => /turn/u.test(String(message.method))), false);
});

test("compatibility canary confirms stream protocol v11 through an open task", async () => {
  const task = { ...ref, title: "Fixture", workspace: "/fixture", updatedAt: 1 }; const servers: Server[] = [];
  const adapter = new ConnectedDesktopTasks({ listTasks: async () => [task], listProjects: async () => [] }, () => {
    const server = new Server(); servers.push(server); return new DesktopIpcClient(() => server, 100);
  });
  const status = await adapter.checkCompatibility();
  assert.equal(status.state, "ok"); assert.match(status.message, /v11/u); assert.equal(servers.length, 2);
});

test("SDK executor creates a user task with the selected worktree and streams its answer", async () => {
  async function* events(): AsyncGenerator<unknown> {
    yield { type: "thread.started", thread_id: "sdk-thread" };
    yield { type: "turn.started" };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "SDK answer" } };
    yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
  }
  const projectWorkspace = path.resolve("fixture-repo"); const codexHome = path.resolve("fixture-codex-home"); const worktreeWorkspace = path.resolve("fixture-worktree");
  const homes: string[] = []; const worktrees: string[] = []; const metadata: string[] = []; const updates: string[] = [];
  const codex = { startThread: () => ({ runStreamed: async () => ({ events: events() }) }) } as unknown as Codex;
  const catalog = {
    resolveProject: async () => ({ project: { id: "project", title: "Project", workspace: projectWorkspace }, rawProjectId: "raw-project", sourceHome: codexHome, sourceLabel: ".codex" }),
    sourceHome: () => codexHome, listTasks: async () => [],
  };
  const executor = new SdkTaskExecutor(catalog, {
    rename: async (_task, title) => { metadata.push(`rename:${title}`); },
    assignProject: async (_task, projectId) => { metadata.push(`project:${projectId}`); },
    archive: async () => {}, markdown: async () => "",
  }, home => { homes.push(home); return codex; }, async (_project, operationId) => { worktrees.push(operationId); return worktreeWorkspace; });
  executor.onUpdate(update => updates.push(update.event.type));
  const task = await executor.createTask({ operationId: "operation", projectId: "project", title: "New SDK task", prompt: "Start", model: "model", effort: "high", environment: "worktree" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(task.threadId, "sdk-thread"); assert.equal(task.workspace, worktreeWorkspace);
  assert.deepEqual(homes, [codexHome]); assert.deepEqual(worktrees, ["operation"]);
  assert.deepEqual(metadata, ["project:raw-project", "rename:New SDK task"]);
  assert.ok(updates.includes("final")); assert.equal(executor.details(task)?.status, "idle");
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
