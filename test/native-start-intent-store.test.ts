import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { NativeStartIntentStore } from '../src/codex/native-start-intent-store.js';

const scope = () => ({ ownerEpoch: randomUUID(), backendGeneration: 1, threadId: 'own-thread' });
const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-native-intent-')), 'intents.sqlite');
const intent = (operationId: string, clientId: string, owner: ReturnType<typeof scope>,
  marker = 'secret prompt marker') => ({
  envelope: { conversationId: 'own-thread', turnStart: { request: { threadId: 'own-thread',
    clientUserMessageId: clientId, input: [{ type: 'text', text: marker }] } } },
  command: { operationId, method: 'turn/start' as const,
    params: { threadId: 'own-thread', clientUserMessageId: clientId,
      input: [{ type: 'text', text: marker }] } },
  uiParams: { clientUserMessageId: clientId, input: [{ type: 'text', text: marker }] },
  localMetadata: { fileAttachmentCount: 0 },
  admission: { ownerEpoch: owner.ownerEpoch, backendGeneration: owner.backendGeneration,
    authorityRevision: 1, snapshot: { id: owner.threadId, latestModel: 'fixture-model' } },
});

test('encrypted intent reserves before dispatch, survives reopen and never exposes plaintext in DB or WAL', () => {
  const filePath = file(), owner = scope(), encryptionKey = randomBytes(32);
  const operationId = randomUUID(), clientId = randomUUID(), value = intent(operationId, clientId, owner);
  const store = new NativeStartIntentStore({ filePath, ...owner, encryptionKey });
  assert.deepEqual(store.owner, owner);
  assert.equal(Object.isFrozen(store.owner), true);
  const reserved = store.reserve(operationId, clientId, value);
  assert.equal(reserved.created, true);
  assert.deepEqual(reserved.record.intent, value);
  assert.deepEqual(store.getByClientUserMessageId(clientId), reserved.record);
  assert.deepEqual(store.list(), [reserved.record]);
  (reserved.record.intent.uiParams as Record<string, unknown>).changed = true;
  assert.deepEqual(store.get(operationId)?.intent, value);
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(filePath + suffix))
    assert.equal(readFileSync(filePath + suffix).includes(Buffer.from('secret prompt marker')), false);
  store.close();
  const reopened = new NativeStartIntentStore({ filePath, ...owner, encryptionKey });
  assert.deepEqual(reopened.get(operationId)?.intent, value);
  assert.equal(reopened.reserve(operationId, clientId, value).created, false);
  reopened.close();
});

test('immutable IDs, scope and admission reject conflicting or malformed intent', () => {
  const filePath = file(), owner = scope(), encryptionKey = randomBytes(32);
  const store = new NativeStartIntentStore({ filePath, ...owner, encryptionKey });
  const op = randomUUID(), client = randomUUID(), first = intent(op, client, owner);
  assert.equal(store.reserve(op, client, first).created, true);
  assert.throws(() => store.reserve(op, client, intent(op, client, owner, 'changed prompt')));
  const secondOp = randomUUID(), secondClient = randomUUID();
  assert.throws(() => store.reserve(secondOp, client, intent(secondOp, client, owner)));
  assert.throws(() => store.reserve(op, secondClient, intent(op, secondClient, owner)));
  const foreignOp = randomUUID(), foreignClient = randomUUID();
  const foreign = intent(foreignOp, foreignClient, owner);
  assert.throws(() => store.reserve(foreignOp, foreignClient, {
    ...foreign, admission: { ...foreign.admission, ownerEpoch: randomUUID() } }));
  assert.throws(() => store.reserve(foreignOp, foreignClient, {
    ...foreign, admission: { ...foreign.admission, snapshot: { id: 'foreign-thread' } } }));
  const malformed = intent(randomUUID(), randomUUID(), owner);
  assert.throws(() => store.reserve(malformed.command.operationId,
    malformed.command.params.clientUserMessageId as string, { ...malformed, uiParams: { invalid: undefined } }));
  store.close();
  assert.throws(() => store.get(op));
  assert.throws(() => new NativeStartIntentStore({ filePath, ...owner, encryptionKey: randomBytes(32) }));
  assert.throws(() => new NativeStartIntentStore({ filePath, ...owner,
    backendGeneration: 2, encryptionKey }));
});

test('ciphertext tampering and capacity bounds fail closed without exposing an accepted receipt', () => {
  const filePath = file(), owner = scope(), encryptionKey = randomBytes(32);
  const store = new NativeStartIntentStore({ filePath, ...owner, encryptionKey, maxRows: 1 });
  const op = randomUUID(), client = randomUUID();
  store.reserve(op, client, intent(op, client, owner));
  const nextOp = randomUUID(), nextClient = randomUUID();
  assert.throws(() => store.reserve(nextOp, nextClient, intent(nextOp, nextClient, owner)));
  assert.deepEqual(store.list().map(row => row.operationId), [op]);
  store.close();
  const db = new Database(filePath);
  db.prepare('UPDATE native_start_intents SET ciphertext=zeroblob(length(ciphertext)) WHERE operation_id=?').run(op);
  db.close();
  const reopened = new NativeStartIntentStore({ filePath, ...owner, encryptionKey });
  assert.throws(() => reopened.get(op));
  assert.throws(() => reopened.getByClientUserMessageId(client));
  reopened.close();
  const tinyFile = file();
  const tiny = new NativeStartIntentStore({ filePath: tinyFile, ...owner, encryptionKey, maxBytes: 100 });
  assert.throws(() => tiny.reserve(op, client, intent(op, client, owner)));
  assert.deepEqual(tiny.list(), []);
  tiny.close();
});
