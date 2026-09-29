import { execFile, spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ProcessIdentity } from '../codex/managed-worker-registry.js';

/** Read-only birth identity. Absence differs from an inaccessible/failed query.
 * A later termination must still bind its action to the same OS process handle. */
function processIdentityQuery(pid: number): { executable: string; script: string; modulePath: string } {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647)
    throw new TypeError('Invalid process ID');
  if (process.platform !== 'win32' || !process.env.SystemRoot || !path.win32.isAbsolute(process.env.SystemRoot))
    throw new Error('Windows process identity unavailable');
  const directory = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const script = `$ErrorActionPreference='Stop'; try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { 'ABSENT' } else { exit 2 } }`;
  return { executable: path.win32.join(directory, 'powershell.exe'), script,
    modulePath: path.win32.join(directory, 'Modules') };
}

function parsedIdentity(pid: number, stdout: string | undefined, stderr: string | undefined): ProcessIdentity | null {
  const value = stdout?.trim();
  if (stderr?.trim() || (value !== 'ABSENT' && !/^[1-9]\d{0,23}$/u.test(value ?? '')))
    throw new Error('Windows process identity unavailable');
  return value === 'ABSENT' ? null : Object.freeze({ pid, birthTicks: value! });
}

export function readWindowsProcessIdentity(pid: number): ProcessIdentity | null {
  const query = processIdentityQuery(pid);
  const result = spawnSync(query.executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query.script], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      env: { ...process.env, PSModulePath: query.modulePath },
    });
  if (result.error || result.status !== 0)
    throw new Error('Windows process identity unavailable');
  return parsedIdentity(pid, result.stdout, result.stderr);
}

/** The background reconciler must not block bridge ticks while PowerShell
 * checks a process birth identity. It uses the same read-only query and bound. */
export async function readWindowsProcessIdentityAsync(pid: number): Promise<ProcessIdentity | null> {
  const query = processIdentityQuery(pid);
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(query.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query.script], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      env: { ...process.env, PSModulePath: query.modulePath },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error('Windows process identity unavailable'));
      else resolve({ stdout, stderr });
    });
  });
  return parsedIdentity(pid, result.stdout, result.stderr);
}
