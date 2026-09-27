import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeStockQueueJournal, type PositiveReconciliationProof } from '../src/codex/native-stock-queue-journal.js';
import { NativeStockAdmission, type StockAdmissionQualification } from '../src/codex/native-stock-admission.js';
import type { JsonObject } from '../src/codex/homogeneous-queue-policy.js';
import { prepareNativeStockTextEntry, type NativeStockTextQualification } from '../src/codex/native-stock-text-entry.js';

interface Entry { id: string; text: string }
interface Qualification extends StockAdmissionQualification {
  readonly confirmed: true;
  readonly effectiveSettings: { readonly model: string; readonly permissions: string; readonly effort: string };
  readonly initializationReceipt: string;
}
interface Request { readonly threadId: string; readonly clientUserMessageId: string;
  readonly input: readonly JsonObject[] }
interface Receipt { readonly queuedSubmission: { readonly id: string; readonly clientUserMessageId: string;
  readonly input: Request['input'] } }
type Publication = { ids: string[]; kind: 'outbox' | 'hydrate' };
const entry = (id: string, text = id): Entry => ({ id, text });
const hash = (value: Entry): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('condition did not occur');
}
async function fixture(t: TestContext, options: {
  queueAdd?: (request: Request) => Promise<Receipt>;
  publish?: (ids: string[]) => Promise<void>;
  qualify?: (entry: Entry | null) => Promise<void>;
  confirmOwner?: () => Promise<void>;
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vkodex-stock-admission-'));
  const taskId = randomUUID(), ownerEpoch = randomUUID();
  const journal = new NativeStockQueueJournal({ filePath: path.join(directory, 'journal.sqlite'), taskId, ownerEpoch, sourceGeneration: 'source-1' });
  t.after(() => journal.close());
  const adds: Request[] = [], publications: Publication[] = [];
  let owner = true, source = true, dispatch = true, currentSettings = {
    model: 'synthetic-model', permissions: ':read-only', effort: 'medium',
  };
  const coordinator = new NativeStockAdmission<Entry, Qualification>({ taskId, ownerEpoch, journal,
    identifyEntry: value => ({ id: value.id, fingerprint: hash(value) }),
    prepareEntry: value => ({ input: [{ type: 'text', text: value.text, text_elements: [] }],
      forwardedUpstream: { turnTrigger: false } }),
    qualify: async ({ entry: value }) => {
      await options.qualify?.(value);
      return { taskId, ownerEpoch, confirmed: true, effectiveSettings: currentSettings,
        initializationReceipt: 'synthetic-start-receipt' };
    },
    confirmOwner: async () => { await options.confirmOwner?.(); return owner; },
    assertOwnerCurrent: () => source,
    assertDispatchCurrent: () => dispatch,
    queueAdd: async request => {
      adds.push(request);
      return options.queueAdd?.(request) ?? { queuedSubmission: {
        id: `stock-${request.clientUserMessageId}`, clientUserMessageId: request.clientUserMessageId,
        input: request.input,
      } };
    },
    publish: async (messages, metadata) => {
      const ids = messages.map(message => String(message.id));
      publications.push({ ids, kind: metadata.kind });
      await options.publish?.(ids);
    },
  });
  return { taskId, ownerEpoch, journal, coordinator, adds, publications,
    loseOwner: () => { owner = false; }, loseSource: () => { source = false; },
    loseDispatch: () => { dispatch = false; },
    changeSettings: () => { currentSettings = { ...currentSettings, effort: 'high' }; } };
}
function event(f: Awaited<ReturnType<typeof fixture>>, clientId = 'A', extra: {
  assertEventCurrent?: () => boolean;
} = {}) {
  return { taskId: f.taskId, ownerEpoch: f.ownerEpoch, clientId, turnId: `turn-${clientId}`,
    authoritative: true, ...extra };
}

test('first stock add persists qualification evidence and exact replay sends no second RPC', async t => {
  const f = await fixture(t), a = entry('A');
  assert.deepEqual(await f.coordinator.acceptFullState({ state: [a] }), { ok: true });
  assert.equal(f.journal.readOperation('A')?.phase, 'accepted');
  assert.equal(f.journal.readOperation('A')?.admissionEvidence.initializationReceipt, 'synthetic-start-receipt');
  assert.deepEqual(await f.coordinator.acceptFullState({ state: [a] }), { ok: true });
  assert.equal(f.adds.length, 1);
});

test('consume before stock ACK and identical join preserve one add, no resurrection', async t => {
  const pending = deferred<Receipt>(), f = await fixture(t, { queueAdd: () => pending.promise });
  const a = entry('A'), first = f.coordinator.acceptFullState({ state: [a] });
  await until(() => f.adds.length === 1);
  const join = f.coordinator.acceptFullState({ state: [a] });
  await assert.rejects(f.coordinator.acceptFullState({ state: [a, entry('B')] }), /unresolved/);
  await f.coordinator.consumeUserMessage(event(f));
  pending.resolve({ queuedSubmission: { id: 'stock-A', clientUserMessageId: 'A', input: f.adds[0]!.input } });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await join, { ok: true });
  assert.equal(f.journal.readOperation('A')?.consumed, true);
  assert.deepEqual(f.publications.map(value => value.ids), [[]]);
  assert.equal(f.adds.length, 1);
});

