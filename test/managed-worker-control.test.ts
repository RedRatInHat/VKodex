import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ManagedWorkerControlServer, ManagedWorkerStopRefusedError } from '../src/desktop/managed-worker-control.js';

async function peer(cap: { host: string; port: number; token: string }) {
  const socket = connect(cap.port, cap.host);
  const frames: Record<string, unknown>[] = [];
  let buffer = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += String(chunk);
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      frames.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
      buffer = buffer.slice(end + 1);
    }
  });
  await once(socket, 'connect');
  const read = async () => {
    for (let n = 0; n < 200; n++) {
      if (frames.length) return frames.shift()!;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('test response timeout');
  };
  socket.write(JSON.stringify({ token: cap.token }) + '\n');
  assert.deepEqual(await read(), { ok: true });
  return { socket, read, send: (value: unknown) => socket.write(JSON.stringify(value) + '\n') };
}

test('authenticated metadata control survives client EOF without stopping its worker', async () => {
  const epoch = randomUUID(); let stops = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'owned-thread',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: 'connected', nativeRevision: 2 }),
    requestStop: async () => { stops++; } });
  const cap = await server.listen();
  try {
    const a = await peer(cap);
    a.send({ id: 's', epoch, method: 'status' });
    assert.deepEqual(await a.read(), { id: 's', result: { ownerEpoch: epoch, taskId: 'owned-thread',
      hostState: 'running', backendGeneration: 1, nativeState: 'connected', nativeRevision: 2 } });
    a.socket.destroy();
    const b = await peer(cap);
    b.send({ id: 'bad', epoch: randomUUID(), method: 'stop' });
    assert.equal((await b.read()).error, 'refused');
    b.send({ id: 'rpc', epoch, method: 'turn/start' });
    assert.equal((await b.read()).error, 'refused');
    assert.equal(stops, 0);
    b.socket.destroy();
  } finally { await server.close(); }
  assert.equal(stops, 0, 'listener shutdown is not worker shutdown');
});

test('authorized stop is single flight and continues after sender disconnect', async () => {
  const epoch = randomUUID(); let stops = 0, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => { stops++; await pending; } });
  const cap = await server.listen(); const a = await peer(cap), b = await peer(cap);
  try {
    a.send({ id: 'stop-a', epoch, method: 'stop' });
    for (let n = 0; !stops && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stops, 1); a.socket.destroy();
    b.send({ id: 'stop-b', epoch, method: 'stop' });
    finish();
    assert.deepEqual(await b.read(), { id: 'stop-b', result: { stopped: true } });
    assert.equal(stops, 1);
  } finally { finish(); a.socket.destroy(); b.socket.destroy(); await server.close(); }
});

test('failed stop stays refused, does not disclose callback error, and is not blindly retried', async () => {
  const epoch = randomUUID(); let stops = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => { stops++; throw new Error('private detail'); } });
  const cap = await server.listen(); const a = await peer(cap);
  try {
    for (const id of ['first', 'again']) {
      a.send({ id, epoch, method: 'stop' });
      assert.deepEqual(await a.read(), { id, error: 'stop-unconfirmed' });
    }
    assert.equal(stops, 1);
  } finally { a.socket.destroy(); await server.close(); }
});

test('bad authentication, oversized frames and extra fields cannot invoke stop', async () => {
  const epoch = randomUUID(); let stops = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own', authTimeoutMs: 50,
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => { stops++; } });
  const cap = await server.listen();
  async function rejected(write?: (s: Socket) => void) {
    const s = connect(cap.port, cap.host); s.on('error', () => {});
    const closed = once(s, 'close'); await once(s, 'connect'); write?.(s); await closed;
  }
  try {
    await rejected(s => s.write(JSON.stringify({ token: 'wrong' }) + '\n'));
    await rejected(s => s.write('a'.repeat(9000)));
    await rejected();
    const a = await peer(cap);
    a.send({ id: 'x', epoch, method: 'stop', override: true });
    assert.deepEqual(await a.read(), { id: 'x', error: 'refused' });
    a.socket.destroy(); assert.equal(stops, 0);
  } finally { await server.close(); }
});

