import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNativeRequestResponse } from '../src/codex/native-request-response.js';

const taskId = 'own-task';
const pending = (id: string | number, method: string, extra: Record<string, unknown> = {}) =>
  ({ id, method, params: { threadId: taskId, turnId: 'turn', itemId: 'item', ...extra } });
const follower = (id: string | number, field: 'response' | 'decision', value: unknown) =>
  ({ conversationId: taskId, hostId: 'local', requestId: id, [field]: value });

test('compiles the four exact native response routes without mutating input', () => {
  const cases = [
    ['thread-follower-submit-user-input', 'item/tool/requestUserInput',
      { questions: [{ id: 'q1' }] }, 'response', { answers: { q1: { answers: ['yes'] } } },
      { answers: { q1: { answers: ['yes'] } } }],
    ['thread-follower-command-approval-decision', 'item/commandExecution/requestApproval',
      { availableDecisions: ['accept', 'decline'] }, 'decision', 'decline', { decision: 'decline' }],
    ['thread-follower-file-approval-decision', 'item/fileChange/requestApproval',
      { availableDecisions: ['accept', 'decline'] }, 'decision', 'accept', { decision: 'accept' }],
    ['thread-follower-permissions-request-approval-response', 'item/permissions/requestApproval',
      { permissions: { network: { enabled: false }, fileSystem: { read: ['C:/own'], write: null,
        entries: [{ path: { type: 'path', path: 'C:/secret' }, access: 'deny' }] } } },
      'response', { permissions: { fileSystem: { read: ['C:/own'], write: null,
        entries: [{ path: { type: 'path', path: 'C:/secret' }, access: 'deny' }] } }, scope: 'turn' },
      { permissions: { fileSystem: { read: ['C:/own'], write: null,
        entries: [{ path: { type: 'path', path: 'C:/secret' }, access: 'deny' }] } }, scope: 'turn' }],
  ] as const;
  for (const [route, method, extra, field, value, expected] of cases) {
    const request = pending(7, method, extra), params = follower(7, field, value);
    const before = structuredClone({ request, params });
    const output = compileNativeRequestResponse(route, params, request);
    assert.deepEqual(output, expected);
    assert.deepEqual({ request, params }, before);
    assert.notStrictEqual(output, value);
  }
});

test('typed pending identity, exact route and envelope fields fail closed', () => {
  const q = pending(7, 'item/tool/requestUserInput', { questions: [{ id: 'q1' }] });
  const valid = follower(7, 'response', { answers: { q1: { answers: ['yes'] } } });
  for (const [route, params, request] of [
    ['thread-follower-submit-user-input', { ...valid, requestId: '7' }, q],
    ['thread-follower-submit-user-input', { ...valid, conversationId: 'other' }, q],
    ['thread-follower-submit-user-input', { ...valid, hostId: 'remote' }, q],
    ['thread-follower-submit-user-input', { ...valid, decision: 'accept' }, q],
    ['thread-follower-command-approval-decision', valid, q],
    ['thread-follower-submit-mcp-server-elicitation-response', valid, q],
    ['thread-follower-submit-user-input', valid, { ...q, params: { ...q.params, threadId: 'other' } }],
    ['thread-follower-submit-user-input', { ...valid, requestId: 1.5 }, q],
  ] as const) assert.throws(() => compileNativeRequestResponse(route, params, request));
  assert.throws(() => compileNativeRequestResponse('thread-follower-submit-user-input',
    { ...valid, response: { answers: { unknown: { answers: ['yes'] } } } }, q));
  assert.throws(() => compileNativeRequestResponse('thread-follower-submit-user-input',
    { ...valid, response: { answers: { q1: { answers: [true] } } } }, q));
  assert.throws(() => compileNativeRequestResponse('thread-follower-submit-user-input',
    { ...valid, response: { answers: {}, extra: true } }, q));
});

