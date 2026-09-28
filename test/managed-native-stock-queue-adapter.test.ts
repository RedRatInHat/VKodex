import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ManagedWorkerCommandDispatcher } from '../src/codex/managed-worker-command-dispatcher.js';
import { ManagedNativeQueueRefusal, ManagedNativeStockQueueAdapter,
  managedStockCommandId, type ManagedNativeStockQueueAdapterOptions } from '../src/desktop/managed-native-stock-queue-adapter.js';
import { NativeStockQueueJournal } from '../src/codex/native-stock-queue-journal.js';

async function fixture(t: TestContext, options: { nullResponse?: boolean; delayed?: boolean;
  staleReceipt?: boolean; baselineGate?: Promise<void>; revokeBeforeDispatch?: boolean;
  workerPrewriteRefusal?: boolean; numericRejection?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vkodex-managed-stock-'));
  const taskId = randomUUID(), ownerEpoch = randomUUID(), sourceClientId = randomUUID();
  const cwd = 'C:/isolated';
  const settings = { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never',
    approvalsReviewer: 'user', permissions: ':danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' }, model: 'synthetic-model', serviceTier: null,
    effort: 'medium', summary: null, personality: 'pragmatic', collaborationMode: {
      mode: 'default', settings: { model: 'synthetic-model', reasoning_effort: 'medium',
        developer_instructions: 'synthetic built-in' } } };
  const requested = { mode: 'default', settings: { model: 'synthetic-model',
    reasoning_effort: 'medium', developer_instructions: null } };
  const qualification = { taskId, ownerEpoch, confirmed: true as const,
    completeQueueAndHistory: true, exclusiveLifecycleWriter: true, ambientContextEmpty: true,
    effectiveSettings: settings, initializationReceipt: { taskId, ownerEpoch, confirmed: true,
      expansionKind: 'builtin-default-instructions', requestedCollaborationMode: requested,
      confirmedEffectiveCollaborationMode: settings.collaborationMode,
      requestedSettings: { ...settings, sandboxPolicy: null, serviceTier: 'default',
        collaborationMode: requested }, confirmedEffectiveSettings: settings },
    tierResolution: { taskId, ownerEpoch, requested: 'default', effective: null,
      fastModeAllowed: false, confirmed: true } };
  const entryId = randomUUID(), text = 'PUBLIC_OK';
  const entry = { id: entryId, text, cwd, createdAt: 1780000000000,
    context: { prompt: text, turnTrigger: 'composer', workspaceRoots: [cwd],
      usedDictation: false, existingWorkspaceRoot: null, localProjectId: null,
      fileAttachments: [] as string[], addedFiles: [] },
    responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    submissionOptions: { executionHostId: 'local', agentMode: 'full-access',
      permissionProfileId: ':danger-full-access', serviceTier: 'default',
      shouldSendPermissionOverrides: false, usePermissionSelection: false,
      permissionSelection: null, collaborationMode: requested,
      clientUserMessageId: 'separate-native-option-id' },
    writingBlockAdditionalContext: null, mentionedBrowserFamilies: [], submissionIntent: 'send-now',
    submission: { hostId: 'local', status: 'pending', queueModeOverride: 'queue' } };
  const controlKey = {}, calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let owner = true, source = true, settingsCurrent = true, baseline = true;
  let qualifications = 0;
  let release: (() => void) | null = null;
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let markBaselineEntered!: () => void;
  const baselineEntered = new Promise<void>(resolve => { markBaselineEntered = resolve; });
  const gate = options.delayed ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const backend = { isSessionCurrent: (generation: number) => generation === 1,
    async request(method: string, params: Record<string, unknown>, rpcOptions: {
      assertBeforeWrite?: () => void;
      onResponseEnvelope?: (value: { result: Record<string, unknown> } |
        { error: { code: number; message: string } }) => void;
      onBeforeWriteRefused?: () => void;
    }) {
      markEntered();
      await gate;
      if (options.workerPrewriteRefusal) {
        rpcOptions.onBeforeWriteRefused?.();
        throw new Error('final worker fence refused before write');
      }
      rpcOptions.assertBeforeWrite?.();
      calls.push({ method, params });
      if (options.numericRejection) {
        rpcOptions.onResponseEnvelope?.({ error: { code: -32602, message: 'invalid params' } });
        throw new Error('numeric native server rejection');
      }
      if (options.nullResponse) return {};
      const result = { queuedSubmission: { id: randomUUID(),
        clientUserMessageId: params.clientUserMessageId, input: params.input } };
      rpcOptions.onResponseEnvelope?.({ result });
      return result;
    } };
  const dispatcher = new ManagedWorkerCommandDispatcher(backend as never, taskId, 1,
    { controlKey, ownerEpoch, journalPath: path.join(directory, 'worker.sqlite'),
      fingerprintKey: Buffer.alloc(32, 7), authorize: () => true,
      isOwnerCurrent: () => owner }, () => true);
  const published: Array<{ ids: string[]; kind: string }> = [];
  const failures: string[] = [];
  let queueChanged = 0;
  const adapterOptions: ManagedNativeStockQueueAdapterOptions = { taskId, ownerEpoch,
    backendGeneration: 1, sourceGeneration: 'generation-1',
    journalPath: path.join(directory, 'native.sqlite'), controlKey,
    host: { executeCommandWithResponse: async (key: object,
      command: Parameters<typeof dispatcher.executeWithResponse>[1], beforeWrite?: () => void) => {
      const observed = await dispatcher.executeWithResponse(key, command, beforeWrite);
      return options.staleReceipt ? { ...observed,
        operation: { ...observed.operation, receiptId: 'stale-stock-id' } } : observed;
    } },
    assertInitialNativeQueueBaseline: async () => {
      markBaselineEntered();
      await options.baselineGate;
      return baseline;
    },
    qualify: () => {
      if (++qualifications === 2 && options.revokeBeforeDispatch) settingsCurrent = false;
      return qualification;
    },
    confirmOwner: () => owner,
    assertOwnerCurrent: () => owner,
    assertDispatchCurrent: () => settingsCurrent,
    publish: (messages, metadata) => {
      published.push({ ids: messages.map(message => String(message.id)), kind: metadata.kind });
    }, onStockQueueChanged: () => { queueChanged++; },
    onFailure: reason => { failures.push(reason); } };
  const adapter = new ManagedNativeStockQueueAdapter(adapterOptions);
  t.after(async () => { adapter.close(); await dispatcher.close(); });
  const request = (state: unknown = [entry]) => ({ requestId: randomUUID(), sourceClientId,
    method: 'thread-follower-set-queued-follow-ups-state', version: 1,
    hostId: 'local', params: { hostId: 'local', conversationId: taskId,
      state: { [taskId]: state } } });
  return { adapter, adapterOptions, dispatcher, controlKey, taskId, ownerEpoch, entryId, entry, calls,
    published, failures,
    request, release: () => release?.(), revokeSource: () => { source = false; },
    waitForBackend: () => Promise.race([entered, new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('backend request was not reached')), 1000))]),
    waitForBaseline: () => baselineEntered,
    revokeSettings: () => { settingsCurrent = false; },
    revokeOwner: () => { owner = false; },
    revokeBaseline: () => { baseline = false; }, ingress: () => source,
    queueChanged: () => queueChanged };
}

