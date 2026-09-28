import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppServerRpc } from '../src/codex/app-server-connection.js';
import { createControlledNativeTask, ControlledNativeCreationUncertainError,
  type ControlledCreationIntent, type ControlledCreationStarted,
  type ControlledCreationReceipt } from '../src/desktop/controlled-native-task-creator.js';
import { ControlledNativeCreationJournal } from '../src/desktop/controlled-native-creation-journal.js';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';

const cwd = 'C:\\fixture\\workspace';
const rolloutPath = 'C:\\fixture\\home\\sessions\\new.jsonl';
const template = { model: 'gpt-5.6-sol', modelProvider: 'openai', effort: 'medium', cwd,
  runtimeWorkspaceRoots: [cwd], allowedEnvironments: [[]], approvalPolicy: 'never',
  approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', extends: null },
  sandbox: { type: 'dangerFullAccess' }, allowedServiceTiers: [null, 'default'] } as const;
const taskId = randomUUID();
const startResult = { thread: { id: taskId, status: { type: 'idle' }, turns: [],
  model: template.model, modelProvider: template.modelProvider, reasoningEffort: template.effort,
  cwd, environments: [] }, model: template.model, modelProvider: template.modelProvider,
  reasoningEffort: template.effort, cwd, runtimeWorkspaceRoots: [cwd],
  approvalPolicy: template.approvalPolicy, approvalsReviewer: template.approvalsReviewer,
  activePermissionProfile: template.activePermissionProfile, sandbox: template.sandbox,
  serviceTier: 'default' };

function fixture(failure: 'none' | 'unknown' | 'started-persist' | 'source-mismatch' |
  'read-fail' | 'unloaded' | 'idle-to-unloaded' | 'provider-mismatch' |
  'cwd-mismatch' | 'policy-mismatch' = 'none') {
  const calls: string[] = [], persisted: string[] = [];
  let reserved = false, readCount = 0;
  const rpc = {
    async initializedSession() { return { generation: 1, initializeResult: {} }; },
    isSessionCurrent(generation: number) { return generation === 1; },
    async request(method: string, params: Record<string, unknown>, options?: {
      mutating?: boolean; expectedGeneration?: number; assertBeforeWrite?: () => void;
    }) {
      calls.push(method);
      if (method === 'thread/start') {
        assert.equal(reserved, true);
        assert.equal(options?.mutating, true);
        assert.equal(options.expectedGeneration, 1);
        options.assertBeforeWrite?.();
        assert.deepEqual(params, { cwd, model: template.model,
          config: { model_reasoning_effort: template.effort },
          permissions: template.activePermissionProfile.id,
          approvalPolicy: template.approvalPolicy, runtimeWorkspaceRoots: [cwd], ephemeral: false });
        if (failure === 'unknown') throw new Error('connection lost after write');
        return failure === 'policy-mismatch' ? { ...startResult, serviceTier: 'unapproved' } : startResult;
      }
      if (method === 'thread/read') {
        readCount++;
        if (failure === 'read-fail') throw new Error('readback unavailable');
        return { thread: failure === 'unloaded' || failure === 'idle-to-unloaded' && readCount === 2
          ? { ...startResult.thread, status: { type: 'notLoaded' }, model: null,
            reasoningEffort: null, environments: null, path: rolloutPath }
          : { ...startResult.thread,
            modelProvider: failure === 'provider-mismatch' ? 'other' : template.modelProvider,
            cwd: failure === 'cwd-mismatch' ? 'C:\\fixture\\other' : cwd,
            path: failure === 'source-mismatch' ? 'C:\\fixture\\home\\other.jsonl' : rolloutPath } };
      }
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/queue/list') return { data: [], nextCursor: null };
      throw new Error(`Unexpected ${method}`);
    },
  } as unknown as AppServerRpc & { initializedSession(): Promise<{ generation: number; initializeResult: Record<string, unknown> }>;
    isSessionCurrent(generation: number): boolean };
  const options = { rpc, operationId: randomUUID(), sourceId: 'source-a', requestedPolicy: template,
    persistIntent: async (intent: ControlledCreationIntent) => {
      assert.equal(intent.operationId.length, 36); assert.equal(intent.sourceId, 'source-a');
      assert.equal(reserved, false); reserved = true; persisted.push('intent');
      return { isCurrent: () => reserved };
    },
    persistStarted: async (started: ControlledCreationStarted) => {
      assert.equal(started.threadId, taskId); persisted.push('started');
      if (failure === 'policy-mismatch') assert.equal(started.selectedEffective.serviceTier, 'unapproved');
      if (failure === 'started-persist') throw new Error('storage unavailable');
    },
    persistQualified: async (receipt: ControlledCreationReceipt) => {
      assert.equal(receipt.threadId, taskId); persisted.push('qualified');
    },
    resolveSource: async () => ({ sourceId: 'source-a', rolloutPath }),
  };
  return { calls, persisted, options };
}

