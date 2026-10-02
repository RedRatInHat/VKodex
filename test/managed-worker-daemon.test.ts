import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ManagedWorkerRegistry } from '../src/codex/managed-worker-registry.js';
import { BridgeStore } from '../src/bridge/store.js';
import { ManagedWorkerOperationJournal } from '../src/codex/managed-worker-operation-journal.js';
import Database from 'better-sqlite3';
import { DesktopIpcClient, encodeFrame, FrameDecoder } from '../src/desktop/ipc-client.js';
import { ManagedWorkerDaemon } from '../src/desktop/managed-worker-daemon.js';
import { OneShotComposerCommandGate, oneShotComposerCommandAuthorized } from '../src/desktop/one-shot-composer-command.js';
import type { ManagedWorkerDaemonOptions } from '../src/desktop/managed-worker-daemon.js';
import { ManagedWorkerControlServer } from '../src/desktop/managed-worker-control.js';
import { ManagedWorkerControlClient, ManagedWorkerControlUnknownError } from
  '../src/desktop/managed-worker-control-client.js';
import { ManagedWorkerStateTransport } from '../src/codex/managed-worker-state-transport.js';
import { managedVkStockCommandId } from '../src/desktop/managed-stock-vk-submit.js';
import { buildBackendWorkerSpawnOptions } from '../src/desktop/managed-worker-environment.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import { NativeStockQueueJournal } from '../src/codex/native-stock-queue-journal.js';
import { NativeStartIntentStore } from '../src/codex/native-start-intent-store.js';
import { ControlledNativeCreationJournal } from '../src/desktop/controlled-native-creation-journal.js';
import { captureControlledNativeSourcePreflight, persistControlledNativeSourcePreflightReceipt } from
  '../src/desktop/controlled-native-source-proof.js';
import { deriveControlledNativeCliSourceScope, assertControlledNativeCliSourceScopeCurrent,
  verifyControlledNativeCliSourceScope } from
  '../src/desktop/controlled-native-cli-source-scope.js';

test('daemon requires explicit follower and IPC policy before private state is read', () => {
  assert.throws(() => new ManagedWorkerDaemon({
    baseDirectory: 'C:\\private', epoch: '11111111-1111-4111-8111-111111111111',
  } as never), /explicit.*polic/i);
});

test('one-shot first Composer cannot be enabled without a callback or alongside stock queue', () => {
  const common = { baseDirectory: path.join(os.tmpdir(), 'vkodex-private-test'),
    epoch: '11111111-1111-4111-8111-111111111111',
    allowFollower: () => true, clientFactory: () => { throw new Error('unused'); },
    verifyFamilyQuiescent: async () => true };
  assert.throws(() => new ManagedWorkerDaemon({ ...common, oneShotFirstComposer: true as never }),
    /One-shot first Composer/);
  assert.throws(() => new ManagedWorkerDaemon({ ...common, oneShotFirstComposer: () => true,
    nativeStockQueue: {} as never }), /One-shot first Composer/);
});

test('refusal-only probe admits navigation but refuses Composer start and queue ingress without writes', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  const broker = own.brokers[0]!;
  try {
    assert.equal(own.daemon.metadata.state, 'ready');
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'probe-follower', params: { conversationId: own.taskId,
        hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));

    const direct = composerRequest(own.taskId, own.home, 'probe-direct-start');
    direct.sourceClientId = 'probe-follower';
    direct.requestId = 'probe-direct-start';
    broker.send(direct);
    broker.send({ type: 'request', requestId: 'probe-queue-state', sourceClientId: 'probe-follower',
      targetClientId: broker.ownerId, hostId: 'local',
      method: 'thread-follower-set-queued-follow-ups-state', version: 1,
      params: { hostId: 'local', conversationId: own.taskId, state: { [own.taskId]: [] } } });
    await waitFor(() => ['probe-direct-start', 'probe-queue-state'].every(requestId =>
      broker.frames.some(frame => frame.type === 'response' && frame.requestId === requestId)));
    for (const requestId of ['probe-direct-start', 'probe-queue-state']) {
      const response = broker.frames.find(frame => frame.type === 'response' && frame.requestId === requestId)!;
      assert.equal(response.resultType, 'error');
      assert.equal(response.error, 'error-handling-request');
    }

    const ingress = own.daemon.metadata.nativeStartup?.composerIngress;
    assert.equal(ingress?.directStartTurn.seen, 1);
    assert.equal(ingress?.directStartTurn.refused, 1);
    assert.equal(ingress?.queuedFollowUpsState.seen, 1);
    assert.equal(ingress?.queuedFollowUpsState.refused, 1);
    assert.equal(own.backend.methods.some(method => method === 'turn/start' ||
      method === 'thread/queue/add'), false);
    await assert.rejects(readFile(path.join(own.privateDirectory, 'start-intents.sqlite')));
    await assert.rejects(readFile(path.join(own.privateDirectory, 'native-stock.sqlite')));
    broker.send({ type: 'request', requestId: 'probe-discovery', sourceClientId: 'probe-follower',
      targetClientId: broker.ownerId, hostId: 'local', method: 'thread-owner-discovery', version: 1,
      params: { hostId: 'local', conversationId: own.taskId } });
    await waitFor(() => broker.frames.some(frame => frame.type === 'response' &&
      frame.requestId === 'probe-discovery'));
    assert.equal(broker.frames.find(frame => frame.type === 'response' &&
      frame.requestId === 'probe-discovery')?.resultType, 'success');
  } finally {
    await controlStop(own.privateDirectory, own.reserved.epoch, 'refusal-only-probe-stop');
  }
});

test('refusal-only probe cannot be combined with writer capabilities', () => {
  const common = { baseDirectory: path.join(os.tmpdir(), 'vkodex-private-test'),
    epoch: '11111111-1111-4111-8111-111111111111', allowFollower: () => true,
    clientFactory: () => { throw new Error('unused'); }, verifyFamilyQuiescent: async () => true,
    refusalOnlyProbe: true as const };
  assert.throws(() => new ManagedWorkerDaemon({ ...common,
    oneShotFirstComposer: () => true }), /refusal-only probe/i);
  assert.throws(() => new ManagedWorkerDaemon({ ...common,
    nativeStockQueue: {} as never }), /refusal-only probe/i);
  assert.throws(() => new ManagedWorkerDaemon({ ...common,
    nativeCliWebSocket: { capability: {}, noPendingExternalAutoStart: () => true } }),
  /refusal-only probe/i);
});

test('refusal-only diagnose-v1 reports empty worker-local mutation state after refused ingress', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  const broker = own.brokers[0]!;
  try {
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'proof-follower', params: { conversationId: own.taskId,
        hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));
    const direct = composerRequest(own.taskId, own.home, 'proof-direct-start');
    direct.sourceClientId = 'proof-follower'; direct.requestId = 'proof-direct-start';
    broker.send(direct);
    broker.send({ type: 'request', requestId: 'proof-queue', sourceClientId: 'proof-follower',
      targetClientId: broker.ownerId, hostId: 'local',
      method: 'thread-follower-set-queued-follow-ups-state', version: 1,
      params: { hostId: 'local', conversationId: own.taskId, state: { [own.taskId]: [] } } });
    // A real pending backend question cannot coexist with a zero-unresolved
    // proof. A synthetic follower answer still exercises the refusal route.
    broker.send({ type: 'request', requestId: 'proof-answer', sourceClientId: 'proof-follower',
      targetClientId: broker.ownerId, hostId: 'local',
      method: 'thread-follower-submit-user-input', version: 1,
      params: { conversationId: own.taskId, requestId: 'proof-question', response: { answers: {} } } });
    await waitFor(() => ['proof-direct-start', 'proof-queue', 'proof-answer'].every(requestId =>
      broker.frames.some(frame => frame.type === 'response' && frame.requestId === requestId)));
    for (const requestId of ['proof-direct-start', 'proof-queue', 'proof-answer']) {
      const response = broker.frames.find(frame => frame.type === 'response' && frame.requestId === requestId)!;
      assert.equal(response.resultType, 'error');
      assert.equal(response.error, 'error-handling-request');
    }
    const diagnosis = await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'refusal-only-evidence', 'diagnose-v1');
    assert.equal(diagnosis.error, undefined);
    const result = diagnosis.result as Record<string, unknown>;
    assert.equal(result.ownerEpoch, own.reserved.epoch);
    assert.equal(result.taskId, own.taskId);
    const evidence = (result as any).refusalOnlyEvidence;
    assert.deepEqual(evidence, {
      backendGeneration: own.daemon.metadata.generation,
      commandInFlight: 0,
      commandUnconfirmed: 0,
      operationJournalRows: 0,
      settingsJournalRows: 0,
      acceptedReceipts: 0,
      acceptedQueue: 0,
      pendingBackendRequests: 0,
      pendingNativeOperations: 0,
      pendingNativeEvents: 0,
      intentStore: 'absent',
    });
    assert.deepEqual(Object.keys(evidence).sort(), ['acceptedQueue', 'acceptedReceipts',
      'backendGeneration', 'commandInFlight', 'commandUnconfirmed', 'intentStore',
      'operationJournalRows', 'pendingBackendRequests', 'pendingNativeEvents',
      'pendingNativeOperations', 'settingsJournalRows'].sort());
    assert.deepEqual(own.backend.methods.filter(method => ['turn/start', 'thread/queue/add'].includes(method)), []);
    // The scoped operation journal itself exists; the proof covers its empty
    // mutation tables. Refusal mode must not create separate ingress stores.
    for (const file of ['start-intents.sqlite', 'native-stock.sqlite'])
      await assert.rejects(readFile(path.join(own.privateDirectory, file)));
  } finally {
    try { await controlStop(own.privateDirectory, own.reserved.epoch, 'refusal-only-evidence-stop'); }
    finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      if (own.backend.exitCode === null) own.backend.stdin.end();
    }
  }
});

test('ordinary diagnose-v1 never exposes refusal-only evidence', async () => {
  const own = await readyFixture();
  try {
    const diagnosis = await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'ordinary-no-refusal-proof', 'diagnose-v1');
    assert.equal(diagnosis.error, undefined);
    assert.equal(Object.hasOwn(diagnosis.result as object, 'refusalOnlyEvidence'), false);
  } finally {
    try { await controlStop(own.privateDirectory, own.reserved.epoch, 'ordinary-no-proof-stop'); }
    finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      if (own.backend.exitCode === null) own.backend.stdin.end();
    }
  }
});

test('refusal-only evidence is absent while a backend question remains unresolved', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  try {
    const broker = own.brokers[0]!;
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'pending-proof-follower', params: { conversationId: own.taskId,
        hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));
    own.backend.stdout.write(JSON.stringify({ id: 'pending-proof-question',
      method: 'item/tool/requestUserInput', params: { threadId: own.taskId,
        turnId: 'proof-turn', itemId: 'proof-item', questions: [] } }) + '\n');
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed' &&
      JSON.stringify(frame).includes('pending-proof-question')));
    const diagnosis = await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'pending-refusal-proof', 'diagnose-v1');
    assert.equal(diagnosis.error, undefined);
    assert.equal(Object.hasOwn(diagnosis.result as object, 'refusalOnlyEvidence'), false);
  } finally {
    try { await controlStop(own.privateDirectory, own.reserved.epoch, 'pending-proof-stop'); }
    finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      if (own.backend.exitCode === null) own.backend.stdin.end();
    }
  }
});

test('refusal-only async canary evidence returns only scoped empty-state facts', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  try {
    const evidence = await (own.daemon as any).nativeRefusalCanaryEvidence();
    const zero = { backendGeneration: own.daemon.metadata.generation, commandInFlight: 0,
      commandUnconfirmed: 0, operationJournalRows: 0, settingsJournalRows: 0,
      acceptedReceipts: 0, acceptedQueue: 0, pendingBackendRequests: 0,
      pendingNativeOperations: 0, pendingNativeEvents: 0, intentStore: 'absent' };
    assert.deepEqual(evidence, { ownerEpoch: own.reserved.epoch, taskId: own.taskId,
      backendGeneration: own.daemon.metadata.generation, nativeState: 'connected',
      threadStatus: 'idle', turnsEmpty: true, queueEmpty: true, goalEmpty: true,
      refusalOnlyEvidence: zero });
    assert.deepEqual(Object.keys(evidence).sort(), ['backendGeneration', 'goalEmpty',
      'nativeState', 'ownerEpoch', 'queueEmpty', 'refusalOnlyEvidence', 'taskId',
      'threadStatus', 'turnsEmpty'].sort());
    assert.deepEqual(Object.keys(evidence.refusalOnlyEvidence).sort(), Object.keys(zero).sort());
    assert.doesNotMatch(JSON.stringify(evidence), /prompt|PRIVATE_|requestId|turnId|goalText/iu);
    assert.ok(own.backend.frames.some(frame => frame.method === 'thread/read' &&
      (frame.params as Record<string, unknown> | undefined)?.includeTurns === false));
    assert.ok(own.backend.frames.some(frame => frame.method === 'thread/turns/list' &&
      (frame.params as Record<string, unknown> | undefined)?.itemsView === 'summary'));
  } finally {
    try { await controlStop(own.privateDirectory, own.reserved.epoch, 'native-refusal-evidence-stop'); }
    finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      if (own.backend.exitCode === null) own.backend.stdin.end();
    }
  }
});

test('refusal-only async canary evidence rejects missing local proof and native nonempty state', async () => {
  const ordinary = await readyFixture();
  try {
    await assert.rejects((ordinary.daemon as any).nativeRefusalCanaryEvidence(),
      /Native refusal canary evidence unavailable$/);
  } finally {
    try { await controlStop(ordinary.privateDirectory, ordinary.reserved.epoch, 'no-local-proof-stop'); }
    finally {
      await (ordinary.control as ManagedWorkerControlServer | null)?.close();
      if (ordinary.backend.exitCode === null) ordinary.backend.stdin.end();
    }
  }
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  try {
    own.backend.readStatusOverride = 'active';
    await assert.rejects((own.daemon as any).nativeRefusalCanaryEvidence(),
      /Native refusal canary evidence unavailable$/);
    own.backend.readStatusOverride = null;
    own.backend.terminalQueueClients = [];
    await assert.rejects((own.daemon as any).nativeRefusalCanaryEvidence(),
      /Native refusal canary evidence unavailable$/);
    own.backend.terminalQueueClients = null;
    own.backend.goalOverride = { text: 'PRIVATE_GOAL_SENTINEL' };
    await assert.rejects((own.daemon as any).nativeRefusalCanaryEvidence(),
      /Native refusal canary evidence unavailable$/);
    own.backend.goalOverride = null;
    own.backend.queueEntries = [{ text: 'PRIVATE_QUEUE_SENTINEL' }];
    await assert.rejects((own.daemon as any).nativeRefusalCanaryEvidence(),
      /Native refusal canary evidence unavailable$/);
  } finally {
    try { await controlStop(own.privateDirectory, own.reserved.epoch, 'native-nonempty-stop'); }
    finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      if (own.backend.exitCode === null) own.backend.stdin.end();
    }
  }
});

test('refusal-only async canary evidence rejects a backend question unresolved before its scoped reads', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  const broker = own.brokers[0]!;
  try {
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'async-proof-follower', params: { conversationId: own.taskId,
        hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));
    own.backend.stdout.write(JSON.stringify({ id: 'async-proof-question',
      method: 'item/tool/requestUserInput', params: { threadId: own.taskId,
        turnId: 'private-turn-id', itemId: 'private-item-id', questions: [] } }) + '\n');
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed' &&
      JSON.stringify(frame).includes('async-proof-question')));
    await assert.rejects((own.daemon as any).nativeRefusalCanaryEvidence(),
      /Native refusal canary evidence unavailable$/);
    own.backend.stdout.write(JSON.stringify({ method: 'serverRequest/resolved',
      params: { threadId: own.taskId, requestId: 'async-proof-question' } }) + '\n');
    await waitFor(() => {
      const latest = broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').at(-1);
      return !!latest && !JSON.stringify(latest).includes('async-proof-question');
    });
  } finally {
    try { await controlStop(own.privateDirectory, own.reserved.epoch, 'native-pending-question-stop'); }
    finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      if (own.backend.exitCode === null) own.backend.stdin.end();
    }
  }
});

test('refusal-only async canary evidence rejects semantic and backend identity races during ownerRead', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  const broker = own.brokers[0]!;
  try {
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'race-proof-follower', params: { conversationId: own.taskId,
        hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));
    own.backend.holdEvidenceRead = true;
    const semanticRace = (own.daemon as any).nativeRefusalCanaryEvidence();
    await waitFor(() => own.backend.heldEvidenceRead !== null);
    own.backend.stdout.write(JSON.stringify({ method: 'turn/started', params: {
      threadId: own.taskId, turn: { id: 'private-race-turn', status: 'inProgress',
        startedAt: 1780000000, items: [] } } }) + '\n');
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed' &&
      JSON.stringify(frame).includes('private-race-turn')));
    own.backend.answerHeldEvidenceRead();
    await assert.rejects(semanticRace, /Native refusal canary evidence unavailable$/);
  } finally {
    try { await controlStop(own.privateDirectory, own.reserved.epoch, 'native-race-evidence-stop'); }
    finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      if (own.backend.exitCode === null) own.backend.stdin.end();
    }
  }
  const identity = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    undefined, true, false, true);
  try {
    identity.backend.holdEvidenceRead = true;
    const identityRace = (identity.daemon as any).nativeRefusalCanaryEvidence();
    await waitFor(() => identity.backend.heldEvidenceRead !== null);
    identity.backend.birthDrift = true;
    identity.backend.answerHeldEvidenceRead();
    await assert.rejects(identityRace, /Native refusal canary evidence unavailable$/);
  } finally {
    identity.backend.birthDrift = false;
    try { await controlStop(identity.privateDirectory, identity.reserved.epoch, 'native-identity-evidence-stop'); }
    finally {
      await (identity.control as ManagedWorkerControlServer | null)?.close();
      if (identity.backend.exitCode === null) identity.backend.stdin.end();
    }
  }
});

test('one-shot command policy admits only the exact persisted first Composer intent', () => {
  const operationId = randomUUID(), clientUserMessageId = randomUUID();
  const scope = { ownerEpoch: randomUUID(), backendGeneration: 1, threadId: 'own-zero-turn',
    operationId, method: 'turn/start' as const,
    params: { threadId: 'own-zero-turn', clientUserMessageId, input: [{ type: 'text', text: 'canary' }] } };
  const record = { operationId, clientUserMessageId,
    intent: { envelope: {}, command: { operationId, method: 'turn/start' as const,
      params: structuredClone(scope.params) }, uiParams: { source: 'Composer' }, localMetadata: null,
    admission: { ownerEpoch: scope.ownerEpoch, backendGeneration: scope.backendGeneration,
      snapshot: { id: scope.threadId }, composer: { snapshot: { turns: [] } } } } };
  const store = { get: (id: string) => id === operationId ? record : null };
  assert.equal(oneShotComposerCommandAuthorized(null, scope), false);
  assert.equal(oneShotComposerCommandAuthorized(store, scope), true);
  assert.equal(oneShotComposerCommandAuthorized({ get: () => null }, scope), false);
  assert.equal(oneShotComposerCommandAuthorized(store, { ...scope,
    params: { ...scope.params, input: [{ type: 'text', text: 'other' }] } }), false);
  assert.equal(oneShotComposerCommandAuthorized({ get: () => ({ ...record,
    intent: { ...record.intent, uiParams: null } }) }, scope), false);
  assert.equal(oneShotComposerCommandAuthorized({ get: () => ({ ...record,
    intent: { ...record.intent, admission: { ...record.intent.admission,
      composer: { snapshot: { turns: [{ id: 'older' }] } } } } }) }, scope), false);
  assert.equal(oneShotComposerCommandAuthorized({ get: () => { throw new Error('bad seal'); } }, scope), false);
  const gate = new OneShotComposerCommandGate();
  assert.equal(gate.authorize(store, scope), false, 'persisted intent alone cannot bypass the first qualifier');
  gate.note(scope, 'before-reservation', true);
  assert.equal(gate.authorize(store, scope), true);
  gate.note(scope, 'before-write', false);
  assert.equal(gate.authorize(store, scope), false, 'a failed final qualifier clears the temporary grant');
  gate.note(scope, 'before-reservation', true);
  gate.settle(scope);
  assert.equal(gate.authorize(store, scope), false, 'settled admission cannot leave an open command gate');
});

