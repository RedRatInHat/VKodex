import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedStockVkOwner } from '../src/desktop/managed-stock-vk-owner.js';
import { RoutedCodexTasks } from '../src/core/codex-task-router.js';
import { ManagedWorkerControlRefusedError, ManagedWorkerControlUnknownError } from '../src/desktop/managed-worker-control-client.js';
import { ActionRejectedError, UncertainActionError, type CodexTasks, type SubmitTaskRequest } from '../src/core/codex-tasks.js';

const epoch = randomUUID();
const task = { hostId: 'local', threadId: 'own-thread', sourceId: 'managed-source' } as const;
const request = (): SubmitTaskRequest => ({ operationId: randomUUID(), task: { ...task }, text: 'plain VK request',
  author: { id: 42, name: 'VK author' }, outboxDir: 'C:\\owned\\outbox', inputFiles: [] });

function fixture() {
  const sent: SubmitTaskRequest[] = [];
  let result: 'accepted' | 'refused' | 'unknown' = 'accepted';
  let status: 'accepted' | 'rejected' | 'unknown' | null = 'accepted';
  let ready = true;
  let current = true;
  const client = {
    async submitVk(value: SubmitTaskRequest) {
      sent.push(value);
      if (result === 'refused') throw new ManagedWorkerControlRefusedError();
      if (result === 'unknown') throw new ManagedWorkerControlUnknownError();
      return { submissionId: 'submission-1' };
    },
    async vkSubmissionStatusByOperationId(_id: string) {
      if (status === null) return null;
      return { state: status, submissionId: status === 'accepted' ? 'submission-1' : null };
    },
  };
  const owner = new ManagedStockVkOwner({ binding: { ...task, ownerEpoch: epoch }, client,
    isReady: () => ready, isCurrent: () => current });
  return { owner, sent, setResult(value: typeof result) { result = value; },
    setStatus(value: typeof status) { status = value; }, setReady(value: boolean) { ready = value; },
    setCurrent(value: boolean) { current = value; } };
}

test('exclusive claim is exact and independent of transient readiness', async () => {
  const own = fixture();
  assert.equal(own.owner.routingPolicy, 'exclusive');
  assert.equal(own.owner.owns(task), true);
  assert.equal(own.owner.owns({ ...task, sourceId: 'other' }), false);
  assert.equal(own.owner.owns({ ...task, threadId: 'other' }), false);
  assert.equal(own.owner.owns({ ...task, hostId: 'remote' }), false);
  own.setReady(false);
  assert.equal(own.owner.owns(task), true);
  assert.equal(own.owner.isReady(task), false);
  await assert.rejects(own.owner.ensureOpen(task), ActionRejectedError);
});

test('submit and explicit queue return actual stock submission receipt, never a turn ID', async () => {
  const own = fixture();
  const input = request();
  let checks = 0;
  const withCallback = { ...input, task: { ...input.task, title: 'bridge binding field' },
    beforeSend: async () => { checks++; (input as { text: string }).text = 'changed'; } };
  assert.deepEqual(await own.owner.submitWithReceipt(withCallback), { mode: 'queue', submissionId: 'submission-1' });
  assert.equal(checks, 1);
  assert.equal(own.sent.length, 1);
  assert.equal(own.sent[0]?.text, 'plain VK request');
  assert.equal(Object.hasOwn(own.sent[0]!, 'beforeSend'), false);
  assert.deepEqual(own.sent[0]?.author, { id: 42, name: 'VK author' });
  assert.equal(own.sent[0]?.outboxDir, 'C:\\owned\\outbox');
  assert.equal(await own.owner.queue(request()), 'submission-1');
  assert.equal(own.sent.length, 2);
});

test('refusal, uncertainty, and local beforeSend failure never imply accepted submission', async () => {
  const own = fixture();
  own.setResult('refused');
  await assert.rejects(own.owner.submitWithReceipt(request()), ActionRejectedError);
  own.setResult('unknown');
  await assert.rejects(own.owner.submitWithReceipt(request()), UncertainActionError);
  const before = own.sent.length;
  await assert.rejects(own.owner.submitWithReceipt({ ...request(), beforeSend: async () => { throw new Error('revoked'); } }), ActionRejectedError);
  assert.equal(own.sent.length, before);
});

