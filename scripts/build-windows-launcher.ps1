[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Destination,
  [ValidateSet('Supervisor','Owner')][string]$Kind = 'Supervisor'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceName = if ($Kind -eq 'Supervisor') { 'VKodexSupervisor.cs' } else { 'VKodexOwnerLauncher.cs' }
$source = Join-Path $PSScriptRoot $sourceName
$icon = Join-Path $repo 'docs\logo.ico'
$output = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $output) { throw 'Choose a new launcher path; existing executables are not overwritten.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
foreach ($required in @($source, $icon, $compiler)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required launcher build input missing: $required" }
}
New-Item -ItemType Directory -Path (Split-Path $output -Parent) -Force | Out-Null
$references = if ($Kind -eq 'Owner') { @('/r:System.Web.Extensions.dll') } else { @() }
& $compiler /nologo /target:exe /platform:anycpu /optimize+ "/win32icon:$icon" "/out:$output" @references $source
if ($LASTEXITCODE -ne 0) { throw 'VKodex launcher compilation failed.' }
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($output)
$expectedTitle = if ($Kind -eq 'Supervisor') { 'VKodex Bridge' } else { 'VKodex Owner Adapter' }
if ($version.FileDescription -cne $expectedTitle -or $version.ProductName -cne 'VKodex') {
  throw 'VKodex launcher branding verification failed; do not deploy this executable.'
}
$hashStream = [IO.File]::OpenRead($output)
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
finally { $hashStream.Dispose(); $hashAlgorithm.Dispose() }
[pscustomobject]@{ executable=$output; description=$version.FileDescription; product=$version.ProductName; sha256=$hash }
