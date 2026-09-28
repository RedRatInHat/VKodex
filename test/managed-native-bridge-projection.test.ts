import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjection, applyNotification } from '../src/codex/managed-native-projection.js';
import { projectManagedNativeBridgeState } from '../src/codex/managed-native-bridge-projection.js';
import { observeAppServerTaskState } from '../src/codex/app-server-task-state.js';

const taskId = '12345678-1234-4234-8234-123456789abc';
const start = { thread: { id: taskId, turns: [] }, cwd: 'C:/work', model: 'gpt-6-sol',
  reasoningEffort: 'low', approvalPolicy: 'never', sandbox: { type: 'readOnly' },
  activePermissionProfile: null, runtimeWorkspaceRoots: [], serviceTier: null };
const read = { thread: { id: taskId, turns: [], status: { type: 'idle' },
  createdAt: 10, updatedAt: 11, name: 'Owned task', cwd: 'C:/work' } };
const base = () => createProjection(start, read, { hostId: 'local', workspaceKind: 'projectless' });
const turn = (id: string, status: string, items: unknown[], startedAt = 12) =>
  ({ id, status, items, startedAt, completedAt: status === 'inProgress' ? null : 13,
    durationMs: status === 'inProgress' ? null : 1000, error: null });

test('native state becomes exact App Server bridge state with user/client, commentary, final and context', () => {
  let native = base();
  const baseline = projectManagedNativeBridgeState(native);
  assert.equal(baseline.kind, 'app-server');
  const initial = observeAppServerTaskState(baseline, null, 12_000);
  native = applyNotification(native, { method: 'turn/started', params: { threadId: taskId,
    turn: turn('turn-1', 'inProgress', [
      { id: 'user-1', type: 'userMessage', clientId: 'vk-op-1',
        content: [{ type: 'text', text: 'hello' }] },
      { id: 'tool-1', type: 'commandExecution', command: 'pwd', status: 'completed' },
      { id: 'agent-1', type: 'agentMessage', text: 'Working', phase: 'commentary' },
    ]) } });
  native = applyNotification(native, { method: 'thread/tokenUsage/updated', params: { threadId: taskId,
    turnId: 'turn-1', tokenUsage: { total: { totalTokens: 8, inputTokens: 6,
      cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
    last: { totalTokens: 8, inputTokens: 6, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 2, reasoningOutputTokens: 0 }, modelContextWindow: 100 } } });
  const nativeBeforeBridge = structuredClone(native);
  const active = projectManagedNativeBridgeState(native);
  assert.deepEqual(native, nativeBeforeBridge);
  assert.deepEqual(active.turns[0]?.items.map(item => item.id), ['user-1', 'agent-1']);
  assert.equal(active.turns[0]?.startedAt, 12_000);
  assert.equal(active.turns[0]?.items[0]?.clientId, 'vk-op-1');
  assert.deepEqual(active.context, { used: 8, window: 100, percent: 8 });
  const observed = observeAppServerTaskState(active, initial.checkpoint, 12_500);
  assert.equal(observed.details.status, 'running');
  assert.deepEqual(observed.inputs, [{ turnId: 'turn-1', status: 'inProgress', operationIds: ['vk-op-1'] }]);
  assert.ok(observed.events.some(event => event.type === 'user' && event.id === 'user-1'));
  assert.ok(observed.events.some(event => event.type === 'progress' && event.id === 'agent-1' && event.text === 'Working'));
  native = applyNotification(native, { method: 'item/completed', params: { threadId: taskId,
    turnId: 'turn-1', item: { id: 'agent-2', type: 'agentMessage', text: 'Done', phase: 'final_answer' } } });
  native = applyNotification(native, { method: 'turn/completed', params: { threadId: taskId,
    turn: turn('turn-1', 'completed', [], 12) } });
  const completed = projectManagedNativeBridgeState(native);
  const final = observeAppServerTaskState(completed, observed.checkpoint, 14_000);
  assert.ok(final.events.some(event => event.type === 'final' && event.id === 'agent-2' && event.text === 'Done'));
  assert.equal(final.details.status, 'idle');
  assert.equal(completed.turns[0]?.id, 'turn-1');
  assert.deepEqual(native.turns[0]?.items.map(item => item.id), ['user-1', 'tool-1', 'agent-1', 'agent-2'],
    'conversion did not mutate the native projection');
});

test('an agent-initiated turn is retained; ambiguous or unsupported visible content fails closed', () => {
  const native = applyNotification(base(), { method: 'turn/started', params: { threadId: taskId,
    turn: turn('agent-only', 'completed', [{ id: 'agent-only-item', type: 'agentMessage',
      text: 'Proactive', phase: 'final_answer' }]) } });
  const projected = projectManagedNativeBridgeState(native);
  assert.equal(projected.turns[0]?.id, 'agent-only');
  assert.equal(projected.turns[0]?.items[0]?.type, 'agentMessage');
  const baseline = observeAppServerTaskState(projectManagedNativeBridgeState(base()), null, 11_000);
  assert.ok(observeAppServerTaskState(projected, baseline.checkpoint, 13_000).events.some(event =>
    event.type === 'final' && event.id === 'agent-only-item'));
  const bad = structuredClone(native);
  bad.turns[0]!.items.push({ id: 'unsupported', type: 'futureVisibleMessage', text: 'do not drop' });
  assert.throws(() => projectManagedNativeBridgeState(bad), /unsupported/i);
  const duplicate = structuredClone(native);
  duplicate.turns[0]!.items.push({ id: 'agent-only-item', type: 'agentMessage', text: 'duplicate' });
  assert.throws(() => projectManagedNativeBridgeState(duplicate), /duplicate/i);
  const missingTime = structuredClone(native);
  missingTime.turns[0]!.turnStartedAtMs = null;
  assert.throws(() => projectManagedNativeBridgeState(missingTime), /timestamp/i);
  const wrongOrder = structuredClone(native);
  wrongOrder.turns.push({ ...structuredClone(wrongOrder.turns[0]!), turnId: 'earlier-turn',
    turnStartedAtMs: 1 });
  assert.throws(() => projectManagedNativeBridgeState(wrongOrder), /order ambiguous/i);
  const pending = structuredClone(native);
  pending.requests.push({ id: 1, method: 'item/tool/requestUserInput', params: {} });
  assert.throws(() => projectManagedNativeBridgeState(pending), /thread shape unsupported/i);
  const unsupportedContent = structuredClone(native);
  unsupportedContent.turns[0]!.items[0]!.phase = 'future_visible_phase';
  assert.throws(() => projectManagedNativeBridgeState(unsupportedContent), /visible assistant content unsupported/i);
});

test('bridge projection validates but omits bulky non-conversation tool output', () => {
  const native = applyNotification(base(), { method: 'turn/started', params: { threadId: taskId,
    turn: turn('turn-with-tool', 'inProgress', [
      { id: 'user-tool', type: 'userMessage', clientId: 'client-tool',
        content: [{ type: 'text', text: 'run' }] },
      { id: 'tool-bulk', type: 'commandExecution', aggregatedOutput: 'x'.repeat(3 * 1024 * 1024) },
      { id: 'agent-tool', type: 'agentMessage', text: 'Done', phase: 'commentary' },
    ]) } });
  const projected = projectManagedNativeBridgeState(native);
  assert.deepEqual(projected.turns[0]?.items.map(item => item.id), ['user-tool', 'agent-tool']);
  assert.ok(JSON.stringify(projected).length < 8_192);
  assert.equal(native.turns[0]?.items.length, 3, 'native UI keeps its full tool item');
});
