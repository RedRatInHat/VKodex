import assert from "node:assert/strict";
import test from "node:test";
import { AppServerRejectedError, AppServerUnavailableError, AppServerUncertainError, type AppServerEnvelope, type AppServerInitializedSession,
  type AppServerRequestOptions, type AppServerRpc, type AppServerServerRequestHandler } from "../src/codex/app-server-connection.js";
import { AppServerProfileOwner, AppServerOwnerStateRouter } from "../src/codex/app-server-profile-owner.js";
import { ActionRejectedError, TaskOwnedByClientError } from "../src/core/codex-tasks.js";
import { RoutedCodexTasks } from "../src/core/codex-task-router.js";
import type { CodexTasks } from "../src/core/codex-tasks.js";
import { LegacyExecutionLifecycle } from "../src/codex/legacy-execution-lifecycle.js";

type JsonObject = Record<string, unknown>;
class Rpc implements AppServerRpc {
  readonly calls: string[] = []; readonly resumeTimeouts: number[] = [];
  readonly requests: Array<{ method: string; params: JsonObject; options?: AppServerRequestOptions }> = [];
  closed = 0; starts = 0; projectId: string | null = null; waitResume: Promise<void> | null = null;
  waitUnsubscribe: Promise<void> | null = null; failUnsubscribe = false; unsubscribeStatus = "unsubscribed";
  threadStatus: "idle" | "active" | "notLoaded" | "systemError" = "idle";
  generation = 1; sessionAvailable = true;
  failResume: Error | null = null;
  threadListResponse: JsonObject = { data: [], nextCursor: null };
  loadedListResponse: JsonObject = { data: ["task"], nextCursor: null };
  turnsListResponse: JsonObject = { data: [{ id: "accepted-turn", items: [
    { type: "userMessage", clientId: "accepted-operation" },
  ] }], nextCursor: null };
  queueListResponse: JsonObject = { data: [], nextCursor: null };
  goalResponse: JsonObject = { goal: null };
  readonly threadReadResponses = new Map<string, JsonObject>();
  waitTurnStart: Promise<void> | null = null; onTurnStart?: () => void; failTurnStart: Error | null = null;
  turnStartEnvelope: { error: JsonObject } | null = null;
  onRequest?: (method: string) => void; beforeGuard?: (method: string) => void;
  pauseMethod: string | null = null; pauseGate: Promise<void> | null = null; onPausedRequest?: () => void;
  private readonly notifications = new Set<(notification: AppServerEnvelope) => void>();
  serverHandler: AppServerServerRequestHandler | null = null;
  async start(): Promise<void> { this.starts++; }
  currentInitializedSession(): AppServerInitializedSession | null {
    return this.sessionAvailable ? structuredClone({ generation: this.generation,
      initializeResult: { serverInfo: { name: "fixture" } } }) : null;
  }
  async request(method: string, _params: JsonObject = {}, _options?: AppServerRequestOptions): Promise<JsonObject> {
    if (_options?.expectedGeneration !== undefined &&
      this.currentInitializedSession()?.generation !== _options.expectedGeneration) throw new AppServerUnavailableError();
    this.beforeGuard?.(method);
    _options?.assertBeforeWrite?.();
    this.onRequest?.(method);
    this.calls.push(method);
    this.requests.push({ method, params: structuredClone(_params), ...(_options ? { options: _options } : {}) });
    if (method === this.pauseMethod && this.pauseGate) { this.onPausedRequest?.(); await this.pauseGate; }
    if (method === "thread/resume") {
      this.resumeTimeouts.push(_options?.timeoutMs ?? 30_000);
      if (this.waitResume) await this.waitResume;
      if (this.failResume) throw this.failResume;
      return { thread: { id: String(_params.threadId ?? "task"), name: "Task", cwd: "D:\\w", status: { type: "idle" } },
        cwd: "D:\\w", model: "gpt", reasoningEffort: "high", initialTurnsPage: { data: [], nextCursor: null } };
    }
    if (method === "thread/unsubscribe") {
      if (this.waitUnsubscribe) await this.waitUnsubscribe;
      if (this.failUnsubscribe) throw new Error("release result unknown");
      return { status: this.unsubscribeStatus };
    }
    if (method === "turn/start") {
      this.onTurnStart?.();
      if (this.waitTurnStart) await this.waitTurnStart;
      if (this.failTurnStart) {
        if (this.turnStartEnvelope) _options?.onResponseEnvelope?.(this.turnStartEnvelope);
        throw this.failTurnStart;
      }
      return { turn: { id: "turn" } };
    }
    if (method === "thread/queue/add") return { queuedSubmission: {
      id: "queued-submission", clientUserMessageId: _params.clientUserMessageId,
    } };
    if (method === "thread/read") {
      const threadId = String(_params.threadId ?? "task");
      return structuredClone(this.threadReadResponses.get(threadId) ??
        { thread: { id: threadId, name: "Task", projectId: this.projectId,
          status: { type: threadId === "task" ? this.threadStatus : "idle" } } });
    }
    if (method === "thread/metadata/update") { this.projectId = _params.projectId ? String(_params.projectId) : null; return {}; }
    if (method === "thread/list") return structuredClone(this.threadListResponse);
    if (method === "thread/loaded/list") return structuredClone(this.loadedListResponse);
    if (method === "thread/goal/get") return structuredClone(this.goalResponse);
    if (method === "thread/queue/list") return structuredClone(this.queueListResponse);
    if (method === "thread/turns/list") return structuredClone(this.turnsListResponse);
    if (method === "thread/archive") return {};
    throw new Error(method);
  }
  notify(notification: AppServerEnvelope): void { for (const listener of this.notifications) listener(notification); }
  onNotification(listener: (notification: AppServerEnvelope) => void): () => void {
    this.notifications.add(listener); return () => { this.notifications.delete(listener); };
  }
  onServerRequest(handler: AppServerServerRequestHandler | null): void { this.serverHandler = handler; }
  async close(): Promise<void> { this.closed++; }
}

