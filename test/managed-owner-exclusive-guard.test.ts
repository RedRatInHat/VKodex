import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BridgeStore } from '../src/bridge/store.js';
import { BridgeRuntime } from '../src/bridge/runtime.js';
import { observeAppServerTaskState } from '../src/codex/app-server-task-state.js';
import { ManagedOwnerExclusiveRouteGuard } from '../src/bridge/managed-owner-exclusive-guard.js';
import { ManagedClaimBoundVkIngress } from '../src/bridge/managed-claim-bound-vk-ingress.js';
import { ManagedWorkerControlRefusedError, ManagedWorkerControlUnknownError } from '../src/desktop/managed-worker-control-client.js';
import type { ManagedOwnerIngressResolver } from '../src/bridge/managed-owner-route-resolver.js';
import { createDesktopRouting } from '../src/desktop/desktop-routing.js';
import type { ManagedOwnerRouteObserver } from '../src/bridge/managed-owner-observed-task-state-transport.js';
import { RoutedCodexTasks } from '../src/core/codex-task-router.js';
import { ActionRejectedError, type CodexTasks, type TaskRef } from '../src/core/codex-tasks.js';
import { ObserverOnlyTaskStateTransport, RoutedTaskStateTransport, TaskStateConnections, type TaskStateTransport } from '../src/core/task-state.js';
import type { BridgeChat, View } from '../src/bridge/contracts.js';

const task = (sourceId = 'source-a'): TaskRef =>
  ({ hostId: 'local', threadId: 'managed-thread', sourceId });

test('claimed facade classifies unavailable pre-submit admission as rejection without reserving authority', async () => {
  for (const error of [new ManagedWorkerControlRefusedError(), new ManagedWorkerControlUnknownError(), new Error('read unavailable'), null]) {
    const store = new BridgeStore(), operationId = randomUUID();
    const binding = store.ensureBinding({ ...task(), title: 'prewrite fixture', workspace: 'C:\\Fixture', updatedAt: 1 });
    const claim = store.transitionManagedOwner(store.claimManagedOwner(binding.id, { ownerEpoch: randomUUID(),
      canonicalHome: 'C:\\Fixture', familyRoot: task().threadId }), 'ready', { backendGeneration: 1,
      registryRevision: 3, endpointRef: randomUUID(), host: { pid: 1, birthTicks: '1' }, backend: { pid: 2, birthTicks: '2' } });
    store.recordOperation(operationId, task());
    let writes = 0;
    const scope = { ownerEpoch: claim.ownerEpoch, taskId: claim.threadId, backendGeneration: 1,
      registryRevision: 3, endpointRef: claim.evidence.endpointRef!, claimId: claim.id, claimRevision: claim.revision };
    const resolver = { isCurrent: () => true, resolveIngress: async () => ({ kind: 'statically-qualified', claim,
      scope, client: { ingressStatusClaimed: async () => { if (error) throw error;
        return { ...scope, capability: 'stock-idle-queue-v2', admissionOpen: true }; },
      submitVkClaimed: async () => { writes++; return { submissionId: 'unexpected' }; } } }),
    resolveOutcome: async () => { throw new Error('unused'); } } as unknown as ManagedOwnerIngressResolver;
    const ingress = new ManagedClaimBoundVkIngress(store, resolver);
    try {
      await assert.rejects(ingress.submitWithReceipt({ task: task(), operationId, text: 'fixture',
        beforeSend: async () => { if (!error) store.setValue(`stream-generation:${binding.id}`, store.streamGeneration(binding.id) + 1); } }), ActionRejectedError);
      assert.equal(store.hasManagedOperationAuthority(task(), operationId), false);
      assert.equal(writes, 0, 'failure during read-only admission has no mutating attempt');
    } finally { store.close(); }
  }
});

test('original durable managed accepted receipt survives unavailable worker without a status RPC', async () => {
  const store = new BridgeStore(), operationId = randomUUID();
  const binding = store.ensureBinding({ ...task(), title: 'receipt fixture', workspace: 'C:\\Fixture', updatedAt: 1 });
  const claim = store.transitionManagedOwner(store.claimManagedOwner(binding.id, { ownerEpoch: randomUUID(),
    canonicalHome: 'C:\\Fixture', familyRoot: task().threadId }), 'ready', { backendGeneration: 1,
    registryRevision: 3, endpointRef: randomUUID(), host: { pid: 1, birthTicks: '1' }, backend: { pid: 2, birthTicks: '2' } });
  store.recordOperation(operationId, task());
  store.captureManagedOperationAuthority(operationId, task(), claim, store.streamGeneration(binding.id));
  store.rememberManagedQueueReceipt(task(), operationId, 'actual-receipt');
  store.settlePromptDispatch(operationId, 'uncertain');
  let reads = 0;
  const resolver = { isCurrent: () => false, resolveIngress: async () => { throw new Error('no ingress'); },
    resolveOutcome: async () => { reads++; return { kind: 'unavailable', claim }; } } as ManagedOwnerIngressResolver;
  const ingress = new ManagedClaimBoundVkIngress(store, resolver);
  try {
    assert.deepEqual(await ingress.findQueuedSubmissionOutcome(task(), operationId), { state: 'accepted', submissionId: 'actual-receipt' });
    assert.equal(reads, 0, 'durable ACK is already a fact, worker liveness is only needed for terminal proof');
    assert.equal(store.managedQueueReceipt(operationId)?.state, 'accepted');
    await assert.rejects(ingress.scanTerminalQueuedInput(task(), operationId, null));
    assert.equal(store.managedQueueReceipt(operationId)?.state, 'accepted', 'unavailable terminal proof never clears debt');
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    for (const [state, id, turnId] of [['unknown', 'actual-receipt', null], ['accepted', '', null],
      ['accepted', 'actual-receipt', 'foreign-terminal'], ['settled', 'actual-receipt', null]]) {
      db.prepare('UPDATE bridge_managed_queue_receipts SET state = ?, submission_id = ?, terminal_turn_id = ? WHERE operation_id = ?')
        .run(state, id, turnId, operationId);
      await assert.rejects(ingress.findQueuedSubmissionOutcome(task(), operationId), /corrupt/i,
        'corrupt persisted receipt cannot attest acceptance');
    }
  } finally { store.close(); }
});

