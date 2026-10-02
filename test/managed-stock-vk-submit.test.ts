import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import { ActionRejectedError } from '../src/core/codex-tasks.js';
import { ManagedWorkerIdleProofRefusedError } from '../src/desktop/managed-worker-bootstrap.js';
import { managedStockCommandId } from '../src/desktop/managed-native-stock-queue-adapter.js';
import { ManagedStockVkSubmitter, managedVkStockCommandId } from '../src/desktop/managed-stock-vk-submit.js';
import type { WorkerCommand } from '../src/codex/managed-worker-command-dispatcher.js';
import type { WorkerOperation } from '../src/codex/managed-worker-operation-journal.js';
import type { ManagedNativeStockQueueAuthority } from '../src/desktop/managed-worker-native-owner.js';
import type { StockReadState } from '../src/desktop/managed-worker-bootstrap.js';

function qualifiedAdmissionFixture() {
  const taskId = randomUUID(), epoch = randomUUID(), capability = {};
  const request = { operationId: randomUUID(), task: { hostId: 'local', threadId: taskId },
    text: 'PUBLIC_VK_ADMISSION' };
  const state = { writes: 0, dispatches: 0, nativeReserved: false as boolean | null,
    workerIdentity: false, finishes: [] as string[], command: null as WorkerCommand | null,
    operation: null as WorkerOperation | null,
    receipts: [] as { method: WorkerCommand['method']; receiptId: string }[],
    inputs: [] as { clientUserMessageId: string; submissionId: string }[],
    beforeRead: async () => {},
    beforeWire: () => {},
  };
  const ticket: ManagedNativeStockQueueAuthority = { taskId, ownerEpoch: epoch,
    backendGeneration: 1, semanticRevision: 0, authorityRevision: 0, pendingEvents: 0,
    projection: { id: taskId, cwd: 'C:\\own', latestModel: 'gpt-5.6-sol',
      latestReasoningEffort: 'medium', threadRuntimeStatus: { type: 'idle' },
      terminalTurnIds: [], activeTurnIds: [], latestThreadSettings: {},
      currentPermissions: {}, environments: [] },
  };
  const read: StockReadState = { threadId: taskId, generation: 1, turnCount: 0,
    terminalTurnIds: [], historyDigest: 'unit-history', model: 'gpt-5.6-sol',
    modelProvider: 'openai', reasoningEffort: 'medium', cwd: 'C:\\own', environments: [],
    updatedAt: 1, fastModeAllowed: false };
  const submitter = new ManagedStockVkSubmitter({ capability, controlKey: {}, sourceId: '',
    taskId, ownerEpoch: epoch, backendGeneration: 1,
    approvedTaskPolicy: approveTaskPolicy({ threadId: taskId, model: 'gpt-5.6-sol',
      modelProvider: 'openai', effort: 'medium', cwd: 'C:\\own', runtimeWorkspaceRoots: ['C:\\own'],
      environments: [], approvalPolicy: 'never', approvalsReviewer: 'user',
      activePermissionProfile: { id: ':danger-full-access', extends: null },
      sandbox: { type: 'dangerFullAccess' }, serviceTier: null }),
    initialState: { latestThreadSettings: {}, currentPermissions: {}, environments: [] } as never,
    captureAuthority: () => ticket, assertAuthorityCurrent: value => value === ticket,
    isClientReservedForNativeInput: () => state.nativeReserved as boolean,
    readStockState: async assertCurrent => { await state.beforeRead(); assertCurrent(); return read; },
    acquireLease: () => ({ assertCurrent() {}, finish: outcome => { state.finishes.push(outcome); } }),
    host: {
      commandStatusForIntent: (_key, command) => { state.command = command; return state.operation; },
      commandQuiescence: () => ({ inFlight: state.operation?.state === 'dispatching' ? 1 : 0,
        unconfirmed: state.operation?.state === 'dispatching' }),
      acceptedCommandReceipts: () => state.receipts, acceptedQueueInputs: () => state.inputs,
      hasCommandClientIdentity: () => state.workerIdentity,
      executeCommandWithResponse: async (_key, command, beforeWrite, withWriteGuard) => {
        state.dispatches++;
        state.operation = { operationId: command.operationId,
          clientUserMessageId: request.operationId, method: command.method,
          fingerprint: 'a'.repeat(64), ownerEpoch: epoch, backendGeneration: 1,
          threadId: taskId, revision: 1, state: 'dispatching', receiptId: null, rejectionCode: null };
        const beforeWrites = state.writes;
        try {
          state.beforeWire(); beforeWrite?.();
          const write = () => { state.writes++; };
          if (withWriteGuard) withWriteGuard(write); else write();
        }
        catch (error) {
          if (state.writes !== beforeWrites) {
            state.operation = { ...state.operation, state: 'unknown', revision: 2 };
            throw error;
          }
          state.operation = { ...state.operation, state: 'rejected', revision: 2, rejectionCode: null };
          return { operation: state.operation, response: null };
        }
        state.operation = { ...state.operation, state: 'accepted', revision: 2,
          receiptId: 'unit-submission' };
        return { operation: state.operation, response: { submissionId: 'unit-submission' } };
      },
    },
  });
  return { submitter, request, capability, state, read, scope: () => {
    assert.ok(state.command);
    return { ...state.command, ownerEpoch: epoch, backendGeneration: 1, threadId: taskId };
  } };
}

