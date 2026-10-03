import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import path from 'node:path';
import { deploymentStartupEnvironment } from '../src/desktop/deployment-execution.js';
import { readWindowsProcessIdentity, readWindowsProcessIdentityAsync } from '../src/desktop/windows-process-identity.js';
import { observeSelectedWindowsProcessExits, captureSelectedWindowsProcesses, isCurrentWindowsProcessCaptureTicket,
  isVerifiedSelectedProcessExit, ProcessAcquisitionBudget, type SelectedProcessIdentity } from '../src/desktop/windows-process-exit-witness.js';

test('concrete predecessor cutover requires an explicit pinned operator action and never accepts a stored closure', async () => {
  const controller = await import('../src/desktop/predecessor-cutover-controller.js');
  const requestPath = path.resolve('private-fixture', 'action.json');
  assert.throws(() => controller.predecessorCutoverArguments([]));
  assert.throws(() => controller.predecessorCutoverArguments(['--request', requestPath, '--sha256', 'a'.repeat(64)]));
  assert.throws(() => controller.predecessorCutoverArguments(['--request', 'private-fixture/action.json', '--sha256', 'a'.repeat(64),
    '--operator-approved-stop', 'stop-selected-legacy-runtime-no-replay']));
  assert.deepEqual(controller.predecessorCutoverArguments(['--request', requestPath, '--sha256', 'a'.repeat(64),
    '--operator-approved-stop', 'stop-selected-legacy-runtime-no-replay']), {
    requestPath, requestSha256: 'a'.repeat(64),
    operatorApproval: 'stop-selected-legacy-runtime-no-replay',
  });
  assert.equal(controller.isVerifiedKnownPredecessorStop({ kind: 'known-predecessor-stopped', exits: [] }), false);
  await assert.rejects(controller.stopPinnedPredecessor({ requestPath, requestSha256: 'a'.repeat(64),
    operatorApproval: 'not-approved' }), /Predecessor cutover refused/);
});

test('Windows Task definition pin accepts implicit Enabled default and permits no behavior change except Enabled',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    const { predecessorCutoverWindowsScript } = await import('../src/desktop/predecessor-cutover-windows.js');
    const begin = predecessorCutoverWindowsScript.indexOf('  function Definition-Hash(');
    const end = predecessorCutoverWindowsScript.indexOf('  $scheduler=', begin);
    assert.ok(begin > 0 && end > begin);
    const fixture = '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings><Actions><Exec><Command>fixture-original.exe</Command></Exec></Actions></Task>';
    const docs = { missing: fixture, enabled: fixture.replace('</Settings>', '<Enabled>true</Enabled></Settings>'),
      disabled: fixture.replace('</Settings>', '<Enabled>false</Enabled></Settings>'),
      changed: fixture.replace('fixture-original.exe', 'fixture-different.exe'),
      dtd: '<!DOCTYPE Task [<!ENTITY external SYSTEM "file:///never-read-fixture">]>' + fixture };
    const systemDirectory = path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0');
    const script = `$ErrorActionPreference='Stop'\n${predecessorCutoverWindowsScript.slice(begin, end)}\n` +
      "$docs=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VKODEX_TASK_XML_FIXTURE))|ConvertFrom-Json\n" +
      "$dtdRefused=$false;try{$null=Definition-Hash @{Xml=$docs.dtd}}catch{$dtdRefused=$true}\n" +
      "[Console]::Out.WriteLine((@{missing=(Definition-Hash @{Xml=$docs.missing});enabled=(Definition-Hash @{Xml=$docs.enabled});disabled=(Definition-Hash @{Xml=$docs.disabled});changed=(Definition-Hash @{Xml=$docs.changed});dtdRefused=$dtdRefused}|ConvertTo-Json -Compress))";
    const result = await promisify(childProcess.execFile)(path.win32.join(systemDirectory, 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 4096,
        env: { ...deploymentStartupEnvironment(process.env), PSModulePath: path.win32.join(systemDirectory, 'Modules'),
          VKODEX_TASK_XML_FIXTURE: Buffer.from(JSON.stringify(docs)).toString('base64') } });
    assert.equal(result.stderr.trim(), '');
    const row = JSON.parse(result.stdout.trim());
    assert.equal(row.missing, row.enabled); assert.equal(row.missing, row.disabled);
    assert.notEqual(row.missing, row.changed); assert.equal(row.dtdRefused, true);
  });

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

