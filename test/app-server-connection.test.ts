import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AppServerConnection, AppServerFrontendResponseError, AppServerRejectedError, AppServerUnavailableError, AppServerUncertainError } from "../src/codex/app-server-connection.js";
import type { AppServerRpc, AppServerServerRequest, AppServerServerRequestContext } from "../src/codex/app-server-connection.js";
import { AppServerRequestInbox } from "../src/codex/app-server-request-inbox.js";
import { LegacyExecutionLifecycle } from "../src/codex/legacy-execution-lifecycle.js";
import { AppServerTaskStateTransport } from "../src/codex/app-server-task-state.js";
import { AppServerProfileOwner } from "../src/codex/app-server-profile-owner.js";
import { ActionRejectedError } from "../src/core/codex-tasks.js";
import { diagnosticScope, withDiagnosticSink } from "../src/bridge/diagnostics.js";
import type { DiagnosticRecord } from "../src/bridge/diagnostics.js";

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

test("late exact resume ACK permits orphan cleanup after the original stream timed out", async () => {
  const child = new AppServerChild();
  let runtimeStatus: "active" | "idle" = "active";
  child.respond = message => {
    if (message.method === "initialize") return { id: message.id, result: { serverInfo: { name: "fixture" } } };
    if (message.method === "thread/resume") return null;
    if (message.method === "thread/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/read") return { id: message.id, result: { thread: { id: "own", status: { type: runtimeStatus } } } };
    if (message.method === "thread/goal/get") return { id: message.id, result: { goal: null } };
    if (message.method === "thread/queue/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/unsubscribe") return { id: message.id, result: { status: "unsubscribed" } };
    return null;
  };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const lifecycle = new LegacyExecutionLifecycle(connection);
  const task = { hostId: "local", threadId: "own", sourceId: "work" };
  let releases = 0;
  const transport = new AppServerTaskStateTransport(lifecycle.rpc, () => [], () => { releases++; }, () => {},
    ref => lifecycle.rpc.request("thread/resume", { threadId: ref.threadId, excludeTurns: true,
      initialTurnsPage: { limit: 20, sortDirection: "desc", itemsView: "full" } }, { timeoutMs: 15 }));
  const stream = transport.subscribe(task, () => assert.fail("timed-out stream must not project a late ACK"), () => {});
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(stream.start(), AppServerUncertainError);
    stream.close();
    assert.equal(releases, 1);
    assert.equal(child.messages.filter(message => message.method === "thread/resume").length, 1);
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
    await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "own" }, { timeoutMs: 15 }), ActionRejectedError);
    const resumeId = child.messages.find(message => message.method === "thread/resume")?.id;
    child.send({ id: resumeId, result: { thread: { id: "own", status: { type: "idle" } },
      initialTurnsPage: { data: [], nextCursor: null }, cwd: "D:\\fixture", model: "gpt", reasoningEffort: "high" } });
    child.send({ id: resumeId, result: { thread: { id: "own", status: { type: "idle" } } } });
    assert.equal(await lifecycle.drain(task, () => {}, () => ({ activeTurnId: null, blocked: false }),
      () => transport.subscriptionSnapshot(task)), "blocked");
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
    await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "own" }, { timeoutMs: 15 }), ActionRejectedError);
    runtimeStatus = "idle";
    const status = await lifecycle.drain(task, () => {}, () => ({ activeTurnId: null, blocked: false }),
      () => transport.subscriptionSnapshot(task));
    assert.equal(status, "waiting-unload");
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 1);
    assert.equal(child.messages.filter(message => message.method === "thread/resume").length, 1);
    child.send({ method: "thread/closed", params: { threadId: "own" } });
    assert.equal(await lifecycle.drain(task, () => {}, () => ({ activeTurnId: null, blocked: false }),
      () => transport.subscriptionSnapshot(task)), "released");
  } finally { clearInterval(keepAlive); stream.close(); transport.close(); lifecycle.close(); await connection.close(); }
});

test("profile owner retires its timed-out stream and drains only its late acquired writer", async () => {
  const child = new AppServerChild();
  child.respond = message => {
    if (message.method === "initialize") return { id: message.id, result: {} };
    if (message.method === "thread/resume") return null;
    if (message.method === "thread/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/read") return { id: message.id, result: { thread: { id: "own", status: { type: "idle" } } } };
    if (message.method === "thread/goal/get") return { id: message.id, result: { goal: null } };
    if (message.method === "thread/queue/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/unsubscribe") return { id: message.id, result: { status: "unsubscribed" } };
    return null;
  };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const rpc: AppServerRpc = {
    start: () => connection.start(), currentInitializedSession: () => connection.currentInitializedSession(),
    request: (method, params, options) => connection.request(method, params,
      method === "thread/resume" ? { ...options, timeoutMs: 15 } : options),
    onNotification: listener => connection.onNotification(listener),
    onDisconnect: listener => connection.onDisconnect(listener),
    onServerRequest: handler => connection.onServerRequest(handler), close: () => connection.close(),
  };
  const owner = new AppServerProfileOwner("work", rpc);
  const task = { hostId: "local", threadId: "own", sourceId: "work" };
  const stream = owner.states.subscribe(task, () => assert.fail("retired stream cannot project late ACK"), () => {});
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(stream.start());
    stream.close();
    assert.equal(owner.pendingLegacyAcquisition(task), null);
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
    const resumeId = child.messages.find(message => message.method === "thread/resume")?.id;
    child.send({ id: resumeId, result: { thread: { id: "own", status: { type: "idle" } },
      initialTurnsPage: { data: [], nextCursor: null } } });
    assert.equal(typeof owner.pendingLegacyAcquisition(task), "symbol");
    assert.equal(await owner.drainIdleExecution(task, () => {}), "waiting-unload");
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 1);
    assert.equal(child.messages.filter(message => message.method === "thread/resume").length, 1);
    child.send({ method: "thread/closed", params: { threadId: "own" } });
    assert.equal(await owner.drainIdleExecution(task, () => assert.fail("no second release")), "released");
  } finally { clearInterval(keepAlive); stream.close(); await owner.close(); }
});

