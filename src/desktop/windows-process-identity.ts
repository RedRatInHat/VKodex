import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ProcessIdentity } from '../codex/managed-worker-registry.js';

/** Read-only birth identity. Absence differs from an inaccessible/failed query.
 * A later termination must still bind its action to the same OS process handle. */
export function readWindowsProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647)
    throw new TypeError('Invalid process ID');
  if (process.platform !== 'win32' || !process.env.SystemRoot || !path.win32.isAbsolute(process.env.SystemRoot))
    throw new Error('Windows process identity unavailable');
  const directory = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const script = `$ErrorActionPreference='Stop'; try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { 'ABSENT' } else { exit 2 } }`;
  const result = spawnSync(path.win32.join(directory, 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      env: { ...process.env, PSModulePath: path.win32.join(directory, 'Modules') },
    });
  const value = result.stdout?.trim();
  if (result.error || result.status !== 0 || result.stderr?.trim() ||
      (value !== 'ABSENT' && !/^[1-9]\d{0,23}$/u.test(value ?? '')))
    throw new Error('Windows process identity unavailable');
  return value === 'ABSENT' ? null : Object.freeze({ pid, birthTicks: value! });
}