test('capture-ready ticket is live before terminal, binds exactly to selected exits, and is not JSON authority',
  { skip: process.platform !== 'win32', timeout: 45_000 }, async () => {
    const children = [10_000, 11_000].map(ms => spawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), Number(process.argv[1]))', String(ms)], { windowsHide: true, stdio: 'ignore' }));
    const exits = children.map(child => new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture failed')));
    }));
    try {
      const identities = await Promise.all(children.map(child => witnessIdentity(child.pid!)));
      const session = await captureSelectedWindowsProcesses(identities, 20_000);
      assert.ok(session, 'the observer must expose the retained-handle capture before the children exit');
      assert.equal(isCurrentWindowsProcessCaptureTicket(session.ticket), true);
      assert.deepEqual(JSON.parse(JSON.stringify(session.ticket)), {
        kind: 'captured', identitySha256: session.ticket.identitySha256, processCount: identities.length
      });
      assert.equal(isCurrentWindowsProcessCaptureTicket(JSON.parse(JSON.stringify(session.ticket))), false,
        'serialized capture metadata cannot be replayed as a current ticket');
      const result = await session.completion;
      assert.equal(result.kind, 'selected-original-processes-gone');
      assert.equal(result.identitySha256, session.ticket.identitySha256,
        'the terminal evidence must be bound to the exact captured ticket');
      assert.equal(isVerifiedSelectedProcessExit(result), true);
      assert.equal(isCurrentWindowsProcessCaptureTicket(session.ticket), false,
        'terminal completion revokes the sequencing ticket');
      if (result.kind === 'selected-original-processes-gone') {
        assert.deepEqual(result.exits.map(exit => exit.pid), identities.map(identity => identity.pid));
        assert.deepEqual(result.exits.map(exit => exit.birthTicks), identities.map(identity => identity.birthTicks));
      }
    } finally { await Promise.all(exits); }
  });

test('capture cancellation revokes the ticket and cannot later produce positive completion',
  { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
    const child = spawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 3_000)'], { windowsHide: true, stdio: 'ignore' });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture failed')));
    });
    try {
      const session = await captureSelectedWindowsProcesses([await witnessIdentity(child.pid!)], 5_000);
      assert.ok(session);
      assert.equal(isCurrentWindowsProcessCaptureTicket(session.ticket), true);
      session.cancelObservation();
      assert.equal(isCurrentWindowsProcessCaptureTicket(session.ticket), false);
      assert.deepEqual(await session.completion, { kind: 'unavailable' });
      assert.equal(isVerifiedSelectedProcessExit(await session.completion), false);
    } finally { await exited; }
  });

test('capture protocol unit faults never mint a ticket from late frames or stream errors',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
    const identity = await witnessIdentity(process.pid);
    const originalSpawn = childProcess.spawn;
    let mode: 'late-exit' | 'terminal-before-capture' | 'terminal-after-exit' | 'stdin-EPIPE' = 'late-exit';
    let lastFakeExit: Promise<void> = Promise.resolve();
    childProcess.spawn = ((_: string, __: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      const envScope = options.env?.VKODEX_EXIT_WITNESS_SCOPE;
      assert.equal(typeof envScope, 'string');
      const scope = JSON.parse(Buffer.from(envScope!, 'base64').toString('utf8')) as { challenge: string; processes: unknown[] };
      const identitySha256 = createHash('sha256').update(Buffer.from(envScope!, 'base64')).digest('hex');
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
        killed: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null; pid: number;
        kill: ChildProcess['kill'];
      };
      lastFakeExit = new Promise(resolve => child.once('exit', () => resolve()));
      const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr, killed: false, exitCode: null, signalCode: null, pid: 991_001 });
      child.kill = (() => {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        child.exitCode = 1; child.signalCode = 'SIGTERM'; child.killed = true;
        setImmediate(() => { stdout.end(); stderr.end(); child.emit('exit', 1, 'SIGTERM'); child.emit('close', 1, 'SIGTERM'); });
        return true;
      }) as ChildProcess['kill'];
      const captured = JSON.stringify({ kind: 'captured', challenge: scope.challenge,
        identitySha256, processCount: scope.processes.length }) + '\n';
      if (mode === 'late-exit') {
        child.exitCode = 0; child.emit('exit', 0, null);
        setImmediate(() => { stdout.write(captured); stdout.end(); stderr.end(); child.emit('close', 0, null); });
      } else if (mode === 'terminal-before-capture') {
        stdin.end = (() => stdin) as typeof stdin.end;
        setImmediate(() => {
          stdout.write(JSON.stringify({ kind: 'unavailable' }) + '\n' + captured);
          stdout.end(); stderr.end(); child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null);
        });
      } else if (mode === 'terminal-after-exit') {
        const end = stdin.end.bind(stdin);
        stdin.end = ((...args: Parameters<typeof stdin.end>) => {
          const result = end(...args);
          child.exitCode = 0; child.emit('exit', 0, null);
          const terminal = JSON.stringify({ kind: 'selected-original-processes-gone', challenge: scope.challenge,
            identitySha256, exits: [{ pid: identity.pid, birthTicks: identity.birthTicks,
              exitTicks: String(BigInt(identity.birthTicks) + 1n) }] }) + '\n';
          setImmediate(() => { stdout.write(terminal); stdout.end(); stderr.end(); child.emit('close', 0, null); });
          return result;
        }) as typeof stdin.end;
        setImmediate(() => stdout.write(captured));
      } else {
        const end = stdin.end.bind(stdin);
        stdin.end = ((...args: Parameters<typeof stdin.end>) => {
          queueMicrotask(() => stdin.emit('error', Object.assign(new Error('mock EPIPE'), { code: 'EPIPE' })));
          return end(...args);
        }) as typeof stdin.end;
        setImmediate(() => stdout.write(captured));
      }
      return child as unknown as ChildProcess;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    try {
      const late = await captureSelectedWindowsProcesses([identity], 1_000);
      assert.equal(late, null, 'a buffered captured frame after process exit must not mint a ticket');

      mode = 'terminal-before-capture';
      const outOfOrder = await captureSelectedWindowsProcesses([identity], 1_000);
      assert.equal(outOfOrder, null, 'a capture frame after a terminal refusal must not mint a ticket');

      mode = 'terminal-after-exit';
      const terminalAfterExit = await captureSelectedWindowsProcesses([identity], 1_000);
      assert.ok(terminalAfterExit);
      assert.equal(isCurrentWindowsProcessCaptureTicket(terminalAfterExit.ticket), true,
        'capture must be visible before the mock helper receives the acknowledgement');
      await lastFakeExit;
      assert.equal(isCurrentWindowsProcessCaptureTicket(terminalAfterExit.ticket), false,
        'helper exit revokes the current ticket even while terminal output remains buffered');
      assert.equal((await terminalAfterExit.completion).kind, 'selected-original-processes-gone',
        'a valid terminal frame may drain after helper exit once capture had already been established');

      mode = 'stdin-EPIPE';
      const brokenPipe = await captureSelectedWindowsProcesses([identity], 1_000);
      assert.ok(brokenPipe, 'the captured frame itself may arrive before the acknowledgement pipe fails');
      assert.deepEqual(await brokenPipe.completion, { kind: 'unavailable' });
      assert.equal(isCurrentWindowsProcessCaptureTicket(brokenPipe.ticket), false);
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  });