type DrainStatus = "waiting-unload" | "released" | "blocked" | "unavailable";
type DrainableOwner = AppServerProfileOwner & {
  drainIdleExecution?: (task: { hostId: string; threadId: string; sourceId: string }, beforeRelease: () => void) => Promise<DrainStatus>;
};
const taskRef = { hostId: "local", threadId: "task", sourceId: "work" };
test("predecessor source quarantine refuses cold reads and unlisted tasks without starting a backend", async () => {
  const rpc = new Rpc();
  const owner = Reflect.construct(AppServerProfileOwner,
    ["work", rpc, undefined, undefined, undefined, undefined, true]) as AppServerProfileOwner;
  const unlisted = { ...taskRef, threadId: "not-in-snapshot" };
  try {
    assert.equal(await owner.ownerAdapterStatus(taskRef), "unknown");
    assert.throws(() => owner.states.subscribe(unlisted, () => {}, () => {}), ActionRejectedError);
    await assert.rejects(owner.ensureOpen(unlisted), ActionRejectedError);
    await assert.rejects(owner.inspectTask(taskRef), ActionRejectedError);
    await assert.rejects(async () => owner.getGoal(taskRef), ActionRejectedError);
    await assert.rejects(owner.findAcceptedInput(taskRef, "old-operation"), ActionRejectedError);
    await assert.rejects(owner.interrupt(taskRef), ActionRejectedError);
    assert.deepEqual(rpc.calls, []);
    assert.equal(rpc.starts, 0);
  } finally { await owner.close(); }
  const coldRpc = new Rpc(); const lifecycle = new LegacyExecutionLifecycle(coldRpc, undefined, true);
  try {
    await assert.rejects(lifecycle.rpc.start(), ActionRejectedError);
    await assert.rejects(lifecycle.rpc.request("thread/read", { threadId: taskRef.threadId }), ActionRejectedError);
    assert.equal(coldRpc.starts, 0);
    assert.deepEqual(coldRpc.calls, []);
  } finally { lifecycle.close(); }
});

test("owner adapter metadata cannot report ready across a legacy acquisition fence", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {});
  rpc.failResume = new AppServerUncertainError();
  await assert.rejects(stream.start(), AppServerUncertainError);
  const before = rpc.calls.length;
  const launches = rpc.starts;
  assert.equal(owner.legacyAcquisitionState(taskRef), "unknown");
  assert.equal(await owner.ownerAdapterStatus(taskRef), "unknown");
  assert.equal(rpc.calls.length, before, "a known fence needs no metadata RPC or launch");
  assert.equal(rpc.starts, launches, "diagnostic accessor never starts the backend");
  rpc.requests.find(request => request.method === "thread/resume")?.options?.onLateResponseEnvelope?.(
    { result: { thread: { id: taskRef.threadId, status: { type: "idle" } } } });
  assert.equal(owner.legacyAcquisitionState(taskRef), "abandoned");
  assert.equal(await owner.ownerAdapterStatus(taskRef), "unknown");
  assert.equal(rpc.calls.length, before, "a late ACK is diagnostic evidence, not a new probe");
  stream.close(); await owner.close();
});

test("owner adapter status rechecks a fence that appears while metadata is pending", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  let release!: () => void;
  rpc.pauseMethod = "thread/read";
  rpc.pauseGate = new Promise<void>(resolve => { release = resolve; });
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  rpc.onPausedRequest = () => reading();
  const status = owner.ownerAdapterStatus(taskRef);
  await started;
  rpc.failResume = new AppServerUncertainError();
  const stream = owner.states.subscribe(taskRef, () => {}, () => {});
  await assert.rejects(stream.start(), AppServerUncertainError);
  release();
  assert.equal(await status, "unknown", "a stale metadata response cannot imply input readiness");
  stream.close(); await owner.close();
});
function drainIdle(owner: AppServerProfileOwner, beforeRelease: () => void): Promise<DrainStatus> {
  const drain = (owner as DrainableOwner).drainIdleExecution;
  return drain ? drain.call(owner, taskRef, beforeRelease) : Promise.resolve("unavailable");
}
function isBlocked(status: DrainStatus): boolean { return status === "blocked" || status === "unavailable"; }

test("publishing drain is not starved by another task's progress on the same profile", async t => {
  for (const shape of ["MS/Steam historical queued receipt", "android terminal turn receipt"] as const)
    await t.test(shape, async () => {
      const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
      const stream = owner.states.subscribe(taskRef, () => {}, () => {});
      await stream.start();
      const operationId = "publishing-receipt";
      if (shape === "MS/Steam historical queued receipt") {
        await owner.queue({ operationId, task: taskRef, text: "synthetic publishing request" });
        rpc.turnsListResponse = { data: [{ id: "terminal-queued-turn", status: "completed",
          items: [{ type: "userMessage", clientId: operationId }] }], nextCursor: null };
      } else {
        await owner.submitWithReceipt({ operationId, task: taskRef, text: "synthetic publishing request" });
        rpc.turnsListResponse = { data: [{ id: "turn", status: "completed", items: [] }], nextCursor: null };
      }
      const otherTaskId = "unrelated-active-task";
      rpc.onRequest = method => {
        if (method === "thread/read" || method === "thread/queue/list") {
          rpc.notify({ method: "item/agentMessage/delta", params: { threadId: otherTaskId,
            turnId: "other-turn", itemId: "other-item", delta: "synthetic progress" } });
          rpc.notify({ method: "thread/status/changed", params: { threadId: otherTaskId,
            status: { type: "active" } } });
        }
      };
      rpc.beforeGuard = method => {
        if (method === "thread/unsubscribe") rpc.notify({ method: "item/agentMessage/delta",
          params: { threadId: otherTaskId, turnId: "other-turn", itemId: "other-item", delta: "last progress" } });
      };
      const before = rpc.calls.length;
      let releases = 0;
      const close = () => { releases++; stream.close(); };
      try {
        assert.equal(await drainIdle(owner, close), "waiting-unload");
        assert.equal(releases, 1);
        assert.equal(rpc.calls.slice(before).filter(method => method === "thread/unsubscribe").length, 1);
        assert.equal(rpc.calls.slice(before).some(method =>
          ["thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(method)), false);
        rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId } });
        assert.equal(await drainIdle(owner, close), "released");
        assert.equal(releases, 1, "unload confirmation must not repeat the release");
      } finally { stream.close(); await owner.close(); }
    });
});

