import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { OwnerTransport, OwnerTransportError } from "../src/desktop/owner-transport.js";
import { archiveThroughOwner, inspectThroughOwner, serveOwnerChannel } from "../src/desktop/owner-channel.js";
import { ProfileDesktopMetadata, unownedArchiveReady } from "../src/desktop/metadata.js";
import { UncertainActionError } from "../src/desktop/contracts.js";
import { ownerEnvironment, resolveOwnerExecutable } from "../src/desktop/owner-launcher.js";
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

test("owner launcher follows Codex Desktop native replacement after an app update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-owner-desktop-version-"));
  const oldExecutable = path.join(root, "1111111111111111", "codex.exe");
  const currentExecutable = path.join(root, "2222222222222222", "codex.exe");
  await mkdir(path.dirname(oldExecutable), { recursive: true });
  await mkdir(path.dirname(currentExecutable), { recursive: true });
  await writeFile(oldExecutable, "old"); await writeFile(currentExecutable, "current");
  const oldTime = new Date("2025-01-01T00:00:00Z"), currentTime = new Date("2026-01-01T00:00:00Z");
  await utimes(oldExecutable, oldTime, oldTime); await utimes(currentExecutable, currentTime, currentTime);
  assert.equal(await resolveOwnerExecutable({ nativeExecutable: oldExecutable, nativeSearchRoot: root }), currentExecutable);
  await mkdir(path.join(root, "not-a-runtime"), { recursive: true });
  await writeFile(path.join(root, "not-a-runtime", "codex.exe"), "ignored");
  assert.equal(await resolveOwnerExecutable({ nativeExecutable: oldExecutable, nativeSearchRoot: root }), currentExecutable);
});

const threadId = "11111111-1111-4111-8111-111111111111";
test("owner launcher preserves native IDE authentication and integration environment without VK secrets", () => {
  assert.deepEqual(ownerEnvironment({ CODEX_HOME: "wrong", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "vscode", VSCODE_IPC_HOOK_CLI: "hook", OPENAI_API_KEY: "fixture-native-key", VK_GROUP_TOKEN: "fixture-vk-key", VKODEX_RUN_ID: "run", BOT_DATA_DIR: "bridge" }, "selected"), {
    CODEX_HOME: "selected", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "vscode", VSCODE_IPC_HOOK_CLI: "hook", OPENAI_API_KEY: "fixture-native-key",
  });
});
type Message = Record<string, any>;
function fixture(overrides: Record<string, (m: Message) => unknown> = {}, timeout = 1000) {
  const nativeInput = new PassThrough(), nativeOutput = new PassThrough(), clientInput = new PassThrough(), clientOutput = new PassThrough();
  const requests: Message[] = [], received: Message[] = [];
  const write = (stream: PassThrough, m: Message) => stream.write(JSON.stringify(m) + "\n");
  const listen = (stream: PassThrough, fn: (m: Message) => void) => {
    let buffer = ""; stream.setEncoding("utf8"); stream.on("data", (chunk: string) => {
      buffer += chunk; let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); fn(JSON.parse(line)); }
    });
  };
  const transport = new OwnerTransport(nativeInput, nativeOutput, clientInput, clientOutput, timeout);
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
