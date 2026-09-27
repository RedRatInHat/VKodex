import test from "node:test";
import assert from "node:assert/strict";
import { HomogeneousStockQueuePolicy, type HomogeneousQueueSettings, type PlainTextQueueInput, type QueueObservation } from "../src/codex/homogeneous-queue-policy.js";

const settings = (): HomogeneousQueueSettings => ({
  cwd: 'C:/isolated', runtimeWorkspaceRoots: ['C:/isolated'],
  approvalPolicy: 'never', approvalsReviewer: 'user',
  permissions: ':read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false },
  model: 'gpt-5.6-sol', serviceTier: null, effort: 'medium',
  summary: null, collaborationMode: { mode: 'default', settings: {} },
  personality: 'pragmatic',
});
const input: readonly PlainTextQueueInput[] = [{ type: "text", text: "public sentinel", text_elements: [] }];
const make = (): HomogeneousStockQueuePolicy => new HomogeneousStockQueuePolicy({ taskId: "task-1", ownerEpoch: "owner-1" });
const observed = (policy: HomogeneousStockQueuePolicy, revision: number, overrides: Partial<QueueObservation> = {}) => {
  const ticket = policy.beginObservation();
  return policy.observe(ticket, {
    taskId: 'task-1', ownerEpoch: 'owner-1', revision, complete: true,
    serialized: true, effectiveSettings: settings(), queueClientIds: [],
    activeClientIds: [], terminalClientIds: [], idle: true, ...overrides,
  });
};

test('requires authoritative baseline and compares complete JSON settings', () => {
  const policy = make();
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() }));
  observed(policy, 1);
  const reordered = Object.fromEntries(Object.entries(settings()).reverse()) as HomogeneousQueueSettings;
  assert.equal(policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: reordered }).clientUserMessageId, 'one');
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: { ...settings(), effort: 'high' } }));
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: { ...settings(), runtimeWorkspaceRoots: ['C:/other'] } }));
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: { ...settings(), extra: true } as unknown as HomogeneousQueueSettings }));
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: { ...settings(), summary: undefined } as unknown as HomogeneousQueueSettings }));
});

test('in-flight admission blocks settings write; accepted item needs terminal reconciliation', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  assert.throws(() => policy.reserveSettingsChange({ ownerEpoch: 'owner-1', effectiveSettings: { ...settings(), effort: 'high' } }));
  policy.recordAddOutcome(add, 'accepted');
  observed(policy, 2);
  assert.equal(policy.status().locked, true); // empty queue may mean claimed turn
  assert.throws(() => policy.reserveSettingsChange({ ownerEpoch: 'owner-1', effectiveSettings: { ...settings(), effort: 'high' } }));
  observed(policy, 3, { terminalClientIds: ['one'] });
  assert.equal(policy.status().locked, false);
});

test('unknown add outcome freezes even when stock queue appears empty', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(add, 'unknown');
  observed(policy, 2);
  assert.equal(policy.status().locked, true);
  assert.throws(() => policy.reserveSettingsChange({ ownerEpoch: 'owner-1', effectiveSettings: settings() }));
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: settings() }),
    /unresolved admission/, 'an unknown prior send must not admit a new queued message');
  observed(policy, 3, { terminalClientIds: ['one'] });
  assert.equal(policy.status().locked, false);
  assert.equal(policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: settings() }).clientUserMessageId, 'two');
});

test('definitive server rejection releases only after a fresh drained read', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(add, 'definitively-rejected');
  assert.equal(policy.status().locked, true);
  observed(policy, 2);
  assert.equal(policy.status().locked, false);
});

test('pre-mutation and stale revision observations cannot clear a lock', () => {
  const policy = make(); observed(policy, 1);
  const staleRead = policy.beginObservation();
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(add, 'definitively-rejected');
  assert.throws(() => policy.observe(staleRead, { taskId: 'task-1', ownerEpoch: 'owner-1', revision: 2, complete: true, serialized: true, effectiveSettings: settings(), queueClientIds: [], activeClientIds: [], terminalClientIds: [], idle: true }));
  assert.throws(() => observed(policy, 1));
  assert.equal(policy.status().locked, true);
  observed(policy, 3);
  assert.equal(policy.status().locked, false);
});