test("a missed close is recovered from the original Publishing owner's notLoaded read", async t => {
  for (const shape of ["MS/Steam historical queued receipt", "android terminal turn receipt"] as const)
    await t.test(shape, async () => {
      const rpc = new Rpc(); let now = 0;
      const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
      const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
      if (shape === "MS/Steam historical queued receipt") {
        await owner.queue({ operationId: "publishing-receipt", task: taskRef, text: "synthetic publishing request" });
        rpc.turnsListResponse = { data: [{ id: "terminal-queued-turn", status: "completed",
          items: [{ type: "userMessage", clientId: "publishing-receipt" }] }], nextCursor: null };
      } else {
        await owner.submitWithReceipt({ operationId: "publishing-receipt", task: taskRef, text: "synthetic publishing request" });
        rpc.turnsListResponse = { data: [{ id: "turn", status: "completed", items: [] }], nextCursor: null };
      }
      let releases = 0;
      const close = () => { releases++; stream.close(); };
      try {
        assert.equal(await drainIdle(owner, close), "waiting-unload");
        await new Promise<void>(resolve => setImmediate(resolve));
        const before = rpc.requests.length;
        rpc.threadStatus = "notLoaded";
        now = 31 * 60_000 - 1;
        assert.equal(await drainIdle(owner, close), "waiting-unload");
        assert.equal(rpc.requests.length, before);
        now++;
        assert.equal(await drainIdle(owner, close), "released");
        assert.deepEqual(rpc.requests.slice(before).map(request => request.method), ["thread/read"]);
        assert.deepEqual(rpc.requests.at(-1)?.params, { threadId: taskRef.threadId, includeTurns: false });
        assert.equal(rpc.requests.at(-1)?.options?.expectedGeneration, 1);
        assert.equal(releases, 1);
        assert.equal(rpc.starts, 0);
      } finally { stream.close(); await owner.close(); }
    });
});

test("waiting-unload readback accepts only exact notLoaded and retains a 31-minute retry interval", async () => {
  const rpc = new Rpc(); let now = 0;
  const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let releases = 0; const close = () => { releases++; stream.close(); };
  try {
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    await new Promise<void>(resolve => setImmediate(resolve));
    const start = rpc.requests.length;
    const responses: JsonObject[] = [
      { thread: { id: taskRef.threadId, status: { type: "idle" } } },
      { thread: { id: taskRef.threadId, status: { type: "active" } } },
      { thread: { id: taskRef.threadId, status: { type: "systemError" } } },
      { thread: { id: "other-thread", status: { type: "notLoaded" } } },
      { thread: { id: taskRef.threadId, status: {} } },
    ];
    for (const response of responses) {
      rpc.threadReadResponses.set(taskRef.threadId, response);
      now += 31 * 60_000;
      assert.equal(await drainIdle(owner, close), "waiting-unload");
      const count = rpc.requests.length;
      for (let i = 0; i < 5; i++) assert.equal(await drainIdle(owner, close), "waiting-unload");
      assert.equal(rpc.requests.length, count, "maintenance calls cannot hot poll");
    }
    rpc.threadReadResponses.set(taskRef.threadId,
      { thread: { id: taskRef.threadId, status: { type: "notLoaded" } } });
    now += 31 * 60_000;
    assert.equal(await drainIdle(owner, close), "released");
    assert.deepEqual(rpc.requests.slice(start).map(request => request.method), Array(6).fill("thread/read"));
    assert.equal(releases, 1);
  } finally { stream.close(); await owner.close(); }
});

test("concurrent waiting-unload drains share one read and a changed generation cannot release", async () => {
  const rpc = new Rpc(); let now = 0;
  const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const close = () => stream.close();
  try {
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    await new Promise<void>(resolve => setImmediate(resolve));
    now = 31 * 60_000;
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const paused = new Promise<void>(resolve => { entered = resolve; });
    rpc.pauseMethod = "thread/read"; rpc.pauseGate = gate; rpc.onPausedRequest = entered;
    rpc.threadStatus = "notLoaded";
    const start = rpc.requests.length;
    const first = drainIdle(owner, close);
    await paused;
    const second = drainIdle(owner, close);
    assert.equal(rpc.requests.slice(start).filter(request => request.method === "thread/read").length, 1);
    rpc.generation++;
    resume();
    assert.deepEqual(await Promise.all([first, second]), ["unavailable", "unavailable"]);
    assert.equal(await drainIdle(owner, close), "unavailable");
    assert.equal(rpc.starts, 0);
  } finally { stream.close(); await owner.close(); }
});

test("readback cadence begins at the successful unsubscribe acknowledgment", async () => {
  const rpc = new Rpc(); let now = 0;
  const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let acknowledge!: () => void;
  rpc.waitUnsubscribe = new Promise<void>(resolve => { acknowledge = resolve; });
  const close = () => stream.close();
  try {
    const pending = drainIdle(owner, close);
    while (!rpc.calls.includes("thread/unsubscribe")) await new Promise<void>(resolve => setImmediate(resolve));
    now = 10 * 60_000;
    acknowledge();
    assert.equal(await pending, "waiting-unload");
    await new Promise<void>(resolve => setImmediate(resolve));
    rpc.threadStatus = "notLoaded";
    const start = rpc.requests.length;
    now = 31 * 60_000;
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    assert.equal(rpc.requests.length, start);
    now = 41 * 60_000;
    assert.equal(await drainIdle(owner, close), "released");
    assert.deepEqual(rpc.requests.slice(start).map(request => request.method), ["thread/read"]);
  } finally { acknowledge(); stream.close(); await owner.close(); }
});

test("failed unsubscribe and restored generation-zero fences never read back", async () => {
  const rpc = new Rpc(); rpc.failUnsubscribe = true;
  let now = 0;
  const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  try {
    assert.equal(await drainIdle(owner, () => stream.close()), "unavailable");
    const start = rpc.requests.length;
    now = 100 * 60_000;
    assert.equal(await drainIdle(owner, () => assert.fail("release must not repeat")), "unavailable");
    assert.equal(rpc.requests.length, start);
  } finally { stream.close(); await owner.close(); }
  const restoredRpc = new Rpc();
  const restored = new AppServerProfileOwner("work", restoredRpc, undefined, undefined, undefined, () => now);
  try {
    restored.restoreExecutionDrain(taskRef);
    assert.equal(await drainIdle(restored, () => assert.fail("restored fence cannot release")), "unavailable");
    assert.deepEqual(restoredRpc.requests, []);
  } finally { await restored.close(); }
});

