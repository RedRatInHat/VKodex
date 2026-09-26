import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerEnvelope, AppServerRequestOptions, AppServerRpc, AppServerServerRequestHandler } from "../src/codex/app-server-connection.js";
import { AppServerTaskStateTransport, observeAppServerTaskState } from "../src/codex/app-server-task-state.js";
import type { TaskState } from "../src/core/task-state.js";

type JsonObject = Record<string, unknown>;

class FakeRpc implements AppServerRpc {
  readonly calls: { method: string; params: JsonObject }[] = [];
  readonly responses = new Map<string, JsonObject[]>();
  private readonly notifications = new Set<(notification: AppServerEnvelope) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  onRequest: ((method: string) => void) | null = null;
  async start(): Promise<void> {}
  async request(method: string, params: JsonObject = {}, _options?: AppServerRequestOptions): Promise<JsonObject> {
    this.calls.push({ method, params }); this.onRequest?.(method);
    const values = this.responses.get(method) ?? [];
    const value = values.shift(); if (!value) throw new Error(`No response for ${method}`);
    return value;
  }
  onNotification(listener: (notification: AppServerEnvelope) => void): () => void {
    this.notifications.add(listener); return () => { this.notifications.delete(listener); };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener); return () => { this.disconnects.delete(listener); };
  }
  onServerRequest(_handler: AppServerServerRequestHandler | null): void {}
  async close(): Promise<void> {}
  notify(method: string, params: JsonObject): void { for (const listener of this.notifications) listener({ method, params }); }
  disconnect(): void { for (const listener of this.disconnects) listener(new Error("lost")); }
}

const item = (id: string, text: string, phase: string | null = "final_answer") => ({ type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null });
const turn = (id: string, status: string, items: JsonObject[], startedAt = 1) => ({ id, status, items, startedAt, error: null });
const resume = (turns: JsonObject[], nextCursor: string | null = null) => ({
  thread: { id: "task", name: "Task", cwd: "D:\\work", status: { type: "idle" } }, model: "gpt-test", reasoningEffort: "high", cwd: "D:\\work",
  initialTurnsPage: { data: turns, nextCursor },
});

test("native ownership verification rejects unloaded or unrecognized runtime state", async () => {
  const rpc = new FakeRpc();
  rpc.responses.set("thread/resume", [resume([])]);
  rpc.responses.set("thread/read", [
    { thread: { id: "task", status: { type: "notLoaded" } } },
    { thread: { id: "task" } },
    { thread: { id: "task", status: { type: "futureUnknownStatus" } } },
  ]);
  const transport = new AppServerTaskStateTransport(rpc);
  const stream = transport.subscribe({ hostId: "h", threadId: "task" }, () => {}, () => {});
  try {
    await stream.start();
    for (let i = 0; i < 3; i++) await assert.rejects(stream.verifyOwner());
  } finally { transport.close(); }
});

test("ownership verification cannot revive an unstarted or closed subscription", async () => {
  const rpc = new FakeRpc();
  rpc.responses.set("thread/resume", [resume([])]);
  const transport = new AppServerTaskStateTransport(rpc);
  const stream = transport.subscribe({ hostId: "h", threadId: "task" }, () => {}, () => {});
  try {
    await assert.rejects(stream.verifyOwner());
    await stream.start();
    stream.close();
    await assert.rejects(stream.verifyOwner());
    assert.equal(rpc.calls.some(call => call.method === "thread/read"), false);
  } finally { transport.close(); }
});