test('VK command identity is stable but distinct from native stock identity', () => {
  const epoch = randomUUID(), taskId = randomUUID(), clientId = randomUUID();
  assert.equal(managedVkStockCommandId(epoch, taskId, clientId),
    managedVkStockCommandId(epoch, taskId, clientId));
  assert.notEqual(managedVkStockCommandId(epoch, taskId, clientId),
    managedStockCommandId(epoch, taskId, clientId));
  assert.notEqual(managedVkStockCommandId(epoch, taskId, clientId),
    managedVkStockCommandId(epoch, taskId, randomUUID()));
});

test('VK submitter forwards trusted actual-write wrapper after the scoped fence', async () => {
  const f = qualifiedAdmissionFixture(); let current = true, wraps = 0;
  const order: string[] = [];
  const outcome = await f.submitter.submit(f.capability, f.request, () => {
    if (!current) throw new Error('scope retired');
    order.push('scope');
  }, write => {
    wraps++; order.push('guard');
    assert.equal(order.at(-2), 'scope');
    assert.equal(f.state.writes, 0);
    write();
    assert.equal(f.state.writes, 1);
    current = false;
  });
  assert.equal(wraps, 1);
  assert.equal(outcome.submissionId, 'unit-submission');
  assert.deepEqual(f.state.finishes, ['accepted']);
  assert.equal(f.submitter.pending, 0);
});

test('VK submitter claim wrapper refusal before entry releases rejected admission', async () => {
  const f = qualifiedAdmissionFixture();
  await assert.rejects(f.submitter.submit(f.capability, f.request, undefined,
    () => { throw new Error('claim revoked before write'); }));
  assert.equal(f.state.writes, 0);
  assert.deepEqual(f.state.finishes, ['rejected']);
  assert.equal(f.submitter.pending, 0);
});

for (const phase of ['history-read', 'idle-proof', 'read-parity', 'authority-ticket', 'local-preparation'] as const) {
  test(`VK pre-reservation ${phase} refusal is definitive and leaves no worker operation`, async () => {
    const f = qualifiedAdmissionFixture();
    f.state.beforeRead = async () => {
      if (phase === 'history-read') throw new Error('private history failure');
      if (phase === 'idle-proof') throw new ManagedWorkerIdleProofRefusedError('accepted-queue-input-not-terminal');
      if (phase === 'read-parity') Object.assign(f.read, { model: 'foreign-model' });
      if (phase === 'authority-ticket') f.state.nativeReserved = true;
    };
    await assert.rejects(f.submitter.submit(f.capability, { ...f.request,
      beforeSend: async () => { if (phase === 'local-preparation') throw new Error('private local failure'); },
    }), error => error instanceof ActionRejectedError && !error.message.includes('private'));
    assert.equal(f.state.dispatches, 0); assert.equal(f.state.writes, 0);
    assert.equal(f.state.operation, null); assert.deepEqual(f.state.finishes, ['rejected']);
    assert.equal(f.submitter.pending, 0);
  });
}

