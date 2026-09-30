import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { AppServerUnavailableError, AppServerUncertainError } from "../src/codex/app-server-connection.js";
import { AppServerProfileOwner } from "../src/codex/app-server-profile-owner.js";
import { createAppServerWebSocketConnection } from "../src/codex/app-server-websocket-connection.js";

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
    createAppServerWebSocketConnection(native.url, native.token, 1000));
  try {
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