test("native state stream bounds history, drops tool output, buffers races and filters other tasks", async () => {
  const rpc = new FakeRpc();
  rpc.responses.set("thread/resume", [resume([turn("two", "completed", [
    { type: "commandExecution", id: "large-tool-output", aggregatedOutput: "discard me" }, item("old", "old"),
  ], 2)], "older")]);
  const states: { state: TaskState; initial: boolean }[] = []; const errors: Error[] = [];
  const transport = new AppServerTaskStateTransport(rpc);
  const stream = transport.subscribe({ hostId: "h", threadId: "task" }, (state, initial) => states.push({ state, initial }), error => errors.push(error));
  rpc.onRequest = method => {
    if (method === "thread/resume") {
      rpc.notify("turn/started", { threadId: "other", turn: turn("ignored", "inProgress", [], 3) });
      rpc.notify("turn/started", { threadId: "task", turn: turn("three", "inProgress", [item("live", "a", "commentary")], 3) });
    }
  };
  await stream.start();
  assert.equal(states.length, 1); assert.equal(states[0]?.initial, true);
  assert.deepEqual((states[0]?.state.turns as JsonObject[]).map(value => value.id), ["two", "three"]);
  assert.deepEqual(rpc.calls.map(call => call.method), ["thread/resume"]);
  assert.equal(((rpc.calls[0]?.params.initialTurnsPage as JsonObject).limit), 20);
  assert.deepEqual(((states[0]?.state.turns as JsonObject[])[0]?.items as JsonObject[]).map(value => value.id), ["old"]);
  rpc.notify("item/agentMessage/delta", { threadId: "task", turnId: "three", itemId: "live", delta: "b" });
  assert.equal(states.length, 2);
  const latestTurns = states.at(-1)?.state.turns as JsonObject[];
  const latestItems = latestTurns.at(-1)?.items as JsonObject[];
  assert.equal(latestItems[0]?.text, "ab");
  rpc.responses.set("thread/read", [{ thread: { id: "task", status: { type: "idle" } } }]); await stream.verifyOwner();
  rpc.disconnect(); assert.equal(errors.length, 1);
  transport.close();
});

test("native state stream starts at most two profile reads concurrently", async () => {
  const rpc = new FakeRpc(); let active = 0; let maximum = 0;
  const releases: Array<() => void> = [];
  rpc.request = async (method: string, params: JsonObject = {}): Promise<JsonObject> => {
    rpc.calls.push({ method, params });
    if (method === "thread/unsubscribe") return {};
    assert.equal(method, "thread/resume"); active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--;
    const id = String(params.threadId);
    return { thread: { id, name: id, status: { type: "idle" } }, initialTurnsPage: { data: [], nextCursor: null } };
  };
  const transport = new AppServerTaskStateTransport(rpc);
  const starts = ["one", "two", "three"].map(threadId => transport
    .subscribe({ hostId: "h", threadId }, () => {}, () => {}).start());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2); assert.equal(releases.length, 2);
  releases.shift()!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2); assert.equal(releases.length, 2);
  while (releases.length) { releases.shift()!(); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all(starts); transport.close();
});

test("native state stream releases only its task lease when closed", async () => {
  const rpc = new FakeRpc();
  rpc.responses.set("thread/resume", [resume([])]);
  rpc.responses.set("thread/unsubscribe", [{}]);
  const transport = new AppServerTaskStateTransport(rpc);
  const stream = transport.subscribe({ hostId: "h", threadId: "task" }, () => {}, () => {});
  await stream.start();
  transport.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rpc.calls.map(call => call.method), ["thread/resume", "thread/unsubscribe"]);
  assert.deepEqual(rpc.calls[1]?.params, { threadId: "task" });
});

test("native state stream keeps a live turn eligible when notifications omit timestamps", async () => {
  const rpc = new FakeRpc(); rpc.responses.set("thread/resume", [resume([])]);
  const states: TaskState[] = [];
  const stream = new AppServerTaskStateTransport(rpc).subscribe({ hostId: "h", threadId: "task" }, state => states.push(state), () => {});
  await stream.start();
  rpc.notify("turn/started", { threadId: "task", turn: { id: "live", status: "inProgress", startedAt: null, error: null, items: [] } });
  rpc.notify("item/completed", { threadId: "task", turnId: "live", item: item("answer", "done") });
  rpc.notify("turn/completed", { threadId: "task", turn: { id: "live", status: "completed", startedAt: null, error: null, items: [] } });
  const latest = (states.at(-1)?.turns as JsonObject[]).at(-1)!;
  assert.equal(latest.status, "completed"); assert.ok(Number(latest.startedAt) > 0);
  assert.equal((latest.items as JsonObject[])[0]?.text, "done");
});

