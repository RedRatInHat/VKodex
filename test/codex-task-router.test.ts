import assert from "node:assert/strict";
import test from "node:test";
import { withDiagnosticSink, type DiagnosticRecord } from "../src/bridge/diagnostics.js";
import { RoutedCodexTasks, type CodexTaskOwner } from "../src/core/codex-task-router.js";
import { ActionRejectedError, DesktopUnavailableError, TaskOwnedByClientError, UncertainActionError, type CodexTasks, type EditLastUserTurnRequest, type TaskRef } from "../src/core/codex-tasks.js";
import { RoutedTaskStateTransport, TaskStateConnections, type TaskStateStream, type TaskStateTransport } from "../src/core/task-state.js";

const primary = { hostId: "local", threadId: "primary" };
const work = { hostId: "local", threadId: "work", sourceId: "work" };

test("legacy routed transfer project preserves explicit null without a native hook", async () => {
  const s = fixture();
  const base: CodexTasks = { ...s.base, listTasks: async () => [{ ...primary,
    title: "Legacy", workspace: "/workspace", updatedAt: 1, projectId: null }] };
  assert.equal(await new RoutedCodexTasks(base, []).transferProjectId(primary), null);
});

test("routed transfer project never falls back after an unavailable native read", async () => {
  const s = fixture();
  const base: CodexTasks = { ...s.base, listTasks: async () => [{ ...primary,
    title: "Legacy", workspace: "/workspace", updatedAt: 1, projectId: null }],
    transferProjectId: async () => { throw new DesktopUnavailableError("native read unavailable"); } };
  await assert.rejects(new RoutedCodexTasks(base, []).transferProjectId(primary), DesktopUnavailableError);
});