test('predispatch refusal leaves durable native reservation with no worker write', async t => {
  const f = await fixture(t, { revokeBeforeDispatch: true });
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.adapter.quiescence(), { taskVersion: 1, unresolved: 1, unconsumed: 1 });
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  assert.equal(f.calls.length, 0);
});

test('stock queue reports fixed shape and baseline refusal codes before any worker write', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.accept({ ...f.request(), version: 2 }, f.ingress),
    error => error instanceof ManagedNativeQueueRefusal && error.code === 'request-shape');
  f.revokeBaseline();
  await assert.rejects(f.adapter.accept(f.request(), f.ingress),
    error => error instanceof ManagedNativeQueueRefusal && error.code === 'baseline');
  assert.equal(f.calls.length, 0);
});

test('proven final worker pre-write refusal is durable not-written, never ACKed or republished empty', async t => {
  const f = await fixture(t, { workerPrewriteRefusal: true });
  await assert.rejects(f.adapter.accept(f.request(), f.ingress), /not written/i);
  assert.equal(f.calls.length, 0);
  const worker = f.dispatcher.get(f.controlKey,
    managedStockCommandId(f.ownerEpoch, f.taskId, f.entryId));
  assert.equal(worker?.state, 'rejected');
  assert.equal(worker?.receiptId, null);
  assert.equal(worker?.rejectionCode, null);
  const durable = new NativeStockQueueJournal({ filePath: f.adapterOptions.journalPath,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch,
    sourceGeneration: f.adapterOptions.sourceGeneration });
  assert.equal(durable.readOperation(f.entryId)?.phase, 'not-written');
  assert.equal(durable.readOperation(f.entryId)?.notWritten?.workerOperationId, worker?.operationId);
  durable.close();
  assert.deepEqual(f.adapter.quiescence(), { taskVersion: 2, unresolved: 1, unconsumed: 1 });
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  const changed = structuredClone(f.entry);
  changed.text = 'CHANGED_PUBLIC_SENTINEL'; changed.context.prompt = changed.text;
  await assert.rejects(f.adapter.accept(f.request([changed]), f.ingress));
  await assert.rejects(f.adapter.hydrateFollower());
  assert.deepEqual(f.published, []);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.adapter.consumeUserMessage(f.entryId, 'unexpected-turn', () => true));
  assert.deepEqual(f.failures, ['not-written-user-message-conflict']);
});

