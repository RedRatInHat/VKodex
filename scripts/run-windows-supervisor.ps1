[CmdletBinding(DefaultParameterSetName = "Legacy")]
param(
  [int]$RestartDelaySeconds = 5,
  [Parameter(Mandatory = $true, ParameterSetName = "Versioned")][string]$LaunchBinding,
  [Parameter(Mandatory = $true, ParameterSetName = "Versioned")][string]$LaunchBindingSha256,
  [Parameter(Mandatory = $true, ParameterSetName = "Versioned")][string]$LauncherPath,
  [Parameter(Mandatory = $true, ParameterSetName = "Versioned")][string]$LauncherSha256,
  [Parameter(ParameterSetName = "Versioned")][switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSCmdlet.ParameterSetName -eq "Versioned") {
  if ($RestartDelaySeconds -lt 1 -or $RestartDelaySeconds -gt 300 -or
      $LaunchBindingSha256 -cnotmatch '^[a-f0-9]{64}$' -or $LauncherSha256 -cnotmatch '^[a-f0-9]{64}$') {
    [Console]::Error.WriteLine("Versioned launch validation refused.")
    exit 86
  }

  foreach ($candidatePath in @($LaunchBinding, $LauncherPath)) {
    if (-not [IO.Path]::IsPathRooted($candidatePath) -or $candidatePath.Contains('"') -or
        $candidatePath.Contains([char]0) -or $candidatePath.Contains("`r") -or $candidatePath.Contains("`n")) {
      [Console]::Error.WriteLine("Versioned launch validation refused.")
      exit 86
    }
  }

  try {
    $canonicalBinding = [IO.Path]::GetFullPath($LaunchBinding)
    $canonicalLauncher = [IO.Path]::GetFullPath($LauncherPath)
  } catch {
    [Console]::Error.WriteLine("Versioned launch validation refused.")
    exit 86
  }

  $startupVariables = @(
    "NODE_OPTIONS", "NODE_PATH", "COR_ENABLE_PROFILING", "COR_PROFILER", "COR_PROFILER_PATH",
    "COR_PROFILER_PATH_32", "COR_PROFILER_PATH_64", "APPDOMAIN_MANAGER_ASM", "APPDOMAIN_MANAGER_TYPE",
    "COMPLUS_PROFAPI_PROFILERCOMPATIBILITYSETTING"
  )

  function Test-SameWindowsPath([string]$Left, [string]$Right) {
    try {
      return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
  }

  function Invoke-PinnedLauncher([string]$Operation, [switch]$CapturePlan, [string]$WorkingDirectory) {
    $stream = $null
    $process = $null
    $processStarted = $false
    try {
      if ($Operation -cnotin @("plan-only", "run-once") -or $canonicalBinding.EndsWith("\") -or $canonicalBinding.EndsWith("/")) {
        return @{ ExitCode = 86; Plan = $null }
      }
      # The trusted parent supplies this immutable digest after validating the launcher.
      # Keep the verified file open without write/delete sharing through Process.Exit.
      $stream = [IO.File]::Open($canonicalLauncher, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      if ($stream.Length -gt 64MB -or (Test-Path -LiteralPath ($canonicalLauncher + ".config"))) {
        return @{ ExitCode = 86; Plan = $null }
      }
      $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
      try { $actualHash = ([BitConverter]::ToString($hashAlgorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
      finally { $hashAlgorithm.Dispose() }
      if ($actualHash -cne $LauncherSha256) { return @{ ExitCode = 86; Plan = $null } }

      if (Test-Path -LiteralPath ($canonicalLauncher + ".config")) { return @{ ExitCode = 86; Plan = $null } }
      if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) { $WorkingDirectory = [Environment]::CurrentDirectory }
      if (-not [IO.Path]::IsPathRooted($WorkingDirectory) -or $WorkingDirectory.Contains('"')) { return @{ ExitCode = 86; Plan = $null } }

      $startInfo = New-Object System.Diagnostics.ProcessStartInfo
      $startInfo.FileName = $canonicalLauncher
      $startInfo.Arguments = '--launch-binding "' + $canonicalBinding + '" --launch-binding-sha256 ' + $LaunchBindingSha256 + ' --operation ' + $Operation
      $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
      $startInfo.UseShellExecute = $false
      $startInfo.CreateNoWindow = $true
      foreach ($key in @($startInfo.EnvironmentVariables.Keys)) {
        if ($startupVariables -icontains [string]$key) { $startInfo.EnvironmentVariables.Remove([string]$key) }
      }
      $startInfo.EnvironmentVariables["NODE_OPTIONS"] = ""
      $startInfo.EnvironmentVariables["NODE_PATH"] = ""
      $startInfo.EnvironmentVariables["COR_ENABLE_PROFILING"] = "0"
      foreach ($name in @("COR_PROFILER", "COR_PROFILER_PATH", "COR_PROFILER_PATH_32", "COR_PROFILER_PATH_64",
          "APPDOMAIN_MANAGER_ASM", "APPDOMAIN_MANAGER_TYPE", "COMPLUS_PROFAPI_PROFILERCOMPATIBILITYSETTING")) {
        $startInfo.EnvironmentVariables[$name] = ""
      }

      if ($CapturePlan) {
        $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false, $true)
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = $utf8
        $startInfo.StandardErrorEncoding = $utf8
      }
      $process = New-Object System.Diagnostics.Process
      $process.StartInfo = $startInfo
      if (-not $process.Start()) { return @{ ExitCode = 86; Plan = $null } }
      $processStarted = $true
      if ($CapturePlan) {
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(35000)) {
          try { $process.Kill() } catch { }
          try { $null = $process.WaitForExit(2000) } catch { }
          return @{ ExitCode = 86; Plan = $null }
        }
        # Process exit does not prove inherited pipe handles have closed. Bound
        # pipe completion as well; only the private plan helper may be killed.
        $captureTasks = [System.Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)
        if (-not [System.Threading.Tasks.Task]::WaitAll($captureTasks, 2000)) {
          return @{ ExitCode = 86; Plan = $null }
        }
        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        $exitCode = $process.ExitCode
        if ($stdoutText.Length -gt 16384 -or $stderrText.Length -gt 8192 -or $stderrText.Length -ne 0) {
          return @{ ExitCode = 86; Plan = $null }
        }
        if ($exitCode -eq 0) {
          if ($stdoutText -notmatch '^[^\r\n]+\r?\n?$') { return @{ ExitCode = 86; Plan = $null } }
          $output = $stdoutText.TrimEnd("`r", "`n")
        } else { $output = "" }
      } else {
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $output = ""
      }

      if ($CapturePlan -and $exitCode -eq 0) {
        if ([string]::IsNullOrWhiteSpace($output) -or $output.Length -gt 16384 -or $output -match "[`r`n]") {
          return @{ ExitCode = 86; Plan = $null }
        }
        try { $plan = [string]$output | ConvertFrom-Json -ErrorAction Stop } catch { return @{ ExitCode = 86; Plan = $null } }
        $expectedKeys = @(
          "executable", "entryPoint", "cwd", "environmentFile", "dataDirectory", "nativeCodexPath", "arguments",
          "environmentOverrides", "descriptorSha256", "manifestSha256", "sourceCommit", "sourceTree", "runtimeSha256",
          "version", "status", "protocol", "bindingPath", "bindingSha256", "bootstrapManifestSha256",
          "launcherPath", "launcherSha256", "supervisorPath", "watchdogPath"
        )
        $actualKeys = @($plan.PSObject.Properties.Name)
        if ($actualKeys.Count -ne $expectedKeys.Count -or @($actualKeys | Where-Object { $expectedKeys -cnotcontains $_ }).Count -ne 0 -or
            @($expectedKeys | Where-Object { $actualKeys -cnotcontains $_ }).Count -ne 0) {
          return @{ ExitCode = 86; Plan = $null }
        }
        $overrideKeys = @($plan.environmentOverrides.PSObject.Properties.Name)
        if ($plan.version -ne 1 -or $plan.protocol -cne "deployment-plan-v1" -or $plan.status -cne "validated_not_launched" -or
            -not (Test-SameWindowsPath ([string]$plan.bindingPath) $canonicalBinding) -or $plan.bindingSha256 -cne $LaunchBindingSha256 -or
            -not (Test-SameWindowsPath ([string]$plan.launcherPath) $canonicalLauncher) -or $plan.launcherSha256 -cne $LauncherSha256 -or
            $plan.runtimeSha256 -cnotmatch '^[a-f0-9]{64}$' -or $plan.bootstrapManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $plan.descriptorSha256 -cnotmatch '^[a-f0-9]{64}$' -or $plan.manifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $plan.sourceCommit -cnotmatch '^[a-f0-9]{40}$' -or $plan.sourceTree -cnotmatch '^[a-f0-9]{40}$' -or
            -not [IO.Path]::IsPathRooted([string]$plan.executable) -or -not [IO.Path]::IsPathRooted([string]$plan.nativeCodexPath) -or
            -not [IO.Path]::IsPathRooted([string]$plan.cwd) -or -not [IO.Path]::IsPathRooted([string]$plan.entryPoint) -or
            -not [IO.Path]::IsPathRooted([string]$plan.environmentFile) -or -not [IO.Path]::IsPathRooted([string]$plan.dataDirectory) -or
            -not (Test-SameWindowsPath ([string]$plan.environmentFile) (Join-Path ([string]$plan.cwd) ".env")) -or
            [int]$plan.arguments.Count -ne 2 -or $plan.arguments[0] -cne ("--env-file=" + [string]$plan.environmentFile) -or
            $plan.arguments[1] -cne [string]$plan.entryPoint -or $plan.environmentOverrides.BOT_DATA_DIR -cne [string]$plan.dataDirectory -or
            $plan.environmentOverrides.NODE_OPTIONS -cne "" -or $plan.environmentOverrides.NODE_PATH -cne "" -or
            $overrideKeys.Count -ne 3 -or @($overrideKeys | Where-Object { @("BOT_DATA_DIR", "NODE_OPTIONS", "NODE_PATH") -cnotcontains $_ }).Count -ne 0) {
          return @{ ExitCode = 86; Plan = $null }
        }
        return @{ ExitCode = 0; Plan = $plan }
      }
      return @{ ExitCode = $exitCode; Plan = $null }
    } catch {
      if ($processStarted -and $null -ne $process) {
        if ($CapturePlan) {
          try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(2000) } } catch { }
        } else {
          try { if (-not $process.HasExited) { $process.WaitForExit() }; return @{ ExitCode = $process.ExitCode; Plan = $null } } catch { }
        }
      }
      return @{ ExitCode = 86; Plan = $null }
    } finally {
      if ($null -ne $process) { $process.Dispose() }
      if ($null -ne $stream) { $stream.Dispose() }
    }
  }

  $planResult = Invoke-PinnedLauncher "plan-only" -CapturePlan
  if ($planResult.ExitCode -ne 0 -or $null -eq $planResult.Plan) {
    [Console]::Error.WriteLine("Versioned launch validation refused.")
    exit 86
  }
  $plan = $planResult.Plan
  $logDirectory = Join-Path ([string]$plan.dataDirectory) "logs"
  $supervisorLog = Join-Path $logDirectory "supervisor.log"
  try { New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null } catch {
    [Console]::Error.WriteLine("Versioned supervisor could not initialize its log directory.")
    exit 1
  }
  function Write-VersionedSupervisorLog([string]$Message) {
    $line = "[$((Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK'))] $Message"
    try { Add-Content -LiteralPath $supervisorLog -Value $line -Encoding UTF8 } catch { }
  }
  Write-VersionedSupervisorLog "Versioned supervisor started."

  if ($Once) {
    $runResult = Invoke-PinnedLauncher "run-once" -WorkingDirectory ([string]$plan.cwd)
    if ($runResult.ExitCode -eq 86) {
      Write-VersionedSupervisorLog "Versioned launch validation refused; supervision stopped without retry."
      exit 86
    }
    Write-VersionedSupervisorLog "Bounded versioned run-once completed with exit code $($runResult.ExitCode)."
    exit ([int]$runResult.ExitCode)
  }

  while ($true) {
    $runResult = Invoke-PinnedLauncher "run-once" -WorkingDirectory ([string]$plan.cwd)
    if ($runResult.ExitCode -eq 86) {
      Write-VersionedSupervisorLog "Versioned launch validation refused; supervision stopped without retry."
      exit 86
    }
    Write-VersionedSupervisorLog "Versioned run exited with code $($runResult.ExitCode); retrying after the configured delay."
    Start-Sleep -Seconds $RestartDelaySeconds
  }
}

if ($RestartDelaySeconds -lt 1 -or $RestartDelaySeconds -gt 300) {
  throw "RestartDelaySeconds must be between 1 and 300."
}

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimePath = Join-Path $env:LOCALAPPDATA "VKodex\runtime\VKodex.exe"
$environmentFile = Join-Path $projectRoot ".env"
$entryPoint = Join-Path $projectRoot "dist\src\desktop-main.js"
$iconPath = Join-Path $projectRoot "docs\logo.ico"
$logDirectory = Join-Path $projectRoot "data\desktop\logs"
$supervisorLog = Join-Path $logDirectory "supervisor.log"
$watchdogScript = Join-Path $PSScriptRoot "watch-windows-bridge.ps1"
$healthFile = Join-Path $projectRoot "data\desktop\health.json"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-SupervisorLog([string]$Message) {
  $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
  $line = "[$timestamp] $Message"
  Add-Content -LiteralPath $supervisorLog -Value $line -Encoding UTF8
  Write-Host $line -ForegroundColor Cyan
}

try {
  foreach ($required in @($runtimePath, $environmentFile, $entryPoint, $iconPath, $watchdogScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Required VKodex file is missing: $required"
    }
  }

  try { $Host.UI.RawUI.WindowTitle = "VKodex Bridge - DO NOT CLOSE" } catch { }
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VKodexWindowIconNative {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}
"@
    $script:windowIcon = New-Object System.Drawing.Icon($iconPath)
    $windowHandle = [VKodexWindowIconNative]::GetConsoleWindow()
    if ($windowHandle -eq [IntPtr]::Zero) { throw "Console window handle is unavailable." }
    [VKodexWindowIconNative]::SetCurrentProcessExplicitAppUserModelID("RedRatInHat.VKodex.Bridge") | Out-Null
    [VKodexWindowIconNative]::SendMessage($windowHandle, 0x80, [IntPtr]0, $script:windowIcon.Handle) | Out-Null
    [VKodexWindowIconNative]::SendMessage($windowHandle, 0x80, [IntPtr]1, $script:windowIcon.Handle) | Out-Null
  } catch {
    Write-SupervisorLog "The VKodex window icon could not be applied; the bridge will continue without it."
  }
  Write-Host "VKodex Bridge - DO NOT CLOSE THIS WINDOW" -ForegroundColor Yellow
  Write-Host "Closing it stops remote access until the scheduled task is started again." -ForegroundColor Yellow
  Write-Host "Runtime logs: $logDirectory"
  Write-Host ""
  Write-SupervisorLog "Supervisor started (PID $PID)."
  $watchdogArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -SupervisorPid {1} -HealthFile "{2}" -EntryPoint "{3}" -LogFile "{4}"' -f
    $watchdogScript, $PID, $healthFile, $entryPoint, $supervisorLog
  try {
    $watchdog = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $watchdogArgs -WindowStyle Hidden -PassThru
    Write-SupervisorLog "Health watchdog started (PID $($watchdog.Id))."
  } catch {
    Write-SupervisorLog "Health watchdog could not start; the bridge will continue without external stale-health diagnostics."
  }
  while ($true) {
    $runId = "{0}-{1}" -f (Get-Date).ToString("yyyyMMdd-HHmmssfff"), ([Guid]::NewGuid().ToString("N").Substring(0, 8))
    $runLog = Join-Path $logDirectory "vkodex-$runId.log"
    Write-SupervisorLog "Starting VKodex run $runId (log: $runLog)."
    $previousRunId = $env:VKODEX_RUN_ID
    $env:VKODEX_RUN_ID = $runId
    try {
      & $runtimePath "--env-file=$environmentFile" $entryPoint
      $exitCode = $LASTEXITCODE
    } finally {
      if ($null -eq $previousRunId) { Remove-Item Env:VKODEX_RUN_ID -ErrorAction SilentlyContinue }
      else { $env:VKODEX_RUN_ID = $previousRunId }
    }
    Write-SupervisorLog "VKodex run $runId exited with code $exitCode; restarting in $RestartDelaySeconds seconds."
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} catch {
  Write-SupervisorLog "Supervisor stopped: $($_.Exception.ToString())"
  throw
}
