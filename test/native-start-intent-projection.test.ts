import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { projectNativeStartIntents } from '../src/codex/native-start-intent-projection.js';
import type { NativeProjectionState } from '../src/codex/managed-native-projection.js';
import type { NativeStartIntentRecord } from '../src/codex/native-start-intent-store.js';
import type { WorkerOperation } from '../src/codex/managed-worker-operation-journal.js';

const scope = { ownerEpoch: randomUUID(), backendGeneration: 3, threadId: 'task' };
const input = [{ type: 'text', text: 'native message', text_elements: [] }];
function state(turns: Record<string, unknown>[] = []): NativeProjectionState {
  return { id: 'task', hostId: 'local', turns: turns as NativeProjectionState['turns'], requests: [],
    currentPermissions: {}, latestThreadSettings: {}, latestModel: null, latestReasoningEffort: null,
    cwd: 'C:/own', latestCollaborationMode: {}, previousTurnModel: null, title: null,
    threadRuntimeStatus: { type: 'idle' }, latestTokenUsageInfo: null, hasUnreadTurn: false, updatedAt: null };
}
function record(operationId: string, clientUserMessageId: string, uiParams: Record<string, unknown> | null =
  { input: structuredClone(input), model: 'native-model', permissionParamsSource: 'stored', marker: { n: 1 } }): NativeStartIntentRecord {
  return { operationId, clientUserMessageId, intent: {
    envelope: { conversationId: 'task', turnStart: { request: { threadId: 'task', clientUserMessageId } } },
    command: { operationId, method: 'turn/start', params: { threadId: 'task', clientUserMessageId, input: structuredClone(input) } },
    uiParams, localMetadata: uiParams === null ? null : { fileAttachmentCount: 0 },
    admission: { ...scope, snapshot: { id: 'task' } },
  } };
}
function operation(operationId: string, clientUserMessageId: string, state: WorkerOperation['state'], receiptId: string | null): WorkerOperation {
  return { ...scope, operationId, clientUserMessageId, method: 'turn/start', fingerprint: 'a'.repeat(64),
    revision: state === 'accepted' ? 1 : 0, state, receiptId, rejectionCode: null };
}
function turn(turnId: string, clientId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { turnId, status: 'inProgress', params: { input: structuredClone(input), clientUserMessageId: clientId,
    permissionParamsSource: 'inferred', backendOnly: true }, items: [{ id: `user-${turnId}`, type: 'userMessage',
      clientId, content: structuredClone(input) }], ...overrides };
}

test('waits for an accepted receipt turn and ignores unknown, rejected, or no-UI bindings', () => {
  const op = randomUUID(), client = randomUUID(), receipt = 'turn-1', r = record(op, client);
  const waiting = state();
  assert.equal(projectNativeStartIntents(waiting, [{ record: r, operation: operation(op, client, 'accepted', receipt) }]), waiting);
  const arrived = state([turn(receipt, client)]);
  assert.equal(projectNativeStartIntents(arrived, [{ record: r, operation: operation(op, client, 'unknown', null) }]), arrived);
  assert.equal(projectNativeStartIntents(arrived, [{ record: r, operation: operation(op, client, 'rejected', null) }]), arrived);
  assert.equal(projectNativeStartIntents(arrived, [{ record: record(op, client, null), operation: operation(op, client, 'accepted', receipt) }]), arrived);
});

test('overlays only a matching accepted projected turn and preserves the source state', () => {
  const op = randomUUID(), client = randomUUID(), receipt = 'turn-accepted';
  const source = state([turn('other', randomUUID()), turn(receipt, client)]);
  const stored = record(op, client);
  const result = projectNativeStartIntents(source, [{ record: stored, operation: operation(op, client, 'accepted', receipt) }]);
  assert.notEqual(result, source);
  assert.deepEqual((source.turns[1]!.params as Record<string, unknown>).permissionParamsSource, 'inferred');
  const params = result.turns[1]!.params as Record<string, unknown>;
  assert.deepEqual(params.input, input); assert.equal(params.model, 'native-model');
  assert.equal(params.fileAttachmentCount, 0); assert.equal('permissionParamsSource' in params, false);
  assert.deepEqual((result.turns[0]!.params as Record<string, unknown>).backendOnly, true);
  (params.marker as { n: number }).n = 9;
  assert.deepEqual(((stored.intent.uiParams as Record<string, unknown>).marker as { n: number }).n, 1);
  assert.deepEqual((source.turns[1]!.params as Record<string, unknown>).backendOnly, true);
});

test('waits when turn/started precedes its user item, then overlays after refresh', () => {
  const op = randomUUID(), client = randomUUID(), receipt = 'turn-refresh', binding =
    { record: record(op, client), operation: operation(op, client, 'accepted', receipt) };
  const waiting = state([{ turnId: receipt, status: 'inProgress',
    params: { input: [], clientUserMessageId: null }, items: [] }]);
  assert.equal(projectNativeStartIntents(waiting, [binding]), waiting);
  const refreshed = state([turn(receipt, client)]);
  assert.equal((projectNativeStartIntents(refreshed, [binding]).turns[0]!.params as Record<string, unknown>).model, 'native-model');
});

test('fails closed for conflicting receipt, user-client, record, operation, and input identities', () => {
  const op = randomUUID(), client = randomUUID(), receipt = 'turn-conflict', binding =
    { record: record(op, client), operation: operation(op, client, 'accepted', receipt) };
  assert.throws(() => projectNativeStartIntents(state([turn('wrong', client)]), [binding]));
  assert.throws(() => projectNativeStartIntents(state([turn(receipt, randomUUID())]), [binding]));
  assert.throws(() => projectNativeStartIntents(state([turn(receipt, client), turn('other', client)]), [binding]));
  assert.throws(() => projectNativeStartIntents(state([turn(receipt, client, { params: { input: [], clientUserMessageId: client } })]), [binding]));
  const otherOp = randomUUID();
  assert.throws(() => projectNativeStartIntents(state([turn(receipt, client)]), [binding,
    { record: record(otherOp, client), operation: operation(otherOp, client, 'accepted', 'other') }]));
  assert.throws(() => projectNativeStartIntents(state([turn(receipt, client)]), [{ record: record(op, client),
    operation: { ...operation(op, client, 'accepted', receipt), backendGeneration: 4 } }]));
});