test('opt-in native task-state listener publishes initial and changed state without another backend request', async () => {
  const own = await readyFixture({ allow: true }, { enabled: false, early: false }, 'normal', false, null, undefined, undefined, true);
  try {
    const endpoint = JSON.parse(await readFile(path.join(own.privateDirectory, 'endpoint.v1.json'), 'utf8')) as {
      epoch: string; taskState?: { host: string; port: number }; control: { port: number };
    };
    assert.equal(endpoint.epoch, own.reserved.epoch);
    assert.ok(endpoint.taskState);
    assert.deepEqual(Object.keys(endpoint.taskState!).sort(), ['host', 'port']);
    assert.doesNotMatch(JSON.stringify(endpoint), /(?:token|fingerprint|intent)/iu);
    const before = own.backend.methods.filter(method => method === 'thread/resume').length;
    const observed = await observeNativeTaskState(endpoint.taskState!, own.reserved.epoch, own.taskId,
      own.daemon.metadata.generation!);
    assert.equal(observed.frames.find(frame => frame.kind === 'snapshot')?.historyComplete, true);
    own.backend.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: own.taskId,
      turn: { id: 'observation-only-turn', status: 'inProgress', startedAt: 1780000000, items: [] } } }) + '\n');
    await waitFor(() => observed.frames.some(frame => frame.kind === 'changed'));
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length, before);
    assert.equal(own.launches, 1);
    observed.socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(own.daemon.metadata.state, 'ready');
    assert.equal(own.backend.exitCode, null);
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'state-stop')).result, { stopped: true });
  } finally {
    if (own.backend.exitCode === null) own.backend.stdin.end();
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('native task-state endpoint remains absent without the explicit daemon opt-in', async () => {
  const own = await readyFixture();
  try {
    const endpoint = JSON.parse(await readFile(path.join(own.privateDirectory, 'endpoint.v1.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(Object.hasOwn(endpoint, 'taskState'), false);
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'no-state-stop')).result, { stopped: true });
  } finally {
    if (own.backend.exitCode === null) own.backend.stdin.end();
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('native CLI WebSocket is opt-in and requires an isolated read-only policy', async () => {
  const ordinary = await readyFixture();
  try {
    assert.throws(() => ordinary.daemon.nativeCliWebSocketCapability({}), /unavailable/i);
    const endpoint = JSON.parse(await readFile(path.join(ordinary.privateDirectory,
      'endpoint.v1.json'), 'utf8')) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(endpoint), /websocket|bearer|token/iu);
  } finally {
    await controlStop(ordinary.privateDirectory, ordinary.reserved.epoch, 'ordinary-stop');
  }
  const capability = {}, cli = { capability, noPendingExternalAutoStart: () => true };
  const readOnly = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined, cli);
  try {
    await assert.rejects(readOnly.daemon.nativeCliCanaryEvidence(capability), /unavailable/i);
  } finally { await controlStop(readOnly.privateDirectory, readOnly.reserved.epoch, 'read-only-evidence-stop'); }
  await assert.rejects(readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined, cli, false),
  /startup unavailable/);
  const common = { baseDirectory: path.join(os.tmpdir(), 'vkodex-private-test'),
    epoch: randomUUID(), allowFollower: () => true, clientFactory: () => { throw new Error('unused'); },
    verifyFamilyQuiescent: async () => true, nativeCliWebSocket: cli };
  assert.throws(() => new ManagedWorkerDaemon({ ...common,
    nativeStockQueue: {} as never }), /Native CLI WebSocket requires/);
  assert.throws(() => new ManagedWorkerDaemon({ ...common,
    oneShotFirstComposer: () => true }), /Native CLI WebSocket requires/);
  assert.throws(() => new ManagedWorkerDaemon({ ...common,
    nativeCliWebSocket: { ...cli, singleAcceptedStart: true } }), /Native CLI WebSocket requires/);
  assert.throws(() => new ManagedWorkerDaemon({ ...common,
    nativeCliWebSocket: { ...cli, singleAcceptedStart: true,
      sourceScope: {} as never } }), /source scope/i);
});

test('controlled native CLI canary evidence is capability-bound and contains only scalar receipts', async () => {
  const ordinary = await readyFixture();
  try {
    await assert.rejects(ordinary.daemon.nativeCliCanaryEvidence({}), /unavailable/i);
  } finally { await controlStop(ordinary.privateDirectory, ordinary.reserved.epoch, 'ordinary-evidence-stop'); }
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  try {
    await assert.rejects(own.daemon.nativeCliCanaryEvidence({}), /unavailable/i);
    const first = await own.daemon.nativeCliCanaryEvidence(capability);
    const locator = JSON.parse(await readFile(path.join(own.privateDirectory,
      'startup-control.v1.json'), 'utf8')) as { control: { port: number } };
    const controlClient = new ManagedWorkerControlClient({ host: '127.0.0.1',
      port: locator.control.port, token: Buffer.alloc(32, 3).toString('base64url'),
      ownerEpoch: own.reserved.epoch, taskId: own.taskId });
    assert.deepEqual(await controlClient.nativeCliCanaryEvidence(), first);
    assert.equal(first.taskId, own.taskId);
    assert.equal(first.ownerEpoch, own.reserved.epoch);
    assert.equal(first.backendGeneration, own.daemon.metadata.generation);
    assert.equal(first.nativeState, 'connected');
    assert.equal(first.threadStatus, 'idle');
    assert.deepEqual(first.turns, []);
    assert.deepEqual(first.acceptedStartSha256, []);
    assert.equal(first.goalEmpty, true);
    assert.equal(first.queueEmpty, true);
    assert.equal(first.commandInFlight, 0);
    assert.equal(first.commandUnconfirmed, false);
    assert.equal(first.requestsUnresolved, 0);
    assert.equal(first.pendingNativeOperations, 0);
    assert.equal(first.pendingEvents, 0);
    const evidenceRead = own.backend.frames.find(frame => frame.method === 'thread/read' &&
      (frame.params as Record<string, unknown> | undefined)?.includeTurns === false);
    assert.ok(evidenceRead, 'canary evidence must not clone the full thread history');
    assert.ok(own.backend.frames.some(frame => frame.method === 'thread/turns/list' &&
      (frame.params as Record<string, unknown> | undefined)?.itemsView === 'summary'));
    const canaryReads = own.backend.frames.slice(-8).map(frame => frame.method);
    assert.ok(canaryReads.every(method => ['thread/goal/get', 'thread/queue/list',
      'thread/read', 'thread/turns/list'].includes(String(method))));
    assert.equal(own.backend.writes, 0);
    assert.deepEqual(Object.keys(first).sort(), [
      'acceptedStartSha256', 'backendGeneration', 'commandInFlight', 'commandUnconfirmed',
      'goalEmpty', 'nativeState', 'ownerEpoch', 'pendingEvents', 'pendingNativeOperations',
      'queueEmpty', 'requestsUnresolved', 'taskId', 'threadStatus', 'turns', 'turnsPageComplete',
    ].sort());
    own.backend.goalOverride = { text: 'PRIVATE_GOAL_SENTINEL' };
    own.backend.queueEntries = [{ text: 'PRIVATE_QUEUE_SENTINEL' }];
    const occupied = await own.daemon.nativeCliCanaryEvidence(capability);
    assert.equal(occupied.goalEmpty, false);
    assert.equal(occupied.queueEmpty, false);
    assert.doesNotMatch(JSON.stringify(occupied), /PRIVATE_(?:GOAL|QUEUE)_SENTINEL/u);
    own.backend.goalOverride = null;
    own.backend.queueEntries = [];
  } finally {
    await controlStop(own.privateDirectory, own.reserved.epoch, 'canary-evidence-stop');
  }
});

test('controlled native CLI canary classifies a failed turn without exposing its error text', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  try {
    own.backend.writes = 1;
    own.backend.readStatusOverride = 'systemError';
    own.backend.turnFailureError = { codexErrorInfo: 'serverOverloaded',
      message: 'PRIVATE_NATIVE_ERROR_SENTINEL' };
    const evidence = await own.daemon.nativeCliCanaryEvidence(capability);
    assert.equal(evidence.threadStatus, 'systemError');
    assert.deepEqual(evidence.turns, [{
      idSha256: createHash('sha256').update('accepted-composer-turn').digest('hex'),
      status: 'failed', failureKind: 'serverOverloaded',
    }]);
    assert.ok(own.backend.frames.some(frame => frame.method === 'thread/turns/list' &&
      (frame.params as Record<string, unknown> | undefined)?.itemsView === 'full'));
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_NATIVE_ERROR_SENTINEL/u);
  } finally {
    own.backend.readStatusOverride = null;
    own.backend.turnFailureError = null;
    own.backend.writes = 0;
    await controlStop(own.privateDirectory, own.reserved.epoch, 'failed-cli-evidence-stop');
  }
});

test('isolated CLI Gateway permits only non-refreshing account bootstrap read', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  const client = await nativeCliClient(own.daemon.nativeCliWebSocketCapability(capability));
  try {
    await client.request('initialize', 'initialize',
      { clientInfo: { name: 'fixture' }, capabilities: {} });
    client.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const allowed = await client.request('account-read', 'account/read', { refreshToken: false });
    assert.equal((allowed.result as { account: { type: string } }).account.type, 'chatgpt');
    for (const params of [{ refreshToken: true }, { refreshToken: 'false' },
      { refreshToken: false, includeToken: true }]) {
      const rejected = await client.request(randomUUID(), 'account/read', params);
      assert.equal((rejected.error as { code: number }).code, -32601);
    }
    assert.equal(own.backend.methods.filter(method => method === 'account/read').length, 1);
    assert.equal(own.backend.frames.filter(frame => frame.method === 'turn/start').length, 0);
    assert.deepEqual((await own.daemon.nativeCliCanaryEvidence(capability)).acceptedStartSha256, []);
  } finally {
    client.socket.terminate();
    await controlStop(own.privateDirectory, own.reserved.epoch, 'cli-account-bootstrap-stop');
  }
});

test('controlled native CLI canary evidence permits only one outstanding history read', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  try {
    const locator = JSON.parse(await readFile(path.join(own.privateDirectory,
      'startup-control.v1.json'), 'utf8')) as { control: { port: number } };
    const controlClient = new ManagedWorkerControlClient({ host: '127.0.0.1',
      port: locator.control.port, token: Buffer.alloc(32, 3).toString('base64url'),
      ownerEpoch: own.reserved.epoch, taskId: own.taskId });
    own.backend.holdEvidenceRead = true;
    const first = controlClient.nativeCliCanaryEvidence();
    await waitFor(() => own.backend.heldEvidenceRead !== null, 1500);
    const reads = own.backend.frames.length;
    await assert.rejects(controlClient.nativeCliCanaryEvidence(), ManagedWorkerControlUnknownError);
    assert.equal(own.backend.frames.length, reads);
    assert.equal(own.backend.writes, 0);
    own.backend.answerHeldEvidenceRead();
    assert.equal((await first).turnsPageComplete, true);
    assert.equal((await controlClient.nativeCliCanaryEvidence()).turnsPageComplete, true);
  } finally {
    await controlStop(own.privateDirectory, own.reserved.epoch, 'canary-singleflight-stop');
  }
});

test('native CLI WebSocket admits one qualified plain-text turn through the same durable worker', async () => {
  const capability = {}; let externalIdle = false;
  const cli = { capability, noPendingExternalAutoStart: () => externalIdle,
    singleAcceptedStart: true as const };
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined, cli);
  let client: Awaited<ReturnType<typeof nativeCliClient>> | null = null;
  try {
    assert.throws(() => own.daemon.nativeCliWebSocketCapability({}), /unavailable/i);
    const bearer = own.daemon.nativeCliWebSocketCapability(capability);
    assert.equal(bearer.protocol, 'websocket');
    assert.equal(bearer.host, '127.0.0.1');
    assert.doesNotMatch(JSON.stringify(own.daemon.metadata), /websocket|bearer|token/iu);
    const endpoint = JSON.parse(await readFile(path.join(own.privateDirectory,
      'endpoint.v1.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(JSON.stringify(endpoint).includes(bearer.token), false);
    client = await nativeCliClient(bearer);
    assert.equal((await client.request('initialize', 'initialize',
      { clientInfo: { name: 'fixture' }, capabilities: {} })).id, 'initialize');
    client.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const params = { threadId: own.taskId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: 'one CLI turn' }], turnTrigger: null, toolOutput: null,
      responsesapiClientMetadata: null, additionalContext: null, environments: null,
      cwd: own.home, runtimeWorkspaceRoots: [own.home], approvalPolicy: 'never',
      approvalsReviewer: 'user', sandboxPolicy: null, permissions: ':read-only',
      model: 'gpt-5.6-sol', serviceTier: null, serviceTierForTurn: null, effort: 'low',
      summary: null, personality: null, outputSchema: null,
      collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-sol',
        reasoning_effort: 'low', developer_instructions: null } },
      multiAgentMode: null, cyberAccessProgram: null };
    const denied = async (id: string) => {
      const reply = await client!.request(id, 'turn/start', params);
      assert.equal((reply.error as { code: number }).code, -32602);
      assert.equal(own.backend.writes, 0);
    };
    await denied('before-resume');
    const resumed = await client.request('resume', 'thread/resume', { threadId: own.taskId });
    assert.equal((resumed.result as { thread: { id: string } }).thread.id, own.taskId);
    await denied('external-scheduler'); externalIdle = true;
    own.backend.terminalQueueClients = [];
    await denied('preexisting-native-turn'); own.backend.terminalQueueClients = null;
    own.backend.queueEntries = [{ id: 'pending-queue' }];
    await denied('queued'); own.backend.queueEntries = [];
    own.backend.goalOverride = { id: 'pending-goal' };
    await denied('goal'); own.backend.goalOverride = null;
    own.backend.readStatusOverride = 'active';
    await denied('active'); own.backend.readStatusOverride = null;
    const accepted = await client.request('accepted', 'turn/start', params);
    assert.deepEqual(accepted.result, { turn: { id: 'accepted-composer-turn',
      status: 'inProgress', extra: true } });
    const evidence = await own.daemon.nativeCliCanaryEvidence(capability);
    const acceptedSha256 = createHash('sha256').update('accepted-composer-turn').digest('hex');
    assert.deepEqual(evidence.acceptedStartSha256, [acceptedSha256]);
    assert.deepEqual(evidence.turns, [{ idSha256: acceptedSha256, status: 'completed' }]);
    assert.equal(evidence.turnsPageComplete, true);
    assert.equal(evidence.commandUnconfirmed, false);
    assert.doesNotMatch(JSON.stringify(evidence), /accepted-composer-turn|one CLI turn|extra/iu);
    assert.equal(own.backend.writes, 1);
    assert.equal(own.launches, 1);
    assert.equal(own.backend.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.deepEqual(own.backend.frames.find(frame => frame.method === 'turn/start')?.params, params);
    const journal = new Database(path.join(own.privateDirectory, 'operations.sqlite'), { readonly: true });
    try {
      assert.equal((journal.prepare("SELECT count(*) AS n FROM managed_worker_operations WHERE state = 'accepted'")
        .get() as { n: number }).n, 1);
    } finally { journal.close(); }
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'cli-stop')).result,
      { stopped: true });
    assert.throws(() => own.daemon.nativeCliWebSocketCapability(capability), /unavailable/i);
    await waitFor(() => client!.socket.readyState === WebSocket.CLOSED);
  } finally {
    client?.socket.terminate();
    if (own.backend.exitCode === null) own.backend.stdin.end();
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('active CLI turn survives native Gateway reconnect without a second worker start', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  const client = await nativeCliClient(own.daemon.nativeCliWebSocketCapability(capability));
  let stopResult: Record<string, unknown> | undefined;
  try {
    await client.request('initialize', 'initialize',
      { clientInfo: { name: 'fixture' }, capabilities: {} });
    client.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    await client.request('resume', 'thread/resume', { threadId: own.taskId });
    const params = { threadId: own.taskId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: 'one active CLI turn' }], turnTrigger: null,
      toolOutput: null, responsesapiClientMetadata: null, additionalContext: null,
      environments: null, cwd: own.home, runtimeWorkspaceRoots: [own.home],
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: null,
      permissions: ':read-only', model: 'gpt-5.6-sol', serviceTier: null,
      serviceTierForTurn: null, effort: 'low', summary: null, personality: null,
      outputSchema: null, collaborationMode: { mode: 'default', settings: {
        model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } },
      multiAgentMode: null, cyberAccessProgram: null };
    const accepted = await client.request('accepted', 'turn/start', params);
    assert.equal((accepted.result as { turn: { status: string } }).turn.status, 'inProgress');
    own.backend.activeTurn = true;
    own.backend.readStatusOverride = 'inProgress';
    const active = await own.daemon.nativeCliCanaryEvidence(capability);
    const turnHash = createHash('sha256').update('accepted-composer-turn').digest('hex');
    assert.deepEqual(active.turns, [{ idSha256: turnHash, status: 'inProgress' }]);
    assert.deepEqual(active.acceptedStartSha256, [turnHash]);
    const resumesBeforeFault = own.backend.methods.filter(method => method === 'thread/resume').length;

    own.brokers[0]!.destroy();
    await waitFor(() => own.daemon.metadata.nativeState === 'disconnected', 1500);
    assert.equal(own.backend.exitCode, null);
    await waitFor(() => own.brokers.length === 2 &&
      own.daemon.metadata.nativeState === 'connected', 4000);
    const rejoined = await own.daemon.nativeCliCanaryEvidence(capability);
    assert.deepEqual(rejoined.turns, active.turns);
    assert.deepEqual(rejoined.acceptedStartSha256, active.acceptedStartSha256);
    assert.equal(rejoined.backendGeneration, active.backendGeneration);
    assert.equal(rejoined.ownerEpoch, active.ownerEpoch);
    assert.equal(rejoined.commandInFlight, 0);
    assert.equal(rejoined.commandUnconfirmed, false);
    assert.equal(rejoined.requestsUnresolved, 0);
    assert.equal(rejoined.goalEmpty, true);
    assert.equal(rejoined.queueEmpty, true);
    assert.equal(own.daemon.metadata.state, 'ready');
    assert.equal(own.launches, 1);
    assert.equal(own.backend.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length,
      resumesBeforeFault);
    assert.ok((await client.request('after-reconnect', 'thread/read',
      { threadId: own.taskId, includeTurns: true })).result);

    own.backend.activeTurn = false;
    own.backend.readStatusOverride = null;
    const terminal = await own.daemon.nativeCliCanaryEvidence(capability);
    assert.deepEqual(terminal.turns, [{ idSha256: turnHash, status: 'completed' }]);
    assert.deepEqual(terminal.acceptedStartSha256, [turnHash]);
  } finally {
    client.socket.terminate();
    try {
      stopResult = await controlStop(own.privateDirectory, own.reserved.epoch,
        'active-cli-reconnect-stop');
    } finally {
      if (own.backend.exitCode === null) own.backend.stdin.end();
      await (own.control as ManagedWorkerControlServer | null)?.close();
    }
  }
  assert.deepEqual(stopResult?.result, { stopped: true });
});

test('active accepted CLI turn reaches a fresh managed state subscriber once after the prior subscriber closes', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, true, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  const client = await nativeCliClient(own.daemon.nativeCliWebSocketCapability(capability));
  let first: ReturnType<ManagedWorkerStateTransport['subscribe']> | null = null;
  let fresh: ReturnType<ManagedWorkerStateTransport['subscribe']> | null = null;
  let firstTransport: ManagedWorkerStateTransport | null = null;
  let freshTransport: ManagedWorkerStateTransport | null = null;
  let stopResult: Record<string, unknown> | undefined;
  try {
    await client.request('initialize', 'initialize',
      { clientInfo: { name: 'fixture' }, capabilities: {} });
    client.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    await client.request('resume', 'thread/resume', { threadId: own.taskId });
    const resumesBeforeSubscribers = own.backend.methods.filter(method => method === 'thread/resume').length;
    const params = { threadId: own.taskId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: 'one observed active CLI turn' }], turnTrigger: null,
      toolOutput: null, responsesapiClientMetadata: null, additionalContext: null,
      environments: null, cwd: own.home, runtimeWorkspaceRoots: [own.home],
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: null,
      permissions: ':read-only', model: 'gpt-5.6-sol', serviceTier: null,
      serviceTierForTurn: null, effort: 'low', summary: null, personality: null,
      outputSchema: null, collaborationMode: { mode: 'default', settings: {
        model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } },
      multiAgentMode: null, cyberAccessProgram: null };
    const accepted = await client.request('accepted-observed', 'turn/start', params);
    assert.equal((accepted.result as { turn: { status: string } }).turn.status, 'inProgress');
    own.backend.activeTurn = true;
    own.backend.readStatusOverride = 'inProgress';
    own.backend.stdout.write(JSON.stringify({ method: 'turn/started', params: {
      threadId: own.taskId, turn: { id: 'accepted-composer-turn', status: 'inProgress',
        startedAt: 1780000000, items: [] } } }) + '\n');

    const endpoint = JSON.parse(await readFile(path.join(own.privateDirectory,
      'endpoint.v1.json'), 'utf8')) as { taskState: { port: number } };
    const ownerEpoch = own.reserved.epoch, backendGeneration = own.daemon.metadata.generation!;
    const token = createHmac('sha256', Buffer.alloc(32, 3))
      .update('vkodex-managed-task-state-v1\0').update(ownerEpoch).update('\0').update(own.taskId)
      .update('\0').update(String(backendGeneration)).digest('base64url');
    const scope = { hostId: 'local' as const, taskId: own.taskId, ownerEpoch, backendGeneration,
      port: endpoint.taskState.port, token };
    const firstStates: Array<{ turns: Array<{ status: string }> }> = [], firstErrors: Error[] = [];
    firstTransport = new ManagedWorkerStateTransport(scope);
    first = firstTransport.subscribe({ hostId: 'local', threadId: own.taskId }, state => {
      firstStates.push(state as { turns: Array<{ status: string }> });
    }, error => firstErrors.push(error));
    await first.start();
    assert.equal(firstStates.length, 1);
    assert.equal(firstStates[0]?.turns[0]?.status, 'inProgress');
    first.close(); firstTransport.close();

    const freshStates: Array<{ turns: Array<{ status: string }> }> = [], freshErrors: Error[] = [];
    freshTransport = new ManagedWorkerStateTransport(scope);
    fresh = freshTransport.subscribe({ hostId: 'local', threadId: own.taskId }, state => {
      freshStates.push(state as { turns: Array<{ status: string }> });
    }, error => freshErrors.push(error));
    await fresh.start();
    assert.equal(freshStates.length, 1);
    assert.equal(freshStates[0]?.turns[0]?.status, 'inProgress');

    own.backend.activeTurn = false;
    own.backend.readStatusOverride = null;
    own.backend.stdout.write(JSON.stringify({ method: 'turn/completed', params: {
      threadId: own.taskId, turn: { id: 'accepted-composer-turn', status: 'completed',
        startedAt: 1780000000, completedAt: 1780000001, items: [] } } }) + '\n');
    await waitFor(() => freshStates.length === 2);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(firstStates.length, 1, 'detached subscriber receives no terminal update');
    assert.equal(freshStates.length, 2, 'fresh subscriber receives terminal state exactly once');
    assert.equal(freshStates[1]?.turns[0]?.status, 'completed');
    assert.deepEqual(firstErrors, []);
    assert.deepEqual(freshErrors, []);
    assert.equal(own.daemon.metadata.epoch, ownerEpoch);
    assert.equal(own.daemon.metadata.generation, backendGeneration);
    assert.equal(own.launches, 1);
    assert.equal(own.backend.frames.filter(frame => frame.method === 'turn/start').length, 1);
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length,
      resumesBeforeSubscribers);
  } finally {
    first?.close(); fresh?.close();
    firstTransport?.close(); freshTransport?.close();
    client.socket.terminate();
    try {
      stopResult = await controlStop(own.privateDirectory, own.reserved.epoch,
        'managed-state-subscriber-reconnect-stop');
    } finally {
      if (own.backend.exitCode === null) own.backend.stdin.end();
      await (own.control as ManagedWorkerControlServer | null)?.close();
    }
  }
  assert.deepEqual(stopResult?.result, { stopped: true });
});