test('controlled creator writes one thread/start after intent, then qualifies zero-turn source', async () => {
  const f = fixture();
  const receipt = await createControlledNativeTask(f.options);
  assert.equal(receipt.threadId, taskId);
  assert.equal(receipt.effectivePolicy.serviceTier, 'default');
  assert.equal(receipt.rolloutPath, rolloutPath);
  assert.equal(receipt.sourceGeneration.length, 36);
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
  assert.deepEqual(f.calls, ['thread/start', 'thread/read', 'thread/turns/list',
    'thread/goal/get', 'thread/queue/list', 'thread/read']);
  assert.equal(f.calls.includes('turn/start'), false);
});

test('selected effective policy remains authoritative when readback is notLoaded', async () => {
  const f = fixture('unloaded');
  const receipt = await createControlledNativeTask(f.options);
  assert.equal(receipt.effectivePolicy.serviceTier, 'default');
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
});

test('idle to notLoaded is the same qualified zero-turn source', async () => {
  const f = fixture('idle-to-unloaded');
  const receipt = await createControlledNativeTask(f.options);
  assert.equal(receipt.threadId, taskId);
  assert.deepEqual(f.persisted, ['intent', 'started', 'qualified']);
});

for (const failure of ['unknown', 'started-persist'] as const) test(`${failure} remains uncertain with no replay`, async () => {
  const f = fixture(failure);
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, ['thread/start']);
  assert.deepEqual(f.persisted, failure === 'unknown' ? ['intent'] : ['intent', 'started']);
});

for (const failure of ['source-mismatch', 'read-fail', 'provider-mismatch', 'cwd-mismatch'] as const)
  test(`${failure} after native acceptance refuses qualification without replay`, async () => {
  const f = fixture(failure);
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, ['thread/start', 'thread/read']);
  assert.deepEqual(f.persisted, ['intent', 'started']);
  });

test('empty native state without a reserved creator intent cannot dispatch', async () => {
  const f = fixture();
  const options = { ...f.options, persistIntent: async () => { throw new Error('no creator provenance'); } };
  await assert.rejects(createControlledNativeTask(options), /no creator provenance/u);
  assert.deepEqual(f.calls, []);
});

test('native policy mismatch still persists known created ID before refusing qualification', async () => {
  const f = fixture('policy-mismatch');
  await assert.rejects(createControlledNativeTask(f.options), ControlledNativeCreationUncertainError);
  assert.deepEqual(f.calls, ['thread/start']);
  assert.deepEqual(f.persisted, ['intent', 'started']);
});

function journalFixture() {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'vkodex-controlled-create-')), 'creation.sqlite');
  const intent: ControlledCreationIntent = { operationId: randomUUID(), creatorNonce: randomUUID(),
    sourceGeneration: randomUUID(), sourceId: 'source-a', requestedPolicy: template };
  const started: ControlledCreationStarted = { ...intent, threadId: taskId,
    selectedEffective: { model: template.model, modelProvider: template.modelProvider,
      reasoningEffort: template.effort, serviceTier: 'default', cwd,
      approvalPolicy: template.approvalPolicy, environments: [] } };
  const { allowedEnvironments: _environments, allowedServiceTiers: _tiers, ...requested } = template;
  const effectivePolicy = approveTaskPolicy({ ...requested, threadId: taskId,
    serviceTier: 'default', environments: [] });
  const qualified: ControlledCreationReceipt = { ...started, effectivePolicy,
    rolloutPath, status: 'qualified-zero-turn' };
  return { filePath, intent, started, qualified };
}

