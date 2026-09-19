import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AppServerConnection, AppServerRejectedError, AppServerUnavailableError, AppServerUncertainError } from "../src/codex/app-server-connection.js";

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
  try {
    await assert.rejects(connection.request("turn/start", { threadId: "task" }, { mutating: true }), AppServerUncertainError);
    assert.equal(first.messages.filter(message => message.method === "turn/start").length, 1);
    assert.deepEqual(await connection.request("thread/read", { threadId: "task" }), { ok: true });
    assert.equal(second.messages.some(message => message.method === "turn/start"), false);
  } finally { await connection.close(); }
});