test('controlled CLI source scope refuses journal, source, and manifest drift', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  try {
    const scope = own.cliOptions!.sourceScope!;
    const locator = JSON.parse(await readFile(path.join(own.privateDirectory,
      'startup-control.v1.json'), 'utf8')) as { control: { port: number } };
    const controlClient = new ManagedWorkerControlClient({ host: '127.0.0.1',
      port: locator.control.port, token: Buffer.alloc(32, 3).toString('base64url'),
      ownerEpoch: own.reserved.epoch, taskId: own.taskId });
    await verifyControlledNativeCliSourceScope(scope);
    assert.doesNotThrow(() => assertControlledNativeCliSourceScopeCurrent(scope));
    await controlClient.nativeCliCanaryEvidence();
    await assert.rejects(verifyControlledNativeCliSourceScope(scope, {
      taskId: randomUUID(), home: own.home, cwd: own.home, approvedTaskPolicy: scope.policy }),
    /scope/i);
    await assert.rejects(verifyControlledNativeCliSourceScope(scope, {
      taskId: own.taskId, home: own.home, cwd: own.home,
      approvedTaskPolicy: { ...scope.policy, model: 'different' } }), /scope/i);
    await writeFile(path.join(own.home, 'sessions', `${randomUUID()}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: randomUUID(),
        session_id: randomUUID(), cwd: own.home } })}\n`);
    assert.throws(() => assertControlledNativeCliSourceScopeCurrent(scope), /source-drift/i);
    const reads = own.backend.frames.length;
    await assert.rejects(controlClient.nativeCliCanaryEvidence(), ManagedWorkerControlUnknownError);
    assert.equal(own.backend.frames.length, reads);
    assert.equal(own.backend.writes, 0);
    await assert.rejects(verifyControlledNativeCliSourceScope(scope), /unqualified/i);
    own.creationJournal!.close();
    await assert.rejects(verifyControlledNativeCliSourceScope(scope), /scope/i);
  } finally {
    await controlStop(own.privateDirectory, own.reserved.epoch, 'cli-drift-stop');
  }
});

test('controlled CLI final source fence rejects an in-place rollout header change', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  try {
    const scope = own.cliOptions!.sourceScope!;
    const rolloutPath = path.join(own.home, 'sessions', `${own.taskId}.jsonl`);
    assert.doesNotThrow(() => assertControlledNativeCliSourceScopeCurrent(scope));
    const original = await readFile(rolloutPath, 'utf8');
    await writeFile(rolloutPath, original.replace(own.taskId, randomUUID()));
    assert.throws(() => assertControlledNativeCliSourceScopeCurrent(scope), /source-drift/i);
  } finally {
    await controlStop(own.privateDirectory, own.reserved.epoch, 'cli-header-drift-stop');
  }
});

test('controlled CLI source scope accepts a journal rollout through a Windows junction',
  { skip: process.platform !== 'win32' }, async () => {
    const capability = {};
    const own = await readyFixture({ allow: true }, { enabled: true, early: false },
      'normal', false, null, undefined, undefined, false, undefined, undefined,
      { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true }, true, true);
    try {
      await verifyControlledNativeCliSourceScope(own.cliOptions!.sourceScope!, {
        taskId: own.taskId, home: own.home, cwd: own.home,
        approvedTaskPolicy: own.cliOptions!.sourceScope!.policy });
    } finally {
      await controlStop(own.privateDirectory, own.reserved.epoch, 'cli-junction-stop');
    }
  });

test('native CLI WebSocket without a controlled source remains read-only', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true });
  const client = await nativeCliClient(own.daemon.nativeCliWebSocketCapability(capability));
  try {
    await client.request('initialize', 'initialize', { clientInfo: { name: 'fixture' }, capabilities: {} });
    client.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    assert.ok((await client.request('resume', 'thread/resume', { threadId: own.taskId })).result);
    const params = { threadId: own.taskId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: 'must not start' }], turnTrigger: null, toolOutput: null,
      responsesapiClientMetadata: null, additionalContext: null, environments: null,
      cwd: own.home, runtimeWorkspaceRoots: [own.home], approvalPolicy: 'never',
      approvalsReviewer: 'user', sandboxPolicy: null, permissions: ':read-only',
      model: 'gpt-5.6-sol', serviceTier: null, serviceTierForTurn: null, effort: 'low',
      summary: null, personality: null, outputSchema: null,
      collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-sol',
        reasoning_effort: 'low', developer_instructions: null } },
      multiAgentMode: null, cyberAccessProgram: null };
    const reply = await client.request('start-without-source', 'turn/start', params);
    assert.equal((reply.error as { code: number }).code, -32602);
    assert.equal(own.backend.writes, 0);
    assert.ok((await client.request('read-after-refusal', 'thread/read',
      { threadId: own.taskId, includeTurns: true })).result);
  } finally {
    client.socket.terminate();
    await controlStop(own.privateDirectory, own.reserved.epoch, 'read-only-stop');
  }
});

test('refused stop during an active CLI turn preserves the attached WebSocket', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', false, null, undefined, undefined, false, undefined, undefined,
    { capability, noPendingExternalAutoStart: () => true, singleAcceptedStart: true });
  const client = await nativeCliClient(own.daemon.nativeCliWebSocketCapability(capability));
  try {
    await client.request('initialize', 'initialize', { clientInfo: { name: 'fixture' }, capabilities: {} });
    client.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    await client.request('resume', 'thread/resume', { threadId: own.taskId });
    const params = { threadId: own.taskId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: 'active CLI turn' }], turnTrigger: null, toolOutput: null,
      responsesapiClientMetadata: null, additionalContext: null, environments: null,
      cwd: own.home, runtimeWorkspaceRoots: [own.home], approvalPolicy: 'never',
      approvalsReviewer: 'user', sandboxPolicy: null, permissions: ':read-only',
      model: 'gpt-5.6-sol', serviceTier: null, serviceTierForTurn: null, effort: 'low',
      summary: null, personality: null, outputSchema: null,
      collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-sol',
        reasoning_effort: 'low', developer_instructions: null } },
      multiAgentMode: null, cyberAccessProgram: null };
    assert.ok((await client.request('start', 'turn/start', params)).result);
    own.backend.readStatusOverride = 'active';
    assert.equal((await controlStop(own.privateDirectory, own.reserved.epoch, 'active-cli-stop')).error,
      'stop-refused');
    assert.equal(own.daemon.metadata.state, 'ready');
    assert.equal(own.backend.exitCode, null);
    assert.equal(client.socket.readyState, WebSocket.OPEN,
      'a read-only stop proof must not retire the attached CLI session');
    assert.ok((await client.request('after-refusal', 'thread/read',
      { threadId: own.taskId, includeTurns: true })).result);
    own.backend.readStatusOverride = null;
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'drained-cli-stop')).result,
      { stopped: true });
  } finally {
    client.socket.terminate();
    if (own.backend.exitCode === null) own.backend.stdin.end();
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

for (const failure of ['owner-unconfirmed', 'native-owner-unavailable'] as const)
  test(`native CLI bearer is revoked after ${failure} while its backend remains alive`, async () => {
    const capability = {};
    const own = await readyFixture({ allow: true }, { enabled: true, early: false },
      'normal', false, null, undefined, undefined, false, undefined, undefined,
      { capability, noPendingExternalAutoStart: () => true });
    const bearer = own.daemon.nativeCliWebSocketCapability(capability);
    const client = await nativeCliClient(bearer);
    try {
      await client.request('initialize', 'initialize', { clientInfo: { name: 'fixture' }, capabilities: {} });
      client.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      if (failure === 'owner-unconfirmed') {
        const registry = new ManagedWorkerRegistry(own.registryPath);
        try {
          const ready = registry.get(own.home, 'own-family');
          assert.ok(ready?.host && ready.backend);
          registry.markLost(ready, ready.host, ready.backend, 'backend_unavailable');
        } finally { registry.close(); }
      } else own.backend.stdout.write(JSON.stringify({ method: 'thread/unsupported',
        params: { threadId: own.taskId } }) + '\n');
      await waitFor(() => own.daemon.metadata.failure === failure, 3500);
      assert.equal(own.backend.exitCode, null);
      assert.throws(() => own.daemon.nativeCliWebSocketCapability(capability), /unavailable/i);
      await assert.rejects(own.daemon.nativeCliCanaryEvidence(capability), /unavailable/i);
      await waitFor(() => client.socket.readyState === WebSocket.CLOSED, 1500);
      const probe = new WebSocket(`ws://${bearer.host}:${bearer.port}/`, {
        headers: { Authorization: `Bearer ${bearer.token}` }, perMessageDeflate: false });
      probe.on('error', () => {});
      try {
        const outcome = await Promise.race([
          new Promise<'open' | 'rejected'>(resolve => {
            probe.once('open', () => resolve('open'));
            probe.once('error', () => resolve('rejected'));
          }),
          new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 1500)),
        ]);
        assert.equal(outcome, 'rejected', 'a previously issued bearer must not restore read access');
      } finally { probe.terminate(); }
    } finally {
      client.socket.terminate();
      if (own.backend.exitCode === null) own.backend.stdin.end();
      await (own.control as ManagedWorkerControlServer | null)?.close();
    }
  });

test('stock daemon confirms one settings write on its own backend before readiness', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false }, 'normal', true);
  try {
    assert.equal(own.daemon.metadata.state, 'ready');
    assert.equal(own.backend.settingsWrites, 1);
    assert.equal(own.backend.queueWrites, 0);
    assert.equal(own.backend.writes, 0);
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(own.brokers.length, 1);
    assert.ok(own.brokers[0]?.frames.some(frame => frame.method === 'thread-queued-followups-changed'));
    assert.ok(own.probeBrokers.some(broker => broker.frames.some(frame =>
      frame.method === 'thread-owner-discovery')));
    const journal = new Database(path.join(own.privateDirectory, 'operations.sqlite'), { readonly: true });
    try {
      const settings = journal.prepare('SELECT state,rpc_ack,effective_fingerprint FROM managed_worker_settings_operations')
        .all() as Array<{state:string;rpc_ack:number;effective_fingerprint:string|null}>;
      assert.equal(settings.length, 1);
      assert.equal(settings[0]?.rpc_ack, 1);
      assert.match(settings[0]?.effective_fingerprint ?? '', /^[0-9a-f]{64}$/u);
      assert.equal((journal.prepare('SELECT count(*) AS n FROM managed_worker_operations').get() as {n:number}).n, 0);
    } finally { journal.close(); }
  } finally {
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'stock-stop')).result,
      { stopped: true });
  }
});