test("normal profile owner drain still writes one unsubscribe after its stream closes", async () => {
  const child = new AppServerChild();
  child.respond = message => {
    if (message.method === "initialize") return { id: message.id, result: {} };
    if (message.method === "thread/resume") return { id: message.id, result: { thread: {
      id: "own", status: { type: "idle" } }, initialTurnsPage: { data: [], nextCursor: null } } };
    if (message.method === "thread/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/read") return { id: message.id, result: { thread: { id: "own", status: { type: "idle" } } } };
    if (message.method === "thread/goal/get") return { id: message.id, result: { goal: null } };
    if (message.method === "thread/queue/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/unsubscribe") return { id: message.id, result: { status: "unsubscribed" } };
    return null;
  };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const owner = new AppServerProfileOwner("work", connection);
  const task = { hostId: "local", threadId: "own", sourceId: "work" };
  const stream = owner.states.subscribe(task, () => {}, () => {});
  try {
    await stream.start();
    assert.equal(await owner.drainIdleExecution(task, () => stream.close()), "waiting-unload");
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 1);
  } finally { stream.close(); await owner.close(); }
});

test("a child acquisition ticket blocks the parent family proof before and after its late ACK", async () => {
  const child = new AppServerChild();
  child.respond = message => {
    if (message.method === "initialize") return { id: message.id, result: {} };
    if (message.method === "thread/resume") return (message.params as JsonObject).threadId === "root"
      ? { id: message.id, result: { thread: { id: "root", status: { type: "idle" } } } } : null;
    if (message.method === "thread/list") return { id: message.id, result: { data: [{ id: "child" }], nextCursor: null } };
    if (message.method === "thread/read") return { id: message.id, result: { thread: {
      id: (message.params as JsonObject).threadId, status: { type: "idle" } } } };
    if (message.method === "thread/goal/get") return { id: message.id, result: { goal: null } };
    if (message.method === "thread/queue/list") return { id: message.id, result: { data: [], nextCursor: null } };
    return null;
  };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const lifecycle = new LegacyExecutionLifecycle(connection);
  const root = { hostId: "local", threadId: "root", sourceId: "work" };
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await lifecycle.rpc.request("thread/resume", { threadId: "root" }, { timeoutMs: 20 });
    await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "child" }, { timeoutMs: 10 }),
      AppServerUncertainError);
    const drain = () => lifecycle.drain(root, () => assert.fail("child ticket cannot release parent"),
      () => ({ activeTurnId: null, blocked: false }), () => ({ count: 1, revision: 1 }));
    assert.equal(await drain(), "blocked");
    const childId = child.messages.find(message => message.method === "thread/resume"
      && (message.params as JsonObject).threadId === "child")?.id;
    child.send({ id: childId, result: { thread: { id: "child", status: { type: "idle" } } } });
    assert.equal(await drain(), "blocked");
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
  } finally { clearInterval(keepAlive); lifecycle.close(); await connection.close(); }
});

test("late acquisition proof cannot clear a separate uncertain queued write", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const lifecycle = new LegacyExecutionLifecycle(connection);
  const task = { hostId: "local", threadId: "own", sourceId: "work" };
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(lifecycle.rpc.request("thread/queue/add", { threadId: "own", clientUserMessageId: "operation" },
      { mutating: true, timeoutMs: 10 }), AppServerUncertainError);
    await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "own" }, { timeoutMs: 10 }),
      AppServerUncertainError);
    const resumeId = child.messages.find(message => message.method === "thread/resume")?.id;
    child.send({ id: resumeId, result: { thread: { id: "own", status: { type: "idle" } } } });
    assert.equal(typeof lifecycle.pendingLegacyAcquisition(task), "symbol");
    assert.equal(await lifecycle.drain(task, () => assert.fail("queued uncertainty cannot be cleared by resume"),
      () => ({ activeTurnId: null, blocked: false }), () => ({ count: 0, revision: 0 })), "blocked");
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
  } finally { clearInterval(keepAlive); lifecycle.close(); await connection.close(); }
});

test("binding scope is rechecked at the unsubscribe wire after an asynchronous boundary", async () => {
  const child = new AppServerChild();
  child.respond = message => {
    if (message.method === "initialize") return { id: message.id, result: {} };
    if (message.method === "thread/resume") return { id: message.id, result: { thread: { id: "own", status: { type: "idle" } } } };
    if (message.method === "thread/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/read") return { id: message.id, result: { thread: { id: "own", status: { type: "idle" } } } };
    if (message.method === "thread/goal/get") return { id: message.id, result: { goal: null } };
    if (message.method === "thread/queue/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "thread/unsubscribe") return { id: message.id, result: { status: "unsubscribed" } };
    return null;
  };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const lifecycle = new LegacyExecutionLifecycle(connection);
  const task = { hostId: "local", threadId: "own", sourceId: "work" };
  try {
    await lifecycle.rpc.request("thread/resume", { threadId: "own" });
    let count = 1; let scopeCurrent = true;
    const status = await lifecycle.drain(task, () => {
      count = 0;
      queueMicrotask(() => { scopeCurrent = false; });
      void lifecycle.rpc.request("thread/unsubscribe", { threadId: "own" }).catch(() => {});
    }, () => ({ activeTurnId: null, blocked: false }), () => ({ count, revision: count ? 1 : 2 }),
    () => { if (!scopeCurrent) throw new ActionRejectedError("binding changed"); });
    assert.equal(status, "unavailable");
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
  } finally { lifecycle.close(); await connection.close(); }
});

test("late resume receipts cannot promote wrong, malformed, rejected or disconnected acquisitions", async t => {
  for (const kind of ["wrong-thread", "malformed-status", "malformed-status-array", "rejected", "disconnected"] as const)
    await t.test(kind, async () => {
      const child = new AppServerChild();
      child.respond = message => message.method === "initialize"
        ? { id: message.id, result: { serverInfo: { name: "fixture" } } } : null;
      let launches = 0;
      const connection = new AppServerConnection(() => { launches++; return child.asChild(); }, undefined, 1_000);
      const lifecycle = new LegacyExecutionLifecycle(connection);
      const task = { hostId: "local", threadId: "own", sourceId: "work" };
      const keepAlive = setInterval(() => {}, 1_000);
      try {
        await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "own" }, { timeoutMs: 10 }),
          AppServerUncertainError);
        const resumeId = child.messages.find(message => message.method === "thread/resume")?.id;
        if (kind === "disconnected") child.disconnect();
        else if (kind === "rejected") child.send({ id: resumeId, error: { code: 409, message: "rejected" } });
        else child.send({ id: resumeId, result: { thread: {
          id: kind === "wrong-thread" ? "other" : "own",
          status: kind === "wrong-thread" ? { type: "idle" }
            : kind === "malformed-status-array" ? { type: ["idle"] } : {},
        } } });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(lifecycle.pendingLegacyAcquisition(task), null);
        if (kind === "malformed-status-array") assert.equal(lifecycle.legacyAcquisitionState(task), "unknown");
        assert.equal(await lifecycle.drain(task, () => assert.fail("invalid receipt cannot release"),
          () => ({ activeTurnId: null, blocked: false }), () => ({ count: 0, revision: 0 })),
        kind === "rejected" ? "unavailable" : "blocked");
        assert.equal(launches, 1);
        assert.equal(child.messages.filter(message => message.method === "thread/resume").length, 1);
        assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
      } finally { clearInterval(keepAlive); lifecycle.close(); await connection.close(); }
    });
});