test('owner epoch change fences late acknowledgments and retains unresolved admission', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.changeOwnerEpoch('owner-2');
  assert.throws(() => policy.recordAddOutcome(add, 'accepted'));
  const ticket = policy.beginObservation();
  policy.observe(ticket, { taskId: 'task-1', ownerEpoch: 'owner-2', revision: 2, complete: true, serialized: true, effectiveSettings: settings(), queueClientIds: [], activeClientIds: [], terminalClientIds: [], idle: true });
  assert.equal(policy.status().locked, true);
  assert.throws(() => policy.reserveSettingsChange({ ownerEpoch: 'owner-2', effectiveSettings: settings() }));
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-2', clientUserMessageId: 'two', input, effectiveSettings: settings() }),
    /unresolved admission/, 'a new owner must not enqueue over the previous owner unresolved send');
});

test('settings write fences admission and unknown write remains frozen', () => {
  const policy = make(); observed(policy, 1);
  const next = { ...settings(), effort: 'high' };
  const write = policy.reserveSettingsChange({ ownerEpoch: 'owner-1', effectiveSettings: next });
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() }));
  policy.recordSettingsOutcome(write, 'unknown');
  observed(policy, 2, { effectiveSettings: next });
  assert.equal(policy.status().locked, true);
});

test('rejects incomplete reads, foreign queue, and unsupported input before admission', () => {
  const policy = make();
  const ticket = policy.beginObservation();
  assert.throws(() => policy.observe(ticket, { taskId: 'task-1', ownerEpoch: 'owner-1', revision: 1, complete: false, serialized: true } as unknown as QueueObservation));
  observed(policy, 1, { queueClientIds: ['foreign'] });
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() }));
  const fresh = make(); observed(fresh, 1);
  assert.throws(() => fresh.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input: [{ type: 'image', image: 'x' }] as unknown as readonly PlainTextQueueInput[], effectiveSettings: settings() }));
});

test('late duplicate or contradictory add outcome cannot overwrite accepted or unknown', () => {
  const policy = make(); observed(policy, 1);
  const first = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(first, 'accepted');
  assert.throws(() => policy.recordAddOutcome(first, 'definitively-rejected'));
  const second = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: settings() });
  policy.recordAddOutcome(second, 'unknown');
  assert.throws(() => policy.recordAddOutcome(second, 'definitively-rejected'));
  observed(policy, 2, { terminalClientIds: ['one'] });
  assert.equal(policy.status().locked, true);
});

test('contradictory queue and terminal observation is rejected without unlocking', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(add, 'accepted');
  assert.throws(() => observed(policy, 2, { queueClientIds: ['one'], terminalClientIds: ['one'] }));
  assert.equal(policy.status().revision, 1);
  assert.equal(policy.status().locked, true);
});

test('settings drift during accepted work latches a failure', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(add, 'accepted');
  observed(policy, 2, { effectiveSettings: { ...settings(), effort: 'high' }, terminalClientIds: ['one'] });
  assert.equal(policy.status().poisoned, true);
  assert.equal(policy.status().locked, true);
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: settings() }));
});

test('same named permission profile with changed resolved sandbox is incompatible', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(add, 'accepted');
  const drifted = { ...settings(), sandboxPolicy: { type: 'readOnly', networkAccess: true } };
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'two', input, effectiveSettings: drifted }));
  observed(policy, 2, { effectiveSettings: drifted, terminalClientIds: ['one'] });
  assert.equal(policy.status().poisoned, true);
  assert.equal(policy.status().locked, true);
});

test('observation tickets are single-use and task-bound', () => {
  const policy = make(); const ticket = policy.beginObservation();
  const base = { taskId: 'task-1', ownerEpoch: 'owner-1', revision: 1,
    complete: true, serialized: true, effectiveSettings: settings(),
    queueClientIds: [], activeClientIds: [], terminalClientIds: [], idle: true };
  assert.throws(() => policy.observe(ticket, { ...base, taskId: 'other' }));
  policy.observe(ticket, base);
  assert.throws(() => policy.observe(ticket, { ...base, revision: 2 }));
  assert.throws(() => policy.observe({ ...ticket, sequence: ticket.sequence + 1 }, { ...base, revision: 2 }));
  assert.equal(policy.status().revision, 1);
});

