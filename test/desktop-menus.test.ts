import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError } from "../src/desktop/contracts.js";
import { parseModelsCache, parseNativeModels, taskDetails } from "../src/desktop/details.js";
import { conversationMarkdown, MetadataRpc, NativeAccountUsage, NativeDesktopGoals, NativeDesktopMetadata, parseAccountLabel, parseAccountUsage, parseTaskGoal } from "../src/desktop/metadata.js";
import type { IpcObject } from "../src/desktop/ipc-client.js";
import { TransferRpc } from "../src/desktop/app-server-transfer.js";
import { ProfileDesktopGoals, ProfileDesktopMetadata } from "../src/desktop/metadata.js";
import { TransferConflictError } from "../src/desktop/contracts.js";

test("context uses last token usage, clamps at the window and keeps unknown data unknown", () => {
  const usage = { last: { totalTokens: 100 }, total: { totalTokens: 900_000 }, modelContextWindow: 1_000 };
  assert.deepEqual(taskDetails({ latestTokenUsageInfo: usage }).context, { used: 100, window: 1_000, percent: 10 });
  assert.equal(taskDetails({ latestTokenUsageInfo: { ...usage, last: { totalTokens: 2_000 } } }).context?.percent, 100);
  for (const value of [null, {}, { ...usage, last: {} }, { ...usage, modelContextWindow: 0 }, { ...usage, modelContextWindow: NaN }, { ...usage, last: { totalTokens: -1 } }]) {
    assert.equal(taskDetails({ latestTokenUsageInfo: value }).context, null);
  }
});

test("task details separate current/next models and do not mark starting or unknown states idle", () => {
  const current = taskDetails({ cwd: "/fixture", latestThreadSettings: { model: "next", effort: "low" }, turns: [{ turnId: "turn", status: "inProgress", items: [], params: { model: "current", effort: "high" } }] });
  assert.equal(current.model, "current"); assert.equal(current.nextModel, "next"); assert.equal(current.status, "running");
  assert.equal(taskDetails({ turns: [{ turnId: null, status: "inProgress" }] }).status, "running");
  assert.equal(taskDetails({}).status, "unavailable");
  assert.equal(taskDetails({ threadRuntimeStatus: { type: "idle" }, resumeState: "resuming" }).status, "unavailable");
  assert.equal(taskDetails({ threadRuntimeStatus: { type: "idle" } }).status, "idle");
  const stale = taskDetails({
    latestThreadSettings: { model: "next", effort: "low" },
    threadRuntimeStatus: { type: "idle" }, resumeState: "resumed",
    turns: [
      { turnId: "orphan", turnStartedAtMs: 100, status: "inProgress", items: [], params: { model: "stale", effort: "high" } },
      { turnId: "latest", turnStartedAtMs: 200, status: "completed", items: [] },
    ],
  });
  assert.equal(stale.status, "idle"); assert.equal(stale.model, "next"); assert.equal(stale.effort, "low");
  assert.equal(taskDetails({ threadRuntimeStatus: { type: "idle" }, turns: [{ turnId: "possibly-current", status: "inProgress", items: [] }] }).status, "unavailable");
  assert.equal(taskDetails({ requests: [{}] }).status, "approval");
});

test("model cache supplies visible ordered IDs and supported efforts without hardcoded options", () => {
  const now = 100_000_000;
  const model = { slug: "model-a", display_name: "Model A", priority: 2, visibility: "list", supported_reasoning_levels: [{ effort: "novel-effort" }, { effort: "novel-effort" }], default_reasoning_level: "novel-effort" };
  const result = parseModelsCache({ fetched_at: new Date(now).toISOString(), models: [model, { ...model, slug: "hidden", visibility: "hide" }, { ...model, slug: "model-b", priority: 1 }, model, { ...model, slug: "bad", default_reasoning_level: "unsupported" }] }, now);
  assert.deepEqual(result.map(model => model.id), ["model-b", "model-a"]);
  assert.deepEqual(result[0]!.efforts, ["novel-effort"]);
  for (const fetchedAt of ["invalid", new Date(now - 25 * 60 * 60_000).toISOString(), new Date(now + 60 * 60_000).toISOString()]) assert.throws(() => parseModelsCache({ fetched_at: fetchedAt, models: [model] }, now), DesktopUnavailableError);
});

