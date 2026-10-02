[CmdletBinding()]
param(
    [ValidateSet('resume-interrupted', 'reconcile-only')]
    [string]$RecoveryPolicy = 'resume-interrupted'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$RecoveryPolicy = $RecoveryPolicy.ToLowerInvariant()
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
$workerProcess = Start-Process -FilePath $node -ArgumentList @('--env-file=.env', $worker, '--recovery-policy', $RecoveryPolicy) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $workerLog -RedirectStandardError $workerErr -PassThru
Write-Output "Controlled restart scheduled (worker PID $($workerProcess.Id), recovery policy $RecoveryPolicy). This policy does not prove that stopping the owned Codex backends is safe."