test('real retained Windows handle refuses an expired action and leaves its original process alive',
  { skip: process.platform !== 'win32', timeout: 45_000 }, async () => {
    const { predecessorCutoverWindowsScript } = await import('../src/desktop/predecessor-cutover-windows.js');
    const classStart = predecessorCutoverWindowsScript.indexOf("  Add-Type -TypeDefinition @'\n");
    const classEnd = predecessorCutoverWindowsScript.indexOf("\n'@", classStart);
    assert.ok(classStart >= 0 && classEnd > classStart, 'the reviewed cutover script must contain its concrete C# handle class');
    const csharp = predecessorCutoverWindowsScript.slice(classStart + "  Add-Type -TypeDefinition @'\n".length, classEnd);
    assert.match(csharp, /public sealed class VKodexCutoverHandle/);
    assert.match(csharp, /if\(remaining<=0\) throw new InvalidOperationException\("action-expired"\)/);

    const child = spawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 14_000)'], { windowsHide: true, stdio: 'ignore' });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve(code) : reject(new Error('Fixture failed')));
    });
    try {
      const identity = await witnessIdentity(child.pid!);
      const powershellDirectory = path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0');
      const powershell = path.win32.join(powershellDirectory, 'powershell.exe');
      const helper = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${csharp}\n'@\n` +
        '$handle=$null; try { ' +
        '$handle=New-Object VKodexCutoverHandle ([int]$env:VKODEX_FIXTURE_PID),$env:VKODEX_FIXTURE_BIRTH,' +
        '$env:VKODEX_FIXTURE_IMAGE,$env:VKODEX_FIXTURE_IMAGE_SHA256,$true; ' +
        '$beforeAlive=$null -eq $handle.ExitTicks(); $expired=$false; ' +
        'try { $null=$handle.Stop(([VKodexCutoverHandle]::Now())-1) } catch { $exception=$_.Exception; while($null -ne $exception.InnerException) { $exception=$exception.InnerException }; $expired=$exception.Message -ceq "action-expired" }; ' +
        '$afterAlive=$null -eq $handle.ExitTicks(); ' +
        '$row=@{expired=$expired;beforeAlive=$beforeAlive;afterAlive=$afterAlive}; ' +
        '[Console]::Out.WriteLine(($row|ConvertTo-Json -Compress)); [Console]::Out.Flush() ' +
        '} finally { if($null -ne $handle) { $handle.Dispose() } }';
      const result = await promisify(childProcess.execFile)(powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', helper], {
          windowsHide: true, timeout: 40_000, maxBuffer: 4096,
          env: {
            ...deploymentStartupEnvironment(process.env),
            PSModulePath: path.win32.join(powershellDirectory, 'Modules'),
            VKODEX_FIXTURE_PID: String(identity.pid),
            VKODEX_FIXTURE_BIRTH: identity.birthTicks,
            VKODEX_FIXTURE_IMAGE: identity.imagePath,
            VKODEX_FIXTURE_IMAGE_SHA256: identity.imageSha256,
          },
        });
      assert.equal(result.stderr.trim(), '', 'the private helper should not emit diagnostic or process data');
      assert.ok(result.stdout.length <= 4096);
      const row = JSON.parse(result.stdout.trim()) as { expired: boolean; beforeAlive: boolean; afterAlive: boolean };
      assert.deepEqual(row, { expired: true, beforeAlive: true, afterAlive: true });
    } finally {
      assert.equal(await exited, 0, 'the sole owned process must finish naturally; no signal or fallback termination is used');
    }
  });
