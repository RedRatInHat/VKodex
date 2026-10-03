import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { uniqueJson } from './deployment-artifact.js';
import { deploymentStartupEnvironment } from './deployment-execution.js';

export interface SelectedProcessIdentity {
  readonly pid: number;
  /** .NET UTC ticks, as in windows-process-identity.ts. Not raw FILETIME. */
  readonly birthTicks: string;
  readonly imagePath: string;
  readonly imageSha256: string;
}
export type SelectedProcessExitObservation = Readonly<{
  readonly kind: 'selected-original-processes-gone';
  readonly identitySha256: string;
  readonly exits: readonly Readonly<{ pid: number; birthTicks: string; exitTicks: string }>[];
}> | Readonly<{ readonly kind: 'blocked' | 'unavailable' }>;
const verified = new WeakSet<object>();
/** In-memory evidence from this invocation, never a deserialized receipt. */
export function isVerifiedSelectedProcessExit(value: unknown): boolean {
  return !!value && typeof value === 'object' && verified.has(value);
}

/** One monotonic preflight deadline, not a reset-on-each-read timeout.
 * A timed-out filesystem call cannot be cancelled, but its late completion
 * cannot start an observer or produce a capability. No polling/retry here.
 */
export class ProcessAcquisitionBudget {
  private readonly until: number;
  constructor(milliseconds: number) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 15_000)
      throw new TypeError('Invalid process acquisition budget');
    this.until = performance.now() + milliseconds;
  }
  remaining(): number { return Math.max(0, this.until - performance.now()); }
  assertCurrent(): void { if (this.remaining() <= 0) throw new Error('Process acquisition budget expired'); }
  async read<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { this.assertCurrent(); return operation(); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Process acquisition budget expired')),
          Math.ceil(this.remaining())); })]);
      this.assertCurrent();
      return value;
    } finally { if (timer) clearTimeout(timer); }
  }
}

// Trusted, fixed code in the protected application artifact. Process handles
// request QUERY_LIMITED_INFORMATION | SYNCHRONIZE only: no terminate rights,
// no signal, Scheduler change, native RPC or descendant enumeration.
const script = String.raw`
$ErrorActionPreference='Stop'
try {
  $scopeBytes=[Convert]::FromBase64String($env:VKODEX_EXIT_WITNESS_SCOPE)
  $scope=[Text.Encoding]::UTF8.GetString($scopeBytes) | ConvertFrom-Json
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $scopeHash=([BitConverter]::ToString($sha.ComputeHash($scopeBytes))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public sealed class VKodexExitHandle : IDisposable {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long born, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder image, ref uint count);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  IntPtr handle;
  public readonly int Pid;
  public readonly string BirthTicks;
  public VKodexExitHandle(int pid, string birth, string imagePath, string imageSha256) {
    Pid=pid; BirthTicks=birth;
    handle=OpenProcess(0x101000, false, pid);
    if(handle==IntPtr.Zero) throw new InvalidOperationException("identity-unproved");
    try {
      long b,e,k,u;
      if(!GetProcessTimes(handle,out b,out e,out k,out u) || e!=0 ||
         DateTime.FromFileTimeUtc(b).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)!=birth ||
         WaitForSingleObject(handle,0)!=258) throw new InvalidOperationException("identity-unproved");
      uint length=32768; var image=new StringBuilder((int)length);
      if(!QueryFullProcessImageName(handle,0,image,ref length) ||
         !String.Equals(Path.GetFullPath(image.ToString()),imagePath,StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("identity-unproved");
      using(var file=new FileStream(imagePath,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        if(file.Length>268435456) throw new InvalidOperationException("identity-unproved");
        using(var sha=SHA256.Create()) {
          if(BitConverter.ToString(sha.ComputeHash(file)).Replace("-","").ToLowerInvariant()!=imageSha256)
            throw new InvalidOperationException("identity-unproved");
        }
      }
      if(WaitForSingleObject(handle,0)!=258) throw new InvalidOperationException("identity-unproved");
    } catch { Dispose(); throw; }
  }
  public string ExitTicks() {
    uint state=WaitForSingleObject(handle,0);
    if(state==258) return null;
    if(state!=0) throw new InvalidOperationException("observation-unavailable");
    long b,e,k,u;
    if(!GetProcessTimes(handle,out b,out e,out k,out u) || e<=b ||
       DateTime.FromFileTimeUtc(b).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)!=BirthTicks)
      throw new InvalidOperationException("observation-unavailable");
    return DateTime.FromFileTimeUtc(e).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
}
'@
  $held=New-Object 'Collections.Generic.List[VKodexExitHandle]'
  try {
    foreach($p in $scope.processes) { $held.Add([VKodexExitHandle]::new($p.pid,$p.birthTicks,$p.imagePath,$p.imageSha256)) }
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $result=@{kind='blocked';challenge=$scope.challenge;identitySha256=$scopeHash}
    while($clock.ElapsedMilliseconds -le $scope.deadlineMs) {
      $exits=@(); $live=$false
      foreach($h in $held) {
        $exitTicks=$h.ExitTicks()
        if($null -eq $exitTicks) { $live=$true }
        else { $exits+=@{pid=$h.Pid;birthTicks=$h.BirthTicks;exitTicks=$exitTicks} }
      }
      if(-not $live -and $clock.ElapsedMilliseconds -le $scope.deadlineMs) { $result=@{kind='selected-original-processes-gone';challenge=$scope.challenge;identitySha256=$scopeHash;exits=$exits}; break }
      [Threading.Thread]::Sleep(25)
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
  } finally { foreach($h in $held) { $h.Dispose() } }
} catch { [Console]::Out.WriteLine('{"kind":"unavailable"}') }
`;

