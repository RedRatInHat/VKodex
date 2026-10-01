import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { AppServerUnavailableError, AppServerUncertainError } from "../src/codex/app-server-connection.js";
import { AppServerProfileOwner } from "../src/codex/app-server-profile-owner.js";
import { createAppServerWebSocketConnection } from "../src/codex/app-server-websocket-connection.js";
import { canonicalDetachedProfileHome, createDetachedProfileConnection, createPinnedDetachedProfileConnection,
  detachedProfileKey, inspectDetachedProfileBackend, pinnedDetachedProfileBackendIdentity } from
  "../src/codex/detached-profile-capability.js";

type JsonObject = Record<string, unknown>;

async function fixture(response: (value: JsonObject) => JsonObject = () => ({ ok: true })) {
  const token = "isolated-test-capability";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024,
    verifyClient: (info: { req: IncomingMessage }) =>
      info.req.headers.authorization === `Bearer ${token}` });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing fixture port");
  const sockets = new Set<WebSocket>();
  const methods: string[] = [];
  let connections = 0;
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    connections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("message", frame => {
      const value = JSON.parse(frame.toString()) as JsonObject;
      if (typeof value.method === "string") methods.push(value.method);
      if (value.id === undefined) return;
      if (value.method === "hang") return;
      socket.send(JSON.stringify({ id: value.id, result: value.method === "initialize"
        ? { serverInfo: { name: "isolated-ws" } } : response(value) }));
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}`, token, sockets, methods,
    get connections() { return connections; },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test("authenticated WebSocket App Server client reconnects without closing the server", async () => {
  const native = await fixture();
  const first = createAppServerWebSocketConnection(native.url, native.token, 1000);
  try {
    assert.deepEqual(await first.request("thread/read", {}), { ok: true });
    assert.deepEqual(native.methods.slice(0, 3), ["initialize", "initialized", "thread/read"]);
    await first.close();
    const second = createAppServerWebSocketConnection(native.url, native.token, 1000);
    try {
      assert.deepEqual(await second.request("thread/read", {}), { ok: true });
      assert.equal(native.connections, 2);
    } finally { await second.close(); }
  } finally { await first.close(); await native.close(); }
});

test("WebSocket loss keeps an in-flight mutation uncertain and reconnects for reads", async () => {
  const native = await fixture();
  const client = createAppServerWebSocketConnection(native.url, native.token, 1000);
  try {
    await client.start();
    const pending = client.request("hang", {}, { mutating: true, timeoutMs: 1000 });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    for (const socket of native.sockets) socket.terminate();
    await assert.rejects(pending, AppServerUncertainError);
    assert.deepEqual(await client.request("thread/read", {}), { ok: true });
    assert.equal(native.connections, 2);
  } finally { await client.close(); await native.close(); }
});

test("WebSocket App Server capability refuses wrong bearer and non-loopback URLs", async () => {
  const native = await fixture();
  try {
    assert.throws(() => createAppServerWebSocketConnection(native.url.replace("127.0.0.1", "192.0.2.1"), native.token),
      TypeError);
    assert.throws(() => createAppServerWebSocketConnection(native.url, "bad\r\nHeader: injected"), TypeError);
    const wrong = createAppServerWebSocketConnection(native.url, "wrong-test-capability", 1000);
    try { await assert.rejects(wrong.start(), AppServerUnavailableError); }
    finally { await wrong.close(); }
    assert.equal(native.connections, 0);
  } finally { await native.close(); }
});

test("profile owner teardown detaches its WebSocket without terminating the backend", async () => {
  const threadId = "00000000-0000-4000-8000-000000000001";
  const native = await fixture(value => value.method === "thread/read"
    ? { thread: { id: threadId, name: "detached owner", cwd: "C:/temp", status: { type: "idle" } } }
    : { ok: true });
  const task = { hostId: "local" as const, threadId, sourceId: "source-a" };
  const first = new AppServerProfileOwner("source-a",
    createAppServerWebSocketConnection(native.url, native.token, 1000), undefined, new Set([threadId]));
  try {
    assert.equal(first.routingPolicy, "exclusive");
    assert.equal(first.owns({ ...task, threadId: "00000000-0000-4000-8000-000000000002" }), false);
    assert.equal((await first.inspectTask(task)).status, "idle");
    await first.close();
    const second = new AppServerProfileOwner("source-a",
      createAppServerWebSocketConnection(native.url, native.token, 1000));
    try {
      assert.equal((await second.inspectTask(task)).title, "detached owner");
      assert.equal(native.connections, 2);
    } finally { await second.close(); }
  } finally { await first.close(); await native.close(); }
});

test("detached profile fences a mutation against replaced descriptor and process birth", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-private");
  const epoch = "00000000-0000-4000-8000-000000000001";
  const descriptorFile = path.join(directory, "ready.json");
  const tokenFile = path.join(directory, epoch, "token");
  let birthTicks = "12345678";
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const record = { schemaVersion: 1, epoch, profileKey: detachedProfileKey(home), home,
    url: native.url, backend: { pid: 1234, birthTicks } };
  const files = new Map([[descriptorFile, JSON.stringify(record)], [tokenFile, native.token]]);
  const dependencies = {
    readFile: (file: string) => {
      const value = files.get(file);
      if (!value) throw new Error("missing");
      return value;
    },
    identity: (pid: number) => pid === 1234 ? { pid, birthTicks } : null,
  };
  const client = createDetachedProfileConnection(directory, record.home, dependencies);
  try {
    assert.deepEqual(await client.request("thread/read"), { ok: true });
    files.set(descriptorFile, JSON.stringify({ ...record, epoch: "00000000-0000-4000-8000-000000000002" }));
    await assert.rejects(client.request("thread/rename", {}, { mutating: true }), AppServerUnavailableError);
    assert.equal(native.methods.includes("thread/rename"), false);
    files.set(descriptorFile, JSON.stringify(record));
    // A new process can reuse a PID only after the original socket has died.
    birthTicks = "98765432";
    for (const socket of native.sockets) socket.terminate();
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    await assert.rejects(client.request("thread/read"), AppServerUnavailableError);
  } finally { await client.close(); await native.close(); }
});

test("detached profile rejects a changed token before first connection", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-first-connection");
  const epoch = "00000000-0000-4000-8000-000000000001";
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const descriptor = { schemaVersion: 1, epoch, profileKey: detachedProfileKey(home), home,
    url: native.url, backend: { pid: 1234, birthTicks: "12345678" } };
  let token = native.token;
  const client = createDetachedProfileConnection(directory, descriptor.home, {
    readFile: file => file.endsWith("ready.json") ? JSON.stringify(descriptor) : token,
    identity: pid => ({ pid, birthTicks: "12345678" }),
  });
  try {
    const start = client.start();
    token = "replaced-test-capability";
    await assert.rejects(start, AppServerUnavailableError);
    assert.equal(native.connections, 0);
  } finally { await client.close(); await native.close(); }
});

test("pinned detached profile refuses a different live epoch before its first socket", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-pinned-epoch");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const expected = { schemaVersion: 1 as const, epoch: "00000000-0000-4000-8000-000000000001",
    profileKey: detachedProfileKey(home), home, url: native.url,
    backend: { pid: 1234, birthTicks: "12345678" } };
  let actual = { ...expected };
  const client = createPinnedDetachedProfileConnection(directory, home, expected, {
    readFile: file => file.endsWith("ready.json") ? JSON.stringify(actual) : native.token,
    identity: pid => ({ pid, birthTicks: "12345678" }),
  });
  try {
    actual = { ...expected, epoch: "00000000-0000-4000-8000-000000000002" };
    await assert.rejects(client.start(), AppServerUnavailableError);
    assert.equal(native.connections, 0);
  } finally { await client.close(); await native.close(); }
});

test("a generic or dependency-injected connector cannot mint a production backend identity", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-no-production-pin");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const expected = { schemaVersion: 1 as const, epoch: "00000000-0000-4000-8000-000000000001",
    profileKey: detachedProfileKey(home), home, url: native.url,
    backend: { pid: 1234, birthTicks: "12345678" } };
  const injected = createPinnedDetachedProfileConnection(directory, home, expected, {
    readFile: file => file.endsWith("ready.json") ? JSON.stringify(expected) : native.token,
    identity: pid => ({ pid, birthTicks: expected.backend.birthTicks }),
  });
  try {
    const session = await injected.initializedSession();
    assert.equal(injected.isSessionCurrent(session.generation), true);
    assert.throws(() => pinnedDetachedProfileBackendIdentity(injected, session.generation),
      AppServerUnavailableError);
    assert.throws(() => pinnedDetachedProfileBackendIdentity({ ...injected }, session.generation),
      AppServerUnavailableError);
    const explicitEmptyDependencies = createPinnedDetachedProfileConnection(directory,
      home, expected, {});
    assert.throws(() => pinnedDetachedProfileBackendIdentity(explicitEmptyDependencies,
      session.generation), AppServerUnavailableError);
    await explicitEmptyDependencies.close();
    const explicitUndefined = createPinnedDetachedProfileConnection(directory,
      home, expected, undefined);
    assert.throws(() => pinnedDetachedProfileBackendIdentity(explicitUndefined,
      session.generation), AppServerUnavailableError);
    await explicitUndefined.close();
    const production = createPinnedDetachedProfileConnection(directory, home, expected);
    assert.equal(Object.isFrozen(production), true);
    assert.throws(() => pinnedDetachedProfileBackendIdentity(production, session.generation),
      AppServerUnavailableError, "another connection's generation does not authorize this pin");
    await production.close();
  } finally { await injected.close(); await native.close(); }
});

test("pinned detached profile accepts only its exact backend and fences replacement", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-pinned-backend");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const expected = { schemaVersion: 1 as const, epoch: "00000000-0000-4000-8000-000000000001",
    profileKey: detachedProfileKey(home), home, url: native.url,
    backend: { pid: 1234, birthTicks: "12345678" } };
  let actual = { ...expected };
  const client = createPinnedDetachedProfileConnection(directory, home, expected, {
    readFile: file => file.endsWith("ready.json") ? JSON.stringify(actual) : native.token,
    identity: pid => ({ pid, birthTicks: actual.backend.birthTicks }),
  });
  try {
    assert.deepEqual(await client.request("thread/read"), { ok: true });
    actual = { ...expected, backend: { pid: 1234, birthTicks: "98765432" } };
    await assert.rejects(client.request("thread/rename", {}, { mutating: true }), AppServerUnavailableError);
    assert.equal(native.methods.includes("thread/rename"), false);
  } finally { await client.close(); await native.close(); }
});

test("pinned detached profile exposes its exact initialized generation to a one-shot writer", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-pinned-generation");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const expected = { schemaVersion: 1 as const, epoch: "00000000-0000-4000-8000-000000000001",
    profileKey: detachedProfileKey(home), home, url: native.url,
    backend: { pid: 1234, birthTicks: "12345678" } };
  const client = createPinnedDetachedProfileConnection(directory, home, expected, {
    readFile: file => file.endsWith("ready.json") ? JSON.stringify(expected) : native.token,
    identity: pid => ({ pid, birthTicks: expected.backend.birthTicks }),
  });
  try {
    assert.equal(client.isSessionCurrent(1), false);
    const session = await client.initializedSession();
    assert.equal(client.isSessionCurrent(session.generation), true);
    assert.deepEqual(await client.request("thread/read", {}, { expectedGeneration: session.generation }), { ok: true });
    await assert.rejects(client.request("thread/read", {}, { expectedGeneration: session.generation + 1 }),
      AppServerUnavailableError);
    assert.equal(native.methods.filter(method => method === "thread/read").length, 1);
    const disconnected = new Promise<void>(resolve => { client.onDisconnect(() => resolve()); });
    for (const socket of native.sockets) socket.terminate();
    await disconnected;
    assert.equal(client.isSessionCurrent(session.generation), false);
    await assert.rejects(client.request("turn/start", {}, { mutating: true }), AppServerUnavailableError);
    await assert.rejects(client.request("turn/start", {}), AppServerUnavailableError);
    await assert.rejects(client.request("unknown/write", {}), AppServerUnavailableError);
    await assert.rejects(client.request("turn/start", {}, { mutating: true,
      expectedGeneration: session.generation }), AppServerUnavailableError);
    await assert.rejects(client.request("thread/read", {}, { expectedGeneration: session.generation }),
      AppServerUnavailableError);
    assert.equal(native.connections, 1, "a stale mutation generation must not reconnect itself");
    assert.equal(native.methods.includes("turn/start"), false);
    assert.deepEqual(await client.request("thread/read", {}), { ok: true });
    assert.equal(native.connections, 2, "a read may intentionally reconnect");
    const fresh = await client.initializedSession();
    assert.ok(fresh.generation > session.generation);
    assert.equal(client.isSessionCurrent(fresh.generation), true);
    assert.deepEqual(await client.request("turn/start", {}, { mutating: true,
      expectedGeneration: fresh.generation }), { ok: true });
  } finally { await client.close(); await native.close(); }
  assert.equal(client.isSessionCurrent(1), false);
});

test("detached profile rejects mismatched home and missing capability without a socket", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-invalid");
  const epoch = "00000000-0000-4000-8000-000000000001";
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const descriptor = { schemaVersion: 1, epoch, profileKey: detachedProfileKey(home), home,
    url: native.url, backend: { pid: 1234, birthTicks: "12345678" } };
  try {
    const wrongHome = createDetachedProfileConnection(directory, path.dirname(os.tmpdir()), {
      readFile: () => JSON.stringify(descriptor), identity: pid => ({ pid, birthTicks: "12345678" }),
    });
    await assert.rejects(wrongHome.start(), AppServerUnavailableError);
    await wrongHome.close();
    const missingToken = createDetachedProfileConnection(directory, descriptor.home, {
      readFile: file => file.endsWith("ready.json") ? JSON.stringify(descriptor) : "missing token\n",
      identity: pid => ({ pid, birthTicks: "12345678" }),
    });
    await assert.rejects(missingToken.start(), AppServerUnavailableError);
    await missingToken.close();
    assert.equal(native.connections, 0);
  } finally { await native.close(); }
});

test("one unavailable detached profile can attach when its server later publishes a record", async () => {
  const native = await fixture();
  const directory = path.resolve("test-detached-profile-late-ready");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const epoch = "00000000-0000-4000-8000-000000000001";
  const files = new Map<string, string>();
  const client = createDetachedProfileConnection(directory, home, {
    readFile: file => {
      const value = files.get(file);
      if (!value) throw new Error("missing");
      return value;
    },
    identity: pid => ({ pid, birthTicks: "12345678" }),
  });
  try {
    await assert.rejects(client.start(), AppServerUnavailableError);
    files.set(path.join(directory, "ready.json"), JSON.stringify({ schemaVersion: 1, epoch,
      profileKey: detachedProfileKey(home), home, url: native.url, backend: { pid: 1234, birthTicks: "12345678" } }));
    files.set(path.join(directory, epoch, "token"), native.token);
    assert.deepEqual(await client.request("thread/read"), { ok: true });
    assert.equal(native.connections, 1);
  } finally { await client.close(); await native.close(); }
});

test("detached profile refuses a capability beneath an unprotected parent", async () => {
  const directory = path.resolve("test-detached-profile-unprotected-parent");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const client = createDetachedProfileConnection(directory, home, {
    assertPrivateDirectory: parent => { if (parent === path.dirname(directory)) throw new Error("unsafe ACL"); },
    readFile: () => { throw new Error("read must not be reached"); },
    identity: () => null,
  });
  try { await assert.rejects(client.start(), AppServerUnavailableError); }
  finally { await client.close(); }
});

test("detached backend diagnostic distinguishes exact death from reuse, uncertainty, and an epoch change", () => {
  const directory = path.resolve("test-detached-profile-diagnostic");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const epoch = "00000000-0000-4000-8000-000000000001";
  const record = { schemaVersion: 1, epoch, profileKey: detachedProfileKey(home), home,
    url: "ws://127.0.0.1:32123", backend: { pid: 1234, birthTicks: "12345678" } };
  let descriptor = JSON.stringify(record);
  let identity: "live" | "dead" | "reused" | "unknown" | "change" = "live";
  const result = () => inspectDetachedProfileBackend(directory, home, {
    readFile: file => file.endsWith("ready.json") ? descriptor : "isolated-test-capability",
    identity: pid => {
      assert.equal(pid, 1234);
      if (identity === "unknown") throw new Error("probe unavailable");
      if (identity === "change") descriptor = JSON.stringify({ ...record, epoch: "00000000-0000-4000-8000-000000000002" });
      return identity === "dead" ? null : { pid, birthTicks: identity === "reused" ? "87654321" : "12345678" };
    },
  });
  assert.equal(result().state, "live");
  identity = "dead"; assert.equal(result().state, "dead-exact");
  identity = "reused"; assert.equal(result().state, "pid-reused-or-changed");
  identity = "unknown"; assert.equal(result().state, "unknown");
  identity = "change"; assert.equal(result().state, "changed");
});

test("detached backend diagnostic requires the protected epoch token without exposing it", () => {
  const directory = path.resolve("test-detached-profile-diagnostic-token");
  const home = canonicalDetachedProfileHome(os.tmpdir());
  const epoch = "00000000-0000-4000-8000-000000000001";
  const record = { schemaVersion: 1, epoch, profileKey: detachedProfileKey(home), home,
    url: "ws://127.0.0.1:32123", backend: { pid: 1234, birthTicks: "12345678" } };
  const diagnose = (token: string | null, failAcl = false) => inspectDetachedProfileBackend(directory, home, {
    readFile: file => file.endsWith("ready.json") ? JSON.stringify(record) : (() => {
      if (token === null) throw new Error("missing token");
      return token;
    })(),
    identity: pid => ({ pid, birthTicks: "12345678" }),
    assertPrivateDirectory: target => { if (failAcl && target === path.join(directory, epoch)) throw new Error("unsafe ACL"); },
  });
  assert.equal(diagnose(null).state, "invalid");
  assert.equal(diagnose("bad token\n").state, "invalid");
  assert.equal(diagnose("A".repeat(513)).state, "invalid");
  assert.equal(diagnose("isolated-test-capability", true).state, "invalid");
  assert.equal(diagnose("isolated-test-capability").state, "live");
});