test('consumed prefix allows next append but pending omission, changed body, and reused ID fail', async t => {
  const f = await fixture(t), a = entry('A'), b = entry('B');
  await f.coordinator.acceptFullState({ state: [a] });
  await f.coordinator.acceptFullState({ state: [a, b] });
  await f.coordinator.consumeUserMessage(event(f));
  await f.coordinator.acceptFullState({ state: [a, b] });
  await assert.rejects(f.coordinator.acceptFullState({ state: [a] }), /pending omission/);
  await assert.rejects(f.coordinator.acceptFullState({ state: [entry('A', 'changed'), b] }), /changed-body/);
  await assert.rejects(f.coordinator.acceptFullState({ state: [b, a] }), /reused|out-of-order/);
  assert.deepEqual(f.adds.map(value => value.clientUserMessageId), ['A', 'B']);
});

test('unknown queue outcome freezes replay and later append without retry', async t => {
  const f = await fixture(t, { queueAdd: async () => { throw new Error('connection lost'); } });
  const a = entry('A');
  await assert.rejects(f.coordinator.acceptFullState({ state: [a] }), /outcome unknown/);
  assert.equal(f.journal.readOperation('A')?.phase, 'unknown');
  await assert.rejects(f.coordinator.acceptFullState({ state: [a] }), /unresolved/);
  await assert.rejects(f.coordinator.acceptFullState({ state: [a, entry('B')] }), /unresolved|unknown/);
  assert.equal(f.adds.length, 1);
});

test('lost response reconciles from positive read without replay and admits next input once', async t => {
  let lost = true;
  const f = await fixture(t, { queueAdd: async request => {
    if (lost) { lost = false; throw new Error('lost response'); }
    return { queuedSubmission: { id: `stock-${request.clientUserMessageId}`,
      clientUserMessageId: request.clientUserMessageId, input: request.input } };
  } });
  await assert.rejects(f.coordinator.acceptFullState({ state: [entry('A')] }), /outcome unknown/);
  const readProof = async (op: NonNullable<ReturnType<NativeStockQueueJournal['readOperation']>>): Promise<PositiveReconciliationProof> => ({
    taskId: f.taskId, ownerEpoch: f.ownerEpoch, sourceGeneration: 'source-1', sourceRevision: 10,
    complete: true, kind: 'started', turnId: 'turn-A', clientUserMessageId: op.opId,
    input: op.stockInput, effectiveSettings: op.effectiveSettings, admissionEvidence: op.admissionEvidence,
  });
  assert.deepEqual(await f.coordinator.reconcileOutcome({ opId: 'A', readProof,
    assertProofCurrent: () => true }), { reconciled: true });
  await f.coordinator.publishLatest();
  assert.deepEqual(f.publications.map(p => p.ids), [[]]);
  await f.coordinator.acceptFullState({ state: [entry('A')] });
  await f.coordinator.acceptFullState({ state: [entry('A'), entry('B')] });
  assert.deepEqual(f.adds.map(r => r.clientUserMessageId), ['A', 'B']);
});

