import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import DatabaseConstructor from 'better-sqlite3';
import { NativeFirstTurnBootstrapJournal } from '../src/desktop/native-first-turn-bootstrap-journal.js';
import { createPrivateKeyWithDependencies, loadPrivateKeyWithDependencies } from
  '../src/desktop/native-first-turn-private-key-core.js';
import { createNativeFirstTurnPrivateKey } from '../src/desktop/native-first-turn-private-key.js';
import { reconcileUnknownNativeFirstTurnFromPinnedHistory } from
  '../src/desktop/native-first-turn-unknown-reconciler.js';
import type { PinnedDetachedProfileRpc } from '../src/codex/detached-profile-capability.js';

const identity = () => ({ sourceId: 'profile-a', sourceGeneration: randomUUID(),
  ownerEpoch: randomUUID(), threadStartFingerprint: 'c'.repeat(64), backendIdentity: 'b'.repeat(64) });
const fingerprint = (_value: string) => 'a'.repeat(64);
const open = (filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite')) =>
  new NativeFirstTurnBootstrapJournal(filePath);

test('bootstrap journal never creates a missing unprotected parent', () => {
  const directory = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'missing');
  assert.throws(() => open(path.join(directory, 'journal.sqlite')));
  assert.equal(existsSync(directory), false);
});

test('durably sequences thread creation before a first-turn reservation without storing prompt material', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite');
  let journal = open(filePath);
  assert.equal(journal.synchronousMode(), 2);
  const operationId = randomUUID();
  const source = identity();
  journal.persistThreadStartIntent({ operationId, ...source });
  assert.equal(journal.getThreadStartFenceStatus(operationId), 'not-passed');
  assert.deepEqual(journal.get(operationId), { operationId, ...source, state: 'thread-reserved', revision: 1,
    threadId: null, clientUserMessageId: null, keyedFingerprint: null, turnId: null });
  journal.close();
  journal = open(filePath);
  assert.equal(journal.get(operationId)?.state, 'thread-reserved');
  assert.throws(() => journal.persistThreadStartIntent({ operationId, ...source }), /conflict/u);
  assert.throws(() => journal.persistThreadStartIntent({ operationId: randomUUID(), ...identity() }), /conflict/u);
  journal.markThreadStartWriteFencePassed(operationId);
  assert.equal(journal.getThreadStartFenceStatus(operationId), 'passed');
  assert.throws(() => journal.markThreadStartWriteFencePassed(operationId), /conflict/u);

  const threadId = '01a0f511-86e7-7942-8067-91d169eb18c7'; // Native UUIDv7, not randomUUID() v4.
  journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId });
  journal.reserveFirstTurn({ operationId, expectedRevision: 2, clientUserMessageId: 'first-message',
    keyedFingerprint: fingerprint('first') });
  assert.equal(journal.getFirstTurnWriteFenceStatus(operationId), 'not-passed');
  assert.deepEqual(journal.get(operationId), { operationId, ...source, state: 'turn-reserved', revision: 3,
    threadId, clientUserMessageId: 'first-message', keyedFingerprint: fingerprint('first'), turnId: null });
  journal.close();
  journal = open(filePath);
  assert.equal(journal.getFirstTurnWriteFenceStatus(operationId), 'not-passed');
  journal.close();
});

test('write fence is durable, CAS-bound, and absent legacy markers remain unknown', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite');
  const operationId = randomUUID();
  let journal = open(filePath);
  assert.throws(() => journal.getThreadStartFenceStatus(operationId), /conflict/u);
  journal.persistThreadStartIntent({ operationId, ...identity() });
  journal.close();
  journal = open(filePath);
  assert.equal(journal.getThreadStartFenceStatus(operationId), 'not-passed');
  assert.throws(() => journal.markThreadStartWriteFencePassed(randomUUID()), /conflict/u);
  journal.markThreadStartWriteFencePassed(operationId);
  journal.close();
  journal = open(filePath);
  assert.equal(journal.getThreadStartFenceStatus(operationId), 'passed');
  journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId: randomUUID() });
  assert.throws(() => journal.markThreadStartWriteFencePassed(operationId), /conflict/u);
  journal.close();

  // Simulate a database written by the earlier journal version, which did not
  // have this table. Recreating its schema cannot reconstruct a past write.
  const old = new DatabaseConstructor(filePath);
  old.exec('DROP TABLE native_first_thread_start_fences');
  old.close();
  journal = open(filePath);
  assert.equal(journal.getThreadStartFenceStatus(operationId), 'legacy-unknown');
  assert.throws(() => journal.markThreadStartWriteFencePassed(operationId), /conflict/u);
  journal.close();
});