test('numeric native server rejection after write remains unknown, not proven not-written', async t => {
  const f = await fixture(t, { numericRejection: true });
  await assert.rejects(f.adapter.accept(f.request(), f.ingress), /outcome unknown/);
  assert.equal(f.calls.length, 1);
  const durable = new NativeStockQueueJournal({ filePath: f.adapterOptions.journalPath,
    taskId: f.taskId, ownerEpoch: f.ownerEpoch,
    sourceGeneration: f.adapterOptions.sourceGeneration });
  assert.equal(durable.readOperation(f.entryId)?.phase, 'unknown');
  assert.equal(durable.readOperation(f.entryId)?.notWritten, null);
  durable.close();
});

test('pending native ingress is not quiescent before its journal reservation', async t => {
  let release!: () => void;
  const baselineGate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { baselineGate });
  const pending = f.adapter.accept(f.request(), f.ingress);
  await f.waitForBaseline();
  assert.throws(() => f.adapter.quiescence());
  assert.equal(f.calls.length, 0);
  release();
  await pending;
  assert.equal(f.adapter.quiescence().unconsumed, 1);
});

test('accepted native queue stays unconsumed until authoritative user item', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.adapter.quiescence(), { taskVersion: 0, unresolved: 0, unconsumed: 0 });
  await f.adapter.accept(f.request(), f.ingress);
  assert.equal(f.adapter.quiescence().unresolved, 0);
  assert.equal(f.adapter.quiescence().unconsumed, 1);
  assert.equal(await f.adapter.consumeUserMessage(f.entryId, 'own-turn', () => true), true);
  assert.equal(f.adapter.quiescence().unconsumed, 0);
  f.adapter.close();
  assert.throws(() => f.adapter.quiescence());
});

test('same-host stock receipt durably accepts full native state; replay and consumption do not write twice', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.accept(f.request(), f.ingress), { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.method, 'thread/queue/add');
  assert.equal(f.calls[0]?.params.clientUserMessageId, f.entryId);
  assert.deepEqual(await f.adapter.accept(f.request(), f.ingress), { ok: true });
  assert.equal(f.calls.length, 1);
  const changed = structuredClone(f.entry);
  changed.text = 'CHANGED_PUBLIC_SENTINEL'; changed.context.prompt = changed.text;
  await assert.rejects(f.adapter.accept(f.request([changed]), f.ingress));
  assert.equal(f.calls.length, 1);
  assert.equal(await f.adapter.consumeUserMessage('unrelated', 'other-turn', () => true), false);
  assert.equal(await f.adapter.consumeUserMessage(f.entryId, 'own-turn', () => true), true);
  assert.deepEqual(f.published.at(-1), { ids: [], kind: 'outbox' });
});

test('unknown result never acknowledges or replays native submission', async t => {
  const f = await fixture(t, { nullResponse: true });
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  assert.equal(f.calls.length, 1);
});

test('an empty request cannot clear an unqualified native baseline', async t => {
  const f = await fixture(t);
  f.revokeBaseline();
  await assert.rejects(f.adapter.accept(f.request([]), f.ingress));
  await assert.rejects(f.adapter.hydrateFollower());
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  assert.equal(f.calls.length, 0);
});