test('VK entered-write wrapper failure keeps unknown ownership and is not normalised to rejection', async () => {
  const f = qualifiedAdmissionFixture(), failure = new Error('post-write uncertainty');
  await assert.rejects(f.submitter.submit(f.capability, f.request, undefined,
    write => { write(); throw failure; }), error => error === failure && !(error instanceof ActionRejectedError));
  assert.equal(f.state.dispatches, 1); assert.equal(f.state.writes, 1);
  assert.equal(f.state.operation?.state, 'unknown'); assert.deepEqual(f.state.finishes, ['unknown']);
  assert.equal(f.submitter.pending, 1);
});

test('held VK admission lease does not grant a write before history qualification', async () => {
  const taskId = randomUUID(), epoch = randomUUID(), capability = {};
  let command: WorkerCommand | null = null;
  let rejectRead!: (error: Error) => void;
  let writes = 0, finishes = 0;
  const read = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  const submitter = new ManagedStockVkSubmitter({ capability, controlKey: {}, sourceId: '',
    taskId, ownerEpoch: epoch, backendGeneration: 1,
    approvedTaskPolicy: approveTaskPolicy({ threadId: taskId, model: 'gpt-5.6-sol',
      modelProvider: 'openai', effort: 'medium', cwd: 'C:\\own',
      runtimeWorkspaceRoots: ['C:\\own'], environments: [], approvalPolicy: 'never',
      approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', extends: null },
      sandbox: { type: 'dangerFullAccess' }, serviceTier: null }),
    initialState: {} as never,
    captureAuthority: () => ({} as never), assertAuthorityCurrent: () => true,
    isClientReservedForNativeInput: () => false,
    readStockState: async () => read,
    host: { executeCommandWithResponse: async () => { writes++; throw new Error('must not write'); },
      commandStatusForIntent: (_key, value) => { command = value; return null; },
      commandQuiescence: () => ({ inFlight: 0, unconfirmed: false }),
      acceptedCommandReceipts: () => [], acceptedQueueInputs: () => [], hasCommandClientIdentity: () => false },
    acquireLease: () => ({ assertCurrent() {}, finish() { finishes++; } }),
  });
  const result = assert.rejects(submitter.submit(capability, {
    operationId: randomUUID(), task: { hostId: 'local', threadId: taskId }, text: 'PUBLIC_VK',
  }), ActionRejectedError);
  try {
    assert.ok(command);
    assert.equal(submitter.pending, 1, 'the admission lease is already held');
    assert.equal(submitter.authorizes({ ...(command as WorkerCommand), ownerEpoch: epoch,
      backendGeneration: 1, threadId: taskId }), false,
    'an exact pending command is not a qualified write grant');
    assert.equal(writes, 0);
  } finally { rejectRead(new Error('history unavailable')); await result; }
  assert.equal(finishes, 1);
});

test('capability, task source, and unsupported attachments refuse before any lease or worker write', async () => {
  const taskId = randomUUID(), epoch = randomUUID(), capability = {};
  let leases = 0, writes = 0, reads = 0;
  const submitter = new ManagedStockVkSubmitter({ capability, controlKey: {}, sourceId: '',
    taskId, ownerEpoch: epoch, backendGeneration: 1,
    approvedTaskPolicy: approveTaskPolicy({ threadId: taskId, model: 'gpt-5.6-sol',
      modelProvider: 'openai', effort: 'medium', cwd: 'C:\\own',
      runtimeWorkspaceRoots: ['C:\\own'], environments: [], approvalPolicy: 'never',
      approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', extends: null },
      sandbox: { type: 'dangerFullAccess' }, serviceTier: null }),
    initialState: {} as never,
    captureAuthority: () => { throw new Error('must not capture'); },
    assertAuthorityCurrent: () => false,
    isClientReservedForNativeInput: () => false,
    readStockState: async () => { reads++; throw new Error('must not read'); },
    host: { executeCommandWithResponse: async () => { writes++; throw new Error('must not write'); },
      commandStatusForIntent: () => null, commandQuiescence: () => ({ inFlight: 0, unconfirmed: false }),
      acceptedCommandReceipts: () => [], acceptedQueueInputs: () => [], hasCommandClientIdentity: () => false },
    acquireLease: () => { leases++; throw new Error('must not lease'); },
  });
  const request = { operationId: randomUUID(), task: { hostId: 'local', threadId: taskId },
    text: 'PUBLIC_VK' };
  await assert.rejects(submitter.submit({}, request), /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request, text: '   ' }),
    /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request,
    task: { ...request.task, sourceId: 'other' } }), /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request,
    inputFiles: [{ kind: 'image', originalName: 'x', path: 'C:\\own\\x.png', sizeBytes: 1 }] }),
    /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request, ignoredSemanticField: true } as never),
    /Managed VK stock input unavailable/);
  assert.deepEqual({ leases, reads, writes }, { leases: 0, reads: 0, writes: 0 });
});