test('first-turn write fence is atomic with reservation and an absent legacy marker stays unknown', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite');
  const operationId = randomUUID();
  let journal = open(filePath);
  assert.throws(() => journal.getFirstTurnWriteFenceStatus(operationId), /conflict/u);
  journal.persistThreadStartIntent({ operationId, ...identity() });
  assert.throws(() => journal.getFirstTurnWriteFenceStatus(operationId), /conflict/u);
  journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId: randomUUID() });
  assert.throws(() => journal.getFirstTurnWriteFenceStatus(operationId), /conflict/u);
  assert.throws(() => journal.reserveFirstTurn({ operationId, expectedRevision: 2,
    clientUserMessageId: 'first-message', keyedFingerprint: 'plaintext' }), /conflict/u);
  assert.equal(journal.get(operationId)?.state, 'thread-accepted');
  journal.reserveFirstTurn({ operationId, expectedRevision: 2,
    clientUserMessageId: 'first-message', keyedFingerprint: fingerprint('first') });
  assert.equal(journal.getFirstTurnWriteFenceStatus(operationId), 'not-passed');
  journal.close();

  journal = open(filePath);
  assert.equal(journal.getFirstTurnWriteFenceStatus(operationId), 'not-passed');
  assert.throws(() => journal.markFirstTurnWriteFencePassed(randomUUID()), /conflict/u);
  journal.markFirstTurnWriteFencePassed(operationId);
  assert.throws(() => journal.markFirstTurnWriteFencePassed(operationId), /conflict/u);
  journal.close();
  journal = open(filePath);
  assert.equal(journal.getFirstTurnWriteFenceStatus(operationId), 'passed');
  journal.markFirstTurnUnknown({ operationId, expectedRevision: 3 });
  assert.throws(() => journal.markFirstTurnWriteFencePassed(operationId), /conflict/u);
  journal.close();

  const old = new DatabaseConstructor(filePath);
  old.exec('DROP TABLE native_first_turn_write_fences');
  old.close();
  journal = open(filePath);
  assert.equal(journal.getFirstTurnWriteFenceStatus(operationId), 'legacy-unknown');
  assert.throws(() => journal.markFirstTurnWriteFencePassed(operationId), /conflict/u);
  journal.close();
});

test('first-turn reservation rolls back when its durable fence insert fails', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite');
  const operationId = randomUUID();
  const journal = open(filePath);
  try {
    journal.persistThreadStartIntent({ operationId, ...identity() });
    journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId: randomUUID() });
    const raw = new DatabaseConstructor(filePath);
    try {
      raw.exec(`CREATE TRIGGER reject_first_turn_fence BEFORE INSERT ON native_first_turn_write_fences
        BEGIN SELECT RAISE(ABORT, 'simulated fence persistence failure'); END`);
    } finally { raw.close(); }
    assert.throws(() => journal.reserveFirstTurn({ operationId, expectedRevision: 2,
      clientUserMessageId: 'first-message', keyedFingerprint: fingerprint('first') }), /conflict/u);
    assert.equal(journal.get(operationId)?.state, 'thread-accepted');
    assert.equal(journal.get(operationId)?.revision, 2);
    assert.throws(() => journal.getFirstTurnWriteFenceStatus(operationId), /conflict/u);
    const reopened = open(filePath);
    try { assert.equal(reopened.get(operationId)?.state, 'thread-accepted'); }
    finally { reopened.close(); }
  } finally { journal.close(); }
});

test('first-turn terminal transitions are CAS-bound and an unknown reservation never replays after reopen', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite');
  const journal = open(filePath); const operationId = randomUUID();
  journal.persistThreadStartIntent({ operationId, ...identity() });
  journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId: randomUUID() });
  journal.reserveFirstTurn({ operationId, expectedRevision: 2, clientUserMessageId: 'first-message', keyedFingerprint: fingerprint('first') });
  assert.throws(() => journal.markFirstTurnAccepted({ operationId, expectedRevision: 2, turnId: 'turn-1' }), /conflict/u);
  journal.markFirstTurnUnknown({ operationId, expectedRevision: 3 });
  journal.close();

  const reopened = open(filePath);
  assert.equal(reopened.get(operationId)?.state, 'turn-unknown');
  reopened.markFirstTurnAccepted({ operationId, expectedRevision: 4, turnId: 'turn-1' });
  assert.equal(reopened.get(operationId)?.revision, 5);
  assert.throws(() => reopened.markFirstTurnAccepted({ operationId, expectedRevision: 5, turnId: 'turn-1' }), /conflict/u);
  assert.throws(() => reopened.reserveFirstTurn({ operationId, expectedRevision: 4,
    clientUserMessageId: 'second-message', keyedFingerprint: fingerprint('second') }), /conflict/u);
  assert.throws(() => reopened.markFirstTurnAccepted({ operationId, expectedRevision: 3, turnId: 'turn-1' }), /conflict/u);
  reopened.close();
});

test('unknown-turn reconciliation refuses an unbranded backend without reading or changing the journal', async () => {
  const journal = open(); const operationId = randomUUID();
  journal.persistThreadStartIntent({ operationId, ...identity() });
  journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId: randomUUID() });
  journal.reserveFirstTurn({ operationId, expectedRevision: 2,
    clientUserMessageId: 'first-message', keyedFingerprint: fingerprint('first') });
  journal.markFirstTurnUnknown({ operationId, expectedRevision: 3 });
  const before = journal.get(operationId);
  let reads = 0;
  const fake = {
    initializedSession: async () => ({ generation: 7 }),
    isSessionCurrent: () => true,
    request: async () => { reads++; return {}; },
  } as unknown as PinnedDetachedProfileRpc;
  await assert.rejects(reconcileUnknownNativeFirstTurnFromPinnedHistory(
    journal, operationId, fake));
  assert.equal(reads, 0);
  assert.deepEqual(journal.get(operationId), before);
  journal.close();
});

