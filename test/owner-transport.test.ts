import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { OwnerTransport, OwnerTransportError, type OwnerReceiptTrace } from "../src/desktop/owner-transport.js";
import { archiveThroughOwner, inspectThroughOwner, serveOwnerChannel } from "../src/desktop/owner-channel.js";
import { ProfileDesktopMetadata, unownedArchiveReady } from "../src/desktop/metadata.js";
import { UncertainActionError } from "../src/desktop/contracts.js";
import { createOwnerReceiptTraceSink, ownerEnvironment, resolveOwnerExecutable } from "../src/desktop/owner-launcher.js";
import { comparablePath } from "../src/desktop/paths.js";

test("an unowned archive retry requires an unloaded task and terminal latest turn", () => {
  const read = { thread: { id: "source", status: { type: "notLoaded" } } };
  const turns = { data: [{ id: "last-turn", status: "completed" }] };
  assert.equal(unownedArchiveReady(read, turns, "source"), true);
  assert.equal(unownedArchiveReady(read, { data: [{ id: "last-turn", status: "inProgress" }] }, "source"), false);
  assert.equal(unownedArchiveReady({ thread: { id: "other", status: { type: "notLoaded" } } }, turns, "source"), false);
  assert.equal(unownedArchiveReady({ thread: { id: "source", status: { type: "active" } } }, turns, "source"), false);
  assert.equal(unownedArchiveReady(read, { data: [] }, "source"), false);
});

test("owner launcher follows the installed extension registry and rejects ambiguous or escaped locations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-version-"));
  const extensionRegistry = path.join(root, "extensions.json");
  const location = "openai.chatgpt-2.0.0-win32-x64";
  const directory = path.join(root, location);
  const executable = path.join(directory, "bin", "windows-x86_64", "codex.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture");
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ publisher: "openai", name: "chatgpt", version: "2.0.0" }));
  const entry = { identifier: { id: "openai.chatgpt" }, version: "2.0.0", relativeLocation: location };
  const config = { nativeExecutable: path.join(root, "old", "bin", "windows-x86_64", "codex.exe"), extensionRegistry };
  await writeFile(extensionRegistry, JSON.stringify([entry]));
  assert.equal(await resolveOwnerExecutable(config), executable);
  await writeFile(extensionRegistry, JSON.stringify([entry, entry]));
  await assert.rejects(resolveOwnerExecutable(config));
  await writeFile(extensionRegistry, JSON.stringify([{ ...entry, relativeLocation: "../outside" }]));
  await assert.rejects(resolveOwnerExecutable(config));
  await writeFile(extensionRegistry, JSON.stringify([{ ...entry, version: "3.0.0" }]));
  await assert.rejects(resolveOwnerExecutable(config));
});

