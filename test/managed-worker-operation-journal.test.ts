import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ManagedWorkerOperationJournal } from "../src/codex/managed-worker-operation-journal.js";
import Database from 'better-sqlite3';

const fingerprint = "a".repeat(64);
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "vkodex-owner-op-journal-"));
  return { filePath: path.join(dir, "operations.sqlite"), ownerEpoch: randomUUID(), backendGeneration: 7, threadId: "thread-1" };
}
function intent(operationId: string = randomUUID(), clientUserMessageId: string = randomUUID()) {
  return { operationId, clientUserMessageId, method: "turn/start" as const, fingerprint };
}

test("reserve persists before dispatch, unknown survives reopen and blocks new admission", () => {
  const scope = fixture();
  const first = intent();
  const a = new ManagedWorkerOperationJournal(scope);
  const reserved = a.reserve(first);
  assert.equal(reserved.created, true);
  assert.equal(reserved.operation.state, "dispatching");
  assert.equal(reserved.operation.revision, 0);
  assert.equal(a.reserve(first).created, false);
  assert.throws(() => a.reserve(intent()), /unsettled/i);
  assert.equal(a.journalMode(), "wal");
  assert.equal(a.synchronousMode(), 2);
  a.close();

  const b = new ManagedWorkerOperationJournal(scope);
  try {
    assert.equal(b.get(first.operationId)?.state, "dispatching");
    const unknown = b.markUnknown(reserved.operation);
    assert.equal(unknown.state, "unknown");
    assert.throws(() => b.reserve(intent()), /unsettled/i);
    assert.throws(() => b.markUnknown(reserved.operation), /stale/i);
    assert.equal(b.get(first.operationId)?.state, "unknown");
  } finally { b.close(); }
});

test("exact duplicate intent joins, but operation or client-ID collision refuses", () => {
  const scope = fixture();
  const journal = new ManagedWorkerOperationJournal(scope);
  try {
    const first = intent();
    journal.reserve(first);
    assert.equal(journal.reserve(first).created, false);
    assert.throws(() => journal.reserve({ ...first, fingerprint: "b".repeat(64) }), /conflict/i);
    assert.throws(() => journal.reserve({ ...first, operationId: randomUUID() }), /client|conflict/i);
    assert.throws(() => journal.reserve({ ...first, method: "turn/steer" as "turn/start" }), /method/i);
    assert.throws(() => journal.reserve({ ...first, clientUserMessageId: "bad\nID" }), /client/i);
  } finally { journal.close(); }
});

test("scope, revision and exact settled outcome are fenced", () => {
  const scope = fixture();
  const journal = new ManagedWorkerOperationJournal(scope);
  try {
    const first = journal.reserve(intent()).operation;
    const accepted = journal.accept(first, "turn-1");
    assert.equal(accepted.state, "accepted");
    assert.equal(journal.accept(first, "turn-1").revision, accepted.revision);
    assert.throws(() => journal.accept(first, "turn-2"), /conflict/i);
    assert.throws(() => journal.reject(first, -32000), /conflict/i);
    assert.throws(() => journal.markUnknown(first), /stale|settled|conflict/i);
    assert.throws(() => journal.accept({ ...first, revision: 999 }, "turn-1"), /stale/i);
    const second = journal.reserve(intent()).operation;
    const rejected = journal.reject(second, -32602);
    assert.equal(rejected.rejectionCode, -32602);
    assert.equal(journal.reject(second, -32602).revision, rejected.revision);
    assert.throws(() => journal.reject(second, -32000), /conflict/i);
    assert.throws(() => journal.accept(second, "turn-3"), /conflict/i);
    assert.throws(() => journal.markUnknown({ ...second, revision: 999 }), /stale/i);
    assert.throws(() => journal.accept({ ...second, ownerEpoch: randomUUID() }, "turn-3"), /scope|stale/i);
    assert.equal(journal.get(first.operationId)?.state, "accepted");
  } finally { journal.close(); }
  assert.throws(() => new ManagedWorkerOperationJournal({ ...scope, backendGeneration: 8 }), /scope/i);
  assert.throws(() => new ManagedWorkerOperationJournal({ ...scope, ownerEpoch: randomUUID() }), /scope/i);
  assert.throws(() => new ManagedWorkerOperationJournal({ ...scope, threadId: "thread-2" }), /scope/i);
});

