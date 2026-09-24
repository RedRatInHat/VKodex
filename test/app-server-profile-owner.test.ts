import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerEnvelope, AppServerRequestOptions, AppServerRpc, AppServerServerRequestHandler } from "../src/codex/app-server-connection.js";
import { AppServerProfileOwner, AppServerOwnerStateRouter } from "../src/codex/app-server-profile-owner.js";
import { ActionRejectedError } from "../src/core/codex-tasks.js";

type JsonObject = Record<string, unknown>;
class Rpc implements AppServerRpc {
  readonly calls: string[] = []; readonly resumeTimeouts: number[] = [];
  closed = 0; projectId: string | null = null; waitResume: Promise<void> | null = null;
  waitUnsubscribe: Promise<void> | null = null; failUnsubscribe = false;
  threadStatus: "idle" | "notLoaded" = "idle";
  private readonly notifications = new Set<(notification: AppServerEnvelope) => void>();
  async start(): Promise<void> {}
  async request(method: string, _params: JsonObject = {}, _options?: AppServerRequestOptions): Promise<JsonObject> {
    this.calls.push(method);
    if (method === "thread/resume") {
      this.resumeTimeouts.push(_options?.timeoutMs ?? 30_000);
      if (this.waitResume) await this.waitResume;
      return { thread: { id: "task", name: "Task", cwd: "D:\\w", status: { type: "idle" } },
        cwd: "D:\\w", model: "gpt", reasoningEffort: "high", initialTurnsPage: { data: [], nextCursor: null } };
    }
    if (method === "thread/unsubscribe") {
      if (this.waitUnsubscribe) await this.waitUnsubscribe;
      if (this.failUnsubscribe) throw new Error("release result unknown");
      return {};
    }
    if (method === "turn/start") return { turn: { id: "turn" } };
    if (method === "thread/read") return { thread: { id: "task", name: "Task", projectId: this.projectId, status: { type: this.threadStatus } } };
    if (method === "thread/metadata/update") { this.projectId = _params.projectId ? String(_params.projectId) : null; return {}; }
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/archive") return {};
    if (method === "thread/turns/list") return { data: [{ id: "accepted-turn", items: [
      { type: "userMessage", clientId: "accepted-operation" },
    ] }], nextCursor: null };
    throw new Error(method);
  }
  onNotification(listener: (notification: AppServerEnvelope) => void): () => void {
    this.notifications.add(listener); return () => { this.notifications.delete(listener); };
  }
  onServerRequest(_handler: AppServerServerRequestHandler | null): void {}
  async close(): Promise<void> { this.closed++; }
}

test("profile owner rejects another source before touching its App Server", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const foreign = { hostId: "local", threadId: "task", sourceId: "other" };
  assert.throws(() => owner.submitWithReceipt({ operationId: "op", task: foreign, text: "prompt" }), ActionRejectedError);
  assert.throws(() => owner.states.subscribe(foreign, () => {}, () => {}), ActionRejectedError);
  assert.deepEqual(rpc.calls, []); await owner.close();
});

test("profile owner shares one connection for commands and task state", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  let initial = false; const stream = owner.states.subscribe(task, (_state, value) => { initial = value; }, () => {});
  await stream.start();
  const receipt = await owner.submitWithReceipt({ operationId: "op", task, text: "prompt" });
  assert.equal(initial, true); assert.deepEqual(receipt, { mode: "start", turnId: "turn" });
  assert.deepEqual(rpc.calls, ["thread/resume", "turn/start"]);
  await owner.close(); assert.equal(rpc.closed, 1);
});

test("profile owner shares a slow resume between a command and the state stream", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  let release!: () => void;
  rpc.waitResume = new Promise<void>(resolve => { release = resolve; });
  const stream = owner.states.subscribe(task, () => {}, () => {});
  try {
    const starting = stream.start();
    await new Promise(resolve => setImmediate(resolve));
    const submitting = owner.submitWithReceipt({ operationId: "op", task, text: "prompt" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rpc.calls.filter(method => method === "thread/resume").length, 1);
    release();
    await Promise.all([starting, submitting]);
    assert.deepEqual(rpc.resumeTimeouts, [180_000]);
  } finally { release(); await owner.close(); }
});

