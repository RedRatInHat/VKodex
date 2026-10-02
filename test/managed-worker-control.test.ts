import assert from 'node:assert/strict';
import { connect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ManagedWorkerControlServer, ManagedWorkerStopRefusedError, type ManagedWorkerControlOptions, type ManagedWorkerVkScope } from '../src/desktop/managed-worker-control.js';
import { ManagedWorkerControlClient, ManagedWorkerControlUnknownError,
  ManagedWorkerHandoffUnknownError } from
  '../src/desktop/managed-worker-control-client.js';

type VkV2Scope = ManagedWorkerVkScope;
type VkV2ClientApi = ManagedWorkerControlClient & {
  ingressStatusV2(expected: VkV2Scope): Promise<Record<string, unknown>>;
  submitVkV2(expected: VkV2Scope, request: Record<string, unknown>): Promise<Record<string, unknown>>;
  vkSubmissionStatusByOperationIdV2(expected: VkV2Scope, operationId: string): Promise<Record<string, unknown> | null>;
};
const v2Client = (client: ManagedWorkerControlClient): VkV2ClientApi => client as VkV2ClientApi;

async function fakeControl(respond: (frame: Record<string, unknown>) => unknown) {
  const token = Buffer.alloc(32, 7).toString('base64url');
  const server = createServer(socket => {
    let buffer = '', authenticated = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += String(chunk);
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (!authenticated) { authenticated = true; socket.write('{"ok":true}\n'); continue; }
        socket.write(JSON.stringify({ id: frame.id, result: respond(frame) }) + '\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { cap: { host: '127.0.0.1' as const, port: address.port, token },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

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
    b.send({ id: 'no-canary', epoch, taskId: 'owned-thread',
      method: 'cli-canary-evidence-v1' });
    assert.equal((await b.read()).error, 'refused');
    assert.equal(stops, 0);
    b.socket.destroy();
  } finally { await server.close(); }
  assert.equal(stops, 0, 'listener shutdown is not worker shutdown');
});

test('opt-in handoff control binds exact worker scope and returns a one-time proof', async () => {
  const epoch = randomUUID(), taskId = 'owned-thread';
  let revokes = 0, qualifications = 0;
  const proof = { ownerEpoch: epoch, taskId, backendGeneration: 2, registryRevision: 5,
    host: { pid: 41, birthTicks: '123' }, backend: { pid: 42, birthTicks: '124', generation: 2 },
    endpointRef: randomUUID(), nonce: randomUUID() };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId,
    status: () => ({ hostState: 'running', backendGeneration: 2, nativeState: 'connected', nativeRevision: 1 }),
    requestStop: async () => { throw new Error('stop must not run'); },
    handoff: { revoke: expected => {
      assert.deepEqual(expected, { backendGeneration: 2, registryRevision: 5 }); revokes++;
      return { backendGeneration: 2, registryRevision: 5 };
    }, qualify: async expected => {
      assert.deepEqual(expected, { backendGeneration: 2, registryRevision: 5 }); qualifications++;
      return proof;
    } } });
  const cap = await server.listen();
  try {
    const client = new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId });
    const bad = await peer(cap);
    bad.send({ id: 'wrong-task', epoch, taskId: 'other', method: 'revoke-ingress-v1',
      backendGeneration: 2, registryRevision: 5 });
    assert.equal((await bad.read()).error, 'refused');
    bad.send({ id: 'wrong-revision', epoch, taskId, method: 'revoke-ingress-v1',
      backendGeneration: 2, registryRevision: 4, extra: true });
    assert.equal((await bad.read()).error, 'refused');
    bad.socket.destroy();
    assert.deepEqual(await client.revokeIngress({ backendGeneration: 2, registryRevision: 5 }),
      { backendGeneration: 2, registryRevision: 5 });
    assert.deepEqual(await client.qualifyHandoff({ backendGeneration: 2, registryRevision: 5 }), proof);
    assert.equal(revokes, 1); assert.equal(qualifications, 1);
  } finally { await server.close(); }
});

test('handoff qualification timeout is unknown and does not cancel its worker-local proof', async () => {
  const epoch = randomUUID(), taskId = 'own', expected = { backendGeneration: 1, registryRevision: 3 };
  let release!: () => void, qualifications = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId,
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: 'connected', nativeRevision: 0 }),
    requestStop: async () => { throw new Error('stop must not run'); },
    handoff: { revoke: () => expected, qualify: async () => {
      qualifications++; await waiting;
      return { ownerEpoch: epoch, taskId, ...expected, host: { pid: 1, birthTicks: '11' },
        backend: { pid: 2, birthTicks: '12', generation: 1 },
        endpointRef: randomUUID(), nonce: randomUUID() };
    } } });
  const cap = await server.listen();
  try {
    const client = new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId, timeoutMs: 80 });
    await assert.rejects(client.qualifyHandoff(expected), ManagedWorkerHandoffUnknownError);
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(qualifications, 1, 'EOF did not cancel or replay the proof operation');
    assert.equal((await client.status()).hostState, 'running');
  } finally { release(); await server.close(); }
});