test('authenticated idle clients release bounded slots without stopping the worker', async () => {
  const epoch = randomUUID(); let stops = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    authenticatedIdleTimeoutMs: 250,
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => { stops++; } });
  const cap = await server.listen();
  const clients: Awaited<ReturnType<typeof peer>>[] = [];
  try {
    for (let n = 0; n < 16; n++) clients.push(await peer(cap));
    await Promise.race([
      Promise.all(clients.map(client => client.socket.destroyed ? Promise.resolve() : once(client.socket, 'close'))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('idle clients retained all slots')), 3000)),
    ]);
    const next = await peer(cap);
    next.send({ id: 'after-idle', epoch, method: 'status' });
    assert.equal((await next.read()).id, 'after-idle');
    next.socket.destroy();
    assert.equal(stops, 0);
  } finally { for (const client of clients) client.socket.destroy(); await server.close(); }
});

test('listen and close race leaves no usable capability or worker stop', async () => {
  let stops = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: randomUUID(), taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => { stops++; } });
  const opening = server.listen();
  const closing = server.close();
  await assert.rejects(opening, /unavailable|closed/);
  await closing;
  await assert.rejects(server.listen(), /closed/);
  assert.equal(stops, 0);
});

test('bounded burst and status callback failure return only metadata or fixed errors', async () => {
  const epoch = randomUUID(); let calls = 0, stops = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => { if (++calls === 32) throw new Error('secret status detail');
      return { hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }; },
    requestStop: async () => { stops++; } });
  const cap = await server.listen(); const client = await peer(cap);
  try {
    const frames = Array.from({ length: 64 }, (_, n) => ({ id: `s-${n}`, epoch, method: 'status' }));
    client.socket.write(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
    const results = [];
    for (let n = 0; n < frames.length; n++) results.push(await client.read());
    assert.deepEqual(results.map(frame => frame.id), frames.map(frame => frame.id));
    assert.deepEqual(results[31], { id: 's-31', error: 'status-unavailable' });
    assert.equal(results.filter(frame => frame.error).length, 1);
    assert.equal(stops, 0);
  } finally { client.socket.destroy(); await server.close(); }
});

test('idle client timeout cannot cancel an admitted stop or cause a retry', async () => {
  const epoch = randomUUID(); let stops = 0, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    authenticatedIdleTimeoutMs: 250,
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => { stops++; await pending; } });
  const cap = await server.listen(); const first = await peer(cap);
  try {
    const closed = once(first.socket, 'close');
    first.send({ id: 'stopping', epoch, method: 'stop' });
    await closed;
    assert.equal(stops, 1);
    finish();
    const second = await peer(cap);
    try {
      second.send({ id: 'confirmation', epoch, method: 'stop' });
      assert.deepEqual(await second.read(), { id: 'confirmation', result: { stopped: true } });
      assert.equal(stops, 1);
    } finally { second.socket.destroy(); }
  } finally { finish(); first.socket.destroy(); await server.close(); }
});

test('definitive pre-stop refusal permits only a new explicit stop request', async () => {
  const epoch = randomUUID(); let stops = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => { if (++stops === 1) throw new ManagedWorkerStopRefusedError(); } });
  const cap = await server.listen(); const first = await peer(cap);
  try {
    first.socket.write([JSON.stringify({ id: 'a', epoch, method: 'stop' }),
      JSON.stringify({ id: 'b', epoch, method: 'stop' })].join('\n') + '\n');
    assert.deepEqual(await first.read(), { id: 'a', error: 'stop-refused' });
    assert.deepEqual(await first.read(), { id: 'b', error: 'stop-refused' });
    assert.equal(stops, 1, 'concurrent waiters share the refused attempt');
    first.send({ id: 'a', epoch, method: 'stop' });
    assert.deepEqual(await first.read(), { id: 'a', error: 'refused' });
    assert.equal(stops, 1, 'replaying the same request ID is not a new attempt');
    first.socket.destroy();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1, 'sender EOF never retries the refused stop');
    const second = await peer(cap);
    try {
      second.send({ id: 'explicit-new-attempt', epoch, method: 'stop' });
      assert.deepEqual(await second.read(), { id: 'explicit-new-attempt', result: { stopped: true } });
      assert.equal(stops, 2);
    } finally { second.socket.destroy(); }
  } finally { first.socket.destroy(); await server.close(); }
});