function fixture() {
  const calls: string[] = [];
  const base = {
    capabilities: { createTask: true, startTurn: true, steerTurn: true, interruptTurn: true, selectModel: true },
    listTasks: async () => [], listProjects: async () => [], createTask: async () => { throw new Error("unused"); },
    createProject: async () => ({ id: "unused", title: "Unused", workspace: "/unused" }),
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
    ensureOpen: async () => { calls.push("owner:open"); },
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

test("diagnostic routing records selected and connected fallback without additional dispatch", async () => {
  const f = fixture(); const records: DiagnosticRecord[] = [];
  f.owner.submitWithReceipt = async () => { throw new TaskOwnedByClientError(); };
  await withDiagnosticSink(record => { records.push(record); }, () =>
    f.routed.submitWithReceipt({ task: work, operationId: "route-fixture", text: "private prompt" }));
  assert.deepEqual(f.calls, ["base:connectedSubmit"]);
  assert.equal(records.find(record => record.event === "route.selected")?.route, "profile-owner");
  assert.equal(records.find(record => record.event === "route.fallback")?.reason, "owner-conflict");
  assert.equal(JSON.stringify(records).includes("private prompt"), false);
});

test("diagnostic exclusive owner refusal never records or executes a fallback", async () => {
  const f = fixture(); const records: DiagnosticRecord[] = [];
  const owner = { ...f.owner, routingPolicy: "exclusive" as const,
    submitWithReceipt: async () => { throw new TaskOwnedByClientError(); } };
  await withDiagnosticSink(record => { records.push(record); }, () => assert.rejects(
    new RoutedCodexTasks(f.base, [owner]).submitWithReceipt({ task: work, operationId: "exclusive-fixture", text: "x" }),
    TaskOwnedByClientError));
  assert.deepEqual(f.calls, []);
  assert.equal(records.find(record => record.event === "route.selected")?.route, "exclusive-owner");
  assert.equal(records.some(record => record.event === "route.fallback"), false);
});

test("command router uses exactly the configured source owner", async () => {
  const f = fixture();
  assert.deepEqual(await f.routed.submitWithReceipt!({ operationId: "one", task: work, text: "x" }), { mode: "start", turnId: "owner-turn" });
  assert.deepEqual(await f.routed.submitWithReceipt!({ operationId: "two", task: primary, text: "x" }), { mode: "start", turnId: "base-turn" });
  await f.routed.interrupt(work); await f.routed.interrupt(primary);
  await f.routed.selectModel(work, "model", "high"); await f.routed.selectModel(primary, "model", "high");
  assert.deepEqual(f.calls, ["owner:submit", "base:submitWithReceipt", "owner:interrupt", "base:interrupt", "owner:model", "base:model"]);
});

test("configured legacy owner is not a ready adapter without its actual session probe", async () => {
  const f = fixture();
  let baseProbes = 0, ownerProbes = 0;
  (f.base as CodexTasks).ownerAdapterStatus = async () => { baseProbes++; return "ready"; };
  assert.equal(await f.routed.ownerAdapterStatus(work), "unknown");
  assert.equal(baseProbes, 0, "a different native client cannot attest the original writer");
  f.owner.ownerAdapterStatus = async () => { ownerProbes++; return "ready"; };
  assert.equal(await f.routed.ownerAdapterStatus(work), "ready");
  assert.equal(ownerProbes, 1);
  assert.equal(baseProbes, 0);
});

test("legacy drain proof and refusal never fall back to another owner", async () => {
  const f = fixture();
  let released = 0;
  assert.equal(await f.routed.drainIdleExecution(work, () => { released++; }), "unavailable");
  assert.equal(f.routed.executionDrainSupported(work), false);
  f.owner.drainIdleExecution = async (_task, beforeRelease) => { beforeRelease(); return "waiting-unload"; };
  assert.equal(f.routed.executionDrainSupported(work), true);
  assert.equal(await f.routed.drainIdleExecution(work, () => { released++; }), "waiting-unload");
  assert.equal(released, 1);
  f.owner.submitWithReceipt = async () => { throw new ActionRejectedError("draining"); };
  f.base.submitConnectedWithReceipt = async () => { assert.fail("drain refusal must not escape to native"); };
  await assert.rejects(f.routed.submitWithReceipt({ task: work, text: "must not dispatch", operationId: "drain-op" }), ActionRejectedError);
  assert.deepEqual(f.calls, []);
});

test("restoring a drain fences only the exact nonexclusive owner with no base fallback", () => {
  const f = fixture(); let restored = 0;
  f.owner.restoreExecutionDrain = task => { assert.deepEqual(task, work); restored++; };
  f.routed.restoreExecutionDrain(work);
  f.routed.restoreExecutionDrain(primary);
  assert.equal(restored, 1);
  const exclusive = { ...f.owner, routingPolicy: "exclusive" as const };
  new RoutedCodexTasks(f.base, [exclusive, f.owner]).restoreExecutionDrain(work);
  assert.equal(restored, 1, "independent managed/exclusive executors are not a legacy drain target");
  assert.deepEqual(f.calls, []);
});

test("metadata and goals use the selected profile owner", async () => {
  const f = fixture();
  assert.deepEqual(await f.routed.renameTask(work, "Renamed"), { liveTitleUpdated: true });
  await f.routed.moveTask(work, "project");
  assert.equal(await f.routed.getGoal!(work), null);
  assert.equal((await f.routed.setGoal!(work, { objective: "Goal", status: "paused" })).objective, "Goal");
  assert.equal(await f.routed.clearGoal!(work), true);
  await assert.rejects(f.routed.continueGoal!(work, "resume-exclusive"), /Автоматическое продолжение цели недоступно/u);
  assert.deepEqual(f.calls, ["owner:rename", "owner:move", "owner:clear-goal"]);
});

test("project creation forwards the selected catalog parameters and result", async () => {
  const f = fixture();
  const expected = { id: "[\"work\",\"raw-project\"]", title: "Project", workspace: "/project", workspaceRoots: ["/project"] };
  let received: unknown[] | null = null;
  f.base.createProject = async (...args) => { received = args; return expected; };

  assert.equal(await f.routed.createProject!("work", "Project", ["/project"], "idempotency-key"), expected);
  assert.deepEqual(received, ["work", "Project", ["/project"], "idempotency-key"]);
});

test("goal continuation uses only an owner that can confirm it", async () => {
  const f = fixture();
  f.owner.continueGoal = async () => { f.calls.push("owner:continue-goal"); return { mode: "started", turnId: "goal-turn" }; };
  assert.deepEqual(await f.routed.continueGoal!(work, "resume-routed"), { mode: "started", turnId: "goal-turn" });
  assert.deepEqual(f.calls, ["owner:continue-goal"]);
});

test("native goal activation cannot fall back from an owner to a legacy empty turn", async () => {
  const f = fixture();
  const base = { ...f.base,
    activateGoalWithReceipt: async () => {
      f.calls.push("base:native-goal");
      return { receipt: { mode: "started" as const, turnId: "base-turn" }, goal: {
        threadId: "primary", objective: "goal", status: "active" as const, tokenBudget: null,
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      } };
    },
  };
  const routed = new RoutedCodexTasks(base, [f.owner]);
  f.owner.continueGoal = async () => { f.calls.push("owner:legacy-empty-turn"); return { mode: "started", turnId: "ordinary-turn" }; };
  await assert.rejects(routed.activateGoalWithReceipt!(work, "native-goal"), /Подтверждение нативного хода цели недоступно/u);
  assert.deepEqual(f.calls, []);
  await assert.rejects(routed.activateGoalWithReceipt!(primary, "native-goal"), /постоянный исполнитель цели/u);
  assert.deepEqual(f.calls, []);
});

test("goal runtime preparation loads only its selected owner and refuses a transient base client", async () => {
  const f = fixture();
  await f.routed.prepareGoalRuntime!(work);
  assert.deepEqual(f.calls, ["owner:open"]);
  await assert.rejects(f.routed.prepareGoalRuntime!(primary), /постоянный исполнитель цели/u);
  assert.deepEqual(f.calls, ["owner:open"]);
  f.owner.ensureOpen = async () => { throw new TaskOwnedByClientError(); };
  await assert.rejects(f.routed.prepareGoalRuntime!(work), /другом клиенте Codex/u);
  assert.deepEqual(f.calls, ["owner:open"]);
});

test("health goal reads are isolated from the long-lived task owner", async () => {
  const f = fixture(); let ownerReads = 0; let healthReads = 0;
  f.owner.getGoal = async () => { ownerReads++; return null; };
  f.base.healthGoal = async () => { healthReads++; return null; };
  assert.equal(await f.routed.getGoal!(work), null);
  assert.equal(await f.routed.healthGoal!(work), null);
  assert.deepEqual({ ownerReads, healthReads }, { ownerReads: 1, healthReads: 1 });
});

test("an archived goal falls back to its read-only profile store, never for a live task", async () => {
  const f = fixture(); let archived = false; let baseReads = 0;
  f.owner.getGoal = async () => { throw new ActionRejectedError("thread not found"); };
  const base = { ...f.base, isTaskArchived: async () => archived,
    getGoal: async () => { baseReads++; return null; } };
  const routed = new RoutedCodexTasks(base, [f.owner]);
  await assert.rejects(routed.getGoal!(work), /thread not found/u);
  assert.equal(baseReads, 0);
  archived = true;
  assert.equal(await routed.getGoal!(work), null);
  assert.equal(baseReads, 1);
});

test("owner route loads through the profile owner without opening a UI client or falling back", async () => {
  const f = fixture(); await f.routed.ensureOpen!(work); assert.deepEqual(f.calls, ["owner:open"]);
  await assert.rejects(f.routed.editLastUserTurn!({ operationId: "edit", task: work, text: "x", expectedTurnId: "t", expectedOperationId: "o" }), ActionRejectedError);
  assert.deepEqual(f.calls, ["owner:open"]);
  await f.routed.ensureOpen!(primary); assert.deepEqual(f.calls, ["owner:open", "base:open"]);
});

test("nonexclusive owner delegates a guarded last-turn edit to the already open UI client", async () => {
  const f = fixture();
  const request = { operationId: "edit", task: work, text: "corrected",
    expectedTurnId: "last-turn", expectedOperationId: "last-prompt" };
  let inspected = 0;
  f.owner.inspectTask = async () => { inspected++; return {
    status: "idle", workspace: null, model: null, effort: null,
    nextModel: null, nextEffort: null, context: null,
  }; };
  const base = { ...f.base, editLastUserTurn: async (received: EditLastUserTurnRequest) => {
    assert.deepEqual(received, request);
    f.calls.push("base:connectedEdit");
    return { turnId: "replacement", operationId: "replacement-prompt" };
  } };
  const routed = new RoutedCodexTasks(base, [f.owner]);
  assert.deepEqual(await routed.editLastUserTurn!(request),
    { turnId: "replacement", operationId: "replacement-prompt" });
  assert.deepEqual(f.calls, ["base:connectedEdit"]);
  assert.equal(inspected, 0);
});

test("a failed connected edit is not retried against the profile owner", async () => {
  const f = fixture();
  const base = { ...f.base, editLastUserTurn: async () => { f.calls.push("base:editRefused");
    throw new ActionRejectedError("No active UI owner"); } };
  const routed = new RoutedCodexTasks(base, [f.owner]);
  await assert.rejects(routed.editLastUserTurn!({ operationId: "edit", task: work,
    text: "corrected", expectedTurnId: "last-turn", expectedOperationId: "last-prompt" }),
  /No active UI owner/u);
  assert.deepEqual(f.calls, ["base:editRefused"]);
});

test("ensure open accepts an active writer as proof that the task is already open", async () => {
  const f = fixture();
  f.owner.ensureOpen = async () => { throw new TaskOwnedByClientError(); };
  await f.routed.ensureOpen!(work);
  assert.deepEqual(f.calls, []);
});

test("inspection falls back to the connected client when the profile owner is unloaded", async () => {
  const f = fixture(); let baseReads = 0;
  f.owner.inspectTask = async () => ({ status: "unavailable", workspace: null, model: null, effort: null,
    nextModel: null, nextEffort: null, context: null });
  f.base.inspectTask = async () => { baseReads++; return { status: "idle", workspace: null, model: null,
    effort: null, nextModel: null, nextEffort: null, context: null }; };
  assert.equal((await f.routed.inspectTask(work)).status, "idle");
  assert.equal(baseReads, 1);
});

test("an active UI writer receives a connected-only fallback before any native mutation", async () => {
  const f = fixture();
  f.owner.submitWithReceipt = async () => { f.calls.push("owner:busy"); throw new TaskOwnedByClientError(); };
  const result = await f.routed.submitWithReceipt!({ operationId: "one", task: work, text: "x" });
  assert.deepEqual(result, { mode: "steer", turnId: "client-turn" });
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

test("state route diagnostics identify discovered native observation without exposing task or error data", async () => {
  const calls: string[] = [];
  const transport = (label: string, kind: "native-observer" | "app-server"): TaskStateTransport => ({
    subscribe: task => ({ task, start: async () => { calls.push(`${label}:start`); }, verifyOwner: async () => {},
      diagnostic: () => ({ kind, ...(kind === "native-observer" ? { nativeOwnerClientId: "native-client" } : {}) }),
      close: () => calls.push(`${label}:close`) }), close: () => {},
  });
  const native = transport("native", "native-observer");
  const appServer = transport("app-server", "app-server");
  const routed = new RoutedTaskStateTransport(native, [{ owns: task => task.sourceId === "work", states: appServer }], async () => true);
  const stream = routed.subscribe(work, () => {}, () => {});
  await stream.start();
  assert.deepEqual(stream.diagnostic?.(), { kind: "native-observer", nativeOwnerClientId: "native-client", selection: "native-discovered" });
  assert.equal(JSON.stringify(stream.diagnostic?.()).includes(work.threadId), false);
  assert.equal(JSON.stringify(stream.diagnostic?.()).includes("exception"), false);
  assert.deepEqual(calls, ["app-server:close", "native:start"]);
  stream.close();
});

test("state route diagnostics retain owner rejection evidence when native fallback starts", async () => {
  const native: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { throw new TaskOwnedByClientError(); }, verifyOwner: async () => {},
    diagnostic: () => ({ kind: "app-server" }), close: () => {} }), close: () => {} };
  const fallback: TaskStateTransport = { subscribe: task => ({ task, start: async () => {}, verifyOwner: async () => {},
    diagnostic: () => ({ kind: "native-observer", nativeOwnerClientId: "native-client" }), close: () => {} }), close: () => {} };
  const routed = new RoutedTaskStateTransport(fallback, [{ owns: task => task.sourceId === "work", states: native }]);
  const stream = routed.subscribe(work, () => {}, () => {});
  await stream.start();
  assert.deepEqual(stream.diagnostic?.(), { kind: "native-observer", nativeOwnerClientId: "native-client",
    selection: "native-after-owner-rejection" });
  assert.equal(JSON.stringify(stream.diagnostic?.()).includes("private owner rejection detail"), false);
  stream.close();
});

test("failed state fallback is removed but leaves fixed privacy-safe route evidence", async () => {
  const native: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { throw new TaskOwnedByClientError(); }, verifyOwner: async () => {},
    diagnostic: () => ({ kind: "app-server" }), close: () => {} }), close: () => {} };
  const fallback: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { throw new Error("private fallback detail: secret/token/task path"); }, verifyOwner: async () => {},
    diagnostic: () => ({ kind: "unknown" }), close: () => {} }), close: () => {} };
  const routed = new RoutedTaskStateTransport(fallback, [{ owns: task => task.sourceId === "work", states: native }]);
  const connections = new TaskStateConnections(routed, () => 123);
  await assert.rejects(connections.connect("binding-private-id", work, () => {}, () => {}), /private fallback detail/);
  assert.equal(connections.diagnostic("binding-private-id"), null);
  const failure = connections.lastFailureDiagnostic("binding-private-id");
  assert.deepEqual(failure, { kind: "unknown", selection: "native-after-owner-rejection", failureClass: "other", routeGeneration: 1 });
  assert.equal(JSON.stringify(failure).includes("private"), false);
  assert.equal(JSON.stringify(failure).includes("secret"), false);
});

