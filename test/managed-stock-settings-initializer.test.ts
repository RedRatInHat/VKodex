import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createManagedStockSettingsInitializer } from '../src/desktop/managed-stock-settings-initializer.js';
import type { SettingsOperation } from '../src/codex/managed-worker-operation-journal.js';
import type { ManagedWorkerNotification, ManagedWorkerPendingRequest } from '../src/codex/managed-worker-frontend-host.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import type { NativeProjectionState } from '../src/codex/managed-native-projection.js';

const taskId = '01a0e498-4fa0-74c0-a795-c5047a06d21c', cwd = 'C:/own';
const profile = { id: ':danger-full-access', extends: null };
const policy = approveTaskPolicy({ threadId: taskId, model: 'gpt-5.6-sol', modelProvider: 'openai',
  effort: 'medium', cwd, runtimeWorkspaceRoots: [cwd], environments: [],
  approvalPolicy: 'never', approvalsReviewer: 'user', activePermissionProfile: profile,
  sandbox: { type: 'dangerFullAccess' }, serviceTier: null });
const initial = { id: taskId, hostId: 'local', turns: [], requests: [], cwd,
  currentPermissions: { activePermissionProfile: profile, sandboxPolicy: policy.sandbox,
    runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never', approvalsReviewer: 'user' },
  latestThreadSettings: { cwd, model: policy.model, modelProvider: 'openai', effort: 'medium',
    collaborationMode: { mode: 'default', settings: { model: policy.model,
      reasoning_effort: 'medium', developer_instructions: null } }, serviceTier: null },
  latestModel: policy.model, latestReasoningEffort: 'medium', modelProvider: 'openai',
  latestCollaborationMode: { mode: 'default', settings: { model: policy.model,
    reasoning_effort: 'medium', developer_instructions: null } },
  previousTurnModel: null, title: null, threadRuntimeStatus: { type: 'idle' },
  latestTokenUsageInfo: null, hasUnreadTurn: false, updatedAt: 1,
  turnsPagination: { hasLoadedOldest: true, olderCursor: null }, environments: [] } as NativeProjectionState;

for (const [model, effort] of [['gpt-5.6-sol', 'medium'], ['approved-other-model', 'high']] as const) {
test(`stock settings initializer confirms actual notification plus readback for ${model}/${effort}`, async () => {
  const selectedPolicy = approveTaskPolicy({ ...policy, model, effort });
  const epoch = randomUUID(), operationId = randomUUID();
  let observer: ((event: ManagedWorkerNotification) => void) | null = null;
  let qualifier: ((context: unknown, assertCurrent: () => void) => Promise<unknown>) | null = null;
  const nativeSettings = { cwd, model: selectedPolicy.model, modelProvider: 'openai', effort,
    activePermissionProfile: profile, sandboxPolicy: { type: 'dangerFullAccess' },
    approvalPolicy: 'never', approvalsReviewer: 'user', serviceTier: null,
    summary: null, personality: 'pragmatic', disabledPluginIds: [], multiAgentMode: 'explicitRequestOnly',
    collaborationMode: { mode: 'default', settings: { model: selectedPolicy.model,
      reasoning_effort: effort, developer_instructions: 'built-in instructions' } } };
  let reads = 0, writes = 0, readProvider = 'openai', fastModeAllowed = false;
  const host = {
    metadata: { taskId, state: 'running' as const, backendGeneration: 7, frontend: null },
    observeNotifications(_key: object, listener: (event: ManagedWorkerNotification) => void) {
      observer = listener; return () => { observer = null; };
    },
    observePendingRequests(_key: object, _listener: (event: ManagedWorkerPendingRequest) => void) { return () => {}; },
    async executeSettingsCommand(_key: object, command: { params: Record<string, unknown> }) {
      writes++;
      assert.equal(command.params.permissions, ':danger-full-access');
      assert.equal(command.params.sandboxPolicy, undefined);
      observer?.({ taskId, generation: 7, notification: { method: 'thread/settings/updated',
        params: { threadId: taskId, threadSettings: nativeSettings } } });
      return { operationId, ownerEpoch: epoch, backendGeneration: 7, threadId: taskId,
        fingerprint: 'a'.repeat(64), revision: 2, state: 'unknown', rpcAck: true,
        effectiveFingerprint: null } as SettingsOperation;
    },
    async confirmSettingsCommand(_key: object, command: unknown) {
      assert.ok(qualifier);
      const proof = await qualifier({ ...(command as object), threadId: taskId,
        ownerEpoch: epoch, backendGeneration: 7 }, () => {});
      assert.ok(proof);
      return { operationId, ownerEpoch: epoch, backendGeneration: 7, threadId: taskId,
        fingerprint: 'a'.repeat(64), revision: 3, state: 'confirmed', rpcAck: true,
        effectiveFingerprint: 'a'.repeat(64) } as SettingsOperation;
    },
  };
  const bootstrap = {
    generation: 7, initialState: { ...initial, latestModel: model, latestReasoningEffort: effort },
    composerDefaults: { taskId, cwd, summary: null, personality: 'pragmatic' as const },
    async readStockState() { reads++; return { threadId: taskId, generation: 7,
      turnCount: 0, terminalTurnIds: [], historyDigest: 'a'.repeat(64),
      model, modelProvider: readProvider, reasoningEffort: effort, cwd,
      environments: [], updatedAt: 1, fastModeAllowed }; },
  };
  const initializer = createManagedStockSettingsInitializer({ host, adapterKey: {}, controlKey: {},
    bootstrap, taskId, ownerEpoch: epoch, operationId, approvedTaskPolicy: selectedPolicy,
    assertOwnerCurrent: () => {} });
  qualifier = (context, current) => initializer.qualifySettingsEffect(context as never, current);
  const result = await initializer.initialize();
  assert.equal(writes, 1);
  assert.ok(reads >= 1);
  assert.equal(result.effectiveSettings.permissions, ':danger-full-access');
  assert.equal(result.initializationReceipt?.expansionKind, 'builtin-default-instructions');
  assert.deepEqual(result.tierResolution, { taskId, ownerEpoch: epoch,
    requested: 'default', effective: null, fastModeAllowed: false, confirmed: true });
  assert.equal(result.initialState.latestThreadSettings.collaborationMode &&
    (result.initialState.latestThreadSettings.collaborationMode as Record<string, unknown>).mode, 'default');
  assert.equal((await result.readInitialState()).id, taskId);
  if (model === 'gpt-5.6-sol') {
    readProvider = 'different-provider';
    await assert.rejects(result.readInitialState(), /initialization unavailable/);
    readProvider = 'openai';
    fastModeAllowed = true;
    await assert.rejects(result.readInitialState(), /initialization unavailable/);
  }
  initializer.close();
});
}

test('native ACK without a settings notification expires without confirmation or retry', async () => {
  const epoch = randomUUID(), operationId = randomUUID();
  let writes = 0, confirms = 0;
  const host = {
    metadata: { taskId, state: 'running' as const, backendGeneration: 7, frontend: null },
    observeNotifications() { return () => {}; },
    observePendingRequests() { return () => {}; },
    async executeSettingsCommand() {
      writes++;
      return { operationId, ownerEpoch: epoch, backendGeneration: 7, threadId: taskId,
        fingerprint: 'a'.repeat(64), revision: 2, state: 'unknown', rpcAck: true,
        effectiveFingerprint: null } as SettingsOperation;
    },
    async confirmSettingsCommand() { confirms++; throw new Error('must not confirm'); },
  } as unknown as Parameters<typeof createManagedStockSettingsInitializer>[0]['host'];
  const bootstrap = {
    generation: 7, initialState: initial,
    composerDefaults: { taskId, cwd, summary: null, personality: 'pragmatic' as const },
    async readStockState() { return { threadId: taskId, generation: 7,
      turnCount: 0, terminalTurnIds: [], historyDigest: 'a'.repeat(64),
      model: policy.model, modelProvider: 'openai', reasoningEffort: 'medium', cwd,
      environments: [], updatedAt: 1, fastModeAllowed: false }; },
  };
  const initializer = createManagedStockSettingsInitializer({ host, adapterKey: {}, controlKey: {},
    bootstrap, taskId, ownerEpoch: epoch, operationId, approvedTaskPolicy: policy,
    assertOwnerCurrent: () => {}, noticeTimeoutMs: 5 });
  await assert.rejects(initializer.initialize(), /notification unavailable/);
  assert.equal(writes, 1);
  assert.equal(confirms, 0);
  initializer.close();
});

test('reentrant owner check cannot leave stale host authority for a settings write', async () => {
  const epoch = randomUUID(), operationId = randomUUID();
  let reads = 0, writes = 0, checks = 0;
  const metadata = { taskId, state: 'running' as 'running' | 'lost',
    backendGeneration: 7, frontend: null };
  const host = {
    metadata,
    observeNotifications() { return () => {}; },
    observePendingRequests() { return () => {}; },
    async executeSettingsCommand() { writes++; throw new Error('unexpected write'); },
    async confirmSettingsCommand() { throw new Error('unexpected confirm'); },
  } as unknown as Parameters<typeof createManagedStockSettingsInitializer>[0]['host'];
  const bootstrap = {
    generation: 7, initialState: initial,
    composerDefaults: { taskId, cwd, summary: null, personality: 'pragmatic' as const },
    async readStockState() { reads++; throw new Error('unexpected read'); },
  };
  const initializer = createManagedStockSettingsInitializer({ host, adapterKey: {}, controlKey: {},
    bootstrap, taskId, ownerEpoch: epoch, operationId, approvedTaskPolicy: policy,
    assertOwnerCurrent: () => { if (++checks === 2) metadata.state = 'lost'; } });
  await assert.rejects(initializer.initialize(), /initialization unavailable/);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  initializer.close();
});