test("native model list exposes every account-visible model and its actual efforts", () => {
  const entry = { model: "gpt-example-spark", displayName: "Example Spark", hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], defaultReasoningEffort: "low" };
  const models = parseNativeModels({ data: [entry, { ...entry, model: "other" },
    { ...entry, model: "internal", hidden: true }, { ...entry, model: "invalid", defaultReasoningEffort: "high" }], nextCursor: null });
  assert.deepEqual(models.map(model => model.id), ["gpt-example-spark", "other"]);
  assert.deepEqual(models[0]!.efforts, ["low", "medium"]);
  assert.throws(() => parseNativeModels({ data: [entry], nextCursor: "more" }), DesktopUnavailableError);
});

test("Markdown contains only user and visible agent text and rejects incomplete or oversized history", () => {
  const thread = { name: "Fixture", turns: [{ itemsView: "full", items: [
    { type: "userMessage", content: [{ type: "text", text: "Visible question" }] },
    { type: "agentMessage", phase: "commentary", text: "Visible progress" },
    { type: "agentMessage", phase: "final_answer", text: "Visible answer" },
    ...["reasoning", "commandExecution", "mcpToolCall", "fileChange"].map(type => ({ type, text: "HIDDEN SENTINEL" })),
  ] }] };
  const markdown = conversationMarkdown(thread);
  assert.match(markdown, /Visible question/u); assert.match(markdown, /Visible progress/u); assert.match(markdown, /Visible answer/u);
  assert.doesNotMatch(markdown, /HIDDEN SENTINEL/u);
  for (const itemsView of ["notLoaded", "summary", undefined, {}]) assert.throws(() => conversationMarkdown({ turns: [{ itemsView, items: [] }] }), DesktopUnavailableError);
  assert.throws(() => conversationMarkdown({ turns: [{ itemsView: "full", items: [{ type: "agentMessage", text: "x".repeat(2 * 1024 * 1024 + 1) }] }] }), ActionRejectedError);
});

class MetadataChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly messages: IpcObject[] = [];
  respond: (message: IpcObject) => IpcObject | null = message => ({ id: message.id, result: {} });
  kills = 0;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as IpcObject; this.messages.push(request);
        if (request.id === undefined) continue;
        const response = this.respond(request);
        if (response) queueMicrotask(() => { const line = `${JSON.stringify(response)}\n`; this.stdout.write(line.slice(0, 4)); this.stdout.write(line.slice(4)); });
      }
    });
    this.stdin.on("finish", () => { queueMicrotask(() => this.emit("close", 0)); });
  }
  kill(): boolean { this.kills++; return true; }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

test("metadata helper initializes once and exposes no task execution methods", async () => {
  const child = new MetadataChild(); const rpc = new MetadataRpc("fixture-home", () => child.asChild(), 50);
  await rpc.call("thread/name/set", { threadId: "fixture", name: "New title" });
  assert.deepEqual(child.messages.map(message => message.method), ["initialize", "initialized", "thread/name/set"]);
  assert.deepEqual(child.messages[2]!.params, { threadId: "fixture", name: "New title" });
  await assert.rejects(rpc.call("turn/start" as "thread/read", {}), ActionRejectedError);
  assert.equal(child.messages.length, 3); assert.equal(child.stdin.writableEnded, true);
});

test("RPC helpers wait for process close and transfer identity is saved before releasing the writer", async () => {
  for (const kind of ["metadata", "transfer"] as const) {
    const child = new MetadataChild();
    Object.assign(child, { pid: 123, exitCode: null, signalCode: null });
    child.stdin.removeAllListeners("finish");
    let acknowledged = false; let settled = false;
    const work = (kind === "metadata"
      ? new MetadataRpc("fixture", () => child.asChild(), 100).call("thread/name/set", {})
      : new TransferRpc("fixture", () => child.asChild(), 100).call("thread/fork", {}, () => { acknowledged = true; }))
      .then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    if (kind === "transfer") assert.equal(acknowledged, true);
    child.emit("close", 0); await work;
    assert.equal(settled, true); assert.equal(child.kills, 0);
  }
});

