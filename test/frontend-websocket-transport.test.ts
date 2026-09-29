import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import WebSocket from 'ws';
import { PersistentFrontendWebSocketTransport } from '../src/codex/frontend-websocket-transport.js';
import type { FrontendFrame, FrontendSessions } from '../src/codex/frontend-local-transport.js';
import { PersistentFrontendSessions } from '../src/codex/persistent-frontend-session.js';

const transports: PersistentFrontendWebSocketTransport[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(transports.splice(0).map(transport => transport.close()));
});

function fakeSessions(): FrontendSessions & { attachments: Array<{
  frames: FrontendFrame[]; detached: number; send: (frame: FrontendFrame) => boolean;
}> } {
  const attachments: Array<{ frames: FrontendFrame[]; detached: number; send: (frame: FrontendFrame) => boolean }> = [];
  return { attachments, attach(send) {
    const attachment = { frames: [] as FrontendFrame[], detached: 0, send };
    attachments.push(attachment);
    return { receive(frame) { attachment.frames.push(frame); }, detach() { attachment.detached++; } };
  } };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(check(), 'condition did not become true');
}

async function create(options: Record<string, unknown> = {}) {
  const sessions = fakeSessions();
  const transport = new PersistentFrontendWebSocketTransport({ sessions, maxFrameBytes: 1024,
    maxBufferedBytes: 1024, authTimeoutMs: 500, ...options });
  transports.push(transport);
  const address = await transport.listen();
  return { sessions, transport, url: `ws://127.0.0.1:${address.port}/`, token: transport.authToken() };
}

async function connect(url: string, token: string, options: { path?: string; header?: string } = {}): Promise<WebSocket> {
  const client = new WebSocket(options.path ? new URL(options.path, url) : url,
    { headers: options.header === 'missing' ? {} : { Authorization: options.header ?? `Bearer ${token}` },
      perMessageDeflate: false });
  clients.push(client);
  await Promise.race([once(client, 'open'), once(client, 'error').then(([error]) => { throw error; })]);
  return client;
}

test('WebSocket transport binds only IPv4 loopback and requires a 256-bit token', async () => {
  const { transport } = await create();
  assert.equal(transport.address?.address, '127.0.0.1');
  assert.equal(transport.metadata.hasFrontend, false);
  assert.equal(JSON.stringify(transport.metadata).includes(transport.authToken()), false);
  assert.throws(() => new PersistentFrontendWebSocketTransport({ sessions: fakeSessions(), host: '0.0.0.0' }), /127\.0\.0\.1/);
  assert.throws(() => new PersistentFrontendWebSocketTransport({ sessions: fakeSessions(), token: 'short' }), /256-bit/);
});

test('HTTP Upgrade rejects missing or wrong bearer header and URL credentials before attach', async () => {
  const { sessions, url, token } = await create();
  await assert.rejects(connect(url, token, { header: 'missing' }));
  await assert.rejects(connect(url, token, { header: 'Bearer wrong' }));
  await assert.rejects(connect(url, token, { header: `bearer ${token}` }));
  await assert.rejects(connect(url, token, { path: `/?token=${token}` }));
  assert.equal(sessions.attachments.length, 0);
});

