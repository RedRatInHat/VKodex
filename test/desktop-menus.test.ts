import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError } from "../src/desktop/contracts.js";
import { parseModelsCache, taskDetails } from "../src/desktop/details.js";
import { conversationMarkdown, MetadataRpc, NativeDesktopMetadata } from "../src/desktop/metadata.js";
import type { IpcObject } from "../src/desktop/ipc-client.js";

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

test("native metadata refuses other hosts and mismatched export responses", async () => {
  let calls = 0;
  const metadata = new NativeDesktopMetadata({ call: async () => { calls++; return { thread: { id: "wrong-thread", turns: [] } }; } });
  await assert.rejects(metadata.rename({ hostId: "remote", threadId: "fixture" }, "Title"), ActionRejectedError);
  assert.equal(calls, 0);
  await assert.rejects(metadata.markdown({ hostId: "local", threadId: "fixture" }), DesktopUnavailableError);
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
