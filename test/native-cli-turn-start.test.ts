import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareNativeCliTurnStart } from '../src/codex/native-cli-turn-start.js';
import { prepareNativeFirstTurnBootstrapCommand, NATIVE_FIRST_TURN_TEXT_MAX_BYTES } from
  '../src/desktop/native-first-turn-input-fingerprint.js';
import { NativeFirstTurnBootstrapJournal } from '../src/desktop/native-first-turn-bootstrap-journal.js';
import { reserveNativeFirstTurnWithKey } from
  '../src/desktop/native-first-turn-bootstrap-preparation.js';
import { dispatchPreparedNativeFirstTurnForOfflineTest } from
  './support/native-first-turn-dispatch-harness.js';
import { ManagedNativeCliStartAdmission, NativeCliStartNotSubmittedError } from
  '../src/codex/managed-native-cli-start-admission.js';
import { readNativeCliIdleEvidence } from '../src/codex/managed-native-cli-source-reader.js';
import { qualifyNativeCliResumePolicy } from '../src/codex/native-cli-resume-policy.js';
import { ManagedNativeCliSourceQualifier } from '../src/codex/managed-native-cli-source-qualifier.js';
import type { ManagedWorkerNotification, ManagedWorkerPendingRequest, WorkerObserverFailure } from
  '../src/codex/managed-worker-frontend-host.js';

const taskId = '01a0eb7e-bec3-7a93-9641-8c4fb5f15d6a';
const ownerEpoch = 'f2945262-91bd-42ed-ac48-77dbca48a138';
const clientId = '76c8caee-85da-4125-8bb6-7b602239783a';
const settings = {
  cwd: 'D:\\GitStorageG\\VKodex', runtimeWorkspaceRoots: ['D:\\GitStorageG\\VKodex'],
  approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':read-only',
  sandboxPolicy: { type: 'readOnly', networkAccess: false }, model: 'gpt-5.6-sol', serviceTier: 'default',
  effort: 'low', summary: null, collaborationMode: { mode: 'default', settings: {
    model: 'gpt-5.6-sol', reasoning_effort: 'low', developer_instructions: null } },
  personality: null,
};
function start(overrides: Record<string, unknown> = {}) {
  return { threadId: taskId, clientUserMessageId: clientId,
    input: [{ type: 'text', text: 'isolated test' }], turnTrigger: null,
    toolOutput: null, responsesapiClientMetadata: null, additionalContext: null,
    environments: null, cwd: settings.cwd,
    runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots,
    approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
    sandboxPolicy: null, permissions: settings.permissions, model: settings.model,
    serviceTier: settings.serviceTier, serviceTierForTurn: null, effort: settings.effort,
    summary: null, personality: null, outputSchema: null,
    collaborationMode: settings.collaborationMode, multiAgentMode: null,
    cyberAccessProgram: null, ...overrides };
}
function resumeResult() {
  return { thread: { id: taskId, status: { type: 'idle' }, turns: [],
    model: settings.model, reasoningEffort: settings.effort, cwd: settings.cwd,
    environments: [{ environmentId: 'local', cwd: settings.cwd,
      runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots }] },
  model: settings.model, reasoningEffort: settings.effort, serviceTier: settings.serviceTier,
  cwd: settings.cwd, runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots,
  approvalPolicy: 'never', approvalsReviewer: 'user',
  sandbox: { type: 'readOnly', networkAccess: false },
  activePermissionProfile: { id: ':read-only', extends: null } };
}

test('native CLI read-only start compiles exact scope with stable operation identity', () => {
  assert.equal(Object.keys(start()).length, 24);
  assert.match(ownerEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  const first = prepareNativeCliTurnStart(start(), { taskId, ownerEpoch, effectiveSettings: settings });
  const second = prepareNativeCliTurnStart(start(), { taskId, ownerEpoch, effectiveSettings: settings });
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.method, 'turn/start');
  assert.deepEqual(first.params, start());
  assert.equal(first.params.clientUserMessageId, clientId);
  assert.notEqual(first.operationId, clientId);
  assert.notEqual(prepareNativeCliTurnStart(start({ clientUserMessageId:
    '76c8caee-85da-4125-8bb6-7b602239783b' }),
  { taskId, ownerEpoch, effectiveSettings: settings }).operationId, first.operationId);
  // A changed body under the same client ID keeps its journal key; the
  // command dispatcher must then reject the conflicting fingerprint.
  assert.equal(prepareNativeCliTurnStart(start({ input: [{ type: 'text', text: 'different' }] }),
    { taskId, ownerEpoch, effectiveSettings: settings }).operationId, first.operationId);
});

