# Windows-only integration check: a stalled child is stopped, while the real
# supervisor and its production bridge are not involved.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimePath = Join-Path $env:LOCALAPPDATA "VKodex\runtime\VKodex.exe"
$watchdogPath = Join-Path $projectRoot "scripts\watch-windows-bridge.ps1"
$marker = "vkodex-watchdog-test-$([Guid]::NewGuid().ToString('N'))"
$fake = $null
$watchdog = $null
try {
  $fake = Start-Process -FilePath $runtimePath -ArgumentList ('-e "setInterval(() => {{}}, 1000)" -- {0}' -f $marker) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  if (-not (Get-CimInstance Win32_Process -Filter "ProcessId=$($fake.Id)")) { throw "The fixture did not remain running." }
  $missingHealth = Join-Path $env:TEMP "$marker-health.json"
  $missingLog = Join-Path $env:TEMP "$marker-missing\watchdog.log"
  $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -SupervisorPid {1} -HealthFile "{2}" -EntryPoint "{3}" -LogFile "{4}" -PollSeconds 1 -StartupSeconds 30 -StaleSeconds 30' -f
    $watchdogPath, $PID, $missingHealth, $marker, $missingLog
  $watchdog = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $args -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($fake.Id)")) {
    Start-Sleep -Seconds 1
  }
  if (Get-CimInstance Win32_Process -Filter "ProcessId=$($fake.Id)") { throw "The watchdog did not stop the stale fixture." }
  Write-Output "Watchdog stopped the stale fixture."
} finally {
  if ($watchdog -and (Get-Process -Id $watchdog.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $watchdog.Id -Force }
  if ($fake -and (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $fake.Id -Force }
}
