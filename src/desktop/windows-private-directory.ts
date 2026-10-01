import { spawnSync } from "node:child_process";
import path from "node:path";
import { Worker } from "node:worker_threads";

const PRIVATE_DIRECTORY_UNAVAILABLE = "Private capability directory unavailable";
const MAX_WORKER_IO_BYTES = 64 * 1024;
// Cold Windows CI/host PowerShell startup can exceed two seconds. Keep the
// synchronous final ACL check bounded and fail-closed at the same limit as the
// existing worker helper; do not substitute a cached earlier attestation.
export const WINDOWS_PRIVATE_DIRECTORY_DIRECT_TIMEOUT_MS = 6_000;
const WORKER_HELPER_TIMEOUT_MS = 6_000;
const WORKER_TIMEOUT_MS = 9_000;

type DirectoryCheck = "ok" | "invalid" | "helper-error";
export type WindowsPrivateDirectoryDiagnostic =
  | "ok" | "invalid-path" | "direct-acl-invalid" | "helper-timeout" | "helper-output-limit"
  | "helper-not-found" | "helper-access-denied" | "helper-error" | "helper-output-invalid"
  | "helper-exit" | "acl-reparse" | "acl-not-directory" | "acl-not-protected" | "acl-owner"
  | "acl-principal" | "acl-rule" | "acl-user-missing" | "acl-system-missing"
  | "worker-start-failed" | "worker-timeout" | "worker-error" | "worker-exit" | "worker-invalid-message";
type WorkerVerificationResult = WindowsPrivateDirectoryDiagnostic;
type DirectoryWorkerEvent = "message" | "error" | "exit";
interface DirectoryWorker {
  once(event: DirectoryWorkerEvent, listener: (value: unknown) => void): unknown;
  terminate(): Promise<number>;
}
/** Test-only seams for the post-ACL retry. Production uses no overrides. */
export interface WindowsPrivateDirectoryAfterAclDependencies {
  readonly directCheck?: (directory: string) => "ok" | "invalid" | "helper-error";
  readonly createWorker?: () => DirectoryWorker;
  readonly workerTimeoutMs?: number;
}

/** Shared rule for both standalone reads and the write-path's in-process ACL installation. */
export const privateDirectoryAclVerificationScript =
  "$entry=Get-Item -LiteralPath $p -Force;" +
  "if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 10};" +
  "if(-not $entry.PSIsContainer){exit 11};" +
  "$acl=Get-Acl -LiteralPath $p; if(-not $acl.AreAccessRulesProtected){exit 12};" +
  "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
  "if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me){exit 13};" +
  "$allowed=@($me,'S-1-5-18');$seen=@{};" +
  "try{$rules=$acl.Access}catch{exit 14};" +
  "foreach($rule in $rules){" +
  "try{$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{exit 14};" +
  "if($allowed -notcontains $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or " +
  "($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne " +
  "[Security.AccessControl.FileSystemRights]::FullControl){exit 15};$seen[$sid]=$true};" +
  "if(-not $seen[$me]){exit 16};if(-not $seen['S-1-5-18']){exit 17};[Console]::Out.Write('OK')";

const checkScript = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd().Trim();" +
  privateDirectoryAclVerificationScript;

/** Reject PowerShell warnings, partial output, or any other success-shaped text. */
export function isWindowsPrivateDirectoryAclAck(output: Uint8Array): boolean {
  return output.byteLength === 2 && output[0] === 0x4f && output[1] === 0x4b;
}

function aclDiagnostic(status: number | null): WindowsPrivateDirectoryDiagnostic {
  switch (status) {
    case 10: return "acl-reparse";
    case 11: return "acl-not-directory";
    case 12: return "acl-not-protected";
    case 13: return "acl-owner";
    case 14: return "acl-principal";
    case 15: return "acl-rule";
    case 16: return "acl-user-missing";
    case 17: return "acl-system-missing";
    default: return "helper-exit";
  }
}

function helperErrorDiagnostic(code: string | undefined): WindowsPrivateDirectoryDiagnostic {
  switch (code) {
    case "ETIMEDOUT": return "helper-timeout";
    case "ENOBUFS": return "helper-output-limit";
    case "ENOENT": return "helper-not-found";
    case "EACCES": case "EPERM": return "helper-access-denied";
    default: return "helper-error";
  }
}

function spawnErrorCode(error: Error | undefined): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function verificationError(diagnostic: WindowsPrivateDirectoryDiagnostic, direct?: WindowsPrivateDirectoryDiagnostic): Error {
  return new Error(PRIVATE_DIRECTORY_UNAVAILABLE, { cause: direct ? { diagnostic, direct } : { diagnostic } });
}

function helperArguments(directory: string): { executable: string; script: string; environment: NodeJS.ProcessEnv } | null {
  const root = process.env.SystemRoot;
  if (process.platform !== "win32" || !root || !path.win32.isAbsolute(root) ||
    !path.win32.isAbsolute(directory) || Buffer.byteLength(directory, "utf8") > MAX_WORKER_IO_BYTES) return null;
  const executable = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE"]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  environment.PSModulePath = path.win32.join(path.dirname(executable), "Modules");
  return { executable, script: checkScript,
    environment };
}

