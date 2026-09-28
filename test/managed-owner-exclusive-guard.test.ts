import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BridgeStore } from '../src/bridge/store.js';
import { ManagedOwnerExclusiveRouteGuard } from '../src/bridge/managed-owner-exclusive-guard.js';
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