test('health settles original uncertain managed dispatch after binding detaches without replay or projection', async () => {
  const store = new BridgeStore(), operationId = randomUUID(), peerId = 2_000_000_074;
  const desktopTask = { ...task(), title: 'original dispatch', workspace: 'C:\\Fixture', updatedAt: 1 };
  const binding = store.ensureBinding(desktopTask); store.setChat(binding.id, peerId, 74);
  const claim = store.transitionManagedOwner(store.claimManagedOwner(binding.id, { ownerEpoch: randomUUID(),
    canonicalHome: desktopTask.workspace, familyRoot: task().threadId }), 'ready', { backendGeneration: 1,
    registryRevision: 3, endpointRef: randomUUID(), host: { pid: 1, birthTicks: '1' }, backend: { pid: 2, birthTicks: '2' } });
  store.recordOperation(operationId, desktopTask, 'original-inbox-fixture', binding.id, 1);
  const authority = store.captureManagedOperationAuthority(operationId, desktopTask, claim, store.streamGeneration(binding.id));
  store.settlePromptDispatch(operationId, 'uncertain');
  store.stopStreaming(binding.id);
  store.retireManagedOwner(store.transitionManagedOwner(claim, 'handoff_pending'));
  let originalReads = 0, fallback = 0;
  const delegate = { isReady: () => false, ensureOpen: async () => { throw new Error('no writer'); },
    submitWithReceipt: async () => { throw new Error('no replay'); },
    ownsOperation: (requested: TaskRef, id: string) => store.hasManagedOperationAuthority(requested, id),
    findQueuedSubmissionOutcome: async (requested: TaskRef, id: string) => {
      assert.deepEqual(requested, authority.claim); assert.equal(id, operationId); originalReads++;
      store.rememberManagedQueueReceipt(requested, id, 'original-accepted');
      return { state: 'accepted' as const, submissionId: 'original-accepted' };
    }, scanTerminalQueuedInput: async () => ({ done: true as const, turnId: null }) };
  const guard = new ManagedOwnerExclusiveRouteGuard(store, undefined, delegate);
  const routed = new RoutedCodexTasks({ findAcceptedInput: async () => { fallback++; return null; },
    findQueuedSubmissionOutcome: async () => { fallback++; return null; } } as unknown as CodexTasks, [guard]);
  const states: TaskStateTransport = { readOnly: true, subscribe: () => { throw new Error('not used'); }, close() {} };
  const chat = { send: async () => ({ peerId, conversationMessageId: 1 }), edit: async () => {}, delete: async () => {} } as unknown as BridgeChat;
  const runtime = new BridgeRuntime({ ownerId: 101, groupId: 202 }, routed, chat, store, { states,
    observe: observeAppServerTaskState, history: { enable() {}, disable() {}, poll: async () => null } }, () => 100_000);
  try {
    (runtime as unknown as { reconcileUncertainOperation(): void }).reconcileUncertainOperation();
    for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(originalReads, 1);
    assert.equal(store.operationState(operationId), 'accepted', 'original fact survives detachment');
    assert.equal(store.queuedInputs(binding.id).length, 0, 'no projection into detached/new generation');
    assert.equal(store.managedQueueReceipt(operationId)?.state, 'accepted', 'terminal proof remains outstanding');
    assert.equal(fallback, 0); assert.equal(store.pendingDeliveries().length, 0);
    const mismatched = { ...authority, claim: { ...authority.claim, sourceId: 'foreign-source' } };
    (store as unknown as { db: import('better-sqlite3').Database }).db.prepare(
      'UPDATE bridge_managed_operation_authorities SET authority = ? WHERE operation_id = ?')
      .run(JSON.stringify(mismatched), operationId);
    assert.throws(() => store.managedOperationAuthorityById(operationId), /corrupt/i,
      'existing but mismatched original authority is never absent/legacy');
  } finally { await runtime.stop(); guard.states.close(); store.close(); }
});