test("native state stream publishes structured question changes immediately", async () => {
  const rpc = new FakeRpc(); rpc.responses.set("thread/resume", [resume([])]);
  let questions: readonly any[] = [];
  const states: TaskState[] = []; const transport = new AppServerTaskStateTransport(rpc, () => questions);
  const stream = transport.subscribe({ hostId: "h", threadId: "task" }, state => states.push(state), () => {});
  await stream.start();
  questions = [{ fingerprint: "f", kind: "blocking", key: "q", turnId: "turn", questions: [] }];
  transport.refresh("task");
  assert.equal((states.at(-1)?.questions as unknown[]).length, 1);
});

test("native observer baselines old history and emits live progress and final once", () => {
  const base: TaskState = { kind: "app-server", threadId: "task", title: "Task", cwd: "D:\\work", model: "gpt-test", effort: "high",
    runtimeStatus: "active", context: null, turns: [{ id: "turn", status: "inProgress", startedAt: 1_000,
      items: [{ type: "userMessage", id: "user", clientId: "operation", content: [{ type: "text", text: "prompt" }] }, item("agent", "thinking", "commentary")], error: null }] };
  const first = observeAppServerTaskState(base, null, 2_000);
  assert.deepEqual(first.events.map(event => event.type), ["status"]);
  assert.equal(first.details.status, "running"); assert.equal(first.inputs[0]?.operationIds[0], "operation");
  const progressed = structuredClone(base);
  ((progressed.turns as JsonObject[])[0]!.items as JsonObject[])[1]!.text = "thinking more";
  const second = observeAppServerTaskState(progressed, first.checkpoint, 3_000);
  assert.deepEqual(second.events.map(event => event.type), ["progress"]);
  const completed = structuredClone(progressed);
  completed.runtimeStatus = "idle"; (completed.turns as JsonObject[])[0]!.status = "completed";
  ((completed.turns as JsonObject[])[0]!.items as JsonObject[])[1] = item("agent", "done", "final_answer");
  const third = observeAppServerTaskState(completed, second.checkpoint, 4_000);
  assert.deepEqual(third.events.map(event => event.type), ["final", "status"]);
  const repeated = observeAppServerTaskState(completed, third.checkpoint, 5_000);
  assert.deepEqual(repeated.events, []);
});

test("native observer hides scheduler input and quiet heartbeat output", () => {
  const prompt = `<heartbeat><automation_id>monitor</automation_id><current_time_iso>2026-09-19T17:00:00Z</current_time_iso><instructions>Check.</instructions></heartbeat>`;
  const empty: TaskState = { kind: "app-server", threadId: "task", title: null, cwd: null, model: null, effort: null,
    runtimeStatus: "idle", context: null, turns: [] };
  const first = observeAppServerTaskState(empty, null, 10_000);
  const running = structuredClone(empty); running.runtimeStatus = "active";
  running.turns = [turn("heartbeat", "inProgress", [
    { type: "userMessage", id: "scheduler", content: [{ type: "text", text: prompt }] },
    item("progress", "Internal automation progress", "commentary"),
  ], 11_000)];
  const live = observeAppServerTaskState(running, first.checkpoint, 12_000);
  assert.deepEqual(live.events.map(event => event.type), ["status"]);

  const completed = structuredClone(running); completed.runtimeStatus = "idle";
  (completed.turns as JsonObject[])[0] = turn("heartbeat", "completed", [
    { type: "userMessage", id: "scheduler", content: [{ type: "text", text: prompt }] },
    item("final", "<heartbeat><automation_id>monitor</automation_id><decision>DONT_NOTIFY</decision><message>Quiet.</message></heartbeat>"),
  ], 11_000);
  const done = observeAppServerTaskState(completed, live.checkpoint, 13_000);
  assert.deepEqual(done.events, [{ type: "status", id: "status:heartbeat", turnId: "heartbeat", status: "completed" }]);
});

