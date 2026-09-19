[CmdletBinding()]
param(
  [string]$ThreadId,
  [switch]$ResolveOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$packages = @(Get-AppxPackage -Name 'OpenAI.Codex' | Where-Object {
  $_.InstallLocation -and (Test-Path -LiteralPath (Join-Path $_.InstallLocation 'app\ChatGPT.exe') -PathType Leaf)
})
if ($packages.Count -ne 1) { throw 'Expected exactly one installed Codex Desktop package.' }
$executable = Join-Path $packages[0].InstallLocation 'app\ChatGPT.exe'
if ($ResolveOnly) { Write-Output $executable; return }

$arguments = @()
if ($ThreadId) {
  if ($ThreadId -notmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'Invalid Codex thread ID.' }
  $arguments += 'codex://threads/' + [Uri]::EscapeDataString($ThreadId)
}
Start-Process -FilePath $executable -ArgumentList $arguments | Out-Null