test('health reconciles original managed ACK debt after stream generation changes and claim retirement', async () => {
  const store = new BridgeStore();
  const desktopTask = { ...task(), title: 'receipt fixture', workspace: 'C:\\Fixture', updatedAt: 1 };
  const binding = store.ensureBinding(desktopTask), operationId = randomUUID();
  const peerId = 2_000_000_073;
  store.setChat(binding.id, peerId, 73);
  const claim = store.transitionManagedOwner(store.claimManagedOwner(binding.id, {
    ownerEpoch: randomUUID(), canonicalHome: desktopTask.workspace, familyRoot: desktopTask.threadId }),
  'ready', { backendGeneration: 1, registryRevision: 3, endpointRef: randomUUID(),
    host: { pid: 1, birthTicks: '1' }, backend: { pid: 2, birthTicks: '2' } });
  store.recordOperation(operationId, desktopTask);
  const authority = store.captureManagedOperationAuthority(operationId, desktopTask, claim,
    store.streamGeneration(binding.id));
  // The worker accepted the wire write, but the original projection has already changed.
  store.setValue(`stream-generation:${binding.id}`, authority.streamGeneration + 1);
  const corruptId = randomUUID();
  // A damaged earlier debt must not prevent independent later debt checks.
  store.recordOperation(corruptId, desktopTask);
  store.captureManagedOperationAuthority(corruptId, desktopTask, claim, authority.streamGeneration + 1);
  store.rememberManagedQueueReceipt(desktopTask, corruptId, 'corrupt-receipt');
  (store as unknown as { db: import('better-sqlite3').Database }).db.prepare(
    'UPDATE bridge_managed_operation_authorities SET authority = ? WHERE operation_id = ?').run('{', corruptId);
  store.rememberManagedQueueReceipt(desktopTask, operationId, 'actual-receipt');
  store.settlePromptDispatch(operationId, 'accepted');
  store.rememberQueuedInput(binding.id, operationId, 'actual-receipt');
  assert.equal(store.queuedInputs(binding.id).length, 0, 'old receipt is not a new-stream queued marker');
  store.retireManagedOwner(store.transitionManagedOwner(claim, 'handoff_pending'));
  let scans = 0, fallback = 0, time = 100_000, terminal = false;
  const states: TaskStateTransport = { readOnly: true, subscribe: requested => ({ task: requested,
    readOnly: true, start: async () => {}, verifyOwner: async () => {}, close() {} }), close() {} };
  const delegate = { isReady: () => false, ensureOpen: async () => { throw new Error('no writer'); },
    submitWithReceipt: async () => { throw new Error('no replay'); },
    ownsOperation: (requested: TaskRef, id: string) => store.hasManagedOperationAuthority(requested, id),
    findQueuedSubmissionOutcome: async () => ({ state: 'accepted' as const, submissionId: 'actual-receipt' }),
    scanTerminalQueuedInput: async (requested: TaskRef, id: string) => {
      assert.deepEqual(requested, authority.claim); assert.equal(id, operationId); scans++;
      return { done: true as const, turnId: terminal ? 'actual-terminal' : null };
    } };
  const guard = new ManagedOwnerExclusiveRouteGuard(store, undefined, delegate);
  const routed = new RoutedCodexTasks({ listTasks: async () => [desktopTask],
    scanTerminalQueuedInput: async () => { fallback++; throw new Error('foreign history'); } } as unknown as CodexTasks, [guard]);
  const chat = { send: async () => ({ peerId, conversationMessageId: 1 }), edit: async () => {}, delete: async () => {} } as unknown as BridgeChat;
  const runtime = new BridgeRuntime({ ownerId: 101, groupId: 202 }, routed, chat, store, { states,
    observe: observeAppServerTaskState, history: { enable() {}, disable() {}, poll: async () => null } },
  () => time, undefined, undefined, 10_000_000);
  const drain = async () => { await runtime.tick(false);
    for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await drain();
    assert.equal(scans, 1, 'health scans original accepted receipt independently of current projection');
    assert.equal(store.managedQueueReceipt(operationId)?.state, 'accepted', 'negative history never clears ACK debt');
    terminal = true; time += 60 * 60_000 + 1;
    await drain();
    assert.deepEqual(store.managedQueueReceipt(operationId), {
      state: 'settled', submissionId: 'actual-receipt', turnId: 'actual-terminal' });
    assert.equal(store.queuedInputs(binding.id).length, 0);
    assert.equal(fallback, 0, 'retirement cannot redirect canonical proof to the current owner');
    assert.deepEqual(store.managedOperationAuthority(desktopTask, operationId), authority);
    time += 30_001; await drain(); assert.equal(scans, 2, 'settled debt is not scanned again');
  } finally { await runtime.stop(); guard.states.close(); store.close(); }
});