test("an acknowledged fork finishes at process exit even if Windows stdio close is delayed", async () => {
  const child = new MetadataChild();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null });
  child.stdin.removeAllListeners("finish");
  let settled = false;
  const result = new TransferRpc("fixture", () => child.asChild(), 100).call("thread/fork", {})
    .then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  Object.assign(child, { exitCode: 0 }); child.emit("exit", 0);
  await result;
  assert.equal(settled, true); assert.equal(child.kills, 0);
  child.emit("close", 0);
});

test("RPC accepts a final response buffered in stdout after the process exited", async () => {
  for (const kind of ["metadata", "transfer"] as const) {
    const child = new MetadataChild();
    Object.assign(child, { pid: 123, exitCode: null, signalCode: null });
    child.respond = message => {
      if (message.id === 2) { Object.assign(child, { exitCode: 0 }); child.emit("exit", 0); }
      return { id: message.id, result: {} };
    };
    const result = kind === "metadata" ? new MetadataRpc("fixture", () => child.asChild(), 100).call("thread/name/set", {})
      : new TransferRpc("fixture", () => child.asChild(), 100).call("thread/fork", {});
    assert.deepEqual(await result, {});
    assert.equal(child.kills, 0);
  }
});

test("archive confirmation reads the exact row and detects source writes racing with archival", async t => {
  const { mkdtemp, writeFile, stat } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { default: Database } = await import("better-sqlite3");
  const home = await mkdtemp(path.join(tmpdir(), "vkodex-archive-verification-"));
  const rollout = path.join(home, "archived.jsonl");
  await writeFile(rollout, "original history");
  const db = new Database(path.join(home, "state_5.sqlite")); t.after(() => db.close());
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("source", 1, rollout);
  const file = await stat(rollout);
  const checkpoint = { rolloutPath: rollout, lastTurnId: "boundary", size: file.size, mtimeMs: file.mtimeMs };
  const metadata = new ProfileDesktopMetadata(() => home);
  const source = { hostId: "local", threadId: "source" };
  assert.equal(await metadata.isArchived(source, checkpoint), true);
  await writeFile(rollout, "source advanced before it was archived");
  await assert.rejects(metadata.isArchived(source, checkpoint), TransferConflictError);
  await assert.rejects(metadata.isArchived({ ...source, threadId: "missing" }), DesktopUnavailableError);
});

test("archived goals remain readable without resuming a writer or hiding active API failures", async t => {
  const { mkdtemp } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { default: Database } = await import("better-sqlite3");
  const home = await mkdtemp(path.join(tmpdir(), "vkodex-archived-goal-"));
  const state = new Database(path.join(home, "state_5.sqlite")); t.after(() => state.close());
  const goals = new Database(path.join(home, "goals_1.sqlite")); t.after(() => goals.close());
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER); INSERT INTO threads VALUES ('fixture', 1), ('empty', 1)");
  goals.exec("CREATE TABLE thread_goals (thread_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)");
  goals.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("fixture", "Saved goal", "budget_limited", 1000, 1100, 40, 100001, 140009);
  const error = new ActionRejectedError("native archived goal rejected");
  const reader = new ProfileDesktopGoals(() => home, () => ({ get: async () => { throw error; },
    set: async () => { throw new Error("no writes allowed"); }, clear: async () => { throw new Error("no writes allowed"); } }));
  const task = { hostId: "local", threadId: "fixture" };
  assert.deepEqual(await reader.get(task), { threadId: "fixture", objective: "Saved goal", status: "budgetLimited", tokenBudget: 1000,
    tokensUsed: 1100, timeUsedSeconds: 40, createdAt: 100, updatedAt: 140 });
  assert.equal(await reader.get({ ...task, threadId: "empty" }), null);
  state.exec("UPDATE threads SET archived = 0 WHERE id = 'fixture'");
  await assert.rejects(reader.get(task), value => value === error);
  await assert.rejects(reader.get({ ...task, threadId: "missing" }), value => value === error);
  await assert.rejects(reader.get({ ...task, hostId: "remote" }), value => value === error);
});