test("owner discovery failure does not start either stream and records only a fixed failure class", async () => {
  const calls: string[] = [];
  const transport = (label: string): TaskStateTransport => ({ subscribe: task => ({ task,
    start: async () => { calls.push(`${label}:start`); }, verifyOwner: async () => {}, diagnostic: () => ({ kind: "unknown" }),
    close: () => calls.push(`${label}:close`) }), close: () => {} });
  const native = transport("native"); const appServer = transport("app-server");
  const routed = new RoutedTaskStateTransport(appServer, [{ owns: task => task.sourceId === "work", states: native }],
    async () => { throw new Error("private discovery exception text"); });
  const connections = new TaskStateConnections(routed, () => 456);
  await assert.rejects(connections.connect("binding", work, () => {}, () => {}), /private discovery exception text/);
  assert.equal(calls.some(call => call.endsWith(":start")), false);
  assert.equal(connections.diagnostic("binding"), null);
  assert.deepEqual(connections.lastFailureDiagnostic("binding"), {
    kind: "unknown", selection: "owner-discovery-failed", failureClass: "other", routeGeneration: 1,
  });
  assert.equal(JSON.stringify(connections.lastFailureDiagnostic("binding")).includes("private"), false);
});

test("a successful reconnect clears prior failed route evidence", async () => {
  let attempt = 0;
  const native: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { throw new TaskOwnedByClientError(); }, verifyOwner: async () => {},
    diagnostic: () => ({ kind: "app-server" }), close: () => {} }), close: () => {} };
  const fallback: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { if (attempt++ === 0) throw new Error("private first attempt failure"); },
    verifyOwner: async () => {}, diagnostic: () => ({ kind: "native-observer" }), close: () => {} }), close: () => {} };
  const connections = new TaskStateConnections(new RoutedTaskStateTransport(fallback,
    [{ owns: task => task.sourceId === "work", states: native }]));
  await assert.rejects(connections.connect("binding", work, () => {}, () => {}), /private first attempt failure/);
  assert.ok(connections.lastFailureDiagnostic("binding"));
  await connections.connect("binding", work, () => {}, () => {});
  assert.equal(connections.lastFailureDiagnostic("binding"), null);
  assert.deepEqual(connections.diagnostic("binding"), {
    kind: "native-observer", selection: "native-after-owner-rejection", routeGeneration: 2,
  });
  await connections.stop();
});

