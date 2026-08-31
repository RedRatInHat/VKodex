[CmdletBinding()]
param([int]$RestartDelaySeconds = 5)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($RestartDelaySeconds -lt 1 -or $RestartDelaySeconds -gt 300) {
  throw "RestartDelaySeconds must be between 1 and 300."
}

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimePath = Join-Path $env:LOCALAPPDATA "VKodex\runtime\VKodex.exe"
$environmentFile = Join-Path $projectRoot ".env"
$entryPoint = Join-Path $projectRoot "dist\src\desktop-main.js"
$logDirectory = Join-Path $projectRoot "data\desktop\logs"
$supervisorLog = Join-Path $logDirectory "supervisor.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-SupervisorLog([string]$Message) {
  $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
  Add-Content -LiteralPath $supervisorLog -Value "[$timestamp] $Message" -Encoding UTF8
}

try {
  foreach ($required in @($runtimePath, $environmentFile, $entryPoint)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Required VKodex file is missing: $required"
    }
  }

  Write-SupervisorLog "Supervisor started (PID $PID)."
  while ($true) {
    $runId = "{0}-{1}" -f (Get-Date).ToString("yyyyMMdd-HHmmssfff"), ([Guid]::NewGuid().ToString("N").Substring(0, 8))
    $stdoutLog = Join-Path $logDirectory "vkodex-$runId.stdout.log"
    $stderrLog = Join-Path $logDirectory "vkodex-$runId.stderr.log"
    $arguments = @("--env-file=`"$environmentFile`"", "`"$entryPoint`"")
    Write-SupervisorLog "Starting VKodex run $runId."
    $child = Start-Process -FilePath $runtimePath -ArgumentList $arguments -NoNewWindow -PassThru -Wait `
      -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    Write-SupervisorLog "VKodex run $runId exited with code $($child.ExitCode); restarting in $RestartDelaySeconds seconds."
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} catch {
  Write-SupervisorLog "Supervisor stopped: $($_.Exception.ToString())"
  throw
}