test("a skipped or malformed unsubscribe acknowledgment never enables readback", async t => {
  for (const status of ["skipped", "unexpected"] as const) await t.test(status, async () => {
    const rpc = new Rpc(); rpc.unsubscribeStatus = status;
    let now = 0;
    const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
    const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
    try {
      assert.equal(await drainIdle(owner, () => stream.close()), "unavailable");
      const start = rpc.requests.length;
      now = 100 * 60_000;
      assert.equal(await drainIdle(owner, () => assert.fail("release must not repeat")), "unavailable");
      assert.equal(rpc.requests.length, start);
    } finally { stream.close(); await owner.close(); }
  });
});

test("target and unscoped events during readback invalidate absence proof", async t => {
  for (const notification of [
    { method: "thread/status/changed", params: { threadId: taskRef.threadId, status: { type: "active" } } },
    { method: "unrecognized/native", params: {} },
  ]) await t.test(notification.method, async () => {
    const rpc = new Rpc(); let now = 0;
    const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
    const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
    const close = () => stream.close();
    try {
      assert.equal(await drainIdle(owner, close), "waiting-unload");
      await new Promise<void>(resolve => setImmediate(resolve));
      now = 31 * 60_000; rpc.threadStatus = "notLoaded";
      let resume!: () => void;
      let entered!: () => void;
      rpc.pauseMethod = "thread/read";
      rpc.pauseGate = new Promise<void>(resolve => { resume = resolve; });
      const paused = new Promise<void>(resolve => { entered = resolve; });
      rpc.onPausedRequest = entered;
      const pending = drainIdle(owner, close);
      await paused;
      rpc.notify(notification);
      resume();
      assert.equal(await pending, "waiting-unload");
      rpc.pauseMethod = null; rpc.pauseGate = null;
      now += 31 * 60_000;
      assert.equal(await drainIdle(owner, close), "released");
    } finally { stream.close(); await owner.close(); }
  });
});

test("readback failure retains waiting and backs off", async () => {
  const rpc = new Rpc(); let now = 0;
  const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const close = () => stream.close();
  try {
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    await new Promise<void>(resolve => setImmediate(resolve));
    let attempts = 0;
    rpc.onRequest = method => { if (method === "thread/read" && ++attempts === 1) throw new Error("read failed"); };
    now = 31 * 60_000;
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    now += 60_000;
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    assert.equal(attempts, 1);
    rpc.threadStatus = "notLoaded";
    now = 62 * 60_000;
    assert.equal(await drainIdle(owner, close), "released");
    assert.equal(attempts, 2);
  } finally { stream.close(); await owner.close(); }
});

test("a same-generation closed notification wins while readback is pending", async () => {
  const rpc = new Rpc(); let now = 0;
  const owner = new AppServerProfileOwner("work", rpc, undefined, undefined, undefined, () => now);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const close = () => stream.close();
  try {
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    await new Promise<void>(resolve => setImmediate(resolve));
    now = 31 * 60_000;
    let resume!: () => void;
    let entered!: () => void;
    rpc.pauseMethod = "thread/read";
    rpc.pauseGate = new Promise<void>(resolve => { resume = resolve; });
    const paused = new Promise<void>(resolve => { entered = resolve; });
    rpc.onPausedRequest = entered;
    const pending = drainIdle(owner, close);
    await paused;
    rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId } });
    resume();
    assert.equal(await pending, "released");
    assert.equal(await drainIdle(owner, close), "released");
  } finally { stream.close(); await owner.close(); }
});

test("a conflicting thread identity in a closed notification cannot release the drain", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const close = () => stream.close();
  try {
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId,
      thread: { id: "conflicting-thread" } } });
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    rpc.notify({ method: "thread/closed", params: { threadId: "bad thread id" } });
    assert.equal(await drainIdle(owner, close), "waiting-unload");
    rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId } });
    assert.equal(await drainIdle(owner, close), "released");
  } finally { stream.close(); await owner.close(); }
});

test("another task's subscription start and close during discovery cannot starve idle drain", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const other = owner.states.subscribe({ ...taskRef, threadId: "unrelated-task" }, () => {}, () => {});
  let entered!: () => void; const discovering = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const discovery = new Promise<void>(resolve => { resume = resolve; });
  rpc.pauseMethod = "thread/list"; rpc.pauseGate = discovery; rpc.onPausedRequest = entered;
  let releases = 0;
  const draining = drainIdle(owner, () => { releases++; stream.close(); });
  try {
    await discovering;
    await other.start(); other.close();
    resume();
    assert.equal(await draining, "waiting-unload");
    assert.equal(releases, 1);
    assert.equal(rpc.requests.filter(request => request.method === "thread/unsubscribe"
      && request.params.threadId === taskRef.threadId).length, 1);
  } finally { resume(); await draining; stream.close(); other.close(); await owner.close(); }
});

