import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { deriveManagedTaskStateToken } from '../src/desktop/managed-worker-task-state-token.js';

test('managed task-state token is domain-separated and scoped to exact worker generation', () => {
  const raw = Buffer.alloc(32, 3);
  const key = raw.toString('base64');
  const epoch = '12345678-1234-4234-8234-123456789abc';
  const task = 'task-one';
  const expected = createHmac('sha256', raw)
    .update('vkodex-managed-task-state-v1\0').update(epoch).update('\0').update(task)
    .update('\0').update('1').digest('base64url');
  assert.equal(deriveManagedTaskStateToken(key, epoch, task, 1), expected);
  assert.notEqual(deriveManagedTaskStateToken(key, epoch, task, 2), expected);
  assert.notEqual(deriveManagedTaskStateToken(key, epoch, 'task-two', 1), expected);
  assert.throws(() => deriveManagedTaskStateToken('not-a-key', epoch, task, 1));
  assert.throws(() => deriveManagedTaskStateToken(key, epoch, task, 0));
});
