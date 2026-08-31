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
$iconPath = Join-Path $projectRoot "docs\logo.ico"
$logDirectory = Join-Path $projectRoot "data\desktop\logs"
$supervisorLog = Join-Path $logDirectory "supervisor.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-SupervisorLog([string]$Message) {
  $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
  $line = "[$timestamp] $Message"
  Add-Content -LiteralPath $supervisorLog -Value $line -Encoding UTF8
  Write-Host $line -ForegroundColor Cyan
}

try {
  foreach ($required in @($runtimePath, $environmentFile, $entryPoint, $iconPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Required VKodex file is missing: $required"
    }
  }

  try { $Host.UI.RawUI.WindowTitle = "VKodex Bridge - DO NOT CLOSE" } catch { }
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VKodexWindowIconNative {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}
"@
    $script:windowIcon = New-Object System.Drawing.Icon($iconPath)
    $windowHandle = [VKodexWindowIconNative]::GetConsoleWindow()
    if ($windowHandle -eq [IntPtr]::Zero) { throw "Console window handle is unavailable." }
    [VKodexWindowIconNative]::SetCurrentProcessExplicitAppUserModelID("RedRatInHat.VKodex.Bridge") | Out-Null
    [VKodexWindowIconNative]::SendMessage($windowHandle, 0x80, [IntPtr]0, $script:windowIcon.Handle) | Out-Null
    [VKodexWindowIconNative]::SendMessage($windowHandle, 0x80, [IntPtr]1, $script:windowIcon.Handle) | Out-Null
  } catch {
    Write-SupervisorLog "The VKodex window icon could not be applied; the bridge will continue without it."
  }
  Write-Host "VKodex Bridge - DO NOT CLOSE THIS WINDOW" -ForegroundColor Yellow
  Write-Host "Closing it stops remote access until the scheduled task is started again." -ForegroundColor Yellow
  Write-Host "Runtime logs: $logDirectory"
  Write-Host ""
  Write-SupervisorLog "Supervisor started (PID $PID)."
  while ($true) {
    $runId = "{0}-{1}" -f (Get-Date).ToString("yyyyMMdd-HHmmssfff"), ([Guid]::NewGuid().ToString("N").Substring(0, 8))
    $runLog = Join-Path $logDirectory "vkodex-$runId.log"
    Write-SupervisorLog "Starting VKodex run $runId (log: $runLog)."
    $previousRunId = $env:VKODEX_RUN_ID
    $env:VKODEX_RUN_ID = $runId
    try {
      & $runtimePath "--env-file=$environmentFile" $entryPoint
      $exitCode = $LASTEXITCODE
    } finally {
      if ($null -eq $previousRunId) { Remove-Item Env:VKODEX_RUN_ID -ErrorAction SilentlyContinue }
      else { $env:VKODEX_RUN_ID = $previousRunId }
    }
    Write-SupervisorLog "VKodex run $runId exited with code $exitCode; restarting in $RestartDelaySeconds seconds."
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} catch {
  Write-SupervisorLog "Supervisor stopped: $($_.Exception.ToString())"
  throw
}