test('a proven final pre-wire refusal settles without a native error code and unblocks new admission', () => {
  const scope = fixture(); const first = intent();
  const journal = new ManagedWorkerOperationJournal(scope);
  const reserved = journal.reserve(first).operation;
  try {
    const rejected = journal.rejectBeforeWrite(reserved);
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.receiptId, null);
    assert.equal(rejected.rejectionCode, null);
    assert.equal(journal.hasUnconfirmed(), false);
    assert.equal(journal.rejectBeforeWrite(reserved).revision, rejected.revision);
    assert.throws(() => journal.accept(reserved, 'not-a-wire-receipt'), /settled|conflict/i);
    assert.equal(journal.reserve(intent()).created, true);
  } finally { journal.close(); }
  const reopened = new ManagedWorkerOperationJournal(scope);
  try { assert.deepEqual(reopened.get(first.operationId)?.state, 'rejected'); }
  finally { reopened.close(); }
});

test("metadata-only journal rejects raw fields and never persists payload marker", () => {
  const scope = fixture();
  const journal = new ManagedWorkerOperationJournal(scope);
  try {
    const marker = "PRIVATE_PROMPT_MARKER_834972";
    const base = intent();
    assert.throws(() => journal.reserve({ ...base, rawInput: marker } as typeof base), /intent|field/i);
    assert.equal(journal.get(base.operationId), null);
    journal.reserve(base);
    assert.equal(readFileSync(scope.filePath).includes(marker), false);
  } finally { journal.close(); }
});

test("invalid constructor and receipt identities fail closed", () => {
  const scope = fixture();
  assert.throws(() => new ManagedWorkerOperationJournal({ ...scope, filePath: "relative.sqlite" }), /absolute/i);
  assert.throws(() => new ManagedWorkerOperationJournal({ ...scope, ownerEpoch: "not-uuid" }), /epoch/i);
  const journal = new ManagedWorkerOperationJournal(scope);
  try {
    const first = journal.reserve(intent()).operation;
    assert.throws(() => journal.accept(first, "secret\n"), /receipt/i);
    assert.throws(() => journal.reject(first, Number.NaN), /code/i);
    assert.equal(journal.get(first.operationId)?.state, "dispatching");
  } finally { journal.close(); }
});

test("scoped unconfirmed query tracks dispatching and unknown across reopen without writing", () => {
  const scope = fixture(), first = intent();
  const a = new ManagedWorkerOperationJournal(scope);
  assert.equal(a.hasUnconfirmed(), false);
  const reserved = a.reserve(first).operation;
  assert.equal(a.hasUnconfirmed(), true);
  a.close();
  const b = new ManagedWorkerOperationJournal(scope);
  let unknown = reserved;
  try {
    assert.equal(b.hasUnconfirmed(), true);
    unknown = b.markUnknown(reserved);
    assert.equal(b.hasUnconfirmed(), true);
  } finally { b.close(); }
  const c = new ManagedWorkerOperationJournal(scope);
  try {
    assert.equal(c.hasUnconfirmed(), true);
    c.accept(unknown, "actual-turn");
    assert.equal(c.hasUnconfirmed(), false);
    const rejected = c.reserve(intent()).operation;
    assert.equal(c.hasUnconfirmed(), true);
    c.reject(rejected, -32602);
    assert.equal(c.hasUnconfirmed(), false);
  } finally { c.close(); }
});

test('accepted receipt IDs are durable metadata for terminal history drain', () => {
  const scope = fixture(); const journal = new ManagedWorkerOperationJournal(scope);
  const first = journal.reserve(intent()).operation;
  journal.accept(first, 'actual-turn');
  const receipts = journal.acceptedReceipts();
  assert.deepEqual(receipts, [{ method: 'turn/start', receiptId: 'actual-turn' }]);
  assert.equal(Object.isFrozen(receipts), true);
  journal.close();
  const reopened = new ManagedWorkerOperationJournal(scope);
  try { assert.deepEqual(reopened.acceptedReceipts(), receipts); }
  finally { reopened.close(); }
});

