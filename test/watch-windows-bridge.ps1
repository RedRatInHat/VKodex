# Windows-only integration check: stale health is reported without stopping
# the fixture. The real supervisor and its production bridge are not involved.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimePath = Join-Path $env:LOCALAPPDATA "VKodex\runtime\VKodex.exe"
$watchdogPath = Join-Path $projectRoot "scripts\watch-windows-bridge.ps1"
$marker = "vkodex-watchdog-test-$([Guid]::NewGuid().ToString('N'))"
$fake = $null
$watchdog = $null
$healthFile = Join-Path $env:TEMP "$marker-health.json"
$watchdogLog = Join-Path $env:TEMP "$marker-watchdog.log"
try {
  $fake = Start-Process -FilePath $runtimePath -ArgumentList ('-e "setInterval(() => {{}}, 1000)" -- {0}' -f $marker) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  if (-not (Get-CimInstance Win32_Process -Filter "ProcessId=$($fake.Id)")) { throw "The fixture did not remain running." }
  $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -SupervisorPid {1} -HealthFile "{2}" -EntryPoint "{3}" -LogFile "{4}" -PollSeconds 1 -StartupSeconds 30 -StaleSeconds 30' -f
    $watchdogPath, $PID, $healthFile, $marker, $watchdogLog
  $watchdog = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $args -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $watchdogLog -PathType Leaf)) {
    Start-Sleep -Seconds 1
  }
  if (-not (Test-Path -LiteralPath $watchdogLog -PathType Leaf)) { throw "The watchdog did not report stale health." }
  if (-not (Get-CimInstance Win32_Process -Filter "ProcessId=$($fake.Id)")) { throw "The watchdog stopped the stale fixture." }
  $stale = @(Select-String -LiteralPath $watchdogLog -Pattern 'leaving it running to preserve active Codex turns' -SimpleMatch)
  if ($stale.Count -ne 1) { throw "Expected one non-destructive stale-health warning." }

  @{ pid = $fake.Id; checkedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
    ConvertTo-Json | Set-Content -LiteralPath $healthFile -Encoding UTF8
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and -not (Select-String -LiteralPath $watchdogLog -Pattern 'resumed updating health' -Quiet)) {
    Start-Sleep -Seconds 1
  }
  if (-not (Select-String -LiteralPath $watchdogLog -Pattern 'resumed updating health' -Quiet)) { throw "The watchdog did not report health recovery." }
  if (-not (Get-CimInstance Win32_Process -Filter "ProcessId=$($fake.Id)")) { throw "The fixture stopped during health recovery." }
  Write-Output "Watchdog reported stale and recovered health without stopping the fixture."
} finally {
  if ($watchdog -and (Get-Process -Id $watchdog.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $watchdog.Id -Force }
  if ($fake -and (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $fake.Id -Force }
  Add-Type -AssemblyName Microsoft.VisualBasic
  foreach ($file in @($healthFile, $watchdogLog)) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($file,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    }
  }
}
