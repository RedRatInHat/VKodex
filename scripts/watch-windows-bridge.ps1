[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$SupervisorPid,
  [Parameter(Mandatory = $true)][string]$HealthFile,
  [Parameter(Mandatory = $true)][string]$EntryPoint,
  [Parameter(Mandatory = $true)][string]$LogFile,
  [string]$VersionedLauncherPath,
  [string]$BridgeExecutable,
  [int]$PollSeconds = 20,
  [int]$StartupSeconds = 300,
  [int]$StaleSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($SupervisorPid -le 0 -or $PollSeconds -lt 1 -or $StartupSeconds -lt 30 -or $StaleSeconds -lt 30) {
  throw "Invalid VKodex watchdog settings."
}

function Write-WatchdogLog([string]$Message) {
  $line = "[$((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK'))] $Message"
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Is-FreshHealth($Child, [datetime]$Now) {
  try {
    $report = Get-Content -LiteralPath $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$report.pid -ne [int]$Child.ProcessId) { return $false }
    $checkedAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$report.checkedAt).LocalDateTime
    if ($checkedAt -lt $Child.CreationDate.AddSeconds(-5)) { return $false }
    $age = ($Now - $checkedAt).TotalSeconds
    return $age -ge -5 -and $age -le $StaleSeconds
  } catch { return $false }
}

$versionedMode = -not [string]::IsNullOrWhiteSpace($VersionedLauncherPath) -or -not [string]::IsNullOrWhiteSpace($BridgeExecutable)
if ($versionedMode) {
  # This parent-chain check is diagnostic only. Fresh health or a matching PID
  # does not prove ownership release, turn completion, or permission to stop work.
  if ([string]::IsNullOrWhiteSpace($VersionedLauncherPath) -or [string]::IsNullOrWhiteSpace($BridgeExecutable)) {
    throw "Invalid VKodex watchdog settings."
  }
  foreach ($candidatePath in @($VersionedLauncherPath, $BridgeExecutable, $EntryPoint)) {
    if (-not [IO.Path]::IsPathRooted($candidatePath) -or $candidatePath.Contains('"') -or
        $candidatePath.Contains([char]0) -or $candidatePath.Contains("`r") -or $candidatePath.Contains("`n")) {
      throw "Invalid VKodex watchdog settings."
    }
  }
  try {
    $launcherIdentity = [IO.Path]::GetFullPath($VersionedLauncherPath)
    $bridgeIdentity = [IO.Path]::GetFullPath($BridgeExecutable)
    $fixedEntryPoint = [IO.Path]::GetFullPath($EntryPoint)
  } catch { throw "Invalid VKodex watchdog settings." }
  $versionedEntryPattern = [regex]::Escape($fixedEntryPoint)
  $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid"
  if (-not $supervisor) { exit 0 }
  $supervisorCreatedAt = $supervisor.CreationDate
  $reportedStale = @{}
  while ($true) {
    Start-Sleep -Seconds $PollSeconds
    try {
      $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid"
      if (-not $supervisor -or $supervisor.CreationDate -ne $supervisorCreatedAt) { break }
      $now = Get-Date
      $helpers = Get-CimInstance Win32_Process -Filter "ParentProcessId=$SupervisorPid" |
        Where-Object { $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath([string]$_.ExecutablePath), $launcherIdentity, [StringComparison]::OrdinalIgnoreCase) }
      $currentKeys = @{}
      foreach ($helper in $helpers) {
        $helperBirth = $helper.CreationDate
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($helper.ProcessId)" |
          Where-Object { $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath([string]$_.ExecutablePath), $bridgeIdentity, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -match $versionedEntryPattern }
        foreach ($child in $children) {
          $key = "$($helper.ProcessId):$($helperBirth.ToFileTimeUtc()):$($child.ProcessId):$($child.CreationDate.ToFileTimeUtc())"
          $currentKeys[$key] = $true
          $age = ($now - $child.CreationDate).TotalSeconds
          if (Is-FreshHealth $child $now) {
            if ($reportedStale.ContainsKey($key)) {
              Write-WatchdogLog "VKodex PID $($child.ProcessId) resumed updating health."
              $reportedStale.Remove($key)
            }
            continue
          }
          if ($age -le $StaleSeconds) { continue }
          $hasOwnReport = $false
          try {
            $report = Get-Content -LiteralPath $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $hasOwnReport = [int]$report.pid -eq [int]$child.ProcessId
          } catch { }
          if (-not $hasOwnReport -and $age -le $StartupSeconds) { continue }
          if ($reportedStale.ContainsKey($key)) { continue }
          # Recheck both generations and the exact helper -> stable-runtime parent chain.
          $currentHelper = Get-CimInstance Win32_Process -Filter "ProcessId=$($helper.ProcessId)"
          $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
          if (-not $currentHelper -or $currentHelper.ParentProcessId -ne $SupervisorPid -or
              $currentHelper.CreationDate -ne $helperBirth -or -not $currentHelper.ExecutablePath -or
              -not [string]::Equals([IO.Path]::GetFullPath([string]$currentHelper.ExecutablePath), $launcherIdentity, [StringComparison]::OrdinalIgnoreCase) -or
              -not $current -or $current.ParentProcessId -ne $helper.ProcessId -or
              $current.CreationDate -ne $child.CreationDate -or -not $current.ExecutablePath -or
              -not [string]::Equals([IO.Path]::GetFullPath([string]$current.ExecutablePath), $bridgeIdentity, [StringComparison]::OrdinalIgnoreCase) -or
              $current.CommandLine -notmatch $versionedEntryPattern) { continue }
          Write-WatchdogLog "VKodex PID $($child.ProcessId) stopped updating health; leaving it running to preserve active work. Investigate the stale health report."
          $reportedStale[$key] = $true
        }
      }
      foreach ($key in @($reportedStale.Keys)) {
        if (-not $currentKeys.ContainsKey($key)) { $reportedStale.Remove($key) }
      }
    } catch {
      Write-WatchdogLog "VKodex watchdog could not complete one poll; it will retry."
    }
  }
  exit 0
}