test('headless VK uses the same managed stock worker queue and durable accepted receipt', async () => {
  const capability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true, expectedTurnCount: 1 },
    { enabled: true, early: false }, 'normal', true, null,
    { capability, sourceId: '' });
  const request = { operationId, task: { hostId: 'local', threadId: own.taskId, sourceId: '' },
    text: 'PUBLIC_VK', author: { id: 7, name: 'VK fixture' }, outboxDir: own.home };
  try {
    await assert.rejects(own.daemon.submitVk({}, request), /Managed VK stock input unavailable/);
    await assert.rejects(own.daemon.submitVk(capability, { ...request,
      task: { ...request.task, sourceId: 'foreign-source' } }), /Managed VK stock input unavailable/);
    await assert.rejects(own.daemon.submitVk(capability, { ...request,
      inputFiles: [{ kind: 'image', path: path.join(own.home, 'image.png'), originalName: 'image.png',
        sizeBytes: 1 }] }),
      /Managed VK stock input unavailable/);
    const generation = own.daemon.metadata.generation;
    assert.ok(generation);
    const collisionId = randomUUID();
    const journal = new ManagedWorkerOperationJournal({
      filePath: path.join(own.privateDirectory, 'operations.sqlite'),
      ownerEpoch: own.reserved.epoch, backendGeneration: generation, threadId: own.taskId });
    try {
      const row = journal.reserve({ operationId: randomUUID(), clientUserMessageId: collisionId,
        method: 'thread/queue/add', fingerprint: 'a'.repeat(64) }).operation;
      journal.reject(row, -32602);
    } finally { journal.close(); }
    await assert.rejects(own.daemon.submitVk(capability, { ...request,
      operationId: collisionId }), /Managed VK stock input unavailable/);
    assert.equal(own.backend.queueWrites, 0);
    const endpoint = JSON.parse(await readFile(path.join(own.privateDirectory,
      'endpoint.v1.json'), 'utf8')) as { control: { port: number } };
    const client = new ManagedWorkerControlClient({ host: '127.0.0.1',
      port: endpoint.control.port, token: Buffer.alloc(32, 3).toString('base64url'),
      ownerEpoch: own.reserved.epoch, taskId: own.taskId });
    assert.equal(await client.vkSubmissionStatusByOperationId(operationId), null);
    const forgedOperationId = randomUUID();
    const otherJournal = new ManagedWorkerOperationJournal({
      filePath: path.join(own.privateDirectory, 'operations.sqlite'),
      ownerEpoch: own.reserved.epoch, backendGeneration: generation, threadId: own.taskId });
    try {
      const row = otherJournal.reserve({ operationId: managedVkStockCommandId(
        own.reserved.epoch, own.taskId, forgedOperationId),
      clientUserMessageId: randomUUID(), method: 'thread/queue/add',
      fingerprint: 'b'.repeat(64) }).operation;
      otherJournal.reject(row, -32602);
    } finally { otherJournal.close(); }
    await assert.rejects(client.vkSubmissionStatusByOperationId(forgedOperationId),
      /unknown|status/i, 'derived operation ID alone cannot attest a foreign client identity');
    const accepted = await client.submitVk(request);
    assert.equal(accepted.submissionId, 'submission-1');
    assert.deepEqual(await client.vkSubmissionStatusByOperationId(operationId),
      { state: 'accepted', submissionId: 'submission-1' });
    assert.deepEqual(await client.vkSubmissionStatus(request),
      { state: 'accepted', submissionId: 'submission-1' });
    await assert.rejects(client.vkSubmissionStatus({ ...request, text: 'changed' }),
      /unknown|status/i);
    assert.equal(own.backend.queueWrites, 1);
    assert.equal(own.backend.writes, 0);
    const queueFrame = own.backend.frames.find(frame => frame.method === 'thread/queue/add');
    assert.ok(queueFrame);
    const params = queueFrame.params as Record<string, unknown>;
    assert.equal(params.clientUserMessageId, operationId);
    assert.match(JSON.stringify(params.input), /VK author.*VK fixture/);
    assert.match(JSON.stringify(params.input), /VKodex file delivery/);
    assert.deepEqual(await own.daemon.submitVk(capability, request), accepted);
    assert.equal(own.backend.queueWrites, 1, 'exact duplicate did not write again');
    await assert.rejects(own.daemon.submitVk(capability, { ...request, text: 'changed' }),
      /intent conflict/i);
    own.backend.terminalQueueClients = [operationId];
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'vk-stock-stop')).result,
      { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK refuses fresh admission after an accepted receipt lacks canonical history but preserves exact duplicate lookup', async () => {
  const capability = {}, firstId = randomUUID(), secondId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' });
  own.backend.stockHistory = [];
  const request = (operationId: string) => ({ operationId,
    task: { hostId: 'local', threadId: own.taskId }, text: `PUBLIC_${operationId}` });
  const first = request(firstId);
  try {
    assert.deepEqual(await own.daemon.submitVk(capability, first), { submissionId: 'submission-1' });
    assert.equal(own.daemon.vkSubmissionStatus(capability, first)?.state, 'accepted');
    assert.equal(own.backend.queueWrites, 1);
    await assert.rejects(own.daemon.submitVk(capability, request(secondId)),
      'an ACK without its canonical user item must not authorize a different VK write');
    assert.equal(own.backend.queueWrites, 1);
    assert.deepEqual(await own.daemon.submitVk(capability, first), { submissionId: 'submission-1' },
      'the original exact accepted lookup must keep its receipt');
    assert.equal(own.backend.queueWrites, 1);
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK refuses a client ID reserved only by a native direct intent', async () => {
  const capability = {}, clientId = randomUUID(), operationId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' });
  const generation = own.daemon.metadata.generation;
  assert.ok(generation);
  const input = [{ type: 'text', text: 'NATIVE_INTENT_ONLY', text_elements: [] }];
  const intentStore = new NativeStartIntentStore({
    filePath: path.join(own.privateDirectory, 'start-intents.sqlite'),
    ownerEpoch: own.reserved.epoch, backendGeneration: generation, threadId: own.taskId,
    encryptionKey: Buffer.alloc(32, 2),
  });
  const intent = {
    envelope: { conversationId: own.taskId, turnStart: { request: {
      threadId: own.taskId, clientUserMessageId: clientId, input } } },
    command: { operationId, method: 'turn/start' as const, params: {
      threadId: own.taskId, clientUserMessageId: clientId, input } },
    uiParams: null, localMetadata: null,
    admission: { ownerEpoch: own.reserved.epoch, backendGeneration: generation,
      snapshot: { id: own.taskId } },
  };
  try {
    assert.equal(intentStore.reserve(operationId, clientId, intent).created, true);
    const ledger = new Database(path.join(own.privateDirectory, 'operations.sqlite'), { readonly: true });
    try {
      assert.equal((ledger.prepare('SELECT count(*) AS n FROM managed_worker_operations WHERE client_user_message_id=?')
        .get(clientId) as { n: number }).n, 0, 'the native intent has no worker operation yet');
    } finally { ledger.close(); }
    await assert.rejects(own.daemon.submitVk(capability, {
      operationId: clientId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_COLLISION',
    }), 'a direct-start intent reserves this client identity before worker admission');
    assert.equal(own.backend.queueWrites, 0);
  } finally {
    intentStore.close();
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK refuses a client ID reserved only by a native queue operation', async () => {
  const capability = {}, clientId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' });
  const generation = own.daemon.metadata.generation;
  assert.ok(generation);
  const journal = new NativeStockQueueJournal({
    filePath: path.join(own.privateDirectory, 'native-stock.sqlite'), taskId: own.taskId,
    ownerEpoch: own.reserved.epoch, sourceGeneration: 'qualified-stock-v1',
  });
  try {
    journal.reserve({ expectedVersion: journal.readTask().version, opId: clientId,
      fingerprint: 'a'.repeat(64), nativeEntry: { id: clientId, text: 'NATIVE_RESERVED_ONLY' },
      effectiveSettings: { model: 'gpt-5.6-sol', effort: 'medium' },
      admissionEvidence: { taskId: own.taskId, ownerEpoch: own.reserved.epoch },
      stockInput: [{ type: 'text', text: 'NATIVE_RESERVED_ONLY', text_elements: [] }],
      forwardedUpstream: {},
    });
    const ledger = new Database(path.join(own.privateDirectory, 'operations.sqlite'), { readonly: true });
    try {
      assert.equal((ledger.prepare('SELECT count(*) AS n FROM managed_worker_operations WHERE client_user_message_id=?')
        .get(clientId) as { n: number }).n, 0, 'the native reservation has no worker operation yet');
    } finally { ledger.close(); }
    await assert.rejects(own.daemon.submitVk(capability, {
      operationId: clientId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_COLLISION',
    }), 'an unresolved native reservation must not authorize VK admission');
    assert.equal(own.backend.queueWrites, 0);
  } finally {
    journal.close();
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK admission resumes after completed VK and native direct turns with distinct receipts', async () => {
  const capability = {}, firstId = randomUUID(), secondId = randomUUID();
  const own = await readyFixture({ allow: true, expectedTurnCount: 3 },
    { enabled: true, early: false }, 'normal', true, null, { capability, sourceId: '' });
  own.backend.stockHistory = [];
  const broker = own.brokers[0]!;
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 12_000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), JSON.stringify({ methods: own.backend.methods, errors: own.handlerErrors,
      native: own.daemon.metadata.nativeState, frames: broker.frames.slice(-3) }));
  };
  const complete = async (turnId: string, clientId: string, content: unknown) => {
    const startedAt = own.backend.stockHistory!.length + 1;
    const userItem = { id: `item-${clientId}`, type: 'userMessage', clientId,
      content: structuredClone(content) };
    const turn = { id: turnId, status: 'inProgress', startedAt, items: [userItem] };
    const terminal = { ...turn, status: 'completed', completedAt: startedAt + 1,
      itemsView: 'full' };
    own.backend.stockHistory!.push(terminal);
    own.backend.stdout.write(JSON.stringify({ method: 'turn/started',
      params: { threadId: own.taskId, turn } }) + '\n');
    own.backend.stdout.write(JSON.stringify({ method: 'turn/completed',
      params: { threadId: own.taskId, turn: terminal } }) + '\n');
    await wait(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed' &&
      JSON.stringify(frame).includes(turnId) && JSON.stringify(frame).includes('completed')));
  };
  const vkRequest = (operationId: string) => ({ operationId,
    task: { hostId: 'local', threadId: own.taskId }, text: `PUBLIC_${operationId}` });
  const response = async (requestId: string) => {
    await wait(() => broker.frames.some(frame => frame.type === 'response' && frame.requestId === requestId));
    const frame = broker.frames.find(value => value.type === 'response' && value.requestId === requestId)!;
    assert.equal(frame.resultType, 'success', JSON.stringify({ frame, errors: own.handlerErrors }));
    return frame.result as Record<string, unknown>;
  };
  try {
    await wait(() => broker.frames.some(frame => frame.method === 'thread-queued-followups-changed'));
    const first = await own.daemon.submitVk(capability, vkRequest(firstId));
    const firstQueue = own.backend.frames.find(frame => frame.method === 'thread/queue/add')!;
    const firstParams = firstQueue.params as Record<string, unknown>;
    assert.equal(firstParams.clientUserMessageId, firstId);
    await complete('vk-first-turn', firstId, firstParams.input);

    const direct = composerRequest(own.taskId, own.home, 'vk-between-direct');
    direct.targetClientId = broker.ownerId;
    const directParams = direct.params as Record<string, unknown>;
    const directStart = directParams.turnStart as Record<string, unknown>;
    const directRequest = directStart.request as Record<string, unknown>;
    directRequest.permissions = ':danger-full-access'; directRequest.approvalPolicy = 'never';
    directRequest.collaborationMode = { mode: 'default', settings: { model: 'gpt-5.6-sol',
      reasoning_effort: 'medium', developer_instructions: null } };
    broker.send(direct);
    const directResult = await response('vk-between-direct');
    const directTurn = (directResult.result as Record<string, unknown>).turn as Record<string, unknown>;
    assert.equal(own.backend.writes, 1, 'native direct start must have its actual worker ACK');
    const directWorkerCommand = own.backend.frames.find(frame => frame.method === 'turn/start')!;
    const directWorkerParams = directWorkerCommand.params as Record<string, unknown>;
    const directClientId = directWorkerParams.clientUserMessageId as string;
    assert.ok(directClientId);
    await complete(directTurn.id as string, directClientId, directWorkerParams.input);

    const second = await own.daemon.submitVk(capability, vkRequest(secondId));
    const secondQueue = own.backend.frames.filter(frame => frame.method === 'thread/queue/add')[1]!;
    const secondParams = secondQueue.params as Record<string, unknown>;
    assert.equal(secondParams.clientUserMessageId, secondId);
    assert.notEqual(first.submissionId, second.submissionId);
    assert.notEqual(first.submissionId, directTurn.id);
    assert.notEqual(second.submissionId, directTurn.id);
    assert.equal(own.backend.queueWrites, 2);
    assert.equal(own.backend.writes, 1);
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length, 1,
      'all three accepted operations stay on the original backend generation');
    await complete('vk-second-turn', secondId, secondParams.input);
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch,
      'vk-native-vk-drained')).result, { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('scoped headless VK binds admission and accepted receipts to the exact registry scope', async () => {
  const capability = {}, handoffCapability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' }, undefined, false, handoffCapability);
  type FullScope = Readonly<{ ownerEpoch: string; taskId: string; backendGeneration: number;
    registryRevision: number; endpointRef: string }>;
  type ScopedDaemon = {
    vkIngressStatusScoped(capability: object, expected: FullScope):
      { capability: string; admissionOpen: boolean };
    submitVkScoped(capability: object, expected: FullScope, request: {
      operationId: string; task: { hostId: 'local'; threadId: string }; text: string
    }): Promise<{ submissionId: string }>;
    vkSubmissionStatusByOperationIdScoped(capability: object, expected: FullScope,
      operationId: string): { state: string; submissionId: string | null } | null;
  };
  const daemon = own.daemon as unknown as ScopedDaemon;
  const registry = new ManagedWorkerRegistry(own.registryPath);
  const row = registry.get(own.home, 'own-family'); registry.close();
  assert.ok(row?.backend && row.endpointRef);
  const scope: FullScope = Object.freeze({ ownerEpoch: row.epoch, taskId: own.taskId,
    backendGeneration: row.backend.generation, registryRevision: row.revision,
    endpointRef: row.endpointRef });
  try {
    assert.deepEqual(daemon.vkIngressStatusScoped(capability, scope),
      { capability: 'stock-idle-queue-v2', admissionOpen: true });
    const accepted = await daemon.submitVkScoped(capability, scope, {
      operationId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK_SCOPED',
    });
    assert.equal(own.backend.queueWrites, 1);
    assert.equal(own.backend.writes, 0, 'scoped admission must use queue/add, never turn/start');
    own.daemon.revokeIngress(handoffCapability);
    assert.deepEqual(daemon.vkIngressStatusScoped(capability, scope),
      { capability: 'stock-idle-queue-v2', admissionOpen: false },
      'the captured owner scope remains identifiable after admission is revoked');
    const receipt = daemon.vkSubmissionStatusByOperationIdScoped(capability, scope, operationId);
    assert.ok(receipt, 'exact accepted receipt remains queryable after revocation');
    assert.deepEqual(await daemon.submitVkScoped(capability, scope, {
      operationId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK_SCOPED',
    }), accepted, 'an exact accepted duplicate is idempotent after revocation');
    assert.equal(own.backend.queueWrites, 1, 'duplicate must not write again');
    await assert.rejects(daemon.submitVkScoped(capability, scope, {
      operationId: randomUUID(), task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK_FRESH',
    }), 'revocation rejects new work');
    assert.equal(own.backend.queueWrites, 1, 'fresh post-revocation work has no wire write');
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('scoped headless VK refuses mismatched or changed scope without wire writes', async () => {
  const capability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' });
  type FullScope = Readonly<{ ownerEpoch: string; taskId: string; backendGeneration: number;
    registryRevision: number; endpointRef: string }>;
  type ScopedDaemon = {
    vkIngressStatusScoped(capability: object, expected: FullScope): unknown;
    submitVkScoped(capability: object, expected: FullScope, request: {
      operationId: string; task: { hostId: 'local'; threadId: string }; text: string;
      beforeSend?: () => Promise<void>;
    }): Promise<{ submissionId: string }>;
    vkSubmissionStatusByOperationIdScoped(capability: object, expected: FullScope,
      operationId: string): unknown;
  };
  const daemon = own.daemon as unknown as ScopedDaemon;
  const registry = new ManagedWorkerRegistry(own.registryPath);
  const row = registry.get(own.home, 'own-family'); registry.close();
  assert.ok(row?.backend && row.endpointRef);
  const scope: FullScope = Object.freeze({ ownerEpoch: row.epoch, taskId: own.taskId,
    backendGeneration: row.backend.generation, registryRevision: row.revision,
    endpointRef: row.endpointRef });
  try {
    const wrongEndpoint = Object.freeze({ ...scope, endpointRef: randomUUID() });
    await assert.rejects(Promise.resolve().then(() => daemon.vkIngressStatusScoped(capability, wrongEndpoint)));
    await assert.rejects(daemon.submitVkScoped(capability, wrongEndpoint, {
      operationId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK_WRONG_SCOPE',
    }));
    assert.equal(own.backend.queueWrites, 0);

    let beforeSendFinished = false;
    await assert.rejects(daemon.submitVkScoped(capability, scope, {
      operationId: randomUUID(), task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK_DRIFT',
      beforeSend: async () => {
        own.backend.birthDrift = true;
        await new Promise(resolve => setTimeout(resolve, 10));
        beforeSendFinished = true;
      },
    }));
    assert.equal(beforeSendFinished, true);
    assert.equal(own.backend.queueWrites, 0,
      'scope drift observed after beforeSend must fence the final worker write');
    await assert.rejects(Promise.resolve().then(() =>
      daemon.vkSubmissionStatusByOperationIdScoped(capability, scope, operationId)),
    'stale scope must be unavailable, not represented as an absent operation');
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('scoped headless VK never replays an operation with an unknown worker receipt', async () => {
  const capability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' }, 300);
  type FullScope = Readonly<{ ownerEpoch: string; taskId: string; backendGeneration: number;
    registryRevision: number; endpointRef: string }>;
  type ScopedDaemon = {
    submitVkScoped(capability: object, expected: FullScope, request: {
      operationId: string; task: { hostId: 'local'; threadId: string }; text: string
    }): Promise<{ submissionId: string }>;
    vkSubmissionStatusByOperationIdScoped(capability: object, expected: FullScope,
      operationId: string): { state: string; submissionId: string | null } | null;
  };
  const daemon = own.daemon as unknown as ScopedDaemon;
  const registry = new ManagedWorkerRegistry(own.registryPath);
  const row = registry.get(own.home, 'own-family'); registry.close();
  assert.ok(row?.backend && row.endpointRef);
  const scope: FullScope = Object.freeze({ ownerEpoch: row.epoch, taskId: own.taskId,
    backendGeneration: row.backend.generation, registryRevision: row.revision,
    endpointRef: row.endpointRef });
  own.backend.holdQueueReply = true;
  try {
    const request = { operationId, task: { hostId: 'local' as const, threadId: own.taskId },
      text: 'PUBLIC_VK_UNKNOWN' };
    await assert.rejects(daemon.submitVkScoped(capability, scope, request));
    assert.equal(own.backend.queueWrites, 1);
    assert.deepEqual(daemon.vkSubmissionStatusByOperationIdScoped(capability, scope, operationId),
      { state: 'unknown', submissionId: null });
    await assert.rejects(daemon.submitVkScoped(capability, scope, request));
    assert.equal(own.backend.queueWrites, 1, 'unknown receipt is never retried');
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK refuses a quiet native queue client identity without a worker operation', async () => {
  const capability = {}, clientId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' });
  const journal = new NativeStockQueueJournal({
    filePath: path.join(own.privateDirectory, 'native-stock.sqlite'), taskId: own.taskId,
    ownerEpoch: own.reserved.epoch, sourceGeneration: 'qualified-stock-v1',
  });
  try {
    const input = [{ type: 'text', text: 'NATIVE_QUIET_IDENTITY', text_elements: [] }];
    journal.reserve({ expectedVersion: journal.readTask().version, opId: clientId,
      fingerprint: 'c'.repeat(64), nativeEntry: { id: clientId, text: 'NATIVE_QUIET_IDENTITY' },
      effectiveSettings: { model: 'gpt-5.6-sol', effort: 'medium' },
      admissionEvidence: { taskId: own.taskId, ownerEpoch: own.reserved.epoch },
      stockInput: input, forwardedUpstream: {},
    });
    journal.markAccepted({ opId: clientId, fingerprint: 'c'.repeat(64), stockId: 'native-stock-quiet' });
    journal.consume({ opId: clientId, fingerprint: 'c'.repeat(64), turnId: 'native-quiet-turn',
      authoritative: true });
    assert.deepEqual(journal.quiescence(), { taskVersion: 3, unresolved: 0, unconsumed: 0 });
    assert.deepEqual(journal.lookupIncomingIdentities({ ids: [clientId] }).items.map(item =>
      item && { id: item.id, phase: item.phase, consumed: item.consumed }),
    [{ id: clientId, phase: 'accepted', consumed: true }]);
    const ledger = new Database(path.join(own.privateDirectory, 'operations.sqlite'), { readonly: true });
    try {
      assert.equal((ledger.prepare('SELECT count(*) AS n FROM managed_worker_operations WHERE client_user_message_id=?')
        .get(clientId) as { n: number }).n, 0, 'native quiet identity is absent from the worker ledger');
    } finally { ledger.close(); }
    await assert.rejects(own.daemon.submitVk(capability, {
      operationId: clientId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_COLLISION',
    }));
    assert.equal(own.backend.queueWrites, 0);
  } finally {
    journal.close();
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK lease fences native ingress and stop while its one queue RPC awaits ACK', async () => {
  const capability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true, expectedTurnCount: 1 },
    { enabled: true, early: false }, 'normal', true, null,
    { capability, sourceId: '' });
  const broker = own.brokers[0]!;
  const request = { operationId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK' };
  own.backend.holdQueueReply = true;
  try {
    const pending = own.daemon.submitVk(capability, request);
    const deadline = Date.now() + 3000;
    while (own.backend.queueWrites === 0 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(own.backend.queueWrites, 1);
    assert.equal((await controlStop(own.privateDirectory, own.reserved.epoch, 'vk-busy-stop')).error,
      'stop-refused');
    assert.equal(own.backend.exitCode, null);
    broker.send({ type: 'request', requestId: 'native-during-vk', sourceClientId: 'follower',
      targetClientId: broker.ownerId, hostId: 'local',
      method: 'thread-follower-set-queued-follow-ups-state', version: 1,
      params: { hostId: 'local', conversationId: own.taskId,
        state: { [own.taskId]: [stockEntry(own.home)] } } });
    const until = Date.now() + 3000;
    while (!broker.frames.some(frame => frame.requestId === 'native-during-vk' &&
      frame.type === 'response') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'native-during-vk')?.resultType,
      'error');
    assert.equal(own.backend.queueWrites, 1);
    const earlyUser = { id: 'queue-user-0', type: 'userMessage', clientId: operationId,
      content: [{ type: 'text', text: 'PUBLIC_VK' }] };
    const earlyTurn = { id: 'queue-terminal-turn', status: 'inProgress', startedAt: 1,
      items: [] };
    own.backend.stdout.write(JSON.stringify({ method: 'turn/started',
      params: { threadId: own.taskId, turn: earlyTurn } }) + '\n');
    own.backend.stdout.write(JSON.stringify({ method: 'item/started',
      params: { threadId: own.taskId, turnId: earlyTurn.id, item: earlyUser } }) + '\n');
    own.backend.stdout.write(JSON.stringify({ method: 'turn/completed',
      params: { threadId: own.taskId, turn: { ...earlyTurn, status: 'completed',
        completedAt: 2, itemsView: 'full', items: [earlyUser] } } }) + '\n');
    own.backend.terminalQueueClients = [operationId];
    own.backend.answerHeldQueue();
    assert.deepEqual(await pending, { submissionId: 'submission-1' });
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'vk-drained-stop')).result,
      { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK refuses authority drift during beforeSend without reserving a queue write', async () => {
  const capability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' });
  try {
    await assert.rejects(own.daemon.submitVk(capability, {
      operationId: randomUUID(), task: { hostId: 'local', threadId: own.taskId },
      text: 'PUBLIC_VK', beforeSend: async () => {
        own.backend.stdout.write(JSON.stringify({ method: 'thread/queue/changed',
          params: { threadId: own.taskId } }) + '\n');
        await new Promise(resolve => setTimeout(resolve, 10));
      },
    }));
    assert.equal(own.backend.queueWrites, 0);
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'vk-drift-stop')).result,
      { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('handoff revoke fences an awaiting VK submission before the worker write', async () => {
  const capability = {}, handoffCapability = {};
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' }, undefined, false, handoffCapability);
  let entered!: () => void, release!: () => void;
  const beforeSendEntered = new Promise<void>(resolve => { entered = resolve; });
  const beforeSendReleased = new Promise<void>(resolve => { release = resolve; });
  try {
    const operationId = randomUUID();
    const request = { operationId, task: { hostId: 'local', threadId: own.taskId },
      text: 'PUBLIC_VK', beforeSend: async () => { entered(); await beforeSendReleased; } };
    const pending = own.daemon.submitVk(capability, request);
    await beforeSendEntered;
    own.daemon.revokeIngress(handoffCapability);
    release();
    await assert.rejects(pending);
    assert.equal(own.backend.queueWrites, 0);
    assert.equal(own.daemon.vkSubmissionStatusByOperationId(capability, operationId), null,
      'revocation before reservation leaves no synthetic worker receipt');
    await assert.rejects(own.daemon.submitVk(capability, { ...request, operationId: randomUUID() }));
    const broker = own.brokers[0]!;
    broker.send({ type: 'request', requestId: 'native-after-revoke', sourceClientId: 'follower',
      targetClientId: broker.ownerId, hostId: 'local',
      method: 'thread-follower-set-queued-follow-ups-state', version: 1,
      params: { hostId: 'local', conversationId: own.taskId,
        state: { [own.taskId]: [stockEntry(own.home)] } } });
    const deadline = Date.now() + 3000;
    while (!broker.frames.some(frame => frame.requestId === 'native-after-revoke') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'native-after-revoke')?.resultType,
      'error');
    assert.equal(own.backend.queueWrites, 0);
    assert.equal(own.backend.exitCode, null);
  } finally {
    release();
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('handoff proof requires the family and is one-time after a monotonic revoke', async () => {
  const handoffCapability = {}, family = { allow: false };
  const own = await readyFixture(family, { enabled: true, early: false },
    'normal', true, null, undefined, undefined, false, handoffCapability);
  try {
    const endpoint = JSON.parse(await readFile(path.join(own.privateDirectory,
      'endpoint.v1.json'), 'utf8')) as { control: { port: number } };
    const client = new ManagedWorkerControlClient({ host: '127.0.0.1',
      port: endpoint.control.port, token: Buffer.alloc(32, 3).toString('base64url'),
      ownerEpoch: own.reserved.epoch, taskId: own.taskId });
    const registry = new ManagedWorkerRegistry(own.registryPath);
    const row = registry.get(own.home, 'own-family'); registry.close();
    assert.ok(row);
    const expected = { backendGeneration: own.daemon.metadata.generation!,
      registryRevision: row.revision };
    assert.deepEqual(await client.revokeIngress(expected), expected);
    await assert.rejects(client.qualifyHandoff(expected));
    assert.equal(own.backend.exitCode, null);
    assert.equal((await controlStop(own.privateDirectory, own.reserved.epoch,
      'handoff-family-refused')).error, 'stop-refused');
    assert.equal(own.backend.exitCode, null);
    family.allow = true;
    const proof = await client.qualifyHandoff(expected);
    assert.equal(proof.ownerEpoch, own.reserved.epoch);
    assert.equal(proof.taskId, own.taskId);
    assert.equal(proof.backendGeneration, own.daemon.metadata.generation);
    assert.ok(proof.registryRevision > own.reserved.revision);
    assert.ok(proof.host.pid > 0 && proof.host.birthTicks);
    assert.ok(proof.backend.pid > 0 && proof.backend.birthTicks);
    assert.match(proof.nonce, /^[0-9a-f-]{36}$/i);
    await assert.rejects(client.qualifyHandoff(expected));
    assert.equal(own.daemon.metadata.state, 'ready', 'proof does not retire the writer');
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('handoff cannot qualify a VK unknown outcome after one idle snapshot', async () => {
  const capability = {}, handoffCapability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' }, 300, false, handoffCapability);
  const request = { operationId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK' };
  own.backend.holdQueueReply = true;
  try {
    const pending = own.daemon.submitVk(capability, request);
    const deadline = Date.now() + 3000;
    while (!own.backend.heldQueueReply && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(own.backend.heldQueueReply);
    own.daemon.revokeIngress(handoffCapability);
    await assert.rejects(pending);
    assert.equal(own.daemon.vkSubmissionStatusByOperationId(capability, operationId)?.state, 'unknown');
    await assert.rejects(own.daemon.qualifyHandoff(handoffCapability));
    assert.equal(own.backend.exitCode, null);
    assert.equal(own.backend.queueWrites, 1);
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK malformed queue ACK stays durable unknown and blocks replay and stop', async () => {
  const capability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, null, { capability, sourceId: '' });
  const request = { operationId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK' };
  own.backend.holdQueueReply = true;
  try {
    const pending = own.daemon.submitVk(capability, request);
    const deadline = Date.now() + 3000;
    while (!own.backend.heldQueueReply && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(own.backend.heldQueueReply);
    own.backend.answerHeldQueueMalformed();
    await assert.rejects(pending, /Результат операции неизвестен/);
    assert.equal(own.daemon.vkSubmissionStatus(capability, request)?.state, 'unknown');
    await assert.rejects(own.daemon.submitVk(capability, request), /Результат операции неизвестен/);
    assert.equal(own.backend.queueWrites, 1);
    assert.equal((await controlStop(own.privateDirectory, own.reserved.epoch, 'vk-unknown-stop')).error,
      'stop-refused');
    assert.equal(own.backend.exitCode, null);
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('headless VK late exact queue ACK reconciles unknown without replay', async () => {
  const capability = {}, operationId = randomUUID();
  const own = await readyFixture({ allow: true, expectedTurnCount: 1 },
    { enabled: true, early: false }, 'normal', true, null,
    { capability, sourceId: '' }, 300);
  const request = { operationId, task: { hostId: 'local', threadId: own.taskId }, text: 'PUBLIC_VK' };
  own.backend.holdQueueReply = true;
  try {
    await assert.rejects(own.daemon.submitVk(capability, request), /Результат операции неизвестен/);
    assert.equal(own.backend.queueWrites, 1);
    assert.equal(own.daemon.vkSubmissionStatus(capability, request)?.state, 'unknown');
    assert.equal((await controlStop(own.privateDirectory, own.reserved.epoch, 'vk-late-pending')).error,
      'stop-refused');
    own.backend.answerHeldQueue();
    const deadline = Date.now() + 3000;
    while (own.daemon.vkSubmissionStatus(capability, request)?.state !== 'accepted' && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(own.daemon.vkSubmissionStatus(capability, request)?.receiptId, 'submission-1');
    assert.deepEqual(await own.daemon.submitVk(capability, request), { submissionId: 'submission-1' });
    assert.equal(own.backend.queueWrites, 1);
    own.backend.terminalQueueClients = [operationId];
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'vk-late-drained')).result,
      { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('stock daemon routes two native queue sends through one journaled backend and stops after terminal proof', async () => {
  const own = await readyFixture({ allow: true, expectedTurnCount: 2 },
    { enabled: true, early: false }, 'normal', true);
  const broker = own.brokers[0]!;
  const wait = async (check: () => boolean) => {
    // The stock queue path traverses the broker, owner, journal, and fake
    // App Server. CI can schedule those processes slowly under Windows;
    // this test checks eventual ordering, not a three-second SLA.
    const deadline = Date.now() + 12_000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), JSON.stringify({ methods: own.backend.methods,
      native: own.daemon.metadata.nativeState, errors: own.handlerErrors }));
  };
  try {
    await wait(() => broker.frames.some(frame => frame.method === 'thread-queued-followups-changed'));
    broker.send({ ...composerRequest(own.taskId, own.home, 'stock-direct-denied'),
      targetClientId: broker.ownerId });
    await wait(() => broker.frames.some(frame => frame.type === 'response' &&
      frame.requestId === 'stock-direct-denied'));
    assert.equal(broker.frames.find(frame => frame.requestId === 'stock-direct-denied')?.resultType, 'error');
    assert.equal(broker.frames.find(frame => frame.requestId === 'stock-direct-denied')?.error,
      'error-handling-request');
    assert.equal(own.daemon.metadata.nativeStartup?.lastRequestFailure?.category,
      'direct-stock-start-refused');
    assert.equal(own.backend.writes, 0);
    for (let index = 1; index <= 2; index++) {
      const entry = stockEntry(own.home);
      broker.send({ type: 'request', requestId: `stock-${index}`, sourceClientId: 'follower',
        targetClientId: broker.ownerId, hostId: 'local',
        method: 'thread-follower-set-queued-follow-ups-state', version: 1,
        params: { hostId: 'local', conversationId: own.taskId,
          state: { [own.taskId]: [entry] } } });
      await wait(() => broker.frames.some(frame => frame.type === 'response' &&
        frame.requestId === `stock-${index}`));
      assert.equal(broker.frames.find(frame => frame.requestId === `stock-${index}`)?.resultType,
        'success', JSON.stringify({ errors: own.handlerErrors }));
      assert.equal(own.backend.queueWrites, index);
      assert.equal(own.backend.writes, 0);
      const userItem = { id: `stock-user-${index}`, type: 'userMessage', clientId: entry.id,
        content: [{ type: 'text', text: 'PUBLIC_OK' }] };
      const turn = { id: `stock-turn-${index}`, status: 'inProgress', startedAt: index, items: [] };
      own.backend.stdout.write(JSON.stringify({ method: 'turn/started',
        params: { threadId: own.taskId, turn } }) + '\n');
      own.backend.stdout.write(JSON.stringify({ method: 'item/started',
        params: { threadId: own.taskId, turnId: turn.id, item: userItem } }) + '\n');
      own.backend.stockCompletedClients.push(entry.id as string);
      own.backend.stdout.write(JSON.stringify({ method: 'turn/completed',
        params: { threadId: own.taskId, turn: { ...turn, status: 'completed',
          completedAt: index + 1, itemsView: 'full', items: [userItem] } } }) + '\n');
      await wait(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed' &&
        JSON.stringify(frame).includes(`stock-turn-${index}`) && JSON.stringify(frame).includes('completed')));
    }
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(own.backend.settingsWrites, 1);
    assert.equal(own.backend.queueWrites, 2);
    assert.equal(own.backend.writes, 0);
    const queueJournal = new Database(path.join(own.privateDirectory, 'native-stock.sqlite'), { readonly: true });
    try {
      const rows = queueJournal.prepare('SELECT phase,consumed FROM native_repeated_op ORDER BY seq')
        .all() as Array<{phase:string;consumed:number}>;
      assert.deepEqual(rows, [{ phase: 'accepted', consumed: 1 },
        { phase: 'accepted', consumed: 1 }]);
    } finally { queueJournal.close(); }
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'stock-two-stop')).result,
      { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('stock direct and native queue share one executor and preserve distinct real receipts across continuation', async () => {
  const own = await readyFixture({ allow: true, expectedTurnCount: 3 },
    { enabled: true, early: false }, 'normal', true);
  const broker = own.brokers[0]!;
  own.backend.stockHistory = [];
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 12_000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), JSON.stringify({ methods: own.backend.methods, errors: own.handlerErrors,
      native: own.daemon.metadata.nativeStartup, state: own.daemon.metadata.nativeState,
      frames: broker.frames.slice(-2) }));
  };
  const response = async (requestId: string) => {
    await wait(() => broker.frames.some(frame => frame.type === 'response' && frame.requestId === requestId));
    const frame = broker.frames.find(frame => frame.type === 'response' && frame.requestId === requestId)!;
    assert.equal(frame.resultType, 'success', JSON.stringify({ frame, errors: own.handlerErrors }));
    return frame.result as Record<string, unknown>;
  };
  const direct = (requestId: string, clientUserMessageId?: string) => {
    const frame = composerRequest(own.taskId, own.home, requestId);
    frame.targetClientId = broker.ownerId;
    const start = (frame.params as Record<string, unknown>).turnStart as Record<string, unknown>;
    const request = start.request as Record<string, unknown>;
    request.permissions = ':danger-full-access'; request.approvalPolicy = 'never';
    request.collaborationMode = { mode: 'default', settings: { model: 'gpt-5.6-sol',
      reasoning_effort: 'medium', developer_instructions: null } };
    if (clientUserMessageId !== undefined) request.clientUserMessageId = clientUserMessageId;
    return { frame, clientId: request.clientUserMessageId as string };
  };
  const rejectFrame = async (frame: Record<string, unknown>, requestId: string) => {
    broker.send(frame);
    await wait(() => broker.frames.some(value => value.type === 'response' && value.requestId === requestId));
    const result = broker.frames.find(value => value.type === 'response' && value.requestId === requestId)!;
    assert.equal(result.resultType, 'error');
  };
  const complete = async (turnId: string, clientId: string) => {
    const accepted = own.backend.frames.find(frame =>
      (frame.params as Record<string, unknown> | undefined)?.clientUserMessageId === clientId);
    assert.ok(accepted, 'canonical history must come from the actual submitted input');
    const item = { id: `item-${clientId}`, type: 'userMessage', clientId,
      content: structuredClone((accepted.params as Record<string, unknown>).input) };
    const turn = { id: turnId, status: 'inProgress', items: [item], startedAt: own.backend.stockHistory!.length + 1 };
    own.backend.stdout.write(JSON.stringify({ method: 'turn/started',
      params: { threadId: own.taskId, turn } }) + '\n');
    const terminal = { ...turn, status: 'completed', completedAt: turn.startedAt + 1, itemsView: 'full' };
    own.backend.stockHistory!.push(terminal);
    own.backend.stdout.write(JSON.stringify({ method: 'turn/completed',
      params: { threadId: own.taskId, turn: terminal } }) + '\n');
    await wait(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed' &&
        JSON.stringify(frame).includes(turnId) && JSON.stringify(frame).includes('completed')));
  };
  try {
    await wait(() => broker.frames.some(frame => frame.method === 'thread-queued-followups-changed'));
    const invalidDirect = [
      (request: Record<string, unknown>) => { request.serviceTier = 'priority'; },
      (request: Record<string, unknown>) => { request.collaborationMode = { mode: 'default', settings: {
        model: 'gpt-5.6-sol', reasoning_effort: 'medium', developer_instructions: 'changed effective instructions' } }; },
      (request: Record<string, unknown>) => { request.permissions = ':read-only'; },
      (request: Record<string, unknown>) => { request.approvalPolicy = 'on-request'; },
      (request: Record<string, unknown>) => { request.sandboxPolicy = { type: 'readOnly', networkAccess: false }; },
      (_request: Record<string, unknown>, context: Record<string, unknown>) => {
        context.responseItems = [{ type: 'message' }];
      },
      (_request: Record<string, unknown>, context: Record<string, unknown>) => {
        context.attachments = [{ id: 'unqualified-attachment' }];
      },
      (request: Record<string, unknown>) => {
        (request.input as Array<Record<string, unknown>>)[0]!.text_elements = [{ type: 'mention' }];
      },
      (request: Record<string, unknown>) => { request.unqualifiedField = true; },
    ];
    for (let index = 0; index < invalidDirect.length; index++) {
      const id = `stock-invalid-direct-${index}`;
      const invalid = direct(id).frame;
      const params = invalid.params as Record<string, unknown>;
      const start = params.turnStart as Record<string, unknown>;
      const request = start.request as Record<string, unknown>;
      const context = start.context as Record<string, unknown>;
      invalidDirect[index]!(request, context);
      await rejectFrame(invalid, id);
      assert.equal(own.backend.writes, 0);
      assert.equal(own.backend.queueWrites, 0);
    }
    const first = direct('stock-direct-one'); broker.send(first.frame);
    const firstResult = await response('stock-direct-one');
    const firstTurn = (firstResult.result as Record<string, unknown>).turn as Record<string, unknown>;
    assert.equal(firstTurn.id, 'stock-direct-turn-1');
    assert.equal(own.backend.writes, 1); assert.equal(own.backend.queueWrites, 0);
    await complete(firstTurn.id as string, first.clientId);
    const entry = stockEntry(own.home);
    entry.id = first.clientId; // A queued client identity cannot reuse an accepted direct command.
    await rejectFrame({ type: 'request', requestId: 'stock-queue-direct-client-collision',
      sourceClientId: 'follower', targetClientId: broker.ownerId, hostId: 'local',
      method: 'thread-follower-set-queued-follow-ups-state', version: 1,
      params: { conversationId: own.taskId, state: { [own.taskId]: [entry] } } },
    'stock-queue-direct-client-collision');
    assert.equal(own.backend.writes, 1);
    assert.equal(own.backend.queueWrites, 0);
    entry.id = randomUUID();
    broker.send({ type: 'request', requestId: 'stock-between', sourceClientId: 'follower',
      targetClientId: broker.ownerId, hostId: 'local', method: 'thread-follower-set-queued-follow-ups-state',
      version: 1, params: { conversationId: own.taskId, state: { [own.taskId]: [entry] } } });
    assert.deepEqual(await response('stock-between'), { ok: true });
    assert.equal(own.backend.queueWrites, 1);
    await complete('stock-queued-turn', entry.id as string);
    await rejectFrame(direct('stock-direct-queue-client-collision', entry.id as string).frame,
      'stock-direct-queue-client-collision');
    assert.equal(own.backend.writes, 1);
    assert.equal(own.backend.queueWrites, 1);
    const second = direct('stock-direct-two'); broker.send(second.frame);
    const secondResult = await response('stock-direct-two');
    const secondTurn = (secondResult.result as Record<string, unknown>).turn as Record<string, unknown>;
    assert.equal(secondTurn.id, 'stock-direct-turn-2');
    await complete(secondTurn.id as string, second.clientId);
    broker.send({ ...first.frame, requestId: 'stock-direct-duplicate' });
    assert.deepEqual(await response('stock-direct-duplicate'), firstResult);
    assert.equal(own.backend.writes, 2); assert.equal(own.backend.queueWrites, 1);
    assert.equal(own.backend.settingsWrites, 1);
    assert.equal(own.backend.methods.filter(method => method === 'thread/resume').length, 1);
    for (const frame of own.backend.frames.filter(frame => frame.method === 'turn/start')) {
      const params = frame.params as Record<string, unknown>;
      assert.equal(params.permissions, ':danger-full-access'); assert.equal(params.approvalPolicy, 'never');
      assert.equal(params.effort, 'medium'); assert.equal(params.turnTrigger, undefined);
      assert.equal(params.responsesapiClientMetadata, undefined);
    }
    assert.deepEqual((await controlStop(own.privateDirectory, own.reserved.epoch, 'stock-direct-stop')).result,
      { stopped: true });
  } finally {
    if (own.backend.exitCode === null) { own.backend.exitCode = 1;
      own.backend.emit('exit', 1, null); own.backend.emit('close', 1, null); }
    await (own.control as ManagedWorkerControlServer | null)?.close();
  }
});

test('stock stop refuses native intents missing from the worker journal, including a late family-proof reservation', async () => {
  for (const phase of ['reserved', 'unknown', 'accepted', 'during-family'] as const) {
    const family: { allow: boolean; beforeReturn?: () => void } = { allow: true };
    const own = await readyFixture(family, { enabled: false, early: false }, 'normal', true);
    const journal = new NativeStockQueueJournal({ filePath: path.join(own.privateDirectory, 'native-stock.sqlite'),
      taskId: own.taskId, ownerEpoch: own.reserved.epoch, sourceGeneration: 'qualified-stock-v1' });
    const id = randomUUID(), fingerprint = 'a'.repeat(64);
    const input = [{ type: 'text', text: 'PUBLIC_PENDING', text_elements: [] }];
    const reserve = () => journal.reserve({ expectedVersion: journal.readTask().version,
      opId: id, fingerprint, nativeEntry: { id, text: 'PUBLIC_PENDING' },
      effectiveSettings: { model: 'gpt-5.6-sol', effort: 'medium' },
      admissionEvidence: { taskId: own.taskId, ownerEpoch: own.reserved.epoch },
      stockInput: input, forwardedUpstream: {} });
    try {
      if (phase === 'during-family') family.beforeReturn = () => { reserve(); };
      else {
        reserve();
        if (phase === 'unknown') journal.markUnknown({ opId: id, fingerprint });
        if (phase === 'accepted') journal.markAccepted({ opId: id, fingerprint, stockId: 'own-submission',
          input, sourceGeneration: 'qualified-stock-v1', clientUserMessageId: id,
          threadId: own.taskId, assertSourceCurrent: () => true });
      }
      assert.equal((await controlStop(own.privateDirectory, own.reserved.epoch, `native-${phase}`)).error,
        'stop-refused');
      assert.equal(own.backend.exitCode, null);
      assert.equal(own.daemon.metadata.state, 'ready');
      assert.equal(own.backend.queueWrites, 0);
      assert.equal(own.backend.writes, 0);
    } finally {
      journal.close();
      await (own.control as ManagedWorkerControlServer | null)?.close();
      own.backend.stdin.end();
    }
  }
});

test('stock daemon refuses uncontrolled baseline or foreign owner discovery before queue writes', async () => {
  for (const failure of ['baseline', 'discovery'] as const) {
    const own = await readyFixture({ allow: true }, { enabled: true, early: false },
      'normal', true, failure);
    try {
      if (failure === 'baseline') {
        assert.equal(own.daemon.metadata.state, 'ready');
        const broker = own.brokers[0]!;
        broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
          sourceClientId: 'follower', params: { hostId: 'local', conversationId: own.taskId,
            following: true } });
        broker.send({ type: 'request', requestId: 'uncontrolled-queue',
          sourceClientId: 'follower', targetClientId: broker.ownerId, hostId: 'local',
          method: 'thread-follower-set-queued-follow-ups-state', version: 1,
          params: { hostId: 'local', conversationId: own.taskId,
            state: { [own.taskId]: [stockEntry(own.home)] } } });
        const deadline = Date.now() + 2_000;
        const refused = () => broker.frames.some(frame => frame.type === 'response' &&
          frame.requestId === 'uncontrolled-queue' && frame.resultType === 'error') ||
          own.daemon.metadata.nativeState === 'failed';
        while (!refused() && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(refused(), 'uncontrolled native queue request did not reach a refusal');
      } else assert.equal(own.daemon.metadata.state, 'failed');
      assert.equal(own.backend.settingsWrites, 1);
      assert.equal(own.backend.queueWrites, 0);
      assert.equal(own.backend.writes, 0);
      assert.equal(own.backend.exitCode, null);
      assert.ok(own.probeBrokers.some(broker => broker.frames.some(frame =>
        frame.method === 'thread-owner-discovery')));
    } finally {
      await (own.control as ManagedWorkerControlServer | null)?.close();
      own.backend.stdin.end();
    }
  }
});

test('failed stock owner discovery requires explicit authenticated zero-work stop', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
    assert.equal(own.backend.writes, 0);
    assert.equal(own.backend.queueWrites, 0);
    const locator = JSON.parse(await readFile(path.join(own.privateDirectory,
      'startup-control.v1.json'), 'utf8')) as {control:{port:number}};
    const disconnected = await controlRequest(locator.control.port, own.reserved.epoch,
      'failed-status', 'status');
    assert.ok(disconnected.result);
    assert.equal(own.backend.exitCode, null, 'control EOF did not stop the worker');
    const stopped = await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'explicit-failed-stop', 'stop');
    assert.deepEqual(stopped.result, { stopped: true });
    assert.equal(own.daemon.metadata.state, 'stopped');
    assert.equal(own.backend.exitCode, 0);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    if (own.backend.exitCode === null) own.backend.stdin.end();
  }
});

test('failed-start stop refuses unconfirmed settings while preserving control and backend', async () => {
  const own = await readyFixture({ allow: true }, { enabled: false, early: false },
    'normal', true, 'notice');
  try {
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.settingsWrites, 1);
    assert.equal(own.backend.writes, 0);
    const refused = await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'unknown-settings-stop', 'stop');
    assert.equal(refused.error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
    assert.ok((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'unknown-settings-status', 'status')).result);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

test('failed-start family refusal is definitive and a later explicit stop can succeed', async () => {
  const family: { allow: boolean; beforeReturn?: () => void } = { allow: false };
  const own = await readyFixture(family, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-busy', 'stop')).error, 'stop-refused');
    assert.equal(own.backend.exitCode, null);
    assert.equal(own.daemon.metadata.state, 'failed');
    family.allow = true;
    family.beforeReturn = () => { throw new Error('test-only family proof unavailable'); };
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-family-error', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    delete family.beforeReturn;
    assert.deepEqual((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-idle', 'stop')).result, { stopped: true });
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    if (own.backend.exitCode === null) own.backend.stdin.end();
  }
});

test('failed-start stop refuses a backend birth change during family proof', async () => {
  const family: {allow:boolean;beforeReturn?:()=>void} = { allow: true };
  const own = await readyFixture(family, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    family.beforeReturn = () => { own.backend.birthDrift = true; };
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-birth-drift', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
    assert.ok((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-birth-status', 'status')).result);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

test('failed-start stop refuses a new unresolved server request during family proof', async () => {
  const family: {allow:boolean;beforeReturn?:()=>void} = { allow: true };
  const own = await readyFixture(family, { enabled: true, early: false },
    'normal', true, 'discovery');
  try {
    family.beforeReturn = () => {
      own.backend.stdout.write(JSON.stringify({ id: 'pending-question',
        method: 'item/tool/requestUserInput', params: { threadId: own.taskId,
          turnId: 'none', questions: [] } }) + '\n');
    };
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-pending-request', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
  } finally {
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

test('failed-start stop refuses a durable accepted queue receipt even with zero visible turns', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false },
    'normal', true, 'discovery');
  const generation = own.daemon.metadata.generation;
  assert.ok(generation);
  const journal = new ManagedWorkerOperationJournal({ filePath: path.join(own.privateDirectory,
    'operations.sqlite'), ownerEpoch: own.reserved.epoch, backendGeneration: generation,
  threadId: own.taskId });
  try {
    const operation = journal.reserve({ operationId: randomUUID(),
      clientUserMessageId: randomUUID(), method: 'thread/queue/add',
      fingerprint: 'a'.repeat(64) }).operation;
    journal.accept(operation, 'retained-queue-submission');
    assert.equal((await startupControlRequest(own.privateDirectory, own.reserved.epoch,
      'failed-accepted-queue', 'stop')).error, 'stop-refused');
    assert.equal(own.daemon.metadata.state, 'failed');
    assert.equal(own.backend.exitCode, null);
  } finally {
    journal.close();
    await (own.control as ManagedWorkerControlServer | null)?.close();
    own.backend.stdin.end();
  }
});

class Backend extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly pid = 42424; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  readonly methods: string[] = []; resumed = false; writes = 0; materializeTurn = true;
  activeTurn = false;
  stock = false; settingsWrites = 0; queueWrites = 0; emitSettingsNotice = true; birthDrift = false;
  holdQueueReply = false; heldQueueReply: Record<string, unknown> | null = null;
  readonly frames: Record<string, unknown>[] = [];
  failBootstrap = false; resumeServiceTier: 'default' | null = null;
  terminalQueueClients: string[] | null = null;
  stockCompletedClients: string[] = [];
  stockHistory: Record<string, unknown>[] | null = null;
  queueEntries: Record<string, unknown>[] = [];
  readStatusOverride: string | null = null;
  turnFailureError: Record<string, unknown> | null = null;
  goalOverride: unknown = null;
  holdEvidenceRead = false; heldEvidenceRead: Record<string, unknown> | null = null;
  holdIdOnlyResume = false;
  heldIdOnlyResume: unknown = null;
  readonly taskId: string; readonly cwd: string;
  constructor(taskId: string, cwd: string) {
    super(); this.taskId = taskId; this.cwd = cwd;
    let data = '';
    this.stdin.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      while (data.includes('\n')) {
        const end = data.indexOf('\n'); const frame = JSON.parse(data.slice(0, end)) as Record<string, unknown>;
        data = data.slice(end + 1);
        const method = String(frame.method); this.methods.push(method); this.frames.push(frame);
        if (!Object.hasOwn(frame, 'id')) continue;
        if (method === 'turn/start') { this.writes++;
          queueMicrotask(() => this.stdout.write(JSON.stringify({ id: frame.id,
            result: { turn: { id: this.stock ? `stock-direct-turn-${this.writes}` : 'accepted-composer-turn',
              status: 'inProgress', extra: true } } }) + '\n'));
          continue; }
        if (method === 'thread/settings/update') {
          this.settingsWrites++;
          queueMicrotask(() => {
            this.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\n');
            if (this.emitSettingsNotice) this.stdout.write(JSON.stringify({
              method: 'thread/settings/updated', params: { threadId: this.taskId,
                threadSettings: { ...(frame.params as Record<string, unknown>),
                  modelProvider: 'openai', sandboxPolicy: { type: 'dangerFullAccess' },
                  activePermissionProfile: { id: ':danger-full-access', extends: null },
                  disabledPluginIds: [], multiAgentMode: 'explicitRequestOnly' } } }) + '\n');
          });
          continue;
        }
        if (method === 'thread/queue/add') { this.queueWrites++;
          const params = frame.params as Record<string, unknown>;
          if (this.holdQueueReply) { this.heldQueueReply = frame; continue; }
          queueMicrotask(() => this.stdout.write(JSON.stringify({ id: frame.id,
            result: { queuedSubmission: { id: `submission-${this.queueWrites}`,
              clientUserMessageId: params.clientUserMessageId, input: params.input } } }) + '\n'));
          continue;
        }
        if (method === 'thread/read' && this.holdEvidenceRead &&
            (frame.params as Record<string, unknown> | undefined)?.includeTurns === false) {
          this.heldEvidenceRead = frame; continue;
        }
        if (method === 'thread/resume' && this.holdIdOnlyResume &&
            Object.keys(frame.params as Record<string, unknown>).length === 1) {
          this.holdIdOnlyResume = false; this.heldIdOnlyResume = frame.id; continue;
        }
        queueMicrotask(() => this.stdout.write(JSON.stringify({ id: frame.id,
          result: this.answer(method) }) + '\n'));
      }
    });
    this.stdin.on('finish', () => {
      this.exitCode = 0; this.emit('exit', 0, null); this.emit('close', 0, null);
    });
  }
  answer(method: string): Record<string, unknown> {
    const thread = () => ({ id: this.taskId, sessionId: this.taskId,
      createdAt: 100, updatedAt: 101, cwd: this.cwd,
      model: 'gpt-5.6-sol', modelProvider: 'openai', reasoningEffort: this.stock ? 'medium' : 'low',
      status: { type: this.readStatusOverride ?? (this.resumed ? 'idle' : 'notLoaded') },
      turns: this.terminalTurns(),
      environments: this.stock ? [] : [{ environmentId: 'local', cwd: this.cwd, runtimeWorkspaceRoots: [this.cwd] }] });
    if (method === 'initialize') return { serverInfo: { name: 'fixture' } };
    if (method === 'account/read') return { account: { type: 'chatgpt',
      email: 'fixture@example.invalid', planType: 'pro' }, requiresOpenaiAuth: false };
    if (method === 'thread/read') return { thread: this.failBootstrap && this.resumed ?
      { ...thread(), status: { type: 'inProgress' } } : thread() };
    if (method === 'thread/turns/list') return { data: this.terminalTurns().map(turn =>
      ({ ...turn, itemsView: 'full' })), nextCursor: null };
    if (method === 'thread/goal/get') return { goal: this.goalOverride };
    if (method === 'thread/queue/list') return { data: this.queueEntries, nextCursor: null };
    if (method === 'thread/resume') {
      this.resumed = true;
      return { thread: thread(), cwd: this.cwd, model: 'gpt-5.6-sol', modelProvider: 'openai',
        reasoningEffort: this.stock ? 'medium' : 'low',
        approvalPolicy: 'never', activePermissionProfile: this.stock ?
          { id: ':danger-full-access', extends: null } : { id: ':read-only', extends: null },
        sandbox: this.stock ? { type: 'dangerFullAccess' } :
          { type: 'readOnly', networkAccess: false }, runtimeWorkspaceRoots: [this.cwd],
        serviceTier: this.resumeServiceTier, approvalsReviewer: 'user', disabledPluginIds: [],
        multiAgentMode: 'explicitRequestOnly', collaborationMode: null };
    }
    if (method === 'config/read') return { config: { model_reasoning_summary: null, personality: 'pragmatic' } };
    if (method === 'configRequirements/read') return { requirements: {
      featureRequirements: { fast_mode: false } } };
    throw new Error(`unexpected method ${method}`);
  }
  kill(): boolean { this.exitCode = 0; this.emit('close', 0, null); return true; }
  answerHeldEvidenceRead(): void {
    const frame = this.heldEvidenceRead;
    assert.ok(frame);
    this.heldEvidenceRead = null; this.holdEvidenceRead = false;
    this.stdout.write(JSON.stringify({ id: frame.id, result: this.answer('thread/read') }) + '\n');
  }
  answerHeldQueue(): void {
    const frame = this.heldQueueReply;
    assert.ok(frame);
    this.heldQueueReply = null; this.holdQueueReply = false;
    const params = frame.params as Record<string, unknown>;
    this.stdout.write(JSON.stringify({ id: frame.id, result: { queuedSubmission: {
      id: `submission-${this.queueWrites}`, clientUserMessageId: params.clientUserMessageId,
      input: params.input } } }) + '\n');
  }
  answerHeldQueueMalformed(): void {
    const frame = this.heldQueueReply;
    assert.ok(frame);
    this.heldQueueReply = null; this.holdQueueReply = false;
    const params = frame.params as Record<string, unknown>;
    this.stdout.write(JSON.stringify({ id: frame.id, result: { queuedSubmission: {
      id: `submission-${this.queueWrites}`, clientUserMessageId: 'wrong-client',
      input: params.input } } }) + '\n');
  }
  rejectHeldIdOnlyResume(): void {
    assert.notEqual(this.heldIdOnlyResume, null);
    this.stdout.write(JSON.stringify({ id: this.heldIdOnlyResume,
      error: { code: -32001, message: 'fixture-current-read-unavailable' } }) + '\n');
    this.heldIdOnlyResume = null;
  }
  terminalTurns(): Record<string, unknown>[] {
    if (this.stockHistory !== null) return this.stockHistory;
    if (this.stock && this.stockCompletedClients.length) return this.stockCompletedClients.map((clientId, index) =>
      ({ id: `stock-turn-${index + 1}`, status: 'completed', items: [
        { id: `stock-user-${index + 1}`, type: 'userMessage', clientId,
          content: [{ type: 'text', text: 'PUBLIC_OK' }] },
        { id: `stock-agent-${index + 1}`, type: 'agentMessage', text: 'done' } ] }));
    if (this.terminalQueueClients !== null) return [{ id: 'queue-terminal-turn', status: 'completed',
      items: this.terminalQueueClients.map((clientId, index) => ({ id: `queue-user-${index}`,
        type: 'userMessage', clientId, content: [{ type: 'text', text: 'fixture only' }] })) }];
    return this.writes && this.materializeTurn ?
      [{ id: 'accepted-composer-turn',
        status: this.turnFailureError ? 'failed' : this.activeTurn ? 'inProgress' : 'completed',
        ...(this.turnFailureError ? { error: this.turnFailureError } : {}), items: [] }] : [];
  }
}
class Broker extends Duplex {
  readonly decoder = new FrameDecoder();
  readonly frames: Record<string, unknown>[] = [];
  constructor(readonly early: Record<string, unknown> | null = null, readonly taskId = '',
    readonly rejectInitialize = false, readonly probe = false,
    readonly ownerId = 'local-owner', readonly initialFollow = false) { super(); }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    for (const frame of this.decoder.push(chunk)) {
      this.frames.push(frame);
      if (frame.method === 'initialize') {
        if (this.rejectInitialize) { queueMicrotask(() => this.destroy()); continue; }
        const reply = encodeFrame({ type: 'response', requestId: frame.requestId,
          resultType: 'success', result: { clientId: this.probe ? 'probe' : this.ownerId } });
        if (this.early) this.push(Buffer.concat([reply, encodeFrame({ type: 'broadcast',
          method: 'thread-stream-following-changed', version: 1, sourceClientId: 'follower',
          params: { conversationId: this.taskId, hostId: 'local', following: true } }), encodeFrame(this.early)]));
        else if (this.initialFollow) this.push(Buffer.concat([reply, encodeFrame({ type: 'broadcast',
          method: 'thread-stream-following-changed', version: 1, sourceClientId: 'follower',
          params: { conversationId: this.taskId, hostId: 'local', following: true } })]));
        else this.push(reply);
      }
      if (frame.method === 'thread-owner-discovery') this.push(encodeFrame({ type: 'response',
        requestId: frame.requestId, resultType: 'success', handledByClientId: this.ownerId,
        result: { supportsUntrustedAppInput: false } }));
    }
    done();
  }
  send(frame: Record<string, unknown>): void { this.push(encodeFrame(frame)); }
}

function composerRequest(taskId: string, cwd: string, requestId: string): Record<string, unknown> {
  return { type: 'request', requestId, sourceClientId: 'follower', hostId: 'local',
    targetClientId: 'local-owner', method: 'thread-follower-start-turn', version: 2,
    params: { conversationId: taskId, turnStart: { request: {
      threadId: taskId, clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: 'fixture only', text_elements: [] }],
      cwd, model: null, effort: null, serviceTier: null,
      collaborationMode: { mode: 'default', settings: {
        model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } },
      permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user',
      turnTrigger: 'composer', multiAgentMode: 'explicitRequestOnly',
      responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    }, context: { inheritThreadSettings: true, writingBlockContextPrepared: true,
      localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [],
      responseItems: [], useAppServerPermissionDefault: false, usePermissionSelection: false } } } };
}

function stockEntry(cwd: string, id = randomUUID()): Record<string, unknown> {
  const mode = { mode: 'default', settings: { model: 'gpt-5.6-sol',
    reasoning_effort: 'medium', developer_instructions: null } };
  return { id, text: 'PUBLIC_OK', cwd, createdAt: 1780000000000,
    context: { prompt: 'PUBLIC_OK', turnTrigger: 'composer', workspaceRoots: [cwd],
      usedDictation: false, existingWorkspaceRoot: null, localProjectId: null,
      fileAttachments: [], addedFiles: [] },
    responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    submissionOptions: { executionHostId: 'local', agentMode: 'full-access',
      permissionProfileId: ':danger-full-access', serviceTier: 'default',
      shouldSendPermissionOverrides: false, usePermissionSelection: false,
      permissionSelection: null, collaborationMode: mode,
      clientUserMessageId: randomUUID() },
    writingBlockAdditionalContext: null, mentionedBrowserFamilies: [], submissionIntent: 'send-now',
    submission: { hostId: 'local', status: 'pending', queueModeOverride: 'queue' } };
}

async function readyFixture(family: { allow: boolean; beforeReturn?: () => void;
  expectedTurnCount?: number } = { allow: true },
  native: { enabled: boolean; early: boolean; available?: boolean } = { enabled: false, early: false },
  startup: 'normal' | 'bootstrap-fail' | 'policy-mismatch' |
    'control-bind-fail' | 'endpoint-collision' = 'normal',
  stock = false, stockFailure: 'baseline' | 'discovery' | 'notice' | 'policy' | null = null,
  headlessVk?: Readonly<{ capability: object; sourceId: string }>, backendTimeoutMs?: number,
  nativeTaskState = false, handoffCapability?: object,
  oneShotFirstComposer?: NonNullable<ManagedWorkerDaemonOptions['oneShotFirstComposer']>,
  nativeCliWebSocket?: NonNullable<ManagedWorkerDaemonOptions['nativeCliWebSocket']>,
  cliApprovedPolicy = true, cliRolloutJunction = false, refusalOnlyProbe = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-ready-'));
  const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
  await Promise.all([mkdir(home), mkdir(privateDirectory)]);
  if (startup === 'endpoint-collision')
    await writeFile(path.join(privateDirectory, 'endpoint.v1.json'), 'preexisting-own-endpoint');
  const cliPath = path.join(root, 'cli.exe'), registryPath = path.join(root, 'registry.sqlite');
  await writeFile(cliPath, 'pinned-code');
  const registry = new ManagedWorkerRegistry(registryPath);
  const reserved = registry.reserve(home, 'own-family'); registry.close();
  const taskId = stock || nativeCliWebSocket ? randomUUID() : 'own-zero-turn';
  const cliPolicy = nativeCliWebSocket && cliApprovedPolicy ? approveTaskPolicy({ threadId: taskId,
    model: 'gpt-5.6-sol', modelProvider: 'openai', effort: 'low', cwd: home,
    runtimeWorkspaceRoots: [home], environments: [{ environmentId: 'local', cwd: home,
      runtimeWorkspaceRoots: [home] }], approvalPolicy: 'never', approvalsReviewer: 'user',
    activePermissionProfile: { id: ':read-only', extends: null },
    sandbox: { type: 'readOnly', networkAccess: false }, serviceTier: null }) : null;
  let managedOwnerClaim: { storePath: string; bindingId: string; claimId: string } | null = null;
  if (cliPolicy || stock) {
    const storePath = path.join(root, 'bridge.sqlite');
    const bridge = new BridgeStore(storePath);
    try {
      const binding = bridge.ensureBinding({ hostId: 'local', threadId: taskId,
        sourceId: 'daemon-fixture', title: 'Daemon fixture', workspace: root, updatedAt: 1 });
      const claim = bridge.claimManagedOwner(binding.id, { ownerEpoch: reserved.epoch,
        canonicalHome: reserved.canonicalHome, familyRoot: reserved.familyRoot });
      managedOwnerClaim = { storePath, bindingId: binding.id, claimId: claim.id };
    } finally { bridge.close(); }
  }
  let cliOptions = nativeCliWebSocket;
  let creationJournal: ControlledNativeCreationJournal | null = null;
  if (nativeCliWebSocket?.singleAcceptedStart && cliPolicy) {
    const operationId = randomUUID(), sourceGeneration = randomUUID();
    const identity = { operationId, sourceGeneration, sourceId: 'isolated-cli-fixture' };
    await mkdir(path.join(home, 'sessions'));
    const preflight = await captureControlledNativeSourcePreflight(identity, home, home);
    const receiptPath = path.join(privateDirectory, 'source-preflight.json');
    await persistControlledNativeSourcePreflightReceipt(receiptPath, preflight);
    const physicalRolloutPath = path.join(home, 'sessions', `${taskId}.jsonl`);
    await writeFile(physicalRolloutPath, `${JSON.stringify({ type: 'session_meta', payload: {
      id: taskId, session_id: taskId, cwd: home } })}\n`);
    let rolloutPath = physicalRolloutPath;
    if (cliRolloutJunction) {
      const alias = path.join(root, 'sessions-alias');
      await symlink(path.join(home, 'sessions'), alias, 'junction');
      rolloutPath = path.join(alias, `${taskId}.jsonl`);
    }
    creationJournal = new ControlledNativeCreationJournal(path.join(privateDirectory, 'creation.sqlite'));
    const { threadId: _threadId, serviceTier: _serviceTier, environments: _environments,
      ...fixed } = cliPolicy;
    const intent = { ...identity, creatorNonce: randomUUID(), sourceProofRequired: true as const,
      requestedPolicy: { ...fixed, allowedServiceTiers: [null],
        allowedEnvironments: [cliPolicy.environments] } };
    const started = { ...intent, threadId: taskId, selectedEffective: {
      model: cliPolicy.model, modelProvider: cliPolicy.modelProvider,
      reasoningEffort: cliPolicy.effort, serviceTier: cliPolicy.serviceTier, cwd: cliPolicy.cwd,
      approvalPolicy: cliPolicy.approvalPolicy, environments: cliPolicy.environments,
      runtimeWorkspaceRoots: cliPolicy.runtimeWorkspaceRoots,
      approvalsReviewer: cliPolicy.approvalsReviewer,
      activePermissionProfile: cliPolicy.activePermissionProfile, sandbox: cliPolicy.sandbox } };
    await creationJournal.persistIntent(intent);
    await creationJournal.persistStarted(started);
    await creationJournal.persistQualified({ ...started, effectivePolicy: cliPolicy,
      rolloutPath, status: 'qualified-zero-turn' });
    const sourceScope = await deriveControlledNativeCliSourceScope({ journal: creationJournal,
      operationId, preflightReceiptPath: receiptPath, sourceHome: home, workspace: home });
    cliOptions = { ...nativeCliWebSocket, sourceScope };
  }
  const backend = new Backend(taskId, home), brokers: Broker[] = [], probeBrokers: Broker[] = [],
    handlerErrors: string[] = [];
  const ownerId = stock ? randomUUID() : 'local-owner';
  backend.stock = stock;
  backend.emitSettingsNotice = stockFailure !== 'notice';
  backend.failBootstrap = startup === 'bootstrap-fail';
  backend.resumeServiceTier = startup === 'policy-mismatch' ? 'default' : null;
  let control: ManagedWorkerControlServer | null = null;
  let launches = 0, observations = 0;
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: root, epoch: reserved.epoch, allowFollower: () => native.enabled,
    ...(refusalOnlyProbe ? { refusalOnlyProbe: true } as never : {}),
    ...(oneShotFirstComposer ? { oneShotFirstComposer } : {}),
    ...(cliOptions ? { nativeCliWebSocket: cliOptions } : {}),
    ...(nativeTaskState ? { nativeTaskState: true as const } : {}),
    ...(stock ? { nativeStockQueue: { sourceGeneration: 'qualified-stock-v1',
      assertControlledNativeBaseline: () => stockFailure !== 'baseline',
      ...(headlessVk ? { headlessVk } : {}),
      ...(handoffCapability ? { handoffCapability } : {}),
      createProbeClient: () => new DesktopIpcClient(() => {
        const probe = new Broker(null, taskId, false, true,
          stockFailure === 'discovery' ? 'foreign-owner' : ownerId);
        probeBrokers.push(probe); return probe;
      }, 500) } } : {}),
    clientFactory: handler => new DesktopIpcClient(() => {
      const broker = new Broker(native.early && brokers.length === 0 ?
        composerRequest(taskId, home, 'before-ready') : null, taskId, native.available === false,
        false, ownerId, stock && stockFailure !== 'baseline');
      brokers.push(broker); return broker;
    }, 500, { canHandle: request => handler.canHandle(request),
      onComposerIngress: (method, outcome) => handler.onComposerIngress?.(method, outcome),
      onRequestFailure: category => handler.onRequestFailure?.(category),
      handle: async (request, signal) => {
        try { return await handler.handle(request, signal); }
        catch (error) { handlerErrors.push(error instanceof Error ? error.message : 'non-error'); throw error; }
      } }),
    verifyFamilyQuiescent: async ({ idle }) => {
      family.beforeReturn?.();
      if (family.expectedTurnCount !== undefined)
        return family.allow && idle.turnCount === family.expectedTurnCount;
      return family.allow && (native.enabled && backend.writes && backend.materializeTurn ?
        idle.turnCount === 1 && idle.latestTurnId === 'accepted-composer-turn' :
        idle.turnCount === 0 && idle.latestTurnId === null);
    },
    dependencies: {
      ...(backendTimeoutMs ? { backendTimeoutMs } : {}),
      createControl: options => {
        control = startup === 'control-bind-fail' ?
          new class extends ManagedWorkerControlServer {
            override listen(): ReturnType<ManagedWorkerControlServer['listen']> {
              return Promise.reject(new Error('fixture bind failure'));
            }
          }(options) : new ManagedWorkerControlServer(options);
        return control;
      },
      loadPrivateState: async () => ({ manifest: {
        schemaVersion: 1, epoch: reserved.epoch, taskId, familyRoot: 'own-family',
        home, cwd: home, cliPath, cliSha256: createHash('sha256').update('pinned-code').digest('hex'),
        initializeRequest: { clientInfo: { name: 'fixture' }, capabilities: {} },
        resumeParams: { threadId: taskId, cwd: home, model: 'gpt-5.6-sol',
          permissions: stock && stockFailure !== 'policy' ? ':danger-full-access' : ':read-only', approvalPolicy: 'never',
          runtimeWorkspaceRoots: [home], config: { model_reasoning_effort: stock ? 'medium' : 'low' } },
        ...(managedOwnerClaim ? { managedOwnerClaim } : {}),
        ...(cliPolicy ? { approvedTaskPolicy: cliPolicy } : stock ? { approvedTaskPolicy: approveTaskPolicy({ threadId: taskId,
          model: 'gpt-5.6-sol', modelProvider: 'openai', effort: stock ? 'medium' : 'low', cwd: home,
          runtimeWorkspaceRoots: [home], environments: stock ? [] :
            [{ environmentId: 'local', cwd: home, runtimeWorkspaceRoots: [home] }], approvalPolicy: 'never',
          approvalsReviewer: 'user', activePermissionProfile: { id: !stock || stockFailure === 'policy' ?
            ':read-only' : ':danger-full-access', extends: null },
          sandbox: !stock || stockFailure === 'policy' ? { type: 'readOnly', networkAccess: false } :
            { type: 'dangerFullAccess' }, serviceTier: null }) } : {}), registryPath,
      }, keys: { fingerprintKey: Buffer.alloc(32, 1).toString('base64'),
        intentKey: Buffer.alloc(32, 2).toString('base64'),
        controlToken: Buffer.alloc(32, 3).toString('base64') }, privateDirectory }),
      observeProcess: pid => { observations++; return pid === backend.pid && backend.exitCode !== null ? null :
        { pid, birthTicks: String(pid + 100 + (pid === backend.pid && backend.birthDrift ? 1 : 0)) }; },
      launch: () => { launches++; return backend as unknown as ChildProcessWithoutNullStreams; },
    },
  });
  if (nativeCliWebSocket)
    assert.throws(() => daemon.nativeCliWebSocketCapability(nativeCliWebSocket.capability),
      /Native CLI frontend unavailable/);
  if (stockFailure === 'discovery' || stockFailure === 'notice' || stockFailure === 'policy') {
    try {
      await daemon.start();
      throw new Error(`stock ${stockFailure} unexpectedly reached ready`);
    } catch (error) {
      if (daemon.metadata.state !== 'failed') {
        await (control as ManagedWorkerControlServer | null)?.close(); backend.stdin.end();
        throw error;
      }
    }
  }
  else if (startup === 'normal') {
    try { await daemon.start(); }
    catch (error) {
      await (control as ManagedWorkerControlServer | null)?.close(); backend.stdin.end();
      throw error;
    }
  }
  else await assert.rejects(daemon.start(), /startup unavailable/);
  return { daemon, backend, brokers, probeBrokers, handlerErrors, reserved, home, taskId, registryPath,
    privateDirectory, launches, observations, control, creationJournal, cliOptions };
}

test('backend spawn specification strips synthetic bridge hooks and retains TLS and proxy settings', () => {
  const source = Object.freeze({ Path: 'synthetic-path', HTTP_PROXY: 'http://synthetic.invalid',
    NO_PROXY: 'synthetic-no-proxy', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    CODEX_API_KEY: 'synthetic-auth', cOdEx_HoMe: 'old-home', VK_TOKEN: 'synthetic-vk',
    vkOdEx_Secret: 'synthetic-vkodex', BOT_DATA_DIR: 'synthetic-bot',
    nOdE_OpTiOnS: 'synthetic-node-hook', ELECTRON_RUN_AS_NODE: 'synthetic-electron' });
  const spec = buildBackendWorkerSpawnOptions('C:/qualified/cwd', 'C:/qualified/home', source);
  assert.deepEqual(spec.env, { Path: 'synthetic-path', HTTP_PROXY: 'http://synthetic.invalid',
    NO_PROXY: 'synthetic-no-proxy', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    CODEX_API_KEY: 'synthetic-auth', CODEX_HOME: 'C:/qualified/home' });
  assert.deepEqual(source, { Path: 'synthetic-path', HTTP_PROXY: 'http://synthetic.invalid',
    NO_PROXY: 'synthetic-no-proxy', NODE_EXTRA_CA_CERTS: 'synthetic-ca',
    CODEX_API_KEY: 'synthetic-auth', cOdEx_HoMe: 'old-home', VK_TOKEN: 'synthetic-vk',
    vkOdEx_Secret: 'synthetic-vkodex', BOT_DATA_DIR: 'synthetic-bot',
    nOdE_OpTiOnS: 'synthetic-node-hook', ELECTRON_RUN_AS_NODE: 'synthetic-electron' });
  assert.deepEqual(spec.stdio, ['pipe', 'pipe', 'pipe']);
});

async function controlRequest(port: number, epoch: string, id: string, method: string,
  afterAuth?: () => void | Promise<void>): Promise<Record<string, unknown>> {
  const socket = connect(port, '127.0.0.1');
  let buffer = ''; const frames: Record<string, unknown>[] = [];
  let terminal: 'closed' | 'errored' | null = null;
  socket.on('data', chunk => { buffer += chunk.toString();
    while (buffer.includes('\n')) { const at = buffer.indexOf('\n');
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1); }
  });
  socket.on('error', () => { terminal = 'errored'; });
  socket.on('close', () => { terminal ??= 'closed'; });
  await new Promise<void>((resolve, reject) => {
    const connected = () => { socket.off('error', failed); resolve(); };
    const failed = () => { socket.off('connect', connected); reject(new Error('control socket connection failed')); };
    socket.once('connect', connected); socket.once('error', failed);
  });
  const wait = async (phase: 'auth' | 'commandreply', predicate: (frame: Record<string, unknown>) => boolean) => {
    // Windows CI can pause four concurrent test files for several seconds;
    // this bounds a real missing reply without mistaking runner load for one.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate); if (found) return found;
      if (terminal !== null) throw new Error(`control socket ${terminal} during ${phase}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`control ${phase} timeout (frames=${frames.length})`);
  };
  try {
    socket.write(JSON.stringify({ token: Buffer.alloc(32, 3).toString('base64url') }) + '\n');
    await wait('auth', frame => frame.ok === true);
    await afterAuth?.();
    socket.write(JSON.stringify({ id, epoch, method }) + '\n');
    return await wait('commandreply', frame => frame.id === id);
  } finally { socket.destroy(); }
}

async function controlStop(privateDirectory: string, epoch: string, id: string): Promise<Record<string, unknown>> {
  const endpoint = JSON.parse(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8')) as
    { control: { port: number } };
  return controlRequest(endpoint.control.port, epoch, id, 'stop');
}

async function startupControlRequest(privateDirectory: string, epoch: string,
  id: string, method: string, afterAuth?: () => void | Promise<void>): Promise<Record<string, unknown>> {
  const locator = JSON.parse(await readFile(path.join(privateDirectory, 'startup-control.v1.json'), 'utf8')) as
    { control: { port: number } };
  return controlRequest(locator.control.port, epoch, id, method, afterAuth);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('fixture observation timeout');
}

async function nativeCliClient(capability: Readonly<{ host: string; port: number; token: string }>) {
  const socket = new WebSocket(`ws://${capability.host}:${capability.port}/`, {
    headers: { Authorization: `Bearer ${capability.token}` }, perMessageDeflate: false });
  const frames: Record<string, unknown>[] = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve); socket.once('error', reject);
  });
  return { socket, async request(id: string, method: string, params: Record<string, unknown>) {
    socket.send(JSON.stringify({ id, method, params }));
    await waitFor(() => frames.some(frame => frame.id === id));
    return frames.splice(frames.findIndex(frame => frame.id === id), 1)[0]!;
  } };
}

async function observeNativeTaskState(endpoint: { host: string; port: number }, epoch: string,
  taskId: string, backendGeneration: number): Promise<{ socket: ReturnType<typeof connect>; frames: Record<string, unknown>[] }> {
  const socket = connect(endpoint.port, endpoint.host);
  const frames: Record<string, unknown>[] = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n');
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const connected = () => { socket.off('error', failed); resolve(); };
    const failed = () => { socket.off('connect', connected); reject(new Error('task-state socket connection failed')); };
    socket.once('connect', connected); socket.once('error', failed);
  });
  const token = createHmac('sha256', Buffer.alloc(32, 3))
    .update('vkodex-managed-task-state-v1\0').update(epoch).update('\0').update(taskId)
    .update('\0').update(String(backendGeneration)).digest('base64url');
  socket.write(JSON.stringify({ token }) + '\n');
  await waitFor(() => frames.some(frame => frame.ok === true));
  socket.write(JSON.stringify({ method: 'observe-task-v1', epoch, taskId, backendGeneration }) + '\n');
  await waitFor(() => frames.some(frame => frame.kind === 'snapshot'));
  return { socket, frames };
}

test('control bind failure leaves reserved worker unlaunched', async () => {
  const { daemon, backend, launches, control, registryPath, home, privateDirectory } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'control-bind-fail');
  try {
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(launches, 0);
    assert.equal(backend.methods.length, 0);
    await assert.rejects(readFile(path.join(privateDirectory, 'endpoint.v1.json')));
    await assert.rejects(readFile(path.join(privateDirectory, 'startup-control.v1.json')));
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'host_registered'); }
    finally { registry.close(); }
  } finally { await (control as ManagedWorkerControlServer | null)?.close(); }
});

test('bootstrap failure retains authenticated startup diagnosis while EOF cannot stop worker', async () => {
  const { daemon, backend, launches, control, reserved, privateDirectory, registryPath, home } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'bootstrap-fail');
  try {
    assert.equal(launches, 1);
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.startupPhase, 'bootstrapping');
    const locator = JSON.parse(await readFile(path.join(privateDirectory, 'startup-control.v1.json'), 'utf8')) as
      Record<string, unknown>;
    assert.deepEqual(Object.keys(locator).sort(), ['control', 'epoch', 'host', 'schemaVersion']);
    assert.equal(locator.epoch, reserved.epoch);
    assert.equal(JSON.stringify(locator).includes(Buffer.alloc(32, 3).toString('base64url')), false);
    await assert.rejects(readFile(path.join(privateDirectory, 'endpoint.v1.json')));
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'backend_registered'); }
    finally { registry.close(); }
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'd', 'diagnose-v1');
    assert.deepEqual(diagnosis.result, { ownerEpoch: reserved.epoch, taskId: 'own-zero-turn',
      schemaVersion: 1, startupPhase: 'bootstrapping', daemonState: 'failed',
      failureCode: 'startup-unavailable', bootstrapFailureCode: 'thread-read-unqualified',
      registryState: 'backend_registered', owner: null });
    const changed = new ManagedWorkerRegistry(registryPath);
    try {
      const row = changed.get(home, 'own-family')!;
      changed.markLost(row, row.host!, row.backend!, 'backend_unavailable');
    } finally { changed.close(); }
    const later = await startupControlRequest(privateDirectory, reserved.epoch, 'later', 'diagnose-v1');
    assert.equal((later.result as Record<string, unknown>).registryState, 'lost');
    assert.equal((await startupControlRequest(privateDirectory, reserved.epoch, 's', 'stop')).error,
      'stop-refused');
    assert.equal((await startupControlRequest(privateDirectory, reserved.epoch, 'again', 'status')).result
      ? 'available' : 'missing', 'available');
    assert.equal(backend.exitCode, null);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
});

test('effective resume mismatch reports only its fixed category, never a raw setting', async () => {
  const { daemon, backend, control, reserved, privateDirectory } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'policy-mismatch', true);
  try {
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.startupPhase, 'bootstrapping');
    assert.equal(daemon.metadata.bootstrapFailureCode, 'effective-resume-policy-mismatch');
    const result = await startupControlRequest(privateDirectory, reserved.epoch, 'mismatch', 'diagnose-v1');
    assert.equal((result.result as Record<string, unknown>).bootstrapFailureCode,
      'effective-resume-policy-mismatch');
    assert.equal(JSON.stringify(result).includes('default'), false);
    assert.equal(backend.exitCode, null);
  } finally { await (control as ManagedWorkerControlServer | null)?.close(); backend.stdin.end(); }
});

test('stock route rejects incompatible approved permissions before backend launch', async () => {
  const { daemon, backend, control, launches, registryPath, home, privateDirectory } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'normal', true, 'policy');
  try {
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.startupPhase, 'private-loaded');
    assert.equal(daemon.metadata.bootstrapFailureCode, 'stock-policy-unqualified');
    assert.equal(launches, 0);
    assert.equal(control, null);
    await assert.rejects(readFile(path.join(privateDirectory, 'startup-control.v1.json')));
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'reserved'); }
    finally { registry.close(); }
    assert.equal(backend.writes, 0);
  } finally { backend.stdin.end(); }
});