test('accepted queue input identities survive reopen without being treated as turn IDs', () => {
  const scope = fixture(), journal = new ManagedWorkerOperationJournal(scope);
  const first = journal.reserve({ ...intent(), method: 'thread/queue/add' }).operation;
  assert.deepEqual(journal.acceptedQueueInputs(), []);
  journal.accept(first, 'native-submission-id');
  const direct = journal.reserve(intent()).operation;
  journal.accept(direct, 'native-turn-id');
  const unknown = journal.reserve({ ...intent(), method: 'thread/queue/add' }).operation;
  journal.markUnknown(unknown);
  journal.close();
  const reopened = new ManagedWorkerOperationJournal(scope);
  try {
    const inputs = reopened.acceptedQueueInputs();
    assert.deepEqual(inputs, [{ clientUserMessageId: first.clientUserMessageId,
      submissionId: 'native-submission-id' }]);
    assert.equal(Object.isFrozen(inputs), true);
    assert.equal(Object.isFrozen(inputs[0]), true);
    assert.equal(reopened.hasUnconfirmed(), true);
  } finally { reopened.close(); }
});

test('client identity existence is bounded, indexed metadata across durable methods and states', () => {
  const scope = fixture(), journal = new ManagedWorkerOperationJournal(scope);
  const queueId: string = 'q'.repeat(128), directId: string = randomUUID();
  try {
    assert.equal(journal.hasClientUserMessageId('not-present'), false);
    assert.equal(journal.hasClientUserMessageId(queueId), false);
    const queued = journal.reserve({ ...intent(randomUUID(), queueId), method: 'thread/queue/add' }).operation;
    assert.equal(queued.state, 'dispatching');
    assert.equal(journal.hasClientUserMessageId(queueId), true);
    const unknown = journal.markUnknown(queued);
    assert.equal(journal.hasClientUserMessageId(queueId), true);
    journal.accept(unknown, 'stock-receipt');
    assert.equal(journal.hasClientUserMessageId(queueId), true);

    const rejected = journal.reserve(intent(randomUUID(), directId)).operation;
    journal.rejectBeforeWrite(rejected);
    assert.equal(journal.hasClientUserMessageId(directId), true);
    for (const invalid of ['', ' leading', 'trailing ', 'bad\nvalue', 'x'.repeat(129)]) {
      assert.throws(() => journal.hasClientUserMessageId(invalid), /client/i);
    }
  } finally { journal.close(); }
  const reopened = new ManagedWorkerOperationJournal(scope);
  try {
    assert.equal(reopened.hasClientUserMessageId(queueId), true);
    assert.equal(reopened.hasClientUserMessageId(directId), true);
    assert.equal(reopened.hasClientUserMessageId('not-present'), false);
  } finally { reopened.close(); }
});

test('settings intent uses the same scoped journal and atomically blocks turn admission without a receipt', () => {
  const scope = fixture(), settingsId = randomUUID();
  const a = new ManagedWorkerOperationJournal(scope);
  const settings = { operationId: settingsId, fingerprint };
  const first = a.reserveSettings(settings);
  assert.equal(first.created, true);
  assert.equal(first.operation.state, 'dispatching');
  assert.equal(first.operation.rpcAck, false);
  assert.equal(a.hasUnconfirmed(), true);
  assert.throws(() => a.reserve(intent()), /unsettled/i);
  assert.throws(() => a.reserve(intent(settingsId)), /conflict/i);
  assert.equal(a.reserveSettings(settings).created, false);
  assert.throws(() => a.reserveSettings({ ...settings, fingerprint: 'b'.repeat(64) }), /conflict/i);
  a.close();
  const b = new ManagedWorkerOperationJournal(scope);
  try {
    assert.deepEqual(b.getSettings(settingsId), first.operation);
    assert.deepEqual(b.acceptedReceipts(), []);
    const unknown = b.markSettingsUnknown(first.operation);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.rpcAck, false);
    const acknowledged = b.noteSettingsAck(unknown);
    assert.equal(acknowledged.rpcAck, true);
    assert.equal(acknowledged.state, 'unknown');
    assert.equal(Object.hasOwn(acknowledged, 'receiptId'), false);
    assert.throws(() => b.reserveSettings({ operationId: randomUUID(), fingerprint }), /unsettled/i);
    assert.throws(() => b.reserve(intent()), /unsettled/i);
    assert.equal(b.hasUnconfirmed(), true);
  } finally { b.close(); }
});