function checkDirectory(directory: string): { result: DirectoryCheck; diagnostic: WindowsPrivateDirectoryDiagnostic } {
  const helper = helperArguments(directory);
  if (!helper) return { result: "invalid", diagnostic: "invalid-path" };
  const result = spawnSync(helper.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", helper.script], {
    input: directory, encoding: "utf8", windowsHide: true,
    timeout: WINDOWS_PRIVATE_DIRECTORY_DIRECT_TIMEOUT_MS, maxBuffer: 4096, env: helper.environment,
  });
  // spawnSync reports launch failures, timeouts, and max-buffer overflow
  // (for example ENOBUFS) through error. Only that bounded helper class may retry.
  if (result.error) return { result: "helper-error", diagnostic: helperErrorDiagnostic(spawnErrorCode(result.error)) };
  if (result.status === 0 && result.stdout === "OK" && !result.stderr.trim()) return { result: "ok", diagnostic: "ok" };
  if (result.status !== 0) return { result: "invalid", diagnostic: aclDiagnostic(result.status) };
  return { result: "invalid", diagnostic: "helper-output-invalid" };
}

/** Verify the ACL established by ensureProtectedLocalDirectory before reading
 * a plaintext local capability. This runs only when a backend is attached. */
export function assertWindowsPrivateDirectory(directory: string): void {
  if (checkDirectory(directory).result !== "ok") throw new Error(PRIVATE_DIRECTORY_UNAVAILABLE);
}

/** Retry only a direct spawnSync helper error (including timeout or ENOBUFS) after this process just installed
 * the private DACL. The blocking PowerShell work stays off the event loop. */
export async function assertWindowsPrivateDirectoryAfterAcl(directory: string,
  dependencies: WindowsPrivateDirectoryAfterAclDependencies = {}): Promise<void> {
  const checked = dependencies.directCheck ? null : checkDirectory(directory);
  const direct = dependencies.directCheck ? dependencies.directCheck(directory) : checked!.result;
  if (direct === "ok") return;
  if (direct !== "helper-error") throw verificationError(dependencies.directCheck ? "direct-acl-invalid" : checked!.diagnostic);
  const directDiagnostic = dependencies.directCheck ? "helper-error" : checked!.diagnostic;
  const helper = helperArguments(directory);
  if (!helper) throw verificationError("invalid-path", directDiagnostic);
  const timeout = dependencies.workerTimeoutMs;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > WORKER_TIMEOUT_MS))
    throw verificationError("worker-timeout", directDiagnostic);
  let diagnostic: WorkerVerificationResult = "worker-invalid-message";
  try { diagnostic = await new Promise<WorkerVerificationResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const settle = (value: WorkerVerificationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const createWorker = dependencies.createWorker ?? (() => new Worker(`
      const { spawnSync } = require("node:child_process");
      const { parentPort, workerData } = require("node:worker_threads");
      const result = spawnSync(workerData.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", workerData.script], {
        input: workerData.directory, encoding: "utf8", windowsHide: true, timeout: workerData.helperTimeoutMs, maxBuffer: workerData.maxBuffer, env: workerData.environment,
      });
      let diagnostic = "helper-output-invalid";
      if (result.error) diagnostic = result.error.code === "ETIMEDOUT" ? "helper-timeout" : result.error.code === "ENOBUFS" ? "helper-output-limit" : result.error.code === "ENOENT" ? "helper-not-found" : result.error.code === "EACCES" || result.error.code === "EPERM" ? "helper-access-denied" : "helper-error";
      else if (result.status === 0 && result.stdout === "OK" && !result.stderr.trim()) diagnostic = "ok";
      else if (result.status !== 0) diagnostic = ({10:"acl-reparse",11:"acl-not-directory",12:"acl-not-protected",13:"acl-owner",14:"acl-principal",15:"acl-rule",16:"acl-user-missing",17:"acl-system-missing"})[result.status] || "helper-exit";
      parentPort.postMessage(diagnostic);
    `, { eval: true, workerData: { ...helper, directory, maxBuffer: MAX_WORKER_IO_BYTES, helperTimeoutMs: WORKER_HELPER_TIMEOUT_MS } }));
    let worker: DirectoryWorker;
    try { worker = createWorker(); } catch { reject(new Error("worker-start-failed")); return; }
    timer = setTimeout(() => { void worker.terminate(); settle("worker-timeout"); }, timeout ?? WORKER_TIMEOUT_MS);
    worker.once("message", value => {
      void worker.terminate();
      const allowed: readonly string[] = ["ok", "helper-timeout", "helper-output-limit", "helper-not-found", "helper-access-denied", "helper-error", "helper-output-invalid", "helper-exit", "acl-reparse", "acl-not-directory", "acl-not-protected", "acl-owner", "acl-principal", "acl-rule", "acl-user-missing", "acl-system-missing"];
      if (typeof value === "string" && allowed.includes(value)) settle(value as WindowsPrivateDirectoryDiagnostic);
      else settle("worker-invalid-message");
    });
    worker.once("error", () => { void worker.terminate(); settle("worker-error"); });
    worker.once("exit", () => settle("worker-exit"));
  }); } catch (error) {
    diagnostic = error instanceof Error && error.message === "worker-start-failed" ? "worker-start-failed" : "worker-error";
  }
  if (diagnostic !== "ok") throw verificationError(diagnostic, directDiagnostic);
}