test('control client status reads exact scoped health without requesting a worker action', async () => {
  const epoch = randomUUID(); let stops = 0, reads = 0;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => { reads++; return { hostState: 'frontend-unavailable', backendGeneration: 2,
      nativeState: 'disconnected', nativeRevision: 7 }; },
    requestStop: async () => { stops++; } });
  const cap = await server.listen();
  try {
    const client = new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId: 'own' });
    assert.deepEqual(await client.status(), { ownerEpoch: epoch, taskId: 'own',
      hostState: 'frontend-unavailable', backendGeneration: 2,
      nativeState: 'disconnected', nativeRevision: 7 });
    assert.equal(reads, 1);
    assert.equal(stops, 0);
  } finally { await server.close(); }
});

test('opt-in CLI canary control returns only scoped content-free evidence', async () => {
  const epoch = randomUUID(), taskId = 'isolated-canary';
  let reads = 0, leak = false, sparse = false;
  const evidence = { taskId, ownerEpoch: epoch, backendGeneration: 4,
    nativeState: 'connected' as const, threadStatus: 'idle' as const,
    turns: [], turnsPageComplete: true, goalEmpty: true, queueEmpty: true,
    acceptedStartSha256: [], commandInFlight: 0, commandUnconfirmed: false,
    requestsUnresolved: 0, pendingNativeOperations: 0, pendingEvents: 0 };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId,
    status: () => ({ hostState: 'running', backendGeneration: 4,
      nativeState: 'connected', nativeRevision: 0 }),
    requestStop: async () => { throw new Error('stop must not run'); },
    cliCanaryEvidence: async () => { reads++; return leak ?
      { ...evidence, prompt: 'must-not-leak' } : sparse ?
      { ...evidence, turns: Array(1) } : evidence; } });
  const cap = await server.listen();
  try {
    const client = new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId });
    assert.deepEqual(await client.nativeCliCanaryEvidence(), evidence);
    const raw = await peer(cap);
    raw.send({ id: 'wrong', epoch, taskId: 'other', method: 'cli-canary-evidence-v1' });
    assert.equal((await raw.read()).error, 'refused');
    raw.send({ id: 'extra', epoch, taskId, method: 'cli-canary-evidence-v1', extra: true });
    assert.equal((await raw.read()).error, 'refused');
    raw.socket.destroy();
    assert.equal(reads, 1);
    leak = true;
    await assert.rejects(client.nativeCliCanaryEvidence(),
      ManagedWorkerControlUnknownError);
    assert.equal(reads, 2);
    leak = false; sparse = true;
    await assert.rejects(client.nativeCliCanaryEvidence(),
      ManagedWorkerControlUnknownError);
    assert.equal(reads, 3);
  } finally { await server.close(); }
});