test('reconciliation absence or source loss during awaited read cannot unfreeze unknown input', async t => {
  const f = await fixture(t, { queueAdd: async () => { throw new Error('lost response'); } });
  await assert.rejects(f.coordinator.acceptFullState({ state: [entry('A')] }), /outcome unknown/);
  assert.deepEqual(await f.coordinator.reconcileOutcome({ opId: 'A', readProof: async () => null,
    assertProofCurrent: () => true }), { reconciled: false });
  let entered = false, current = true;
  const gate = deferred<void>();
  const recovery = f.coordinator.reconcileOutcome({ opId: 'A', readProof: async op => {
    entered = true; await gate.promise;
    return { taskId: f.taskId, ownerEpoch: f.ownerEpoch, sourceGeneration: 'source-1',
      sourceRevision: 10, complete: true, kind: 'queued', stockId: 'stock-A',
      clientUserMessageId: op.opId, input: op.stockInput, effectiveSettings: op.effectiveSettings,
      admissionEvidence: op.admissionEvidence };
  }, assertProofCurrent: () => current });
  await until(() => entered); current = false; gate.resolve();
  await assert.rejects(recovery, /reconciliation source changed/);
  assert.equal(f.journal.readOperation('A')!.phase, 'unknown');
  assert.deepEqual(f.journal.reconciliationEvidence('A'), []);
  assert.equal(f.adds.length, 1);
});

test('reconciliation will not race a live add; late ACK after started proof never republishes', async t => {
  const pending = deferred<Receipt>(), f = await fixture(t, { queueAdd: () => pending.promise });
  const acceptance = f.coordinator.acceptFullState({ state: [entry('A')] });
  await until(() => f.adds.length === 1);
  let reads = 0;
  await assert.rejects(f.coordinator.reconcileOutcome({ opId: 'A',
    readProof: async () => { reads++; return null; }, assertProofCurrent: () => true }), /still in flight/);
  assert.equal(reads, 0);
  // Simulate a persisted proof produced by recovery before the original RPC
  // callback reaches this coordinator (e.g. after transport replacement).
  const op = f.journal.readOperation('A')!;
  f.journal.reconcilePositive({ expectedVersion: f.journal.readTask().version,
    proof: { taskId: f.taskId, ownerEpoch: f.ownerEpoch, sourceGeneration: 'source-1',
      sourceRevision: 10, complete: true, kind: 'started', turnId: 'turn-A',
      clientUserMessageId: 'A', input: op.stockInput, effectiveSettings: op.effectiveSettings,
      admissionEvidence: op.admissionEvidence }, assertSourceCurrent: () => true });
  pending.resolve({ queuedSubmission: { id: 'stock-A', clientUserMessageId: 'A', input: f.adds[0]!.input } });
  assert.deepEqual(await acceptance, { ok: true });
  assert.equal(f.journal.readOperation('A')!.stockId, 'stock-A');
  assert.deepEqual(f.publications.map(p => p.ids), [[]]);
  assert.equal(f.adds.length, 1);
});

test('accepted replay can ACK after settings drift; new append cannot use changed settings', async t => {
  const f = await fixture(t), a = entry('A');
  await f.coordinator.acceptFullState({ state: [a] });
  f.changeSettings();
  assert.deepEqual(await f.coordinator.acceptFullState({ state: [a] }), { ok: true });
  await assert.rejects(f.coordinator.acceptFullState({ state: [a, entry('B')] }), /settings changed/);
  assert.equal(f.adds.length, 1);
});

test('request lease loss during qualification prevents reserve and RPC', async t => {
  const pause = deferred<void>(); let entered = false, lease = true;
  const f = await fixture(t, { qualify: async () => { entered = true; await pause.promise; } });
  const acceptance = f.coordinator.acceptFullState({ state: [entry('A')],
    assertIngressCurrent: () => lease });
  await until(() => entered);
  lease = false; pause.resolve();
  await assert.rejects(acceptance, /request ingress changed/);
  assert.equal(f.journal.readOperation('A'), null);
  assert.equal(f.adds.length, 0);
});

test('new request lease joins old dispatched flight and alone receives accepted ACK', async t => {
  const pending = deferred<Receipt>(); let oldLease = true, joined = false;
  const f = await fixture(t, { queueAdd: () => pending.promise });
  const a = entry('A');
  const old = f.coordinator.acceptFullState({ state: [a], assertIngressCurrent: () => oldLease });
  await until(() => f.adds.length === 1);
  const newer = f.coordinator.acceptFullState({ state: [a],
    assertIngressCurrent: () => { joined = true; return true; } });
  await until(() => joined);
  oldLease = false;
  pending.resolve({ queuedSubmission: { id: 'stock-A', clientUserMessageId: 'A', input: f.adds[0]!.input } });
  await assert.rejects(old, /request ingress changed/);
  assert.deepEqual(await newer, { ok: true });
  assert.equal(f.journal.readOperation('A')?.phase, 'accepted');
  assert.equal(f.adds.length, 1);
});

