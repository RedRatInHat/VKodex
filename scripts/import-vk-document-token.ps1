[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$Path = (Join-Path $env:LOCALAPPDATA 'VKodex\secrets\vk-document-token.xml')
)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'

if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
  throw "VK authorization file was not found: $InputPath"
}

$raw = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $InputPath).Path)
$token = $null

# Accept the URL fragment produced by VK OAuth: ...#access_token=...&expires_in=...
$match = [regex]::Match($raw, '(?i)(?:[#?&]|^)access_token=([^&#\s"''<>]+)')
if ($match.Success) {
  $token = [System.Uri]::UnescapeDataString($match.Groups[1].Value)
}

# Also accept a JSON OAuth response containing an access_token property.
if ([string]::IsNullOrWhiteSpace($token)) {
  try {
    $json = $raw | ConvertFrom-Json
    if ($json.access_token -is [string]) { $token = $json.access_token }
  }
  catch {
    # A URL or plain text input is valid, so invalid JSON is expected.
  }
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw 'No access_token was found in the authorization file.'
}

$token = $token.Trim()
if ($token.Length -lt 16 -or $token.Length -gt 4096 -or $token -notmatch '^[A-Za-z0-9_.:-]+$') {
  throw 'The extracted access_token has an unexpected format.'
}

$parent = Split-Path -Parent $Path
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$secure = ConvertTo-SecureString -String $token -AsPlainText -Force
$encrypted = ConvertFrom-SecureString -SecureString $secure
$existing = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
$target = if ($existing) { $existing.Path } else { $Path }
[System.IO.File]::WriteAllText($target, $encrypted, [System.Text.UTF8Encoding]::new($false))

Write-Host "VK user token imported into the DPAPI store: $Path"