const threadId = "11111111-1111-4111-8111-111111111111";
test("owner launcher preserves native IDE authentication and integration environment without VK secrets", () => {
  assert.deepEqual(ownerEnvironment({ CODEX_HOME: "wrong", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "vscode", VSCODE_IPC_HOOK_CLI: "hook", OPENAI_API_KEY: "fixture-native-key", VK_GROUP_TOKEN: "fixture-vk-key", VKODEX_RUN_ID: "run", BOT_DATA_DIR: "bridge" }, "selected"), {
    CODEX_HOME: "selected", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "vscode", VSCODE_IPC_HOOK_CLI: "hook", OPENAI_API_KEY: "fixture-native-key",
  });
});
type Message = Record<string, any>;
function fixture(overrides: Record<string, (m: Message) => unknown> = {}, timeout = 1000,
  onReceiptTrace?: (event: Readonly<OwnerReceiptTrace>) => void) {
  const nativeInput = new PassThrough(), nativeOutput = new PassThrough(), clientInput = new PassThrough(), clientOutput = new PassThrough();
  const requests: Message[] = [], received: Message[] = [];
  const write = (stream: PassThrough, m: Message) => stream.write(JSON.stringify(m) + "\n");
  const listen = (stream: PassThrough, fn: (m: Message) => void) => {
    let buffer = ""; stream.setEncoding("utf8"); stream.on("data", (chunk: string) => {
      buffer += chunk; let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); fn(JSON.parse(line)); }
    });
  };
  const transport = new OwnerTransport(nativeInput, nativeOutput, clientInput, clientOutput, timeout, onReceiptTrace);
  listen(clientOutput, m => received.push(m));
  listen(nativeInput, m => {
    requests.push(m);
    if (!m.method || m.id === undefined) return;
    const result = overrides[m.method] ? overrides[m.method]!(m) : ({
      initialize: {}, "thread/loaded/list": { data: [threadId] },
      "thread/read": { thread: { id: threadId, status: { type: "idle" } } },
      "thread/goal/get": { goal: null }, "thread/list": { data: [], nextCursor: null }, "thread/archive": {},
    } as Record<string, unknown>)[m.method];
    if (result !== undefined) write(nativeOutput, { id: m.id, result });
  });
  return { transport, nativeInput, nativeOutput, clientInput, received, requests,
    initialize() { write(clientInput, { id: 1, method: "initialize", params: {} }); write(clientInput, { method: "initialized" }); },
    send(m: Message) { write(clientInput, m); }, native(m: Message) { write(nativeOutput, m); } };
}

test("receipt trace correlates native writes and user items without payload or RPC IDs", () => {
  const trace: Readonly<OwnerReceiptTrace>[] = [];
  const userId = "33333333-3333-4333-8333-333333333333";
  const turnId = "44444444-4444-4444-8444-444444444444";
  const itemId = "55555555-5555-4555-8555-555555555555";
  const f = fixture({ "turn/start": () => ({ turn: { id: turnId }, secret: "RESPONSE_PRIVATE" }) },
    1000, event => trace.push(event));
  f.initialize();
  f.send({ id: "PRIVATE_RPC_ID", method: "turn/start", params: { threadId,
    clientUserMessageId: userId, input: [{ type: "text", text: "PROMPT_PRIVATE" }] } });
  f.native({ method: "item/completed", params: { threadId, turnId,
    item: { type: "userMessage", id: itemId, clientId: userId,
      content: [{ type: "text", text: "PROMPT_PRIVATE" }] } } });
  const dispatch = trace.find(e => e.phase === "request-observed")!;
  const reply = trace.find(e => e.phase === "frontend-write-buffered")!;
  const receipt = trace.find(e => e.phase === "native-user-message-observed")!;
  assert.equal(dispatch.method, "turn/start");
  assert.equal(dispatch.threadId, threadId);
  assert.equal(dispatch.clientUserMessageId, userId);
  assert.equal(reply.requestSequence, dispatch.requestSequence);
  assert.equal(reply.turnId, turnId);
  assert.equal(reply.outcome, "success");
  assert.equal(receipt.clientUserMessageId, userId);
  assert.equal(receipt.itemId, itemId);
  assert.equal(receipt.turnId, turnId);
  assert.equal(receipt.nativeMethod, "item/completed");
  assert.ok(reply.elapsedMs! >= 0);
  assert.equal(trace.some(e => e.phase === "backend-write-buffered"), true);
  assert.equal(trace.some(e => e.phase === "native-response-observed"), true);
  assert.equal(trace.some(e => e.phase === "frontend-user-message-buffered" && e.itemId === itemId), true);
  assert.ok(trace.every(e => e.transportInstance === dispatch.transportInstance));
  assert.deepEqual(trace.map(e => e.eventSequence), trace.map((_, index) => index + 1));
  assert.ok(trace.every(e => Object.isFrozen(e)));
  const metadata = JSON.stringify(trace);
  for (const privateValue of ["PROMPT_PRIVATE", "RESPONSE_PRIVATE", "PRIVATE_RPC_ID"])
    assert.equal(metadata.includes(privateValue), false);
  assert.equal(f.received.find(m => m.id === "PRIVATE_RPC_ID")?.result.secret, "RESPONSE_PRIVATE");
  f.transport.close();
});