test('sole managed guard sends foreground once and resolves original operations after claim retirement', async () => {
  const store = new BridgeStore();
  const binding = store.ensureBinding({ ...task(), title: 'fixture', workspace: 'C:\\Fixture', updatedAt: 1 });
  const registering = store.claimManagedOwner(binding.id, { ownerEpoch: randomUUID(), canonicalHome: 'C:\\Fixture', familyRoot: task().threadId });
  const claim = store.transitionManagedOwner(registering, 'ready', { backendGeneration: 1,
    registryRevision: 3, endpointRef: randomUUID(), host: { pid: 1, birthTicks: '1' }, backend: { pid: 2, birthTicks: '2' } });
  const operationId = randomUUID();
  let fallback = 0, sent = 0;
  const delegate = { isReady: () => true, ensureOpen: async () => {},
    submitWithReceipt: async () => { sent++; return { mode: 'queue' as const, submissionId: 'actual-receipt' }; },
    ownsOperation: (_task: TaskRef, id: string) => id === operationId,
    findQueuedSubmissionOutcome: async () => ({ state: 'accepted' as const, submissionId: 'actual-receipt' }),
    scanTerminalQueuedInput: async () => ({ done: true as const, turnId: 'terminal-turn' }) };
  const guard = new ManagedOwnerExclusiveRouteGuard(store, undefined, delegate);
  const routed = new RoutedCodexTasks({ findQueuedSubmissionOutcome: async () => { fallback++; return null; } } as unknown as CodexTasks, [guard]);
  try {
    assert.deepEqual(await routed.submitWithReceipt({ task: task(), operationId, text: 'fixture text' }),
      { mode: 'queue', submissionId: 'actual-receipt' });
    store.retireManagedOwner(store.transitionManagedOwner(claim, 'handoff_pending'));
    assert.equal(guard.owns(task()), false, 'historical operation never captures fresh commands');
    assert.deepEqual(await routed.findQueuedSubmissionOutcome(task(), operationId), { state: 'accepted', submissionId: 'actual-receipt' });
    assert.deepEqual(await routed.scanTerminalQueuedInput(task(), operationId, null), { done: true, turnId: 'terminal-turn' });
    assert.equal(fallback, 0); assert.equal(sent, 1);
  } finally { guard.states.close(); store.close(); }
});

test('passive production routing fences every exclusive owner, not just managed claims', () => {
  const store = new BridgeStore();
  let subscribed = 0;
  const native: TaskStateTransport = { readOnly: true, subscribe: requested => {
    subscribed++;
    return { task: requested, readOnly: true, start: async () => {}, verifyOwner: async () => {}, close() {} };
  }, close() {} };
  const exclusive = { routingPolicy: 'exclusive' as const, owns: (requested: TaskRef) => requested.sourceId === 'source-a',
    states: { subscribe: native.subscribe, close() {} } } as import('../src/core/codex-task-router.js').CodexTaskOwner &
      import('../src/core/task-state.js').TaskStateOwnerRoute;
  const routed = createDesktopRouting({} as CodexTasks, native, [exclusive], store);
  try {
    assert.throws(() => routed.passiveStates!.subscribe(task(), () => {}, () => {}), ActionRejectedError);
    assert.equal(subscribed, 0);
    routed.passiveStates!.subscribe(task('other-source'), () => {}, () => {}).close();
    assert.equal(subscribed, 1, 'fence is task scoped');
  } finally { routed.states.close(); store.close(); }
});

test('passive observation retires if an exclusive claim appears before start or during a stream', async () => {
  for (const phase of ['before-start', 'during-stream'] as const) {
    let blocked = false, started = 0, verified = 0, closed = 0;
    let emit!: (state: Record<string, unknown>, initial: boolean) => void;
    const native: TaskStateTransport = { readOnly: true, subscribe: (requested, onState) => {
      emit = onState;
      return { task: requested, readOnly: true, start: async () => { started++; onState({ value: 'initial' }, true); },
        verifyOwner: async () => { verified++; }, close() { closed++; } };
    }, close() {} };
    const transport = new ObserverOnlyTaskStateTransport(native, () => blocked);
    const seen: string[] = [], errors: Error[] = [];
    const stream = transport.subscribe(task(), state => seen.push(String(state.value)), error => errors.push(error));
    try {
      if (phase === 'during-stream') await stream.start();
      blocked = true;
      if (phase === 'before-start') await assert.rejects(stream.start(), ActionRejectedError);
      emit({ value: 'stale' }, false);
      emit({ value: 'stale-again' }, false);
      await assert.rejects(stream.verifyOwner(), ActionRejectedError);
      assert.equal(started, phase === 'before-start' ? 0 : 1);
      assert.equal(verified, 0);
      assert.deepEqual(seen, phase === 'before-start' ? [] : ['initial']);
      assert.equal(errors.length, 1, 'claim loss is reported only once');
      assert.equal(closed, 1, 'upstream is retired immediately');
      blocked = false;
      await assert.rejects(stream.start(), ActionRejectedError, 'retiring a claim cannot resurrect the old stream');
    } finally { stream.close(); transport.close(); }
    assert.equal(closed, 1);
  }
});