test('first-turn bootstrap command applies its recoverable text bound before journal reservation', () => {
  const identity = { operationId: 'b857db38-8ad4-4b6c-83cc-2ba63b6aef61',
    sourceId: 'profile-a', sourceGeneration: '3818c7d2-4c41-4e93-a310-0fbfcfbe5d55',
    ownerEpoch, threadStartFingerprint: 'c'.repeat(64), backendIdentity: 'b'.repeat(64),
    threadId: taskId, clientUserMessageId: clientId, fingerprintKey: Buffer.alloc(32, 7) };
  const good = prepareNativeFirstTurnBootstrapCommand(start({ input: [{ type: 'text',
    text: 'a'.repeat(NATIVE_FIRST_TURN_TEXT_MAX_BYTES) }] }),
  { taskId, ownerEpoch, effectiveSettings: settings }, identity);
  assert.equal(good.command.method, 'turn/start');
  assert.match(good.keyedFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(good.command), true);
  assert.equal(Object.isFrozen(good.command.params), true);
  assert.equal(Object.isFrozen(good.command.params.input), true);
  assert.equal(Object.isFrozen((good.command.params.input as unknown[])[0]), true);
  assert.throws(() => {
    ((good.command.params.input as { text: string }[])[0]!).text = 'changed after fingerprint';
  }, TypeError);
  assert.throws(() => prepareNativeFirstTurnBootstrapCommand(start({ input: [{ type: 'text',
    text: 'a'.repeat(NATIVE_FIRST_TURN_TEXT_MAX_BYTES + 1) }] }),
  { taskId, ownerEpoch, effectiveSettings: settings }, identity), /first-turn input/u);
});

