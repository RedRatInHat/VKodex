import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeCliTurnStart } from '../src/codex/native-cli-turn-start.js';
import { ManagedNativeCliStartAdmission } from '../src/codex/managed-native-cli-start-admission.js';
import { readNativeCliIdleEvidence } from '../src/codex/managed-native-cli-source-reader.js';
import { qualifyNativeCliResumePolicy } from '../src/codex/native-cli-resume-policy.js';
import { ManagedNativeCliSourceQualifier } from '../src/codex/managed-native-cli-source-qualifier.js';
import type { ManagedWorkerNotification, ManagedWorkerPendingRequest } from
  '../src/codex/managed-worker-frontend-host.js';

const taskId = '01a0eb7e-bec3-7a93-9641-8c4fb5f15d6a';
const ownerEpoch = 'f2945262-91bd-42ed-ac48-77dbca48a138';
const clientId = '76c8caee-85da-4125-8bb6-7b602239783a';
const settings = {
  cwd: 'D:\\GitStorageG\\VKodex', runtimeWorkspaceRoots: ['D:\\GitStorageG\\VKodex'],
  approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':read-only',
  sandboxPolicy: { type: 'readOnly', networkAccess: false }, model: 'gpt-5.6-sol', serviceTier: 'default',
  effort: 'low', summary: null, collaborationMode: { mode: 'default', settings: null },
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
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }), /resume/i);
  admission.recordResume(host, 7, resumeResult());
  const accepted = await admission.run({ taskId, generation: 7, params: start() });
  assert.equal(accepted.operation.receiptId, 'native-turn');
  assert.equal(writes, 1);
  current = false;
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }), /stale/);
  assert.equal(writes, 1);
  current = true; host.metadata.backendGeneration = 8;
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }), /generation/);
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
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }), /proof/);
  queued = false; unsettled = true;
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }), /unsettled/);
  assert.equal(writes, 0);
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
  await assert.rejects(pending, /resume evidence changed/i);
  assert.equal(writes, 0);
  admission.recordResume(host, 7, { bad: true });
  await assert.rejects(admission.run({ taskId, generation: 7, params: start() }), /resume evidence unavailable/i);
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
    params: start({ serviceTier: null }) }), /resume and current settings disagree/i);
  assert.equal(writes, 0);
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
  let ownerCurrent = true, noPendingAutoStart = true, unresolved = 0;
  let inFlight = 0, unconfirmed = false;
  let acceptedQueue = false, acceptedReceipt = false, notifyDuringRead = false;
  const thread = { ...resumeResult().thread, updatedAt: 5 };
  const host = { metadata: { taskId, state: 'running', backendGeneration: 7 },
    observeNotifications(key: object, listener: (event: ManagedWorkerNotification) => void) {
      assert.equal(key, adapterKey); notify = listener; return () => { notify = null; };
    },
    observePendingRequests(key: object, _listener: (event: ManagedWorkerPendingRequest) => void) {
      assert.equal(key, adapterKey); return () => {};
    },
    async ownerRead(key: object, generation: number, method: string) {
      assert.equal(key, controlKey); assert.equal(generation, 7);
      if (method === 'thread/read') {
        if (notifyDuringRead) {
          notify?.({ taskId, generation: 7,
            notification: { method: 'thread/settings/updated', params: { threadId: taskId } } });
        }
        return { thread };
      }
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/queue/list') return { data: [], nextCursor: null };
      throw new Error('unexpected read');
    },
    commandQuiescence: () => ({ inFlight, unconfirmed }),
    requestQuiescence: () => ({ generation: 7, unresolved }),
    acceptedCommandReceipts: () => acceptedReceipt ?
      [{ method: 'turn/start' as const, receiptId: 'not-terminal' }] : [],
    acceptedQueueInputs: () => acceptedQueue ?
      [{ clientUserMessageId: clientId, submissionId: 'queued' }] : [],
  };
  const qualifier = new ManagedNativeCliSourceQualifier({ host, taskId, ownerEpoch,
    adapterKey, controlKey, assertOwnerCurrent: () => ownerCurrent,
    noPendingAutoStart: () => noPendingAutoStart });
  qualifier.start();
  const proof = await qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId));
  assert.equal(proof.idle, true);
  assert.equal(proof.nativeQueueEmpty, true);
  assert.equal(proof.effectiveSettings.permissions, ':read-only');
  proof.assertCurrent();
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
  acceptedReceipt = false;
  unresolved = 1;
  assert.throws(proof.assertCurrent, /pending|request/i);
  unresolved = 0; noPendingAutoStart = false;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /auto|pending/i);
  noPendingAutoStart = true;
  notifyDuringRead = true;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)),
    /revision|changed/i);
  notifyDuringRead = false;
  (notify as ((event: ManagedWorkerNotification) => void) | null)?.({ taskId, generation: 7,
    notification: { method: 'thread/settings/updated', params: { threadId: taskId } } });
  assert.throws(proof.assertCurrent, /revision|changed/i);
  ownerCurrent = false;
  await assert.rejects(qualifier.qualify(qualifyNativeCliResumePolicy(resumeResult(), taskId)));
  qualifier.close();
});
