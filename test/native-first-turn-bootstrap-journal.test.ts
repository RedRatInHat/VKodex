import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativeFirstTurnBootstrapJournal } from '../src/desktop/native-first-turn-bootstrap-journal.js';

const identity = () => ({ sourceId: 'profile-a', sourceGeneration: randomUUID(),
  ownerEpoch: randomUUID(), threadStartFingerprint: 'c'.repeat(64), backendIdentity: 'b'.repeat(64) });
const fingerprint = (_value: string) => 'a'.repeat(64);
const open = (filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite')) =>
  new NativeFirstTurnBootstrapJournal(filePath);

test('durably sequences thread creation before a first-turn reservation without storing prompt material', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite');
  let journal = open(filePath);
  assert.equal(journal.synchronousMode(), 2);
  const operationId = randomUUID();
  const source = identity();
  journal.persistThreadStartIntent({ operationId, ...source });
  assert.deepEqual(journal.get(operationId), { operationId, ...source, state: 'thread-reserved', revision: 1,
    threadId: null, clientUserMessageId: null, keyedFingerprint: null, turnId: null });
  journal.close();
  journal = open(filePath);
  assert.equal(journal.get(operationId)?.state, 'thread-reserved');
  assert.throws(() => journal.persistThreadStartIntent({ operationId, ...source }), /conflict/u);
  assert.throws(() => journal.persistThreadStartIntent({ operationId: randomUUID(), ...identity() }), /conflict/u);

  const threadId = '01a0f511-86e7-7942-8067-91d169eb18c7'; // Native UUIDv7, not randomUUID() v4.
  journal.persistThreadAccepted({ operationId, expectedRevision: 1, threadId });
  journal.reserveFirstTurn({ operationId, expectedRevision: 2, clientUserMessageId: 'first-message',
    keyedFingerprint: fingerprint('first') });
  assert.deepEqual(journal.get(operationId), { operationId, ...source, state: 'turn-reserved', revision: 3,
    threadId, clientUserMessageId: 'first-message', keyedFingerprint: fingerprint('first'), turnId: null });
  journal.close();
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
