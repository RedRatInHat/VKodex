[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$SupervisorPid,
  [Parameter(Mandatory = $true)][string]$HealthFile,
  [Parameter(Mandatory = $true)][string]$EntryPoint,
  [Parameter(Mandatory = $true)][string]$LogFile,
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

$entryPattern = [regex]::Escape($EntryPoint)
$supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid"
if (-not $supervisor) { exit 0 }
$supervisorCreatedAt = $supervisor.CreationDate
while ($true) {
  Start-Sleep -Seconds $PollSeconds
  try {
    $supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid"
    if (-not $supervisor -or $supervisor.CreationDate -ne $supervisorCreatedAt) { break }
    $now = Get-Date
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$SupervisorPid" |
      Where-Object { $_.Name -eq "VKodex.exe" -and $_.CommandLine -match $entryPattern }
    foreach ($child in $children) {
      $age = ($now - $child.CreationDate).TotalSeconds
      if ($age -le $StaleSeconds -or (Is-FreshHealth $child $now)) { continue }
      $hasOwnReport = $false
      try {
        $report = Get-Content -LiteralPath $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $hasOwnReport = [int]$report.pid -eq [int]$child.ProcessId
      } catch { }
      if (-not $hasOwnReport -and $age -le $StartupSeconds) { continue }
      # Recheck identity immediately before stopping to avoid a reused PID.
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"
      if (-not $current -or $current.ParentProcessId -ne $SupervisorPid -or
          $current.CreationDate -ne $child.CreationDate -or $current.Name -ne "VKodex.exe" -or
          $current.CommandLine -notmatch $entryPattern) { continue }
      Write-WatchdogLog "VKodex PID $($child.ProcessId) stopped updating health; stopping it for supervised recovery."
      Stop-Process -Id $child.ProcessId -Force
    }
  } catch {
    Write-WatchdogLog "VKodex watchdog could not complete one poll; it will retry."
  }
}