test('control client status fails closed on malformed or wrong-scope metadata', async () => {
  const epoch = randomUUID();
  const replies = [
    { ownerEpoch: randomUUID(), taskId: 'own', hostState: 'running', backendGeneration: 1,
      nativeState: 'connected', nativeRevision: 0 },
    { ownerEpoch: epoch, taskId: 'other', hostState: 'running', backendGeneration: 1,
      nativeState: 'connected', nativeRevision: 0 },
    { ownerEpoch: epoch, taskId: 'own', hostState: 'running', backendGeneration: 0,
      nativeState: 'connected', nativeRevision: 0 },
    { ownerEpoch: epoch, taskId: 'own', hostState: 'running', backendGeneration: 1,
      nativeState: 'connected', nativeRevision: 0, token: 'must-not-pass' },
  ];
  const server = createServer(socket => {
    let buffer = '', authenticated = false;
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        if (!authenticated) { authenticated = true; socket.write('{"ok":true}\n'); continue; }
        socket.write(JSON.stringify({ id: frame.id, result: replies.shift() }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const client = new ManagedWorkerControlClient({ host: '127.0.0.1', port: address.port,
      token: 'a'.repeat(43), ownerEpoch: epoch, taskId: 'own' });
    for (let i = 0; i < 4; i++) await assert.rejects(client.status(), ManagedWorkerControlUnknownError);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('versioned diagnosis returns only fixed startup metadata and no private callback details', async () => {
  const epoch = randomUUID();
  const diagnosis = { schemaVersion: 1 as const, startupPhase: 'bootstrapping' as const,
    daemonState: 'failed' as const, failureCode: 'startup-unavailable' as const,
    registryState: 'backend_registered' as const, owner: null };
  const owner = { startupStage: 'ready' as const, bootstrapEventCount: 0,
    bootstrapNotifications: { status: 0, settings: 0, goal: 0, usage: 0,
      'startup-or-warning': 0, turn: 0, item: 0, other: 0 },
    bootstrapPendingRequests: 0, bootstrapBoundary: null,
    lastRequestFailure: { category: 'settings-refused' as const, count: 2, atMs: 1780000000000 } };
  let mode: 'normal' | 'category' | 'direct-stock' | 'stock-policy' | 'raw' = 'normal';
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    diagnose: () => mode === 'raw' ? { ...diagnosis, owner: { ...owner,
      lastRequestFailure: { category: 'C:/private/secret-token', count: 2, atMs: 1780000000000 } } } as never
      : mode === 'category' ? { ...diagnosis, owner }
      : mode === 'direct-stock' ? { ...diagnosis, owner: { ...owner,
        lastRequestFailure: { ...owner.lastRequestFailure,
          category: 'direct-stock-start-refused' as const } } }
      : mode === 'stock-policy' ? { ...diagnosis, startupPhase: 'private-loaded',
        registryState: 'reserved', bootstrapFailureCode: 'stock-policy-unqualified' } : diagnosis,
    requestStop: async () => { throw new ManagedWorkerStopRefusedError(); } });
  const cap = await server.listen(); const client = await peer(cap);
  try {
    client.send({ id: 'd', epoch, method: 'diagnose-v1' });
    assert.deepEqual(await client.read(), { id: 'd', result: { ownerEpoch: epoch, taskId: 'own', ...diagnosis } });
    mode = 'category';
    client.send({ id: 'category', epoch, method: 'diagnose-v1' });
    assert.deepEqual(await client.read(), { id: 'category', result: { ownerEpoch: epoch,
      taskId: 'own', ...diagnosis, owner } });
    mode = 'direct-stock';
    client.send({ id: 'direct-stock', epoch, method: 'diagnose-v1' });
    assert.deepEqual(await client.read(), { id: 'direct-stock', result: { ownerEpoch: epoch,
      taskId: 'own', ...diagnosis, owner: { ...owner,
        lastRequestFailure: { ...owner.lastRequestFailure,
          category: 'direct-stock-start-refused' } } } });
    mode = 'stock-policy';
    client.send({ id: 'stock-policy', epoch, method: 'diagnose-v1' });
    assert.deepEqual(await client.read(), { id: 'stock-policy', result: { ownerEpoch: epoch,
      taskId: 'own', ...diagnosis, startupPhase: 'private-loaded',
      registryState: 'reserved', bootstrapFailureCode: 'stock-policy-unqualified' } });
    mode = 'raw';
    client.send({ id: 'raw', epoch, method: 'diagnose-v1' });
    assert.deepEqual(await client.read(), { id: 'raw', error: 'diagnosis-unavailable' });
    client.send({ id: 's', epoch, method: 'stop' });
    assert.deepEqual(await client.read(), { id: 's', error: 'stop-refused' });
  } finally { client.socket.destroy(); await server.close(); }
});

test('diagnose-v1 accepts only the fixed bounded composer ingress summary', async () => {
  const epoch = randomUUID();
  const diagnosis = { schemaVersion: 1 as const, startupPhase: 'ready' as const,
    daemonState: 'ready' as const, failureCode: null, registryState: 'ready' as const,
    owner: { startupStage: 'ready' as const, bootstrapEventCount: 0,
      bootstrapNotifications: { status: 0, settings: 0, goal: 0, usage: 0,
        'startup-or-warning': 0, turn: 0, item: 0, other: 0 },
      bootstrapPendingRequests: 0, bootstrapBoundary: null,
      composerIngress: {
        directStartTurn: { seen: 2, handled: 1, refused: 1, lastAtMs: 1780000000000 },
        queuedFollowUpsState: { seen: 3, handled: 2, refused: 1, lastAtMs: 1780000000001 },
      } } };
  type Mode = 'valid' | 'extra' | 'raw' | 'count' | 'time';
  let mode: Mode = 'valid';
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: 'connected', nativeRevision: 1 }),
    diagnose: () => {
      const composerIngress = structuredClone(diagnosis.owner.composerIngress);
      if (mode === 'extra') Object.assign(composerIngress.directStartTurn, { requestId: 'private-request' });
      if (mode === 'raw') Object.assign(composerIngress.queuedFollowUpsState, { params: { prompt: 'private' } });
      if (mode === 'count') composerIngress.directStartTurn.seen = 256;
      if (mode === 'time') composerIngress.queuedFollowUpsState.lastAtMs = Number.MAX_SAFE_INTEGER + 1;
      return { ...diagnosis, owner: { ...diagnosis.owner, composerIngress } };
    },
    requestStop: async () => { throw new Error('stop must not run'); } });
  const cap = await server.listen(); const client = await peer(cap);
  try {
    client.send({ id: 'valid', epoch, method: 'diagnose-v1' });
    assert.deepEqual(await client.read(), { id: 'valid', result: { ownerEpoch: epoch, taskId: 'own', ...diagnosis } });
    for (const invalid of ['extra', 'raw', 'count', 'time'] as const) {
      mode = invalid;
      client.send({ id: invalid, epoch, method: 'diagnose-v1' });
      assert.deepEqual(await client.read(), { id: invalid, error: 'diagnosis-unavailable' });
    }
  } finally { client.socket.destroy(); await server.close(); }
});