/** Observes a SELECTED original process set. Not a complete predecessor,
 * restart-exclusion, writer-release, native readiness or replay capability.
 * The calling application/artifact and Windows system interpreter are trusted.
 * Every original must be alive and independently matched at handle capture;
 * already absent or inaccessible is unproved, never an affirmative exit.
 * deadlineMs is the post-capture observation budget. Acquisition/compilation
 * has a shared extra 15-second allowance; filesystem reads and pipe completion
 * are bounded at the parent too. Late preflight never starts a helper.
 */
export async function observeSelectedWindowsProcessExits(processes: readonly SelectedProcessIdentity[], deadlineMs = 1_000):
  Promise<SelectedProcessExitObservation> {
  if (!Array.isArray(processes) || processes.length < 1 || processes.length > 16
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > 60_000)
    throw new TypeError('Invalid selected process observation');
  const pids = new Set<number>();
  const selected = processes.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
      || ['pid', 'birthTicks', 'imagePath', 'imageSha256'].some(key => !Object.hasOwn(value, key))
      || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 2_147_483_647 || pids.has(value.pid)
      || typeof value.birthTicks !== 'string' || !/^[1-9]\d{16,18}$/u.test(value.birthTicks)
      || typeof value.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.imageSha256)
      || typeof value.imagePath !== 'string' || value.imagePath.length > 1024 || /[\x00-\x1f\x7f"]/u.test(value.imagePath)
      || !/^[a-zA-Z]:\\/u.test(value.imagePath) || value.imagePath.split(/[\\/]/u).some((part: string) => part === '.' || part === '..')
      || value.imagePath.slice(path.win32.parse(value.imagePath).root.length).includes(':'))
      throw new TypeError('Invalid selected process identity');
    pids.add(value.pid);
    return Object.freeze({ pid: value.pid, birthTicks: value.birthTicks, imagePath: value.imagePath, imageSha256: value.imageSha256 });
  });
  if (process.platform !== 'win32' || !process.env.SystemRoot || !path.win32.isAbsolute(process.env.SystemRoot))
    return Object.freeze({ kind: 'unavailable' });
  const acquisition = new ProcessAcquisitionBudget(15_000);
  for (const value of selected) {
    try {
      const image = await acquisition.read(() => stat(value.imagePath));
      if (!image.isFile() || image.nlink !== 1 || image.size > 256 * 1024 * 1024
        || (await acquisition.read(() => realpath(value.imagePath))).toLowerCase() !== value.imagePath.toLowerCase())
        return Object.freeze({ kind: 'unavailable' });
    } catch { return Object.freeze({ kind: 'unavailable' }); }
  }
  const challenge = randomUUID();
  const scope = JSON.stringify({ challenge, deadlineMs, processes: selected });
  const identitySha256 = createHash('sha256').update(scope).digest('hex');
  const systemDirectory = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  try {
    acquisition.assertCurrent();
    const totalRemaining = Math.max(1, Math.ceil(acquisition.remaining()) + deadlineMs);
    const until = performance.now() + totalRemaining;
    const stdout = await new Promise<string>((resolve, reject) => {
      // execFile's timeout alone may still await an inherited output pipe.
      // Bound this invocation independently; a late callback cannot brand it.
      const timer = setTimeout(() => reject(new Error('Observation unavailable')), totalRemaining);
      try { execFile(path.win32.join(systemDirectory, 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: totalRemaining, maxBuffer: 16_384,
          env: { ...deploymentStartupEnvironment(process.env), PSModulePath: path.win32.join(systemDirectory, 'Modules'),
            VKODEX_EXIT_WITNESS_SCOPE: Buffer.from(scope).toString('base64') } },
        (error, out, err) => { clearTimeout(timer); error || err.trim() || performance.now() > until
          ? reject(new Error('Observation unavailable')) : resolve(out); }); }
      catch { clearTimeout(timer); reject(new Error('Observation unavailable')); }
    });
    if (performance.now() > until) throw new Error();
    const row = uniqueJson(stdout.trim()) as Record<string, unknown>;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
    if (Object.keys(row).length === 1 && row.kind === 'unavailable') return Object.freeze({ kind: 'unavailable' });
    if (row.challenge !== challenge || row.identitySha256 !== identitySha256) throw new Error();
    if (Object.keys(row).length === 3 && row.kind === 'blocked') return Object.freeze({ kind: 'blocked' });
    if (Object.keys(row).length !== 4 || row.kind !== 'selected-original-processes-gone'
      || !Array.isArray(row.exits) || row.exits.length !== selected.length) throw new Error();
    const exits = row.exits.map((item: unknown, index: number) => {
      const exit = item as Record<string, unknown>; const expected = selected[index]!;
      if (!exit || typeof exit !== 'object' || Array.isArray(exit) || Object.keys(exit).length !== 3
        || exit.pid !== expected.pid || exit.birthTicks !== expected.birthTicks
        || typeof exit.exitTicks !== 'string' || !/^[1-9]\d{16,18}$/u.test(exit.exitTicks)
        || BigInt(exit.exitTicks) <= BigInt(expected.birthTicks)) throw new Error();
      return Object.freeze({ pid: expected.pid, birthTicks: expected.birthTicks, exitTicks: exit.exitTicks });
    });
    const result = Object.freeze({ kind: 'selected-original-processes-gone' as const, identitySha256, exits: Object.freeze(exits) });
    if (performance.now() > until) throw new Error();
    verified.add(result);
    return result;
  } catch { return Object.freeze({ kind: 'unavailable' }); }
}