test("receipt trace failure and non-UUID metadata never alter native forwarding", () => {
  const events: Readonly<OwnerReceiptTrace>[] = [];
  const f = fixture({ "turn/start": () => ({ turn: { id: "PRIVATE_TURN_ID" } }) },
    1000, event => { events.push(event); throw new Error("diagnostic sink failed"); });
  f.initialize();
  f.send({ id: 3, method: "turn/start", params: { threadId: "PRIVATE_THREAD_ID",
    clientUserMessageId: "PRIVATE_CLIENT_ID", input: [{ type: "text", text: "PRIVATE_INPUT" }] } });
  assert.equal(f.received.at(-1)?.id, 3);
  assert.equal(f.received.at(-1)?.result.turn.id, "PRIVATE_TURN_ID");
  assert.equal(f.requests.at(-1)?.params.clientUserMessageId, "PRIVATE_CLIENT_ID");
  assert.ok(events.length > 0);
  assert.equal(JSON.stringify(events).includes("PRIVATE_"), false);
  f.transport.close();
});

test("receipt trace distinguishes an active-writer rejection without exposing error text", () => {
  const trace: Readonly<OwnerReceiptTrace>[] = [];
  const f = fixture({ "thread/resume": m => {
    f.native({ id: m.id, error: { code: -32600,
      message: "PRIVATE_LOCATION thread already has an active writer PRIVATE_INPUT" } });
    return undefined;
  } }, 1000, event => trace.push(event));
  f.initialize(); f.send({ id: 7, method: "thread/resume", params: { threadId } });
  const rejected = trace.find(e => e.phase === "frontend-write-buffered")!;
  assert.equal(rejected.outcome, "error");
  assert.equal(rejected.errorCode, -32600);
  assert.equal(rejected.errorCategory, "active-writer-conflict");
  assert.equal(JSON.stringify(trace).includes("PRIVATE_"), false);
  assert.equal(f.received.at(-1)?.error.code, -32600);
  f.transport.close();
});

test("receipt trace stderr sink is disabled by default and bounded without blocking transport", () => {
  const trace: Readonly<OwnerReceiptTrace>[] = [];
  const f = fixture({}, 1000, event => trace.push(event));
  f.send({ id: 8, method: "thread/read", params: { threadId } });
  const lines: string[] = [];
  const output = { writableLength: 0, on: () => undefined,
    write: (line: string) => { lines.push(line); return true; } };
  assert.equal(createOwnerReceiptTraceSink(false, output), undefined);
  const sink = createOwnerReceiptTraceSink(true, output)!;
  output.writableLength = 256 * 1024;
  sink(trace[0]!);
  assert.equal(lines.length, 0);
  output.writableLength = 0;
  sink(trace[0]!);
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]!.slice("VKodex receipt trace ".length));
  assert.equal(event.sinkDroppedEvents, 1);
  assert.equal(event.threadId, threadId);
  assert.equal(event.pid, process.pid);
  const throwingSink = createOwnerReceiptTraceSink(true, { writableLength: 0, on: () => undefined,
    write: () => { throw new Error("PRIVATE_LOG_FAILURE"); } })!;
  assert.doesNotThrow(() => throwingSink(trace[0]!));
  f.transport.close();
});

test("receipt trace contains asynchronous stderr failure and disables further writes", async () => {
  const events: Readonly<OwnerReceiptTrace>[] = [];
  const f = fixture({}, 1000, event => events.push(event));
  f.send({ id: 4, method: "thread/read", params: { threadId } });
  let writes = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) {
    writes++;
    setImmediate(() => callback(new Error("PRIVATE_ASYNC_ERROR")));
  } });
  const sink = createOwnerReceiptTraceSink(true, output)!;
  sink(events[0]!);
  await new Promise<void>(resolve => setImmediate(resolve));
  sink(events[0]!);
  assert.equal(writes, 1);
  assert.equal(f.received.at(-1)?.id, 4);
  f.transport.close();
});