test("family, topology and ambiguous events remain fences during discovery and at the wire", async t => {
  const events: Array<{ name: string; event: AppServerEnvelope }> = [
    { name: "root progress", event: { method: "item/agentMessage/delta", params: { threadId: "task", delta: "progress" } } },
    { name: "child discovered after event", event: { method: "thread/status/changed", params: { threadId: "child", status: { type: "active" } } } },
    { name: "new family topology", event: { method: "thread/started", params: { thread: { id: "new-child" } } } },
    { name: "archived topology", event: { method: "thread/archived", params: { threadId: "unrelated" } } },
    { name: "unknown scoped method", event: { method: "future/native/event", params: { threadId: "unrelated" } } },
    { name: "missing thread scope", event: { method: "item/agentMessage/delta", params: { itemId: "item", delta: "progress" } } },
    { name: "blank thread scope", event: { method: "item/agentMessage/delta", params: { threadId: " " } } },
    { name: "control character scope", event: { method: "thread/status/changed", params: { threadId: "bad\u0000id" } } },
    { name: "oversized thread scope", event: { method: "thread/status/changed", params: { threadId: "x".repeat(1024) } } },
    { name: "conflicting thread scope", event: { method: "thread/status/changed", params: { threadId: "unrelated", thread: { id: "task" } } } },
  ];
  for (const phase of ["discovery", "wire"] as const) for (const scenario of events)
    await t.test(`${phase}: ${scenario.name}`, async () => {
      const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
      rpc.threadListResponse = { data: [{ id: "child" }], nextCursor: null };
      const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
      let injected = false;
      const inject = (method: string) => {
        if (!injected && method === (phase === "discovery" ? "thread/list" : "thread/unsubscribe")) {
          injected = true; rpc.notify(scenario.event);
        }
      };
      if (phase === "discovery") rpc.onRequest = inject; else rpc.beforeGuard = inject;
      let releases = 0;
      try {
        const result = await drainIdle(owner, () => { releases++; stream.close(); });
        assert.equal(result, phase === "discovery" ? "blocked" : "unavailable");
        assert.equal(injected, true);
        assert.equal(releases, phase === "discovery" ? 0 : 1);
        assert.equal(rpc.calls.includes("thread/unsubscribe"), false,
          "a changed family/ambiguous scope cannot write unsubscribe");
      } finally { delete rpc.onRequest; delete rpc.beforeGuard; stream.close(); await owner.close(); }
    });
});

test("malformed server-request scope retains the unscoped pending-write fence", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let written!: () => void; const responseWritten = new Promise<void>(resolve => { written = resolve; });
  try {
    assert.ok(rpc.serverHandler);
    await Promise.resolve().then(() => rpc.serverHandler!({ id: "synthetic-question",
      method: "item/tool/requestUserInput", params: { threadId: " ", turnId: "other-turn", itemId: "question", questions: [] } },
    { signal: new AbortController().signal, responseWritten })).catch(() => {});
    let releases = 0;
    assert.equal(await drainIdle(owner, () => { releases++; stream.close(); }), "blocked");
    assert.equal(releases, 0, "ambiguous question scope cannot be assumed unrelated");
  } finally { written(); await new Promise(resolve => setImmediate(resolve)); stream.close(); await owner.close(); }
});

test("revision cache pressure invalidates an in-flight proof and permits a fresh bounded proof", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let injected = false;
  rpc.onRequest = method => {
    if (!injected && method === "thread/list") {
      injected = true;
      for (let i = 0; i < 5000; i++) rpc.notify({ method: "item/agentMessage/delta",
        params: { threadId: `unrelated-${i}`, delta: "synthetic progress" } });
    }
  };
  let releases = 0;
  const close = () => { releases++; stream.close(); };
  try {
    assert.equal(await drainIdle(owner, close), "blocked", "eviction must invalidate rather than forget proof changes");
    assert.equal(releases, 0);
    assert.equal(await drainIdle(owner, close), "waiting-unload", "cache pressure does not permanently fence fresh proof");
    assert.equal(releases, 1);
  } finally { delete rpc.onRequest; stream.close(); await owner.close(); }
});

test("idle execution drain closes only the current owner stream and waits for matching unload", async () => {
  const rpc = new Rpc(); rpc.turnsListResponse = { data: [{ id: "turn", status: "completed", items: [] }], nextCursor: null };
  const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {});
  await stream.start();
  await owner.submitWithReceipt({ operationId: "terminal-proof", task: taskRef, text: "fixture" });
  const drainStart = rpc.calls.length;
  let releaseCalls = 0;
  const beforeRelease = () => { releaseCalls++; stream.close(); };
  try {
    assert.equal(await drainIdle(owner, beforeRelease), "waiting-unload");
    assert.equal(releaseCalls, 1, "the synchronous callback must release the exact owner stream once");
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 1,
      "drain waits for the actual unsubscribe acknowledgment");
    const drainCalls = rpc.calls.slice(drainStart);
    for (const method of ["thread/read", "thread/list", "thread/goal/get", "thread/queue/list", "thread/turns/list"])
      assert.ok(drainCalls.includes(method), `idle proof must include ${method}`);
    assert.ok(drainCalls.every(method => ["thread/read", "thread/list", "thread/goal/get", "thread/queue/list",
      "thread/turns/list", "thread/loaded/list", "thread/unsubscribe"].includes(method)),
    "drain must stay on bounded native reads plus the exact subscription release");
    assert.equal(drainCalls.some(method => ["thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(method)), false,
      "drain must not acquire a writer or start/replay work");
    assert.ok(rpc.requests.slice(drainStart).filter(request => drainCalls.includes(request.method)
      && ["thread/read", "thread/list", "thread/goal/get", "thread/queue/list", "thread/turns/list", "thread/loaded/list"].includes(request.method))
      .every(request => request.options?.expectedGeneration === 1), "every drain read is pinned to the initialized generation");

    rpc.notify({ method: "thread/closed", params: { threadId: "another-thread" } });
    assert.equal(await drainIdle(owner, beforeRelease), "waiting-unload", "an unrelated close event cannot release the gate");
    rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId } });
    assert.equal(await drainIdle(owner, beforeRelease), "released");
    assert.equal(releaseCalls, 1);
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 1);
    await assert.rejects(owner.submitWithReceipt({ operationId: "after-release", task: taskRef, text: "fixture" }), TaskOwnedByClientError,
      "only a same-generation native unload releases the drain fence, and the old owner cannot write afterward");
  } finally { stream.close(); await owner.close(); }
});

test("a cold owner drain returns unavailable without starting or requesting anything", async () => {
  const rpc = new Rpc(); rpc.sessionAvailable = false;
  const owner = new AppServerProfileOwner("work", rpc);
  try {
    assert.equal(await drainIdle(owner, () => assert.fail("cold drain cannot release an owner")), "unavailable");
    assert.equal(rpc.starts, 0);
    assert.deepEqual(rpc.calls, []);
  } finally { await owner.close(); }
});

