import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { boundedArtifactBytes, deploymentValidationIO, uniqueJson } from './deployment-artifact.js';
import { validateDeploymentBinding } from './deployment-binding.js';
import { deploymentStartupEnvironment } from './deployment-execution.js';
import { captureCommittedPredecessorSnapshot, type CommittedPredecessorSnapshot } from './predecessor-final-snapshot.js';
import { predecessorCutoverWindowsScript } from './predecessor-cutover-windows.js';
import { assertHistoricalPredecessorMaintenanceShape } from './predecessor-maintenance.js';
import { ProcessAcquisitionBudget } from './windows-process-exit-witness.js';

const APPROVAL = 'stop-selected-legacy-runtime-no-replay';
const HASH = /^[a-f0-9]{64}$/u;
const ROLES = ['supervisor', 'watchdog', 'wrapper', 'bridge', 'backend'] as const;
type Role = typeof ROLES[number];
interface ProcessScope {
  readonly pid: number; readonly parentPid: number; readonly birthTicks: string;
  readonly imagePath: string; readonly imageSha256: string; readonly role: Role;
}
interface ActionRequest {
  readonly version: 1; readonly operationId: string; readonly dataDirectory: string;
  readonly legacyRoot: string;
  readonly privateJournalDirectory: string; readonly expectedFileIdentity: Readonly<{ dev: string; ino: string }>;
  readonly legacySourceIds: readonly string[]; readonly snapshotSha256: string;
  readonly launchBindingPath: string; readonly launchBindingSha256: string; readonly configurationSha256: string;
  readonly deadlineMs: number;
  readonly task: Readonly<{ path: string; definitionSha256: string;
    instances: readonly Readonly<{ instanceGuid: string; enginePid: number }>[] }>;
  readonly processes: readonly ProcessScope[];
}
export interface PredecessorCutoverInvocation {
  readonly requestPath: string; readonly requestSha256: string; readonly operatorApproval: string;
}
export interface KnownPredecessorStop {
  readonly kind: 'known-predecessor-stopped'; readonly operationId: string; readonly actionScopeSha256: string;
  readonly exits: readonly Readonly<{ pid: number; birthTicks: string; exitTicks: string }>[];
  readonly finalSnapshot: CommittedPredecessorSnapshot;
}
const verifiedStops = new WeakSet<object>();
/** Invocation-local known-original evidence, NOT all-writer absence, native
 * readiness, permission to launch/replay, or a capability recovered from JSON. */