test("explicit close clears prior failed route evidence", async () => {
  const native: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { throw new TaskOwnedByClientError(); }, verifyOwner: async () => {},
    diagnostic: () => ({ kind: "app-server" }), close: () => {} }), close: () => {} };
  const fallback: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { throw new Error("private fallback failure"); }, verifyOwner: async () => {},
    diagnostic: () => ({ kind: "unknown" }), close: () => {} }), close: () => {} };
  const connections = new TaskStateConnections(new RoutedTaskStateTransport(fallback,
    [{ owns: task => task.sourceId === "work", states: native }]));
  await assert.rejects(connections.connect("binding", work, () => {}, () => {}));
  assert.ok(connections.lastFailureDiagnostic("binding"));
  connections.close("binding");
  assert.equal(connections.lastFailureDiagnostic("binding"), null);
});

test("failed route evidence expires instead of making an obsolete owner error look current", async () => {
  let now = 1_000;
  const transport: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { throw new DesktopUnavailableError("private transport detail"); },
    verifyOwner: async () => {}, close: () => {} }), close: () => {} };
  const connections = new TaskStateConnections(transport, () => now);
  await assert.rejects(connections.connect("binding", work, () => {}, () => {}));
  assert.equal(connections.lastFailureDiagnostic("binding")?.failureClass, "desktop-unavailable");
  now += 5 * 60_000 + 1;
  assert.equal(connections.lastFailureDiagnostic("binding"), null);
});