test('control request helper reports an authenticated control termination during command reply', async () => {
  const { backend, control, reserved, privateDirectory } =
    await readyFixture({ allow: true }, { enabled: false, early: false }, 'bootstrap-fail');
  try {
    if (control === null) throw new Error('fixture control unavailable');
    const activeControl = control as unknown as ManagedWorkerControlServer;
    await assert.rejects(startupControlRequest(privateDirectory, reserved.epoch, 'closed', 'status',
      async () => { await activeControl.close(); }),
    /control socket (closed|errored) during commandreply/);
    assert.equal(backend.exitCode, null);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
});

test('post-owner ready endpoint collision retires native gateway but preserves backend and startup control', async () => {
  const { daemon, backend, brokers, control, reserved, privateDirectory, registryPath, home } =
    await readyFixture({ allow: true }, { enabled: true, early: false }, 'endpoint-collision');
  try {
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.startupPhase, 'publishing-ready');
    assert.equal(daemon.metadata.nativeState, 'closed');
    assert.equal(brokers.length, 1);
    assert.equal(brokers[0]!.destroyed, true);
    assert.equal(backend.exitCode, null);
    assert.equal(backend.writes, 0);
    assert.equal(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8'),
      'preexisting-own-endpoint');
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'backend_registered'); }
    finally { registry.close(); }
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'failed-owner', 'diagnose-v1');
    assert.deepEqual(diagnosis.result, { ownerEpoch: reserved.epoch, taskId: 'own-zero-turn',
      schemaVersion: 1, startupPhase: 'publishing-ready', daemonState: 'failed',
      failureCode: 'startup-unavailable', bootstrapFailureCode: null,
      registryState: 'backend_registered',
      owner: daemon.metadata.nativeStartup });
    assert.deepEqual((await startupControlRequest(privateDirectory, reserved.epoch, 'stop', 'stop')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
    assert.equal(backend.exitCode, 0);
    assert.equal(backend.writes, 0);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
});

