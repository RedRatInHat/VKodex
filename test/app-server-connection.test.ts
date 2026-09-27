import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AppServerConnection, AppServerRejectedError, AppServerUnavailableError, AppServerUncertainError } from "../src/codex/app-server-connection.js";
import type { AppServerServerRequestContext } from "../src/codex/app-server-connection.js";

type JsonObject = Record<string, unknown>;

class AppServerChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: JsonObject[] = [];
  respond: (message: JsonObject) => JsonObject | null = message => message.method === "initialize"
    ? { id: message.id, result: { serverInfo: { name: "fixture" } } }
    : { id: message.id, result: { ok: true } };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = undefined;

  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject; this.messages.push(message);
        if (message.id === undefined) continue;
        const response = this.respond(message);
        if (response) queueMicrotask(() => this.send(response));
      }
    });
  }

  send(message: JsonObject): void {
    const line = `${JSON.stringify(message)}\n`;
    this.stdout.write(line.slice(0, 3)); this.stdout.write(line.slice(3));
  }

  disconnect(): void { this.emit("close", 1, null); }
  kill(): boolean { this.disconnect(); return true; }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

test("one long-lived App Server connection initializes once and multiplexes requests and notifications", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const notifications: string[] = [];
  connection.onNotification(notification => notifications.push(notification.method));
  try {
    assert.deepEqual(await connection.request("thread/read", { threadId: "task" }), { ok: true });
    assert.deepEqual(await connection.request("model/list"), { ok: true });
    child.send({ method: "turn/started", params: { threadId: "task", turn: { id: "turn" } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(notifications, ["turn/started"]);
    assert.equal(child.messages.filter(message => message.method === "initialize").length, 1);
    assert.equal(child.messages.filter(message => message.method === "initialized").length, 1);
    assert.deepEqual(child.messages.map(message => message.method), ["initialize", "initialized", "thread/read", "model/list"]);
  } finally { await connection.close(); }
});

test("raw response callback preserves response-before-notification order in one stdout chunk", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "thread/read" ? null
    : { id: message.id, result: { ok: true } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const order: string[] = [];
  let observed: JsonObject | null = null;
  connection.onNotification(() => order.push("notification"));
  try {
    await connection.start();
    const pending = connection.request("thread/read", { threadId: "own" }, {
      onResponseEnvelope: envelope => {
        order.push("response"); observed = envelope;
        ((envelope as { result: JsonObject }).result.thread as JsonObject).id = "callback-local-change";
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    const id = child.messages.find(message => message.method === "thread/read")!.id;
    const response = { id, result: { thread: { id: "own" } } };
    const notification = { method: "thread/status/changed", params: { threadId: "own" } };
    child.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(notification)}\n`);
    const result = await pending; order.push("settled");
    assert.deepEqual(order, ["response", "notification", "settled"]);
    assert.deepEqual(observed, { result: { thread: { id: "callback-local-change" } } },
      "the callback receives its own ID-free clone");
    assert.deepEqual(result, { thread: { id: "own" } },
      "callback mutation cannot change the safe Promise result");
  } finally { await connection.close(); }
});

test("opt-in raw error callback retains native details while the Promise error stays safe", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "thread/read" ? null
    : { id: message.id, result: { ok: true } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let observed: JsonObject | null = null;
  try {
    await connection.start();
    const pending = connection.request("thread/read", { threadId: "own" }, {
      onResponseEnvelope: envelope => { observed = envelope; },
    });
    void pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const id = child.messages.find(message => message.method === "thread/read")!.id;
    child.send({ id, error: { code: -32010, message: "private native detail",
      data: { nativeTag: "opaque" } } });
    await assert.rejects(pending, error => error instanceof AppServerRejectedError &&
      error.code === -32010 && !error.message.includes("private native detail"));
    assert.deepEqual(observed, { error: { code: -32010,
      message: "private native detail", data: { nativeTag: "opaque" } } });
  } finally { await connection.close(); }
});

test("throwing raw response callback cannot lose the worker, response, or next notification", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "thread/read" ? null
    : { id: message.id, result: { ok: true } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const notifications: string[] = [];
  let calls = 0;
  connection.onNotification(notification => notifications.push(notification.method));
  try {
    await connection.start();
    const pending = connection.request("thread/read", { threadId: "own" }, {
      onResponseEnvelope: () => { calls++; throw new Error("frontend writer failed"); },
    });
    await new Promise(resolve => setImmediate(resolve));
    const id = child.messages.find(message => message.method === "thread/read")!.id;
    child.stdout.write(`${JSON.stringify({ id, result: { ok: true } })}\n` +
      `${JSON.stringify({ method: "turn/started", params: { threadId: "own" } })}\n`);
    assert.deepEqual(await pending, { ok: true });
    assert.equal(calls, 1);
    assert.deepEqual(notifications, ["turn/started"]);
    assert.deepEqual(await connection.request("model/list"), { ok: true });
  } finally { await connection.close(); }
});

test("retired timeout and late duplicate responses never invoke a raw callback", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "thread/read" ? null
    : { id: message.id, result: { ok: true } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let calls = 0;
  try {
    await connection.start();
    const pending = connection.request("thread/read", { threadId: "own" }, {
      timeoutMs: 5, onResponseEnvelope: () => { calls++; },
    });
    void pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 15));
    await assert.rejects(pending, AppServerUnavailableError);
    const id = child.messages.find(message => message.method === "thread/read")!.id;
    child.send({ id, result: { late: true } });
    child.send({ id, result: { duplicate: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.deepEqual(await connection.request("model/list"), { ok: true });
  } finally { await connection.close(); }
});

test("concurrent requests wait for the initialization handshake before dispatch", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? null : { id: message.id, result: { ok: true } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 5_000);
  const first = connection.request("thread/read", { threadId: "first" });
  void first.catch(() => {});
  let second: Promise<JsonObject> | undefined;
  try {
    await new Promise(resolve => setImmediate(resolve));
    second = connection.request("turn/start", { threadId: "second" }, { mutating: true });
    void second.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.map(message => message.method), ["initialize"],
      "a spawned child is not yet an initialized connection");
    child.send({ id: child.messages[0]!.id, result: {} });
    await Promise.all([first, second]);
    assert.deepEqual(child.messages.map(message => message.method),
      ["initialize", "initialized", "thread/read", "turn/start"]);
  } finally {
    await connection.close();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test("rejected initialization never dispatches a waiting mutation", async () => {
  const child = new AppServerChild();
  child.respond = () => null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 5_000);
  const first = connection.start();
  void first.catch(() => {});
  let second: Promise<JsonObject> | undefined;
  try {
    await new Promise(resolve => setImmediate(resolve));
    second = connection.request("turn/start", { threadId: "second" }, { mutating: true });
    void second.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    child.send({ id: child.messages[0]!.id, error: { code: -32600, message: "fixture init rejection" } });
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(child.messages.map(message => message.method), ["initialize"]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.ok(result.reason instanceof AppServerRejectedError);
    }
  } finally {
    await connection.close();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test("frontend attachment shares the actual initialize result and cannot mutate another receipt", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? null : { id: message.id, result: {} };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 5_000);
  const first = connection.initializedSession();
  const second = connection.initializedSession();
  void first.catch(() => {}); void second.catch(() => {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.map(message => message.method), ["initialize"]);
    const actual = { userAgent: "fixture/backend", capabilities: { fixture: ["value"] } };
    child.send({ id: child.messages[0]!.id, result: actual });
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.initializeResult, actual);
    assert.deepEqual(b.initializeResult, actual);
    assert.equal(a.generation, b.generation);
    assert.equal(connection.isSessionCurrent(a.generation), true);
    (a.initializeResult.capabilities as JsonObject).fixture = ["changed by one frontend"];
    assert.deepEqual((await connection.initializedSession()).initializeResult, actual);
    assert.deepEqual(b.initializeResult, actual);
    assert.deepEqual(child.messages.map(message => message.method), ["initialize", "initialized"]);
    await connection.close();
    assert.equal(connection.isSessionCurrent(a.generation), false);
    await assert.rejects(connection.initializedSession(), AppServerUnavailableError);
  } finally {
    await connection.close();
    await Promise.allSettled([first, second]);
  }
});

test("an initialization receipt expires before disconnect callbacks and never crosses backend generations", async () => {
  const children: AppServerChild[] = [];
  const connection = new AppServerConnection(() => {
    const child = new AppServerChild();
    const index = children.length;
    child.respond = message => message.method === "initialize"
      ? { id: message.id, result: { userAgent: `fixture/backend-${index}` } } : { id: message.id, result: {} };
    children.push(child); return child.asChild();
  });
  try {
    const first = await connection.initializedSession();
    let expiredDuringCallback = false;
    connection.onDisconnect(() => { expiredDuringCallback = !connection.isSessionCurrent(first.generation); });
    children[0]!.disconnect();
    assert.equal(expiredDuringCallback, true);
    const second = await connection.initializedSession();
    assert.notEqual(second.generation, first.generation);
    assert.deepEqual(second.initializeResult, { userAgent: "fixture/backend-1" });
    assert.equal(connection.isSessionCurrent(first.generation), false);
    assert.equal(connection.isSessionCurrent(second.generation), true);
    assert.equal(children.length, 2);
  } finally { await connection.close(); }
});

test("stale expected generation rejects a known-unwritten mutation without launching a child", async () => {
  const children: AppServerChild[] = [];
  const connection = new AppServerConnection(() => {
    const child = new AppServerChild(); children.push(child); return child.asChild();
  });
  try {
    const session = await connection.initializedSession();
    children[0]!.disconnect();
    await assert.rejects(connection.request("thread/resume", { threadId: "own" },
      { mutating: true, expectedGeneration: session.generation }), AppServerUnavailableError);
    assert.equal(children.length, 1, "a stale attachment must not launch a replacement worker");
    assert.deepEqual(children[0]!.messages.map(message => message.method), ["initialize", "initialized"]);
  } finally { await connection.close(); }
});

test("stale expected generation does not join an already-starting reconnect", async () => {
  const children: AppServerChild[] = [];
  const connection = new AppServerConnection(() => {
    const child = new AppServerChild();
    if (children.length === 1) child.respond = message => message.method === "initialize" ? null
      : { id: message.id, result: { ok: true } };
    children.push(child); return child.asChild();
  }, undefined, 5_000);
  let reconnect: Promise<void> | null = null;
  let stale: Promise<JsonObject> | null = null;
  try {
    const session = await connection.initializedSession();
    children[0]!.disconnect();
    reconnect = connection.start(); void reconnect.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(children[1]!.messages.map(message => message.method), ["initialize"]);
    stale = connection.request("thread/resume", { threadId: "own" },
      { mutating: true, expectedGeneration: session.generation });
    void stale.catch(() => {});
    let settled = false;
    void stale.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, "a stale request must reject before the new handshake completes");
    await assert.rejects(stale, AppServerUnavailableError);
    assert.deepEqual(children[1]!.messages.map(message => message.method), ["initialize"]);
  } finally {
    const second = children[1];
    if (second?.messages[0]?.method === "initialize")
      second.send({ id: second.messages[0].id, result: {} });
    await Promise.allSettled([...(reconnect ? [reconnect] : []), ...(stale ? [stale] : [])]);
    await connection.close();
  }
});

test("expected generation is rechecked after the start await before dispatch", async () => {
  const children: AppServerChild[] = [];
  const connection = new AppServerConnection(() => {
    const child = new AppServerChild(); children.push(child); return child.asChild();
  });
  const realStart = connection.start.bind(connection);
  let releaseStart!: () => void;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  let pending: Promise<JsonObject> | null = null;
  try {
    const session = await connection.initializedSession();
    connection.start = () => startGate;
    pending = connection.request("thread/resume", { threadId: "own" },
      { mutating: true, expectedGeneration: session.generation });
    void pending.catch(() => {});
    children[0]!.disconnect();
    await realStart();
    assert.equal(children.length, 2);
    releaseStart();
    await assert.rejects(pending, AppServerUnavailableError);
    assert.deepEqual(children[1]!.messages.map(message => message.method), ["initialize", "initialized"],
      "the stale mutation must not be written to the reconnected child");
  } finally {
    releaseStart(); connection.start = realStart;
    if (pending) await Promise.allSettled([pending]);
    await connection.close();
  }
});

test("requests without expected generation retain ordinary reconnect behavior", async () => {
  const children: AppServerChild[] = [];
  const connection = new AppServerConnection(() => {
    const child = new AppServerChild(); children.push(child); return child.asChild();
  });
  try {
    await connection.initializedSession();
    children[0]!.disconnect();
    assert.deepEqual(await connection.request("thread/read", { threadId: "own" }), { ok: true });
    assert.equal(children.length, 2);
    assert.deepEqual(children[1]!.messages.map(message => message.method),
      ["initialize", "initialized", "thread/read"]);
  } finally { await connection.close(); }
});

test("failed initialization does not expose a session receipt or a live generation", async () => {
  const child = new AppServerChild();
  child.respond = message => ({ id: message.id, error: { code: -32600 } });
  const connection = new AppServerConnection(() => child.asChild());
  try {
    await assert.rejects(connection.initializedSession(), AppServerRejectedError);
    assert.equal(connection.isSessionCurrent(1), false);
    assert.deepEqual(child.messages.map(message => message.method), ["initialize"]);
  } finally { await connection.close(); }
});

test("App Server assembles a large response line from bounded chunks", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 5_000);
  try {
    const response = connection.request("thread/read", { threadId: "large" });
    await new Promise(resolve => setImmediate(resolve));
    const id = child.messages.find(message => message.method === "thread/read")?.id;
    const value = "x".repeat(8 * 1024 * 1024);
    const line = `${JSON.stringify({ id, result: { value } })}\n`;
    // Small pipe reads used to make the old whole-buffer byte count quadratic.
    const startedAt = Date.now();
    for (let offset = 0; offset < line.length; offset += 1024) child.stdout.write(line.slice(offset, offset + 1024));
    assert.equal((await response).value, value);
    assert.ok(Date.now() - startedAt < 5_000, "a fragmented response must not stall the bridge event loop");
  } finally { await connection.close(); }
});

test("App Server rejects an oversized unfinished line before it consumes unbounded memory", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 5_000);
  const disconnects: Error[] = [];
  connection.onDisconnect(error => disconnects.push(error));
  try {
    await connection.start();
    const chunk = "x".repeat(1024 * 1024);
    for (let count = 0; count <= 64 && !disconnects.length; count++) child.stdout.write(chunk);
    assert.equal(disconnects.length, 1);
    assert.ok(disconnects[0] instanceof AppServerUnavailableError);
  } finally { await connection.close(); }
});

test("App Server requests are answered on the same profile connection", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  connection.onServerRequest(request => ({ answers: { choice: request.params.itemId } }));
  try {
    await connection.start();
    child.send({ id: "question-1", method: "item/tool/requestUserInput", params: { itemId: "item-1" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.at(-1), { id: "question-1", result: { answers: { choice: "item-1" } } });
  } finally { await connection.close(); }
});

test("pending server request replay invokes its handler and sends its answer only once", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  let calls = 0;
  connection.onServerRequest(request => {
    calls++;
    request.params.itemId = "handler-local-mutation";
    return answer;
  });
  try {
    await connection.start();
    child.send({ id: 0, method: "item/tool/requestUserInput", params: { threadId: "task", itemId: "question" } });
    child.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "question", threadId: "task" } });
    assert.equal(calls, 1, "resume replay is not a new question");
    release({ answers: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 0), [{ id: 0, result: { answers: {} } }]);
  } finally { release({}); await connection.close(); }
});

test("conflicting replay of a pending server request rejects once without answering from the old handler", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  let calls = 0;
  connection.onServerRequest(() => { calls++; return answer; });
  try {
    await connection.start();
    child.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "first" } });
    child.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "different" } });
    child.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "first" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    const replies = () => child.messages.filter(message => message.id === 0);
    assert.equal(replies().length, 1, "a conflicting replay receives one generic refusal");
    const refusal = replies()[0]!.error as JsonObject;
    assert.equal(refusal.code, -32600);
    assert.doesNotMatch(String(refusal.message), /first|different/u);
    assert.equal(replies()[0]!.result, undefined);
    release({ answers: { choice: "old answer" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies().length, 1, "the invalidated handler cannot answer the conflicting request");
    assert.deepEqual(await connection.request("model/list"), { ok: true }, "unrelated requests keep using the connection");
  } finally { release({}); await connection.close(); }
});

test("numeric and string server request IDs remain distinct while both are pending", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const releases: Array<(value: JsonObject) => void> = [];
  let calls = 0;
  connection.onServerRequest(() => {
    calls++;
    return new Promise<JsonObject>(resolve => { releases.push(resolve); });
  });
  try {
    await connection.start();
    child.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "same" } });
    child.send({ id: "0", method: "item/tool/requestUserInput", params: { itemId: "same" } });
    assert.equal(calls, 2);
    releases[0]!({ answers: { choice: "numeric" } });
    releases[1]!({ answers: { choice: "string" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 0), [{ id: 0, result: { answers: { choice: "numeric" } } }]);
    assert.deepEqual(child.messages.filter(message => message.id === "0"), [{ id: "0", result: { answers: { choice: "string" } } }]);
  } finally { for (const release of releases) release({}); await connection.close(); }
});

test("server request handlers receive the original typed request ID", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const seenIds: unknown[] = [];
  connection.onServerRequest(request => {
    seenIds.push("id" in request ? request.id : undefined);
    return { answers: {} };
  });
  try {
    await connection.start();
    child.send({ id: 7, method: "item/tool/requestUserInput", params: { itemId: "numeric" } });
    child.send({ id: "7", method: "item/tool/requestUserInput", params: { itemId: "string" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seenIds, [7, "7"]);
  } finally { await connection.close(); }
});

test("server request receipt waits for the handler result to be written on the live child", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, context) => { contexts.push(context); return answer; });
  try {
    await connection.start();
    child.send({ id: 11, method: "item/tool/requestUserInput", params: { itemId: "deferred" } });
    const context = contexts[0];
    assert.ok(context, "the handler receives a receipt and cancellation signal");
    assert.equal(context.signal.aborted, false);
    let settled = false;
    void context.responseWritten.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(child.messages.filter(message => message.id === 11), []);
    release({ answers: { choice: { answers: ["yes"] } } });
    await context.responseWritten;
    assert.deepEqual(child.messages.filter(message => message.id === 11), [
      { id: 11, result: { answers: { choice: { answers: ["yes"] } } } },
    ]);
    assert.equal(settled, true);
  } finally { release({}); await connection.close(); }
});

test("matching serverRequest/resolved retires the callback before observers see it", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  const contexts: AppServerServerRequestContext[] = [];
  let observerSawAborted: boolean | null = null;
  const observed: string[] = [];
  connection.onServerRequest((_request, requestContext) => {
    contexts.push(requestContext);
    void requestContext.responseWritten.catch(() => {});
    return answer;
  });
  connection.onNotification(notification => {
    observed.push(notification.method);
    if (notification.method === "serverRequest/resolved") observerSawAborted = contexts[0]?.signal.aborted ?? false;
  });
  try {
    await connection.start();
    child.send({ id: 21, method: "item/tool/requestUserInput",
      params: { threadId: "task-a", turnId: "turn-a", itemId: "item-a" } });
    const context = contexts[0];
    assert.ok(context);
    child.send({ method: "serverRequest/resolved", params: { threadId: "task-a", requestId: 21 } });
    assert.equal(observerSawAborted, true, "the pending callback is retired before raw notification delivery");
    assert.equal(context.signal.aborted, true);
    await assert.rejects(context.responseWritten);
    release({ answers: { choice: { answers: ["late"] } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observed, ["serverRequest/resolved"]);
    assert.deepEqual(child.messages.filter(message => message.id === 21), [], "no late success or error reply");
  } finally { release({}); await connection.close(); }
});

test("serverRequest/resolved does not cancel a different thread or typed request ID", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, requestContext) => { contexts.push(requestContext); return answer; });
  try {
    await connection.start();
    child.send({ id: 22, method: "item/tool/requestUserInput",
      params: { threadId: "task-a", turnId: "turn-a", itemId: "item-a" } });
    const context = contexts[0];
    assert.ok(context);
    child.send({ method: "serverRequest/resolved", params: { threadId: "task-b", requestId: 22 } });
    child.send({ method: "serverRequest/resolved", params: { threadId: "task-a", requestId: "22" } });
    assert.equal(context.signal.aborted, false);
    release({ answers: {} });
    await context.responseWritten;
    assert.deepEqual(child.messages.filter(message => message.id === 22), [{ id: 22, result: { answers: {} } }]);
  } finally { release({}); await connection.close(); }
});

test("a reused request ID after serverRequest/resolved survives the retired handler", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const contexts: AppServerServerRequestContext[] = [];
  const releases: Array<(value: JsonObject) => void> = [];
  connection.onServerRequest((_request, context) => {
    contexts.push(context);
    void context.responseWritten.catch(() => {});
    return new Promise<JsonObject>(resolve => { releases.push(resolve); });
  });
  try {
    await connection.start();
    child.send({ id: 23, method: "item/tool/requestUserInput",
      params: { threadId: "task-a", turnId: "turn-a", itemId: "old" } });
    const oldContext = contexts[0];
    assert.ok(oldContext);
    child.send({ method: "serverRequest/resolved", params: { threadId: "task-a", requestId: 23 } });
    assert.equal(oldContext.signal.aborted, true);
    await assert.rejects(oldContext.responseWritten);
    child.send({ id: 23, method: "item/tool/requestUserInput",
      params: { threadId: "task-a", turnId: "turn-b", itemId: "new" } });
    const newContext = contexts[1];
    assert.ok(newContext, "the resolved ID can be reused for a new callback");
    releases[0]!({ answers: { stale: { answers: ["old"] } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(newContext.signal.aborted, false, "old handler cleanup cannot retire the new callback");
    releases[1]!({ answers: { fresh: { answers: ["new"] } } });
    await newContext.responseWritten;
    assert.deepEqual(child.messages.filter(message => message.id === 23), [
      { id: 23, result: { answers: { fresh: { answers: ["new"] } } } },
    ]);
  } finally { for (const release of releases) release({}); await connection.close(); }
});

test("conflicting server request replay aborts and rejects the old response receipt", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, context) => {
    contexts.push(context);
    if (context) void context.responseWritten.catch(() => {});
    return answer;
  });
  try {
    await connection.start();
    child.send({ id: 12, method: "item/tool/requestUserInput", params: { itemId: "first" } });
    const context = contexts[0];
    assert.ok(context);
    child.send({ id: 12, method: "item/tool/requestUserInput", params: { itemId: "different" } });
    assert.equal(context.signal.aborted, true);
    await assert.rejects(context.responseWritten);
    release({ answers: { choice: { answers: ["stale"] } } });
    await new Promise(resolve => setImmediate(resolve));
    const replies = child.messages.filter(message => message.id === 12);
    assert.equal(replies.length, 1);
    assert.equal((replies[0]!.error as JsonObject).code, -32600);
  } finally { release({}); await connection.close(); }
});

test("disconnect aborts and rejects the pending server response receipt", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, context) => {
    contexts.push(context);
    if (context) void context.responseWritten.catch(() => {});
    return answer;
  });
  try {
    await connection.start();
    child.send({ id: 13, method: "item/tool/requestUserInput", params: { itemId: "pending" } });
    const context = contexts[0];
    assert.ok(context);
    child.disconnect();
    assert.equal(context.signal.aborted, true);
    await assert.rejects(context.responseWritten);
    release({ answers: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 13), []);
  } finally { release({}); await connection.close(); }
});

test("abort-listener reconnect waits until the previous child is closed", { timeout: 2_000 }, async () => {
  const first = new AppServerChild();
  const second = new AppServerChild();
  let launches = 0;
  let oldStdinEndedAtSecondLaunch = false;
  const connection = new AppServerConnection(() => {
    if (launches++ === 0) return first.asChild();
    oldStdinEndedAtSecondLaunch = first.stdin.writableEnded;
    return second.asChild();
  }, undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  let reentrant: Promise<JsonObject> | null = null;
  connection.onServerRequest((_request, context) => {
    void context.responseWritten.catch(() => {});
    context.signal.addEventListener("abort", () => { reentrant = connection.request("model/list"); }, { once: true });
    return answer;
  });
  try {
    await connection.start();
    first.send({ id: 18, method: "item/tool/requestUserInput", params: { itemId: "pending" } });
    first.disconnect();
    assert.ok(reentrant, "the abort listener starts recovery immediately");
    assert.deepEqual(await reentrant, { ok: true });
    assert.equal(oldStdinEndedAtSecondLaunch, true, "old child stdin must be closed before launching a new child");
  } finally { release({}); await connection.close(); }
});

test("explicit close aborts and rejects a pending server response receipt", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, context) => {
    contexts.push(context);
    void context.responseWritten.catch(() => {});
    return answer;
  });
  try {
    await connection.start();
    child.send({ id: 15, method: "item/tool/requestUserInput", params: { itemId: "pending" } });
    const context = contexts[0];
    assert.ok(context);
    await connection.close();
    assert.equal(context.signal.aborted, true);
    await assert.rejects(context.responseWritten);
    release({ answers: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 15), []);
  } finally { release({}); await connection.close(); }
});

test("a synchronous result write failure cannot resolve the server response receipt", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, context) => {
    contexts.push(context);
    void context.responseWritten.catch(() => {});
    return { answers: {} };
  });
  try {
    await connection.start();
    const write = child.stdin.write.bind(child.stdin);
    Object.defineProperty(child.stdin, "write", { configurable: true, value: (chunk: string) => {
      if (chunk.includes('"id":16,"result"')) throw new Error("fixture result write failure");
      return write(chunk);
    } });
    child.send({ id: 16, method: "item/tool/requestUserInput", params: { itemId: "write-failure" } });
    await new Promise(resolve => setImmediate(resolve));
    const context = contexts[0];
    assert.ok(context);
    assert.equal(context.signal.aborted, true);
    await assert.rejects(context.responseWritten);
    assert.deepEqual(child.messages.filter(message => message.id === 16), []);
  } finally { await connection.close(); }
});

test("ended child stdin cannot count as a written server response", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let release!: (value: JsonObject) => void;
  const answer = new Promise<JsonObject>(resolve => { release = resolve; });
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, context) => {
    contexts.push(context);
    void context.responseWritten.catch(() => {});
    return answer;
  });
  child.stdin.on("error", () => { /* A write-after-end fixture error is expected. */ });
  try {
    await connection.start();
    child.send({ id: 17, method: "item/tool/requestUserInput", params: { itemId: "ended-stdin" } });
    const context = contexts[0];
    assert.ok(context);
    child.stdin.end();
    assert.equal(child.stdin.writableEnded, true);
    release({ answers: {} });
    await assert.rejects(context.responseWritten);
    assert.equal(context.signal.aborted, true);
    assert.deepEqual(child.messages.filter(message => message.id === 17), []);
  } finally { release({}); await connection.close(); }
});

test("handler failure rejects its response receipt even when a generic error reply is written", { timeout: 2_000 }, async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((_request, context) => {
    contexts.push(context);
    if (context) void context.responseWritten.catch(() => {});
    throw new Error("private handler detail");
  });
  try {
    await connection.start();
    child.send({ id: 14, method: "item/tool/requestUserInput", params: { itemId: "failure" } });
    await new Promise(resolve => setImmediate(resolve));
    const context = contexts[0];
    assert.ok(context);
    await assert.rejects(context.responseWritten);
    const replies = child.messages.filter(message => message.id === 14);
    assert.equal(replies.length, 1);
    assert.equal((replies[0]!.error as JsonObject).code, -32000);
  } finally { await connection.close(); }
});

test("a previous child handler cannot answer or retire a reused server request ID", async () => {
  const first = new AppServerChild(); const second = new AppServerChild();
  const children = [first, second];
  const connection = new AppServerConnection(() => children.shift()!.asChild(), undefined, 100);
  let releaseOld!: (value: JsonObject) => void; let releaseNew!: (value: JsonObject) => void;
  const oldAnswer = new Promise<JsonObject>(resolve => { releaseOld = resolve; });
  const newAnswer = new Promise<JsonObject>(resolve => { releaseNew = resolve; });
  let calls = 0;
  connection.onServerRequest(request => { calls++; return request.params.itemId === "old" ? oldAnswer : newAnswer; });
  try {
    await connection.start();
    first.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "old" } });
    assert.equal(calls, 1);
    first.disconnect();
    assert.deepEqual(await connection.request("model/list"), { ok: true });
    second.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "new" } });
    assert.equal(calls, 2, "ID reuse on a new child is a fresh request");
    releaseOld({ answers: { choice: "stale" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(second.messages.filter(message => message.id === 0), [], "old handler cannot reply into the new child");
    second.send({ id: 0, method: "item/tool/requestUserInput", params: { itemId: "new" } });
    assert.equal(calls, 2, "old handler completion cannot retire the new pending request");
    releaseNew({ answers: { choice: "fresh" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(second.messages.filter(message => message.id === 0), [{ id: 0, result: { answers: { choice: "fresh" } } }]);
    assert.deepEqual(first.messages.filter(message => message.id === 0), []);
  } finally { releaseOld({}); releaseNew({}); await connection.close(); }
});

test("known App Server rejections remain rejected without exposing server text", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} }
    : { id: message.id, error: { code: 409, message: "PRIVATE SERVER DETAIL" } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  try {
    await assert.rejects(connection.request("turn/start", {}, { mutating: true }), error =>
      error instanceof AppServerRejectedError && error.code === 409 && !error.message.includes("PRIVATE"));
  } finally { await connection.close(); }
});

test("active-writer rejection is classified without exposing the task identity", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} }
    : { id: message.id, error: { code: -32600, message: "thread private-id already has an active writer" } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  try {
    await assert.rejects(connection.request("thread/resume", { threadId: "private-id" }), error =>
      error instanceof AppServerRejectedError && error.reason === "active-writer" && !error.message.includes("private-id"));
  } finally { await connection.close(); }
});

test("disconnect classifies reads as unavailable and dispatched mutations as uncertain, then reconnects", async () => {
  const first = new AppServerChild(); first.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const second = new AppServerChild();
  const children = [first, second];
  const connection = new AppServerConnection(() => children.shift()!.asChild(), undefined, 100);
  try {
    await connection.start();
    const read = connection.request("thread/read", { threadId: "task" });
    const mutation = connection.request("turn/start", { threadId: "task" }, { mutating: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.messages.filter(message => message.method === "turn/start").length, 1);
    first.disconnect();
    await assert.rejects(read, AppServerUnavailableError);
    await assert.rejects(mutation, AppServerUncertainError);
    assert.deepEqual(await connection.request("thread/read", { threadId: "task" }), { ok: true });
    assert.equal(second.messages.filter(message => message.method === "initialize").length, 1);
  } finally { await connection.close(); }
});

test("a timed-out mutation is never replayed when the profile connection recovers", async () => {
  const first = new AppServerChild(); first.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const second = new AppServerChild();
  const children = [first, second];
  const connection = new AppServerConnection(() => children.shift()!.asChild(), undefined, 20);
  // The fake child has no process handle; production request timers are unref'ed.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(connection.request("turn/start", { threadId: "task" }, { mutating: true }), AppServerUncertainError);
    assert.equal(first.messages.filter(message => message.method === "turn/start").length, 1);
    first.disconnect();
    assert.deepEqual(await connection.request("thread/read", { threadId: "task" }), { ok: true });
    assert.equal(second.messages.some(message => message.method === "turn/start"), false);
  } finally { clearInterval(keepAlive); await connection.close(); }
});

test("a timed-out mutation preserves the writer, pending reads and late turn notifications", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const keepAlive = setInterval(() => {}, 1_000);
  const disconnects: Error[] = []; const notifications: string[] = [];
  connection.onDisconnect(error => disconnects.push(error));
  connection.onNotification(event => notifications.push(event.method));
  try {
    await connection.start();
    const read = connection.request("thread/read", { threadId: "other-task" });
    // Attach a rejection handler immediately: the old implementation aborts
    // this unrelated request when the mutation's response times out.
    const readResult = read.then(value => ({ value }), error => ({ error }));
    await assert.rejects(connection.request("turn/start", { threadId: "task" },
      { mutating: true, timeoutMs: 20 }), AppServerUncertainError);
    assert.equal(disconnects.length, 0);
    const mutationId = child.messages.find(message => message.method === "turn/start")?.id;
    const readId = child.messages.find(message => message.method === "thread/read")?.id;
    child.send({ id: mutationId, result: { turn: { id: "accepted-late" } } });
    child.send({ method: "turn/started", params: { threadId: "task", turn: { id: "accepted-late" } } });
    child.send({ id: readId, result: { thread: { id: "other-task" } } });
    assert.deepEqual(await readResult, { value: { thread: { id: "other-task" } } });
    assert.deepEqual(notifications, ["turn/started"]);
    assert.equal(child.messages.filter(message => message.method === "turn/start").length, 1);
    child.respond = message => ({ id: message.id, result: { ok: true } });
    assert.deepEqual(await connection.request("model/list"), { ok: true });
    assert.equal(child.messages.filter(message => message.method === "initialize").length, 1);
  } finally { clearInterval(keepAlive); await connection.close(); }
});

test("a timed-out read does not disconnect unrelated profile work", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} }
    : message.method === "thread/read" ? null : { id: message.id, result: { ok: true } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 20);
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(connection.request("thread/read", { threadId: "slow" }), AppServerUnavailableError);
    assert.deepEqual(await connection.request("model/list"), { ok: true });
    assert.equal(child.messages.filter(message => message.method === "initialize").length, 1);
  } finally { clearInterval(keepAlive); await connection.close(); }
});
