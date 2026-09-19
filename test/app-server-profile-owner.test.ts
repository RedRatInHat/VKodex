import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerEnvelope, AppServerRequestOptions, AppServerRpc, AppServerServerRequestHandler } from "../src/codex/app-server-connection.js";
import { AppServerProfileOwner, AppServerOwnerStateRouter } from "../src/codex/app-server-profile-owner.js";
import { ActionRejectedError } from "../src/core/codex-tasks.js";

type JsonObject = Record<string, unknown>;
class Rpc implements AppServerRpc {
  readonly calls: string[] = []; closed = 0;
  private readonly notifications = new Set<(notification: AppServerEnvelope) => void>();
  async start(): Promise<void> {}
  async request(method: string, _params: JsonObject = {}, _options?: AppServerRequestOptions): Promise<JsonObject> {
    this.calls.push(method);
    if (method === "thread/resume") return { thread: { id: "task", name: "Task", cwd: "D:\\w", status: { type: "idle" } },
      cwd: "D:\\w", model: "gpt", reasoningEffort: "high", initialTurnsPage: { data: [], nextCursor: null } };
    if (method === "turn/start") return { turn: { id: "turn" } };
    if (method === "thread/read") return { thread: { id: "task" } };
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
  assert.deepEqual(rpc.calls, ["thread/resume", "thread/resume", "turn/start"]);
  await owner.close(); assert.equal(rpc.closed, 1);
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