test("receipt trace capture ends with unresolved metadata and caps long-running streams", () => {
  const trace: Readonly<OwnerReceiptTrace>[] = [];
  const f = fixture({ "turn/start": () => undefined }, 1000, event => trace.push(event));
  f.send({ id: 1, method: "turn/start", params: { threadId } });
  for (let i = 0; i < 10_005; i++) f.native({ method: "item/completed", params: { threadId,
    item: { type: "userMessage", id: "55555555-5555-4555-8555-555555555555" } } });
  assert.equal(f.received.length, 10_005);
  assert.equal(trace.length, 10_000);
  f.transport.close();
  assert.equal(trace.length, 10_001);
  assert.equal(trace.at(-1)?.phase, "capture-ended");
  assert.equal(trace.at(-1)?.unresolvedRequests, 1);
  assert.equal(trace.at(-1)?.droppedEvents, 10_005 * 2 + 2 - 10_000);
});

test("receipt trace preserves receipt-before-ACK and typed IDs under protocol backpressure", async () => {
  const nativeInput = new PassThrough(), nativeOutput = new PassThrough(), clientInput = new PassThrough();
  const received: Message[] = [], trace: Readonly<OwnerReceiptTrace>[] = [];
  let releaseWrite: (() => void) | undefined;
  const clientOutput = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    received.push(JSON.parse(chunk.toString()));
    releaseWrite = () => { releaseWrite = undefined; done(); };
  } });
  const transport = new OwnerTransport(nativeInput, nativeOutput, clientInput, clientOutput, 1000,
    event => trace.push(event));
  const requests: Message[] = [];
  nativeInput.setEncoding("utf8");
  nativeInput.on("data", (line: string) => requests.push(JSON.parse(line)));
  const userId = "33333333-3333-4333-8333-333333333333";
  const receipt = { method: "item/completed", params: { threadId,
    item: { type: "userMessage", id: "55555555-5555-4555-8555-555555555555", clientId: userId,
      content: [{ type: "text", text: "PRIVATE_INPUT" }] } } };
  clientInput.write(JSON.stringify({ id: 0, method: "turn/start", params: { threadId, clientUserMessageId: userId } }) + "\n");
  clientInput.write(JSON.stringify({ id: "0", method: "thread/queue/add", params: { threadId } }) + "\n");
  nativeOutput.write(JSON.stringify(receipt) + "\n");
  assert.equal(nativeOutput.isPaused(), true);
  nativeOutput.write(JSON.stringify({ id: requests[1]!.id, result: { id: "PRIVATE_STOCK_ID" } }) + "\n");
  nativeOutput.write(JSON.stringify({ id: requests[0]!.id, result: { turn: { id: "PRIVATE_TURN_ID" } } }) + "\n");
  for (let i = 0; i < 3; i++) {
    assert.ok(releaseWrite);
    releaseWrite();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.deepEqual(received, [receipt, { id: "0", result: { id: "PRIVATE_STOCK_ID" } },
    { id: 0, result: { turn: { id: "PRIVATE_TURN_ID" } } }]);
  assert.equal(trace.filter(e => e.phase === "frontend-write-buffered").length, 2);
  assert.ok(trace.findIndex(e => e.phase === "native-user-message-observed")
    < trace.findIndex(e => e.phase === "native-response-observed"));
  assert.equal(JSON.stringify(trace).includes("PRIVATE_"), false);
  transport.close();
});

test("VS Code readiness is confirmed by a native response without initialized notification", async () => {
  const f = fixture();
  f.send({ id: 1, method: "initialize", params: {} });
  await assert.rejects(f.transport.ownsTask(threadId));
  f.send({ id: 2, method: "thread/read", params: { threadId } });
  assert.equal(await f.transport.ownsTask(threadId), true);
  await f.transport.archiveIdle(threadId);
  assert.equal(f.requests.filter(r => r.method === "initialize").length, 1);
  assert.equal(f.requests.some(r => r.method === "initialized"), false);
  f.transport.close();
});