test("post-start onError retains fixed route evidence before closing the connection", async () => {
  const reportError: { current?: (error: Error) => void } = {};
  const native: TaskStateTransport = { subscribe: (task, _onState, onError) => {
    reportError.current = onError;
    return { task, start: async () => {}, verifyOwner: async () => {},
      diagnostic: () => ({ kind: "native-observer", nativeOwnerClientId: "native-client" }), close: () => {} };
  }, close: () => {} };
  const appServer: TaskStateTransport = { subscribe: task => {
    return { task, start: async () => {}, verifyOwner: async () => {}, diagnostic: () => ({ kind: "app-server" }), close: () => {} };
  }, close: () => {} };
  const connections = new TaskStateConnections(new RoutedTaskStateTransport(native,
    [{ owns: task => task.sourceId === "work", states: appServer }], async () => true), () => 789);
  const failures: Error[] = [];
  await connections.connect("binding-private", work, () => {}, failure => failures.push(failure.error));
  assert.ok(reportError.current);
  reportError.current(new DesktopUnavailableError("private native path and token detail"));
  assert.equal(connections.has("binding-private"), false);
  assert.equal(connections.diagnostic("binding-private"), null);
  assert.equal(failures.length, 1);
  assert.deepEqual(connections.lastFailureDiagnostic("binding-private"), {
    kind: "unknown", selection: "native-discovered", failureClass: "desktop-unavailable", routeGeneration: 1,
  });
  assert.equal(JSON.stringify(connections.lastFailureDiagnostic("binding-private")).includes("private"), false);
});