export function isVerifiedKnownPredecessorStop(value: unknown): value is KnownPredecessorStop {
  return !!value && typeof value === 'object' && verifiedStops.has(value);
}
function refuse(): never { throw new Error('Predecessor cutover refused; unknown operations must not be replayed.'); }
const { object, absolute, canonical, metadataFile, contained } = deploymentValidationIO;
const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function digest(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) refuse(); return value; }
function pid(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) refuse(); return Number(value);
}
function samePath(first: string, second: string): boolean { return first.toLowerCase() === second.toLowerCase(); }
function parseRequest(value: unknown): ActionRequest {
  const row = object(value, ['version', 'operationId', 'dataDirectory', 'legacyRoot', 'privateJournalDirectory', 'expectedFileIdentity',
    'legacySourceIds', 'snapshotSha256', 'launchBindingPath', 'launchBindingSha256', 'configurationSha256', 'deadlineMs', 'task', 'processes']);
  if (row.version !== 1 || typeof row.operationId !== 'string' || !/^[a-f0-9-]{36}$/u.test(row.operationId)
    || !Number.isSafeInteger(row.deadlineMs) || Number(row.deadlineMs) < 5_000 || Number(row.deadlineMs) > 120_000) refuse();
  const file = object(row.expectedFileIdentity, ['dev', 'ino']);
  if ([file.dev, file.ino].some(v => typeof v !== 'string' || !/^\d{1,64}$/u.test(v))) refuse();
  if (!Array.isArray(row.legacySourceIds) || row.legacySourceIds.length < 1 || row.legacySourceIds.length > 64
    || row.legacySourceIds.some(v => typeof v !== 'string' || v.length > 500 || /[\x00-\x1f\x7f]/u.test(v))
    || new Set(row.legacySourceIds).size !== row.legacySourceIds.length) refuse();
  const task = object(row.task, ['path', 'definitionSha256', 'instances']);
  if (typeof task.path !== 'string' || !/^\\(?:[^\\\x00-\x1f\x7f]+\\)*[^\\\x00-\x1f\x7f]+$/u.test(task.path)
    || task.path.length > 500 || task.path.split('\\').some(p => p === '.' || p === '..')
    || !Array.isArray(task.instances) || task.instances.length !== 1) refuse();
  const instances = task.instances.map(value => {
    const instance = object(value, ['instanceGuid', 'enginePid']);
    if (typeof instance.instanceGuid !== 'string' || !/^\{[a-fA-F0-9-]{36}\}$/u.test(instance.instanceGuid)) refuse();
    return Object.freeze({ instanceGuid: instance.instanceGuid, enginePid: pid(instance.enginePid) });
  });
  if (new Set(instances.map(v => v.instanceGuid.toLowerCase())).size !== instances.length) refuse();
  if (!Array.isArray(row.processes) || row.processes.length < 4 || row.processes.length > 16) refuse();
  const processes = row.processes.map(value => {
    const p = object(value, ['pid', 'parentPid', 'birthTicks', 'imagePath', 'imageSha256', 'role']);
    if (typeof p.birthTicks !== 'string' || !/^[1-9]\d{16,18}$/u.test(p.birthTicks)
      || typeof p.role !== 'string' || !ROLES.includes(p.role as Role)) refuse();
    return Object.freeze({ pid: pid(p.pid), parentPid: pid(p.parentPid), birthTicks: p.birthTicks,
      imagePath: absolute(p.imagePath), imageSha256: digest(p.imageSha256), role: p.role as Role });
  });
  if (new Set(processes.map(v => v.pid)).size !== processes.length || ['supervisor', 'wrapper', 'bridge'].some(role =>
    processes.filter(v => v.role === role).length !== 1) || processes.filter(v => v.role === 'watchdog').length > 1
    || !processes.some(v => v.role === 'backend')) refuse();
  const rolePid = (role: Role) => processes.find(v => v.role === role)!.pid;
  if (instances[0]!.enginePid !== rolePid('wrapper')) refuse();
  if (processes.some(p => p.role === 'supervisor' ? p.parentPid !== rolePid('wrapper')
    : p.role === 'bridge' || p.role === 'watchdog' ? p.parentPid !== rolePid('supervisor')
      : p.role === 'backend' ? p.parentPid !== rolePid('bridge') : processes.some(v => v.pid === p.parentPid))) refuse();
  return Object.freeze({ version: 1, operationId: row.operationId, dataDirectory: absolute(row.dataDirectory),
    legacyRoot: absolute(row.legacyRoot),
    privateJournalDirectory: absolute(row.privateJournalDirectory), expectedFileIdentity: Object.freeze({ dev: file.dev as string, ino: file.ino as string }),
    legacySourceIds: Object.freeze([...row.legacySourceIds as string[]].sort()), snapshotSha256: digest(row.snapshotSha256),
    launchBindingPath: absolute(row.launchBindingPath), launchBindingSha256: digest(row.launchBindingSha256),
    configurationSha256: digest(row.configurationSha256), deadlineMs: Number(row.deadlineMs),
    task: Object.freeze({ path: task.path, definitionSha256: digest(task.definitionSha256), instances: Object.freeze(instances) }),
    processes: Object.freeze(processes) });
}

/** Exact opt-in arguments. The flag records an operator decision; it does not
 * manufacture human authorization. No environment variable or health loop can
 * turn a planning/inspection invocation into an action invocation. */
export function predecessorCutoverArguments(args: readonly string[]): PredecessorCutoverInvocation {
  if (args.length !== 6 || args[0] !== '--request' || args[2] !== '--sha256' || args[4] !== '--operator-approved-stop'
    || args[5] !== APPROVAL) refuse();
  return Object.freeze({ requestPath: absolute(args[1]), requestSha256: digest(args[3]), operatorApproval: APPROVAL });
}

