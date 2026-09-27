import assert from 'node:assert/strict';
import test from 'node:test';
import { approveTaskPolicy, assertEffectiveResume } from '../src/codex/managed-task-policy.js';

const taskId = '01a0e498-4fa0-74c0-a795-c5047a06d21c';
function intention() {
  return { threadId: taskId, model: 'gpt-6-luna', modelProvider: 'openai', effort: 'high',
    cwd: 'C:/owned-task', runtimeWorkspaceRoots: ['C:/owned-task'],
    environments: [{ environmentId: 'local', cwd: 'C:/owned-task', runtimeWorkspaceRoots: ['C:/owned-task'] }],
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    activePermissionProfile: { id: ':workspace', extends: null },
    sandbox: { type: 'workspaceWrite', writableRoots: ['C:/owned-task'], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true }, serviceTier: null };
}
function effective() {
  const policy = intention();
  return { thread: { id: taskId, status: { type: 'idle' }, model: policy.model,
    modelProvider: policy.modelProvider, reasoningEffort: policy.effort,
    cwd: policy.cwd, environments: structuredClone(policy.environments) },
    model: policy.model, modelProvider: policy.modelProvider, reasoningEffort: policy.effort,
    cwd: policy.cwd, runtimeWorkspaceRoots: structuredClone(policy.runtimeWorkspaceRoots),
    approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer,
    activePermissionProfile: structuredClone(policy.activePermissionProfile),
    sandbox: structuredClone(policy.sandbox), serviceTier: policy.serviceTier };
}

test('owner intention for a noncanary model and effort compares exactly with native effective resume', () => {
  const input = intention(), policy = approveTaskPolicy(input);
  input.model = 'changed'; input.runtimeWorkspaceRoots[0] = 'C:/elsewhere';
  assert.equal(policy.model, 'gpt-6-luna');
  assert.equal(policy.runtimeWorkspaceRoots[0], 'C:/owned-task');
  assert.throws(() => { (policy.sandbox as { networkAccess: boolean }).networkAccess = true; }, TypeError);
  assert.doesNotThrow(() => assertEffectiveResume(policy, effective()));
});

test('read-only intention preserves explicit null effort, tier, and inherited profile parent', () => {
  const input = { ...intention(), effort: null, serviceTier: null,
    activePermissionProfile: { id: ':read-only', extends: null },
    sandbox: { type: 'readOnly', networkAccess: false } };
  const actual = effective();
  Object.assign(actual, { reasoningEffort: null,
    activePermissionProfile: { id: ':read-only', extends: null },
    sandbox: { type: 'readOnly', networkAccess: false } });
  Object.assign(actual.thread, { reasoningEffort: null });
  const policy = approveTaskPolicy(input);
  assert.doesNotThrow(() => assertEffectiveResume(policy, actual));
  const missingEffort = structuredClone(actual) as Record<string, unknown>;
  delete missingEffort.reasoningEffort;
  assert.throws(() => assertEffectiveResume(policy, missingEffort), /effective/i);
  const missingTier = structuredClone(actual) as Record<string, unknown>;
  delete missingTier.serviceTier;
  assert.throws(() => assertEffectiveResume(policy, missingTier), /effective/i);
  const missingParent = structuredClone(input) as Record<string, unknown>;
  missingParent.activePermissionProfile = { id: ':read-only' };
  assert.throws(() => approveTaskPolicy(missingParent), /policy/i);
});

test('native Windows path spelling may differ while workspace identity stays exact', () => {
  const policy = approveTaskPolicy(intention());
  const actual = effective();
  actual.cwd = 'c:\\OWNED-TASK';
  actual.thread.cwd = 'c:\\owned-task';
  actual.runtimeWorkspaceRoots[0] = 'c:\\owned-task';
  actual.thread.environments[0]!.cwd = 'c:\\OWNED-TASK';
  actual.thread.environments[0]!.runtimeWorkspaceRoots[0] = 'c:\\owned-task';
  actual.sandbox.writableRoots[0] = 'c:\\owned-task';
  assert.doesNotThrow(() => assertEffectiveResume(policy, actual));
  actual.sandbox.writableRoots[0] = 'C:/another-root';
  assert.throws(() => assertEffectiveResume(policy, actual), /effective/i);
  actual.sandbox.writableRoots[0] = 'c:\\owned-task';
  actual.thread.environments[0]!.runtimeWorkspaceRoots[0] = 'C:/another-root';
  assert.throws(() => assertEffectiveResume(policy, actual), /effective/i);
});

test('effective response never inherits omitted policy fields or mismatched settings', () => {
  const policy = approveTaskPolicy(intention());
  for (const field of ['reasoningEffort', 'approvalPolicy', 'approvalsReviewer', 'serviceTier',
    'runtimeWorkspaceRoots', 'activePermissionProfile', 'sandbox', 'modelProvider'] as const) {
    const missing = effective() as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => assertEffectiveResume(policy, missing), /effective/i, field);
  }
  const mismatch = effective(); mismatch.model = 'gpt-6-sol';
  assert.throws(() => assertEffectiveResume(policy, mismatch), /effective/i);
  const otherTask = effective(); otherTask.thread.id = 'other';
  assert.throws(() => assertEffectiveResume(policy, otherTask), /effective/i);
  const changedEnvironment = effective(); changedEnvironment.thread.environments[0]!.cwd = 'C:/elsewhere';
  assert.throws(() => assertEffectiveResume(policy, changedEnvironment), /effective/i);
  const changedThreadEffort = effective(); changedThreadEffort.thread.reasoningEffort = 'low';
  assert.throws(() => assertEffectiveResume(policy, changedThreadEffort), /effective/i);
  const widerSandbox = effective(); widerSandbox.sandbox.networkAccess = true;
  assert.throws(() => assertEffectiveResume(policy, widerSandbox), /effective/i);
});

test('intention requires explicit known fields and rejects unknown or malformed policy shapes', () => {
  const missing = intention() as Record<string, unknown>; delete missing.effort;
  assert.throws(() => approveTaskPolicy(missing), /policy/i);
  assert.throws(() => approveTaskPolicy({ ...intention(), unreviewed: true }), /policy/i);
  assert.throws(() => approveTaskPolicy({ ...intention(), cwd: 'relative/path' }), /policy/i);
  assert.throws(() => approveTaskPolicy({ ...intention(), model: 'bad model\n' }), /policy/i);
  assert.throws(() => approveTaskPolicy({ ...intention(), sandbox: { type: 'dangerFullAccess' } }), /policy/i);
  assert.throws(() => approveTaskPolicy({ ...intention(), sandbox: { ...intention().sandbox, unknown: true } }), /policy/i);
  assert.throws(() => approveTaskPolicy({ ...intention(), approvalPolicy: { granular: {} } }), /policy/i);
  assert.throws(() => approveTaskPolicy({ ...intention(), approvalPolicy: { toString: () => 'never' } }), /policy/i);
});
