import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { approveTaskPolicy } from '../src/codex/managed-task-policy.js';
import { managedStockCommandId } from '../src/desktop/managed-native-stock-queue-adapter.js';
import { ManagedStockVkSubmitter, managedVkStockCommandId } from '../src/desktop/managed-stock-vk-submit.js';

test('VK command identity is stable but distinct from native stock identity', () => {
  const epoch = randomUUID(), taskId = randomUUID(), clientId = randomUUID();
  assert.equal(managedVkStockCommandId(epoch, taskId, clientId),
    managedVkStockCommandId(epoch, taskId, clientId));
  assert.notEqual(managedVkStockCommandId(epoch, taskId, clientId),
    managedStockCommandId(epoch, taskId, clientId));
  assert.notEqual(managedVkStockCommandId(epoch, taskId, clientId),
    managedVkStockCommandId(epoch, taskId, randomUUID()));
});

test('capability, task source, and unsupported attachments refuse before any lease or worker write', async () => {
  const taskId = randomUUID(), epoch = randomUUID(), capability = {};
  let leases = 0, writes = 0, reads = 0;
  const submitter = new ManagedStockVkSubmitter({ capability, controlKey: {}, sourceId: '',
    taskId, ownerEpoch: epoch, backendGeneration: 1,
    approvedTaskPolicy: approveTaskPolicy({ threadId: taskId, model: 'gpt-5.6-sol',
      modelProvider: 'openai', effort: 'medium', cwd: 'C:\\own',
      runtimeWorkspaceRoots: ['C:\\own'], environments: [], approvalPolicy: 'never',
      approvalsReviewer: 'user', activePermissionProfile: { id: ':danger-full-access', extends: null },
      sandbox: { type: 'dangerFullAccess' }, serviceTier: null }),
    initialState: {} as never,
    captureAuthority: () => { throw new Error('must not capture'); },
    assertAuthorityCurrent: () => false,
    readStockState: async () => { reads++; throw new Error('must not read'); },
    host: { executeCommandWithResponse: async () => { writes++; throw new Error('must not write'); },
      commandStatusForIntent: () => null, commandQuiescence: () => ({ inFlight: 0, unconfirmed: false }) },
    acquireLease: () => { leases++; throw new Error('must not lease'); },
  });
  const request = { operationId: randomUUID(), task: { hostId: 'local', threadId: taskId },
    text: 'PUBLIC_VK' };
  await assert.rejects(submitter.submit({}, request), /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request, text: '   ' }),
    /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request,
    task: { ...request.task, sourceId: 'other' } }), /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request,
    inputFiles: [{ kind: 'image', originalName: 'x', path: 'C:\\own\\x.png', sizeBytes: 1 }] }),
    /Managed VK stock input unavailable/);
  await assert.rejects(submitter.submit(capability, { ...request, ignoredSemanticField: true } as never),
    /Managed VK stock input unavailable/);
  assert.deepEqual({ leases, reads, writes }, { leases: 0, reads: 0, writes: 0 });
});
