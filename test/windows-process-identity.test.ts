import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { readWindowsProcessIdentity, readWindowsProcessIdentityAsync } from '../src/desktop/windows-process-identity.js';
import { observeSelectedWindowsProcessExits, isVerifiedSelectedProcessExit, ProcessAcquisitionBudget, type SelectedProcessIdentity } from '../src/desktop/windows-process-exit-witness.js';

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
test('asynchronous Windows observer validates IDs without blocking the event loop', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(readWindowsProcessIdentityAsync(0), /Invalid process ID/);
  const pending = readWindowsProcessIdentityAsync(process.pid);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(await pending, readWindowsProcessIdentity(process.pid));
  assert.equal(await readWindowsProcessIdentityAsync(2_147_483_647), null);
});

test('selected process witness refuses malformed identity scopes before any OS observation', async () => {
  const identity = { pid: 123, birthTicks: '639100000000000000', imagePath: 'C:\\fixture\\node.exe', imageSha256: 'a'.repeat(64) };
  for (const processes of [[], [identity, identity], [{ ...identity, pid: 0 }], [{ ...identity, pid: 2_147_483_648 }],
    [{ ...identity, birthTicks: 639100000000000000 }], [{ ...identity, imagePath: 'relative.exe' }],
    [{ ...identity, imagePath: 'C:\\fixture\\..\\node.exe' }], [{ ...identity, imagePath: 'C:\\fixture\\node.exe:stream' }],
    [{ ...identity, imagePath: '\\\\server\\share\\node.exe' }], [{ ...identity, imagePath: '\\\\?\\C:\\fixture\\node.exe' }],
    [{ ...identity, imageSha256: 'not-a-digest' }], [{ ...identity, extra: true }]])
    await assert.rejects(observeSelectedWindowsProcessExits(processes as unknown as SelectedProcessIdentity[]), /Invalid selected process/);
  for (const deadline of [-1, 1.5, NaN, Infinity, 60_001])
    await assert.rejects(observeSelectedWindowsProcessExits([identity], deadline), /Invalid selected process observation/);
  assert.equal(isVerifiedSelectedProcessExit({ kind: 'selected-original-processes-gone' }), false);
});

test('one monotonic acquisition budget bounds a hung preflight and cannot launch after a late completion', async () => {
  const budget = new ProcessAcquisitionBudget(50);
  let finishRead!: (value: string) => void; let launches = 0;
  const reading = new Promise<string>(resolve => { finishRead = resolve; });
  const operation = (async () => { await budget.read(() => reading); budget.assertCurrent(); launches++; })();
  await assert.rejects(operation, /acquisition budget expired/);
  finishRead('late filesystem result');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(launches, 0);
  await assert.rejects(budget.read(async () => 'a new read cannot reset the deadline'), /acquisition budget expired/);
  const current = new ProcessAcquisitionBudget(1_000);
  assert.equal(await current.read(async () => 'current'), 'current');
  assert.throws(() => new ProcessAcquisitionBudget(15_001), /Invalid process acquisition budget/);
});

async function witnessIdentity(pid: number): Promise<SelectedProcessIdentity> {
  const imagePath = await realpath(process.execPath);
  const imageSha256 = createHash('sha256').update(await readFile(imagePath)).digest('hex');
  const identity = await readWindowsProcessIdentityAsync(pid);
  assert.ok(identity, 'test-owned process must still be alive');
  return { ...identity, imagePath, imageSha256 };
}

test('real retained-handle witness reports a live original as blocked and never brands a snapshot',
  { skip: process.platform !== 'win32' }, async () => {
    const result = await observeSelectedWindowsProcessExits([await witnessIdentity(process.pid)], 50);
    assert.deepEqual(result, { kind: 'blocked' });
    assert.equal(isVerifiedSelectedProcessExit(result), false);
  });

test('real handle birth uses NET ticks and both harmless original processes must naturally exit',
  { skip: process.platform !== 'win32', timeout: 45_000 }, async () => {
    // No signal/kill/tree cleanup: fixture lifetimes terminate themselves.
    const children = [15_000, 16_000].map(ms => spawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), Number(process.argv[1]))', String(ms)], { windowsHide: true, stdio: 'ignore' }));
    const exits = children.map(child => new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture failed')));
    }));
    try {
      const identities = await Promise.all(children.map(child => witnessIdentity(child.pid!)));
      const result = await observeSelectedWindowsProcessExits(identities, 20_000);
      assert.equal(result.kind, 'selected-original-processes-gone');
      assert.equal(isVerifiedSelectedProcessExit(result), true);
      assert.equal(isVerifiedSelectedProcessExit(JSON.parse(JSON.stringify(result))), false,
        'a historical JSON record is not current OS evidence');
      if (result.kind === 'selected-original-processes-gone') {
        assert.equal(result.exits.length, 2);
        assert.deepEqual(result.exits.map(exit => exit.birthTicks), identities.map(identity => identity.birthTicks),
          'GetProcessTimes is normalized to the exact existing Process.StartTime UTC ticks');
        for (const exit of result.exits) assert.ok(BigInt(exit.exitTicks) > BigInt(exit.birthTicks));
      }
    } finally { await Promise.all(exits); }
  });

test('real process witness refuses wrong generation or image and does not turn absence into exit proof',
  { skip: process.platform !== 'win32' }, async () => {
    const identity = await witnessIdentity(process.pid);
    for (const wrong of [{ ...identity, birthTicks: String(BigInt(identity.birthTicks) + 1n) },
      { ...identity, imageSha256: '0'.repeat(64) }, { ...identity, pid: 2_147_483_647 }]) {
      const result = await observeSelectedWindowsProcessExits([wrong], 0);
      assert.deepEqual(result, { kind: 'unavailable' });
      assert.equal(isVerifiedSelectedProcessExit(result), false);
    }
  });