test('diagnose-v1 accepts only exact scoped refusal-only evidence and rejects forged or extra fields', async () => {
  const epoch = randomUUID();
  const evidence = { backendGeneration: 7, commandInFlight: 0, commandUnconfirmed: 0,
    operationJournalRows: 0, settingsJournalRows: 0, acceptedReceipts: 0, acceptedQueue: 0,
    pendingBackendRequests: 0, pendingNativeOperations: 0, pendingNativeEvents: 0,
    intentStore: 'absent' };
  const diagnosis = { schemaVersion: 1 as const, startupPhase: 'ready' as const,
    daemonState: 'ready' as const, failureCode: null, registryState: 'ready' as const,
    owner: { startupStage: 'ready' as const, bootstrapEventCount: 0,
      bootstrapNotifications: { status: 0, settings: 0, goal: 0, usage: 0,
        'startup-or-warning': 0, turn: 0, item: 0, other: 0 },
      bootstrapPendingRequests: 0, bootstrapBoundary: null },
    refusalOnlyEvidence: evidence };
  type Mode = 'valid' | 'forged' | 'extra' | 'unscoped' | 'not-ready';
  let mode: Mode = 'valid';
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: 'connected', nativeRevision: 1 }),
    diagnose: () => {
      const proof = { ...evidence };
      if (mode === 'forged') proof.pendingNativeEvents = 1;
      if (mode === 'extra') Object.assign(proof, { prompt: 'must never cross control socket' });
      return { ...diagnosis, ...(mode === 'unscoped' ? { taskId: 'another-task' } : {}),
        ...(mode === 'not-ready' ? { owner: { ...diagnosis.owner, startupStage: 'connecting' } } : {}),
        refusalOnlyEvidence: proof } as never;
    }, requestStop: async () => { throw new Error('stop must not run'); } });
  const cap = await server.listen(); const client = await peer(cap);
  try {
    for (const invalid of ['forged', 'extra', 'unscoped', 'not-ready'] as const) {
      mode = invalid;
      client.send({ id: invalid, epoch, method: 'diagnose-v1' });
      assert.deepEqual(await client.read(), { id: invalid, error: 'diagnosis-unavailable' });
    }
    mode = 'valid';
    client.send({ id: 'valid-refusal-proof', epoch, method: 'diagnose-v1' });
    assert.deepEqual(await client.read(), { id: 'valid-refusal-proof', result: {
      ownerEpoch: epoch, taskId: 'own', ...diagnosis } });
  } finally { client.socket.destroy(); await server.close(); }
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

test('VK control is opt-in, exact task and epoch scoped, and never echoes prompt', async () => {
  const epoch = randomUUID(), operationId = randomUUID();
  const request = { operationId, task: { hostId: 'local', threadId: 'own', sourceId: '' },
    text: 'private prompt', inputFiles: [] };
  const calls: string[] = [];
  const options = { ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => {} };
  const absent = new ManagedWorkerControlServer(options as ConstructorParameters<typeof ManagedWorkerControlServer>[0]);
  const absentCap = await absent.listen();
  try {
    const client = await peer(absentCap);
    client.send({ id: 'absent', epoch, taskId: 'own', method: 'submit-vk-v1', request });
    assert.deepEqual(await client.read(), { id: 'absent', error: 'refused' });
    client.socket.destroy();
  } finally { await absent.close(); }
  const server = new ManagedWorkerControlServer({ ...options, vk: {
    submit: async () => { calls.push('submit'); return { submissionId: 'queued-1' }; },
    status: () => { calls.push('exact-status'); return { state: 'accepted', submissionId: 'queued-1' }; },
    statusByOperationId: () => { calls.push('id-status'); return { state: 'accepted', submissionId: 'queued-1' }; },
  } });
  const cap = await server.listen(); const peerOne = await peer(cap);
  try {
    for (const [id, bad] of [
      ['wrong-task', { id: 'wrong-task', epoch, taskId: 'other', method: 'submit-vk-v1', request }],
      ['wrong-epoch', { id: 'wrong-epoch', epoch: randomUUID(), taskId: 'own', method: 'submit-vk-v1', request }],
      ['extra', { id: 'extra', epoch, taskId: 'own', method: 'submit-vk-v1', request, extra: true }],
      ['callback', { id: 'callback', epoch, taskId: 'own', method: 'submit-vk-v1', request: { ...request, beforeSend: true } }],
    ] as const) {
      peerOne.send(bad);
      assert.deepEqual(await peerOne.read(), { id, error: 'refused' });
    }
    assert.deepEqual(calls, []);
    const client = new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId: 'own' });
    assert.deepEqual(await client.submitVk(request), { submissionId: 'queued-1' });
    assert.deepEqual(await client.submitVk({ ...request, operationId: randomUUID(),
      text: '😀'.repeat(16_384) }), { submissionId: 'queued-1' },
    'the 64 KiB UTF-8 boundary is admitted after authentication');
    assert.deepEqual(await client.vkSubmissionStatus(request), { state: 'accepted', submissionId: 'queued-1' });
    assert.deepEqual(await client.vkSubmissionStatusByOperationId(operationId),
      { state: 'accepted', submissionId: 'queued-1' });
    assert.deepEqual(calls, ['submit', 'submit', 'exact-status', 'id-status']);
  } finally { peerOne.socket.destroy(); await server.close(); }
});