test("owner inspection reads an already loaded task without resuming or mutating it", async () => {
  const f = fixture(); f.initialize();
  assert.equal(await f.transport.inspectTask(threadId), "idle");
  assert.deepEqual(f.requests.filter(request => request.method === "thread/read").map(request => request.params),
    [{ threadId, includeTurns: false }]);
  assert.equal(f.requests.some(request => request.method === "thread/resume" || request.method === "turn/start"), false);
  f.transport.close();
});

test("owner archive shares initialization, isolates IDs and preserves native notifications and approvals", async () => {
  const f = fixture(); f.initialize();
  f.send({ id: 1, method: "thread/read", params: { threadId } });
  await f.transport.archiveIdle(threadId);
  assert.equal(f.requests.filter(r => r.method === "initialize").length, 1);
  assert.equal(new Set(f.requests.filter(r => r.id).map(r => r.id)).size, f.requests.filter(r => r.id).length);
  assert.deepEqual(f.received.map(r => r.id), [1, 1]);
  f.native({ method: "thread/archived", params: { threadId } });
  f.native({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
  f.send({ id: "approval-1", result: { decision: "accept" } });
  assert.equal(f.received.at(-2)?.method, "thread/archived");
  assert.equal(f.received.at(-1)?.id, "approval-1");
  assert.deepEqual(f.requests.at(-1), { id: "approval-1", result: { decision: "accept" } });
  f.transport.close();
});

test("owner archive accepts a terminal system error but still rejects an active task", async () => {
  const failed = fixture({ "thread/read": () => ({ thread: { id: threadId, status: { type: "systemError" } } }) });
  failed.initialize(); await failed.transport.archiveIdle(threadId);
  assert.equal(failed.requests.filter(request => request.method === "thread/archive").length, 1);
  failed.transport.close();

  const active = fixture({ "thread/read": () => ({ thread: { id: threadId, status: { type: "active" } } }) });
  active.initialize(); await assert.rejects(active.transport.archiveIdle(threadId));
  assert.equal(active.requests.some(request => request.method === "thread/archive"), false);
  active.transport.close();
});

test("owner archive rejects uninitialized, unloaded, running, active-goal and descendant tasks", async () => {
  const uninitialized = fixture(); await assert.rejects(uninitialized.transport.archiveIdle(threadId)); uninitialized.transport.close();
  for (const overrides of [
    { "thread/loaded/list": () => ({ data: [] }) },
    { "thread/read": () => ({ thread: { id: threadId, status: { type: "active" } } }) },
    { "thread/goal/get": () => ({ goal: { status: "active" } }) },
    { "thread/goal/get": () => ({ goal: {} }) },
    { "thread/list": () => ({ data: [{ id: "child" }], nextCursor: null }) },
  ]) {
    const f = fixture(overrides); f.initialize(); await assert.rejects(f.transport.archiveIdle(threadId));
    assert.equal(f.requests.filter(r => r.method === "thread/archive").length, 0); f.transport.close();
  }
});

test("archival checks spawned descendants at every depth including non-interactive sources", async () => {
  const f = fixture({ "thread/list": m => {
    assert.equal(m.params.ancestorThreadId, threadId);
    assert.equal(m.params.parentThreadId, undefined);
    assert.ok(m.params.sourceKinds.includes("subAgentThreadSpawn"));
    assert.ok(m.params.sourceKinds.includes("subAgentOther"));
    return { data: [{ id: "nested-spawn" }], nextCursor: null };
  } });
  f.initialize();
  await assert.rejects(f.transport.archiveIdle(threadId));
  assert.equal(f.requests.some(m => m.method === "thread/archive"), false);
  f.transport.close();
});

test("archival gates source mutations but leaves a neighbouring task and reads working", async () => {
  const f = fixture({ "thread/archive": () => undefined }); f.initialize();
  const archive = f.transport.archiveIdle(threadId);
  await new Promise(resolve => setImmediate(resolve));
  f.send({ id: 42, method: "turn/start", params: { threadId } });
  f.send({ id: 43, method: "turn/start", params: { threadId: "neighbour" } });
  assert.equal(f.received.find(m => m.id === 42)?.error?.code, -32000);
  assert.equal(f.requests.filter(m => m.method === "turn/start").length, 1);
  const request = f.requests.find(m => m.method === "thread/archive")!;
  f.native({ id: request.id, result: {} }); await archive; f.transport.close();
});

test("idle descendant trees are paginated, gated and archived once through their root", async () => {
  const child = "22222222-2222-4222-8222-222222222222";
  const grandchild = "33333333-3333-4333-8333-333333333333";
  const f = fixture({
    "thread/list": m => m.params.cursor ? { data: [{ id: grandchild }], nextCursor: null } : { data: [{ id: child }], nextCursor: "page2" },
    "thread/read": m => ({ thread: { id: m.params.threadId, status: { type: "idle" } } }),
    "thread/archive": () => undefined,
  });
  f.initialize(); const archive = f.transport.archiveIdle(threadId);
  await new Promise(resolve => setImmediate(resolve));
  f.send({ id: 55, method: "turn/start", params: { threadId: grandchild } });
  assert.equal(f.received.find(m => m.id === 55)?.error?.code, -32000);
  const mutation = f.requests.filter(m => m.method === "thread/archive");
  assert.equal(mutation.length, 1); assert.equal(mutation[0]?.params.threadId, threadId);
  f.native({ id: mutation[0]!.id, result: {} }); await archive;
  f.send({ id: 56, method: "turn/start", params: { threadId: grandchild } });
  assert.ok(f.requests.some(m => m.method === "turn/start" && m.params.threadId === grandchild));
  f.transport.close();
});

test("running, unloaded or active-goal descendants prevent root archival", async () => {
  const child = "22222222-2222-4222-8222-222222222222";
  for (const state of ["active", "notLoaded", "goal"]) {
    const f = fixture({
      "thread/list": () => ({ data: [{ id: child }], nextCursor: null }),
      "thread/read": m => ({ thread: { id: m.params.threadId, status: { type: m.params.threadId === child && state !== "goal" ? state : "idle" } } }),
      "thread/goal/get": m => ({ goal: m.params.threadId === child && state === "goal" ? { status: "active" } : null }),
    });
    f.initialize(); await assert.rejects(f.transport.archiveIdle(threadId));
    assert.equal(f.requests.some(m => m.method === "thread/archive"), false);
    f.transport.close();
  }
});

test("owner archive accepts an old unloaded empty child but not a newly spawned one", async () => {
  const child = "22222222-2222-4222-8222-222222222222";
  let updatedAt = Math.floor(Date.now() / 1000);
  const f = fixture({
    "thread/list": () => ({ data: [{ id: child }], nextCursor: null }),
    "thread/read": m => ({ thread: { id: m.params.threadId, updatedAt,
      status: { type: m.params.threadId === child ? "notLoaded" : "idle" } } }),
    "thread/turns/list": () => ({ data: [], nextCursor: null }),
  });
  f.initialize();
  await assert.rejects(f.transport.archiveIdle(threadId));
  assert.equal(f.requests.filter(m => m.method === "thread/archive").length, 0);
  updatedAt -= 600;
  await f.transport.archiveIdle(threadId);
  assert.equal(f.requests.filter(m => m.method === "thread/archive").length, 1);
  f.transport.close();
});

test("a changed descendant tree or repeated pagination cursor prevents archival", async () => {
  const child = "22222222-2222-4222-8222-222222222222";
  let lists = 0;
  const changed = fixture({ "thread/list": () => ({ data: ++lists === 1 ? [] : [{ id: child }], nextCursor: null }) });
  changed.initialize(); await assert.rejects(changed.transport.archiveIdle(threadId));
  assert.equal(changed.requests.some(m => m.method === "thread/archive"), false); changed.transport.close();
  const repeated = fixture({ "thread/list": () => ({ data: [], nextCursor: "loop" }) });
  repeated.initialize(); await assert.rejects(repeated.transport.archiveIdle(threadId));
  assert.equal(repeated.requests.filter(m => m.method === "thread/list").length, 2);
  assert.equal(repeated.requests.some(m => m.method === "thread/archive"), false); repeated.transport.close();
});

test("timeout after archive is unknown, is not retried and late response stays out of UI", async () => {
  const f = fixture({ "thread/archive": () => undefined }, 15); f.initialize();
  await assert.rejects(f.transport.archiveIdle(threadId), (e: unknown) => e instanceof OwnerTransportError && e.outcome === "unknown");
  const requests = f.requests.filter(m => m.method === "thread/archive"); assert.equal(requests.length, 1);
  f.native({ id: requests[0]!.id, result: {} }); assert.equal(f.received.length, 1); f.transport.close();
});

test("disconnect after archive preserves uncertainty and never retries", async () => {
  const f = fixture({ "thread/archive": () => undefined }); f.initialize();
  const operation = f.transport.archiveIdle(threadId);
  await new Promise(resolve => setImmediate(resolve));
  f.transport.close();
  await assert.rejects(operation, (e: unknown) => e instanceof OwnerTransportError && e.outcome === "unknown");
  assert.equal(f.requests.filter(m => m.method === "thread/archive").length, 1);
});

test("UTF-8 and a large native response survive framing without a metadata size cap", () => {
  const f = fixture(); f.initialize(); const text = "цель 🐈".repeat(250_000);
  const frame = Buffer.from(JSON.stringify({ method: "test/large", params: { text } }) + "\n");
  for (let i = 0; i < frame.length; i += 8191) f.nativeOutput.write(frame.subarray(i, i + 8191));
  assert.equal(f.received.at(-1)?.params.text, text); f.transport.close();
});

test("private owner channel selects the matching profile and retires discovery on close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-channel-"));
  const home = path.join(root, "profile"); let archives = 0;
  const channel = await serveOwnerChannel(home, { ownsTask: async id => id === threadId, archiveIdle: async () => { archives++; } }, root);
  try {
    assert.equal(await archiveThroughOwner(path.join(root, "other-profile"), threadId, root), false);
    assert.equal(await archiveThroughOwner(home, threadId, root), true);
    assert.equal(archives, 1);
  } finally { await channel.close(); }
  assert.equal(await archiveThroughOwner(home, threadId, root), false);
});