test("connection lifecycle reports notification failure stage without exception content", async () => {
  const events: unknown[] = [];
  const scopes: TaskRef[] = [];
  let reportError: ((error: Error) => void) | undefined;
  const transport: TaskStateTransport = { subscribe: (task, _onState, onError) => {
    reportError = onError;
    return { task, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const connections = new TaskStateConnections(transport, () => 1_000, (_id, event, task) => {
    events.push(event); scopes.push(task);
  });
  await connections.connect("binding", work, () => {}, () => {});
  reportError!(new Error("private token and task path"));
  assert.deepEqual(events, [
    { phase: "subscribe", outcome: "attempt", routeGeneration: 1 },
    { phase: "resume", outcome: "confirmed", routeGeneration: 1, elapsedMs: 0 },
    { phase: "notification", outcome: "failed", reason: "other", routeGeneration: 1 },
  ]);
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.deepEqual(scopes, [work, work, work]);
});

test("exclusive claim wins before legacy and never falls back after an owner error", async () => {
  const f = fixture();
  const legacy = { ...f.owner, owns: () => true };
  const exclusive = { ...f.owner, routingPolicy: "exclusive" as const,
    owns: (task: TaskRef) => task.threadId === "work",
    submitWithReceipt: async () => { f.calls.push("exclusive:submit"); throw new TaskOwnedByClientError(); },
    inspectTask: async () => { f.calls.push("exclusive:inspect"); throw new TaskOwnedByClientError(); },
    getGoal: async () => { f.calls.push("exclusive:goal"); throw new ActionRejectedError("owner unavailable"); },
    ensureOpen: async () => { f.calls.push("exclusive:open"); throw new TaskOwnedByClientError(); },
  };
  const routed = new RoutedCodexTasks(f.base, [legacy, exclusive]);
  await assert.rejects(routed.submitWithReceipt!({ operationId: "exclusive", task: work, text: "x" }), TaskOwnedByClientError);
  await assert.rejects(routed.inspectTask(work), TaskOwnedByClientError);
  await assert.rejects(routed.getGoal!(work), /owner unavailable/u);
  await assert.rejects(routed.ensureOpen!(work), TaskOwnedByClientError);
  assert.deepEqual(f.calls, ["exclusive:submit", "exclusive:inspect", "exclusive:goal", "exclusive:open"]);
});

test("exclusive routing readiness affects health only; ambiguity refuses before side effects", async () => {
  const f = fixture();
  const exclusive = { ...f.owner, routingPolicy: "exclusive" as const,
    owns: (task: TaskRef) => task.threadId === "work", isReady: () => false };
  const routed = new RoutedCodexTasks(f.base, [exclusive]);
  assert.equal(await routed.ownerAdapterStatus!(work), "missing");
  await routed.submitWithReceipt!({ operationId: "still-routed", task: work, text: "x" });
  assert.deepEqual(f.calls, ["owner:submit"]);
  const ambiguous = new RoutedCodexTasks(f.base, [exclusive, { ...exclusive }]);
  await assert.rejects(ambiguous.submitWithReceipt!({ operationId: "ambiguous", task: work, text: "x" }), ActionRejectedError);
  assert.deepEqual(f.calls, ["owner:submit"]);
});

test("exclusive queue reconciliation never treats the legacy writer as proof of acceptance", async () => {
  const f = fixture();
  let baseReads = 0;
  const base = { ...f.base,
    findAcceptedInput: async () => { baseReads++; return "wrong-base-turn"; },
    findQueuedSubmission: async () => { baseReads++; return "wrong-base-queue"; } };
  const exclusive = { ...f.owner, routingPolicy: "exclusive" as const,
    findAcceptedInput: async () => null,
    findQueuedSubmission: async () => null };
  const routed = new RoutedCodexTasks(base, [exclusive]);
  assert.equal(await routed.findAcceptedInput!(work, "unknown-operation"), null);
  assert.equal(await routed.findQueuedSubmission!(work, "unknown-operation"), null);
  assert.equal(baseReads, 0);
});

test("missing terminal history scanner cannot fabricate a completed negative scan", async () => {
  const f = fixture();
  await assert.rejects(f.routed.scanTerminalQueuedInput!(primary, "missing", null), /Сверка терминальной истории недоступна/u);
  const exclusive = { ...f.owner, routingPolicy: "exclusive" as const };
  const routed = new RoutedCodexTasks(f.base, [exclusive]);
  await assert.rejects(routed.scanTerminalQueuedInput!(work, "missing", null), /Сверка терминальной истории недоступна/u);
});

test("accepted-input reconciliation falls back to the exact profile task after a nonexclusive owner read error", async () => {
  const f = fixture(); const sourceTask = { ...work, rolloutPath: "C:/codex/sessions/exact.jsonl" };
  let baseTask: TaskRef | undefined; let baseOperationId: string | undefined;
  const base = { ...f.base, findAcceptedInput: async (task: TaskRef, operationId: string) => {
    baseTask = task; baseOperationId = operationId; return "profile-turn";
  } } satisfies CodexTasks;
  const owner = { ...f.owner, findAcceptedInput: async () => { throw new Error("profile owner read failed"); } };
  const routed = new RoutedCodexTasks(base, [owner]);

  assert.equal(await routed.findAcceptedInput!(sourceTask, "operation-1"), "profile-turn");
  assert.deepEqual(baseTask, sourceTask);
  assert.equal(baseOperationId, "operation-1");
});

test("accepted-input reconciliation keeps an exclusive owner fail-closed after a read error", async () => {
  const f = fixture(); let baseReads = 0;
  const base = { ...f.base, findAcceptedInput: async () => { baseReads++; return "profile-turn"; } } satisfies CodexTasks;
  const exclusive = { ...f.owner, routingPolicy: "exclusive" as const,
    findAcceptedInput: async () => { throw new Error("exclusive owner read failed"); } };
  const routed = new RoutedCodexTasks(base, [exclusive]);

  await assert.rejects(routed.findAcceptedInput!(work, "operation-2"), /exclusive owner read failed/u);
  assert.equal(baseReads, 0);
});

test("exclusive task refuses unsupported edit, transfer, reveal and export before base", async () => {
  const f = fixture(); let touched = 0;
  const base = { ...f.base,
    editLastUserTurn: async () => { touched++; throw new Error("base edit"); },
    transferTask: async () => { touched++; throw new Error("base transfer"); },
    transferCheckpoint: async () => { touched++; throw new Error("base checkpoint"); },
    verifyTransferSource: async () => { touched++; },
    verifyTransferTarget: async () => { touched++; },
    archiveTransferredSource: async () => { touched++; },
    revealTask: async () => { touched++; },
    exportMarkdown: async () => { touched++; return "base"; },
  } satisfies CodexTasks;
  const exclusive = { ...f.owner, routingPolicy: "exclusive" as const };
  const routed = new RoutedCodexTasks(base, [exclusive]);
  const request = { operationId: "transfer", startedAt: 1, task: { ...work, title: "Work" },
    targetSourceId: "other", projectId: null };
  const target = { ...work, title: "Copy", workspace: "C:/owned", updatedAt: 1 };
  const checkpoint = { sourceThreadId: "work" } as never;
  await assert.rejects(routed.editLastUserTurn!({ operationId: "edit", task: work,
    text: "x", expectedTurnId: "turn", expectedOperationId: "prior" }), ActionRejectedError);
  await assert.rejects(routed.transferTask!(request), ActionRejectedError);
  await assert.rejects(routed.transferCheckpoint!(work), ActionRejectedError);
  await assert.rejects(routed.verifyTransferSource!(work, checkpoint), ActionRejectedError);
  await assert.rejects(routed.verifyTransferTarget!(request, target), ActionRejectedError);
  await assert.rejects(routed.archiveTransferredSource!(work), ActionRejectedError);
  await assert.rejects(routed.revealTask!(work), ActionRejectedError);
  await assert.rejects(routed.exportMarkdown(work), ActionRejectedError);
  const archiveProbe = routed.isTaskArchived!(work).catch(error => error);
  assert.ok(await archiveProbe instanceof ActionRejectedError);
  assert.equal(touched, 0);
});

test("exclusive state stream never invokes discovery or fallback, including TaskOwned errors", async () => {
  const used: string[] = [];
  const native: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { used.push("native:start"); throw new TaskOwnedByClientError(); },
    verifyOwner: async () => {}, close: () => used.push("native:close") }), close: () => {} };
  const client: TaskStateTransport = { subscribe: task => ({ task,
    start: async () => { used.push("client:start"); }, verifyOwner: async () => {},
    close: () => used.push("client:close") }), close: () => {} };
  const owner = { routingPolicy: "exclusive" as const,
    owns: (task: TaskRef) => task.threadId === "work", states: native };
  const routed = new RoutedTaskStateTransport(client, [owner], async () => {
    used.push("discover"); return true;
  });
  const stream = routed.subscribe(work, () => {}, () => {});
  await assert.rejects(stream.start(), TaskOwnedByClientError);
  stream.close();
  assert.deepEqual(used, ["native:start", "native:close"]);
  const ambiguous = new RoutedTaskStateTransport(client, [owner, { ...owner }]);
  assert.throws(() => ambiguous.subscribe(work, () => {}, () => {}), ActionRejectedError);
});