test('envelope is cloned before awaited baseline and constructor options cannot redirect dispatch', async t => {
  let release!: () => void;
  const baselineGate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { baselineGate });
  const incoming = f.request();
  const pending = f.adapter.accept(incoming, f.ingress);
  await f.waitForBaseline();
  incoming.params.state[f.taskId] = [];
  const mutable = f.adapterOptions as unknown as { taskId: string; controlKey: object;
    host: { executeCommandWithResponse: () => never } };
  mutable.taskId = 'wrong-task'; mutable.controlKey = {};
  mutable.host.executeCommandWithResponse = () => { throw new Error('mutated host method'); };
  release();
  assert.deepEqual(await pending, { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.params.clientUserMessageId, f.entryId);
  await assert.rejects(f.adapter.accept({ ...f.request(), params: {
    ...f.request().params, unexpected: true } }, f.ingress));
  assert.equal(f.calls.length, 1);
});

test('stale accepted worker receipt cannot produce native ok or a second write', async t => {
  const f = await fixture(t, { staleReceipt: true });
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
  assert.equal(f.calls.length, 1);
});

test('authoritative user item before reserve faults route without a duplicate stock add', async t => {
  let release!: () => void;
  const baselineGate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { baselineGate });
  const pending = f.adapter.accept(f.request(), f.ingress);
  await f.waitForBaseline();
  assert.equal(await f.adapter.consumeUserMessage(f.entryId, 'own-turn', () => true), true);
  await assert.rejects(f.adapter.consumeUserMessage(f.entryId, 'different-turn', () => true));
  release();
  await assert.rejects(pending);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.failures, ['early-user-message-before-dispatch']);
  await assert.rejects(f.adapter.accept(f.request(), f.ingress));
});

test('early item plus failed baseline faults route, and close during async dispatch fences write', async t => {
  let release!: () => void;
  const baselineGate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { baselineGate });
  const early = f.adapter.accept(f.request(), f.ingress);
  await f.waitForBaseline();
  assert.equal(await f.adapter.consumeUserMessage(f.entryId, 'own-turn', () => true), true);
  f.revokeBaseline();
  release();
  await assert.rejects(early);
  assert.deepEqual(f.failures, ['early-user-message-unattributed']);
  assert.equal(f.calls.length, 0);
  const delayed = await fixture(t, { delayed: true });
  const pending = delayed.adapter.accept(delayed.request(), delayed.ingress);
  await delayed.waitForBackend();
  delayed.adapter.close(); delayed.release();
  await assert.rejects(pending);
  assert.equal(delayed.calls.length, 0);
});

test('authoritative item after reserve but before backend write prevents duplicate queue add', async t => {
  const f = await fixture(t, { delayed: true });
  const pending = f.adapter.accept(f.request(), f.ingress);
  await f.waitForBackend();
  assert.equal(await f.adapter.consumeUserMessage(f.entryId, 'own-turn', () => true), true);
  f.release();
  await assert.rejects(pending);
  assert.equal(f.calls.length, 0);
});

test('own stock queue notification invalidates caller evidence; unrelated notifications do not', async t => {
  const f = await fixture(t);
  assert.equal(f.adapter.observeBackendNotification({ method: 'thread/queue/changed',
    params: { threadId: 'unrelated' } }, () => true), false);
  assert.equal(f.adapter.observeBackendNotification({ method: 'thread/settings/updated',
    params: { threadId: f.taskId } }, () => true), false);
  assert.equal(f.queueChanged(), 0);
  assert.equal(f.adapter.observeBackendNotification({ method: 'thread/queue/changed',
    params: { threadId: f.taskId } }, () => true), true);
  assert.equal(f.queueChanged(), 1);
  assert.throws(() => f.adapter.observeBackendNotification({ method: 'thread/queue/changed',
    params: { threadId: f.taskId } }, () => false));
  assert.equal(f.queueChanged(), 1);
});

test('late source, settings or owner revocation fences actual backend write', async t => {
  for (const revoke of ['revokeSource', 'revokeSettings', 'revokeOwner'] as const) {
    const f = await fixture(t, { delayed: true });
    const pending = f.adapter.accept(f.request(), f.ingress);
    await f.waitForBackend();
    f[revoke](); f.release();
    await assert.rejects(pending);
    assert.equal(f.calls.length, 0, revoke);
  }
});