test('unavailable or changed claim refuses before local callback and worker control write', async () => {
  const own = fixture();
  let beforeSend = 0;
  const input = { ...request(), beforeSend: async () => { beforeSend++; } };
  own.setReady(false);
  await assert.rejects(own.owner.submitWithReceipt(input), ActionRejectedError);
  assert.equal(beforeSend, 0); assert.equal(own.sent.length, 0);
  own.setReady(true); own.setCurrent(false);
  await assert.rejects(own.owner.submitWithReceipt(input), ActionRejectedError);
  assert.equal(beforeSend, 0); assert.equal(own.sent.length, 0);
  own.setCurrent(true);
  await assert.rejects(own.owner.submitWithReceipt({ ...input,
    beforeSend: async () => { beforeSend++; own.setCurrent(false); } }), ActionRejectedError);
  assert.equal(beforeSend, 1); assert.equal(own.sent.length, 0);
});

test('scoped status is read-only and returns queue ID only for durable acceptance', async () => {
  const own = fixture();
  const id = randomUUID();
  assert.deepEqual(await own.owner.findQueuedSubmissionOutcome(task, id),
    { state: 'accepted', submissionId: 'submission-1' });
  assert.equal(await own.owner.findQueuedSubmission(task, id), 'submission-1');
  assert.equal(await own.owner.findAcceptedInput(task, id), null);
  own.setStatus('unknown');
  assert.deepEqual(await own.owner.findQueuedSubmissionOutcome(task, id), { state: 'unknown' });
  await assert.rejects(own.owner.findQueuedSubmission(task, id), UncertainActionError);
  own.setStatus('rejected');
  assert.deepEqual(await own.owner.findQueuedSubmissionOutcome(task, id), { state: 'rejected' });
  assert.equal(await own.owner.findQueuedSubmission(task, id), null);
  own.setStatus(null);
  assert.equal(await own.owner.findQueuedSubmissionOutcome(task, id), null);
  assert.equal(await own.owner.findQueuedSubmission(task, id), null);
  await assert.rejects(own.owner.findQueuedSubmissionOutcome({ ...task, sourceId: 'other' }, id), ActionRejectedError);
  await assert.rejects(own.owner.findQueuedSubmission({ ...task, sourceId: 'other' }, id), ActionRejectedError);
  assert.equal(own.sent.length, 0);
});

test('exclusive routing does not fall back to a legacy writer when control is unavailable', async () => {
  const own = fixture();
  let baseCalls = 0;
  const base = {
    submitWithReceipt: async () => { baseCalls++; return { mode: 'start' as const, turnId: 'wrong-owner' }; },
    findAcceptedInput: async () => { baseCalls++; return 'wrong-owner'; },
    findQueuedSubmission: async () => { baseCalls++; return 'wrong-owner'; },
  } as unknown as CodexTasks;
  const routed = new RoutedCodexTasks(base, [own.owner]);
  own.setReady(false);
  own.setResult('unknown');
  await assert.rejects(routed.submitWithReceipt(request()), ActionRejectedError);
  assert.equal(own.sent.length, 0);
  own.setReady(true);
  await assert.rejects(routed.submitWithReceipt(request()), UncertainActionError);
  assert.equal(own.sent.length, 1);
  assert.equal(await routed.findAcceptedInput(task, randomUUID()), null);
  own.setStatus('accepted');
  assert.equal(await routed.findQueuedSubmission(task, randomUUID()), 'submission-1');
  assert.equal(baseCalls, 0);
});

test('files, wrong task and unsupported mutations refuse before control write', async () => {
  const own = fixture();
  await assert.rejects(own.owner.submitWithReceipt({ ...request(), task: { ...task, threadId: 'other' } }), ActionRejectedError);
  await assert.rejects(own.owner.submitWithReceipt({ ...request(), inputFiles: [{ kind: 'image', path: 'C:\\image.png', originalName: 'image.png', sizeBytes: 1 }] }), ActionRejectedError);
  await assert.rejects(own.owner.interrupt(task), ActionRejectedError);
  await assert.rejects(own.owner.selectModel(task, 'model', 'low'), ActionRejectedError);
  await assert.rejects(own.owner.renameTask(task, 'name'), ActionRejectedError);
  await assert.rejects(own.owner.archiveTask(task), ActionRejectedError);
  assert.equal(own.sent.length, 0);
});