test('VK submit continues after authenticated client EOF; oversized UTF-8 prompt never reaches callback', async () => {
  const epoch = randomUUID(), operationId = randomUUID(); let entered = 0, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const request = { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'known' };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => {}, vk: {
      submit: async () => { entered++; await pending; return { submissionId: 'queued-1' }; },
      status: () => ({ state: 'accepted', submissionId: 'queued-1' }),
      statusByOperationId: () => ({ state: 'accepted', submissionId: 'queued-1' }),
    } });
  const cap = await server.listen(); const client = await peer(cap);
  try {
    client.send({ id: 'submit', epoch, taskId: 'own', method: 'submit-vk-v1', request });
    for (let n = 0; entered === 0 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(entered, 1); client.socket.destroy(); finish();
    const second = await peer(cap);
    second.send({ id: 'too-long', epoch, taskId: 'own', method: 'submit-vk-v1',
      request: { ...request, text: '😀'.repeat(20_000) } });
    assert.deepEqual(await second.read(), { id: 'too-long', error: 'refused' });
    assert.equal(entered, 1);
    second.socket.destroy();
  } finally { finish(); client.socket.destroy(); await server.close(); }
});

test('scoped VK v2 serves only the exact frozen owner and backend scope', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const scope: VkV2Scope = Object.freeze({ ownerEpoch: epoch, taskId: 'own', backendGeneration: 7,
    registryRevision: 11, endpointRef });
  const request = { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'private prompt' };
  const calls: string[] = [];
  // V2 is separately opt-in and requires a live full-scope predicate.
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: (expected: typeof scope) => {
      calls.push('scope-current');
      assert.deepEqual(expected, scope);
      return true;
    },
    ingressStatus: (expected: typeof scope) => {
      calls.push('ingress');
      assert.deepEqual(expected, scope);
      return { capability: 'stock-idle-queue-v2' as const, admissionOpen: true };
    },
    submit: async (expected: typeof scope, received) => {
      calls.push('submit');
      assert.deepEqual(expected, scope);
      assert.deepEqual(received, request);
      return { submissionId: 'submission-v2' };
    },
    statusByOperationId: (expected: typeof scope, receivedId: string) => {
      calls.push('status-by-id');
      assert.deepEqual(expected, scope);
      assert.equal(receivedId, operationId);
      return { state: 'accepted', submissionId: 'submission-v2' };
    },
  };
  const serverOptions = { ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 };
  const server = new ManagedWorkerControlServer(serverOptions);
  const cap = await server.listen();
  try {
    const client = v2Client(new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId: 'own' }));
    assert.deepEqual(await client.ingressStatusV2(scope), {
      ownerEpoch: epoch, taskId: 'own', backendGeneration: 7, registryRevision: 11, endpointRef,
      capability: 'stock-idle-queue-v2' as const, admissionOpen: true });
    assert.deepEqual(await client.submitVkV2(scope, request), {
      ownerEpoch: epoch, taskId: 'own', backendGeneration: 7, registryRevision: 11, endpointRef,
      submissionId: 'submission-v2' });
    assert.deepEqual(await client.vkSubmissionStatusByOperationIdV2(scope, operationId), {
      ownerEpoch: epoch, taskId: 'own', backendGeneration: 7, registryRevision: 11, endpointRef,
      state: 'accepted', submissionId: 'submission-v2' });
    assert.ok(calls.indexOf('scope-current') < calls.indexOf('submit'));
    assert.deepEqual(calls.filter(call => call !== 'scope-current'), ['ingress', 'submit', 'status-by-id']);
  } finally { await server.close(); }
});

test('v2 exact status null envelope is authoritative only while its captured scope remains current', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const scope: VkV2Scope = Object.freeze({ ownerEpoch: epoch, taskId: 'own', backendGeneration: 7,
    registryRevision: 11, endpointRef });
  let current = scope;
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: expected => expected.ownerEpoch === current.ownerEpoch && expected.taskId === current.taskId
      && expected.backendGeneration === current.backendGeneration
      && expected.registryRevision === current.registryRevision && expected.endpointRef === current.endpointRef,
    ingressStatus: () => ({ capability: 'stock-idle-queue-v2', admissionOpen: true }),
    submit: async () => ({ submissionId: 'unused' }),
    statusByOperationId: () => null,
  };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 });
  const cap = await server.listen();
  try {
    const client = await peer(cap);
    try {
      client.send({ id: 'status-null', epoch, taskId: 'own', backendGeneration: 7,
        registryRevision: 11, endpointRef, method: 'vk-submission-status-by-id-v2', operationId });
      assert.deepEqual(await client.read(), { id: 'status-null', result: { ...scope, status: null } });
      current = { ...scope, registryRevision: 12 };
      client.send({ id: 'status-stale', epoch, taskId: 'own', backendGeneration: 7,
        registryRevision: 11, endpointRef, method: 'vk-submission-status-by-id-v2', operationId });
      assert.deepEqual(await client.read(), { id: 'status-stale', error: 'status-unavailable' });
    } finally { client.socket.destroy(); }
  } finally { await server.close(); }
});