$entryPattern = [regex]::Escape($EntryPoint)
$supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid"
if (-not $supervisor) { exit 0 }
$supervisorCreatedAt = $supervisor.CreationDate
$reportedStale = @{}
while ($true) {
  Start-Sleep -Seconds $PollSeconds
  try {
    $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid"
    if (-not $supervisor -or $supervisor.CreationDate -ne $supervisorCreatedAt) { break }
    $now = Get-Date
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$SupervisorPid" |
      Where-Object { $_.Name -eq "VKodex.exe" -and $_.CommandLine -match $entryPattern }
    $currentKeys = @{}
    foreach ($child in $children) {
      $key = "$($child.ProcessId):$($child.CreationDate.ToFileTimeUtc())"
      $currentKeys[$key] = $true
      $age = ($now - $child.CreationDate).TotalSeconds
      if (Is-FreshHealth $child $now) {
        if ($reportedStale.ContainsKey($key)) {
          Write-WatchdogLog "VKodex PID $($child.ProcessId) resumed updating health."
          $reportedStale.Remove($key)
        }
        continue
      }
      if ($age -le $StaleSeconds) { continue }
      $hasOwnReport = $false
      try {
        $report = Get-Content -LiteralPath $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $hasOwnReport = [int]$report.pid -eq [int]$child.ProcessId
      } catch { }
      if (-not $hasOwnReport -and $age -le $StartupSeconds) { continue }
      if ($reportedStale.ContainsKey($key)) { continue }
      # Recheck identity before reporting to avoid a reused PID.
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
      if (-not $current -or $current.ParentProcessId -ne $SupervisorPid -or
          $current.CreationDate -ne $child.CreationDate -or $current.Name -ne "VKodex.exe" -or
          $current.CommandLine -notmatch $entryPattern) { continue }
      # A stale report does not prove that Codex turns have stopped. Killing
      # the bridge also closes App Server pipes and interrupts active turns.
      # The supervisor still restarts the bridge when it exits on its own.
      Write-WatchdogLog "VKodex PID $($child.ProcessId) stopped updating health; leaving it running to preserve active Codex turns. Investigate the stale health report."
      $reportedStale[$key] = $true
    }
    foreach ($key in @($reportedStale.Keys)) {
      if (-not $currentKeys.ContainsKey($key)) { $reportedStale.Remove($key) }
    }
  } catch {
    Write-WatchdogLog "VKodex watchdog could not complete one poll; it will retry."
  }
}