test("exclusive mutation fallbacks preserve exact owner errors and never touch base", async () => {
  const f = fixture(); const touched: string[] = [];
  const busy = async (): Promise<never> => { throw new TaskOwnedByClientError(); };
  const base = { ...f.base,
    interrupt: async () => { touched.push("interrupt"); }, queue: async () => { touched.push("queue"); return "base"; },
    selectModel: async () => { touched.push("model"); }, moveTask: async () => { touched.push("move"); },
    renameTask: async () => { touched.push("rename"); return { liveTitleUpdated: false }; },
    archiveTask: async () => { touched.push("archive"); },
    answerQuestions: async () => { touched.push("answer"); },
  } satisfies CodexTasks;
  const owner = { ...f.owner, routingPolicy: "exclusive" as const,
    interrupt: busy, queue: busy, selectModel: busy, moveTask: busy, renameTask: busy, archiveTask: busy,
    answerQuestions: busy };
  const routed = new RoutedCodexTasks(base, [owner]);
  for (const action of [
    () => routed.interrupt(work), () => routed.queue!({ operationId: "queue", task: work, text: "x" }),
    () => routed.selectModel(work, "model", "low"), () => routed.moveTask(work, null),
    () => routed.renameTask(work, "title"), () => routed.archiveTask(work),
    () => routed.answerQuestions!(work, {} as never, {}, "answer", async () => {}),
  ]) await assert.rejects(action(), TaskOwnedByClientError);
  assert.deepEqual(touched, []);
  const uncertain = new UncertainActionError();
  owner.submitWithReceipt = async () => { throw uncertain; };
  await assert.rejects(routed.submitWithReceipt!({ operationId: "uncertain", task: work, text: "x" }),
    error => error === uncertain);
  assert.deepEqual(touched, []);
});