test('v2 rejected read callback promises become status-unavailable without unhandled rejection', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: () => true,
    ingressStatus: (() => Promise.reject(new Error('private ingress failure'))) as unknown as
      NonNullable<ManagedWorkerControlOptions['vkV2']>['ingressStatus'],
    submit: async () => ({ submissionId: 'unused' }),
    statusByOperationId: (() => Promise.reject(new Error('private lookup failure'))) as unknown as
      NonNullable<ManagedWorkerControlOptions['vkV2']>['statusByOperationId'],
  };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 });
  const cap = await server.listen();
  try {
    const client = await peer(cap);
    try {
      client.send({ id: 'ingress-rejects', epoch, taskId: 'own', backendGeneration: 7,
        registryRevision: 11, endpointRef, method: 'vk-ingress-status-v2' });
      assert.deepEqual(await client.read(), { id: 'ingress-rejects', error: 'status-unavailable' });
      await new Promise<void>(resolve => setImmediate(resolve));
      client.send({ id: 'lookup-rejects', epoch, taskId: 'own', backendGeneration: 7,
        registryRevision: 11, endpointRef, method: 'vk-submission-status-by-id-v2', operationId });
      assert.deepEqual(await client.read(), { id: 'lookup-rejects', error: 'status-unavailable' });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, [], 'read callback rejections are observed and remain private');
    } finally { client.socket.destroy(); }
  } finally { process.off('unhandledRejection', onUnhandled); await server.close(); }
});

test('scoped VK v2 refuses malformed scope and v1-only owner before callbacks', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const scope: VkV2Scope = { ownerEpoch: epoch, taskId: 'own', backendGeneration: 7,
    registryRevision: 11, endpointRef };
  let calls = 0;
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: (expected: typeof scope) => expected.ownerEpoch === scope.ownerEpoch
      && expected.taskId === scope.taskId
      && expected.backendGeneration === scope.backendGeneration
      && expected.registryRevision === scope.registryRevision
      && expected.endpointRef === scope.endpointRef,
    ingressStatus: (_expected: typeof scope) => { calls++; return {
      capability: 'stock-idle-queue-v2' as const, admissionOpen: true }; },
    submit: async (_expected: typeof scope, _request: { operationId: string }) => {
      calls++; return { submissionId: 'submission-v2' };
    },
    statusByOperationId: (_expected: typeof scope, _operationId: string) => {
      calls++; return { state: 'unknown', submissionId: null };
    },
  };
  const options = { ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 };
  const absent = new ManagedWorkerControlServer({ ownerEpoch: options.ownerEpoch, taskId: options.taskId,
    status: options.status, requestStop: options.requestStop });
  const absentCap = await absent.listen();
  try {
    const client = await peer(absentCap);
    client.send({ id: 'v1-only', epoch, taskId: 'own', backendGeneration: 7,
      registryRevision: 11, endpointRef, method: 'vk-ingress-status-v2' });
    assert.deepEqual(await client.read(), { id: 'v1-only', error: 'refused' });
    client.send({ id: 'v1-only-submit', epoch, taskId: 'own', backendGeneration: 7,
      registryRevision: 11, endpointRef, method: 'submit-vk-v2',
      request: { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'fixture' } });
    assert.deepEqual(await client.read(), { id: 'v1-only-submit', error: 'refused' });
    client.socket.destroy();
  } finally { await absent.close(); }

  const server = new ManagedWorkerControlServer(options as ConstructorParameters<typeof ManagedWorkerControlServer>[0]);
  const cap = await server.listen();
  try {
    const client = await peer(cap);
    try {
      const valid = { epoch, taskId: 'own', backendGeneration: 7,
        registryRevision: 11, endpointRef, method: 'vk-ingress-status-v2' };
      const malformed = [
        ['missing', { ...valid, endpointRef: undefined }],
        ['extra', { ...valid, extra: true }],
        ['wrong-generation', { ...valid, backendGeneration: 8 }],
        ['wrong-revision', { ...valid, registryRevision: 12 }],
        ['wrong-endpoint', { ...valid, endpointRef: randomUUID() }],
        ['wrong-epoch', { ...valid, epoch: randomUUID() }],
        ['wrong-task', { ...valid, taskId: 'other' }],
      ] as const;
      for (const [id, frame] of malformed) {
        client.send({ ...frame, id });
        assert.deepEqual(await client.read(), { id, error: 'refused' });
      }
      assert.equal(calls, 0);
    } finally { client.socket.destroy(); }
  } finally { await server.close(); }
  void operationId;
});