test("a restored unavailable-generation fence blocks all owner entrypoints without RPC", async t => {
  const attempts: Array<{ name: string; run(owner: AppServerProfileOwner): Promise<unknown> }> = [
    { name: "ensureOpen", run: owner => owner.ensureOpen(taskRef) },
    { name: "selectModel", run: owner => owner.selectModel(taskRef, "model", "effort") },
    { name: "setGoal", run: owner => owner.setGoal(taskRef, { objective: "fixture", status: "active" }) },
    { name: "archiveRetryReady", run: owner => owner.archiveRetryReady(taskRef) },
    { name: "renameTask", run: owner => owner.renameTask(taskRef, "fixture") },
    { name: "archiveTask", run: owner => owner.archiveTask(taskRef) },
    { name: "interrupt current-work control", run: owner => owner.interrupt(taskRef) },
    { name: "clearGoal current-work control", run: owner => owner.clearGoal(taskRef) },
  ];
  for (const attempt of attempts) await t.test(attempt.name, async () => {
    const rpc = new Rpc(); rpc.sessionAvailable = false;
    const owner = new AppServerProfileOwner("work", rpc);
    const restorer = (owner as AppServerProfileOwner & { restoreExecutionDrain?: (task: typeof taskRef) => void }).restoreExecutionDrain;
    restorer?.call(owner, taskRef);
    try {
      await assert.rejects(attempt.run(owner), ActionRejectedError,
        "a recovered unavailable owner must reject all execution entrypoints as a non-fallback result");
      assert.equal(rpc.starts, 0, "restoration is synchronous and cannot start the App Server");
      assert.deepEqual(rpc.calls, [], "the generation-zero fence cannot resume or issue a native write");
      assert.equal(typeof restorer, "function", "the profile owner exposes the synchronous recovery fence");
    } finally { await owner.close(); }
  });
});

test("restoring an execution fence for a foreign source rejects before RPC", async () => {
  const rpc = new Rpc(); rpc.sessionAvailable = false;
  const owner = new AppServerProfileOwner("work", rpc);
  const restorer = (owner as AppServerProfileOwner & { restoreExecutionDrain?: (task: typeof taskRef) => void }).restoreExecutionDrain;
  try {
    assert.equal(typeof restorer, "function", "the profile owner exposes the synchronous recovery fence");
    assert.throws(() => restorer?.call(owner, { ...taskRef, sourceId: "foreign" }), ActionRejectedError);
    assert.equal(rpc.starts, 0);
    assert.deepEqual(rpc.calls, []);
  } finally { await owner.close(); }
});

test("routed recovered owners never fall back to native base operations", async () => {
  const rpc = new Rpc(); rpc.sessionAvailable = false;
  const owner = new AppServerProfileOwner("work", rpc);
  const capabilities = { createTask: false, startTurn: false, steerTurn: false, interruptTurn: false, selectModel: false };
  const nativeBase = new Proxy({} as CodexTasks, { get(_target, property) {
    if (property === "capabilities") return capabilities;
    throw new Error(`native base fallback was touched: ${String(property)}`);
  } });
  const routed = new RoutedCodexTasks(nativeBase, [owner]);
  try {
    routed.restoreExecutionDrain(taskRef);
    await assert.rejects(routed.selectModel(taskRef, "model", "effort"), ActionRejectedError);
    await assert.rejects(routed.setGoal(taskRef, { objective: "fixture", status: "active" }), ActionRejectedError);
    await assert.rejects(routed.ensureOpen(taskRef), ActionRejectedError);
    await assert.rejects(routed.interrupt(taskRef), ActionRejectedError);
    assert.equal(rpc.starts, 0);
    assert.deepEqual(rpc.calls, []);
  } finally { await owner.close(); }
});

test("active descendants, goals, and queued inputs fail closed before releasing the owner", async t => {
  const cases: Array<{ name: string; configure(rpc: Rpc): void }> = [
    { name: "active root", configure: rpc => { rpc.threadStatus = "active"; } },
    { name: "active descendant", configure: rpc => {
      rpc.threadListResponse = { data: [{ id: "child" }], nextCursor: null };
      rpc.threadReadResponses.set("child", { thread: { id: "child", status: { type: "active" } } });
    } },
    { name: "active goal", configure: rpc => { rpc.goalResponse = { goal: { id: "goal", status: "active" } }; } },
    { name: "nonempty native queue", configure: rpc => { rpc.queueListResponse = { data: [{ id: "queued" }], nextCursor: null }; } },
    { name: "malformed native queue page", configure: rpc => { rpc.queueListResponse = { data: {}, nextCursor: null }; } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const rpc = new Rpc(); scenario.configure(rpc);
    const owner = new AppServerProfileOwner("work", rpc);
    const stream = owner.states.subscribe(taskRef, () => {}, () => {});
    await stream.start();
    let releaseCalls = 0;
    const beforeRelease = () => { releaseCalls++; stream.close(); };
    try {
      const before = rpc.calls.length;
      const status = await drainIdle(owner, beforeRelease);
      assert.ok(isBlocked(status), `unsafe snapshot must return blocked/unavailable, got ${status}`);
      assert.equal(releaseCalls, 0, "uncertain or non-idle task must retain its owner stream");
      assert.equal(rpc.calls.slice(before).includes("thread/unsubscribe"), false);
      assert.equal(rpc.calls.slice(before).some(method => ["thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(method)), false);
    } finally { stream.close(); await owner.close(); }
  });
});

test("an additional live state consumer blocks drain without closing the shared upstream", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const first = owner.states.subscribe(taskRef, () => {}, () => {});
  const second = owner.states.subscribe(taskRef, () => {}, () => {});
  await Promise.all([first.start(), second.start()]);
  try {
    let releaseCalls = 0;
    const status = await drainIdle(owner, () => { releaseCalls++; first.close(); });
    assert.ok(isBlocked(status));
    assert.equal(releaseCalls, 0, "a different live consumer prevents releasing its shared stream");
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 0);
  } finally { first.close(); second.close(); await owner.close(); }
});

test("a generation change while waiting for unload cannot release a stale drain", async () => {
  const rpc = new Rpc(); rpc.turnsListResponse = { data: [], nextCursor: null };
  const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let releaseCalls = 0;
  const beforeRelease = () => { releaseCalls++; stream.close(); };
  try {
    assert.equal(await drainIdle(owner, beforeRelease), "waiting-unload");
    rpc.generation++;
    rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId } });
    const status = await drainIdle(owner, beforeRelease);
    assert.notEqual(status, "released", "a replacement initialized generation cannot satisfy the previous drain");
    assert.equal(releaseCalls, 1);
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 1);
  } finally { stream.close(); await owner.close(); }
});

