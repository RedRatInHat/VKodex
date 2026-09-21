[CmdletBinding()]
param(
  [string]$Path = (Join-Path $env:LOCALAPPDATA 'VKodex\secrets\vk-document-token.xml')
)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$parent = Split-Path -Parent $Path
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$token = Read-Host 'Paste VK user token (input is hidden)' -AsSecureString
if ($token.Length -le 0) { throw 'Token cannot be empty.' }
$encrypted = ConvertFrom-SecureString -SecureString $token
$existing = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
$target = if ($existing) { $existing.Path } else { $Path }
[System.IO.File]::WriteAllText($target, $encrypted, [System.Text.UTF8Encoding]::new($false))
Write-Host "Token saved in the DPAPI store: $Path"
