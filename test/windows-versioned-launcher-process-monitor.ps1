[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('AuditFixture')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$FixtureRoot,
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][string]$StableRuntimePath,
  [Parameter(Mandatory=$true)][string]$PowerShellPath,
  [Parameter(Mandatory=$true)][string]$SupervisorPath,
  [Parameter(Mandatory=$true)][string]$WatchdogPath,
  [string]$WrapperPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Birth($Process) { return ([DateTime]$Process.CreationDate).ToUniversalTime().ToString('o') }
$self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -OperationTimeoutSec 3 -ErrorAction Stop
$heldSelf = Get-Process -Id $PID -ErrorAction Stop
try {
  $selfStart = $heldSelf.StartTime.ToUniversalTime()
  if (-not $self -or -not $self.ExecutablePath -or
      -not ([string]$self.ExecutablePath).Equals($heldSelf.Path,[StringComparison]::OrdinalIgnoreCase) -or
      [Math]::Abs(($selfStart - ([DateTime]$self.CreationDate).ToUniversalTime()).Ticks) -gt 10) {
    throw 'Audit helper self identity is incomplete.'
  }
} finally { $heldSelf.Dispose() }
$remaining = New-Object 'System.Collections.Generic.List[object]'
$uncertainties = New-Object 'System.Collections.Generic.List[object]'
$gone = New-Object 'System.Collections.Generic.List[object]'
$querySucceeded = $false
try {
  $processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3 -ErrorAction Stop)
  if ($processes.Count -eq 0) { throw 'Empty process inventory.' }
  $querySucceeded = $true
  $fixedPaths = @($LauncherPath,$StableRuntimePath,$SupervisorPath,$WatchdogPath)
  if ($WrapperPath) { $fixedPaths += $WrapperPath }
  $knownNames = @([IO.Path]::GetFileName($LauncherPath),[IO.Path]::GetFileName($StableRuntimePath),[IO.Path]::GetFileName($PowerShellPath))
  foreach ($candidate in $processes) {
    $candidatePid = [int]$candidate.ProcessId
    if ($candidatePid -eq $PID) {
      if ((Birth $candidate) -ne (Birth $self) -or
          -not ([string]$candidate.ExecutablePath).Equals([string]$self.ExecutablePath,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Audit self generation changed.'
      }
      continue
    }
    $exe = [string]$candidate.ExecutablePath
    $line = [string]$candidate.CommandLine
    $matched = ($exe -and $exe.IndexOf($FixtureRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0) -or
      ($line -and $line.IndexOf($FixtureRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0)
    foreach ($fixedPath in $fixedPaths) {
      if (($exe -and $exe.Equals($fixedPath,[StringComparison]::OrdinalIgnoreCase)) -or
          ($line -and $line.IndexOf($fixedPath,[StringComparison]::OrdinalIgnoreCase) -ge 0)) { $matched = $true }
    }
    $relevantMissing = ([string]$candidate.Name -iin $knownNames) -and
      ([string]::IsNullOrWhiteSpace($exe) -or [string]::IsNullOrWhiteSpace($line))
    if (-not $matched -and -not $relevantMissing) { continue }
    if (-not $candidate.CreationDate) {
      $uncertainties.Add(@{pid=$candidatePid;reason='relevant-birth-missing'})
      continue
    }
    $birth = Birth $candidate
    # One fresh exact-generation read establishes absence only, never authority
    # to stop anything. Unrelated protected system processes are not our fixture.
    $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$candidatePid" -OperationTimeoutSec 3 -ErrorAction Stop
    if ($fresh -and -not $fresh.CreationDate) {
      $uncertainties.Add(@{pid=$candidatePid;reason='fresh-relevant-birth-missing'})
      continue
    }
    if (-not $fresh -or (Birth $fresh) -ne $birth) {
      $gone.Add(@{pid=$candidatePid;birthUtc=$birth;state='original-generation-absent'})
      continue
    }
    if ($relevantMissing -or -not $fresh.ExecutablePath -or -not $fresh.CommandLine) {
      $uncertainties.Add(@{pid=$candidatePid;birthUtc=$birth;name=[string]$candidate.Name;reason='live-relevant-metadata-incomplete'})
    } else {
      $remaining.Add(@{pid=$candidatePid;birthUtc=$birth;name=[string]$candidate.Name;executable=[string]$fresh.ExecutablePath;reason='fixture-path-still-in-use'})
    }
  }
} catch {
  $querySucceeded = $false
  $uncertainties.Add(@{reason='audit-query-failed';error=$_.Exception.GetType().FullName})
}
[pscustomobject]@{querySucceeded=$querySucceeded;safe=($querySucceeded -and $remaining.Count -eq 0 -and $uncertainties.Count -eq 0);
  self=@{pid=$PID;birthUtc=(Birth $self);exactStartUtc=$selfStart.ToString('o');executable=[string]$self.ExecutablePath};
  remaining=@($remaining.ToArray());uncertainties=@($uncertainties.ToArray());gone=@($gone.ToArray())} | ConvertTo-Json -Depth 5 -Compress