test("owner channel exposes only the selected owner's task status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-inspect-"));
  const channel = await serveOwnerChannel(root, {
    ownsTask: async id => id === threadId,
    inspectTask: async () => "active",
    archiveIdle: async () => { throw new Error("unexpected archive"); },
  }, root);
  try {
    assert.equal(await inspectThroughOwner(root, threadId, root), "active");
    assert.equal(await inspectThroughOwner(root, "22222222-2222-4222-8222-222222222222", root), null);
  } finally { await channel.close(); }
});

test("a legacy owner cannot silently receive archive after the protocol changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-legacy-"));
  const home = path.join(root, "profile");
  const id = randomUUID(); const token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\vkodex-owner-${id}` : path.join(os.tmpdir(), `vkodex-owner-${id}.sock`);
  let archives = 0;
  const server = createServer(socket => {
    socket.once("data", bytes => {
      const request = JSON.parse(String(bytes).trim()) as { operation: string };
      if (request.operation === "archive") archives++;
      socket.end(JSON.stringify(request.operation === "probe" ? { ok: true, owned: true } : { ok: true }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const directory = path.join(root, createHash("sha256").update(comparablePath(home)).digest("hex"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${process.pid}-${id}.json`), JSON.stringify({
    version: 1, home: comparablePath(home), endpoint, token, pid: process.pid,
  }));
  try {
    await assert.rejects(archiveThroughOwner(home, threadId, root), (error: unknown) =>
      error instanceof OwnerTransportError && error.outcome === "outdated");
    await assert.rejects(inspectThroughOwner(home, threadId, root), (error: unknown) =>
      error instanceof OwnerTransportError && error.outcome === "outdated");
    assert.equal(archives, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("ambiguous owners cannot receive an archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-ambiguity-")); let archives = 0;
  const owner = { ownsTask: async () => true, archiveIdle: async () => { archives++; } };
  const first = await serveOwnerChannel(root, owner, root), second = await serveOwnerChannel(root, owner, root);
  try {
    await assert.rejects(archiveThroughOwner(root, threadId, root), (e: unknown) => e instanceof OwnerTransportError && e.outcome === "rejected");
    assert.equal(archives, 0);
  } finally { await first.close(); await second.close(); }
});