test('passive start and verification recheck claims after asynchronous native work', async () => {
  for (const phase of ['start', 'verify'] as const) {
    let blocked = false, release!: () => void, closed = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const native: TaskStateTransport = { readOnly: true, subscribe: requested => ({
      task: requested, readOnly: true, start: async () => { if (phase === 'start') await pending; },
      verifyOwner: async () => { if (phase === 'verify') await pending; }, close() { closed++; },
    }), close() {} };
    const transport = new ObserverOnlyTaskStateTransport(native, () => blocked);
    const errors: Error[] = [];
    const stream = transport.subscribe(task(), () => {}, error => errors.push(error));
    try {
      if (phase === 'verify') await stream.start();
      const work = phase === 'start' ? stream.start() : stream.verifyOwner();
      blocked = true; release();
      await assert.rejects(work, ActionRejectedError);
      assert.equal(closed, 1);
      assert.equal(errors.length, 1);
    } finally { stream.close(); transport.close(); }
  }
});

test('an unreadable passive claim retires the stream even if cleanup and the error observer throw', async () => {
  let unreadable = false, closed = 0, errors = 0;
  let emit!: (state: Record<string, unknown>, initial: boolean) => void;
  const native: TaskStateTransport = { readOnly: true, subscribe: (requested, onState) => {
    emit = onState;
    return { task: requested, readOnly: true, start: async () => {}, verifyOwner: async () => {},
      close() { closed++; throw new Error('fixture cleanup error'); } };
  }, close() {} };
  const transport = new ObserverOnlyTaskStateTransport(native, () => {
    if (unreadable) throw new Error('fixture claim read error');
    return false;
  });
  const seen: unknown[] = [];
  const stream = transport.subscribe(task(), state => seen.push(state), () => { errors++; throw new Error('fixture observer error'); });
  await stream.start();
  unreadable = true;
  assert.doesNotThrow(() => emit({ value: 'unknown-owner' }, false));
  unreadable = false;
  emit({ value: 'late' }, false);
  await assert.rejects(stream.verifyOwner(), ActionRejectedError);
  stream.close();
  assert.deepEqual(seen, []);
  assert.equal(closed, 1); assert.equal(errors, 1);
});

test('a synchronous native claim rejection closes its handle without breaking connection installation', async () => {
  let blocked = false, started = 0, closed = 0;
  const native: TaskStateTransport = { readOnly: true, subscribe: (requested, onState) => {
    blocked = true;
    onState({ value: 'stale' }, true);
    return { task: requested, readOnly: true, start: async () => { started++; }, verifyOwner: async () => {},
      close() { closed++; } };
  }, close() {} };
  const transport = new ObserverOnlyTaskStateTransport(native, () => blocked);
  const connections = new TaskStateConnections(transport);
  const seen: unknown[] = [];
  await assert.rejects(connections.connect('fixture', task(), state => seen.push(state), () => {}), ActionRejectedError);
  assert.equal(started, 0); assert.equal(closed, 1);
  assert.equal(connections.has('fixture'), false);
  assert.deepEqual(seen, []);
  await connections.stop();
});

