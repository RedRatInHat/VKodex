import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import { managedStockCommandId } from '../src/desktop/managed-native-stock-queue-adapter.js';
import { createManagedStockQueueRuntimeFactory } from '../src/desktop/managed-stock-queue-runtime.js';
import type { ManagedNativeStockQueueContext, ManagedNativeStockQueueAuthority } from '../src/desktop/managed-worker-native-owner.js';

test('runtime queue factory qualifies current same-worker state and refuses drift before a write', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vkodex-stock-runtime-'));
  const taskId = randomUUID(), ownerEpoch = randomUUID(), entryId = randomUUID(), cwd = 'C:/owned';
  const model = 'approved-model', effort = 'medium';
  const policy = approveTaskPolicy({ threadId: taskId, model, modelProvider: 'openai', effort, cwd,
    runtimeWorkspaceRoots: [cwd], environments: [], approvalPolicy: 'never', approvalsReviewer: 'user',
    activePermissionProfile: { id: ':danger-full-access', extends: null },
    sandbox: { type: 'dangerFullAccess' }, serviceTier: null });
  const requestedMode = { mode: 'default', settings: { model, reasoning_effort: effort,
    developer_instructions: null } };
  const confirmedMode = { mode: 'default', settings: { model, reasoning_effort: effort,
    developer_instructions: 'builtin' } };
  const settings = { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never',
    approvalsReviewer: 'user', permissions: ':danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' }, model, serviceTier: null, effort,
    summary: null, personality: 'pragmatic', collaborationMode: confirmedMode };
  const projection = { id: taskId, cwd, latestModel: model, latestReasoningEffort: effort,
    latestThreadSettings: { cwd, model, modelProvider: 'openai', effort,
      approvalPolicy: 'never', approvalsReviewer: 'user', serviceTier: null,
      activePermissionProfile: policy.activePermissionProfile, sandboxPolicy: policy.sandbox,
      collaborationMode: confirmedMode },
    currentPermissions: { activePermissionProfile: policy.activePermissionProfile,
      sandboxPolicy: policy.sandbox, runtimeWorkspaceRoots: [cwd], approvalPolicy: 'never',
      approvalsReviewer: 'user' }, environments: [], threadRuntimeStatus: { type: 'idle' },
    terminalTurnIds: [] as string[], activeTurnIds: [] as string[] };
  let generation = 1, revision = 1, admitted = true, owner = true, baseline = true,
    discovery = true, reads = 0, writes = 0, closeAtWire = false,
    mutateDuringRead = false, transportConnected = true;
  let releaseWire!: () => void;
  let enterWire: (() => void) | null = null;
  const wireEntered = new Promise<void>(resolve => { enterWire = resolve; });
  const wireGate = new Promise<void>(resolve => { releaseWire = resolve; });
  let holdWire = false;
  let provider = 'openai', readModel = model, fastModeAllowed = false;
  const observed: string[] = [];
  const context: ManagedNativeStockQueueContext = { taskId, ownerEpoch, backendGeneration: 1,
    controlKey: {}, host: { metadata: { taskId, backendGeneration: 1, state: 'running', frontend: null },
      observeNotifications() { throw new Error('unused observer'); },
      observePendingRequests() { throw new Error('unused observer'); },
      createRequestResponder() { throw new Error('unused responder'); },
      commandStatusForIntent() { throw new Error('unused status'); },
      async executeCommandWithResponse(_key, command, beforeWrite) {
        if (holdWire) { enterWire?.(); await wireGate; }
        if (closeAtWire) { admitted = false; transportConnected = false; }
        beforeWrite?.(); writes++;
        observed.push(command.method);
        const receiptId = randomUUID();
        return { operation: { operationId: command.operationId, ownerEpoch, backendGeneration: 1,
          threadId: taskId, method: command.method, clientUserMessageId: command.params.clientUserMessageId,
          fingerprint: 'a'.repeat(64), revision: 1, state: 'accepted', receiptId,
          rejectionCode: null }, response: { queuedSubmission: { id: receiptId,
          clientUserMessageId: command.params.clientUserMessageId, input: command.params.input } } } as never;
      } },
    publish: () => {}, onStockQueueChanged: () => { revision++; }, onFailure: () => {},
    captureAuthority: () => ({ taskId, ownerEpoch, backendGeneration: generation,
      semanticRevision: revision, authorityRevision: revision,
      projection: structuredClone(projection), pendingEvents: 0 }) as ManagedNativeStockQueueAuthority,
    assertCurrent: ticket => ticket.taskId === taskId && ticket.ownerEpoch === ownerEpoch &&
      ticket.backendGeneration === generation && ticket.semanticRevision === revision && owner,
  };
  const initialized = { effectiveSettings: settings, initializationReceipt: { taskId, ownerEpoch,
    confirmed: true, expansionKind: 'builtin-default-instructions',
    requestedCollaborationMode: requestedMode, confirmedEffectiveCollaborationMode: confirmedMode,
    requestedSettings: { ...settings, sandboxPolicy: null, serviceTier: 'default',
      collaborationMode: requestedMode }, confirmedEffectiveSettings: settings },
    tierResolution: { taskId, ownerEpoch, requested: 'default', effective: null,
      fastModeAllowed: false, confirmed: true }, initialState: { ...projection, hostId: 'local' as const, turns: [],
      requests: [], latestCollaborationMode: confirmedMode, previousTurnModel: null,
      title: null, latestTokenUsageInfo: null, hasUnreadTurn: false, updatedAt: 1,
      turnsPagination: { hasLoadedOldest: true, olderCursor: null } } };
  const bootstrap = { generation: 1, async readStockState(assertCurrent: () => void) {
    assertCurrent(); reads++; if (mutateDuringRead) revision++;
    return { threadId: taskId, generation, turnCount: 0,
      terminalTurnIds: [] as string[], historyDigest: 'a'.repeat(64), model: readModel,
      modelProvider: provider, reasoningEffort: effort, cwd, environments: [], updatedAt: 1,
      fastModeAllowed }; } };
  const factory = createManagedStockQueueRuntimeFactory({ journalPath: path.join(directory, 'native.sqlite'),
    sourceGeneration: 'created-generation-1', bootstrap, initialized, approvedTaskPolicy: policy,
    assertControlledNativeBaseline: scope => {
      assert.deepEqual(scope, { taskId, ownerEpoch, backendGeneration: 1,
        sourceGeneration: 'created-generation-1' });
      return baseline;
    },
    confirmNativeOwner: () => discovery, isOwnerCurrent: () => owner,
    admissionOpen: () => admitted });
  const adapter = factory(context);
  t.after(() => adapter.close());
  const text = 'PUBLIC_OK';
  const entry = { id: entryId, text, cwd, createdAt: 1780000000000,
    context: { prompt: text, turnTrigger: 'composer', workspaceRoots: [cwd],
      usedDictation: false, existingWorkspaceRoot: null, localProjectId: null,
      fileAttachments: [], addedFiles: [] },
    responsesapiClientMetadata: { source: 'codex', client_type: 'desktop_app' },
    submissionOptions: { executionHostId: 'local', agentMode: 'full-access',
      permissionProfileId: ':danger-full-access', serviceTier: 'default',
      shouldSendPermissionOverrides: false, usePermissionSelection: false,
      permissionSelection: null, collaborationMode: requestedMode,
      clientUserMessageId: 'separate-option-id' }, writingBlockAdditionalContext: null,
    mentionedBrowserFamilies: [], submissionIntent: 'send-now',
    submission: { hostId: 'local', status: 'pending', queueModeOverride: 'queue' } };
  const request = (state: unknown[]) => ({ requestId: randomUUID(), sourceClientId: randomUUID(),
    method: 'thread-follower-set-queued-follow-ups-state', version: 1, hostId: 'local',
    params: { hostId: 'local', conversationId: taskId, state: { [taskId]: state } } });
  assert.equal(managedStockCommandId(ownerEpoch, taskId, entryId).length, 36);
  admitted = false;
  await adapter.hydrateFollower();
  assert.equal(writes, 0);
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  admitted = true;
  baseline = false;
  await assert.rejects(adapter.accept(request([]), () => true));
  assert.equal(writes, 0);
  baseline = true;
  discovery = false;
  await assert.rejects(adapter.hydrateFollower());
  assert.equal(writes, 0);
  discovery = true;
  readModel = 'changed-model';
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  readModel = model;
  provider = 'other';
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  provider = 'openai';
  fastModeAllowed = true;
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  fastModeAllowed = false;
  discovery = false;
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  discovery = true;
  projection.terminalTurnIds = ['unexpected-turn'];
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  projection.terminalTurnIds = [];
  projection.latestThreadSettings.model = 'changed-model';
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  projection.latestThreadSettings.model = model;
  projection.latestThreadSettings.serviceTier = 'different' as never;
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  projection.latestThreadSettings.serviceTier = settings.serviceTier;
  projection.latestThreadSettings.collaborationMode = { mode: 'plan' } as never;
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  projection.latestThreadSettings.collaborationMode = confirmedMode;
  projection.currentPermissions.approvalPolicy = 'on-request';
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  projection.currentPermissions.approvalPolicy = 'never';
  generation = 2;
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  generation = 1;
  mutateDuringRead = true;
  await assert.rejects(adapter.accept(request([entry]), () => true));
  assert.equal(writes, 0);
  mutateDuringRead = false;
  owner = false;
  await assert.rejects(adapter.accept(request([entry]), () => true));
  owner = true;
  assert.equal(writes, 0);
  closeAtWire = true;
  assert.deepEqual(await adapter.accept(request([entry]), () => true), { ok: true });
  assert.equal(writes, 1);
  assert.equal(transportConnected, false);
  assert.equal(admitted, false);
  assert.deepEqual(observed, ['thread/queue/add']);
  assert.ok(reads >= 4);
  admitted = true;
  assert.deepEqual(await adapter.accept(request([entry]), () => true), { ok: true });
  assert.equal(writes, 1);
  baseline = false;
  await assert.rejects(adapter.hydrateFollower());
  baseline = true;
  assert.equal(await adapter.consumeUserMessage(entryId, randomUUID(), () => true), true);
  admitted = false;
  assert.deepEqual(await adapter.accept(request([]), () => true), { ok: true });
  admitted = true; closeAtWire = false;
  const next = { ...entry, id: randomUUID() };
  holdWire = true;
  const pending = adapter.accept(request([next]), () => true);
  await wireEntered;
  revision++;
  const duplicate = adapter.accept(request([next]), () => true);
  releaseWire();
  await assert.rejects(pending);
  await assert.rejects(duplicate);
  assert.equal(writes, 1);
});