test('command amendments must match offered decisions; file approvals remain simple', () => {
  const exec = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo hello'] } };
  const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'deny' } } };
  const command = pending('7', 'item/commandExecution/requestApproval',
    { availableDecisions: [exec, network, 'decline'] });
  assert.deepEqual(compileNativeRequestResponse('thread-follower-command-approval-decision',
    follower('7', 'decision', exec), command), { decision: exec });
  assert.deepEqual(compileNativeRequestResponse('thread-follower-command-approval-decision',
    follower('7', 'decision', network), command), { decision: network });
  for (const value of ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: [1] } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } }])
    assert.throws(() => compileNativeRequestResponse('thread-follower-command-approval-decision',
      follower('7', 'decision', value), command));
  assert.throws(() => compileNativeRequestResponse('thread-follower-file-approval-decision',
    follower('7', 'decision', exec), pending('7', 'item/fileChange/requestApproval')));
});

test('permission grants cannot add network, paths, entries or remove exclusions and depth bounds', () => {
  const deny = { path: { type: 'path', path: 'C:/secret' }, access: 'deny' };
  const allow = { path: { type: 'path', path: 'C:/own' }, access: 'read' };
  const request = pending(7, 'item/permissions/requestApproval', { permissions: {
    network: { enabled: false }, fileSystem: { read: ['C:/own'], write: null,
      globScanMaxDepth: 2, entries: [allow, deny] } } });
  const valid = { permissions: { fileSystem: { read: ['C:/own'], write: null,
    globScanMaxDepth: 2, entries: [allow, deny] } }, scope: 'turn' };
  assert.deepEqual(compileNativeRequestResponse('thread-follower-permissions-request-approval-response',
    follower(7, 'response', valid), request), valid);
  for (const response of [
    { ...valid, permissions: { ...valid.permissions, network: { enabled: true } } },
    { ...valid, permissions: { fileSystem: { ...valid.permissions.fileSystem, read: ['C:/other'] } } },
    { ...valid, permissions: { fileSystem: { ...valid.permissions.fileSystem, read: null } } },
    { ...valid, permissions: { fileSystem: { ...valid.permissions.fileSystem, entries: [allow] } } },
    { ...valid, permissions: { fileSystem: { ...valid.permissions.fileSystem, globScanMaxDepth: 3 } } },
    { ...valid, permissions: { fileSystem: { ...valid.permissions.fileSystem, entries: [allow, deny,
      { path: { type: 'path', path: 'C:/other' }, access: 'read' }] } } },
  ]) assert.throws(() => compileNativeRequestResponse('thread-follower-permissions-request-approval-response',
    follower(7, 'response', response), request));
  const sparse = pending(8, 'item/permissions/requestApproval', { permissions: {} });
  assert.deepEqual(compileNativeRequestResponse('thread-follower-permissions-request-approval-response',
    follower(8, 'response', { permissions: {}, scope: 'turn' }), sparse),
  { permissions: {}, scope: 'turn' });
  assert.throws(() => compileNativeRequestResponse('thread-follower-permissions-request-approval-response',
    follower(8, 'response', { permissions: { network: { enabled: true } }, scope: 'turn' }), sparse));
  const denyOnly = pending(9, 'item/permissions/requestApproval', { permissions: {
    fileSystem: { read: null, write: null, entries: [deny], globScanMaxDepth: 2 } } });
  assert.throws(() => compileNativeRequestResponse('thread-follower-permissions-request-approval-response',
    follower(9, 'response', { permissions: { fileSystem: { read: null, write: null,
      entries: [] } }, scope: 'turn' }), denyOnly));
  assert.throws(() => compileNativeRequestResponse('thread-follower-permissions-request-approval-response',
    follower(8, 'response', { permissions: { fileSystem: { read: null, write: null } }, scope: 'turn' }), sparse));
});

test('non-JSON and oversized envelopes never become a worker response', () => {
  const request = pending(7, 'item/tool/requestUserInput', { questions: [{ id: 'q1' }] });
  const good = follower(7, 'response', { answers: { q1: { answers: ['yes'] } } });
  for (const value of [undefined, () => {}, Number.NaN, BigInt(1)])
    assert.throws(() => compileNativeRequestResponse('thread-follower-submit-user-input',
      { ...good, surprise: value }, request));
  assert.throws(() => compileNativeRequestResponse('thread-follower-submit-user-input',
    { ...good, response: { answers: { q1: { answers: ['x'.repeat(1024 * 1024)] } } } }, request));
  const cyclic: Record<string, unknown> = { ...good }; cyclic.self = cyclic;
  assert.throws(() => compileNativeRequestResponse('thread-follower-submit-user-input', cyclic, request));
});