test("native goal API validates identity, state, budgets and exact local methods", async () => {
  const task = { hostId: "local", threadId: "fixture" };
  const raw = { threadId: "fixture", objective: "Ship the verified result", status: "active", tokenBudget: 250_000, tokensUsed: 12_500, timeUsedSeconds: 3_700, createdAt: 1_788_000_000, updatedAt: 1_788_000_100 };
  const calls: { method: string; params: IpcObject }[] = [];
  const goals = new NativeDesktopGoals({ call: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/goal/get") return { goal: raw };
    if (method === "thread/goal/set") return { goal: { ...raw, ...params } };
    if (method === "thread/goal/clear") return { cleared: true };
    throw new Error("unexpected method");
  } });
  assert.deepEqual(await goals.get(task), raw);
  assert.equal((await goals.set(task, { objective: "Updated", tokenBudget: null, status: "paused" })).status, "paused");
  assert.equal(await goals.clear(task), true);
  assert.deepEqual(calls, [
    { method: "thread/goal/get", params: { threadId: "fixture" } },
    { method: "thread/goal/set", params: { threadId: "fixture", objective: "Updated", status: "paused", tokenBudget: null } },
    { method: "thread/goal/clear", params: { threadId: "fixture" } },
  ]);
  assert.equal(parseTaskGoal(null, "fixture"), null);
  assert.throws(() => parseTaskGoal({ ...raw, threadId: "other" }, "fixture"), DesktopUnavailableError);
  await assert.rejects(goals.set(task, { tokenBudget: 0 }), ActionRejectedError);
  await assert.rejects(goals.get({ hostId: "remote", threadId: "fixture" }), ActionRejectedError);
  assert.equal(calls.length, 3);
});

test("account usage validates Codex rate-limit windows and exposes only displayable fields", async () => {
  const response = { rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_788_643_425 },
    credits: { hasCredits: false, unlimited: false, balance: "0" } }, rateLimitsByLimitId: {
      codex: { limitId: "codex", primary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 1_788_643_425 } },
      spark: { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_788_106_270 }, secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_788_693_070 } },
      malformed: { limitId: "bad", primary: { usedPercent: 101, windowDurationMins: 0, resetsAt: -1 } },
    }, rateLimitResetCredits: { availableCount: 2 } };
  const usage = parseAccountUsage(response);
  assert.equal(usage.planType, "pro"); assert.equal(usage.limits.length, 2);
  assert.equal(usage.accountLabel, null); assert.equal(usage.sourceLabel, null);
  assert.deepEqual(usage.limits[1], { id: "codex_bengalfox", name: "GPT-5.3-Codex-Spark", primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1_788_106_270 }, secondary: { usedPercent: 3, windowMinutes: 10_080, resetsAt: 1_788_693_070 } });
  assert.deepEqual(usage.credits, { hasCredits: false, unlimited: false, balance: "0" }); assert.equal(usage.resetCredits, 2);
  const reader = new NativeAccountUsage({ call: async (method, params) => {
    if (method === "account/read") { assert.deepEqual(params, { refreshToken: false }); return { account: { type: "chatgpt", email: "owner@example.com", planType: "pro" } }; }
    assert.equal(method, "account/rateLimits/read"); assert.deepEqual(params, {}); return response;
  } });
  assert.deepEqual(await reader.read(), { ...usage, accountLabel: "owner@example.com" });
  const noIdentity = new NativeAccountUsage({ call: async method => {
    if (method === "account/read") throw new DesktopUnavailableError();
    return response;
  } });
  assert.deepEqual(await noIdentity.read(), usage);
  assert.equal(parseAccountLabel({ account: { type: "chatgpt", name: "Owner", email: "owner@example.com" } }), "Owner · owner@example.com");
  assert.equal(parseAccountLabel({ account: { type: "chatgpt", email: "PRIVATE_SENTINEL\n" } }), "ChatGPT");
  assert.throws(() => parseAccountUsage({ rateLimits: { limitId: "codex", planType: "PRIVATE_SENTINEL" } }), error => error instanceof DesktopUnavailableError && !error.message.includes("PRIVATE_SENTINEL"));
});

