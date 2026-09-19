import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerEnvelope, AppServerRequestOptions, AppServerRpc, AppServerServerRequestHandler } from "../src/codex/app-server-connection.js";
import { AppServerUncertainError } from "../src/codex/app-server-connection.js";
import { AppServerTaskExecutor } from "../src/codex/app-server-task-executor.js";
import { ActionRejectedError, UncertainActionError, type SubmitTaskRequest } from "../src/core/codex-tasks.js";

type JsonObject = Record<string, unknown>;

class FakeRpc implements AppServerRpc {
  readonly requests: { method: string; params: JsonObject; options: AppServerRequestOptions }[] = [];
  private readonly listeners = new Set<(notification: AppServerEnvelope) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private handler: AppServerServerRequestHandler | null = null;
  activeTurnId: string | null = null;
  title: string | null = "Task";
  projectId: string | null = null;
  goal: JsonObject | null = null;
  fail: Error | null = null;
  failMethod: string | null = null;
  failAfterMethod: string | null = null;
  private after(method: string): void {
    if (this.failAfterMethod === method) { this.failAfterMethod = null; throw new AppServerUncertainError(); }
  }
  async start(): Promise<void> {}
  async request(method: string, params: JsonObject = {}, options: AppServerRequestOptions = {}): Promise<JsonObject> {
    this.requests.push({ method, params, options });
    if (this.fail && (!this.failMethod || this.failMethod === method)) { const error = this.fail; this.fail = null; this.failMethod = null; throw error; }
    if (method === "thread/resume") return {
      thread: { id: params.threadId, status: { type: this.activeTurnId ? "active" : "idle" } },
      initialTurnsPage: { data: this.activeTurnId ? [{ id: this.activeTurnId, status: "inProgress", items: [] }] : [] },
      model: "model-a", reasoningEffort: "high",
    };
    if (method === "turn/start") { this.activeTurnId = "started-turn"; return { turn: { id: this.activeTurnId } }; }
    if (method === "turn/steer") return { turnId: this.activeTurnId };
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-1" } };
    if (method === "thread/list") return { data: [], nextCursor: null };
    // Native thread/read can briefly lag an acknowledged turn/start.
    if (method === "thread/read") return { thread: { id: params.threadId, name: this.title, projectId: this.projectId,
      cwd: "D:\\work", status: { type: "idle" } } };
    if (method === "thread/name/set") { this.title = String(params.name); this.after(method); return {}; }
    if (method === "thread/metadata/update") { this.projectId = params.projectId ? String(params.projectId) : null; this.after(method); return {}; }
    if (method === "thread/goal/get") return { goal: this.goal };
    if (method === "thread/goal/set") {
      const previous = this.goal ?? { threadId: params.threadId, objective: "Goal", status: "paused", tokenBudget: null,
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
      this.goal = { ...previous, ...params, updatedAt: 2 }; this.after(method); return { goal: this.goal };
    }
    if (method === "thread/goal/clear") { const cleared = this.goal !== null; this.goal = null; this.after(method); return { cleared }; }
    return {};
  }
  onNotification(listener: (notification: AppServerEnvelope) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener); return () => { this.disconnectListeners.delete(listener); };
  }
  onServerRequest(handler: AppServerServerRequestHandler | null): void { this.handler = handler; }
  emit(notification: AppServerEnvelope): void { for (const listener of this.listeners) listener(notification); }
  disconnect(): void { for (const listener of this.disconnectListeners) listener(new Error("Disconnected")); }
  ask(request: AppServerEnvelope): Promise<JsonObject> { return Promise.resolve(this.handler!(request)); }
  async close(): Promise<void> {}
}

const task = { hostId: "local", threadId: "task", sourceId: "profile" };
const request = (beforeSend?: () => Promise<void>): SubmitTaskRequest => ({
  operationId: "operation-1", task, text: "Continue", ...(beforeSend ? { beforeSend } : {}),
});

test("App Server executor starts an idle turn and steers only the confirmed active turn", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    assert.deepEqual(await executor.submitWithReceipt(request()), { mode: "start", turnId: "started-turn" });
    const start = rpc.requests.find(item => item.method === "turn/start")!;
    assert.equal(start.params.clientUserMessageId, "operation-1");
    assert.equal(start.options.mutating, true);
    assert.deepEqual(await executor.submitWithReceipt({ ...request(), operationId: "operation-2" }), { mode: "steer", turnId: "started-turn" });
    const steer = rpc.requests.find(item => item.method === "turn/steer")!;
    assert.equal(steer.params.expectedTurnId, "started-turn");
    assert.equal(steer.params.clientUserMessageId, "operation-2");
    assert.equal(rpc.requests.filter(item => item.method === "thread/resume").length, 1);
  } finally { executor.close(); }
});

test("inspection of an owned active task never resumes and aborts it", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.submitWithReceipt(request());
    const details = await executor.inspectLoadedTask(task);
    assert.equal(details?.status, "running");
    assert.equal(details?.model, "model-a");
    assert.equal(rpc.requests.filter(item => item.method === "thread/resume").length, 1);
    assert.equal(rpc.requests.filter(item => item.method === "thread/read").length, 1);
  } finally { executor.close(); }
});

test("a disconnected owner drops its loaded-task cache before reconnecting", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.submitWithReceipt(request());
    rpc.disconnect(); rpc.activeTurnId = null;
    assert.equal(await executor.inspectLoadedTask(task), null);
    await executor.submitWithReceipt({ ...request(), operationId: "operation-after-reconnect" });
    assert.equal(rpc.requests.filter(item => item.method === "thread/resume").length, 2);
  } finally { executor.close(); }
});

