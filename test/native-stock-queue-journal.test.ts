import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import DatabaseConstructor from 'better-sqlite3';
import { NativeStockQueueJournal, type StockQueueIntent } from '../src/codex/native-stock-queue-journal.js';

const taskId = 'public-repeat-task', ownerEpoch = 'public-owner-epoch';
const filename = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'vkodex-native-stock-journal-')), `${randomUUID()}.sqlite`);
const fp = (id: string) => (id.codePointAt(0) ?? 0).toString(16).padStart(64, '0');
const settings = () => ({ model: 'synthetic-model', effort: 'medium', permissions: ':read-only',
  sandboxPolicy: { type: 'readOnly' }, serviceTier: 'default' });
const intent = (id: string, expectedVersion: number, extras: Partial<StockQueueIntent> = {}): StockQueueIntent => ({ expectedVersion, opId: id,
  fingerprint: fp(id), nativeEntry: { id, text: `PUBLIC_${id}` },
  effectiveSettings: settings(), admissionEvidence: { taskId, ownerEpoch, initializationReceipt: `receipt-${id}` },
  stockInput: [{ type: 'text', text: `PUBLIC_${id}\n`, text_elements: [] }],
  forwardedUpstream: { turnTrigger: false, responsesapiClientMetadata: false }, ...extras });
const open = async (filePath?: string) => new NativeStockQueueJournal({ filePath: filePath ?? await filename(), taskId, ownerEpoch });