test("account reset credits use an idempotency key and validate the outcome", async () => {
  const idempotencyKey = "4fea0429-352c-4873-b963-bbb7a1a92e01";
  const calls: { method: string; params: IpcObject }[] = [];
  const reader = new NativeAccountUsage({ call: async (method, params) => {
    calls.push({ method, params });
    return { outcome: "reset" };
  } });
  assert.equal(await reader.consumeReset(idempotencyKey), "reset");
  assert.deepEqual(calls, [{ method: "account/rateLimitResetCredit/consume", params: { idempotencyKey } }]);
  await assert.rejects(reader.consumeReset("not-a-uuid"), ActionRejectedError);
  assert.equal(calls.length, 1);
  const unknown = new NativeAccountUsage({ call: async () => ({ outcome: "futureOutcome" }) });
  await assert.rejects(unknown.consumeReset(idempotencyKey), UncertainActionError);
});

test("account reads are read-only and time out as unavailable rather than uncertain", async () => {
  for (const method of ["account/read", "account/rateLimits/read"] as const) {
    const child = new MetadataChild(); child.respond = message => message.id === 1 ? { id: 1, result: {} } : null;
    const rpc = new MetadataRpc("fixture-home", () => child.asChild(), 10);
    await assert.rejects(rpc.call(method, method === "account/read" ? { refreshToken: false } : {}), DesktopUnavailableError);
    assert.deepEqual(child.messages.map(message => message.method), ["initialize", "initialized", method]);
  }
  const child = new MetadataChild(); child.respond = message => message.id === 1 ? { id: 1, result: {} } : null;
  await assert.rejects(new MetadataRpc("fixture-home", () => child.asChild(), 10).call("thread/goal/get", { threadId: "fixture" }), DesktopUnavailableError);
});

test("metadata timeouts and raw API failures are sanitized and never retried", async () => {
  for (const mutating of [false, true]) {
    const child = new MetadataChild(); child.respond = message => message.id === 1 ? { id: 1, result: {} } : null;
    const rpc = new MetadataRpc("fixture-home", () => child.asChild(), 10);
    await assert.rejects(rpc.call(mutating ? "thread/name/set" : "thread/read", {}), mutating ? UncertainActionError : DesktopUnavailableError);
    assert.equal(child.messages.filter(message => message.id === 2).length, 1);
  }
  const child = new MetadataChild(); child.respond = message => message.id === 1 ? { id: 1, result: {} } : { id: 2, error: { code: 500, message: "PRIVATE_SENTINEL" } };
  await assert.rejects(new MetadataRpc("fixture-home", () => child.asChild(), 50).call("thread/archive", {}), error => error instanceof ActionRejectedError && !error.message.includes("PRIVATE_SENTINEL"));
});

test("metadata archive exposes a safe explanation for a nonstandard rollout filename", async () => {
  const child = new MetadataChild();
  child.respond = message => message.id === 1 ? { id: 1, result: {} }
    : { id: 2, error: { code: -32600, message: "rollout path C:/PRIVATE.routing-clean.jsonl has an invalid filename" } };
  await assert.rejects(new MetadataRpc("fixture-home", () => child.asChild(), 50).call("thread/archive", { threadId: "fixture" }),
    error => error instanceof ActionRejectedError && /нестандартное имя/u.test(error.message) && !error.message.includes("PRIVATE"));
});

test("native metadata refuses other hosts and mismatched export responses", async () => {
  let calls = 0;
  const metadata = new NativeDesktopMetadata({ call: async () => { calls++; return { thread: { id: "wrong-thread", turns: [] } }; } });
  await assert.rejects(metadata.rename({ hostId: "remote", threadId: "fixture" }, "Title"), ActionRejectedError);
  assert.equal(calls, 0);
  await assert.rejects(metadata.markdown({ hostId: "local", threadId: "fixture" }), DesktopUnavailableError);
});

test("native rename recovers an exact target after a transient metadata startup failure", async () => {
  const calls: string[] = []; let writes = 0; let current: string | null = null;
  const metadata = new NativeDesktopMetadata({ call: async method => {
    calls.push(method);
    if (method === "thread/read") return { thread: { id: "fixture", name: current } };
    if (++writes === 1) throw new DesktopUnavailableError("startup timeout");
    current = "Preserved title"; return {};
  } });
  await metadata.rename({ hostId: "local", threadId: "fixture" }, "Preserved title");
  assert.deepEqual(calls, ["thread/name/set", "thread/read", "thread/name/set"]);
  assert.equal(writes, 2);
});