test("an unavailable registered owner cannot be mistaken for absence or unique ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-probe-")); let archives = 0;
  const unavailable = await serveOwnerChannel(root, {
    ownsTask: async () => { throw new OwnerTransportError("unavailable", "initializing"); },
    archiveIdle: async () => { archives++; },
  }, root);
  let ready: Awaited<ReturnType<typeof serveOwnerChannel>> | undefined;
  try {
    await assert.rejects(archiveThroughOwner(root, threadId, root), (e: unknown) => e instanceof OwnerTransportError && e.outcome === "unavailable");
    ready = await serveOwnerChannel(root, { ownsTask: async () => true, archiveIdle: async () => { archives++; } }, root);
    await assert.rejects(archiveThroughOwner(root, threadId, root), (e: unknown) => e instanceof OwnerTransportError && e.outcome === "unavailable");
    assert.equal(archives, 0);
  } finally { await ready?.close(); await unavailable.close(); }
});

test("a missing stale endpoint does not block a live owner after PID reuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-stale-pid-")); let archives = 0;
  const directory = path.join(root, createHash("sha256").update(comparablePath(root)).digest("hex"));
  await mkdir(directory, { recursive: true });
  const staleId = randomUUID();
  await writeFile(path.join(directory, `${process.pid}-${staleId}.json`), JSON.stringify({
    version: 1, home: comparablePath(root),
    endpoint: process.platform === "win32" ? `\\\\.\\pipe\\vkodex-owner-${staleId}` : path.join(os.tmpdir(), `vkodex-owner-${staleId}.sock`),
    token: randomBytes(32).toString("hex"), pid: process.pid,
  }));
  const ready = await serveOwnerChannel(root, { ownsTask: async () => true, archiveIdle: async () => { archives++; } }, root);
  try {
    assert.equal(await archiveThroughOwner(root, threadId, root), true);
    assert.equal(archives, 1);
  } finally { await ready.close(); }
});