test('stale worker generation during awaited owner proof does not consume', async t => {
  const pause = deferred<void>(); let block = false, entered = false, generation = 1;
  const f = await fixture(t, { confirmOwner: async () => { if (block) {
    entered = true; await pause.promise;
  } } });
  await f.coordinator.acceptFullState({ state: [entry('A')] });
  block = true;
  const captured = generation;
  const consumed = f.coordinator.consumeUserMessage(event(f, 'A', {
    assertEventCurrent: () => generation === captured,
  }));
  await until(() => entered);
  generation = 2; pause.resolve();
  await assert.rejects(consumed, /worker event source changed/);
  assert.equal(f.journal.readOperation('A')?.consumed, false);
});

test('global owner source loss during awaited proof cannot consume', async t => {
  const pause = deferred<void>(); let block = false, entered = false;
  const f = await fixture(t, { confirmOwner: async () => { if (block) {
    entered = true; await pause.promise;
  } } });
  await f.coordinator.acceptFullState({ state: [entry('A')] });
  block = true;
  const consumed = f.coordinator.consumeUserMessage(event(f));
  await until(() => entered);
  f.loseSource(); pause.resolve();
  await assert.rejects(consumed, /owner source changed/);
  assert.equal(f.journal.readOperation('A')?.consumed, false);
});

test('post-reserve dispatch fence refuses queue RPC and retains reserved intent', async t => {
  const f = await fixture(t); f.loseDispatch();
  await assert.rejects(f.coordinator.acceptFullState({ state: [entry('A')] }), /dispatch fence changed/);
  assert.equal(f.adds.length, 0);
  assert.equal(f.journal.readOperation('A')?.phase, 'reserved');
});

test('publication ACK waits for append qualification, allowing its reserve CAS', async t => {
  const published = deferred<void>(), qualified = deferred<void>();
  let firstPublishing = false, secondQualifying = false, sends = 0;
  const f = await fixture(t, { publish: async () => { if (++sends === 1) {
    firstPublishing = true; await published.promise;
  } }, qualify: async value => { if (value?.id === 'B') {
    secondQualifying = true; await qualified.promise;
  } } });
  const a = entry('A'), b = entry('B');
  const first = f.coordinator.acceptFullState({ state: [a] });
  await until(() => firstPublishing);
  const second = f.coordinator.acceptFullState({ state: [a, b] });
  await until(() => secondQualifying);
  published.resolve(); qualified.resolve();
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(f.adds.map(value => value.clientUserMessageId), ['A', 'B']);
});

test('owner loss during publication leaves durable outbox pending', async t => {
  const paused = deferred<void>(); let publishing = false;
  const f = await fixture(t, { publish: async () => { publishing = true; await paused.promise; } });
  const acceptance = f.coordinator.acceptFullState({ state: [entry('A')] });
  await until(() => publishing);
  f.loseSource(); paused.resolve();
  await assert.rejects(acceptance, /owner source changed/);
  assert.equal(f.journal.publicationStatus().pending, true);
});

test('publication rechecks version after awaited owner proof and skips consumed stale state', async t => {
  const pause = deferred<void>(); let count = 0, entered = false;
  const f = await fixture(t, { confirmOwner: async () => {
    if (++count === 3) { entered = true; await pause.promise; }
  } });
  const acceptance = f.coordinator.acceptFullState({ state: [entry('A')] });
  await until(() => entered);
  await f.coordinator.consumeUserMessage(event(f));
  pause.resolve();
  await acceptance;
  await f.coordinator.publishLatest();
  assert.deepEqual(f.publications.map(value => value.ids), [[]]);
});

test('hydration fails closed if consume changes snapshot during awaited owner proof', async t => {
  const pause = deferred<void>(); let block = false, entered = false;
  const f = await fixture(t, { confirmOwner: async () => { if (block && !entered) {
    entered = true; await pause.promise;
  } } });
  await f.coordinator.acceptFullState({ state: [entry('A')] });
  block = true;
  const hydration = f.coordinator.hydrateFollower();
  await until(() => entered);
  await f.coordinator.consumeUserMessage(event(f));
  pause.resolve();
  await assert.rejects(hydration, /hydration snapshot changed/);
  await f.coordinator.publishLatest();
  assert.equal(f.publications.filter(value => value.kind === 'hydrate').length, 0);
});