test('creation journal persists intent, native ID, and qualification across reopen', async () => {
  const f = journalFixture();
  let journal = new ControlledNativeCreationJournal(f.filePath);
  const reservation = await journal.persistIntent(f.intent);
  assert.equal(reservation.isCurrent(), true);
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  assert.equal(journal.synchronousMode(), 2);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  await journal.persistStarted(f.started);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  assert.equal(journal.get(f.intent.operationId)?.started?.threadId, taskId);
  await journal.persistQualified(f.qualified);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  assert.equal(journal.get(f.intent.operationId)?.qualified?.rolloutPath, rolloutPath);
  assert.deepEqual(journal.listUncertain(), []);
  journal.close();
});

test('creation journal rejects duplicate operation and immutable-scope drift without overwrite', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  await journal.persistIntent(f.intent);
  await assert.rejects(journal.persistIntent(f.intent));
  await assert.rejects(journal.persistStarted({ ...f.started, sourceId: 'different' }));
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  await journal.persistStarted(f.started);
  await assert.rejects(journal.persistStarted({ ...f.started, threadId: randomUUID() }));
  await assert.rejects(journal.persistQualified({ ...f.qualified, creatorNonce: randomUUID() }));
  assert.equal(journal.get(f.intent.operationId)?.state, 'started');
  assert.equal(journal.get(f.intent.operationId)?.started?.threadId, taskId);
  assert.deepEqual(journal.listUncertain().map(row => row.state), ['started']);
  journal.close();
});

test('reopened uncertain intent prevents any second native thread/start', async () => {
  const f = journalFixture();
  let journal = new ControlledNativeCreationJournal(f.filePath);
  await journal.persistIntent(f.intent);
  journal.close();
  journal = new ControlledNativeCreationJournal(f.filePath);
  const rpc = fixture();
  await assert.rejects(createControlledNativeTask({ ...rpc.options,
    operationId: f.intent.operationId,
    persistIntent: intent => journal.persistIntent(intent),
    persistStarted: started => journal.persistStarted(started),
    persistQualified: receipt => journal.persistQualified(receipt) }));
  assert.deepEqual(rpc.calls, []);
  assert.equal(journal.get(f.intent.operationId)?.state, 'intent');
  journal.close();
});

test('journal independently rejects forged or malformed requested policy', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  await assert.rejects(journal.persistIntent({ ...f.intent,
    requestedPolicy: { ...f.intent.requestedPolicy, model: 'bad model' } }));
  await assert.rejects(journal.persistIntent({ ...f.intent,
    requestedPolicy: { ...f.intent.requestedPolicy, allowedServiceTiers: ['bad tier'] } }));
  await assert.rejects(journal.persistIntent({ ...f.intent,
    requestedPolicy: { ...f.intent.requestedPolicy, extra: 'unapproved' } } as ControlledCreationIntent));
  assert.equal(journal.get(f.intent.operationId), null);
  journal.close();
});

test('journal rejects qualified policy that differs from fixed request or native selection', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  await journal.persistIntent(f.intent);
  await journal.persistStarted(f.started);
  await assert.rejects(journal.persistQualified({ ...f.qualified,
    effectivePolicy: approveTaskPolicy({ ...f.qualified.effectivePolicy, model: 'gpt-6-sol' }) }));
  await assert.rejects(journal.persistQualified({ ...f.qualified,
    effectivePolicy: approveTaskPolicy({ ...f.qualified.effectivePolicy, serviceTier: null }) }));
  assert.equal(journal.get(f.intent.operationId)?.state, 'started');
  journal.close();
});

test('same native thread ID cannot be persisted for two creation operations', async () => {
  const first = journalFixture(), second = journalFixture();
  const journal = new ControlledNativeCreationJournal(first.filePath);
  await journal.persistIntent(first.intent);
  await journal.persistStarted(first.started);
  await journal.persistIntent(second.intent);
  await assert.rejects(journal.persistStarted(second.started));
  assert.equal(journal.get(second.intent.operationId)?.state, 'intent');
  assert.equal(journal.get(first.intent.operationId)?.started?.threadId, taskId);
  journal.close();
});

test('qualified native cwd accepts equivalent Windows path spelling', async () => {
  const f = journalFixture();
  const journal = new ControlledNativeCreationJournal(f.filePath);
  const started = { ...f.started, selectedEffective: { ...f.started.selectedEffective,
    cwd: 'c:\\FIXTURE\\workspace\\.' } };
  await journal.persistIntent(f.intent);
  await journal.persistStarted(started);
  await journal.persistQualified({ ...f.qualified, selectedEffective: started.selectedEffective });
  assert.equal(journal.get(f.intent.operationId)?.state, 'qualified');
  journal.close();
});