test("native rename reconciles a lost response without repeating an accepted write", async () => {
  const calls: string[] = []; let writes = 0;
  const metadata = new NativeDesktopMetadata({ call: async method => {
    calls.push(method);
    if (method === "thread/read") return { thread: { id: "fixture", name: "Preserved title" } };
    writes++; throw new UncertainActionError();
  } });
  await metadata.rename({ hostId: "local", threadId: "fixture" }, "Preserved title");
  assert.deepEqual(calls, ["thread/name/set", "thread/read"]);
  assert.equal(writes, 1);
});

test("native rename does not retry a rejected write unless readback proves it already succeeded", async () => {
  for (const current of ["Preserved title", "Other title"] as const) {
    const calls: string[] = [];
    const metadata = new NativeDesktopMetadata({ call: async method => {
      calls.push(method);
      if (method === "thread/read") return { thread: { id: "fixture", name: current } };
      throw new ActionRejectedError("rejected");
    } });
    const rename = metadata.rename({ hostId: "local", threadId: "fixture" }, "Preserved title");
    if (current === "Preserved title") await rename;
    else await assert.rejects(rename, ActionRejectedError);
    assert.deepEqual(calls, ["thread/name/set", "thread/read"]);
  }
});

test("metadata archive explains an active writer without retrying or exposing thread identifiers", async () => {
  const child = new MetadataChild();
  child.respond = message => message.id === 1 ? { id: 1, result: {} }
    : { id: 2, error: { code: -32600, message: "thread PRIVATE_SENTINEL already has an active writer" } };
  await assert.rejects(new MetadataRpc("fixture-home", () => child.asChild(), 50).call("thread/archive", { threadId: "fixture" }),
    error => error instanceof ActionRejectedError && /удерживает её историю/u.test(error.message)
      && /Архивируй её в приложении/u.test(error.message) && !error.message.includes("PRIVATE_SENTINEL"));
  assert.equal(child.messages.filter(message => message.method === "thread/archive").length, 1);
});

test("native project assignment uses thread metadata and clears with an empty project id", async () => {
  const calls: { method: string; params: IpcObject }[] = [];
  const metadata = new NativeDesktopMetadata({ call: async (method, params) => { calls.push({ method, params }); return {}; } });
  const task = { hostId: "local", threadId: "fixture" };
  await metadata.assignProject(task, "project-a"); await metadata.assignProject(task, null);
  assert.deepEqual(calls, [
    { method: "thread/metadata/update", params: { threadId: "fixture", projectId: "project-a" } },
    { method: "thread/metadata/update", params: { threadId: "fixture", projectId: "" } },
  ]);
});

test("an unchanged native project assignment is accepted only after exact readback", async () => {
  const calls: { method: string; params: IpcObject }[] = [];
  const task = { hostId: "local", threadId: "fixture" };
  const metadata = new NativeDesktopMetadata({ call: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/metadata/update") throw new ActionRejectedError("no-op");
    return { thread: { id: "fixture", projectId: "project-a" } };
  } });
  await metadata.assignProject(task, "project-a");
  assert.deepEqual(calls.map(call => call.method), ["thread/metadata/update", "thread/read"]);

  const mismatch = new NativeDesktopMetadata({ call: async method => {
    if (method === "thread/metadata/update") throw new ActionRejectedError("rejected");
    return { thread: { id: "fixture", projectId: "project-b" } };
  } });
  await assert.rejects(mismatch.assignProject(task, "project-a"), /rejected/u);
});


test("native queue appends by operation ID without reading or replacing existing queue", async () => {
  const calls: { method: string; params: IpcObject }[] = [];
  const metadata = new NativeDesktopMetadata({ call: async (method, params) => {
    calls.push({ method, params });
    return { queuedSubmission: { id: "native-id", clientUserMessageId: params.clientUserMessageId } };
  } });
  const request = { task: { hostId: "local", threadId: "task" }, operationId: "op", text: "later" };
  const input = [{ type: "text", text: "later" }];
  assert.equal(await metadata.queue(request, input), "native-id");
  assert.deepEqual(calls, [{ method: "thread/queue/add", params: { threadId: "task", clientUserMessageId: "op", input } }]);
  const bad = new NativeDesktopMetadata({ call: async () => ({ queuedSubmission: { id: "wrong" } }) });
  await assert.rejects(bad.queue(request, input), UncertainActionError);
});