test('VK write authority waits for bridge-local preparation and then admits only its exact reservation', async () => {
  const { submitter, request, capability, state, scope } = qualifiedAdmissionFixture();
  let release!: () => void, prepared!: () => void;
  const waiting = new Promise<void>(resolve => { prepared = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = submitter.submit(capability, { ...request,
    beforeSend: async () => { prepared(); await gate; } });
  await waiting;
  assert.equal(submitter.pending, 1);
  assert.equal(submitter.authorizes(scope()), false);
  assert.equal(state.dispatches, 0);
  state.beforeWire = () => {
    assert.equal(submitter.authorizes(scope()), true, 'its exact durable reservation is allowed');
    assert.equal(submitter.authorizes({ ...scope(), backendGeneration: 2 }), false);
    assert.equal(submitter.authorizes({ ...scope(), operationId: randomUUID() }), false);
  };
  release();
  assert.deepEqual(await result, { submissionId: 'unit-submission' });
  assert.equal(state.writes, 1);
  assert.deepEqual(state.finishes, ['accepted']);
  assert.equal(submitter.pending, 0);
  assert.equal(submitter.authorizes(scope()), false);
});

for (const transition of ['native-identity', 'unknown-native-identity', 'accepted-history', 'worker-identity'] as const) {
  test(`VK ${transition} change during preparation refuses before dispatch`, async () => {
    const { submitter, request, capability, state } = qualifiedAdmissionFixture();
    await assert.rejects(submitter.submit(capability, { ...request, beforeSend: async () => {
      if (transition === 'native-identity') state.nativeReserved = true;
      if (transition === 'unknown-native-identity') state.nativeReserved = null;
      if (transition === 'worker-identity') state.workerIdentity = true;
      if (transition === 'accepted-history') state.receipts.push({ method: 'turn/start', receiptId: 'new-turn' });
    } }));
    assert.equal(state.dispatches, 0);
    assert.equal(state.writes, 0);
    assert.deepEqual(state.finishes, ['rejected']);
    assert.equal(submitter.pending, 0);
  });
}

test('VK native collision at the final write fence refuses an already reserved operation', async () => {
  const { submitter, request, capability, state } = qualifiedAdmissionFixture();
  state.beforeWire = () => { state.nativeReserved = true; };
  await assert.rejects(submitter.submit(capability, request));
  assert.equal(state.dispatches, 1);
  assert.equal(state.writes, 0);
  assert.equal(state.operation?.state, 'rejected');
  assert.deepEqual(state.finishes, ['rejected']);
  assert.equal(submitter.pending, 0);
});

for (const phase of ['initial', 'history-read', 'local-preparation', 'actual-write'] as const) {
  test(`VK per-call worker scope refuses a change at ${phase}`, async () => {
    const { submitter, request, capability, state } = qualifiedAdmissionFixture();
    let current = phase !== 'initial';
    if (phase === 'history-read') state.beforeRead = async () => { current = false; };
    if (phase === 'actual-write') state.beforeWire = () => { current = false; };
    await assert.rejects(submitter.submit(capability, { ...request,
      beforeSend: async () => { if (phase === 'local-preparation') current = false; },
    }, () => { if (!current) throw new Error('Scoped worker identity changed'); }));
    assert.equal(state.writes, 0);
    assert.equal(state.dispatches, phase === 'actual-write' ? 1 : 0);
    assert.equal(submitter.pending, 0);
  });
}

for (const rejects of [false, true]) test(`VK per-call scope rejects an asynchronous assertion (${rejects ? 'rejected' : 'resolved'}) without an unhandled promise`, async () => {
  const { submitter, request, capability, state } = qualifiedAdmissionFixture();
  await assert.rejects(submitter.submit(capability, request, async () => {
    if (rejects) throw new Error('Unqualified asynchronous scope');
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.writes, 0);
  assert.equal(state.dispatches, 0);
});
