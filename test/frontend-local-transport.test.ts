import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { PersistentFrontendLocalTransport, startFrontendServer, connectFrontend } from '../src/codex/frontend-local-transport.js';
import type { FrontendFrame, FrontendLocalTransportOptions } from '../src/codex/frontend-local-transport.js';
import { PersistentFrontendSessions } from '../src/codex/persistent-frontend-session.js';

const transports: PersistentFrontendLocalTransport[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(transport => transport.close())); });

interface FakeAttachment {
  readonly received: FrontendFrame[];
  detached: number;
  readonly send: (payload: FrontendFrame) => boolean;
  receive(frame: FrontendFrame): void;
  detach(): void;
}
function fakeSessions() {
  const state: { attaches: FakeAttachment[]; backendStops: number } = { attaches: [], backendStops: 0 };
  return {
    state,
    attach(send: (payload: FrontendFrame) => boolean): FakeAttachment {
      const attachment: FakeAttachment = { received: [], detached: 0, send,
        receive(frame: FrontendFrame) { attachment.received.push(frame); },
        detach() { attachment.detached++; },
      };
      state.attaches.push(attachment);
      return attachment;
    },
  };
}

async function openClient(port: number, token: string): Promise<{ socket: Socket; ack: FrontendFrame }> {
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ token })}\n`);
  const [data] = await once(socket, 'data');
  assert.ok(Buffer.isBuffer(data));
  const ack: unknown = JSON.parse(data.toString('utf8').split('\n')[0]!);
  assert.ok(ack && typeof ack === 'object' && !Array.isArray(ack));
  return { socket, ack: ack as FrontendFrame };
}

async function closes(socket: Socket): Promise<void> {
  await Promise.race([once(socket, 'close'), new Promise((_, reject) => setTimeout(() => reject(new Error('socket did not close')), 300))]);
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(check(), 'condition did not become true');
}

async function create(options: Partial<Omit<FrontendLocalTransportOptions, 'sessions'>> = {}) {
  const sessions = fakeSessions();
  const transport = new PersistentFrontendLocalTransport({ sessions, authTimeoutMs: 40, maxFrameBytes: 1024, ...options });
  transports.push(transport);
  await transport.listen();
  return { sessions, transport, port: transport.address!.port, token: transport.authToken() };
}
function addressOf(server: Server): AddressInfo {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address;
}

test('wrong or missing authentication never attaches a frontend', async () => {
  const { sessions, port } = await create();
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write('{"token":"wrong"}\n');
  await closes(socket);
  assert.equal(sessions.state.attaches.length, 0);
  assert.equal(sessions.state.backendStops, 0);
});

test('authenticated disconnect detaches only its frontend and leaves backend ownership untouched', async () => {
  const { sessions, transport, port, token } = await create();
  const { socket, ack } = await openClient(port, token);
  assert.equal(ack.ok, true);
  socket.write('{"method":"thread/read","params":{}}\n');
  await eventually(() => sessions.state.attaches[0]!.received.length === 1);
  assert.deepEqual(sessions.state.attaches[0]!.received, [{ method: 'thread/read', params: {} }]);
  socket.destroy();
  await closes(socket);
  assert.equal(sessions.state.attaches[0]!.detached, 1);
  assert.equal(sessions.state.backendStops, 0);
  assert.equal(transport.metadata.authenticatedCount, 0);
});

test('a replacement authenticated frontend retires the old attachment but not the backend', async () => {
  const { sessions, port, token } = await create();
  const first = await openClient(port, token);
  const second = await openClient(port, token);
  await closes(first.socket);
  assert.equal(sessions.state.attaches.length, 2);
  assert.equal(sessions.state.attaches[0]!.detached, 1);
  second.socket.write('{"id":7}\n');
  await eventually(() => sessions.state.attaches[1]!.received.length === 1);
  assert.deepEqual(sessions.state.attaches[1]!.received, [{ id: 7 }]);
  assert.equal(sessions.state.backendStops, 0);
  second.socket.destroy();
});

test('malformed and oversized frames close only that frontend', async () => {
  const { sessions, port, token } = await create();
  const malformed = await openClient(port, token);
  malformed.socket.write('{not json}\n');
  await closes(malformed.socket);
  assert.equal(sessions.state.attaches[0]!.detached, 1);
  const oversized = await openClient(port, token);
  oversized.socket.write(`${'x'.repeat(1025)}\n`);
  await closes(oversized.socket);
  assert.equal(sessions.state.attaches[1]!.detached, 1);
  assert.equal(sessions.state.backendStops, 0);
});

test('bounded outbound frames and explicit transport close detach active frontend without backend stop', async () => {
  const { sessions, transport, port, token } = await create();
  const { socket } = await openClient(port, token);
  sessions.state.attaches[0]!.send({ body: 'x'.repeat(1200) });
  await closes(socket);
  assert.equal(sessions.state.attaches[0]!.detached, 1);
  let closed = 0;
  transport.onClose(() => { closed++; });
  await transport.close();
  assert.equal(closed, 1);
  assert.equal(sessions.state.backendStops, 0);
});

test('startFrontendServer exposes loopback address and in-memory token capability', async () => {
  const sessions = fakeSessions();
  const server = await startFrontendServer({ sessions, authTimeoutMs: 40, maxFrameBytes: 1024 });
  transports.push(server.transport);
  assert.equal(server.host, '127.0.0.1');
  assert.equal(typeof server.port, 'number');
  assert.ok(server.token.length >= 32);
  assert.equal(JSON.stringify(server.metadata()).includes(server.token), false);
  await server.close();
  assert.equal(server.metadata().address, null);
});

test('typed transport accepts a persistent frontend session and delivers its initialize result', async () => {
  const initializeRequest = { clientInfo: { name: 'fixture' }, capabilities: {} };
  const sessions = new PersistentFrontendSessions({
    backendFactory: () => ({
      initializedSession: async () => ({ generation: 1, initializeResult: { serverInfo: { name: 'fixture' } } }),
      isSessionCurrent: generation => generation === 1,
      onNotification: () => () => {},
      request: async () => ({}),
    }), initializeRequest, taskId: 'own',
  });
  const server = await startFrontendServer({ sessions });
  transports.push(server.transport);
  const { socket } = await openClient(server.port, server.token);
  try {
    socket.write(`${JSON.stringify({ id: 'init', method: 'initialize', params: initializeRequest })}\n`);
    const [data] = await once(socket, 'data');
    assert.ok(Buffer.isBuffer(data));
    const frame: unknown = JSON.parse(data.toString('utf8').split('\n')[0]!);
    assert.deepEqual(frame, { id: 'init', result: { serverInfo: { name: 'fixture' } } });
  } finally { socket.destroy(); }
});


test('fragmented authentication acknowledgement is accepted by the shim helper', async () => {
  const server = createServer(socket => {
    socket.once('data', () => { socket.write('{"ok":'); setTimeout(() => socket.write('true}\n'), 2); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const input = new PassThrough(); const output = new PassThrough();
  const socket = await connectFrontend({ port: addressOf(server).port, token: 'x'.repeat(43), input, output, authTimeoutMs: 100 });
  assert.equal(socket.destroyed, false);
  socket.destroy(); input.end();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('shim rejects closed authentication without hanging and loopback is enforced', async () => {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  await assert.rejects(connectFrontend({ port: addressOf(server).port, token: 'x'.repeat(43), input: new PassThrough(), output: new PassThrough(), authTimeoutMs: 100 }), /closed|failed/);
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.throws(() => new PersistentFrontendLocalTransport({ sessions: fakeSessions(), host: '0.0.0.0' }), /127\.0\.0\.1/);
  assert.throws(() => new PersistentFrontendLocalTransport({ sessions: fakeSessions(), authTimeoutMs: 0 }), /timeout/);
  assert.throws(() => new PersistentFrontendLocalTransport({ sessions: fakeSessions(), port: -1 }), /port/);
});

test('async receive rejection retires only its frontend and transport close cleans unauthenticated sockets', async () => {
  const sessions: { state: { attachment: { detached: number } | null; backendStops: number };
    attach(): { detached: number; receive(): Promise<never>; detach(): void } } = {
    state: { attachment: null, backendStops: 0 }, attach() {
    const attachment = { detached: 0, receive: async () => { throw new Error('frontend only'); }, detach() { attachment.detached++; } };
    sessions.state.attachment = attachment; return attachment;
  } };
  const transport = new PersistentFrontendLocalTransport({ sessions, authTimeoutMs: 1_000, maxFrameBytes: 1024 });
  transports.push(transport); await transport.listen();
  const { socket } = await openClient(transport.address!.port, transport.authToken());
  socket.write('{"request":1}\n');
  await closes(socket);
  assert.equal(sessions.state.attachment!.detached, 1);
  const unauthenticated = connect({ host: '127.0.0.1', port: transport.address!.port });
  unauthenticated.on('error', () => {}); await once(unauthenticated, 'connect');
  const closing = transport.close();
  await closes(unauthenticated); await closing;
  assert.equal(sessions.state.backendStops, 0);
});

test('many valid frames in one TCP chunk are bounded per frame, not aggregate chunk size', async () => {
  const { sessions, port, token } = await create();
  const { socket } = await openClient(port, token);
  const frame = JSON.stringify({ payload: 'x'.repeat(700) }) + '\n';
  socket.write(frame + frame);
  await eventually(() => sessions.state.attaches[0]!.received.length === 2);
  assert.equal(sessions.state.attaches[0]!.received.length, 2);
  socket.destroy();
});