test('v2 malformed, extra, unsafe, or mismatched submission scope never calls trusted callbacks', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const scope: VkV2Scope = Object.freeze({ ownerEpoch: epoch, taskId: 'own', backendGeneration: 7,
    registryRevision: 11, endpointRef });
  const request = { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'fixture' };
  let currentChecks = 0, ingressCalls = 0, submitCalls = 0, statusCalls = 0;
  let currentResult: unknown = true;
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: (expected: typeof scope) => {
      currentChecks++;
      if (currentResult === 'throw') throw new Error('private detail');
      if (currentResult !== true) return currentResult as boolean;
      return expected.ownerEpoch === scope.ownerEpoch
        && expected.taskId === scope.taskId
        && expected.backendGeneration === scope.backendGeneration
        && expected.registryRevision === scope.registryRevision
        && expected.endpointRef === scope.endpointRef;
    },
    ingressStatus: (_expected: typeof scope) => { ingressCalls++; return { capability: 'stock-idle-queue-v2' as const, admissionOpen: true }; },
    submit: async (_expected: typeof scope, _request) => { submitCalls++; return { submissionId: 'submission-v2' }; },
    statusByOperationId: (_expected: typeof scope, _operationId: string) => { statusCalls++; return null; },
  };
  const options = { ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 };
  const server = new ManagedWorkerControlServer(options as ConstructorParameters<typeof ManagedWorkerControlServer>[0]); const cap = await server.listen();
  try {
    const client = await peer(cap);
    try {
      const valid = { epoch, taskId: 'own', backendGeneration: 7, registryRevision: 11, endpointRef,
        method: 'submit-vk-v2', request };
      const malformed: Array<[string, Record<string, unknown>]> = [
        ['missing-endpoint', { ...valid, endpointRef: undefined }],
        ['extra-key', { ...valid, extra: true }],
        ['zero-generation', { ...valid, backendGeneration: 0 }],
        ['negative-revision', { ...valid, registryRevision: -1 }],
        ['empty-endpoint', { ...valid, endpointRef: '' }],
        ['wrong-epoch', { ...valid, epoch: randomUUID() }],
        ['wrong-task', { ...valid, taskId: 'other' }],
      ];
      for (const [id, frame] of malformed) {
        client.send({ ...frame, id });
        assert.deepEqual(await client.read(), { id, error: 'refused' });
      }
      assert.equal(currentChecks, 0, 'malformed or foreign owner scope is refused before the scope callback');
      const stale: Array<[string, Record<string, unknown>]> = [
        ['wrong-endpoint', { ...valid, endpointRef: randomUUID() }],
        ['wrong-generation', { ...valid, backendGeneration: 8 }],
        ['wrong-revision', { ...valid, registryRevision: 12 }],
      ];
      for (const [id, frame] of stale) {
        client.send({ ...frame, id });
        assert.deepEqual(await client.read(), { id, error: 'refused' });
      }
      assert.equal(currentChecks, stale.length, 'valid-shaped stale scope reaches the authoritative predicate');
      assert.equal(ingressCalls + submitCalls + statusCalls, 0);
      for (const result of [false, undefined, 1, 'true', null, Promise.resolve(true)]) {
        currentResult = result;
        const before: number = currentChecks;
        client.send({ ...valid, id: `predicate-${String(result)}` });
        assert.equal((await client.read()).error, 'refused');
        assert.equal(currentChecks, before + 1, 'valid full scope reaches the trusted predicate exactly once');
      }
      currentResult = 'throw';
      const beforeThrow = currentChecks;
      client.send({ ...valid, id: 'predicate-throws' });
      assert.equal((await client.read()).error, 'refused');
      assert.equal(currentChecks, beforeThrow + 1);
      assert.equal(submitCalls, 0, 'only synchronous true authorizes the submit callback');
      assert.equal(ingressCalls + statusCalls, 0);
    } finally { client.socket.destroy(); }
  } finally { await server.close(); }
});

test('v2 client snapshots its caller scope before deferred submit completion', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const original: VkV2Scope = { ownerEpoch: epoch, taskId: 'own', backendGeneration: 7,
    registryRevision: 11, endpointRef };
  const supplied = { ...original };
  const request = { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'fixture' };
  let entered!: () => void, finish!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let currentScope = original;
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: (expected: VkV2Scope) => expected.ownerEpoch === currentScope.ownerEpoch
      && expected.taskId === currentScope.taskId && expected.backendGeneration === currentScope.backendGeneration
      && expected.registryRevision === currentScope.registryRevision && expected.endpointRef === currentScope.endpointRef,
    ingressStatus: (_expected: VkV2Scope) => ({ capability: 'stock-idle-queue-v2' as const, admissionOpen: true }),
    submit: async (expected: VkV2Scope) => {
      assert.notEqual(expected, supplied, 'callback gets a cloned scope, not caller-owned mutable state');
      assert.deepEqual(expected, original);
      entered(); await pending;
      return { submissionId: 'deferred-v2' };
    },
    statusByOperationId: (_expected: VkV2Scope) => ({ state: 'accepted', submissionId: 'deferred-v2' }),
  };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 });
  const cap = await server.listen();
  const client = v2Client(new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId: 'own' }));
  try {
    const submission = client.submitVkV2(supplied, request);
    await waiting;
    currentScope = { ...original, registryRevision: 12 };
    supplied.backendGeneration = 99; supplied.endpointRef = randomUUID();
    finish();
    assert.deepEqual(await submission, { ...original, submissionId: 'deferred-v2' });
  } finally { finish(); await server.close(); }
});

test('v2 client rejects wrong-scope and extra-key replies as unknown', async t => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const scope: VkV2Scope = { ownerEpoch: epoch, taskId: 'own', backendGeneration: 7, registryRevision: 11, endpointRef };
  const request = { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'fixture' };
  const valid = { ...scope, submissionId: 'submission-v2' };
  const cases: Array<{ name: string; reply: Record<string, unknown> }> = [
    { name: 'wrong owner scope', reply: { ...valid, taskId: 'other' } },
    { name: 'extra reply key', reply: { ...valid, extra: true } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const stub = await fakeControl(() => scenario.reply);
    const client = v2Client(new ManagedWorkerControlClient({ ...stub.cap, ownerEpoch: epoch, taskId: 'own' }));
    try { await assert.rejects(client.submitVkV2(scope, request), ManagedWorkerControlUnknownError); }
    finally { await stub.close(); }
  });
});