test("a generation change during idle proof refuses the release callback and wire close", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const drainStart = rpc.calls.length;
  let releaseCalls = 0; let changed = false;
  rpc.onRequest = method => { if (!changed && method === "thread/read") { changed = true; rpc.generation++; } };
  try {
    const status = await drainIdle(owner, () => { releaseCalls++; stream.close(); });
    assert.equal(status, "unavailable");
    assert.equal(releaseCalls, 0, "proof from the retired connection cannot revoke the current owner");
    const drainCalls = rpc.calls.slice(drainStart);
    assert.equal(drainCalls.includes("thread/unsubscribe"), false);
    assert.equal(drainCalls.some(method => ["thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(method)), false);
  } finally { stream.close(); await owner.close(); }
});

test("an idle proof that exhausts its monotonic deadline never releases or writes", async t => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let now = 0;
  t.mock.method(performance, "now", () => { const value = now; now += 5_000; return value; });
  const drainStart = rpc.calls.length;
  try {
    let releaseCalls = 0;
    assert.equal(await drainIdle(owner, () => { releaseCalls++; stream.close(); }), "unavailable");
    assert.equal(releaseCalls, 0);
    const drainCalls = rpc.calls.slice(drainStart);
    assert.equal(drainCalls.includes("thread/unsubscribe"), false);
    assert.equal(drainCalls.some(method => ["thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(method)), false);
  } finally { stream.close(); await owner.close(); }
});

test("an oversized native descendant page fails closed without release", async () => {
  const rpc = new Rpc(); rpc.threadListResponse = { data: Array.from({ length: 101 }, (_, index) => ({ id: `child-${index}` })), nextCursor: null };
  const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const drainStart = rpc.calls.length;
  try {
    let releaseCalls = 0;
    assert.equal(await drainIdle(owner, () => { releaseCalls++; stream.close(); }), "unavailable");
    assert.equal(releaseCalls, 0);
    const drainCalls = rpc.calls.slice(drainStart);
    assert.equal(drainCalls.filter(method => method === "thread/list").length, 1);
    assert.equal(drainCalls.includes("thread/unsubscribe"), false);
    assert.equal(drainCalls.some(method => ["thread/resume", "turn/start", "turn/steer", "thread/queue/add"].includes(method)), false);
  } finally { stream.close(); await owner.close(); }
});

test("a pending dispatched turn mutation blocks drain and is never retried", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let entered!: () => void; const mutationEntered = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; rpc.waitTurnStart = new Promise<void>(resolve => { finish = resolve; });
  rpc.onTurnStart = () => entered();
  const submit = owner.submitWithReceipt({ operationId: "pending-turn", task: taskRef, text: "fixture" });
  await mutationEntered;
  try {
    let releaseCalls = 0;
    const before = rpc.calls.filter(method => method === "turn/start").length;
    const status = await drainIdle(owner, () => { releaseCalls++; stream.close(); });
    assert.ok(isBlocked(status));
    assert.equal(releaseCalls, 0);
    assert.equal(rpc.calls.filter(method => method === "turn/start").length, before,
      "drain cannot replay or issue another turn/start while an earlier mutation is pending");
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 0);
  } finally { finish(); await Promise.allSettled([submit]); stream.close(); await owner.close(); }
});

test("an uncertain turn mutation blocks drain without replay", async () => {
  const rpc = new Rpc(); rpc.failTurnStart = new AppServerUncertainError();
  const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  try {
    await assert.rejects(owner.submitWithReceipt({ operationId: "unknown-turn", task: taskRef, text: "fixture" }));
    const starts = rpc.calls.filter(method => method === "turn/start").length;
    let releaseCalls = 0;
    const status = await drainIdle(owner, () => { releaseCalls++; stream.close(); });
    assert.ok(isBlocked(status));
    assert.equal(releaseCalls, 0);
    assert.equal(rpc.calls.filter(method => method === "turn/start").length, starts,
      "unknown native mutation outcomes cannot be retried by the drain");
  } finally { stream.close(); await owner.close(); }
});

test("a callback failure after closing the stream leaves admission fenced", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const turnStarts = rpc.calls.filter(method => method === "turn/start").length;
  try {
    assert.equal(await drainIdle(owner, () => { stream.close(); throw new Error("binding release failed"); }), "unavailable");
    await assert.rejects(owner.submitWithReceipt({ operationId: "must-not-write", task: taskRef, text: "fixture" }), ActionRejectedError);
    assert.equal(rpc.calls.filter(method => method === "turn/start").length, turnStarts);
    assert.equal(rpc.calls.filter(method => method === "thread/resume").length, 1);
  } finally { stream.close(); await owner.close(); }
});

test("an exact same-generation close resolves an unavailable unsubscribe without retry", async () => {
  const rpc = new Rpc(); rpc.failUnsubscribe = true;
  const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  const resumes = rpc.calls.filter(method => method === "thread/resume").length;
  try {
    assert.equal(await drainIdle(owner, () => stream.close()), "unavailable");
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 1);
    rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId } });
    assert.equal(await drainIdle(owner, () => assert.fail("the committed close cannot be repeated")), "released");
    await assert.rejects(owner.submitWithReceipt({ operationId: "closed-owner", task: taskRef, text: "fixture" }), TaskOwnedByClientError);
    assert.equal(rpc.calls.filter(method => method === "thread/resume").length, resumes);
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 1);
  } finally { stream.close(); await owner.close(); }
});

