import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskRef } from '../src/core/codex-tasks.js';
import type { TaskState, TaskStateStream, TaskStateTransport } from '../src/core/task-state.js';
import { ManagedClaimStateTransport } from '../src/codex/managed-claim-state-transport.js';

const task: TaskRef = { hostId: 'local', threadId: 'thread-a', sourceId: 'source-a' };

class FakeStream implements TaskStateStream {
  closed = false;
  onStart: (() => void) | null = null;
  onVerify: (() => void) | null = null;
  constructor(readonly task: TaskRef) {}
  async start(): Promise<void> { this.onStart?.(); }
  async verifyOwner(): Promise<void> { this.onVerify?.(); }
  diagnostic() { return { kind: 'app-server' as const }; }
  close(): void { this.closed = true; }
}

class FakeTransport implements TaskStateTransport {
  closed = false;
  stream: FakeStream | null = null;
  onState: ((state: TaskState, initial: boolean) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  subscribe(ref: TaskRef, onState: (state: TaskState, initial: boolean) => void,
    onError: (error: Error) => void): TaskStateStream {
    this.stream = new FakeStream(ref);
    this.onState = onState;
    this.onError = onError;
    return this.stream;
  }
  close(): void { this.closed = true; }
}

test('managed state claim fences subscription, frames and verify after revision change', async () => {
  const base = new FakeTransport();
  let current = true;
  const transport = new ManagedClaimStateTransport(base, task, () => current);
  const seen: string[] = [], errors: Error[] = [];
  const stream = transport.subscribe(task, state => seen.push(String(state.marker)), error => errors.push(error));
  await stream.start();
  base.onState?.({ marker: 'initial' }, true);
  assert.deepEqual(seen, ['initial']);
  current = false;
  base.onState?.({ marker: 'late' }, false);
  assert.deepEqual(seen, ['initial']);
  assert.equal(errors.length, 1);
  assert.equal(base.stream?.closed, true);
  assert.equal(stream.diagnostic?.().kind, 'unknown');
  await assert.rejects(stream.verifyOwner(), /claim is no longer current/);
  assert.throws(() => transport.subscribe(task, () => {}, () => {}), /claim is no longer current/);
  transport.close();
  assert.equal(base.closed, true);
});

test('managed state claim checks immediately before and after asynchronous owner probes', async () => {
  const base = new FakeTransport();
  let current = true;
  const transport = new ManagedClaimStateTransport(base, task, () => current);
  const stream = transport.subscribe(task, () => {}, () => {});
  base.stream!.onStart = () => { current = false; };
  await assert.rejects(stream.start(), /claim is no longer current/);
  assert.equal(base.stream?.closed, true);
  transport.close();

  const next = new FakeTransport();
  current = true;
  const fresh = new ManagedClaimStateTransport(next, task, () => current);
  const second = fresh.subscribe(task, () => {}, () => {});
  await second.start();
  next.stream!.onVerify = () => { current = false; };
  await assert.rejects(second.verifyOwner(), /claim is no longer current/);
  assert.equal(next.stream?.closed, true);
  fresh.close();
});

test('managed state claim does not open a different task or source', () => {
  const base = new FakeTransport();
  const transport = new ManagedClaimStateTransport(base, task, () => true);
  assert.throws(() => transport.subscribe({ ...task, sourceId: 'other' }, () => {}, () => {}));
  assert.throws(() => transport.subscribe({ ...task, threadId: 'other' }, () => {}, () => {}));
  assert.equal(base.stream, null);
  transport.close();
});

test('underlying state failure closes its stream before reporting the failure', async () => {
  const base = new FakeTransport();
  const transport = new ManagedClaimStateTransport(base, task, () => true);
  let closedWhenReported = false;
  const stream = transport.subscribe(task, () => {}, () => {
    closedWhenReported = base.stream?.closed === true;
  });
  await stream.start();
  base.onError?.(new Error('private socket failed'));
  assert.equal(closedWhenReported, true);
  assert.equal(base.stream?.closed, true);
  stream.close(); transport.close();
});