for (const meaningful of [false, true]) {
  test(`stop fence ${meaningful ? 'rejects a new turn' : 'permits usage-only updates'} during family proof`, async () => {
    const family: { allow: boolean; beforeReturn?: () => void } = { allow: true };
    const f = await readyFixture(family);
    const usage = { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    family.beforeReturn = () => {
      f.backend.stdout.write(JSON.stringify(meaningful
        ? { method: 'turn/started', params: { threadId: 'own-zero-turn',
          turn: { id: 'raced-turn', status: 'inProgress', items: [] } } }
        : { method: 'thread/tokenUsage/updated', params: { threadId: 'own-zero-turn',
          turnId: 'usage-only', tokenUsage: { total: usage, last: usage, modelContextWindow: null } } }) + '\n');
    };
    try {
      const reply = await controlStop(f.privateDirectory, f.reserved.epoch, 'fenced-stop');
      if (meaningful) {
        assert.equal(reply.error, 'stop-refused');
        assert.equal(f.backend.exitCode, null);
        assert.equal(f.daemon.metadata.state, 'ready');
      } else {
        assert.deepEqual(reply.result, { stopped: true });
        assert.equal(f.backend.exitCode, 0);
      }
    } finally {
      await (f.control as ManagedWorkerControlServer | null)?.close();
      if (f.backend.exitCode === null) f.backend.stdin.end();
    }
  });
}

test('opt-in daemon composes one backend, bootstrap, native owner, and ready registry', async () => {
  const { daemon, backend, reserved, home, registryPath, privateDirectory, launches, observations } = await readyFixture();
  assert.equal(daemon.metadata.state, 'ready');
  assert.equal(daemon.metadata.nativeState, 'connected');
  assert.equal(daemon.metadata.nativeStartup?.startupStage, 'ready');
  assert.equal(daemon.metadata.nativeStartup?.bootstrapEventCount, 0);
  assert.equal(launches, 1);
  assert.equal(observations, 2); // startup only, never per native notification
  assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
  assert.equal(backend.writes, 0);
  const check = new ManagedWorkerRegistry(registryPath);
  try {
    const row = check.get(home, 'own-family');
    assert.equal(row?.state, 'ready');
    assert.equal(row?.endpointRef, daemon.metadata.endpointRef);
  } finally { check.close(); }
  const endpoint = JSON.parse(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8')) as
    { control: { port: number } };
  const socket = connect(endpoint.control.port, '127.0.0.1');
  let buffer = ''; const frames: Record<string, unknown>[] = [];
  socket.on('data', chunk => { buffer += chunk.toString();
    while (buffer.includes('\n')) { const at = buffer.indexOf('\n');
      frames.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
      buffer = buffer.slice(at + 1); }
  });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const send = (frame: object) => socket.write(JSON.stringify(frame) + '\n');
  const wait = async (predicate: (frame: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate); if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('control response timeout');
  };
  send({ token: Buffer.alloc(32, 3).toString('base64url') });
  assert.equal((await wait(frame => frame.ok === true)).ok, true);
  send({ id: 'stop-once', epoch: reserved.epoch, method: 'stop' });
  assert.deepEqual((await wait(frame => frame.id === 'stop-once')).result, { stopped: true });
  socket.destroy();
  assert.equal(daemon.metadata.state, 'stopped');
  assert.equal(backend.exitCode, 0);
});

test('unexpected backend exit retires ready admission and marks only its registry epoch lost', async () => {
  const { daemon, backend, reserved, home, registryPath } = await readyFixture();
  backend.exitCode = 1;
  backend.emit('exit', 1, null);
  backend.emit('close', 1, null);
  assert.equal(daemon.metadata.state, 'failed');
  assert.equal(daemon.metadata.failure, 'backend-lost');
  const check = new ManagedWorkerRegistry(registryPath);
  try {
    const row = check.get(home, 'own-family');
    assert.equal(row?.epoch, reserved.epoch);
    assert.equal(row?.state, 'lost');
    assert.equal(row?.lostReason, 'backend_unavailable');
  } finally { check.close(); }
});

test('native projection failure retires daemon readiness while preserving backend and diagnosis', async () => {
  const { daemon, backend, control, reserved, privateDirectory, registryPath, home } = await readyFixture();
  try {
    backend.stdout.write(JSON.stringify({ method: 'thread/unsupported',
      params: { threadId: 'own-zero-turn' } }) + '\n');
    const ownerDeadline = Date.now() + 2000;
    while (daemon.metadata.nativeState !== 'failed' && Date.now() < ownerDeadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(daemon.metadata.nativeState, 'failed');
    const daemonDeadline = Date.now() + 2500;
    while (daemon.metadata.state === 'ready' && Date.now() < daemonDeadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(daemon.metadata.failure, 'native-owner-unavailable');
    assert.equal(backend.exitCode, null);
    assert.equal(backend.writes, 0);
    assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'ready'); }
    finally { registry.close(); }
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'owner-failed', 'diagnose-v1');
    assert.equal((diagnosis.result as Record<string, unknown>).daemonState, 'failed');
    assert.equal((diagnosis.result as Record<string, unknown>).failureCode, 'native-owner-unavailable');
    assert.equal((diagnosis.result as Record<string, unknown>).registryState, 'ready');
    assert.equal((await startupControlRequest(privateDirectory, reserved.epoch, 'stop-failed', 'stop')).error,
      'stop-refused');
    assert.equal(backend.exitCode, null);
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    backend.stdin.end();
  }
});

test('native broker EOF rejoins transport without another backend launch or resume', async () => {
  const { daemon, backend, brokers, reserved, privateDirectory } = await readyFixture();
  assert.equal(brokers.length, 1);
  brokers[0]!.destroy();
  const deadline = Date.now() + 4000;
  while (brokers.length < 2 && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(brokers.length, 2);
  assert.equal(daemon.metadata.state, 'ready');
  assert.equal(daemon.metadata.nativeState, 'connected');
  assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
  const endpoint = JSON.parse(await readFile(path.join(privateDirectory, 'endpoint.v1.json'), 'utf8')) as
    { control: { port: number } };
  const socket = connect(endpoint.control.port, '127.0.0.1');
  let data = ''; socket.on('data', chunk => { data += chunk.toString(); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(JSON.stringify({ token: Buffer.alloc(32, 3).toString('base64url') }) + '\n');
  while (!data.includes('"ok":true')) await new Promise(resolve => setTimeout(resolve, 5));
  socket.write(JSON.stringify({ id: 'stop-after-rejoin', epoch: reserved.epoch, method: 'stop' }) + '\n');
  while (!data.includes('"stopped":true')) await new Promise(resolve => setTimeout(resolve, 5));
  socket.destroy();
});

test('qualified backend publishes disconnected native gateway then reconnects same worker', async () => {
  const native = { enabled: false, early: false, available: false };
  const { daemon, backend, brokers, reserved, privateDirectory, registryPath, home, launches, control } =
    await readyFixture({ allow: true }, native);
  try {
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(daemon.metadata.nativeState, 'disconnected');
    assert.equal(daemon.metadata.nativeStartup?.startupStage, 'connecting');
    assert.equal(backend.exitCode, null);
    assert.equal(backend.writes, 0);
    assert.equal(launches, 1);
    assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
    const registry = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(registry.get(home, 'own-family')?.state, 'ready'); }
    finally { registry.close(); }
    const status = await startupControlRequest(privateDirectory, reserved.epoch, 'headless-status', 'status');
    assert.equal((status.result as Record<string, unknown>).nativeState, 'disconnected');
    const diagnosis = await startupControlRequest(privateDirectory, reserved.epoch, 'headless-diagnose', 'diagnose-v1');
    assert.equal((diagnosis.result as Record<string, unknown>).daemonState, 'ready');
    assert.equal((diagnosis.result as Record<string, unknown>).ownerEpoch, reserved.epoch);
    native.available = true;
    const currentNativeState = () => daemon.metadata.nativeState;
    const deadline = Date.now() + 4000;
    while (currentNativeState() !== 'connected' && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(currentNativeState(), 'connected');
    assert.equal(brokers.length, 2);
    assert.equal(backend.methods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(backend.writes, 0);
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-after-late-connect')).result,
      { stopped: true });
  } finally {
    await (control as ManagedWorkerControlServer | null)?.close();
    if (backend.exitCode === null) backend.stdin.end();
  }
});

test('headless backend can be explicitly stopped while native broker remains unavailable', async () => {
  const { daemon, backend, reserved, privateDirectory, control } = await readyFixture(
    { allow: true }, { enabled: false, early: false, available: false });
  try {
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(daemon.metadata.nativeState, 'disconnected');
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-headless')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
    assert.equal(backend.exitCode, 0);
    assert.equal(backend.writes, 0);
  } finally { await (control as ManagedWorkerControlServer | null)?.close(); }
});

test('pre-ready start cannot write; qualified first Composer start preserves inherited environment wire', async () => {
  const { daemon, backend, brokers, handlerErrors, reserved, privateDirectory, home } = await readyFixture(
    { allow: true }, { enabled: true, early: true });
  try {
  const broker = brokers[0]!;
  const deadline = Date.now() + 2000;
  while (!broker.frames.some(frame => frame.requestId === 'before-ready') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(backend.writes, 0);
  const snapshots = broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length;
  broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
    sourceClientId: 'follower', params: { conversationId: 'own-zero-turn', hostId: 'local', following: true } });
  while (broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length <= snapshots && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(broker.frames.filter(frame => frame.method === 'thread-stream-state-changed').length > snapshots);
  broker.send(composerRequest('own-zero-turn', home, 'after-ready'));
  const written = Date.now() + 2000;
  while (backend.writes === 0 && Date.now() < written)
    await new Promise(resolve => setTimeout(resolve, 5));
  const intents = new Database(path.join(privateDirectory, 'start-intents.sqlite'), { readonly: true });
  const intentCount = (intents.prepare('SELECT count(*) AS n FROM native_start_intents').get() as { n: number }).n;
  intents.close();
  assert.equal(backend.writes, 1, JSON.stringify({ native: daemon.metadata.nativeState, intentCount, handlerErrors,
    results: broker.frames.filter(frame => frame.type === 'response').map(frame => ({
      requestId: frame.requestId, resultType: frame.resultType, error: frame.error })) }));
  const wire = backend.frames.find(frame => frame.method === 'turn/start')!;
  const params = wire.params as Record<string, unknown>;
  assert.equal(params.cwd, null);
  assert.equal(params.runtimeWorkspaceRoots, null);
  assert.deepEqual(params.environments, [{ environmentId: 'local', cwd: home,
    runtimeWorkspaceRoots: [home] }]);
  assert.equal(params.permissions, ':read-only');
  assert.equal(params.approvalPolicy, 'on-request');
  const responseDeadline = Date.now() + 2000;
  while (!broker.frames.some(frame => frame.requestId === 'after-ready') && Date.now() < responseDeadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(broker.frames.find(frame => frame.requestId === 'after-ready')?.resultType, 'success');
  assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-after-composer')).result,
    { stopped: true });
  assert.equal(daemon.metadata.state, 'stopped');
  } finally {
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
  }
});

test('opt-in one-shot first Composer admission permits only one read-only start', async () => {
  const phases: string[] = [];
  const own = await readyFixture({ allow: true }, { enabled: true, early: false }, 'normal',
    false, null, undefined, undefined, false, undefined,
    scope => { phases.push(scope.phase); return true; });
  const { daemon, backend, brokers, home, privateDirectory, reserved } = own;
  try {
    const broker = brokers[0]!;
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: own.taskId, hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));
    const first = composerRequest(own.taskId, home, 'one-shot-first');
    broker.send(first);
    await waitFor(() => broker.frames.some(frame => frame.type === 'response' && frame.requestId === 'one-shot-first'));
    assert.equal(broker.frames.find(frame => frame.requestId === 'one-shot-first')?.resultType, 'success');
    assert.deepEqual(phases, ['before-reservation', 'before-write']);
    broker.send(composerRequest(own.taskId, home, 'one-shot-second'));
    await waitFor(() => broker.frames.some(frame => frame.type === 'response' && frame.requestId === 'one-shot-second'));
    assert.equal(broker.frames.find(frame => frame.requestId === 'one-shot-second')?.resultType, 'error');
    assert.equal(backend.writes, 1);
    const duplicate = structuredClone(first);
    duplicate.requestId = 'one-shot-duplicate';
    broker.send(duplicate);
    await waitFor(() => broker.frames.some(frame => frame.type === 'response' && frame.requestId === 'one-shot-duplicate'));
    assert.equal(broker.frames.find(frame => frame.requestId === 'one-shot-duplicate')?.resultType, 'success');
    assert.equal(backend.writes, 1);
    const intents = new Database(path.join(privateDirectory, 'start-intents.sqlite'), { readonly: true });
    assert.equal((intents.prepare('SELECT count(*) AS n FROM native_start_intents').get() as { n: number }).n, 1);
    intents.close();
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-one-shot')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
  } finally { if (backend.exitCode === null) { backend.exitCode = 1;
    backend.emit('exit', 1, null); backend.emit('close', 1, null); } }
});

test('one-shot first Composer budget remains consumed after pre-write refusal', async () => {
  const phases: string[] = [];
  const own = await readyFixture({ allow: true }, { enabled: true, early: false }, 'normal',
    false, null, undefined, undefined, false, undefined, scope => {
      phases.push(scope.phase); return scope.phase === 'before-reservation';
    });
  const { backend, brokers, home, privateDirectory, reserved } = own;
  try {
    const broker = brokers[0]!;
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: own.taskId, hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));
    broker.send(composerRequest(own.taskId, home, 'refused-first'));
    await waitFor(() => broker.frames.some(frame => frame.type === 'response' && frame.requestId === 'refused-first'));
    assert.equal(broker.frames.find(frame => frame.requestId === 'refused-first')?.resultType, 'error');
    assert.deepEqual(phases, ['before-reservation', 'before-write']);
    broker.send(composerRequest(own.taskId, home, 'refused-second'));
    await waitFor(() => broker.frames.some(frame => frame.type === 'response' && frame.requestId === 'refused-second'));
    assert.equal(broker.frames.find(frame => frame.requestId === 'refused-second')?.resultType, 'error');
    assert.equal(backend.writes, 0);
    const intents = new Database(path.join(privateDirectory, 'start-intents.sqlite'), { readonly: true });
    assert.equal((intents.prepare('SELECT count(*) AS n FROM native_start_intents').get() as { n: number }).n, 1);
    intents.close();
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-refused-one-shot')).result,
      { stopped: true });
  } finally { if (backend.exitCode === null) { backend.exitCode = 1;
    backend.emit('exit', 1, null); backend.emit('close', 1, null); } }
});