/** Explicit trusted operator command only. It stops just the pinned known
 * runtime, leaves its task disabled, and captures committed SQLite data while
 * the helper is still holding exact handles and awaiting a final scope check.
 * It DOES NOT finalize new quarantine pins, launch a successor, restore data,
 * settle old ACKs, retry input, stop Desktop/VS Code, or run from boot/health.
 * Run from an independent trusted parent; a controller inside a selected
 * target's process tree is refused before any Task setter or signal.
 */
export async function stopPinnedPredecessor(provided: PredecessorCutoverInvocation, inspectOnly = false): Promise<
  KnownPredecessorStop | Readonly<{ kind: 'inspected'; actionScopeSha256: string }> | Readonly<{ kind: 'unknown'; operationId: string }>> {
  const fields = object(provided, ['requestPath', 'requestSha256', 'operatorApproval']);
  const invocation = Object.freeze({ requestPath: absolute(fields.requestPath), requestSha256: digest(fields.requestSha256),
    operatorApproval: fields.operatorApproval });
  if (invocation.operatorApproval !== APPROVAL
    || process.platform !== 'win32' || !process.env.SystemRoot) refuse();
  const acquisition = new ProcessAcquisitionBudget(15_000);
  const requestPath = absolute(invocation.requestPath);
  const request = parseRequest(await acquisition.read(() => metadataFile(requestPath, 32 * 1024, invocation.requestSha256)));
  const database = path.join(request.dataDirectory, 'vkodex.sqlite');
  const checkDatabase = async () => {
    await canonical(database, 'file'); const value = await stat(database, { bigint: true });
    if (!value.isFile() || value.nlink !== 1n || String(value.dev) !== request.expectedFileIdentity.dev
      || String(value.ino) !== request.expectedFileIdentity.ino) refuse();
  };
  const checkPins = async () => {
    await metadataFile(requestPath, 32 * 1024, invocation.requestSha256);
    await checkDatabase();
    await canonical(request.legacyRoot, 'directory');
    const plan = await validateDeploymentBinding(request.launchBindingPath, request.launchBindingSha256);
    if (!samePath(plan.dataDirectory, request.dataDirectory) || !samePath(plan.cwd, request.legacyRoot)
      || !samePath(plan.environmentFile, path.join(request.legacyRoot, '.env'))) refuse();
    const hash = createHash('sha256');
    for await (const chunk of boundedArtifactBytes(createReadStream(plan.environmentFile), 256 * 1024)) hash.update(chunk);
    if (hash.digest('hex') !== request.configurationSha256) refuse();
    const snapshot = object(await metadataFile(path.join(request.dataDirectory, 'predecessor-maintenance.json'),
      1024 * 1024, request.snapshotSha256), ['version', 'fenceId', 'createdAt', 'dataDirectory', 'legacySourceIds', 'bindings', 'processes', 'recoveryPolicy']);
    assertHistoricalPredecessorMaintenanceShape(snapshot, request.dataDirectory, request.legacySourceIds, request.snapshotSha256);
    if (snapshot.version !== 1 || snapshot.recoveryPolicy !== 'reconcile-only' || !samePath(absolute(snapshot.dataDirectory), request.dataDirectory)
      || !Array.isArray(snapshot.legacySourceIds) || !isDeepStrictEqual([...snapshot.legacySourceIds].sort(), request.legacySourceIds)
      || !Array.isArray(snapshot.processes) || snapshot.processes.length !== request.processes.length
      || new Set(snapshot.processes.map(p => p && typeof p === 'object' ? (p as Record<string, unknown>).pid : null)).size !== request.processes.length
      || snapshot.processes.some(value => {
        if (!value || typeof value !== 'object') return true; const p = value as Record<string, unknown>;
        return !request.processes.some(v => v.pid === p.pid && v.birthTicks === p.birthTicks
          && (p.role === 'bridge' ? v.role === 'bridge' : p.role === 'legacy-backend' ? v.role === 'backend'
            : ['supervisor', 'wrapper', 'watchdog'].includes(v.role))
          && typeof p.imagePath === 'string' && samePath(v.imagePath, p.imagePath));
      })) refuse();
    for (const p of request.processes) {
      await canonical(p.imagePath, 'file'); const image = await stat(p.imagePath);
      if (!image.isFile() || image.nlink !== 1 || image.size > 256 * 1024 * 1024) refuse();
    }
    for (const other of [request.dataDirectory, plan.cwd, path.dirname(plan.entryPoint), plan.launcherPath])
      if (contained(request.privateJournalDirectory, other) || contained(other, request.privateJournalDirectory)) refuse();
  };
  await acquisition.read(checkPins);
  await acquisition.read(() => canonical(request.privateJournalDirectory, 'directory'));
  const scope = Object.freeze({ challenge: randomUUID(), mode: inspectOnly ? 'inspect' : 'stop', controllerPid: process.pid,
    deadlineMs: request.deadlineMs, legacyRoot: request.legacyRoot, task: request.task, processes: request.processes, requestSha256: invocation.requestSha256 });
  const scopeText = JSON.stringify(scope); const actionScopeSha256 = hashOf(scope);
  const journalDirectory = path.join(request.privateJournalDirectory, request.operationId);
  const durable = async (file: string, value: unknown) => {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  };
  if (!inspectOnly) {
    // Fixed data-directory lease excludes a concurrent controller with a different
    // private journal root. It survives unknown/crashed commands: no auto clear.
    await durable(path.join(request.dataDirectory, 'predecessor-cutover-control.lock.json'), {
      version: 1, operationId: request.operationId, requestSha256: invocation.requestSha256, actionScopeSha256 });
    await mkdir(journalDirectory, { mode: 0o700 });
    await durable(path.join(journalDirectory, 'action-scope.json'), { version: 1, request, actionScopeSha256, scope });
  }
  const until = performance.now() + request.deadlineMs + 15_000;
  const steps = ['disable-task', ...ROLES.flatMap(role => request.processes.filter(p => p.role === role).map(p => `stop-${p.pid}`))];
  const exits: { pid: number; birthTicks: string; exitTicks: string }[] = [];
  let finalSnapshot: CommittedPredecessorSnapshot | undefined;
  let child: ReturnType<typeof spawn> | undefined; let exited = false; let ready = false; let nextSequence = 0;
  let stopped = false; let terminal = false; let failed = false; let stdoutBytes = 0; let pending = Buffer.alloc(0);
  let chain: Promise<void> = Promise.resolve(); let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise(resolve => {
    let settled = false;
    const finishUnknown = () => {
      if (settled) return; settled = true; failed = true; if (timer) clearTimeout(timer);
      // Only our direct helper is cancelled. No original/PID/tree termination here.
      try { child?.stdin?.end(); } catch { /* closed helper */ }
      try { if (child && child.exitCode === null && !child.killed) child.kill(); } catch { /* own helper only */ }
      resolve(Object.freeze({ kind: 'unknown', operationId: request.operationId }));
    };
    const assertCurrent = () => { if (failed || settled || exited || !child || child.exitCode !== null
      || performance.now() >= until) refuse(); };
    const grant = async (sequence: number, action: string) => {
      assertCurrent();
      const pins = new ProcessAcquisitionBudget(15_000);
      await pins.read(checkPins);
      assertCurrent();
      // Reserve a durable step BEFORE writing its exact bounded grant to stdin.
      await durable(path.join(journalDirectory, `${String(sequence).padStart(3, '0')}-grant.json`), {
        version: 1, operationId: request.operationId, actionScopeSha256, sequence, action, outcome: 'unknown-until-ack' });
      assertCurrent();
      child!.stdin!.write(`${scope.challenge}:${sequence}:${action}\n`);
    };
    const frame = async (bytes: Buffer) => {
      if (failed || bytes.length > 4096 || bytes.length === 0) refuse();
      const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) refuse();
      const row = object(uniqueJson(text));
      if (row.kind === 'unavailable') { finishUnknown(); return; }
      if (row.challenge !== scope.challenge || row.scopeSha256 !== actionScopeSha256 || terminal) refuse();
      if (!ready) {
        if (exited || child?.exitCode !== null || row.kind !== 'ready' || Object.keys(row).length !== 4 || row.processCount !== request.processes.length) refuse();
        ready = true;
        if (inspectOnly) { terminal = true; child!.stdin!.end(); return; }
        await grant(0, steps[0]!); return;
      }
      if (row.kind === 'step' && !stopped) {
        const expected = steps[nextSequence];
        if (row.sequence !== nextSequence || row.action !== expected) refuse();
        if (nextSequence === 0) { if (Object.keys(row).length !== 5) refuse(); }
        else {
          const original = request.processes.find(p => `stop-${p.pid}` === expected)!;
          if (Object.keys(row).length !== 8 || row.pid !== original.pid || row.birthTicks !== original.birthTicks
            || typeof row.exitTicks !== 'string' || !/^[1-9]\d{16,18}$/u.test(row.exitTicks)
            || BigInt(row.exitTicks) <= BigInt(original.birthTicks)) refuse();
          exits.push({ pid: original.pid, birthTicks: original.birthTicks, exitTicks: row.exitTicks });
        }
        await durable(path.join(journalDirectory, `${String(nextSequence).padStart(3, '0')}-ack.json`), row);
        nextSequence++;
        if (nextSequence < steps.length) await grant(nextSequence, steps[nextSequence]!);
        return;
      }
      if (row.kind === 'stopped' && !stopped && nextSequence === steps.length && row.sequence === nextSequence && Object.keys(row).length === 4) {
        stopped = true; assertCurrent();
        await durable(path.join(journalDirectory, 'known-original-exits.json'), { operationId: request.operationId, actionScopeSha256, exits });
        const pins = new ProcessAcquisitionBudget(15_000); await pins.read(checkPins); assertCurrent();
        finalSnapshot = await captureCommittedPredecessorSnapshot({ sourceDatabasePath: database,
          privateBackupRoot: path.join(journalDirectory, 'backup'), expectedFileIdentity: request.expectedFileIdentity,
          legacySourceIds: request.legacySourceIds, operationId: request.operationId, actionScopeSha256,
          deadlineMs: Math.min(30_000, Math.max(1, Math.floor(until - performance.now()))) });
        assertCurrent();
        await durable(path.join(journalDirectory, 'committed-snapshot.json'), finalSnapshot);
        assertCurrent(); await grant(nextSequence, 'final-check'); return;
      }
      if (row.kind === 'verified' && stopped && row.sequence === steps.length && Object.keys(row).length === 4) {
        if (!finalSnapshot) refuse(); terminal = true; child!.stdin!.end(); return;
      }
      refuse();
    };
    const systemDirectory = path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0');
    try {
      child = spawn(path.win32.join(systemDirectory, 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', predecessorCutoverWindowsScript], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...deploymentStartupEnvironment(process.env),
          PSModulePath: path.win32.join(systemDirectory, 'Modules'), VKODEX_CUTOVER_SCOPE: Buffer.from(scopeText).toString('base64') } });
      timer = setTimeout(finishUnknown, Math.max(1, Math.ceil(until - performance.now())));
      child.stdout!.on('data', (bytes: Buffer) => {
        stdoutBytes += bytes.length; if (stdoutBytes > 32 * 1024 || performance.now() > until) { finishUnknown(); return; }
        pending = Buffer.concat([pending, bytes]); let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
          const line = Buffer.from(pending.subarray(0, end)); pending = pending.subarray(end + 1);
          chain = chain.then(() => frame(line)).catch(finishUnknown);
        }
      });
      child.stderr!.on('data', finishUnknown);
      for (const stream of [child.stdin!, child.stdout!, child.stderr!]) stream.on('error', finishUnknown);
      child.on('error', finishUnknown);
      child.on('exit', () => { exited = true; });
      child.on('close', (code, signal) => { void chain.then(() => {
        if (settled) return;
        if (failed || code !== 0 || signal !== null || !terminal || pending.length || performance.now() > until) { finishUnknown(); return; }
        if (timer) clearTimeout(timer); settled = true;
        if (inspectOnly) { resolve(Object.freeze({ kind: 'inspected', actionScopeSha256 })); return; }
        if (!finalSnapshot || exits.length !== request.processes.length) { settled = false; finishUnknown(); return; }
        const result: KnownPredecessorStop = Object.freeze({ kind: 'known-predecessor-stopped', operationId: request.operationId,
          actionScopeSha256, exits: Object.freeze(exits.map(v => Object.freeze(v))), finalSnapshot });
        verifiedStops.add(result); resolve(result);
      }).catch(finishUnknown); });
    } catch { finishUnknown(); }
  });
}
