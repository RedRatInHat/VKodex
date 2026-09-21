[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source

# Build before detaching. The worker is started as an independent process so
# the bridge may terminate the Codex turn that launched this command without
# taking the snapshot/restart waiter down with it.
Push-Location $projectRoot
try { npm run build | Out-Host }
finally { Pop-Location }

$worker = Join-Path $projectRoot "dist\src\desktop\controlled-restart.js"
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw "Controlled restart worker was not built: $worker" }
$workerLog = Join-Path $projectRoot "data\desktop\controlled-restart-worker.log"
$workerErr = Join-Path $projectRoot "data\desktop\controlled-restart-worker.err.log"
$workerProcess = Start-Process -FilePath $node -ArgumentList @('--env-file=.env', $worker) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $workerLog -RedirectStandardError $workerErr -PassThru
Write-Output "Controlled restart scheduled (worker PID $($workerProcess.Id)): snapshot, bridge stop, supervised start and idempotent task recovery will run in the background."