test('concurrent distinct one-shot Composer requests never create two intents or writes', async () => {
  const own = await readyFixture({ allow: true }, { enabled: true, early: false }, 'normal',
    false, null, undefined, undefined, false, undefined, () => true);
  const { backend, brokers, home, privateDirectory, reserved } = own;
  try {
    const broker = brokers[0]!;
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: own.taskId, hostId: 'local', following: true } });
    await waitFor(() => broker.frames.some(frame => frame.method === 'thread-stream-state-changed'));
    broker.send(composerRequest(own.taskId, home, 'concurrent-first'));
    broker.send(composerRequest(own.taskId, home, 'concurrent-second'));
    await waitFor(() => ['concurrent-first', 'concurrent-second'].every(id =>
      broker.frames.some(frame => frame.type === 'response' && frame.requestId === id)));
    assert.ok(backend.writes <= 1);
    const intents = new Database(path.join(privateDirectory, 'start-intents.sqlite'), { readonly: true });
    assert.ok((intents.prepare('SELECT count(*) AS n FROM native_start_intents').get() as { n: number }).n <= 1);
    intents.close();
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'stop-concurrent-one-shot')).result,
      { stopped: true });
  } finally { if (backend.exitCode === null) { backend.exitCode = 1;
    backend.emit('exit', 1, null); backend.emit('close', 1, null); } }
});