test('exact non-retired claim dynamically takes exclusive route through every health state', async () => {
  const store = new BridgeStore();
  let baseWrites = 0, baseStreams = 0, baseOutcomes = 0;
  const base = {
    submitWithReceipt: async () => { baseWrites++; return { mode: 'start' as const, turnId: 'base' }; },
    submit: async () => { baseWrites++; },
    findQueuedSubmissionOutcome: async () => { baseOutcomes++; return null; },
  } as unknown as CodexTasks;
  const baseStates: TaskStateTransport = { subscribe: requested => {
    baseStreams++;
    return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const guard = new ManagedOwnerExclusiveRouteGuard(store);
  const routed = new RoutedCodexTasks(base, [guard]);
  const states = new RoutedTaskStateTransport(baseStates, [guard]);
  const request = { operationId: randomUUID(), task: task(), text: 'test' };
  try {
    assert.deepEqual(await routed.submitWithReceipt(request), { mode: 'start', turnId: 'base' });
    assert.equal(guard.owns(task()), false);
    const binding = store.ensureBinding({ ...task(), title: 'Managed', workspace: 'C:\\ManagedFixture', updatedAt: 1 });
    const epoch = randomUUID();
    const registering = store.claimManagedOwner(binding.id, { ownerEpoch: epoch,
      canonicalHome: 'C:\\ManagedFixture', familyRoot: 'managed-thread' });
    assert.equal(guard.owns(task()), true);
    assert.equal(guard.owns(task('source-b')), false);
    let claim = registering;
    for (const state of ['registering', 'ready', 'unavailable', 'handoff_pending'] as const) {
      if (state === 'ready') claim = store.transitionManagedOwner(claim, state, {
        backendGeneration: 1, registryRevision: 1, endpointRef: randomUUID(),
        host: { pid: 101, birthTicks: '10' }, backend: { pid: 102, birthTicks: '11' },
      });
      else if (state !== 'registering') claim = store.transitionManagedOwner(claim, state);
      assert.equal(store.managedOwner(task())?.state, state);
      assert.equal(await routed.ownerAdapterStatus!(task()), 'missing');
      await assert.rejects(routed.submitWithReceipt(request), ActionRejectedError);
      await assert.rejects(routed.queue!(request), ActionRejectedError);
      await assert.rejects(routed.findQueuedSubmissionOutcome!(task(), request.operationId), ActionRejectedError);
      await assert.rejects(routed.ensureOpen!(task()), ActionRejectedError);
      const stream = states.subscribe(task(), () => {}, () => {});
      await assert.rejects(stream.start(), ActionRejectedError);
      await assert.rejects(stream.verifyOwner(), ActionRejectedError);
      stream.close();
      assert.equal(baseWrites, 1);
      assert.equal(baseOutcomes, 0);
      assert.equal(baseStreams, 0);
    }
    store.retireManagedOwner(claim);
    assert.equal(guard.owns(task()), false);
    assert.deepEqual(await routed.submitWithReceipt(request), { mode: 'start', turnId: 'base' });
    const stream = states.subscribe(task(), () => {}, () => {});
    await stream.start(); stream.close();
    assert.equal(baseWrites, 2);
    assert.equal(baseStreams, 1);
  } finally { states.close(); store.close(); }
});

test('production route composition fences both commands and state before a managed worker is ready', async () => {
  const store = new BridgeStore();
  let baseWrites = 0, baseStreams = 0, profileWrites = 0, profileStreams = 0;
  const base = { submitWithReceipt: async () => { baseWrites++; return { mode: 'start' as const, turnId: 'base' }; } } as unknown as CodexTasks;
  const baseStates: TaskStateTransport = { subscribe: requested => {
    baseStreams++; return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const profile = { owns: () => true, submitWithReceipt: async () => {
    profileWrites++; return { mode: 'start' as const, turnId: 'profile' };
  }, states: { subscribe: (requested: TaskRef) => {
    profileStreams++; return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} } } as unknown as import('../src/core/codex-task-router.js').CodexTaskOwner &
    import('../src/core/task-state.js').TaskStateOwnerRoute;
  const routed = createDesktopRouting(base, baseStates, [profile], store);
  const request = { operationId: randomUUID(), task: task(), text: 'test' };
  try {
    assert.deepEqual(await routed.tasks.submitWithReceipt!(request), { mode: 'start', turnId: 'profile' });
    const binding = store.ensureBinding({ ...task(), title: 'Managed', workspace: 'C:\\ManagedFixture', updatedAt: 1 });
    store.claimManagedOwner(binding.id, { ownerEpoch: randomUUID(),
      canonicalHome: 'C:\\ManagedFixture', familyRoot: task().threadId });
    await assert.rejects(routed.tasks.submitWithReceipt!(request), ActionRejectedError);
    const stream = routed.states.subscribe(task(), () => {}, () => {});
    await assert.rejects(stream.start(), ActionRejectedError);
    stream.close();
    assert.equal(profileWrites, 1); assert.equal(profileStreams, 0);
    assert.equal(baseWrites, 0); assert.equal(baseStreams, 0);
    assert.deepEqual(await routed.tasks.submitWithReceipt!({ ...request, task: task('other-source') }),
      { mode: 'start', turnId: 'profile' });
  } finally { routed.states.close(); store.close(); }
});

test('production composition observes only the exact ready worker and fences stale frames', async () => {
  const store = new BridgeStore();
  const binding = store.ensureBinding({ ...task(), title: 'Managed', workspace: 'C:\\ManagedFixture', updatedAt: 1 });
  const epoch = randomUUID();
  const registering = store.claimManagedOwner(binding.id, { ownerEpoch: epoch,
    canonicalHome: 'C:\\ManagedFixture', familyRoot: task().threadId });
  const claim = store.transitionManagedOwner(registering, 'ready', {
    backendGeneration: 1, registryRevision: 1, endpointRef: randomUUID(),
    host: { pid: 101, birthTicks: '10' }, backend: { pid: 102, birthTicks: '11' },
  });
  let baseStreams = 0, profileStreams = 0, resolved = 0;
  let emit!: (state: Record<string, unknown>, initial: boolean) => void;
  const workerStates: TaskStateTransport = { readOnly: true, subscribe: (requested, onState) => {
    emit = onState;
    return { task: requested, readOnly: true, start: async () => onState({ kind: 'app-server', threadId: task().threadId }, true),
      verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const observer: ManagedOwnerRouteObserver = {
    isCurrent: expected => store.managedOwner(task())?.revision === expected.revision,
    async resolve() { resolved++; return { kind: 'statically-qualified', claim,
      controlStatus: async () => ({ ownerEpoch: epoch, taskId: task().threadId,
        hostState: 'running', backendGeneration: 1, nativeState: 'connected', nativeRevision: 1 }),
      states: workerStates }; },
  };
  const base = {} as CodexTasks;
  const baseStates: TaskStateTransport = { subscribe: requested => {
    baseStreams++; return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const profile = { owns: () => true, states: { subscribe: (requested: TaskRef) => {
    profileStreams++; return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} } } as unknown as import('../src/core/codex-task-router.js').CodexTaskOwner &
    import('../src/core/task-state.js').TaskStateOwnerRoute;
  const routed = createDesktopRouting(base, baseStates, [profile], store, observer);
  const seen: boolean[] = [];
  try {
    const stream = routed.states.subscribe(task(), (_state, initial) => seen.push(initial), () => {});
    await stream.start();
    assert.equal(resolved, 1); assert.deepEqual(seen, [true]);
    assert.equal(baseStreams, 0); assert.equal(profileStreams, 0);
    store.transitionManagedOwner(claim, 'unavailable');
    emit({ kind: 'app-server', threadId: task().threadId }, false);
    assert.deepEqual(seen, [true]);
    assert.equal(baseStreams, 0); assert.equal(profileStreams, 0);
    stream.close();
  } finally { routed.states.close(); store.close(); }
});

test('claim for one source never captures another source or thread', async () => {
  const store = new BridgeStore();
  const guard = new ManagedOwnerExclusiveRouteGuard(store);
  try {
    const binding = store.ensureBinding({ ...task(), title: 'Managed', workspace: 'C:\\ManagedFixture', updatedAt: 1 });
    store.claimManagedOwner(binding.id, { ownerEpoch: randomUUID(),
      canonicalHome: 'C:\\ManagedFixture', familyRoot: 'managed-thread' });
    assert.equal(guard.owns(task()), true);
    assert.equal(guard.owns(task('source-b')), false);
    assert.equal(guard.owns({ ...task(), threadId: 'other-thread' }), false);
    assert.equal(guard.owns({ ...task(), hostId: 'remote' }), false);
  } finally { store.close(); }
});

test('exclusive managed observation uses the exact claim without opening a fallback writer stream', async () => {
  const store = new BridgeStore();
  let baseStreams = 0, resolved = 0, observed = 0, closed = 0, closedSources = 0;
  const baseStates: TaskStateTransport = { subscribe: requested => {
    baseStreams++;
    return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const binding = store.ensureBinding({ ...task(), title: 'Managed', workspace: 'C:\\ManagedFixture', updatedAt: 1 });
  const epoch = randomUUID();
  const registering = store.claimManagedOwner(binding.id, { ownerEpoch: epoch,
    canonicalHome: 'C:\\ManagedFixture', familyRoot: 'managed-thread' });
  const claim = store.transitionManagedOwner(registering, 'ready', {
    backendGeneration: 1, registryRevision: 1, endpointRef: randomUUID(),
    host: { pid: 101, birthTicks: '10' }, backend: { pid: 102, birthTicks: '11' },
  });
  let emitError!: () => void; let reported = 0;
  const workerStates: TaskStateTransport = { readOnly: true, subscribe: (requested, _onState, onError) => {
    emitError = () => onError(new Error('private state stream failed'));
    return { task: requested, readOnly: true,
    start: async () => { observed++; }, verifyOwner: async () => {}, close: () => { closed++; },
    };
  }, close: () => { closedSources++; } };
  const resolver: ManagedOwnerRouteObserver = {
    isCurrent: current => store.managedOwner(task())?.revision === current.revision,
    async resolve() { resolved++; return { kind: 'statically-qualified' as const, claim,
      controlStatus: async () => ({ ownerEpoch: epoch, taskId: task().threadId,
        hostState: 'running' as const, backendGeneration: 1,
        nativeState: 'connected' as const, nativeRevision: 1 }),
      states: workerStates }; },
  };
  const guard = new ManagedOwnerExclusiveRouteGuard(store, resolver);
  const states = new RoutedTaskStateTransport(baseStates, [guard]);
  try {
    const stream = states.subscribe(task(), () => {}, () => { reported++; });
    assert.equal(resolved, 0, 'subscription remains lazy');
    await stream.start(); await stream.verifyOwner();
    assert.equal(resolved, 1); assert.equal(observed, 1); assert.equal(baseStreams, 0);
    emitError();
    assert.equal(reported, 1);
    assert.equal(closedSources, 1, 'stream failure releases the private state source');
    stream.close(); assert.ok(closed >= 1);
    store.transitionManagedOwner(claim, 'unavailable');
    const stale = states.subscribe(task(), () => {}, () => {});
    await assert.rejects(stale.start());
    assert.equal(baseStreams, 0, 'claim loss never falls back to the base writer');
    assert.equal(closedSources, 2, 'failed start closes its source automatically');
    states.close();
    assert.equal(closedSources, 2, 'failed stream is no longer retained by the guard');
  } finally { states.close(); store.close(); }
});

test('managed native-origin progress and final reach VK once without a second route or writer', async () => {
  const store = new BridgeStore();
  const access = { ownerId: 101, groupId: 202 };
  const peerId = 2_000_000_017;
  const desktopTask = { ...task(), title: 'Managed', workspace: 'C:\\ManagedFixture', updatedAt: 1 };
  const binding = store.ensureBinding(desktopTask);
  store.setChat(binding.id, peerId, 17);
  const epoch = randomUUID();
  const registering = store.claimManagedOwner(binding.id, { ownerEpoch: epoch,
    canonicalHome: desktopTask.workspace, familyRoot: task().threadId });
  const claim = store.transitionManagedOwner(registering, 'ready', {
    backendGeneration: 1, registryRevision: 1, endpointRef: randomUUID(),
    host: { pid: 101, birthTicks: '10' }, backend: { pid: 102, birthTicks: '11' },
  });
  let baseStreams = 0, profileStreams = 0, writes = 0;
  let emit!: (state: Record<string, unknown>, initial: boolean) => void;
  let time = 1_000_000;
  const snapshot = (turns: readonly Record<string, unknown>[], runtimeStatus: string) => ({
    kind: 'app-server', threadId: task().threadId, title: desktopTask.title,
    cwd: desktopTask.workspace, model: 'fixture-model', effort: 'low', runtimeStatus,
    context: null, questions: [], turns,
  });
  const privateStates: TaskStateTransport = { readOnly: true, subscribe: (requested, onState) => {
    emit = onState as typeof emit;
    return { task: requested, readOnly: true, start: async () => onState(snapshot([], 'active'), true),
      verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const observer: ManagedOwnerRouteObserver = {
    isCurrent: expected => store.managedOwner(task())?.revision === expected.revision,
    async resolve() { return { kind: 'statically-qualified', claim,
      controlStatus: async () => ({ ownerEpoch: epoch, taskId: task().threadId,
        hostState: 'running', backendGeneration: 1, nativeState: 'connected', nativeRevision: 1 }),
      states: privateStates }; },
  };
  const base = {
    listTasks: async () => [desktopTask],
    submitWithReceipt: async () => { writes++; return { mode: 'start' as const, turnId: 'base' }; },
  } as unknown as CodexTasks;
  const baseStates: TaskStateTransport = { readOnly: true, subscribe: requested => {
    baseStreams++;
    return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} };
  const profile = { owns: () => true, submitWithReceipt: async () => {
    writes++; return { mode: 'start' as const, turnId: 'profile' };
  }, states: { subscribe: (requested: TaskRef) => {
    profileStreams++;
    return { task: requested, start: async () => {}, verifyOwner: async () => {}, close: () => {} };
  }, close: () => {} } } as unknown as import('../src/core/codex-task-router.js').CodexTaskOwner &
    import('../src/core/task-state.js').TaskStateOwnerRoute;
  const routed = createDesktopRouting(base, baseStates, [profile], store, observer);
  const sent: View[] = [], edited: View[] = [];
  const chat = { async send(_peer: number, view: View) {
    sent.push(view); return { peerId, conversationMessageId: sent.length };
  }, async edit(_handle: unknown, view: View) { edited.push(view); }, async delete() {} } as unknown as BridgeChat;
  const history = { enable() {}, disable() {}, async poll() { return null; } };
  const runtime = new BridgeRuntime(access, routed.tasks, chat, store,
    { states: routed.states, passiveStates: routed.passiveStates!, observe: observeAppServerTaskState, history }, () => time,
    undefined, undefined, 10_000_000);
  const drain = async () => {
    await runtime.tick(true, binding.id);
    for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    await drain();
    const user = { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'Native request' }] };
    const progress = { type: 'agentMessage', id: 'progress-1', phase: 'commentary', text: 'Native progress' };
    const running = { id: 'turn-1', status: 'inProgress', startedAt: 1_001_000, items: [user, progress], error: null };
    time += 2_000;
    emit(snapshot([running], 'active'), false);
    await drain();
    assert.equal(store.getValue<{ lastObservedAt: number }>(`projection:${binding.id}`)?.lastObservedAt,
      time, 'native snapshot reached runtime observer');
    assert.ok(store.pendingDeliveries().length || sent.length, 'native snapshot produced VK delivery');
    assert.equal(sent.filter(view => view.text.includes('Native request')).length, 1);
    assert.equal(sent.filter(view => view.text.includes('Native progress')).length, 1);

    const final = { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: 'Native final' };
    const next = { id: 'turn-2', status: 'inProgress', startedAt: 1_001_500, items: [], error: null };
    const completed = { ...running, status: 'completed', items: [user, progress, final] };
    emit(snapshot([completed, next], 'active'), false);
    await drain();
    assert.equal(sent.filter(view => view.text.includes('Native final')).length, 1);
    emit(snapshot([completed, next], 'active'), false);
    await drain();
    assert.equal(sent.filter(view => view.text.includes('Native final')).length, 1);
    assert.equal(baseStreams, 0);
    assert.equal(profileStreams, 0);
    assert.equal(writes, 0);

    store.transitionManagedOwner(claim, 'unavailable');
    emit(snapshot([completed, { ...next, items: [
      { type: 'agentMessage', id: 'late-1', phase: 'commentary', text: 'Stale progress' }] }], 'active'), false);
    await drain();
    assert.equal(sent.some(view => view.text.includes('Stale progress')), false);
    assert.equal(edited.some(view => view.text.includes('Stale progress')), false);
    assert.equal(store.pendingDeliveries().some(delivery =>
      delivery.view.text.includes('Stale progress')), false);
    assert.equal(baseStreams, 0);
    assert.equal(profileStreams, 0);
    assert.equal(writes, 0);
  } finally { await runtime.stop(); routed.states.close(); store.close(); }
});
