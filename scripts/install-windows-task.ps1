[CmdletBinding()]
param(
  [string]$TaskName = "VKodex",
  [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimePath = Join-Path $env:LOCALAPPDATA "VKodex\runtime\VKodex.exe"
$environmentFile = Join-Path $projectRoot ".env"
$entryPoint = Join-Path $projectRoot "dist\src\desktop-main.js"
$supervisor = Join-Path $projectRoot "scripts\run-windows-supervisor.ps1"

foreach ($required in @($runtimePath, $environmentFile, $entryPoint, $supervisor)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required VKodex file is missing: $required"
  }
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$supervisor`""
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "VKodex bridge: autostart and restart after process failure." `
  -Force | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
}

Write-Output "Scheduled task '$TaskName' installed for $identity."