test('v2 EOF does not replay an accepted write and exact by-ID lookup observes late completion', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const scope: VkV2Scope = Object.freeze({ ownerEpoch: epoch, taskId: 'own', backendGeneration: 7,
    registryRevision: 11, endpointRef });
  const request = { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'fixture' };
  let writes = 0, accepted = false, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: (expected: typeof scope) => { assert.deepEqual(expected, scope); return true; },
    ingressStatus: (_expected: typeof scope) => ({ capability: 'stock-idle-queue-v2' as const, admissionOpen: true }),
    submit: async (_expected: typeof scope) => { writes++; await pending; accepted = true; return { submissionId: 'late-v2' }; },
    statusByOperationId: (_expected: typeof scope, received: string) => {
      assert.equal(received, operationId);
      return accepted ? { state: 'accepted', submissionId: 'late-v2' } : { state: 'unknown', submissionId: null };
    },
  };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own', authenticatedIdleTimeoutMs: 40,
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 });
  const cap = await server.listen();
  const client = v2Client(new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId: 'own', timeoutMs: 80 }));
  try {
    await assert.rejects(client.submitVkV2(scope, request), ManagedWorkerControlUnknownError);
    assert.equal(writes, 1);
    assert.deepEqual(await client.vkSubmissionStatusByOperationIdV2(scope, operationId), {
      ...scope, state: 'unknown', submissionId: null });
    finish();
    for (let n = 0; !accepted && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await client.vkSubmissionStatusByOperationIdV2(scope, operationId), {
      ...scope, state: 'accepted', submissionId: 'late-v2' });
    assert.equal(writes, 1, 'EOF never retries the original write; only an explicit read follows');
  } finally { finish(); await server.close(); }
});

test('v2 stale operation status is unknown, not a successful missing-row null', async () => {
  const epoch = randomUUID(), endpointRef = randomUUID(), operationId = randomUUID();
  const scope: VkV2Scope = Object.freeze({ ownerEpoch: epoch, taskId: 'own', backendGeneration: 7,
    registryRevision: 11, endpointRef });
  let statusCalls = 0;
  const vkV2: NonNullable<ManagedWorkerControlOptions['vkV2']> = {
    isScopeCurrent: (_expected: typeof scope) => false,
    ingressStatus: (_expected: typeof scope) => ({ capability: 'stock-idle-queue-v2' as const, admissionOpen: false }),
    submit: async () => { throw new Error('stale scope must not submit'); },
    statusByOperationId: (_expected: typeof scope) => { statusCalls++; return null; },
  };
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    status: () => ({ hostState: 'running', backendGeneration: 7, nativeState: null, nativeRevision: 11 }),
    requestStop: async () => {}, vkV2 });
  const cap = await server.listen();
  const client = v2Client(new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId: 'own' }));
  try {
    await assert.rejects(client.vkSubmissionStatusByOperationIdV2(scope, operationId), ManagedWorkerControlUnknownError);
    assert.equal(statusCalls, 0, 'stale scope cannot be confused with an authoritative not-found status');
  } finally { await server.close(); }
});

test('client timeout is unknown, does not replay, and requires explicit by-ID status', async () => {
  const epoch = randomUUID(), operationId = randomUUID(); let writes = 0, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let accepted = false;
  const server = new ManagedWorkerControlServer({ ownerEpoch: epoch, taskId: 'own',
    authenticatedIdleTimeoutMs: 40,
    status: () => ({ hostState: 'running', backendGeneration: 1, nativeState: null, nativeRevision: 0 }),
    requestStop: async () => {}, vk: {
      submit: async () => { writes++; await pending; accepted = true;
        return { submissionId: 'queued-1' }; },
      status: () => accepted ? { state: 'accepted', submissionId: 'queued-1' } :
        { state: 'unknown', submissionId: null },
      statusByOperationId: () => accepted ? { state: 'accepted', submissionId: 'queued-1' } :
        { state: 'unknown', submissionId: null },
    } });
  const cap = await server.listen();
  const client = new ManagedWorkerControlClient({ ...cap, ownerEpoch: epoch, taskId: 'own', timeoutMs: 80 });
  const request = { operationId, task: { hostId: 'local', threadId: 'own' }, text: 'known' };
  try {
    await assert.rejects(client.submitVk(request), ManagedWorkerControlUnknownError);
    assert.equal(writes, 1);
    assert.deepEqual(await client.vkSubmissionStatusByOperationId(operationId),
      { state: 'unknown', submissionId: null });
    finish();
    for (let n = 0; !accepted && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await client.vkSubmissionStatusByOperationId(operationId),
      { state: 'accepted', submissionId: 'queued-1' });
    assert.equal(writes, 1);
  } finally { finish(); await server.close(); }
});
