import assert from "node:assert/strict";
import test from "node:test";
import { RoutedCodexTasks, type CodexTaskOwner } from "../src/core/codex-task-router.js";
import { ActionRejectedError, TaskOwnedByClientError, type CodexTasks, type TaskRef } from "../src/core/codex-tasks.js";
import { RoutedTaskStateTransport, type TaskStateStream, type TaskStateTransport } from "../src/core/task-state.js";

const primary = { hostId: "local", threadId: "primary" };
const work = { hostId: "local", threadId: "work", sourceId: "work" };

function fixture() {
  const calls: string[] = [];
  const base = {
    capabilities: { createTask: true, startTurn: true, steerTurn: true, interruptTurn: true, selectModel: true },
    listTasks: async () => [], listProjects: async () => [], createTask: async () => { throw new Error("unused"); },
    submit: async () => { calls.push("base:submit"); },
    submitWithReceipt: async () => { calls.push("base:submitWithReceipt"); return { mode: "start" as const, turnId: "base-turn" }; },
    submitConnectedWithReceipt: async () => { calls.push("base:connectedSubmit"); return { mode: "steer" as const, turnId: "client-turn" }; },
    interrupt: async () => { calls.push("base:interrupt"); }, moveTask: async () => { calls.push("base:move"); },
    inspectTask: async () => ({ status: "idle" as const, workspace: null, model: null, effort: null, nextModel: null, nextEffort: null, context: null }),
    listModels: async () => [], selectModel: async () => { calls.push("base:model"); },
    renameTask: async () => ({ liveTitleUpdated: false }), archiveTask: async () => {}, archiveTransferredSource: async () => {}, exportMarkdown: async () => "",
    healthGoal: async () => null,
    ensureOpen: async () => { calls.push("base:open"); },
  } satisfies CodexTasks;
  const owner: CodexTaskOwner = {
    owns: task => (task.sourceId ?? "") === "work",
    submitWithReceipt: async () => { calls.push("owner:submit"); return { mode: "start", turnId: "owner-turn" }; },
    interrupt: async () => { calls.push("owner:interrupt"); }, queue: async () => "queued",
    selectModel: async () => { calls.push("owner:model"); }, renameTask: async () => { calls.push("owner:rename"); return { liveTitleUpdated: true }; },
    moveTask: async () => { calls.push("owner:move"); },
    getGoal: async () => null, setGoal: async (_task, update) => ({ threadId: "work", objective: update.objective ?? "goal", status: update.status ?? "paused",
      tokenBudget: update.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }),
    clearGoal: async () => { calls.push("owner:clear-goal"); return true; },
    pendingQuestions: async () => [], answerQuestions: async () => {},
    findAcceptedInput: async () => "accepted", inspectTask: async () => ({ status: "idle", workspace: null, model: null, effort: null, nextModel: null, nextEffort: null, context: null }),
    archiveTask: async () => { calls.push("owner:archive"); }, archiveRetryReady: async () => true,
  };
  return { calls, base, owner, routed: new RoutedCodexTasks(base, [owner]) };
}

test("command router uses exactly the configured source owner", async () => {
  const f = fixture();
  assert.equal((await f.routed.submitWithReceipt!({ operationId: "one", task: work, text: "x" })).turnId, "owner-turn");
  assert.equal((await f.routed.submitWithReceipt!({ operationId: "two", task: primary, text: "x" })).turnId, "base-turn");
  await f.routed.interrupt(work); await f.routed.interrupt(primary);
  await f.routed.selectModel(work, "model", "high"); await f.routed.selectModel(primary, "model", "high");
  assert.deepEqual(f.calls, ["owner:submit", "base:submitWithReceipt", "owner:interrupt", "base:interrupt", "owner:model", "base:model"]);
});

test("metadata and goals use the selected profile owner", async () => {
  const f = fixture();
  assert.deepEqual(await f.routed.renameTask(work, "Renamed"), { liveTitleUpdated: true });
  await f.routed.moveTask(work, "project");
  assert.equal(await f.routed.getGoal!(work), null);
  assert.equal((await f.routed.setGoal!(work, { objective: "Goal", status: "paused" })).objective, "Goal");
  assert.equal(await f.routed.clearGoal!(work), true);
  await f.routed.continueGoal!(work);
  assert.deepEqual(f.calls, ["owner:rename", "owner:move", "owner:clear-goal"]);
});

test("health goal reads are isolated from the long-lived task owner", async () => {
  const f = fixture(); let ownerReads = 0; let healthReads = 0;
  f.owner.getGoal = async () => { ownerReads++; return null; };
  f.base.healthGoal = async () => { healthReads++; return null; };
  assert.equal(await f.routed.getGoal!(work), null);
  assert.equal(await f.routed.healthGoal!(work), null);
  assert.deepEqual({ ownerReads, healthReads }, { ownerReads: 1, healthReads: 1 });
});

