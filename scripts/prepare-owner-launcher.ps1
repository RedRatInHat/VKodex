[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$CodexHome,
  [Parameter(Mandatory=$true)][string]$NativeExecutable,
  [Parameter(Mandatory=$true)][string]$Destination,
  [string]$RuntimeExecutable = (Join-Path $env:LOCALAPPDATA 'VKodex\runtime\VKodex.exe')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$homePath = (Resolve-Path -LiteralPath $CodexHome).Path
$nativePath = (Resolve-Path -LiteralPath $NativeExecutable).Path
$runtimePath = (Resolve-Path -LiteralPath $RuntimeExecutable).Path
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Choose a new installation directory; existing installations are not overwritten.' }
$files = @('owner-launcher.js', 'owner-channel.js', 'owner-transport.js', 'paths.js')
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $repo "dist\src\desktop\$file") -PathType Leaf)) { throw 'Run npm run build before preparing the launcher.' }
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework compiler is required.' }
New-Item -ItemType Directory -Path $target | Out-Null
# Profile and registry data contain a local capability token. Do not inherit broad
# permissions from a custom deployment directory.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$registry = Join-Path $env:LOCALAPPDATA 'VKodex\owner-transports'
New-Item -ItemType Directory -Path $registry -Force | Out-Null
foreach ($directory in @($target, $registry)) {
  & icacls.exe $directory /inheritance:r /grant:r "*$($sid):(OI)(CI)(F)" '*S-1-5-18:(OI)(CI)(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect the local owner transport directory.' }
}
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $repo "dist\src\desktop\$file") -Destination (Join-Path $target $file) }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $target 'package.json'), '{"private":true,"type":"module"}', $utf8)
$config = @{version=1;codexHome=$homePath;nativeExecutable=$nativePath;runtimeExecutable=$runtimePath;adapterEntry=(Join-Path $target 'owner-launcher.js')}
$nativeDirectory = Split-Path $nativePath -Parent
$nativeVersion = Split-Path $nativeDirectory -Leaf
$nativeRoot = Split-Path $nativeDirectory -Parent
if ((Split-Path $nativePath -Leaf) -ieq 'codex.exe' -and $nativeVersion -match '^[a-f0-9]{16}$' -and (Split-Path $nativeRoot -Leaf) -ieq 'bin') {
  # Codex Desktop replaces the hashed native directory during an AppX update.
  # Resolve the newest signed app payload at launch instead of pinning a deleted file.
  $config.nativeSearchRoot = $nativeRoot
}
$extensionDirectory = Split-Path (Split-Path (Split-Path $nativePath -Parent) -Parent) -Parent
$extensionRegistry = Join-Path (Split-Path $extensionDirectory -Parent) 'extensions.json'
if ((Split-Path $extensionDirectory -Leaf) -like 'openai.chatgpt-*' -and (Test-Path -LiteralPath $extensionRegistry -PathType Leaf)) {
  $config.extensionRegistry = $extensionRegistry
}
[IO.File]::WriteAllText((Join-Path $target 'owner-launcher.json'), ($config | ConvertTo-Json), $utf8)
$executable = Join-Path $target 'VKodexOwnerLauncher.exe'
& $compiler /nologo /target:exe /reference:System.Web.Extensions.dll "/out:$executable" (Join-Path $PSScriptRoot 'VKodexOwnerLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Owner launcher compilation failed.' }
Write-Output "Prepared: $executable"
Write-Output 'No VS Code settings or running clients were changed.'