test("App Server executor rechecks access before dispatch and does not mutate after rejection", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await assert.rejects(executor.submitWithReceipt(request(async () => { throw new ActionRejectedError("detached"); })), /detached/u);
    assert.equal(rpc.requests.some(item => item.method === "turn/start" || item.method === "turn/steer"), false);
  } finally { executor.close(); }
});

test("App Server executor uses native interrupt, queue and settings APIs", async () => {
  const rpc = new FakeRpc(); rpc.activeTurnId = "active-turn"; const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.interrupt(task);
    assert.deepEqual(rpc.requests.find(item => item.method === "turn/interrupt")?.params, { threadId: "task", turnId: "active-turn" });
    assert.equal(await executor.queue(request()), "queue-1");
    await executor.selectModel(task, "model-b", "xhigh");
    assert.deepEqual(rpc.requests.find(item => item.method === "thread/settings/update")?.params,
      { threadId: "task", model: "model-b", effort: "xhigh" });
    for (const method of ["turn/interrupt", "thread/queue/add", "thread/settings/update"]) {
      assert.equal(rpc.requests.find(item => item.method === method)?.options.mutating, true);
    }
  } finally { executor.close(); }
});

test("App Server executor keeps metadata and goals on its native owner connection", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    assert.deepEqual(await executor.renameTask(task, "Renamed"), { liveTitleUpdated: true });
    await executor.assignProject(task, "raw-project");
    assert.equal((await executor.getGoal(task)), null);
    const goal = await executor.setGoal(task, { objective: "Ship safely", tokenBudget: 2_000, status: "paused" });
    assert.equal(goal.objective, "Ship safely"); assert.equal(goal.tokenBudget, 2_000);
    assert.equal(await executor.clearGoal(task), true);
    assert.equal(await executor.getGoal(task), null);
    for (const method of ["thread/name/set", "thread/metadata/update", "thread/goal/set", "thread/goal/clear"]) {
      assert.equal(rpc.requests.filter(item => item.method === method).length, 1);
      assert.equal(rpc.requests.find(item => item.method === method)?.options.mutating, true);
    }
  } finally { executor.close(); }
});

test("owner metadata reconciles lost acknowledgments without repeating mutations", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    rpc.failAfterMethod = "thread/name/set";
    assert.deepEqual(await executor.renameTask(task, "Recovered"), { liveTitleUpdated: true });
    rpc.failAfterMethod = "thread/metadata/update";
    await executor.assignProject(task, "project-after-timeout");
    rpc.failAfterMethod = "thread/goal/set";
    assert.equal((await executor.setGoal(task, { objective: "Recovered goal", status: "paused" })).objective, "Recovered goal");
    rpc.failAfterMethod = "thread/goal/clear";
    assert.equal(await executor.clearGoal(task), true);
    for (const method of ["thread/name/set", "thread/metadata/update", "thread/goal/set", "thread/goal/clear"]) {
      assert.equal(rpc.requests.filter(item => item.method === method).length, 1);
    }
  } finally { executor.close(); }
});

test("App Server executor exposes a native structured question and returns one complete response", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    const response = rpc.ask({ method: "item/tool/requestUserInput", params: {
      threadId: "task", turnId: "turn", itemId: "question-item", isBlocking: true,
      questions: [{ id: "choice", question: "Choose", isSecret: false,
        options: [{ label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }] }],
    } });
    await new Promise(resolve => setImmediate(resolve));
    const [question] = await executor.pendingQuestions(task);
    assert.equal(question?.kind, "blocking");
    assert.deepEqual(question?.questions[0]?.options.map(option => option.label), ["Alpha", "Beta"]);
    await executor.answerQuestions(task, question!, { choice: "Beta" }, "answer-operation", async () => {});
    assert.deepEqual(await response, { answers: { choice: { answers: ["Beta"] } } });
    assert.deepEqual(await executor.pendingQuestions(task), []);
  } finally { executor.close(); }
});

test("App Server executor never hides an uncertain mutation behind a retry", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    rpc.fail = new AppServerUncertainError(); rpc.failMethod = "turn/start";
    await assert.rejects(executor.submitWithReceipt(request()), UncertainActionError);
    assert.equal(rpc.requests.filter(item => item.method === "turn/start").length, 1);
  } finally { executor.close(); }
});

test("App Server executor archives an idle tree once and gates concurrent mutations", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.archiveIdle(task);
    const archive = rpc.requests.filter(item => item.method === "thread/archive");
    assert.equal(archive.length, 1); assert.equal(archive[0]?.options.mutating, true);
    assert.equal(await executor.archiveRetryReady(task), true);
  } finally { executor.close(); }
});

test("App Server executor preserves an uncertain archive gate and never retries it", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    rpc.fail = new AppServerUncertainError(); rpc.failMethod = "thread/archive";
    await assert.rejects(executor.archiveIdle(task), UncertainActionError);
    await assert.rejects(executor.submitWithReceipt(request()), /архивируется/u);
    await assert.rejects(executor.archiveIdle(task), /архивируется/u);
    assert.equal(rpc.requests.filter(item => item.method === "thread/archive").length, 1);
    rpc.emit({ method: "thread/archived", params: { threadId: task.threadId } });
    assert.equal(await executor.archiveRetryReady(task), true);
  } finally { executor.close(); }
});