test('one-shot database refuses a fresh operation ID and invalid fingerprint', () => {
  const journal = open(); const operationId = randomUUID(); const source = identity();
  assert.throws(() => journal.persistThreadStartIntent({ operationId, ...source,
    threadStartFingerprint: 'raw prompt' }), /conflict/u);
  journal.persistThreadStartIntent({ operationId, ...source });
  assert.throws(() => journal.persistThreadStartIntent({ operationId, ...source, ownerEpoch: randomUUID() }), /conflict/u);
  assert.throws(() => journal.persistThreadStartIntent({ operationId, ...source,
    threadStartFingerprint: 'd'.repeat(64) }), /conflict/u);
  journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId: randomUUID() });
  assert.throws(() => journal.reserveFirstTurn({ operationId, expectedRevision: 2, clientUserMessageId: 'first-message', keyedFingerprint: 'raw prompt' }), /conflict/u);
  journal.reserveFirstTurn({ operationId, expectedRevision: 2, clientUserMessageId: 'first-message', keyedFingerprint: fingerprint('first') });
  assert.throws(() => journal.persistThreadStartIntent({ operationId: randomUUID(), ...identity() }), /conflict/u);
  journal.markFirstTurnAccepted({ operationId, expectedRevision: 3, turnId: 'turn-1' });
  assert.equal(journal.get(operationId)?.state, 'turn-accepted');
  journal.close();
});

test('first-turn fingerprint key is protected, exclusive and recoverable without journal plaintext', async () => {
  const directory = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-key-')), 'private');
  const stored = new Map<string, Uint8Array>();
  const filesystem = {
    async ensureProtectedDirectory(checkedPath: string) { mkdirSync(checkedPath, { recursive: true }); },
    async writeExclusive(filePath: string, bytes: Uint8Array) {
      if (stored.has(filePath)) throw new Error('exists');
      stored.set(filePath, Uint8Array.from(bytes));
    },
    async readProtectedFile(filePath: string) {
      const bytes = stored.get(filePath); if (!bytes) throw new Error('missing');
      return Uint8Array.from(bytes);
    },
  };
  const protector = { async protect(bytes: Uint8Array) {
    return Uint8Array.from(bytes, value => value ^ 0xa5);
  }, async unprotect(bytes: Uint8Array) { return Uint8Array.from(bytes, value => value ^ 0xa5); } };
  const key = await createPrivateKeyWithDependencies(directory, protector, filesystem);
  assert.equal(key.byteLength, 32);
  assert.equal(stored.size, 1);
  assert.notDeepEqual([...stored.values()][0], key);
  assert.deepEqual(await loadPrivateKeyWithDependencies(directory, protector, filesystem), key);
  await assert.rejects(createPrivateKeyWithDependencies(directory, protector, filesystem));
  const cipherPath = [...stored.keys()][0]!;
  stored.set(cipherPath, new Uint8Array([1, 2, 3]));
  await assert.rejects(loadPrivateKeyWithDependencies(directory, protector, filesystem));
});

test('production first-turn key entrypoint rejects injected fake dependencies', async () => {
  await assert.rejects(createNativeFirstTurnPrivateKey({ directory: 'C:\\fake',
    protector: {}, filesystem: {} } as unknown as string), /private key unavailable/u);
});

test('failed key creation does not overwrite an existing or uncertain ciphertext', async () => {
  const directory = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-key-')), 'private');
  const stored = new Map<string, Uint8Array>();
  const filesystem = {
    async ensureProtectedDirectory(checkedPath: string) { mkdirSync(checkedPath, { recursive: true }); },
    async writeExclusive(filePath: string, bytes: Uint8Array) {
      if (stored.has(filePath)) throw new Error('already exists');
      stored.set(filePath, Uint8Array.from(bytes));
      throw new Error('ACK lost after durable write');
    },
    async readProtectedFile(filePath: string) {
      const bytes = stored.get(filePath); if (!bytes) throw new Error('missing');
      return Uint8Array.from(bytes);
    },
  };
  const protector = { async protect(bytes: Uint8Array) {
    return Uint8Array.from(bytes, value => value ^ 0xa5);
  }, async unprotect(bytes: Uint8Array) { return Uint8Array.from(bytes, value => value ^ 0xa5); } };
  await assert.rejects(createPrivateKeyWithDependencies(directory, protector, filesystem), /ACK lost/u);
  const firstCiphertext = Uint8Array.from([...stored.values()][0]!);
  await assert.rejects(createPrivateKeyWithDependencies(directory, protector, filesystem));
  assert.deepEqual([...stored.values()][0], firstCiphertext);
  assert.equal((await loadPrivateKeyWithDependencies(directory, protector, filesystem)).byteLength, 32);
});