test("owner route never opens a UI client and rejects unsupported edit instead of falling back", async () => {
  const f = fixture(); await f.routed.ensureOpen!(work); assert.deepEqual(f.calls, []);
  await assert.rejects(f.routed.editLastUserTurn!({ operationId: "edit", task: work, text: "x", expectedTurnId: "t", expectedOperationId: "o" }), ActionRejectedError);
  assert.deepEqual(f.calls, []);
  await f.routed.ensureOpen!(primary); assert.deepEqual(f.calls, ["base:open"]);
});

test("ensure open accepts an active writer as proof that the task is already open", async () => {
  const f = fixture();
  f.owner.inspectTask = async () => { throw new TaskOwnedByClientError(); };
  await f.routed.ensureOpen!(work);
  assert.deepEqual(f.calls, []);
});

test("an active UI writer receives a connected-only fallback before any native mutation", async () => {
  const f = fixture();
  f.owner.submitWithReceipt = async () => { f.calls.push("owner:busy"); throw new TaskOwnedByClientError(); };
  const result = await f.routed.submitWithReceipt!({ operationId: "one", task: work, text: "x" });
  assert.equal(result.turnId, "client-turn");
  assert.deepEqual(f.calls, ["owner:busy", "base:connectedSubmit"]);
});

test("archive and transfer cleanup use the selected owner and fall back only for an active UI writer", async () => {
  const f = fixture();
  let baseArchives = 0; let transferArchives = 0;
  f.base.archiveTask = async () => { baseArchives++; };
  f.base.archiveTransferredSource = async () => { transferArchives++; };
  await f.routed.archiveTask(work);
  await f.routed.archiveTransferredSource!(work);
  assert.deepEqual(f.calls, ["owner:archive", "owner:archive"]);
  assert.equal(await f.routed.archiveRetryReady!(work), true);
  f.owner.archiveTask = async () => { throw new TaskOwnedByClientError(); };
  await f.routed.archiveTask(work);
  await f.routed.archiveTransferredSource!(work);
  assert.equal(baseArchives, 1); assert.equal(transferArchives, 1);
});

test("state router sends each task only to its selected owner", () => {
  const used: string[] = [];
  const transport = (label: string): TaskStateTransport => ({
    subscribe: (task: TaskRef): TaskStateStream => { used.push(`${label}:${task.threadId}`); return { task, start: async () => {}, verifyOwner: async () => {}, close: () => {} }; },
    close: () => { used.push(`${label}:close`); },
  });
  const fallback = transport("client"); const native = transport("native");
  const owner = { owns: (task: TaskRef) => task.sourceId === "work", states: native };
  const routed = new RoutedTaskStateTransport(fallback, [owner]);
  routed.subscribe(primary, () => {}, () => {}); routed.subscribe(work, () => {}, () => {}); routed.close();
  assert.deepEqual(used, ["client:primary", "native:work", "client:close", "native:close"]);
});

test("state router falls back to an already connected UI owner only for an active writer", async () => {
  const used: string[] = [];
  const native: TaskStateTransport = {
    subscribe: task => ({ task, start: async () => { used.push("native:start"); throw new TaskOwnedByClientError(); }, verifyOwner: async () => {}, close: () => used.push("native:close") }),
    close: () => {},
  };
  const client: TaskStateTransport = {
    subscribe: task => ({ task, start: async () => { used.push("client:start"); }, verifyOwner: async () => {}, close: () => used.push("client:close") }),
    close: () => {},
  };
  const routed = new RoutedTaskStateTransport(client, [{ owns: task => task.sourceId === "work", states: native }]);
  const stream = routed.subscribe(work, () => {}, () => {}); await stream.start(); stream.close();
  assert.deepEqual(used, ["native:start", "native:close", "client:start", "client:close"]);
});

test("state router follows a discovered UI owner before resuming the profile writer", async () => {
  const used: string[] = [];
  const native: TaskStateTransport = {
    subscribe: task => ({ task, start: async () => { used.push("native:start"); }, verifyOwner: async () => {}, close: () => used.push("native:close") }),
    close: () => {},
  };
  const client: TaskStateTransport = {
    subscribe: task => ({ task, start: async () => { used.push("client:start"); }, verifyOwner: async () => {}, close: () => used.push("client:close") }),
    close: () => {},
  };
  const routed = new RoutedTaskStateTransport(client, [{ owns: task => task.sourceId === "work", states: native }],
    async task => { used.push(`discover:${task.threadId}`); return true; });
  const stream = routed.subscribe(work, () => {}, () => {}); await stream.start(); stream.close();
  assert.deepEqual(used, [`discover:${work.threadId}`, "native:close", "client:start", "client:close"]);
});
