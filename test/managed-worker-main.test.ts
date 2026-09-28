import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseManagedWorkerArguments } from '../src/desktop/managed-worker-main.js';

const baseDirectory = path.resolve('private');
const epoch = 'b7e239fa-091e-41bc-ad3f-a2e27a410f27';
const args = ['--private-base', baseDirectory, '--epoch', epoch, '--native-ipc', 'local'];
test('daemon main accepts only explicit scoped local-native opt-in', () => {
  assert.deepEqual(parseManagedWorkerArguments(args), { baseDirectory, epoch, nativeIpc: 'local' });
  assert.equal(Object.isFrozen(parseManagedWorkerArguments(args)), true);
});
test('daemon main accepts an exact read-only task-state opt-in', () => {
  assert.deepEqual(parseManagedWorkerArguments([...args, '--native-task-state']),
    { baseDirectory, epoch, nativeIpc: 'local', nativeTaskState: true });
});
test('daemon main refuses missing, duplicated, unknown or unscoped arguments', () => {
  for (const input of [[], args.slice(0, 4), [...args, '--force'],
    [...args, '--native-task-state', '--native-task-state'],
    ['--private-base', 'relative', ...args.slice(2)],
    [...args.slice(0, 3), '../other', ...args.slice(4)],
    [...args.slice(0, 5), 'external'], ['--epoch', epoch, ...args.slice(2)]]) {
    assert.throws(() => parseManagedWorkerArguments(input), /Invalid managed worker arguments/);
  }
});