test("owner channel timeout after dispatch is unknown and never retries the mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-uncertain-")); let archives = 0;
  let finish!: () => void;
  const channel = await serveOwnerChannel(root, {
    ownsTask: async () => true,
    archiveIdle: async () => { archives++; await new Promise<void>(resolve => { finish = resolve; }); },
  }, root);
  try {
    await assert.rejects(archiveThroughOwner(root, threadId, root, 50), (e: unknown) => e instanceof OwnerTransportError && e.outcome === "unknown");
    assert.equal(archives, 1);
  } finally { finish?.(); await channel.close(); }
});

test("profile archive prefers the native owner and never falls back after an uncertain mutation", async () => {
  let external = 0; const seen: string[] = [];
  const fallback = () => ({ rename: async () => {}, archive: async () => { external++; }, markdown: async () => "", assignProject: async () => {} });
  const task = { hostId: "local", threadId };
  await new ProfileDesktopMetadata(() => "selected-home", fallback, async home => { seen.push(home); return true; }).archive(task);
  assert.deepEqual(seen, ["selected-home"]); assert.equal(external, 0);
  await assert.rejects(new ProfileDesktopMetadata(() => "selected-home", fallback, async () => { throw new OwnerTransportError("unknown", "lost response"); }).archive(task), UncertainActionError);
  assert.equal(external, 0);
  await new ProfileDesktopMetadata(() => "selected-home", fallback, async () => false).archive(task);
  assert.equal(external, 1);
});
