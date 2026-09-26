import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerEnvelope, AppServerRequestOptions, AppServerRpc, AppServerServerRequestHandler } from "../src/codex/app-server-connection.js";
import { AppServerRejectedError, AppServerUnavailableError, AppServerUncertainError } from "../src/codex/app-server-connection.js";
import { AppServerTaskExecutor } from "../src/codex/app-server-task-executor.js";
import { ActionRejectedError, TaskNotOpenError, UncertainActionError, type SubmitTaskRequest } from "../src/core/codex-tasks.js";

type JsonObject = Record<string, unknown>;

class FakeRpc implements AppServerRpc {
  runtimeStatus: string | null = null;
  readonly requests: { method: string; params: JsonObject; options: AppServerRequestOptions }[] = [];
  private readonly listeners = new Set<(notification: AppServerEnvelope) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private handler: AppServerServerRequestHandler | null = null;
  activeTurnId: string | null = null;
  nativeLoaded = true;
  title: string | null = "Task";
  projectId: string | null = null;
  goal: JsonObject | null = null;
  fail: Error | null = null;
  failMethod: string | null = null;
  failAfterMethod: string | null = null;
  interruptPlan: ("success" | "reject-running" | "reject-stopped" | "uncertain-running" | "uncertain-stopped")[] = [];
  modelUpdatePlan: Error[] = [];
  descendants: string[] = [];
  unloadedDescendantStatus: "completed" | "failed" | "interrupted" | "inProgress" | "empty" | null = null;
  emptyDescendantUpdatedAt = Math.floor(Date.now() / 1000) - 600;
  private after(method: string): void {
    if (this.failAfterMethod === method) { this.failAfterMethod = null; throw new AppServerUncertainError(); }
  }
  async start(): Promise<void> {}
  async request(method: string, params: JsonObject = {}, options: AppServerRequestOptions = {}): Promise<JsonObject> {
    this.requests.push({ method, params, options });
    if (this.fail && (!this.failMethod || this.failMethod === method)) { const error = this.fail; this.fail = null; this.failMethod = null; throw error; }
    if (method === "thread/resume") { this.nativeLoaded = true; return {
      thread: { id: params.threadId, status: { type: this.activeTurnId ? "active" : "idle" } },
      initialTurnsPage: { data: this.activeTurnId ? [{ id: this.activeTurnId, status: "inProgress", items: [] }] : [] },
      model: "model-a", reasoningEffort: "high",
    }; }
    if (method === "turn/start") { if (!this.nativeLoaded) throw new AppServerRejectedError(-32600); this.activeTurnId = "started-turn"; return { turn: { id: this.activeTurnId } }; }
    if (method === "turn/steer") return { turnId: this.activeTurnId };
    if (method === "turn/interrupt") {
      const action = this.interruptPlan.shift() ?? "success";
      if (action.endsWith("stopped") || action === "success") this.activeTurnId = null;
      if (action.startsWith("reject")) throw new AppServerRejectedError();
      if (action.startsWith("uncertain")) throw new AppServerUncertainError();
      return {};
    }
    if (method === "thread/queue/add") return { queuedSubmission: { id: "queue-1" } };
    if (method === "thread/settings/update" && this.modelUpdatePlan.length) throw this.modelUpdatePlan.shift()!;
    if (method === "thread/list") return { data: this.descendants.map(id => ({ id })), nextCursor: null };
    if (method === "thread/turns/list" && this.unloadedDescendantStatus === "empty" && params.threadId !== "task") {
      return { data: [], nextCursor: null };
    }
    if (method === "thread/turns/list") return { data: [{ id: "started-turn",
      status: this.unloadedDescendantStatus && params.threadId !== "task" ? this.unloadedDescendantStatus
        : this.activeTurnId === "started-turn" ? "inProgress" : "interrupted", items: [] }], nextCursor: null };
    // Native thread/read can briefly lag an acknowledged turn/start.
    if (method === "thread/read") return { thread: { id: params.threadId, name: this.title, projectId: this.projectId,
      cwd: "D:\\work", updatedAt: this.emptyDescendantUpdatedAt,
      status: { type: this.runtimeStatus ?? (this.unloadedDescendantStatus && params.threadId !== "task" || !this.nativeLoaded ? "notLoaded" : "idle") } } };
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

test("native prompt rejections identify the failed stage and safe numeric code", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    rpc.fail = new AppServerRejectedError(-32000); rpc.failMethod = "thread/resume";
    await assert.rejects(executor.submitWithReceipt(request()), /подключение к задаче \(код -32000\)/u);
    rpc.fail = new AppServerRejectedError(-32602); rpc.failMethod = "turn/start";
    await assert.rejects(executor.submitWithReceipt(request()), /запуск нового хода \(код -32602\)/u);
    assert.equal(rpc.requests.filter(item => item.method === "turn/start").length, 1);
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

test("inspection does not report a cached active turn as running after native unload", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.submitWithReceipt(request());
    rpc.nativeLoaded = false;
    assert.equal((await executor.inspectLoadedTask(task))?.status, "unavailable");
    assert.equal(rpc.requests.filter(item => item.method === "thread/resume").length, 1);
  } finally { executor.close(); }
});

test("a native system error overrides the cached active turn during inspection", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.submitWithReceipt(request());
    rpc.runtimeStatus = "systemError";
    const details = await executor.inspectLoadedTask(task);
    assert.equal(details?.status, "failed");
    assert.equal(details?.failure, "systemError");
  } finally { executor.close(); }
});