test("a stream started after a VK turn reads the loaded writer without resuming it again", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  try {
    await owner.submitWithReceipt({ operationId: "op", task, text: "prompt" });
    let status: unknown = null;
    const stream = owner.states.subscribe(task, state => { status = state.kind === "app-server" ? state.runtimeStatus : null; }, () => {});
    await stream.start();
    assert.equal(rpc.calls.filter(method => method === "thread/resume").length, 1);
    assert.equal(rpc.calls.filter(method => method === "thread/read").length, 1);
    assert.equal(status, "active");
  } finally { await owner.close(); }
});

test("a VK command waits for confirmed stream release before resuming a task", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  let release!: () => void;
  rpc.waitUnsubscribe = new Promise<void>(resolve => { release = resolve; });
  try {
    const stream = owner.states.subscribe(task, () => {}, () => {});
    await stream.start(); stream.close();
    const submitting = owner.submitWithReceipt({ operationId: "op", task, text: "prompt" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(rpc.calls, ["thread/resume", "thread/unsubscribe"]);
    release();
    assert.deepEqual(await submitting, { mode: "start", turnId: "turn" });
    assert.deepEqual(rpc.calls, ["thread/resume", "thread/unsubscribe", "thread/resume", "turn/start"]);
  } finally { release(); await owner.close(); }
});

test("an uncertain stream release reuses its still-loaded writer without a second resume", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  rpc.failUnsubscribe = true;
  try {
    const stream = owner.states.subscribe(task, () => {}, () => {});
    await stream.start(); stream.close();
    assert.deepEqual(await owner.submitWithReceipt({ operationId: "op", task, text: "prompt" }),
      { mode: "start", turnId: "turn" });
    assert.deepEqual(rpc.calls, ["thread/resume", "thread/unsubscribe", "thread/read", "turn/start"]);
  } finally { await owner.close(); }
});

test("closing a stream during slow resume still releases the writer it acquires", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  let release!: () => void;
  rpc.waitResume = new Promise<void>(resolve => { release = resolve; });
  try {
    const stream = owner.states.subscribe(task, () => {}, () => {});
    const starting = stream.start();
    await new Promise(resolve => setImmediate(resolve));
    stream.close(); release();
    await starting;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(rpc.calls, ["thread/resume", "thread/unsubscribe"]);
  } finally { release(); await owner.close(); }
});

test("an ambiguous release that actually succeeded resumes after a native notLoaded check", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  rpc.failUnsubscribe = true;
  rpc.threadStatus = "notLoaded";
  try {
    const stream = owner.states.subscribe(task, () => {}, () => {});
    await stream.start(); stream.close();
    await owner.submitWithReceipt({ operationId: "op", task, text: "prompt" });
    assert.deepEqual(rpc.calls, ["thread/resume", "thread/unsubscribe", "thread/read", "thread/resume", "turn/start"]);
  } finally { await owner.close(); }
});

test("state router never falls back to another account", () => {
  const first = new AppServerProfileOwner("one", new Rpc());
  const second = new AppServerProfileOwner("two", new Rpc());
  const router = new AppServerOwnerStateRouter([first, second]);
  assert.throws(() => router.subscribe({ hostId: "local", threadId: "task", sourceId: "three" }, () => {}, () => {}), ActionRejectedError);
  router.close();
});

test("profile owner reconciles an uncertain input from native paged history", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("", rpc);
  const task = { hostId: "local", threadId: "task" };
  assert.equal(await owner.findAcceptedInput(task, "accepted-operation"), "accepted-turn");
  assert.equal(await owner.findAcceptedInput(task, "missing-operation"), null);
  await owner.close();
});

test("profile owner archives through its shared App Server connection", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  assert.equal(await owner.archiveRetryReady(task), true);
  await owner.archiveTask(task);
  assert.equal(rpc.calls.filter(method => method === "thread/archive").length, 1);
  await owner.close();
});

test("profile owner resolves a visible project inside its own source before the native write", async () => {
  const rpc = new Rpc();
  const owner = new AppServerProfileOwner("work", rpc, async projectId => ({ rawProjectId: `raw:${projectId}`, sourceId: "work" }));
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  await owner.moveTask(task, "visible-project");
  assert.equal(rpc.projectId, "raw:visible-project");
  await owner.close();

  const foreignRpc = new Rpc();
  const foreign = new AppServerProfileOwner("work", foreignRpc, async () => ({ rawProjectId: "raw", sourceId: "other" }));
  await assert.rejects(foreign.moveTask(task, "visible-project"), ActionRejectedError);
  assert.equal(foreignRpc.calls.includes("thread/metadata/update"), false);
  await foreign.close();
});