test('atomic expected-version reserve admits one racer and preserves immutable ID after reopen', async () => {
  const filePath = await filename(); const a = await open(filePath); const b = await open(filePath);
  const results = await Promise.allSettled([Promise.resolve().then(() => a.reserve(intent('A', 0))),
    Promise.resolve().then(() => b.reserve(intent('B', 0)))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(a.read().pendingIds.length, 1);
  const winningId = a.read().pendingIds[0]!; a.close(); b.close();
  const reopened = await open(filePath);
  assert.equal(reopened.read().operations[0]!.opId, winningId);
  assert.throws(() => reopened.reserve(intent(winningId, reopened.read().version)), /reused immutable/);
  reopened.close();
});

test('admission evidence is required, detached from caller objects, and persists across reopen', async () => {
  const filePath = await filename(); const j = await open(filePath);
  assert.throws(() => j.reserve({ ...intent('A', 0), admissionEvidence: undefined } as unknown as StockQueueIntent), /incomplete immutable intent/);
  assert.throws(() => j.reserve({ ...intent('A', 0), admissionEvidence: {} }), /incomplete immutable intent/);
  const operation = intent('A', 0);
  j.reserve(operation);
  (operation.admissionEvidence as Record<string, string>).initializationReceipt = 'tampered';
  assert.equal(j.readOperation('A')!.admissionEvidence.initializationReceipt, 'receipt-A');
  j.close();
  const reopened = await open(filePath);
  const firstRead = reopened.readOperation('A')!;
  (firstRead.admissionEvidence as Record<string, string>).initializationReceipt = 'changed-read';
  assert.equal(reopened.readOperation('A')!.admissionEvidence.initializationReceipt, 'receipt-A');
  reopened.close();
});

test('old journal schema is refused without an implicit migration', async () => {
  const filePath = await filename();
  const old = new DatabaseConstructor(filePath);
  old.exec('CREATE TABLE native_repeated_op(task_id TEXT,op_id TEXT,seq INTEGER,consumed INTEGER,phase TEXT,stock_id TEXT)');
  old.close();
  assert.throws(() => new NativeStockQueueJournal({ filePath, taskId, ownerEpoch }), /incompatible journal schema/);
});

test('one unresolved stock add blocks a second reservation even with fresh version', async () => {
  const j = await open();
  j.reserve(intent('A', 0));
  assert.throws(() => j.reserve(intent('B', j.read().version)), /still unresolved/);
  assert.throws(() => j.reserve(intent('A', j.read().version, {
    fingerprint: 'f'.repeat(64) })), /reused immutable/);
  assert.deepEqual(j.read().pendingIds, ['A']);
  j.close();
});

test('SQLite insert failure rolls back reservation without a false durable intent', async () => {
  const filePath = await filename(); const j = await open(filePath);
  const other = new DatabaseConstructor(filePath);
  other.exec(`CREATE TRIGGER deny_repeat_reservation BEFORE INSERT ON native_repeated_task
    BEGIN SELECT RAISE(ABORT, 'synthetic durable write failure'); END`);
  assert.throws(() => j.reserve(intent('A', 0)), /synthetic durable write failure/);
  assert.deepEqual(j.read().pendingIds, []);
  assert.equal(j.read().version, 0);
  other.exec('DROP TRIGGER deny_repeat_reservation');
  j.reserve(intent('A', 0));
  assert.deepEqual(j.read().pendingIds, ['A']);
  other.close(); j.close();
});

test('two accepted sends maintain ordered projection and stale publication ACK cannot erase newer state', async () => {
  const j = await open();
  j.reserve(intent('A', 0));
  j.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  const first = j.publication();
  assert.deepEqual(first!.pendingIds, ['A']);
  j.reserve(intent('B', j.read().version));
  j.markAccepted({ opId: 'B', fingerprint: fp('B'), stockId: 'stock-B' });
  const second = j.publication();
  assert.deepEqual(second!.pendingIds, ['A', 'B']);
  assert.equal(j.acknowledgePublication({ version: first!.version }).acknowledged, false);
  assert.equal(j.publication()!.version, second!.version);
  j.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
  assert.deepEqual(j.publication()!.pendingIds, ['B']);
  assert.equal(j.acknowledgePublication({ version: second!.version }).acknowledged, false);
  const latest = j.publication();
  assert.equal(j.acknowledgePublication({ version: latest!.version }).acknowledged, true);
  assert.equal(j.publication(), null);
  j.close();
});

test('indexed bounded pages preserve order and publication snapshot version', async () => {
  const filePath = await filename(); const j = await open(filePath);
  for (const id of ['A', 'B', 'C']) {
    j.reserve(intent(id, j.readTask().version));
    j.markAccepted({ opId: id, fingerprint: fp(id), stockId: `stock-${id}` });
  }
  assert.equal(Object.hasOwn(j.readTask(), 'operations'), false);
  const first = j.pendingPage({ limit: 2 });
  assert.deepEqual(first.items.map(op => op.opId), ['A', 'B']);
  assert.equal(first.hasMore, true);
  const second = j.pendingPage({ afterSeq: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map(op => op.opId), ['C']);
  const status = j.publicationStatus();
  const p1 = j.publicationPage({ version: status.version, limit: 2 });
  assert.deepEqual(p1.items.map(op => op.opId), ['A', 'B']);
  assert.deepEqual(j.publicationPage({ version: status.version, afterSeq: p1.nextCursor,
    limit: 2 }).items.map(op => op.opId), ['C']);
  j.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
  assert.throws(() => j.publicationPage({ version: status.version, limit: 2 }), /stale publication/);
  assert.deepEqual(j.consumedPage({ limit: 2 }).items.map(op => op.opId), ['A']);
  assert.deepEqual(j.pendingPage({ limit: 2 }).items.map(op => op.opId), ['B', 'C']);
  j.close();
  const reopened = await open(filePath);
  assert.deepEqual(reopened.publicationPage({ version: reopened.publicationStatus().version,
    limit: 2 }).items.map(op => op.opId), ['B', 'C']);
  assert.throws(() => reopened.pendingPage({ limit: 501 }), /page cursor and limit/);
  reopened.close();
});

test('pending page keeps task version and rows on one read snapshot across another connection commit', async () => {
  const filePath = await filename(); const reader = await open(filePath);
  reader.reserve(intent('A', 0));
  reader.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  const writer = await open(filePath); const before = reader.readTask().version;
  const original = reader.readTask.bind(reader); let injected = false;
  reader.readTask = () => {
    const task = original();
    if (!injected) {
      injected = true;
      writer.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
    }
    return task;
  };
  const page = reader.pendingPage({ limit: 1 });
  assert.equal(page.taskVersion, before);
  assert.deepEqual(page.items.map(op => op.opId), ['A']);
  assert.equal(writer.readTask().version, before + 1);
  reader.close(); writer.close();
});

test('publication page keeps version and rows on one read snapshot across another connection commit', async () => {
  const filePath = await filename(); const reader = await open(filePath);
  reader.reserve(intent('A', 0));
  reader.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  const writer = await open(filePath); const before = reader.publicationStatus().version;
  const original = reader.publicationStatus.bind(reader); let injected = false;
  reader.publicationStatus = () => {
    const status = original();
    if (!injected) {
      injected = true;
      writer.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
    }
    return status;
  };
  const page = reader.publicationPage({ version: before, limit: 1 });
  assert.equal(page.version, before);
  assert.deepEqual(page.items.map(op => op.opId), ['A']);
  assert.equal(writer.publicationStatus().version, before + 1);
  reader.close(); writer.close();
});

test('single operation read does not mix old task metadata with a newer operation row', async () => {
  const filePath = await filename(); const reader = await open(filePath);
  reader.reserve(intent('A', 0));
  const writer = await open(filePath);
  const original = reader.readTask.bind(reader); let injected = false;
  reader.readTask = () => {
    const task = original();
    if (!injected) {
      injected = true;
      writer.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
    }
    return task;
  };
  assert.equal(reader.readOperation('A')!.phase, 'reserved');
  assert.equal(writer.readOperation('A')!.phase, 'accepted');
  reader.close(); writer.close();
});

test('indexed incoming identity batch stays on one snapshot and returns absent IDs without old tombstone scan', async () => {
  const filePath = await filename(); const reader = await open(filePath);
  reader.reserve(intent('A', 0));
  const writer = await open(filePath);
  const original = reader.readTask.bind(reader); let injected = false;
  reader.readTask = () => {
    const task = original();
    if (!injected) {
      injected = true;
      writer.markUnknown({ opId: 'A', fingerprint: fp('A') });
    }
    return task;
  };
  const result = reader.lookupIncomingIdentities({ ids: ['A', 'absent'] });
  assert.equal(result.taskVersion, 1);
  assert.deepEqual(result.items.map(item => item?.phase ?? null), ['reserved', null]);
  assert.equal(result.items[0]!.fingerprint, fp('A'));
  assert.equal(result.items[0]!.seq, 1);
  assert.equal(result.items[0]!.consumed, false);
  assert.equal(writer.lookupIncomingIdentities({ ids: ['A'] }).items[0]!.phase, 'unknown');
  reader.close(); writer.close();
});

test('hydration currentQueuePage works after publication ACK and fences stale task versions', async () => {
  const filePath = await filename(); const reader = await open(filePath);
  reader.reserve(intent('A', 0));
  reader.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  const publication = reader.publicationStatus();
  reader.acknowledgePublication({ version: publication.version });
  assert.equal(reader.publicationStatus().pending, false);
  const version = reader.readTask().version;
  assert.deepEqual(reader.currentQueuePage({ expectedVersion: version, limit: 1 }).items.map(item => item.opId), ['A']);
  const writer = await open(filePath);
  const original = reader.readTask.bind(reader); let injected = false;
  reader.readTask = () => {
    const task = original();
    if (!injected) {
      injected = true;
      writer.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
    }
    return task;
  };
  assert.deepEqual(reader.currentQueuePage({ expectedVersion: version, limit: 1 }).items.map(item => item.opId), ['A']);
  assert.throws(() => reader.currentQueuePage({ expectedVersion: version, limit: 1 }), /stale task version/);
  reader.close(); writer.close();
});

test('replay confirmation is atomic, no-op, owner-scoped and refuses unresolved outcomes', async () => {
  const filePath = await filename(); const j = await open(filePath);
  assert.deepEqual(j.confirmReplay({ expectedVersion: 0, ownerEpoch }), { confirmed: true, version: 0 });
  j.reserve(intent('A', 0));
  assert.throws(() => j.confirmReplay({ expectedVersion: 1, ownerEpoch }), /unresolved/);
  j.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  const stable = j.readTask().version;
  assert.deepEqual(j.confirmReplay({ expectedVersion: stable, ownerEpoch }), { confirmed: true, version: stable });
  assert.equal(j.readTask().version, stable);
  assert.throws(() => j.confirmReplay({ expectedVersion: stable - 1, ownerEpoch }), /stale expected version/);
  assert.throws(() => j.confirmReplay({ expectedVersion: stable, ownerEpoch: 'other-owner' }), /owner epoch mismatch/);
  j.reserve(intent('B', stable)); j.markUnknown({ opId: 'B', fingerprint: fp('B') });
  assert.throws(() => j.confirmReplay({ expectedVersion: j.readTask().version, ownerEpoch }), /unresolved/);
  j.close();
});

test('large consumed history needs only indexed requested IDs and enforces bounded batch', async () => {
  const filePath = await filename(); const j = await open(filePath);
  j.reserve(intent('A', 0)); j.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  j.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
  const seed = new DatabaseConstructor(filePath); seed.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const insert = seed.prepare(`INSERT INTO native_repeated_op
    (task_id,op_id,seq,fingerprint,native_entry_json,admission_evidence_json,stock_input_json,forwarded_json,phase,stock_id,accepted_turn_id,consumed)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 1200; i++) {
    const id = `old-${String(i).padStart(4, '0')}`;
    insert.run(taskId, id, i + 1, 'b'.repeat(64), JSON.stringify({ id }), '{}', '[]', '{}',
      'accepted', `stock-${id}`, `turn-${id}`, 1);
  }
  seed.prepare('UPDATE native_repeated_task SET version=version+1 WHERE task_id=?').run(taskId);
  seed.exec('COMMIT'); seed.close();
  const result = j.lookupIncomingIdentities({ ids: ['old-0001', 'old-1200', 'new-op'] });
  assert.deepEqual(result.items.map(item => item?.seq ?? null), [2, 1201, null]);
  assert.equal(result.items[1]!.consumed, true);
  assert.throws(() => j.lookupIncomingIdentities({ ids: Array.from({ length: 501 }, (_, i) => `x-${i}`) }), /batch/);
  j.close();
});

test('authoritative consume before add ACK survives reopen and never resurrects native entry', async () => {
  const filePath = await filename(); const first = await open(filePath);
  first.reserve(intent('A', 0));
  first.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
  assert.deepEqual(first.read().pendingIds, []);
  assert.equal(first.publication(), null);
  first.close();
  const reopened = await open(filePath);
  reopened.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  assert.deepEqual(reopened.publication()!.messages, []);
  assert.deepEqual(reopened.read().operations.map(op => [op.opId, op.acceptedTurnId, op.consumed]),
    [['A', 'turn-A', true]]);
  assert.throws(() => reopened.reserve(intent('A', reopened.read().version)), /reused immutable/);
  reopened.close();
});

test('unknown result freezes new admissions across reopen, and queue absence has no journal transition', async () => {
  const filePath = await filename(); const first = await open(filePath);
  first.reserve(intent('A', 0));
  first.markUnknown({ opId: 'A', fingerprint: fp('A') });
  assert.equal(first.read().operations[0]!.phase, 'unknown'); first.close();
  const reopened = await open(filePath);
  assert.throws(() => reopened.reserve(intent('B', reopened.read().version)), /unknown outcome freezes/);
  assert.throws(() => reopened.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' }),
    /explicit authoritative reconciliation/);
  assert.equal(reopened.read().operations[0]!.phase, 'unknown');
  reopened.close();
});

test('accepted cannot downgrade and conflicts cannot replace stock ID, turn, fingerprint, or settings', async () => {
  const j = await open();
  j.reserve(intent('A', 0));
  j.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'stock-A' });
  assert.throws(() => j.markUnknown({ opId: 'A', fingerprint: fp('A') }), /cannot downgrade/);
  assert.throws(() => j.markAccepted({ opId: 'A', fingerprint: fp('A'), stockId: 'other' }), /stock receipt conflict/);
  assert.throws(() => j.markAccepted({ opId: 'A', fingerprint: 'f'.repeat(64), stockId: 'stock-A' }), /identity conflict/);
  j.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: true });
  assert.throws(() => j.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-other', authoritative: true }), /turn identity conflict/);
  assert.throws(() => j.reserve(intent('B', j.read().version, {
    effectiveSettings: { ...settings(), effort: 'high' } })), /effective settings changed/);
  assert.deepEqual(j.read().pendingIds, []);
  j.close();
});

test('owner epoch is bound to durable task, and nonauthoritative consume leaves state untouched', async () => {
  const filePath = await filename(); const j = await open(filePath);
  j.reserve(intent('A', 0));
  const version = j.read().version;
  assert.throws(() => j.consume({ opId: 'A', fingerprint: fp('A'), turnId: 'turn-A', authoritative: false }),
    /authoritative/);
  assert.equal(j.read().version, version); j.close();
  const wrong = new NativeStockQueueJournal({ filePath, taskId, ownerEpoch: 'other-owner' });
  assert.throws(() => wrong.read(), /owner epoch mismatch/);
  assert.throws(() => wrong.reserve(intent('B', version)), /owner epoch mismatch/);
  wrong.close();
});
