import assert from 'node:assert/strict';
import test from 'node:test';
import { readWindowsProcessIdentity } from '../src/desktop/windows-process-identity.js';

test('process observer refuses invalid IDs before attempting a query', () => {
  for (const id of [0, -1, NaN, 1.5, Infinity, 2_147_483_648])
    assert.throws(() => readWindowsProcessIdentity(id), /Invalid process ID/);
});
test('Windows observer reports stable current birth and distinguishes absence', { skip: process.platform !== 'win32' }, () => {
  const first = readWindowsProcessIdentity(process.pid);
  assert.equal(first?.pid, process.pid);
  assert.match(first!.birthTicks, /^[1-9]\d{16,19}$/);
  assert.deepEqual(readWindowsProcessIdentity(process.pid), first);
  assert.equal(readWindowsProcessIdentity(2_147_483_647), null);
});
