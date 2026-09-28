import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { confirmManagedNativeOwner } from '../src/desktop/managed-native-owner-confirmation.js';
import { DesktopIpcClient, encodeFrame, FrameDecoder, type IpcObject } from '../src/desktop/ipc-client.js';

class Link extends Duplex {
  readonly decoder = new FrameDecoder();
  constructor(readonly broker: Broker, readonly clientId: string) { super(); }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      for (const message of this.decoder.push(chunk)) void this.broker.receive(this, message);
      callback();
    } catch (error) { callback(error instanceof Error ? error : new Error('fixture write failed')); }
  }
  send(message: IpcObject): void { if (!this.destroyed) this.push(encodeFrame(message)); }
}

class Broker {
  readonly links: Link[] = [];
  handledBy = 'managed-owner';
  discovery: 'success' | 'reject' | 'eof' = 'success';
  lastDiscovery: IpcObject | null = null;
  beforeDiscovery: (() => Promise<void>) | null = null;
  connect(id: string): () => Duplex {
    return () => { const link = new Link(this, id); this.links.push(link); return link; };
  }
  async receive(link: Link, message: IpcObject): Promise<void> {
    if (message.type !== 'request' || typeof message.requestId !== 'string') return;
    if (message.method === 'initialize') {
      link.send({ type: 'response', requestId: message.requestId, resultType: 'success',
        handledByClientId: 'broker', result: { clientId: link.clientId } });
      return;
    }
    if (message.method !== 'thread-owner-discovery') return;
    this.lastDiscovery = message;
    await this.beforeDiscovery?.();
    if (this.discovery === 'eof') { link.destroy(); return; }
    if (this.discovery === 'reject') {
      link.send({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' });
      return;
    }
    link.send({ type: 'response', requestId: message.requestId, resultType: 'success',
      handledByClientId: this.handledBy, result: { supportsUntrustedAppInput: false } });
  }
}

async function ownedClient(broker: Broker): Promise<DesktopIpcClient> {
  const client = new DesktopIpcClient(broker.connect('managed-owner'), 100);
  await client.connect();
  return client;
}

test('confirms exact current managed owner through an independent scoped discovery probe', async () => {
  const broker = new Broker(); const owned = await ownedClient(broker);
  const result = await confirmManagedNativeOwner({ ownedClient: owned,
    createProbeClient: () => new DesktopIpcClient(broker.connect('probe'), 100), taskId: 'task-one',
    assertOwnerCurrent: () => {} });
  assert.deepEqual(result, { clientId: 'managed-owner', connectionEpoch: 1 });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual((broker.lastDiscovery as IpcObject).params, { hostId: 'local', conversationId: 'task-one' });
  assert.deepEqual(owned.connectionIdentity, result);
  assert.equal(broker.links.at(-1)?.destroyed, true);
  owned.close();
});

test('refuses foreign discovery, rejected or EOF probe without closing owned connection', async () => {
  for (const mode of ['foreign', 'reject', 'eof'] as const) {
    const broker = new Broker(); const owned = await ownedClient(broker);
    if (mode === 'foreign') broker.handledBy = 'other-owner'; else broker.discovery = mode;
    await assert.rejects(confirmManagedNativeOwner({ ownedClient: owned,
      createProbeClient: () => new DesktopIpcClient(broker.connect('probe'), 20), taskId: 'task-one',
      assertOwnerCurrent: () => {} }), /confirmation unavailable/);
    assert.deepEqual(owned.connectionIdentity, { clientId: 'managed-owner', connectionEpoch: 1 });
    owned.close();
  }
});

test('an owned-client candidate is refused before disposable-probe cleanup', async () => {
  const broker = new Broker(); const owned = await ownedClient(broker);
  await assert.rejects(confirmManagedNativeOwner({ ownedClient: owned,
    createProbeClient: () => owned, taskId: 'task-one', assertOwnerCurrent: () => {} }), /confirmation unavailable/);
  assert.deepEqual(owned.connectionIdentity, { clientId: 'managed-owner', connectionEpoch: 1 });
  assert.equal(broker.links.length, 1);
  owned.close();
});

test('same client ID after owned EOF/reconnect fails the captured epoch fence', async () => {
  const broker = new Broker(); const owned = await ownedClient(broker);
  broker.beforeDiscovery = async () => { owned.close(); await owned.connect(); };
  await assert.rejects(confirmManagedNativeOwner({ ownedClient: owned,
    createProbeClient: () => new DesktopIpcClient(broker.connect('probe'), 100), taskId: 'task-one',
    assertOwnerCurrent: () => {} }), /confirmation unavailable/);
  assert.deepEqual(owned.connectionIdentity, { clientId: 'managed-owner', connectionEpoch: 2 });
  owned.close();
});

test('identity is null while disconnected and scope/current checks fail before probe work', async () => {
  const broker = new Broker(); const owned = new DesktopIpcClient(broker.connect('managed-owner'), 100);
  assert.equal(owned.connectionIdentity, null);
  let probes = 0;
  await assert.rejects(confirmManagedNativeOwner({ ownedClient: owned,
    createProbeClient: () => { probes++; return new DesktopIpcClient(broker.connect('probe'), 100); }, taskId: '',
    assertOwnerCurrent: () => {} }), /confirmation unavailable/);
  assert.equal(probes, 0);
  await owned.connect();
  await assert.rejects(confirmManagedNativeOwner({ ownedClient: owned,
    createProbeClient: () => { probes++; return new DesktopIpcClient(broker.connect('probe'), 100); }, taskId: 'task-one',
    assertOwnerCurrent: () => { throw new Error('stale'); } }), /confirmation unavailable/);
  assert.equal(probes, 0);
  owned.close(); assert.equal(owned.connectionIdentity, null);
});