test('definitive family refusal preserves worker and permits a new explicit stop', async () => {
  const family = { allow: false };
  const { daemon, backend, reserved, privateDirectory } = await readyFixture(family);
  assert.equal((await controlStop(privateDirectory, reserved.epoch, 'busy')).error, 'stop-refused');
  assert.equal(daemon.metadata.state, 'ready');
  assert.equal(backend.exitCode, null);
  family.allow = true;
  assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'authorized')).result,
    { stopped: true });
  assert.equal(daemon.metadata.state, 'stopped');
});

test('accepted turn absent from terminal full history refuses stop until it appears', async () => {
  const { daemon, backend, brokers, reserved, privateDirectory, home } = await readyFixture(
    { allow: true }, { enabled: true, early: false });
  try {
    backend.materializeTurn = false;
    const broker = brokers[0]!;
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: 'own-zero-turn', hostId: 'local', following: true } });
    const deadline = Date.now() + 2000;
    while (!broker.frames.some(frame => frame.method === 'thread-stream-state-changed') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    broker.send(composerRequest('own-zero-turn', home, 'accepted-before-history'));
    while (!broker.frames.some(frame => frame.requestId === 'accepted-before-history') && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'accepted-before-history')?.resultType, 'success');
    assert.equal(backend.writes, 1);
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'not-terminal')).error, 'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.materializeTurn = true;
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'now-terminal')).result,
      { stopped: true });
    assert.equal(daemon.metadata.state, 'stopped');
  } finally {
    if (backend.exitCode === null) { backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null); }
  }
});

test('temporary read-only idle proof refusal keeps an exact live worker ready', async () => {
  const { daemon, backend, reserved, privateDirectory } = await readyFixture();
  try {
    backend.queueEntries = [{ id: 'still-queued' }];
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'queue-busy')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.queueEntries = [];
    backend.readStatusOverride = 'inProgress';
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'not-idle')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.readStatusOverride = null;
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'now-idle')).result,
      { stopped: true });
  } finally {
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
  }
});

test('stop refuses a native continuation still qualifying before any second worker RPC', async () => {
  const { daemon, backend, brokers, reserved, privateDirectory, home } = await readyFixture(
    { allow: true }, { enabled: true, early: false });
  const broker = brokers[0]!;
  const until = Date.now() + 2500;
  try {
    broker.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: 'follower', params: { conversationId: 'own-zero-turn',
        hostId: 'local', following: true } });
    while (!broker.frames.some(frame => frame.method === 'thread-stream-state-changed') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    broker.send(composerRequest('own-zero-turn', home, 'first-composer'));
    while (!broker.frames.some(frame => frame.type === 'response' && frame.requestId === 'first-composer') &&
      Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'first-composer')?.resultType, 'success');
    assert.equal(backend.writes, 1);
    backend.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'own-zero-turn',
      turn: { id: 'accepted-composer-turn', status: 'inProgress', startedAt: 2, items: [] } } }) + '\n');
    backend.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'own-zero-turn',
      turn: { id: 'accepted-composer-turn', status: 'completed', startedAt: 2, items: [] } } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    backend.holdIdOnlyResume = true;
    broker.send(composerRequest('own-zero-turn', home, 'second-qualifying'));
    while (backend.heldIdOnlyResume === null && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.notEqual(backend.heldIdOnlyResume, null,
      JSON.stringify({ methods: backend.methods, responses: broker.frames.filter(frame =>
        frame.type === 'response').map(frame => ({ id: frame.requestId, type: frame.resultType })) }));
    assert.equal(backend.writes, 1);
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'native-before-rpc')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
    backend.rejectHeldIdOnlyResume();
    while (!broker.frames.some(frame => frame.type === 'response' &&
      frame.requestId === 'second-qualifying') && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(broker.frames.find(frame => frame.requestId === 'second-qualifying')?.resultType, 'error');
    assert.equal(backend.writes, 1);
    assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'native-drained')).result,
      { stopped: true });
  } finally {
    if (backend.heldIdOnlyResume !== null) backend.rejectHeldIdOnlyResume();
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
  }
});

test('accepted queue input stops only after exact unique terminal user client identity', async () => {
  for (const observed of [['queue-client'], ['other-client'], ['queue-client', 'queue-client']]) {
    const { daemon, backend, reserved, privateDirectory } = await readyFixture(
      { allow: true, expectedTurnCount: 1 });
    const generation = daemon.metadata.generation;
    assert.ok(generation);
    const journal = new ManagedWorkerOperationJournal({
      filePath: path.join(privateDirectory, 'operations.sqlite'), ownerEpoch: reserved.epoch,
      backendGeneration: generation, threadId: 'own-zero-turn' });
    try {
      const operation = journal.reserve({ operationId: randomUUID(),
        clientUserMessageId: 'queue-client', method: 'thread/queue/add',
        fingerprint: 'a'.repeat(64) }).operation;
      journal.accept(operation, 'actual-queue-submission');
      backend.terminalQueueClients = observed;
      const first = await controlStop(privateDirectory, reserved.epoch, `queue-stop-${observed.length}`);
      if (observed.length === 1 && observed[0] === 'queue-client') {
        assert.deepEqual(first.result, { stopped: true });
      } else {
        assert.equal(first.error, 'stop-refused');
        assert.equal(daemon.metadata.state, 'ready');
        assert.equal(backend.exitCode, null);
        backend.terminalQueueClients = ['queue-client'];
        assert.deepEqual((await controlStop(privateDirectory, reserved.epoch, 'queue-terminal-proven')).result,
          { stopped: true });
      }
    } finally {
      journal.close();
      if (backend.exitCode === null) {
        backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
      }
    }
  }
});

test('duplicate accepted queue submission IDs refuse stop even with distinct terminal clients', async () => {
  const { daemon, backend, reserved, privateDirectory, control } = await readyFixture(
    { allow: true, expectedTurnCount: 1 });
  const generation = daemon.metadata.generation;
  assert.ok(generation);
  const journal = new ManagedWorkerOperationJournal({
    filePath: path.join(privateDirectory, 'operations.sqlite'), ownerEpoch: reserved.epoch,
    backendGeneration: generation, threadId: 'own-zero-turn' });
  try {
    for (const clientUserMessageId of ['queue-one', 'queue-two']) {
      const operation = journal.reserve({ operationId: randomUUID(), clientUserMessageId,
        method: 'thread/queue/add', fingerprint: 'a'.repeat(64) }).operation;
      journal.accept(operation, 'same-submission-id');
    }
    backend.terminalQueueClients = ['queue-one', 'queue-two'];
    assert.equal((await controlStop(privateDirectory, reserved.epoch, 'duplicate-queue-receipt')).error,
      'stop-refused');
    assert.equal(daemon.metadata.state, 'ready');
    assert.equal(backend.exitCode, null);
  } finally {
    journal.close();
    if (backend.exitCode === null) {
      backend.exitCode = 1; backend.emit('exit', 1, null); backend.emit('close', 1, null);
    }
    await (control as ManagedWorkerControlServer | null)?.close();
  }
});

test('exact reserved epoch is required before observing or launching a worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-reserve-'));
  const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
  await Promise.all([mkdir(home), mkdir(privateDirectory)]);
  const registryPath = path.join(root, 'registry.sqlite');
  const registry = new ManagedWorkerRegistry(registryPath);
  const actual = registry.reserve(home, 'own-family');
  registry.close();
  let observed = 0, launched = 0;
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: root, epoch: '22222222-2222-4222-8222-222222222222',
    allowFollower: () => false, clientFactory: () => { throw new Error('unexpected IPC'); },
    verifyFamilyQuiescent: async () => false,
    dependencies: {
      loadPrivateState: async () => ({ manifest: {
        schemaVersion: 1, epoch: '22222222-2222-4222-8222-222222222222',
        taskId: 'own-thread', familyRoot: 'own-family', home, cwd: home,
        cliPath: path.join(root, 'cli.exe'), cliSha256: '0'.repeat(64),
        initializeRequest: { clientInfo: {}, capabilities: {} }, resumeParams: {}, registryPath,
      }, keys: { fingerprintKey: '', intentKey: '', controlToken: '' }, privateDirectory }),
      observeProcess: () => { observed++; return { pid: process.pid, birthTicks: '1' }; },
      launch: () => { launched++; throw new Error('unexpected launch'); },
    },
  });
  await assert.rejects(daemon.start(), /startup unavailable/);
  assert.equal(daemon.metadata.state, 'failed');
  assert.equal(daemon.metadata.failure, 'startup-unavailable');
  assert.equal(observed, 0);
  assert.equal(launched, 0);
  const check = new ManagedWorkerRegistry(registryPath);
  try { assert.equal(check.get(home, 'own-family')?.epoch, actual.epoch); }
  finally { check.close(); }
});

test('policy worker refuses a retired or replaced bridge claim before host registration', async () => {
  for (const scenario of ['retired', 'replaced', 'revoked-after-first-read'] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-claim-'));
    const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
    await Promise.all([mkdir(home), mkdir(privateDirectory)]);
    const registryPath = path.join(root, 'registry.sqlite');
    const registry = new ManagedWorkerRegistry(registryPath);
    const reserved = registry.reserve(home, 'own-family'); registry.close();
    const taskId = randomUUID(), storePath = path.join(root, 'bridge.sqlite');
    const bridge = new BridgeStore(storePath);
    const binding = bridge.ensureBinding({ hostId: 'local', threadId: taskId,
      sourceId: 'daemon-claim-test', title: 'Claim test', workspace: root, updatedAt: 1 });
    const claim = bridge.claimManagedOwner(binding.id, { ownerEpoch: reserved.epoch,
      canonicalHome: reserved.canonicalHome, familyRoot: reserved.familyRoot });
    if (scenario === 'retired') {
      const pending = bridge.transitionManagedOwner(claim, 'handoff_pending');
      bridge.retireManagedOwner(pending);
    }
    bridge.close();
    const policy = approveTaskPolicy({ threadId: taskId, model: 'gpt-6-luna',
      modelProvider: 'openai', effort: 'low', cwd: home, runtimeWorkspaceRoots: [home],
      environments: [], approvalPolicy: 'never', approvalsReviewer: 'user',
      activePermissionProfile: { id: ':read-only', extends: null },
      sandbox: { type: 'readOnly', networkAccess: false }, serviceTier: null });
    let observed = 0, launched = 0, controls = 0;
    const daemon = new ManagedWorkerDaemon({
      baseDirectory: root, epoch: reserved.epoch,
      allowFollower: () => false, clientFactory: () => { throw new Error('unexpected IPC'); },
      verifyFamilyQuiescent: async () => false,
      dependencies: {
        loadPrivateState: async () => ({ manifest: {
          schemaVersion: 1, epoch: reserved.epoch, taskId, familyRoot: reserved.familyRoot,
          home, cwd: home, cliPath: path.join(root, 'cli.exe'), cliSha256: '0'.repeat(64),
          initializeRequest: { clientInfo: {}, capabilities: {} }, resumeParams: {}, registryPath,
          approvedTaskPolicy: policy, managedOwnerClaim: { storePath, bindingId: binding.id,
            claimId: scenario === 'replaced' ? randomUUID() : claim.id },
        }, keys: { fingerprintKey: '', intentKey: '', controlToken: '' }, privateDirectory }),
        observeProcess: () => {
          observed++;
          if (scenario === 'revoked-after-first-read') {
            const revoker = new BridgeStore(storePath);
            try {
              const pending = revoker.transitionManagedOwner(claim, 'handoff_pending');
              revoker.retireManagedOwner(pending);
            } finally { revoker.close(); }
          }
          return { pid: process.pid, birthTicks: '1' };
        },
        createControl: () => { controls++; throw new Error('unexpected control'); },
        launch: () => { launched++; throw new Error('unexpected launch'); },
      },
    });
    await assert.rejects(daemon.start(), /startup unavailable/);
    assert.equal(daemon.metadata.state, 'failed');
    assert.equal(observed, scenario === 'revoked-after-first-read' ? 1 : 0);
    assert.equal(controls, 0); assert.equal(launched, 0);
    const check = new ManagedWorkerRegistry(registryPath);
    try { assert.equal(check.get(home, 'own-family')?.state, 'reserved'); }
    finally { check.close(); }
  }
});

test('CLI pin mismatch is refused before launch and retains host registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vk-daemon-pin-'));
  const home = path.join(root, 'home'), privateDirectory = path.join(root, 'private');
  await Promise.all([mkdir(home), mkdir(privateDirectory)]);
  const cliPath = path.join(root, 'cli.exe'), registryPath = path.join(root, 'registry.sqlite');
  await writeFile(cliPath, 'qualified binary bytes');
  const registry = new ManagedWorkerRegistry(registryPath);
  const reserved = registry.reserve(home, 'own-family');
  registry.close();
  let launched = 0;
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: root, epoch: reserved.epoch,
    allowFollower: () => false, clientFactory: () => { throw new Error('unexpected IPC'); },
    verifyFamilyQuiescent: async () => false,
    dependencies: {
      loadPrivateState: async () => ({ manifest: {
        schemaVersion: 1, epoch: reserved.epoch, taskId: 'own-thread', familyRoot: 'own-family',
        home, cwd: home, cliPath,
        cliSha256: createHash('sha256').update('different bytes').digest('hex'),
        initializeRequest: { clientInfo: {}, capabilities: {} }, resumeParams: {}, registryPath,
      }, keys: { fingerprintKey: '', intentKey: '', controlToken: '' }, privateDirectory }),
      observeProcess: pid => ({ pid, birthTicks: '123' }),
      launch: () => { launched++; throw new Error('unexpected launch'); },
    },
  });
  await assert.rejects(daemon.start(), /startup unavailable/);
  assert.equal(launched, 0);
  const check = new ManagedWorkerRegistry(registryPath);
  try {
    const row = check.get(home, 'own-family');
    assert.equal(row?.state, 'host_registered');
    assert.deepEqual(row?.host, { pid: process.pid, birthTicks: '123' });
  } finally { check.close(); }
});