test("an idle task unloaded behind the owner cache is resumed before the next turn", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.submitWithReceipt(request());
    rpc.activeTurnId = null;
    rpc.emit({ method: "turn/completed", params: { threadId: task.threadId, turn: { id: "started-turn", status: "completed" } } });
    rpc.nativeLoaded = false;
    assert.deepEqual(await executor.submitWithReceipt({ ...request(), operationId: "operation-after-unload" }),
      { mode: "start", turnId: "started-turn" });
    assert.equal(rpc.requests.filter(item => item.method === "thread/resume").length, 2);
    assert.equal(rpc.requests.filter(item => item.method === "turn/start").length, 2);
  } finally { executor.close(); }
});

test("App Server executor rechecks access before dispatch and does not mutate after rejection", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    await assert.rejects(executor.submitWithReceipt(request(async () => { throw new ActionRejectedError("detached"); })), /detached/u);
    assert.equal(rpc.requests.some(item => item.method === "turn/start" || item.method === "turn/steer"), false);
  } finally { executor.close(); }
});

test("an unavailable owner before dispatch is a retryable route failure, not an uncertain mutation", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    rpc.fail = new AppServerUnavailableError("resume timed out"); rpc.failMethod = "thread/resume";
    await assert.rejects(executor.submitWithReceipt(request()), TaskNotOpenError);
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

test("model selection retries one confirmed transient rejection but never an uncertain write", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  try {
    rpc.modelUpdatePlan = [new AppServerRejectedError(-32000)];
    await executor.selectModel(task, "gpt-6-astra", "high");
    assert.equal(rpc.requests.filter(item => item.method === "thread/settings/update").length, 2);
    assert.equal((await executor.inspectLoadedTask(task))?.nextModel, "gpt-6-astra");

    rpc.modelUpdatePlan = [new AppServerUncertainError()];
    await assert.rejects(executor.selectModel(task, "gpt-6-astra", "xhigh"), UncertainActionError);
    assert.equal(rpc.requests.filter(item => item.method === "thread/settings/update").length, 3);
  } finally { executor.close(); }
});

test("model selection does not retry a malformed request or repeated rejection", async () => {
  for (const first of [new AppServerRejectedError(-32602), new AppServerRejectedError(-32000)]) {
    const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
    try {
      rpc.modelUpdatePlan = [first, new AppServerRejectedError(-32000)];
      await assert.rejects(executor.selectModel(task, "gpt-6-astra", "high"), ActionRejectedError);
      assert.equal(rpc.requests.filter(item => item.method === "thread/settings/update").length,
        first.code === -32602 ? 1 : 2);
    } finally { executor.close(); }
  }
});