test('a pending turn blocks settings reservation and metadata-only settings reject raw payloads', () => {
  const scope = fixture(); const journal = new ManagedWorkerOperationJournal(scope);
  try {
    const turn = journal.reserve(intent()).operation;
    const settings = { operationId: randomUUID(), fingerprint };
    assert.throws(() => journal.reserveSettings(settings), /unsettled/i);
    journal.accept(turn, 'real-turn');
    assert.throws(() => journal.reserveSettings({ ...settings, rawParams: 'PRIVATE_SETTINGS_MARKER' } as never), /field|intent/i);
    assert.equal(readFileSync(scope.filePath).includes('PRIVATE_SETTINGS_MARKER'), false);
    const reserved = journal.reserveSettings(settings).operation;
    assert.throws(() => journal.noteSettingsAck({ ...reserved, ownerEpoch: randomUUID() }), /scope/i);
    assert.throws(() => journal.noteSettingsAck({ ...reserved, revision: 9 }), /stale/i);
  } finally { journal.close(); }
});

test('settings effect confirmation is a separate durable CAS and releases admission', () => {
  const scope = fixture(), journal = new ManagedWorkerOperationJournal(scope);
  const operationId = randomUUID();
  try {
    const initial = journal.reserveSettings({ operationId, fingerprint }).operation;
    assert.throws(() => journal.confirmSettings(initial, 'c'.repeat(64)), /ack|unknown/i);
    const unknown = journal.markSettingsUnknown(initial);
    assert.throws(() => journal.confirmSettings(unknown, 'c'.repeat(64)), /ack/i);
    const acked = journal.noteSettingsAck(unknown);
    assert.throws(() => journal.confirmSettings({ ...acked, revision: acked.revision - 1 }, 'c'.repeat(64)), /stale/i);
    const confirmed = journal.confirmSettings(acked, 'c'.repeat(64));
    assert.equal(confirmed.state, 'confirmed');
    assert.equal(confirmed.rpcAck, true);
    assert.equal(confirmed.effectiveFingerprint, 'c'.repeat(64));
    assert.equal(journal.hasUnconfirmed(), false);
    assert.deepEqual(journal.acceptedReceipts(), []);
    assert.throws(() => journal.confirmSettings(acked, 'd'.repeat(64)), /conflict|stale/i);
    journal.reserve(intent());
  } finally { journal.close(); }
  const reopened = new ManagedWorkerOperationJournal(scope);
  try { assert.equal(reopened.getSettings(operationId)?.state, 'confirmed'); }
  finally { reopened.close(); }
});

test('legacy two-state settings table migrates without erasing an unresolved operation', () => {
  const scope = fixture(), operationId = randomUUID();
  const old = new Database(scope.filePath);
  old.exec(`CREATE TABLE managed_worker_settings_operations (
    operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('dispatching','unknown')),
    rpc_ack INTEGER NOT NULL CHECK(rpc_ack IN (0,1)),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  old.prepare(`INSERT INTO managed_worker_settings_operations
    (operation_id,fingerprint,revision,state,rpc_ack,created_at,updated_at)
    VALUES (?, ?, 3, 'unknown', 1, 1, 1)`).run(operationId, fingerprint);
  old.close();
  const journal = new ManagedWorkerOperationJournal(scope);
  try {
    assert.equal(journal.hasUnconfirmed(), true);
    assert.throws(() => journal.reserve(intent()), /unsettled/i);
    const persisted = journal.getSettings(operationId);
    assert.ok(persisted);
    assert.equal(persisted.effectiveFingerprint, null);
    assert.equal(journal.confirmSettings(persisted, 'd'.repeat(64)).state, 'confirmed');
    assert.equal(journal.hasUnconfirmed(), false);
  } finally { journal.close(); }
  const reopened = new ManagedWorkerOperationJournal(scope);
  try { assert.equal(reopened.getSettings(operationId)?.state, 'confirmed'); }
  finally { reopened.close(); }
});