test("exclusive inspection never reassigns unavailable state; health readiness is explicit", async () => {
  const f = fixture(); let baseReads = 0;
  const base = { ...f.base, inspectTask: async () => { baseReads++; throw new Error("base read"); } };
  const owner = { ...f.owner, routingPolicy: "exclusive" as const,
    inspectTask: async () => ({ status: "unavailable" as const, workspace: null, model: null, effort: null,
      nextModel: null, nextEffort: null, context: null }) };
  const routed = new RoutedCodexTasks(base, [owner]);
  assert.equal((await routed.inspectTask(work)).status, "unavailable");
  assert.equal(await routed.ownerAdapterStatus!(work), "missing");
  assert.equal(baseReads, 0);
  const { ensureOpen: _unused, ...noOpenOwner } = owner;
  const withoutOpen = new RoutedCodexTasks(base, [noOpenOwner]);
  await assert.rejects(withoutOpen.ensureOpen!(work), ActionRejectedError);
  assert.equal(baseReads, 0);
});

test("exclusive transfer target blocks a legacy source and owner health never reads base goal", async () => {
  const f = fixture(); let touched = 0; let ownerReads = 0;
  const target = { ...work, title: "target", workspace: "C:/owned", updatedAt: 1 };
  const base = { ...f.base,
    transferTask: async () => { touched++; return target; },
    verifyTransferTarget: async () => { touched++; },
    healthGoal: async () => { touched++; return null; },
  } satisfies CodexTasks;
  const owner = { ...f.owner, routingPolicy: "exclusive" as const,
    getGoal: async () => { ownerReads++; return null; } };
  const routed = new RoutedCodexTasks(base, [owner]);
  const request = { operationId: "transfer", startedAt: 1, task: { ...primary, title: "source" },
    targetSourceId: "work", projectId: null, existingTarget: target };
  await assert.rejects(routed.transferTask!(request), ActionRejectedError);
  await assert.rejects(routed.verifyTransferTarget!(request, target), ActionRejectedError);
  assert.equal(await routed.healthGoal!(work), null);
  assert.equal(ownerReads, 1);
  assert.equal(touched, 0);
});

test("exclusive state owner wins even when a legacy owner is earlier", async () => {
  const used: string[] = [];
  const stream = (label: string): TaskStateTransport => ({
    subscribe: task => ({ task, start: async () => { used.push(label); }, verifyOwner: async () => {}, close: () => {} }),
    close: () => {},
  });
  const routed = new RoutedTaskStateTransport(stream("base"), [
    { owns: () => true, states: stream("legacy") },
    { routingPolicy: "exclusive", owns: task => task.threadId === "work", states: stream("exclusive") },
  ]);
  await routed.subscribe(work, () => {}, () => {}).start();
  assert.deepEqual(used, ["exclusive"]);
});
