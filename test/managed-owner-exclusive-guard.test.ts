import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BridgeStore } from '../src/bridge/store.js';
import { ManagedOwnerExclusiveRouteGuard } from '../src/bridge/managed-owner-exclusive-guard.js';
import { createDesktopRouting } from '../src/desktop/desktop-routing.js';
import type { ManagedOwnerRouteObserver } from '../src/bridge/managed-owner-observed-task-state-transport.js';
import { RoutedCodexTasks } from '../src/core/codex-task-router.js';
import { ActionRejectedError, type CodexTasks, type TaskRef } from '../src/core/codex-tasks.js';
import { RoutedTaskStateTransport, type TaskStateTransport } from '../src/core/task-state.js';

const task = (sourceId = 'source-a'): TaskRef =>
  ({ hostId: 'local', threadId: 'managed-thread', sourceId });

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
  const workerStates: TaskStateTransport = { subscribe: (requested, onState) => {
    emit = onState;
    return { task: requested, start: async () => onState({ kind: 'app-server', threadId: task().threadId }, true),
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
  const workerStates: TaskStateTransport = { subscribe: (requested, _onState, onError) => {
    emitError = () => onError(new Error('private state stream failed'));
    return { task: requested,
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