test("native observer unwraps a notifying heartbeat", () => {
  const prompt = `<heartbeat><automation_id>monitor</automation_id><current_time_iso>2026-09-19T17:00:00Z</current_time_iso><instructions>Check.</instructions></heartbeat>`;
  const empty: TaskState = { kind: "app-server", threadId: "task", title: null, cwd: null, model: null, effort: null,
    runtimeStatus: "idle", context: null, turns: [] };
  const first = observeAppServerTaskState(empty, null, 10_000);
  const completed = structuredClone(empty);
  completed.turns = [turn("heartbeat", "completed", [
    { type: "userMessage", id: "scheduler", content: [{ type: "text", text: prompt }] },
    item("final", "<heartbeat><automation_id>monitor</automation_id><decision>NOTIFY</decision><message>Needs attention.</message></heartbeat>"),
  ], 11_000)];
  const done = observeAppServerTaskState(completed, first.checkpoint, 12_000);
  assert.deepEqual(done.events.filter(event => event.type === "final"), [
    { type: "final", id: "final", turnId: "heartbeat", text: "Needs attention.", showMenu: false },
  ]);
});

test("a streamed final-answer item remains progress until the turn completes", () => {
  const empty: TaskState = { kind: "app-server", threadId: "task", title: null, cwd: null, model: null, effort: null,
    runtimeStatus: "idle", context: null, turns: [] };
  const first = observeAppServerTaskState(empty, null, 10_000);
  const streaming = structuredClone(empty); streaming.runtimeStatus = "active";
  streaming.turns = [turn("turn", "inProgress", [item("answer", "partial", "final_answer")], 11_000)];
  const live = observeAppServerTaskState(streaming, first.checkpoint, 11_500);
  assert.deepEqual(live.events.map(event => event.type), ["progress", "status"]);
  const done = structuredClone(streaming); done.runtimeStatus = "idle"; (done.turns as JsonObject[])[0]!.status = "completed";
  const completed = observeAppServerTaskState(done, live.checkpoint, 12_000);
  assert.deepEqual(completed.events.map(event => event.type), ["final", "status"]);
});

test("native observer accepts a turn started later in the attachment second", () => {
  const empty: TaskState = { kind: "app-server", threadId: "task", title: null, cwd: null, model: null, effort: null,
    runtimeStatus: "idle", context: null, turns: [] };
  const first = observeAppServerTaskState(empty, null, 10_999);
  const live = structuredClone(empty); live.runtimeStatus = "active";
  live.turns = [turn("same-second", "inProgress", [], 10_000)];
  const next = observeAppServerTaskState(live, first.checkpoint, 11_001);
  assert.deepEqual(next.events.map(event => event.type), ["status"]);
});

test("native observer recovers an accepted final after reconnect without replaying commentary", () => {
  const running: TaskState = { kind: "app-server", threadId: "task", title: null, cwd: null, model: null, effort: null,
    runtimeStatus: "active", context: null, turns: [turn("turn", "inProgress", [item("progress", "old", "commentary")], 10)] };
  const first = observeAppServerTaskState(running, null, 10_000);
  const completed = structuredClone(running); completed.runtimeStatus = "idle";
  (completed.turns as JsonObject[])[0] = turn("turn", "completed", [item("progress", "old", "commentary"), item("final", "done")], 10);
  const recovered = observeAppServerTaskState(completed, first.checkpoint, 20_000,
    { rebaseline: true, recoverFinalTurnIds: ["turn"], finalRecorded: () => false });
  assert.deepEqual(recovered.events.filter(event => event.type !== "status").map(event => event.type), ["final"]);
});

test("native observer recovers the terminal status of an accepted interrupted turn", () => {
  const interrupted: TaskState = { kind: "app-server", threadId: "task", title: null, cwd: null, model: null, effort: null,
    runtimeStatus: "idle", context: null, turns: [turn("turn", "interrupted", [
      { type: "userMessage", id: "user", clientId: "operation", content: [{ type: "text", text: "prompt" }] },
    ], 10)] };
  const first = observeAppServerTaskState(interrupted, null, 10_000);
  const baseline = observeAppServerTaskState(interrupted, first.checkpoint, 20_000, { rebaseline: true });
  assert.equal(baseline.events.length, 0);
  const recovered = observeAppServerTaskState(interrupted, baseline.checkpoint, 30_000,
    { rebaseline: true, recoverFinalTurnIds: ["turn"], finalRecorded: () => false });
  assert.deepEqual(recovered.events, [
    { type: "status", id: "status:turn", turnId: "turn", status: "interrupted" },
  ]);
});