test("a malformed post-dispatch rejection stays unknown, while a validated native rejection is drainable", async t => {
  await t.test("malformed error envelope", async () => {
    const rpc = new Rpc(); rpc.failTurnStart = new AppServerRejectedError(); rpc.turnStartEnvelope = { error: {} };
    const owner = new AppServerProfileOwner("work", rpc);
    const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
    try {
      await assert.rejects(owner.submitWithReceipt({ operationId: "malformed-error", task: taskRef, text: "fixture" }), ActionRejectedError);
      let releaseCalls = 0;
      assert.ok(isBlocked(await drainIdle(owner, () => { releaseCalls++; stream.close(); })));
      assert.equal(releaseCalls, 0, "a malformed response after wire dispatch is not proof of refusal");
      assert.equal(rpc.calls.filter(method => method === "turn/start").length, 1);
    } finally { stream.close(); await owner.close(); }
  });
  await t.test("validated native error", async () => {
    const rpc = new Rpc(); rpc.failTurnStart = new AppServerRejectedError(-32000);
    rpc.turnStartEnvelope = { error: { code: -32000, message: "denied" } };
    const owner = new AppServerProfileOwner("work", rpc);
    const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
    try {
      await assert.rejects(owner.submitWithReceipt({ operationId: "validated-error", task: taskRef, text: "fixture" }), ActionRejectedError);
      let releaseCalls = 0;
      const beforeRelease = () => { releaseCalls++; stream.close(); };
      assert.equal(await drainIdle(owner, beforeRelease), "waiting-unload");
      assert.equal(releaseCalls, 1, "a structurally validated native refusal is definitive");
      rpc.notify({ method: "thread/closed", params: { threadId: taskRef.threadId } });
      assert.equal(await drainIdle(owner, beforeRelease), "released");
    } finally { stream.close(); await owner.close(); }
  });
});

test("a command paused in beforeSend keeps the owner drain blocked", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let entered!: () => void; const beforeSendEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const beforeSendGate = new Promise<void>(resolve => { release = resolve; });
  const submit = owner.submitWithReceipt({ operationId: "preparing", task: taskRef, text: "fixture",
    beforeSend: async () => { entered(); await beforeSendGate; } });
  await beforeSendEntered;
  try {
    let releaseCalls = 0;
    assert.equal(await drainIdle(owner, () => { releaseCalls++; stream.close(); }), "blocked");
    assert.equal(releaseCalls, 0);
    assert.equal(rpc.calls.includes("thread/unsubscribe"), false);
  } finally { release(); await Promise.allSettled([submit]); stream.close(); await owner.close(); }
});

test("a new state consumer is refused during proof before the existing owner releases", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
  let entered!: () => void; const readEntered = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const readGate = new Promise<void>(resolve => { resume = resolve; });
  rpc.pauseMethod = "thread/list"; rpc.pauseGate = readGate; rpc.onPausedRequest = entered;
  let releaseCalls = 0;
  const drain = drainIdle(owner, () => { releaseCalls++; stream.close(); });
  try {
    await readEntered;
    assert.throws(() => owner.states.subscribe(taskRef, () => {}, () => {}), ActionRejectedError,
      "new consumers are refused while the native writer proof is in flight");
    resume();
    assert.equal(await drain, "waiting-unload");
    assert.equal(releaseCalls, 1);
    assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 1);
  } finally { resume(); stream.close(); await owner.close(); }
});

test("a notification or generation change before unsubscribe assertBeforeWrite refuses the close", async t => {
  for (const change of ["notification", "generation"] as const) await t.test(change, async () => {
    const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
    const stream = owner.states.subscribe(taskRef, () => {}, () => {}); await stream.start();
    let injected = false;
    rpc.beforeGuard = method => {
      if (!injected && method === "thread/unsubscribe") {
        injected = true;
        if (change === "generation") rpc.generation++;
        else rpc.notify({ method: "thread/closed", params: { threadId: "unrelated" } });
      }
    };
    try {
      assert.equal(await drainIdle(owner, () => stream.close()), "unavailable");
      assert.equal(injected, true);
      assert.equal(rpc.calls.filter(method => method === "thread/unsubscribe").length, 0,
        "the final generation/revision guard must reject before the unsubscribe reaches the wire");
      await assert.rejects(owner.submitWithReceipt({ operationId: `fenced-${change}`, task: taskRef, text: "fixture" }), ActionRejectedError);
    } finally { stream.close(); await owner.close(); }
  });
});

test("profile owner rejects another source before touching its App Server", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const foreign = { hostId: "local", threadId: "task", sourceId: "other" };
  assert.throws(() => owner.submitWithReceipt({ operationId: "op", task: foreign, text: "prompt" }), ActionRejectedError);
  assert.throws(() => owner.states.subscribe(foreign, () => {}, () => {}), ActionRejectedError);
  assert.deepEqual(rpc.calls, []); await owner.close();
});

test("inspecting a cold task never resumes it or changes native subscriptions", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  try {
    rpc.threadStatus = "notLoaded";
    const details = await owner.inspectTask(task);
    assert.equal(details.status, "unavailable");
    assert.deepEqual(rpc.calls, ["thread/read"]);
  } finally { await owner.close(); }
});

test("inspection during a slow stream start cannot unsubscribe the live observer", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  let release!: () => void;
  rpc.waitResume = new Promise<void>(resolve => { release = resolve; });
  const stream = owner.states.subscribe(task, () => {}, () => {});
  try {
    const starting = stream.start();
    await new Promise(resolve => setImmediate(resolve));
    const inspecting = owner.inspectTask(task);
    release();
    await Promise.all([starting, inspecting]);
    assert.equal(rpc.calls.filter(method => method === "thread/resume").length, 1);
    assert.equal(rpc.calls.includes("thread/unsubscribe"), false);
  } finally { release(); stream.close(); await owner.close(); }
});

test("profile owner shares one connection for commands and task state", async () => {
  const rpc = new Rpc(); const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "task", sourceId: "work" };
  let initial = false; const stream = owner.states.subscribe(task, (_state, value) => { initial = value; }, () => {});
  await stream.start();
  const receipt = await owner.submitWithReceipt({ operationId: "op", task, text: "prompt" });
  assert.equal(initial, true); assert.deepEqual(receipt, { mode: "start", turnId: "turn" });
  assert.deepEqual(rpc.calls, ["thread/resume", "thread/read", "turn/start"]);
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
