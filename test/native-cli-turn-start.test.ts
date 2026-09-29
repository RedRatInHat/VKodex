import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeCliTurnStart } from '../src/codex/native-cli-turn-start.js';

const taskId = '01a0eb7e-bec3-7a93-9641-8c4fb5f15d6a';
const ownerEpoch = 'f2945262-91bd-42ed-ac48-77dbca48a138';
const clientId = '76c8caee-85da-4125-8bb6-7b602239783a';
const settings = {
  cwd: 'D:\\GitStorageG\\VKodex', runtimeWorkspaceRoots: ['D:\\GitStorageG\\VKodex'],
  approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':read-only',
  sandboxPolicy: { type: 'readOnly' }, model: 'gpt-5.6-sol', serviceTier: 'default',
  effort: 'low', summary: null, collaborationMode: { mode: 'default', settings: null },
  personality: null,
};
function start(overrides: Record<string, unknown> = {}) {
  return { threadId: taskId, clientUserMessageId: clientId,
    input: [{ type: 'text', text: 'isolated test' }], turnTrigger: null,
    toolOutput: null, responsesapiClientMetadata: null, additionalContext: null,
    environments: null, cwd: settings.cwd,
    runtimeWorkspaceRoots: settings.runtimeWorkspaceRoots,
    approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
    sandboxPolicy: null, permissions: settings.permissions, model: settings.model,
    serviceTier: settings.serviceTier, serviceTierForTurn: null, effort: settings.effort,
    summary: null, personality: null, outputSchema: null,
    collaborationMode: settings.collaborationMode, multiAgentMode: null,
    cyberAccessProgram: null, ...overrides };
}

test('native CLI read-only start compiles exact scope with stable operation identity', () => {
  assert.equal(Object.keys(start()).length, 24);
  assert.match(ownerEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  const first = prepareNativeCliTurnStart(start(), { taskId, ownerEpoch, effectiveSettings: settings });
  const second = prepareNativeCliTurnStart(start(), { taskId, ownerEpoch, effectiveSettings: settings });
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.method, 'turn/start');
  assert.deepEqual(first.params, start());
  assert.equal(first.params.clientUserMessageId, clientId);
  assert.notEqual(first.operationId, clientId);
  assert.notEqual(prepareNativeCliTurnStart(start({ clientUserMessageId:
    '76c8caee-85da-4125-8bb6-7b602239783b' }),
  { taskId, ownerEpoch, effectiveSettings: settings }).operationId, first.operationId);
  // A changed body under the same client ID keeps its journal key; the
  // command dispatcher must then reject the conflicting fingerprint.
  assert.equal(prepareNativeCliTurnStart(start({ input: [{ type: 'text', text: 'different' }] }),
    { taskId, ownerEpoch, effectiveSettings: settings }).operationId, first.operationId);
});

test('native CLI start rejects source, settings, context, and input drift', () => {
  for (const request of [
    start({ threadId: 'other' }), start({ model: 'gpt-6-astra' }),
    start({ cwd: 'D:\\GitStorageG\\other' }), start({ permissions: ':danger-full-access' }),
    start({ approvalPolicy: 'on-request' }), start({ sandboxPolicy: { type: 'dangerFullAccess' } }),
    start({ responsesapiClientMetadata: { opaque: true } }),
    start({ additionalContext: { developerInstructions: 'ignored' } }),
    start({ input: [{ type: 'image', url: 'local' }] }),
    start({ input: [{ type: 'text', text: ' ' }] }),
    start({ input: [{ type: 'text', text: 'isolated test', text_elements: ['unsupported'] }] }),
    start({ extra: true }),
  ]) assert.throws(() => prepareNativeCliTurnStart(request,
    { taskId, ownerEpoch, effectiveSettings: settings }));
  assert.throws(() => prepareNativeCliTurnStart(start(), { taskId, ownerEpoch,
    effectiveSettings: { ...settings, permissions: ':danger-full-access' } }));
});
