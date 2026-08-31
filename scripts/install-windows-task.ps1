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
$launcherSource = Join-Path $projectRoot "scripts\VKodexSupervisor.cs"
$iconPath = Join-Path $projectRoot "docs\logo.ico"

foreach ($required in @($runtimePath, $environmentFile, $entryPoint, $supervisor, $launcherSource, $iconPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required VKodex file is missing: $required"
  }
}

$compiler = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) { throw "The Windows .NET Framework C# compiler is unavailable." }
function Get-Sha256Prefix([string]$Path, [int]$Length) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").Substring(0, $Length)
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}
$launcherVersion = "{0}-{1}" -f (Get-Sha256Prefix $launcherSource 12), (Get-Sha256Prefix $iconPath 8)
$launcherPath = Join-Path $env:LOCALAPPDATA "VKodex\runtime\VKodexSupervisor-$launcherVersion.exe"
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  & $compiler /nologo /target:exe /platform:anycpu /optimize+ "/win32icon:$iconPath" "/out:$launcherPath" $launcherSource
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "VKodexSupervisor.exe could not be built."
  }
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $oldLauncher = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "VKodexSupervisor-*.exe" }
  } while ($oldLauncher -and (Get-Date) -lt $deadline)
  if ($oldLauncher) { throw "The previous VKodex supervisor did not stop." }
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "`"$projectRoot`""
$action = New-ScheduledTaskAction -Execute $launcherPath -Argument $arguments -WorkingDirectory $projectRoot
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
