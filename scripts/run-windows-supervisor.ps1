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

foreach ($required in @($runtimePath, $environmentFile, $entryPoint)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required VKodex file is missing: $required"
  }
}

while ($true) {
  & $runtimePath "--env-file=$environmentFile" $entryPoint
  Start-Sleep -Seconds $RestartDelaySeconds
}