test("normal resume ACK with array status cannot clear its acquisition fence", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} }
    : message.method === "thread/resume" ? { id: message.id, result: {
      thread: { id: "own", status: { type: ["idle"] } } } } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const lifecycle = new LegacyExecutionLifecycle(connection);
  const task = { hostId: "local", threadId: "own", sourceId: "work" };
  try {
    await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "own" }), AppServerUnavailableError);
    assert.equal(lifecycle.legacyAcquisitionState(task), "unknown");
    await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "own" }), ActionRejectedError);
    assert.equal(child.messages.filter(message => message.method === "thread/resume").length, 1);
    assert.equal(child.messages.filter(message => message.method === "thread/unsubscribe").length, 0);
  } finally { lifecycle.close(); await connection.close(); }
});

test("cold pinned resume never launches an owner for any expected generation", async t => {
  for (const expectedGeneration of [1, 0, 999]) await t.test(String(expectedGeneration), async () => {
    const child = new AppServerChild(); let launches = 0;
    const connection = new AppServerConnection(() => { launches++; return child.asChild(); }, undefined, 100);
    const lifecycle = new LegacyExecutionLifecycle(connection);
    try {
      await assert.rejects(lifecycle.rpc.request("thread/resume", { threadId: "own" },
        { expectedGeneration, timeoutMs: 10 }), AppServerUnavailableError);
      assert.equal(launches, 0);
      assert.deepEqual(child.messages, []);
    } finally { lifecycle.close(); await connection.close(); }
  });
});

test("a pending acquisition blocks another writer RPC at the actual wire", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} }
    : message.method === "thread/resume" ? null : { id: message.id, result: {} };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const lifecycle = new LegacyExecutionLifecycle(connection);
  try {
    const resume = lifecycle.rpc.request("thread/resume", { threadId: "own" }, { timeoutMs: 1_000 });
    while (!child.messages.some(message => message.method === "thread/resume"))
      await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(lifecycle.rpc.request("turn/start", { threadId: "own" },
      { mutating: true, timeoutMs: 10 }), ActionRejectedError);
    assert.equal(child.messages.filter(message => message.method === "turn/start").length, 0);
    const resumeId = child.messages.find(message => message.method === "thread/resume")?.id;
    child.send({ id: resumeId, result: { thread: { id: "own", status: { type: "idle" } } } });
    assert.equal(((await resume).thread as JsonObject).id, "own");
    assert.equal(child.messages.filter(message => message.method === "thread/resume").length, 1);
  } finally { lifecycle.close(); await connection.close(); }
});