test("App Server interrupt confirms a stopped turn after a rejected or lost reply", async () => {
  for (const outcome of ["reject-stopped", "uncertain-stopped"] as const) {
    const rpc = new FakeRpc(); rpc.activeTurnId = "started-turn"; rpc.interruptPlan = [outcome];
    const executor = new AppServerTaskExecutor(rpc);
    try {
      await executor.interrupt(task);
      assert.equal(rpc.requests.filter(item => item.method === "turn/interrupt").length, 1);
    } finally { executor.close(); }
  }
});

test("App Server interrupt retries only an explicitly rejected immutable running turn", async () => {
  const rpc = new FakeRpc(); rpc.activeTurnId = "started-turn"; rpc.interruptPlan = ["reject-running", "success"];
  const executor = new AppServerTaskExecutor(rpc);
  try {
    await executor.interrupt(task);
    const requests = rpc.requests.filter(item => item.method === "turn/interrupt");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(item => item.params.turnId), ["started-turn", "started-turn"]);
  } finally { executor.close(); }
});

test("App Server interrupt never retries an uncertain running turn", async () => {
  const rpc = new FakeRpc(); rpc.activeTurnId = "started-turn"; rpc.interruptPlan = ["uncertain-running"];
  const executor = new AppServerTaskExecutor(rpc);
  try {
    await assert.rejects(executor.interrupt(task), UncertainActionError);
    assert.equal(rpc.requests.filter(item => item.method === "turn/interrupt").length, 1);
  } finally { executor.close(); }
});

test("App Server interrupt reports a known refusal when the same turn stays active", async () => {
  const rpc = new FakeRpc(); rpc.activeTurnId = "started-turn"; rpc.interruptPlan = ["reject-running", "reject-running"];
  const executor = new AppServerTaskExecutor(rpc);
  try {
    await assert.rejects(executor.interrupt(task), /всё ещё выполняется/u);
    assert.equal(rpc.requests.filter(item => item.method === "turn/interrupt").length, 2);
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

test("archive checks an unloaded descendant's terminal turn without resuming it", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  rpc.descendants = ["finished-child"]; rpc.unloadedDescendantStatus = "failed";
  try {
    await executor.archiveIdle(task);
    assert.equal(rpc.requests.filter(item => item.method === "thread/archive").length, 1);
    assert.equal(rpc.requests.filter(item => item.method === "thread/resume" && item.params.threadId === "finished-child").length, 0);
    assert.equal(rpc.requests.filter(item => item.method === "thread/turns/list" && item.params.threadId === "finished-child").length, 1);
  } finally { executor.close(); }
});

test("archive rejects an unloaded descendant with an active last turn", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  rpc.descendants = ["running-child"]; rpc.unloadedDescendantStatus = "inProgress";
  try {
    await assert.rejects(executor.archiveIdle(task), /дочерние задачи должны быть завершены/u);
    assert.equal(rpc.requests.filter(item => item.method === "thread/archive").length, 0);
    assert.equal(rpc.requests.filter(item => item.method === "thread/resume" && item.params.threadId === "running-child").length, 0);
  } finally { executor.close(); }
});

test("archive accepts an old unloaded child with no turns but waits for a newly spawned child", async () => {
  const rpc = new FakeRpc(); const executor = new AppServerTaskExecutor(rpc);
  rpc.descendants = ["empty-child"]; rpc.unloadedDescendantStatus = "empty";
  try {
    rpc.emptyDescendantUpdatedAt = Math.floor(Date.now() / 1000);
    await assert.rejects(executor.archiveIdle(task), /дочерние задачи должны быть завершены/u);
    assert.equal(rpc.requests.filter(item => item.method === "thread/archive").length, 0);
    rpc.emptyDescendantUpdatedAt -= 600;
    await executor.archiveIdle(task);
    assert.equal(rpc.requests.filter(item => item.method === "thread/archive").length, 1);
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