test('duplicate Authorization headers fail the Upgrade before attachment', async () => {
  const { sessions, transport, token } = await create();
  const socket = connectTcp({ host: '127.0.0.1', port: transport.address!.port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n` +
    `Authorization: Bearer ${token}\r\nAuthorization: Bearer ${token}\r\n\r\n`);
  const [response] = await once(socket, 'data');
  assert.match(String(response), /^HTTP\/1\.1 401 Unauthorized/u);
  socket.destroy();
  assert.equal(sessions.attachments.length, 0);
});

test('authenticated text object frames reach one attachment and outbound JSON is bounded', async () => {
  const { sessions, transport, url, token } = await create();
  const client = await connect(url, token);
  assert.equal(transport.metadata.authenticatedCount, 1);
  assert.equal(client.extensions, '');
  client.send(JSON.stringify({ id: 7, method: 'thread/read', params: {} }));
  await eventually(() => sessions.attachments[0]?.frames.length === 1);
  assert.deepEqual(sessions.attachments[0]!.frames, [{ id: 7, method: 'thread/read', params: {} }]);
  const received = once(client, 'message');
  assert.equal(sessions.attachments[0]!.send({ id: 7, result: {} }), true);
  const [data, binary] = await received;
  assert.equal(binary, false);
  assert.deepEqual(JSON.parse(String(data)), { id: 7, result: {} });
  assert.equal(sessions.attachments[0]!.send({ body: 'x'.repeat(1200) }), false);
  await eventually(() => sessions.attachments[0]!.detached === 1);
});

test('outbound buffered-byte budget is enforced separately from frame size', async () => {
  const { sessions, url, token } = await create({ maxFrameBytes: 2048, maxBufferedBytes: 1024 });
  await connect(url, token);
  assert.equal(sessions.attachments[0]!.send({ body: 'x'.repeat(1100) }), false);
  await eventually(() => sessions.attachments[0]!.detached === 1);
});

test('an outbound object that serializes to no JSON retires only its frontend', async () => {
  const { sessions, url, token } = await create();
  await connect(url, token);
  assert.equal(sessions.attachments[0]!.send({ toJSON: () => undefined }), false);
  await eventually(() => sessions.attachments[0]!.detached === 1);
  assert.equal(sessions.attachments.length, 1);
});

test('client deflate offer is not negotiated', async () => {
  const { url, token } = await create();
  const client = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: true });
  clients.push(client);
  await once(client, 'open');
  assert.equal(client.extensions, '');
});

test('new authenticated frontend retires the old attachment without touching sessions', async () => {
  const { sessions, url, token } = await create();
  const first = await connect(url, token);
  const second = await connect(url, token);
  await eventually(() => sessions.attachments[0]!.detached === 1);
  assert.equal(sessions.attachments.length, 2);
  assert.equal(sessions.attachments[0]!.send({ stale: true }), false);
  second.send(JSON.stringify({ current: true }));
  await eventually(() => sessions.attachments[1]!.frames.length === 1);
  assert.deepEqual(sessions.attachments[1]!.frames, [{ current: true }]);
  first.terminate(); second.terminate();
  await eventually(() => sessions.attachments[1]!.detached === 1);
});

test('binary, non-object, malformed, and oversized frames close only their frontend', async () => {
  const { sessions, url, token } = await create();
  for (const payload of [Buffer.from('binary'), '[]', '{invalid', JSON.stringify({ body: 'x'.repeat(1200) })]) {
    const client = await connect(url, token);
    client.send(payload);
    await eventually(() => sessions.attachments.at(-1)?.detached === 1);
    assert.equal(sessions.attachments.at(-1)!.frames.length, 0);
  }
  assert.equal(sessions.attachments.length, 4);
});

test('close is idempotent and detaches the active frontend once', async () => {
  const { sessions, transport, url, token } = await create();
  await connect(url, token);
  const first = transport.close();
  assert.strictEqual(transport.close(), first);
  await first;
  assert.equal(sessions.attachments[0]!.detached, 1);
  assert.equal(transport.address, null);
});

test('closing during bind settles listen and leaves no endpoint', async () => {
  const transport = new PersistentFrontendWebSocketTransport({ sessions: fakeSessions() });
  transports.push(transport);
  const listening = transport.listen();
  const rejection = assert.rejects(listening, /closed/i);
  await transport.close();
  await rejection;
  assert.equal(transport.address, null);
});

test('WebSocket transport can attach PersistentFrontendSessions without an auth data frame', async () => {
  const initializeRequest = { clientInfo: { name: 'fixture' }, capabilities: {} };
  const sessions = new PersistentFrontendSessions({ taskId: 'fixture', initializeRequest,
    backendFactory: () => ({
      initializedSession: async () => ({ generation: 1, initializeResult: { serverInfo: { name: 'fixture' } } }),
      isSessionCurrent: generation => generation === 1,
      onNotification: () => () => {}, request: async () => ({}),
    }),
  });
  const transport = new PersistentFrontendWebSocketTransport({ sessions });
  transports.push(transport);
  const address = await transport.listen();
  const client = await connect(`ws://127.0.0.1:${address.port}/`, transport.authToken());
  const received = once(client, 'message');
  client.send(JSON.stringify({ id: 'init', method: 'initialize', params: initializeRequest }));
  const [data] = await received;
  assert.deepEqual(JSON.parse(String(data)), { id: 'init', result: { serverInfo: { name: 'fixture' } } });
});