test('first-turn preparation reserves one durable fingerprint before any native dispatch', () => {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')),
    'journal.sqlite');
  const journal = new NativeFirstTurnBootstrapJournal(filePath);
  const identity = { operationId: randomUUID(), sourceId: 'profile-a',
    sourceGeneration: randomUUID(), ownerEpoch,
    threadStartFingerprint: 'c'.repeat(64), backendIdentity: 'b'.repeat(64) };
  const cliScope = { taskId, ownerEpoch, effectiveSettings: settings };
  const key = Buffer.alloc(32, 7);
  try {
    journal.persistThreadStartIntent(identity);
    assert.equal(journal.directory(), path.dirname(filePath));
    journal.persistThreadAccepted({ operationId: identity.operationId,
      expectedRevision: 1, threadId: taskId });
    assert.throws(() => reserveNativeFirstTurnWithKey(journal, { ...identity,
      backendIdentity: 'd'.repeat(64) }, start(), cliScope, key), /unqualified/u);
    assert.throws(() => reserveNativeFirstTurnWithKey(journal, identity,
      start({ input: [{ type: 'text', text: 'a'.repeat(8193) }] }), cliScope, key), /first-turn input/u);
    assert.equal(journal.get(identity.operationId)?.state, 'thread-accepted');
    const result = reserveNativeFirstTurnWithKey(journal, identity, start(), cliScope, key);
    assert.equal(result.revision, 3);
    assert.equal(result.command.method, 'turn/start');
    assert.equal(Object.isFrozen(result.command.params), true);
    assert.equal(journal.get(identity.operationId)?.keyedFingerprint, result.keyedFingerprint);
    assert.equal(journal.get(identity.operationId)?.clientUserMessageId, clientId);
    assert.equal(JSON.stringify(journal.get(identity.operationId)).includes('isolated test'), false);
    assert.throws(() => reserveNativeFirstTurnWithKey(journal, identity, start(), cliScope, key), /unqualified/u);
    assert.equal(journal.get(identity.operationId)?.revision, 3);
  } finally { journal.close(); key.fill(0); }
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${filePath}${suffix}`;
    if (existsSync(candidate))
      assert.equal(readFileSync(candidate).includes(Buffer.from('isolated test')), false);
  }
  const reopened = new NativeFirstTurnBootstrapJournal(filePath);
  try {
    assert.equal(reopened.get(identity.operationId)?.state, 'turn-reserved');
    assert.throws(() => reserveNativeFirstTurnWithKey(reopened, identity, start(), cliScope,
      Buffer.alloc(32, 7)), /unqualified/u);
  } finally { reopened.close(); }
});

function firstTurnDispatchFixture() {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-first-turn-')), 'journal.sqlite');
  const journal = new NativeFirstTurnBootstrapJournal(filePath);
  const identity = { operationId: randomUUID(), sourceId: 'profile-a',
    sourceGeneration: randomUUID(), ownerEpoch,
    threadStartFingerprint: 'c'.repeat(64), backendIdentity: 'b'.repeat(64) };
  journal.persistThreadStartIntent(identity);
  journal.persistThreadAccepted({ operationId: identity.operationId,
    expectedRevision: 1, threadId: taskId });
  const prepared = reserveNativeFirstTurnWithKey(journal, identity, start(),
    { taskId, ownerEpoch, effectiveSettings: settings }, Buffer.alloc(32, 7));
  return { journal, filePath, prepared };
}

test('first-turn dispatch records only a positive native ACK and sends once', async () => {
  const { journal, prepared } = firstTurnDispatchFixture();
  const turnId = '01a0f511-86e7-7942-8067-91d169eb18c7';
  let writes = 0;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(method: string, params: Record<string, unknown>, options: {
      mutating?: boolean; expectedGeneration?: number; assertBeforeWrite?: () => void;
      onResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }) {
      writes++;
      assert.equal(method, 'turn/start'); assert.equal(params.threadId, taskId);
      assert.equal(options.mutating, true); assert.equal(options.expectedGeneration, 5);
      options.assertBeforeWrite?.();
      options.onResponseEnvelope?.({ result: { turn: { id: turnId, status: 'inProgress' } } });
      return { turn: { id: turnId, status: 'inProgress' } };
    } };
  try {
    const result = await dispatchPreparedNativeFirstTurnForOfflineTest(journal, prepared, rpc, () => true);
    assert.equal(result.state, 'turn-accepted'); assert.equal(result.turnId, turnId);
    assert.equal(writes, 1);
    await assert.rejects(dispatchPreparedNativeFirstTurnForOfflineTest(journal, prepared, rpc, () => true), /unqualified/u);
    assert.equal(writes, 1);
  } finally { journal.close(); }
});

test('first-turn timeout stays unknown; late positive ACK may reconcile without replay', async () => {
  const { journal, filePath, prepared } = firstTurnDispatchFixture();
  const turnId = '01a0f511-86e7-7942-8067-91d169eb18c7';
  let writes = 0;
  let late: ((value: { result: Record<string, unknown> }) => void) | undefined;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(_method: string, _params: Record<string, unknown>, options: {
      assertBeforeWrite?: () => void;
      onLateResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }): Promise<unknown> {
      writes++; options.assertBeforeWrite?.(); late = options.onLateResponseEnvelope;
      throw new Error('timeout');
    } };
  try {
    const result = await dispatchPreparedNativeFirstTurnForOfflineTest(journal, prepared, rpc, () => true);
    assert.equal(result.state, 'turn-unknown'); assert.equal(writes, 1);
  } finally { journal.close(); }
  late?.({ result: { turn: { id: turnId, status: 'inProgress' } } });
  const reopened = new NativeFirstTurnBootstrapJournal(filePath);
  try {
    assert.equal(reopened.get(prepared.operationId)?.state, 'turn-accepted');
    assert.equal(reopened.get(prepared.operationId)?.revision, 5);
    assert.equal(writes, 1);
  } finally { reopened.close(); }
});

test('first-turn prewrite authority refusal and malformed ACK never create acceptance', async () => {
  const { journal, prepared } = firstTurnDispatchFixture();
  let writes = 0;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(_method: string, _params: Record<string, unknown>, options: {
      assertBeforeWrite?: () => void;
      onResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }) { options.assertBeforeWrite?.(); writes++;
      options.onResponseEnvelope?.({ result: { turn: { id: 'wrong', status: 'inProgress' } } });
      return { turn: { id: 'wrong', status: 'inProgress' } }; } };
  try {
    const result = await dispatchPreparedNativeFirstTurnForOfflineTest(journal, prepared, rpc, () => true);
    assert.equal(result.state, 'turn-unknown'); assert.equal(writes, 1);
  } finally { journal.close(); }
  const refused = firstTurnDispatchFixture();
  try {
    const result = await dispatchPreparedNativeFirstTurnForOfflineTest(refused.journal, refused.prepared,
      rpc, () => false);
    assert.equal(result.state, 'turn-unknown'); assert.equal(writes, 1);
  } finally { refused.journal.close(); }
});

test('first-turn ACK before the final write fence cannot claim a refused write', async () => {
  const { journal, prepared } = firstTurnDispatchFixture();
  const turnId = '01a0f511-86e7-7942-8067-91d169eb18c7';
  let authorized = true, writes = 0;
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(_method: string, _params: Record<string, unknown>, options: {
      assertBeforeWrite?: () => void;
      onResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }) {
      options.onResponseEnvelope?.({ result: { turn: { id: turnId, status: 'inProgress' } } });
      authorized = false;
      options.assertBeforeWrite?.();
      writes++;
      return { turn: { id: turnId, status: 'inProgress' } };
    } };
  try {
    const result = await dispatchPreparedNativeFirstTurnForOfflineTest(journal, prepared, rpc, () => authorized);
    assert.equal(result.state, 'turn-unknown'); assert.equal(result.turnId, null);
    assert.equal(writes, 0);
  } finally { journal.close(); }
});

test('first-turn positive ACK survives closing the initiating journal during the RPC', async () => {
  const { journal, filePath, prepared } = firstTurnDispatchFixture();
  const turnId = '01a0f511-86e7-7942-8067-91d169eb18c7';
  const rpc = { async initializedSession() { return { generation: 5 }; },
    isSessionCurrent: (generation: number) => generation === 5,
    async request(_method: string, _params: Record<string, unknown>, options: {
      assertBeforeWrite?: () => void;
      onResponseEnvelope?: (value: { result: Record<string, unknown> }) => void;
    }) {
      options.assertBeforeWrite?.(); journal.close();
      options.onResponseEnvelope?.({ result: { turn: { id: turnId, status: 'inProgress' } } });
      return { turn: { id: turnId, status: 'inProgress' } };
    } };
  const result = await dispatchPreparedNativeFirstTurnForOfflineTest(journal, prepared, rpc, () => true);
  assert.equal(result.state, 'turn-accepted');
  const reopened = new NativeFirstTurnBootstrapJournal(filePath);
  try { assert.equal(reopened.get(prepared.operationId)?.turnId, turnId); }
  finally { reopened.close(); }
});

test('native CLI start rejects source, settings, context, and input drift', () => {
  for (const request of [
    start({ threadId: 'other' }), start({ model: 'gpt-6-astra' }),
    start({ cwd: 'D:\\GitStorageG\\other' }), start({ permissions: ':danger-full-access' }),
    start({ approvalPolicy: 'on-request' }), start({ sandboxPolicy: { type: 'dangerFullAccess' } }),
    start({ responsesapiClientMetadata: { opaque: true } }),
    start({ additionalContext: { developerInstructions: 'ignored' } }),
    start({ input: [{ type: 'image', url: 'local' }] }),
    start({ input: [{ type: 'text', text: ' ' }] }),
    start({ input: [{ type: 'text', text: 'isolated test', text_elements: ['unsupported'] }] }),
    start({ collaborationMode: { mode: 'plan', settings: settings.collaborationMode.settings } }),
    start({ collaborationMode: { mode: 'default', settings: {
      ...settings.collaborationMode.settings, developer_instructions: 'unapproved' } } }),
    start({ extra: true }),
  ]) assert.throws(() => prepareNativeCliTurnStart(request,
    { taskId, ownerEpoch, effectiveSettings: settings }));
  assert.throws(() => prepareNativeCliTurnStart(start(), { taskId, ownerEpoch,
    effectiveSettings: { ...settings, permissions: ':danger-full-access' } }));
  assert.throws(() => prepareNativeCliTurnStart(start(), { taskId, ownerEpoch,
    effectiveSettings: { ...settings, sandboxPolicy: { type: 'readOnly', networkAccess: true } } }));
});

test('CLI admission rechecks same-worker queue proof before durable host write', async () => {
  const controlKey = {}; let current = true; let writes = 0;
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    commandQuiescence(key: object) { assert.equal(key, controlKey);
      return { inFlight: 0, unconfirmed: false }; },
    async executeCommandWithResponse(key: object, command: ReturnType<typeof prepareNativeCliTurnStart>,
      beforeWrite?: () => void) {
      assert.equal(key, controlKey);
      beforeWrite?.(); writes++;
      return { operation: { ownerEpoch, backendGeneration: 7, threadId: taskId,
        operationId: command.operationId, clientUserMessageId: clientId,
        method: 'turn/start' as const, fingerprint: 'a'.repeat(64), revision: 1,
        state: 'accepted' as const, receiptId: 'native-turn', rejectionCode: null },
      response: { turn: { id: 'native-turn' } } };
    } };
  const admission = new ManagedNativeCliStartAdmission({ taskId, ownerEpoch,
    controlKey, qualify: async resume => {
      assert.deepEqual(resume, qualifyNativeCliResumePolicy(resumeResult(), taskId));
      return { taskId, ownerEpoch,
        backendGeneration: 7, semanticRevision: 4, effectiveSettings: settings,
        idle: true as const, nativeQueueEmpty: true as const,
        noPendingAutoStart: true as const,
        assertCurrent: () => { if (!current) throw new Error('stale'); },
      };
    } });
  admission.bindHost(host, taskId, { ownerEpoch, controlKey });
  assert.throws(() => admission.bindHost(host, taskId, { ownerEpoch, controlKey }), /mismatch/);
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }),
    NativeCliStartNotSubmittedError);
  assert.equal(writes, 0);
  admission.recordResume(host, 7, resumeResult());
  const accepted = await admission.run({ taskId, generation: 7, params: start() });
  assert.equal(accepted.operation.receiptId, 'native-turn');
  assert.equal(writes, 1);
  current = false;
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }),
    NativeCliStartNotSubmittedError);
  assert.equal(writes, 1);
  current = true; host.metadata.backendGeneration = 8;
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }),
    NativeCliStartNotSubmittedError);
  assert.equal(writes, 1);
});

test('CLI admission refuses an occupied queue and unsettled command ledger', async () => {
  const controlKey = {}; let writes = 0; let queued = true; let unsettled = false;
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    commandQuiescence: () => ({ inFlight: 0, unconfirmed: unsettled }),
    executeCommandWithResponse: async () => { writes++; throw new Error('should not write'); } };
  const admission = new ManagedNativeCliStartAdmission({ taskId, ownerEpoch,
    controlKey, qualify: async () => ({ taskId, ownerEpoch,
      backendGeneration: 7, semanticRevision: 4, effectiveSettings: settings,
      idle: true as const, nativeQueueEmpty: !queued as true,
      noPendingAutoStart: true as const, assertCurrent: () => {},
    }) });
  admission.bindHost(host, taskId, { ownerEpoch, controlKey });
  admission.recordResume(host, 7, resumeResult());
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }),
    NativeCliStartNotSubmittedError);
  queued = false; unsettled = true;
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }),
    NativeCliStartNotSubmittedError);
  assert.equal(writes, 0);
});

test('single-start CLI canary refuses a second distinct accepted turn', async () => {
  const controlKey = {}; let writes = 0;
  const accepted: Array<{ method: 'turn/start'; receiptId: string }> = [];
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    commandQuiescence: () => ({ inFlight: 0, unconfirmed: false }),
    acceptedCommandReceipts: (key: object) => { assert.equal(key, controlKey); return accepted; },
    async executeCommandWithResponse(_key: object, command: ReturnType<typeof prepareNativeCliTurnStart>,
      beforeWrite?: () => void) {
      beforeWrite?.(); writes++;
      accepted.push({ method: 'turn/start', receiptId: `native-${writes}` });
      return { operation: { ownerEpoch, backendGeneration: 7, threadId: taskId,
        operationId: command.operationId, clientUserMessageId: command.params.clientUserMessageId as string,
        method: 'turn/start' as const, fingerprint: 'a'.repeat(64), revision: writes,
        state: 'accepted' as const, receiptId: `native-${writes}`, rejectionCode: null },
      response: { turn: { id: `native-${writes}` } } };
    } };
  const admission = new ManagedNativeCliStartAdmission({ taskId, ownerEpoch, controlKey,
    singleAcceptedStart: true,
    qualify: async () => ({ taskId, ownerEpoch, backendGeneration: 7,
      semanticRevision: 4, effectiveSettings: settings, idle: true,
      nativeQueueEmpty: true, noPendingAutoStart: true, assertCurrent: () => {},
    }) });
  admission.bindHost(host, taskId, { ownerEpoch, controlKey });
  admission.recordResume(host, 7, resumeResult());
  await admission.run({ taskId, generation: 7, params: start() });
  await assert.rejects(admission.run({ taskId, generation: 7, params: start({
    clientUserMessageId: '76c8caee-85da-4125-8bb6-7b602239783b',
  }) }), NativeCliStartNotSubmittedError);
  assert.equal(writes, 1);
});

test('CLI admission invalidates an in-flight proof when native resume changes', async () => {
  const controlKey = {}; let release!: () => void; let writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    commandQuiescence: () => ({ inFlight: 0, unconfirmed: false }),
    executeCommandWithResponse: async () => { writes++; throw new Error('unexpected write'); } };
  const admission = new ManagedNativeCliStartAdmission({ taskId, ownerEpoch, controlKey,
    qualify: async () => { await gate; return { taskId, ownerEpoch,
      backendGeneration: 7, semanticRevision: 1, effectiveSettings: settings,
      idle: true as const, nativeQueueEmpty: true as const,
      noPendingAutoStart: true as const, assertCurrent: () => {},
    }; } });
  admission.bindHost(host, taskId, { ownerEpoch, controlKey });
  admission.recordResume(host, 7, resumeResult());
  const pending = admission.run({ taskId, generation: 7, params: start() });
  admission.recordResume(host, 7, resumeResult());
  release();
  await assert.rejects(pending, NativeCliStartNotSubmittedError);
  assert.equal(writes, 0);
  admission.recordResume(host, 7, { bad: true });
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }),
    NativeCliStartNotSubmittedError);
});

test('CLI admission rejects a proof whose permissions differ from native resume', async () => {
  const controlKey = {}; let writes = 0;
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    commandQuiescence: () => ({ inFlight: 0, unconfirmed: false }),
    executeCommandWithResponse: async () => { writes++; throw new Error('unexpected write'); } };
  const admission = new ManagedNativeCliStartAdmission({ taskId, ownerEpoch, controlKey,
    qualify: async () => ({ taskId, ownerEpoch, backendGeneration: 7,
      semanticRevision: 2, effectiveSettings: { ...settings, serviceTier: null },
      idle: true, nativeQueueEmpty: true, noPendingAutoStart: true,
      assertCurrent: () => {},
    }) });
  admission.bindHost(host, taskId, { ownerEpoch, controlKey });
  admission.recordResume(host, 7, resumeResult());
  await assert.rejects(admission.run({ taskId, generation: 7,
    params: start({ serviceTier: null }) }), NativeCliStartNotSubmittedError);
  assert.equal(writes, 0);
});

test('CLI admission never labels a dispatcher failure as not submitted', async () => {
  const controlKey = {}; let dispatches = 0;
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    commandQuiescence: () => ({ inFlight: 0, unconfirmed: false }),
    executeCommandWithResponse: async () => {
      dispatches++;
      throw new NativeCliStartNotSubmittedError();
    } };
  const admission = new ManagedNativeCliStartAdmission({ taskId, ownerEpoch,
    controlKey, qualify: async () => ({ taskId, ownerEpoch, backendGeneration: 7,
      semanticRevision: 1, effectiveSettings: settings, idle: true,
      nativeQueueEmpty: true, noPendingAutoStart: true, assertCurrent: () => {} }) });
  admission.bindHost(host, taskId, { ownerEpoch, controlKey });
  admission.recordResume(host, 7, resumeResult());
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }),
    error => error instanceof Error &&
      !(error instanceof NativeCliStartNotSubmittedError) &&
      /outcome unknown/u.test(error.message));
  assert.equal(dispatches, 1);
});

test('CLI source reader requires stable terminal history, empty native queue and null goal', async () => {
  const turn = { id: 'prior', status: 'completed', itemsView: 'full', items: [] };
  const thread = { id: taskId, status: { type: 'idle' }, turns: [
    { id: 'prior', status: 'completed' }], model: settings.model,
  reasoningEffort: settings.effort, cwd: settings.cwd, updatedAt: 5 };
  const calls: string[] = [];
  let queued = false, changed = false;
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    async ownerRead(key: object, generation: number, method: string, params: Record<string, unknown>) {
      assert.equal(key, keyObject); assert.equal(generation, 7);
      assert.equal(params.threadId, taskId);
      calls.push(method);
      if (method === 'thread/read') return { thread: changed ? { ...thread, updatedAt: 6 } : thread };
      if (method === 'thread/turns/list') return { data: [turn], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/queue/list') return { data: queued ? [{ id: 'pending' }] : [], nextCursor: null };
      throw new Error('unexpected method');
    } };
  const keyObject = {};
  const options = { host, controlKey: keyObject, taskId, generation: 7,
    expectedCwd: settings.cwd, expectedModel: settings.model,
    expectedEffort: settings.effort, assertCurrent: () => {} };
  const evidence = await readNativeCliIdleEvidence(options);
  assert.equal(evidence.turnCount, 1);
  assert.deepEqual(evidence.terminalTurnIds, ['prior']);
  assert.match(evidence.historyDigest, /^[a-f0-9]{64}$/u);
  assert.equal(calls.filter(method => method === 'thread/read').length, 2);
  queued = true;
  await assert.rejects(readNativeCliIdleEvidence(options), /queue/i);
  queued = false;
  let reads = 0;
  const drift = { ...host, ownerRead: async (key: object, generation: number, method: string,
    params: Record<string, unknown>) => {
    if (method === 'thread/read' && ++reads === 2) changed = true;
    return host.ownerRead(key, generation, method, params);
  } };
  await assert.rejects(readNativeCliIdleEvidence({ ...options, host: drift }), /unstable/i);
});

test('native resume supplies the exact read-only policy tuple, not optional composer defaults', () => {
  const resume = resumeResult();
  const qualified = qualifyNativeCliResumePolicy(resume, taskId);
  assert.deepEqual(qualified, { cwd: settings.cwd,
    runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots,
    model: settings.model, effort: settings.effort,
    serviceTier: settings.serviceTier, approvalPolicy: 'never',
    approvalsReviewer: 'user', permissions: ':read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  for (const value of [
    { ...resume, approvalPolicy: 'on-request' },
    { ...resume, sandbox: { type: 'readOnly', networkAccess: true } },
    { ...resume, activePermissionProfile: { id: ':danger-full-access' } },
    { ...resume, thread: { ...resume.thread, model: 'different' } },
    { ...resume, runtimeWorkspaceRoots: ['foreign'] },
  ]) assert.throws(() => qualifyNativeCliResumePolicy(value, taskId));
});

test('CLI source qualifier fences live worker changes around complete idle reads', async () => {
  const controlKey = {}, adapterKey = {};
  let notify: ((event: ManagedWorkerNotification) => void) | null = null;
  let failObserver: ((reason: WorkerObserverFailure) => void) | null = null;
  let ownerCurrent = true, sourceCurrent = true, noPendingAutoStart = false, unresolved = 0;
  let inFlight = 0, unconfirmed = false;
  let acceptedQueue = false, acceptedReceipt = false, terminalReceipt = false,
    notificationsDuringRead = 0;
  const thread = { ...resumeResult().thread, updatedAt: 5 };
  const priorTurn = { id: 'completed-prior', status: 'completed', items: [] };
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    observeNotifications(key: object, listener: (event: ManagedWorkerNotification) => void,
      onFailure: (reason: WorkerObserverFailure) => void) {
      assert.equal(key, adapterKey); notify = listener; failObserver = onFailure;
      return () => { notify = null; failObserver = null; };
    },
    observePendingRequests(key: object, _listener: (event: ManagedWorkerPendingRequest) => void) {
      assert.equal(key, adapterKey); return () => {};
    },
    async ownerRead(key: object, generation: number, method: string) {
      assert.equal(key, controlKey); assert.equal(generation, 7);
      if (method === 'thread/read') {
        if (notificationsDuringRead > 0) {
          notificationsDuringRead--;
          notify?.({ taskId, generation: 7,
            notification: { method: 'thread/settings/updated', params: { threadId: taskId } } });
        }
        return { thread: terminalReceipt ? { ...thread, updatedAt: 6,
          turns: [priorTurn] } : thread };
      }
      if (method === 'thread/turns/list') return { data: terminalReceipt ?
        [{ ...priorTurn, itemsView: 'full' }] : [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/queue/list') return { data: [], nextCursor: null };
      throw new Error('unexpected read');
    },
    commandQuiescence: () => ({ inFlight, unconfirmed }),
    requestQuiescence: () => ({ generation: 7, unresolved }),
    acceptedCommandReceipts: () => acceptedReceipt ?
      [{ method: 'turn/start' as const, receiptId: terminalReceipt ?
        priorTurn.id : 'not-terminal' }] : [],
    acceptedQueueInputs: () => acceptedQueue ?
      [{ clientUserMessageId: clientId, submissionId: 'queued' }] : [],
  };
  const qualifier = new ManagedNativeCliSourceQualifier({ host, taskId, ownerEpoch,
    adapterKey, controlKey, assertOwnerCurrent: () => ownerCurrent,
    assertSourceCurrent: () => { if (!sourceCurrent) throw new Error('source replaced'); },
    noPendingAutoStart: () => noPendingAutoStart });
  qualifier.start();
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /auto|pending/i, 'a busy scheduler must not prevent a read-only observer from starting');
  noPendingAutoStart = true;
  const proof = await qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId));
  assert.equal(proof.idle, true);
  assert.equal(proof.nativeQueueEmpty, true);
  assert.equal(proof.effectiveSettings.permissions, ':read-only');
  assert.deepEqual(proof.effectiveSettings.collaborationMode, settings.collaborationMode);
  proof.assertCurrent();
  sourceCurrent = false;
  assert.throws(() => proof.assertCurrent(), /source replaced/u);
  sourceCurrent = true;
  inFlight = 1;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /ledger/i);
  inFlight = 0; unconfirmed = true;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /ledger/i);
  unconfirmed = false; acceptedQueue = true;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /queue/i);
  acceptedQueue = false; acceptedReceipt = true;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /history|incomplete/i);
  terminalReceipt = true;
  const repeat = await qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId));
  repeat.assertCurrent();
  acceptedReceipt = false;
  terminalReceipt = false;
  unresolved = 1;
  assert.throws(proof.assertCurrent, /pending|request/i);
  unresolved = 0; noPendingAutoStart = false;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /auto|pending/i);
  noPendingAutoStart = true;
  notificationsDuringRead = 1;
  const settled = await qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId));
  settled.assertCurrent();
  notificationsDuringRead = Number.POSITIVE_INFINITY;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /revision|changed/i);
  notificationsDuringRead = 0;
  (notify as ((event: ManagedWorkerNotification) => void) | null)?.({ taskId, generation: 7,
    notification: { method: 'thread/settings/updated', params: { threadId: taskId } } });
  assert.throws(proof.assertCurrent, /revision|changed/i);
  ownerCurrent = false;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)));
  ownerCurrent = true;
  (failObserver as ((reason: WorkerObserverFailure) => void) | null)?.('backend-lost');
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /observer/i);
  qualifier.close();
});