test('hydration after outbox ACK reads current queue then empty consumed state', async t => {
  const f = await fixture(t);
  await f.coordinator.acceptFullState({ state: [entry('A')] });
  await f.coordinator.hydrateFollower();
  assert.deepEqual(f.publications.at(-1), { ids: ['A'], kind: 'hydrate' });
  await f.coordinator.consumeUserMessage(event(f));
  await f.coordinator.publishLatest();
  await f.coordinator.hydrateFollower();
  assert.deepEqual(f.publications.at(-1), { ids: [], kind: 'hydrate' });
});

test('synthetic Desktop-shaped entry uses the repo mapper and retains complete qualification evidence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vkodex-stock-mapper-'));
  const taskId = randomUUID(), ownerEpoch = randomUUID(), cwd = 'C:/isolated';
  const journal = new NativeStockQueueJournal({ filePath: path.join(directory, 'journal.sqlite'), taskId, ownerEpoch, sourceGeneration: 'source-1' });
  t.after(() => journal.close());
  const settings = { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never',
    approvalsReviewer: 'user', permissions: ':danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' },
    model: 'synthetic-model', serviceTier: null, effort: 'medium', summary: null,
    collaborationMode: { mode: 'default', settings: { model: 'synthetic-model', reasoning_effort: 'medium',
      developer_instructions: 'synthetic built-in' } }, personality: 'pragmatic' };
  const requested = { mode: 'default', settings: { model: 'synthetic-model',
    reasoning_effort: 'medium', developer_instructions: null } };
  const qualification: NativeStockTextQualification & StockAdmissionQualification = {
    taskId, ownerEpoch, confirmed: true, completeQueueAndHistory: true,
    exclusiveLifecycleWriter: true, ambientContextEmpty: true, effectiveSettings: settings,
    initializationReceipt: { taskId, ownerEpoch, confirmed: true,
      expansionKind: 'builtin-default-instructions', requestedCollaborationMode: requested,
      confirmedEffectiveCollaborationMode: settings.collaborationMode,
      requestedSettings: { ...settings, sandboxPolicy: null, serviceTier: 'default',
        collaborationMode: requested }, confirmedEffectiveSettings: settings },
    tierResolution: { taskId, ownerEpoch, requested: 'default', effective: null,
      fastModeAllowed: false, confirmed: true },
  };
  const text = 'PUBLIC_OK';
  const native = { id: randomUUID(), text, cwd, createdAt: 1780000000000,
    context: { prompt: text, turnTrigger: 'composer', workspaceRoots: [cwd],
      usedDictation: false, existingWorkspaceRoot: null, localProjectId: null,
      fileAttachments: [] as string[], addedFiles: [] },
    responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    submissionOptions: { executionHostId: 'local', agentMode: 'full-access',
      permissionProfileId: ':danger-full-access', serviceTier: 'default',
      shouldSendPermissionOverrides: false, usePermissionSelection: false,
      permissionSelection: null,
      collaborationMode: requested,
      clientUserMessageId: 'separate-native-option-id' },
    writingBlockAdditionalContext: null, mentionedBrowserFamilies: [], submissionIntent: 'send-now',
    submission: { hostId: 'local', status: 'pending', queueModeOverride: 'queue' } };
  const calls: Request[] = [];
  const coordinator = new NativeStockAdmission<typeof native, typeof qualification>({
    taskId, ownerEpoch, journal,
    identifyEntry: value => ({ id: value.id, fingerprint: createHash('sha256')
      .update(JSON.stringify(value)).digest('hex') }),
    qualify: () => qualification,
    prepareEntry: value => {
      const prepared = prepareNativeStockTextEntry(value, qualification, taskId, ownerEpoch);
      return { input: prepared.queueAdd.input,
        forwardedUpstream: prepared.localAttribution.forwardedUpstream };
    },
    confirmOwner: () => true, assertOwnerCurrent: () => true, assertDispatchCurrent: () => true,
    queueAdd: request => {
      calls.push(request);
      return { queuedSubmission: { id: 'stock-1', clientUserMessageId: request.clientUserMessageId,
        input: request.input } };
    },
    publish: () => {},
  });
  assert.deepEqual(await coordinator.acceptFullState({ state: [native] }), { ok: true });
  assert.deepEqual(calls[0]?.input, [{ type: 'text', text: `${text}\n`, text_elements: [] }]);
  assert.equal(calls[0]?.clientUserMessageId, native.id);
  assert.deepEqual(journal.readOperation(native.id)?.admissionEvidence, qualification);
});