test('rejects lossy JSON representations and unknown active first admission', () => {
  const policy = make(); observed(policy, 1, { idle: false });
  assert.throws(() => policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() }));
  const fresh = make(); observed(fresh, 1);
  const settingsWithProtoKey = settings();
  Object.defineProperty(settingsWithProtoKey.collaborationMode as object, '__proto__', { enumerable: true, value: { mode: 'wrong' } });
  assert.throws(() => fresh.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settingsWithProtoKey }));
  const sparse = settings(); Object.defineProperty(sparse, 'runtimeWorkspaceRoots', { value: new Array(1) });
  assert.throws(() => fresh.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: sparse }));
});

test('owner revisions are epoch scoped, but old tickets stay invalid if owner name recurs', () => {
  const policy = make(); observed(policy, 100);
  const old = policy.beginObservation();
  policy.changeOwnerEpoch('owner-2');
  let ticket = policy.beginObservation();
  policy.observe(ticket, { taskId: 'task-1', ownerEpoch: 'owner-2', revision: 1,
    complete: true, serialized: true, effectiveSettings: settings(), queueClientIds: [], activeClientIds: [], terminalClientIds: [], idle: true });
  policy.changeOwnerEpoch('owner-1');
  assert.throws(() => policy.observe(old, { taskId: 'task-1', ownerEpoch: 'owner-1', revision: 1,
    complete: true, serialized: true, effectiveSettings: settings(), queueClientIds: [], activeClientIds: [], terminalClientIds: [], idle: true }));
  ticket = policy.beginObservation();
  policy.observe(ticket, { taskId: 'task-1', ownerEpoch: 'owner-1', revision: 1,
    complete: true, serialized: true, effectiveSettings: settings(), queueClientIds: [], activeClientIds: [], terminalClientIds: [], idle: true });
  assert.equal(policy.status().revision, 1);
});

test('terminal before add acknowledgment retains receipt and old observation is fenced', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  const stale = policy.beginObservation();
  observed(policy, 2, { terminalClientIds: ['one'] });
  assert.equal(policy.status().locked, true);
  policy.recordAddOutcome(add, 'accepted');
  assert.throws(() => policy.observe(stale, { taskId: 'task-1', ownerEpoch: 'owner-1', revision: 3,
    complete: true, serialized: true, effectiveSettings: settings(), queueClientIds: [], activeClientIds: [], terminalClientIds: ['one'], idle: true }));
  observed(policy, 3, { terminalClientIds: ['one'] });
  assert.equal(policy.status().locked, false);
});

test('repeated owner label cannot settle unresolved work from an earlier generation', () => {
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: 'owner-1', clientUserMessageId: 'one', input, effectiveSettings: settings() });
  policy.recordAddOutcome(add, 'unknown');
  policy.changeOwnerEpoch('owner-2');
  policy.changeOwnerEpoch('owner-1');
  observed(policy, 1, { terminalClientIds: ['one'] });
  assert.equal(policy.status().locked, true);
  assert.equal(policy.status().unresolvedCount, 1);
});

test("runtime-invalid values reject without corrupting a valid pending operation", () => {
  assert.throws(() => new HomogeneousStockQueuePolicy({ taskId: 1, ownerEpoch: "owner-1" } as unknown as { taskId: string; ownerEpoch: string }));
  const policy = make(); observed(policy, 1);
  const add = policy.reserveAdd({ ownerEpoch: "owner-1", clientUserMessageId: "one", input, effectiveSettings: settings() });
  assert.throws(() => policy.recordAddOutcome(add, "invalid" as unknown as "accepted"));
  assert.throws(() => policy.reserveAdd({ ownerEpoch: "owner-1", clientUserMessageId: 2, input, effectiveSettings: settings() } as unknown as { ownerEpoch: string; clientUserMessageId: string; input: readonly PlainTextQueueInput[]; effectiveSettings: HomogeneousQueueSettings }));
  assert.throws(() => policy.changeOwnerEpoch(3 as unknown as string));
  policy.recordAddOutcome(add, "accepted");
  observed(policy, 2, { terminalClientIds: ["one"] });
  assert.equal(policy.status().locked, false);
});