test("request inbox keeps worker questions across frontend detach and fences typed replies", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  const inbox = new AppServerRequestInbox({
    threadId: "own", generation: session.generation,
    isGenerationCurrent: generation => connection.isSessionCurrent(generation),
    allowRequest: request => request.method === "item/tool/requestUserInput",
    allowAnswer: (_request, result) => result.answers !== undefined,
  });
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  const firstFrames: JsonObject[] = [];
  const first = inbox.attach(frame => firstFrames.push(frame));
  try {
    child.send({ id: 17, method: "item/tool/requestUserInput", params: { threadId: "own", questions: [] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstFrames.length, 1);
    first.detach();
    assert.equal(child.messages.filter(message => message.id === 17).length, 0,
      "frontend EOF cannot answer the worker");
    const secondFrames: JsonObject[] = [];
    const second = inbox.attach(frame => secondFrames.push(frame));
    assert.deepEqual(secondFrames, firstFrames);
    assert.equal(first.answer(17, { answers: {} }), false);
    assert.equal(second.answer("17", { answers: {} }), false);
    assert.equal(second.answer(17, { rejected: true }), false);
    assert.equal(second.answer(17, { answers: {} }), true);
    assert.equal(second.answer(17, { answers: {} }), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(child.messages.filter(message => message.id === 17 && message.result !== undefined).length, 1);
    assert.equal(child.messages.filter(message => message.method === "initialize").length, 1);
  } finally { await connection.close(); }
});

test("request inbox retires externally resolved questions without frontend answer", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  const inbox = new AppServerRequestInbox({
    threadId: "own", generation: session.generation,
    isGenerationCurrent: generation => connection.isSessionCurrent(generation),
    allowRequest: () => true, allowAnswer: () => true,
  });
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  try {
    child.send({ id: "17", method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    child.send({ method: "serverRequest/resolved", params: { threadId: "own", requestId: "17" } });
    await new Promise(resolve => setImmediate(resolve));
    const frames: JsonObject[] = [];
    const attachment = inbox.attach(frame => frames.push(frame));
    assert.deepEqual(frames, []);
    assert.equal(attachment.answer("17", {}), false);
    assert.equal(child.messages.filter(message => message.id === "17" && message.result !== undefined).length, 0);
  } finally { await connection.close(); }
});

test("request inbox policies cannot mutate request identity or answer through reentry", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  let detach: (() => void) | null = null;
  const inbox = new AppServerRequestInbox({
    threadId: "own", generation: session.generation,
    isGenerationCurrent: generation => connection.isSessionCurrent(generation),
    allowRequest: request => { request.params.threadId = "other"; return true; },
    allowAnswer: (_request, result) => { result.answer = "mutated"; detach?.(); return true; },
  });
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  const frames: JsonObject[] = [];
  const attached = inbox.attach(frame => frames.push(frame));
  detach = attached.detach;
  try {
    child.send({ id: 23, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 1);
    assert.equal((frames[0]!.params as JsonObject).threadId, "own");
    assert.equal(attached.answer(23, { answer: "original" }), false,
      "policy reentry invalidates the old attachment");
    const next = inbox.attach(() => {});
    assert.equal(next.answer(23, { answer: "original" }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 23 && message.result !== undefined)
      .map(message => message.result), [{ answer: "original" }]);
  } finally { await connection.close(); }
});

test("request inbox snapshots owner settings and shields accepted answer from policy mutation", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  const options = {
    threadId: "own", generation: session.generation,
    isGenerationCurrent: (generation: number) => connection.isSessionCurrent(generation),
    allowRequest: () => true,
    allowAnswer: (_request: AppServerServerRequest, result: JsonObject) => { result.answer = "changed"; return true; },
  };
  const inbox = new AppServerRequestInbox(options);
  options.threadId = "other";
  options.generation = session.generation + 1;
  assert.deepEqual(inbox.owner, { threadId: "own", generation: session.generation });
  assert.equal(Object.isFrozen(inbox.owner), true);
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  const attached = inbox.attach(() => {});
  try {
    child.send({ id: 25, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attached.answer(25, { answer: "original" }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 25 && message.result !== undefined)
      .map(message => message.result), [{ answer: "original" }]);
  } finally { await connection.close(); }
});

test("request inbox retains pending request after an uncloneable answer", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  const inbox = new AppServerRequestInbox({
    threadId: "own", generation: session.generation,
    isGenerationCurrent: generation => connection.isSessionCurrent(generation),
    allowRequest: () => true, allowAnswer: () => true,
  });
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  const attached = inbox.attach(() => {});
  try {
    child.send({ id: 24, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attached.answer(24, { bad: () => 1 }), false);
    assert.equal(attached.answer(24, { bad: 1n }), false);
    assert.equal(attached.answer(24, { bad: new Date("2026-09-27T00:00:00Z") }), false);
    assert.equal(attached.answer(24, { bad: new Map([["key", "value"]]) }), false);
    assert.equal(attached.answer(24, { answer: "valid" }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 24 && message.result !== undefined)
      .map(message => message.result), [{ answer: "valid" }]);
  } finally { await connection.close(); }
});

test("request inbox stops an old replay loop when a writer reattaches", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  const inbox = new AppServerRequestInbox({
    threadId: "own", generation: session.generation,
    isGenerationCurrent: generation => connection.isSessionCurrent(generation),
    allowRequest: () => true, allowAnswer: () => true,
  });
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  try {
    child.send({ id: 31, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    child.send({ id: 32, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    const old: number[] = []; const current: number[] = [];
    inbox.attach(frame => {
      old.push(frame.id as number);
      inbox.attach(next => current.push(next.id as number));
    });
    assert.deepEqual(old, [31]);
    assert.deepEqual(current, [31, 32]);
  } finally { await connection.close(); }
});

test("request inbox keeps typed pending IDs when frontend delivery throws", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  const inbox = new AppServerRequestInbox({
    threadId: "own", generation: session.generation,
    isGenerationCurrent: generation => connection.isSessionCurrent(generation),
    allowRequest: () => true, allowAnswer: () => true, maxPending: 2,
  });
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  inbox.attach(() => { throw new Error("frontend disconnected"); });
  try {
    child.send({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    child.send({ id: "7", method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(child.messages.filter(message => message.id === 7 || message.id === "7").length, 0);
    const frames: JsonObject[] = [];
    const attached = inbox.attach(frame => frames.push(frame));
    assert.deepEqual(frames.map(frame => frame.id), [7, "7"]);
    assert.equal(attached.answer(7, { typed: "number" }), true);
    assert.equal(attached.answer("7", { typed: "string" }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 7 || message.id === "7")
      .map(message => [message.id, message.result]),
    [[7, { typed: "number" }], ["7", { typed: "string" }]]);
    assert.equal(child.messages.filter(message => message.method === "initialize").length, 1);
  } finally { await connection.close(); }
});

test("inbox rejects only with explicit error policy and preserves pending after invalid denial", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  const options = {
    threadId: "own", generation: session.generation,
    isGenerationCurrent: (generation: number) => connection.isSessionCurrent(generation),
    allowRequest: () => true, allowAnswer: () => true,
  };
  const inbox = new AppServerRequestInbox(options);
  options.threadId = "other";
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  const attached = inbox.attach(() => {});
  try {
    child.send({ id: 51, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attached.reject(51, { code: 4100, message: "denied" }), false);
    assert.equal(attached.answer(51, { answers: {} }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 51).map(message => message.result), [{ answers: {} }]);
  } finally { await connection.close(); }
});

test("inbox explicit negative reply fences epoch, typed ID, policy reentry and answer race", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const session = await connection.initializedSession();
  let detachOnPolicy = false;
  let currentDetach: (() => void) | null = null;
  const inbox = new AppServerRequestInbox({
    threadId: "own", generation: session.generation,
    isGenerationCurrent: generation => connection.isSessionCurrent(generation),
    allowRequest: () => true, allowAnswer: () => true,
    allowError: (_request, error) => {
      if (detachOnPolicy) currentDetach?.();
      return error.code === 4101;
    },
  });
  connection.onServerRequest((request, context) => inbox.handle(request, context));
  const old = inbox.attach(() => {});
  try {
    child.send({ id: 52, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    const current = inbox.attach(() => {});
    currentDetach = current.detach;
    assert.equal(old.reject(52, { code: 4101, message: "denied" }), false);
    assert.equal(current.reject("52", { code: 4101, message: "denied" }), false);
    assert.equal(current.reject(52, { code: 1.5, message: "bad" }), false);
    assert.equal(current.reject(52, { code: 4101, message: "bad", data: new Date() }), false);
    detachOnPolicy = true;
    assert.equal(current.reject(52, { code: 4101, message: "denied" }), false);
    detachOnPolicy = false;
    const final = inbox.attach(() => {});
    assert.equal(final.reject(52, { code: 4101, message: "denied", data: { reason: "native" } }), true);
    assert.equal(final.answer(52, { answers: {} }), false);
    assert.equal(final.reject(52, { code: 4101, message: "duplicate" }), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.messages.filter(message => message.id === 52).map(message => message.error),
      [{ code: 4101, message: "denied", data: { reason: "native" } }]);
  } finally { await connection.close(); }
});

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

test("account model rejection retains only a fixed reason and actual backend generation", async () => {
  const detail = "The 'private-model' model is not supported when using Codex with a ChatGPT account.";
  for (const native of [
    { message: detail }, { message: JSON.stringify({ detail }) },
    { message: "Request failed", data: { detail, token: "PRIVATE_SECRET" } },
    { message: "A different unsupported model error", data: { detail: "not supported" } },
  ]) {
    const child = new AppServerChild();
    child.respond = message => message.method === "turn/start"
      ? { id: message.id, error: { code: -32600, ...native } }
      : { id: message.id, result: { ok: true } };
    const connection = new AppServerConnection(() => child.asChild());
    try {
      await assert.rejects(connection.request("turn/start", { threadId: "own" }, { mutating: true }), error => {
        assert.ok(error instanceof AppServerRejectedError);
        assert.equal(error.reason, native.message.startsWith("A different") ? null : "model-not-supported-for-account");
        assert.equal(Reflect.get(error, "backendGeneration"), 1);
        assert.equal(Reflect.get(error, "requestMethod"), "turn/start");
        assert.doesNotMatch(JSON.stringify(error) + error.message, /private-model|PRIVATE_SECRET|Request failed/u);
        return true;
      });
    } finally { await connection.close(); }
  }
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

test("current initialized session is a synchronous non-starting live snapshot", async () => {
  const children: AppServerChild[] = [];
  const connection = new AppServerConnection(() => {
    const child = new AppServerChild(); children.push(child); return child.asChild();
  });
  const readCurrent = (): { generation: number; initializeResult: JsonObject } | null =>
    (connection as unknown as { currentInitializedSession?: () => { generation: number; initializeResult: JsonObject } | null })
      .currentInitializedSession?.() ?? null;
  try {
    assert.equal(readCurrent(), null);
    assert.equal(children.length, 0, "a cold snapshot read must not launch the App Server");

    const first = await connection.initializedSession();
    assert.deepEqual(readCurrent(), first, "the synchronous accessor must reflect the completed handshake");
    const observed = readCurrent();
    assert.ok(observed);
    observed.initializeResult.serverInfo = { name: "caller mutation" };
    assert.deepEqual(readCurrent(), first, "returned snapshots must not mutate the live handshake receipt");

    children[0]!.disconnect();
    assert.equal(readCurrent(), null, "a disconnected generation must not remain visible");
    await connection.start();
    const second = await connection.initializedSession();
    assert.ok(second.generation > first.generation);
    assert.deepEqual(readCurrent(), second);
    assert.equal(connection.isSessionCurrent(first.generation), false);

    await connection.close();
    assert.equal(readCurrent(), null, "a stopped connection must not expose its previous session");
    assert.equal(children.length, 2);
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

test("explicit frontend errors preserve exact typed IDs and validated native error data", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const original = { code: 4102, message: "frontend denied", data: { reason: "user choice" } };
  const branded = new AppServerFrontendResponseError(original);
  original.data.reason = "mutated";
  const exposed = branded.wireError;
  (exposed.data as JsonObject).reason = "also mutated";
  const contexts: AppServerServerRequestContext[] = [];
  connection.onServerRequest((request, context) => { contexts.push(context); throw request.id === 41 ? branded
    : new AppServerFrontendResponseError({ code: 4103, message: "string id", data: null }); });
  try {
    await connection.start();
    child.send({ id: 41, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    child.send({ id: "41", method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(contexts.length, 2);
    await Promise.all(contexts.map(context => context.responseWritten));
    assert.deepEqual(child.messages.filter(message => message.id === 41 || message.id === "41")
      .map(message => [message.id, message.error]), [
        [41, { code: 4102, message: "frontend denied", data: { reason: "user choice" } }],
        ["41", { code: 4103, message: "string id", data: null }],
      ]);
  } finally { await connection.close(); }
});

test("invalid frontend error payload is rejected before it can reach the worker", () => {
  for (const payload of [
    { code: 1.5, message: "bad" }, { code: 1, message: 7 },
    { code: 1, message: "bad", extra: true },
    { code: 1, message: "bad", data: new Date() },
    { code: 1, message: "bad", data: new Map([["x", 1]]) },
    { code: 1, message: "bad", data: 1n },
  ]) assert.throws(() => new AppServerFrontendResponseError(payload as never));
});

test("externally resolved or stale frontend error cannot write a late negative reply", async () => {
  const first = new AppServerChild(); const second = new AppServerChild();
  const children = [first, second];
  const connection = new AppServerConnection(() => children.shift()!.asChild(), undefined, 100);
  const rejectors: Array<(error: Error) => void> = [];
  connection.onServerRequest(() => new Promise<JsonObject>((_resolve, reject) => { rejectors.push(reject); }));
  try {
    await connection.start();
    first.send({ id: 42, method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    first.send({ method: "serverRequest/resolved", params: { threadId: "own", requestId: 42 } });
    rejectors[0]!(new AppServerFrontendResponseError({ code: 4104, message: "too late" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(first.messages.filter(message => message.id === 42), []);
    first.send({ id: "43", method: "item/tool/requestUserInput", params: { threadId: "own" } });
    await new Promise(resolve => setImmediate(resolve));
    first.disconnect();
    await connection.start();
    rejectors[1]!(new AppServerFrontendResponseError({ code: 4105, message: "old generation" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(second.messages.filter(message => message.id === "43"), []);
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

test("opt-in late mutation receipt is once, cloned, and precedes later notifications", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const keepAlive = setInterval(() => {}, 1_000);
  const order: string[] = []; const late: JsonObject[] = [];
  let ordinary = 0;
  try {
    const session = await connection.initializedSession();
    connection.onNotification(() => order.push("notification"));
    await assert.rejects(connection.request("turn/start", { threadId: "own" }, {
      mutating: true, expectedGeneration: session.generation, timeoutMs: 10,
      onResponseEnvelope: () => ordinary++,
      onLateResponseEnvelope: envelope => { order.push("late"); late.push(envelope as JsonObject); },
    }), AppServerUncertainError);
    const id = child.messages.find(message => message.method === "turn/start")?.id;
    const response = { id, result: { turn: { id: "accepted" } } };
    child.send(response);
    child.send({ method: "turn/started", params: { threadId: "own" } });
    child.send(response);
    assert.deepEqual(order, ["late", "notification"]);
    assert.deepEqual(late, [{ result: { turn: { id: "accepted" } } }]);
    assert.equal(ordinary, 0);
    (late[0]!.result as JsonObject).turn = "changed";
    assert.deepEqual(response.result, { turn: { id: "accepted" } });
    assert.equal(connection.isSessionCurrent(session.generation), true);
    assert.equal(child.messages.filter(message => message.method === "turn/start").length, 1);
  } finally { clearInterval(keepAlive); await connection.close(); }
});

test("late callback needs mutating and explicit current generation; malformed answer retires it", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const keepAlive = setInterval(() => {}, 1_000);
  const late: JsonObject[] = []; let ordinary = 0;
  try {
    const session = await connection.initializedSession();
    const options = [
      { mutating: true, timeoutMs: 10, onLateResponseEnvelope: (value: JsonObject) => late.push(value) },
      { mutating: false, expectedGeneration: session.generation, timeoutMs: 10,
        onLateResponseEnvelope: (value: JsonObject) => late.push(value) },
      { mutating: true, expectedGeneration: session.generation, timeoutMs: 10,
        onResponseEnvelope: () => ordinary++, onLateResponseEnvelope: (value: JsonObject) => late.push(value) },
      { mutating: true, expectedGeneration: session.generation, timeoutMs: 10,
        onResponseEnvelope: () => ordinary++ },
    ];
    for (const option of options) await assert.rejects(connection.request("turn/start", {}, option));
    const ids = child.messages.filter(message => message.method === "turn/start").map(message => message.id);
    child.send({ id: ids[0], result: { ok: true } });
    child.send({ id: ids[1], result: { ok: true } });
    child.send({ id: ids[2], result: { ok: true }, error: { code: 1, message: "ambiguous" } });
    child.send({ id: ids[2], result: { ok: true } });
    child.send({ id: ids[3], result: { ok: true } });
    assert.deepEqual(late, []);
    assert.equal(ordinary, 0);
  } finally { clearInterval(keepAlive); await connection.close(); }
});

test("late receipt callback throw is isolated and generation loss clears tombstones", async () => {
  const first = new AppServerChild(); first.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const second = new AppServerChild();
  const children = [first, second];
  const connection = new AppServerConnection(() => children.shift()!.asChild(), undefined, 1_000);
  const keepAlive = setInterval(() => {}, 1_000);
  let calls = 0;
  try {
    const session = await connection.initializedSession();
    await assert.rejects(connection.request("turn/start", {}, { mutating: true,
      expectedGeneration: session.generation, timeoutMs: 10,
      onLateResponseEnvelope: () => { calls++; throw new Error("observer failure"); } }), AppServerUncertainError);
    const firstId = first.messages.find(message => message.method === "turn/start")?.id;
    first.send({ id: firstId, error: { code: 409, message: "rejected" } });
    assert.equal(calls, 1);
    await assert.rejects(connection.request("turn/start", {}, { mutating: true,
      expectedGeneration: session.generation, timeoutMs: 10,
      onLateResponseEnvelope: () => calls++ }), AppServerUncertainError);
    const secondId = first.messages.filter(message => message.method === "turn/start")[1]?.id;
    first.disconnect();
    await connection.start();
    first.send({ id: secondId, result: { ok: true } });
    second.send({ id: secondId, result: { ok: true } });
    assert.equal(calls, 1);
    second.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
    const current = await connection.initializedSession();
    await assert.rejects(connection.request("turn/start", {}, { mutating: true,
      expectedGeneration: current.generation, timeoutMs: 10,
      onLateResponseEnvelope: () => calls++ }), AppServerUncertainError);
    const closeId = second.messages.find(message => message.method === "turn/start")?.id;
    await connection.close();
    second.send({ id: closeId, result: { ok: true } });
    assert.equal(calls, 1);
    assert.equal(second.messages.filter(message => message.method === "turn/start").length, 1);
  } finally { clearInterval(keepAlive); await connection.close(); }
});

test("late receipt tombstones evict oldest at a bounded capacity", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 1_000);
  const keepAlive = setInterval(() => {}, 1_000);
  const observed: number[] = [];
  try {
    const session = await connection.initializedSession();
    await Promise.all(Array.from({ length: 129 }, (_, index) =>
      assert.rejects(connection.request("turn/start", {}, { mutating: true,
        expectedGeneration: session.generation, timeoutMs: 10,
        onLateResponseEnvelope: () => observed.push(index) }), AppServerUncertainError)));
    const ids = child.messages.filter(message => message.method === "turn/start").map(message => message.id);
    assert.equal(ids.length, 129);
    child.send({ id: ids[0], result: { ok: true } });
    child.send({ id: ids[128], result: { ok: true } });
    assert.deepEqual(observed, [128]);
    assert.equal(connection.isSessionCurrent(session.generation), true);
  } finally { clearInterval(keepAlive); await connection.close(); }
});

test("final before-write guard rejects only this request after authority revocation", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  try {
    const session = await connection.initializedSession();
    let checks = 0;
    let authorized = true;
    const rejected = connection.request("turn/start", {}, {
      mutating: true, expectedGeneration: session.generation,
      assertBeforeWrite: () => { checks++; if (!authorized) throw new Error("authority-revoked"); },
    });
    authorized = false;
    await assert.rejects(rejected, /authority-revoked/);
    assert.equal(checks, 1);
    assert.equal(child.messages.some(message => message.method === "turn/start"), false);
    assert.equal(connection.isSessionCurrent(session.generation), true);
    assert.deepEqual(await connection.request("thread/read", { threadId: "own" }), { ok: true });
  } finally { await connection.close(); }
});

test("final guard refusal callback fires once before RPC allocation and preserves guard error", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  try {
    const session = await connection.initializedSession();
    let refusals = 0;
    const denied = new Error('scoped-lease-revoked');
    await assert.rejects(connection.request('turn/start', {}, {
      mutating: true, expectedGeneration: session.generation,
      assertBeforeWrite: () => { throw denied; },
      onBeforeWriteRefused: () => { refusals++; throw new Error('callback-isolated'); },
    }), error => error === denied);
    assert.equal(refusals, 1);
    assert.equal(child.messages.some(message => message.method === 'turn/start'), false);
    assert.equal(connection.isSessionCurrent(session.generation), true);
  } finally { await connection.close(); }
});

test("before-write guard reentrant close cannot dispatch onto the old child", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  try {
    const session = await connection.initializedSession();
    let closing!: Promise<void>;
    await assert.rejects(connection.request("turn/start", {}, {
      mutating: true, expectedGeneration: session.generation,
      assertBeforeWrite: () => { closing = connection.close(); },
    }), AppServerUnavailableError);
    await closing;
    assert.equal(child.messages.some(message => message.method === "turn/start"), false);
  } finally { await connection.close(); }
});

test("ambiguous live mutation response cannot become a definitive error receipt", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} }
    : { id: message.id, result: { accepted: true }, error: { code: 409, message: "denied" } };
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  let ordinary = 0;
  try {
    const session = await connection.initializedSession();
    await assert.rejects(connection.request("turn/start", {}, { mutating: true,
      expectedGeneration: session.generation, onResponseEnvelope: () => ordinary++ }), AppServerUncertainError);
    assert.equal(ordinary, 0);
    assert.equal(connection.isSessionCurrent(session.generation), true);
  } finally { await connection.close(); }
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

test('actual-write guard encloses only synchronous stdin write and preserves the ACK', async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const order: string[] = [];
  try {
    const session = await connection.initializedSession();
    child.stdin.on('data', () => order.push('write'));
    await connection.request('turn/start', {}, { mutating: true, expectedGeneration: session.generation,
      withWriteGuard: write => { order.push('enter'); write(); order.push('leave'); },
      onResponseEnvelope: () => order.push('ack'),
    });
    assert.deepEqual(order, ['enter', 'write', 'leave', 'ack']);
  } finally { await connection.close(); }
});

test('actual-write guard refuses absent or async callbacks without retiring the writer', async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  try {
    const session = await connection.initializedSession();
    let refusals = 0;
    for (const withWriteGuard of [() => {}, async (write: () => void) => { await Promise.resolve(); write(); },
      (write: () => void) => { queueMicrotask(write); }]) {
      await assert.rejects(connection.request('turn/start', {}, {
        mutating: true, expectedGeneration: session.generation, withWriteGuard,
        onBeforeWriteRefused: () => { refusals++; },
      }));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refusals, 3);
    assert.equal(child.messages.some(message => message.method === 'turn/start'), false);
    assert.equal(connection.isSessionCurrent(session.generation), true);
    assert.deepEqual(await connection.request('model/list'), { ok: true });
  } finally { await connection.close(); }
});

test('synchronous wire ACK stays ordered after actual-write transaction release', async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const order: string[] = [];
  try {
    const session = await connection.initializedSession();
    child.respond = () => null;
    child.stdin.on('data', () => {
      const frame = child.messages.at(-1)!;
      child.send({ id: frame.id, result: { turn: { id: 'sync-ack' } } });
      child.send({ method: 'turn/started', params: { threadId: 'own' } });
    });
    connection.onNotification(() => order.push('notification'));
    await connection.request('turn/start', {}, { mutating: true, expectedGeneration: session.generation,
      withWriteGuard: write => { order.push('enter'); write(); order.push('release'); },
      onResponseEnvelope: () => order.push('ack'),
    });
    assert.deepEqual(order, ['enter', 'release', 'ack', 'notification']);
  } finally { await connection.close(); }
});

test('duplicate callback or post-write guard failure is uncertain, writes once and keeps late ACK', async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === 'initialize' ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  try {
    const session = await connection.initializedSession();
    let refusals = 0, receipts = 0;
    for (const withWriteGuard of [(write: () => void) => { write(); write(); },
      (write: () => void) => { write(); throw new Error('commit ambiguous'); }]) {
      await assert.rejects(connection.request('turn/start', {}, {
        mutating: true, expectedGeneration: session.generation, withWriteGuard,
        onBeforeWriteRefused: () => { refusals++; },
        onLateResponseEnvelope: () => { receipts++; },
      }), AppServerUncertainError);
      const id = child.messages.filter(message => message.method === 'turn/start').at(-1)!.id;
      child.send({ id, result: { turn: { id: 'late' } } });
    }
    assert.equal(refusals, 0);
    assert.equal(receipts, 2);
    assert.equal(child.messages.filter(message => message.method === 'turn/start').length, 2);
    assert.equal(connection.isSessionCurrent(session.generation), true);
  } finally { await connection.close(); }
});

test("RPC diagnostics retain initiating scope across rejection, timeout and late receipt without payloads", async () => {
  const child = new AppServerChild();
  child.respond = message => message.method === "initialize" ? { id: message.id, result: {} } : null;
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const keepAlive = setInterval(() => {}, 1_000);
  const records: DiagnosticRecord[] = [];
  const sink = (record: DiagnosticRecord) => { records.push(record); };
  try {
    const session = await connection.initializedSession();
    const rejectedAttempt = "00000000-0000-4000-8000-000000000001";
    const rejected = withDiagnosticSink(sink, () => diagnosticScope({ attemptId: rejectedAttempt }, () =>
      connection.request("turn/start", { secret: "RPC-PARAM-SECRET" }, {
        mutating: true, expectedGeneration: session.generation,
      })));
    await new Promise(resolve => setImmediate(resolve));
    const rejectedId = child.messages.find(message => message.method === "turn/start")?.id as number;
    child.send({ id: rejectedId, error: { code: 409, message: "RPC-ERROR-SECRET" } });
    await assert.rejects(rejected, AppServerRejectedError);
    const rejectedStages = records.filter(record => record.attemptId === rejectedAttempt);
    assert.deepEqual(rejectedStages.map(record => record.stage),
      ["start", "before-write", "write-attempt", "write-returned", "response"]);
    assert.ok(rejectedStages.every(record => record.connectionId === rejectedStages[0]?.connectionId &&
      record.backendGeneration === session.generation && record.method === "turn/start" && record.mutating === true));
    assert.ok(rejectedStages.slice(2).every(record => record.requestId === rejectedId));
    assert.equal(rejectedStages.at(-1)?.outcome, "failure");

    const timedOutAttempt = "00000000-0000-4000-8000-000000000002";
    let receipts = 0;
    const timedOut = withDiagnosticSink(sink, () => diagnosticScope({ attemptId: timedOutAttempt }, () =>
      connection.request("turn/start", { secret: "RPC-TIMEOUT-SECRET" }, {
        mutating: true, expectedGeneration: session.generation, timeoutMs: 10,
        onLateResponseEnvelope: () => { receipts++; },
      })));
    await new Promise(resolve => setImmediate(resolve));
    const timedOutId = child.messages.filter(message => message.method === "turn/start").at(-1)?.id as number;
    await assert.rejects(timedOut, AppServerUncertainError);
    child.send({ id: timedOutId, result: { secret: "RPC-RESULT-SECRET" } });
    assert.equal(receipts, 1);
    const timedOutStages = records.filter(record => record.attemptId === timedOutAttempt);
    assert.ok(timedOutStages.slice(2).every(record => record.requestId === timedOutId));
    assert.deepEqual(timedOutStages.map(record => record.stage),
      ["start", "before-write", "write-attempt", "write-returned", "timeout", "late-response"]);
    assert.ok(timedOutStages.every(record => record.attemptId === timedOutAttempt));
    assert.equal(timedOutStages.find(record => record.stage === "timeout")?.outcome, "unknown");
    assert.equal(timedOutStages.find(record => record.stage === "late-response")?.outcome, "success");
    assert.doesNotMatch(JSON.stringify(records), /RPC-(?:PARAM|ERROR|TIMEOUT|RESULT)-SECRET/u);
  } finally { clearInterval(keepAlive); await connection.close(); }
});

test("RPC diagnostics report actual-write refusal only after the guard exits", async () => {
  const child = new AppServerChild();
  const connection = new AppServerConnection(() => child.asChild(), undefined, 100);
  const records: DiagnosticRecord[] = [];
  let insideGuard = false;
  let diagnosticInsideGuard = false;
  try {
    const session = await connection.initializedSession();
    const denied = new Error("RPC-GUARD-SECRET");
    await assert.rejects(withDiagnosticSink(record => {
      if (insideGuard) diagnosticInsideGuard = true;
      records.push(record);
    }, () => diagnosticScope({ attemptId: "00000000-0000-4000-8000-000000000003" }, () =>
      connection.request("turn/start", { secret: "RPC-PARAM-SECRET" }, {
        mutating: true, expectedGeneration: session.generation,
        withWriteGuard: () => { insideGuard = true; try { throw denied; } finally { insideGuard = false; } },
      }))), error => error === denied);
    assert.equal(diagnosticInsideGuard, false);
    assert.equal(child.messages.some(message => message.method === "turn/start"), false);
    assert.deepEqual(records.map(record => record.stage), ["start", "before-write", "guard-refused"]);
    assert.equal(records.at(-1)?.requestId, 2);
    assert.equal(records.at(-1)?.outcome, "failure");
    assert.doesNotMatch(JSON.stringify(records), /RPC-(?:GUARD|PARAM)-SECRET/u);
    records.length = 0;
    await withDiagnosticSink(record => {
      if (insideGuard) diagnosticInsideGuard = true;
      records.push(record);
    }, () => connection.request("turn/start", {}, {
      mutating: true, expectedGeneration: session.generation,
      withWriteGuard: write => { insideGuard = true; try { write(); } finally { insideGuard = false; } },
    }));
    assert.equal(diagnosticInsideGuard, false);
    assert.deepEqual(records.map(record => record.stage),
      ["start", "before-write", "write-attempt", "write-returned", "response"]);
    records.length = 0;
    await assert.rejects(withDiagnosticSink(record => {
      if (insideGuard) diagnosticInsideGuard = true;
      records.push(record);
    }, () => connection.request("turn/start", {}, {
      mutating: true, expectedGeneration: session.generation,
      withWriteGuard: write => {
        insideGuard = true;
        try { write(); child.disconnect(); } finally { insideGuard = false; }
      },
    })), AppServerUncertainError);
    assert.equal(diagnosticInsideGuard, false);
    assert.ok(records.some(record => record.stage === "disconnect" && record.outcome === "unknown"));
  } finally { await connection.close(); }
});
