import { spawnSync } from "node:child_process";
import path from "node:path";
import { Worker } from "node:worker_threads";

const PRIVATE_DIRECTORY_UNAVAILABLE = "Private capability directory unavailable";
const MAX_WORKER_IO_BYTES = 64 * 1024;
const WORKER_TIMEOUT_MS = 10_000;

type DirectoryCheck = "ok" | "invalid" | "helper-error";
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

const checkScript = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd().Trim();" +
  "$entry=Get-Item -LiteralPath $p -Force;" +
  "if(-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){exit 2};" +
  "$acl=Get-Acl -LiteralPath $p; if(-not $acl.AreAccessRulesProtected){exit 2};" +
  "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
  "if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me){exit 2};" +
  "$allowed=@($me,'S-1-5-18');$seen=@{};" +
  "foreach($rule in $acl.Access){" +
  "try{$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{exit 2};" +
  "if($allowed -notcontains $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or " +
  "($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne " +
  "[Security.AccessControl.FileSystemRights]::FullControl){exit 2};$seen[$sid]=$true};" +
  "if(-not $seen[$me] -or -not $seen['S-1-5-18']){exit 2};[Console]::Out.Write('OK')";

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

function checkDirectory(directory: string): DirectoryCheck {
  const helper = helperArguments(directory);
  if (!helper) return "invalid";
  const result = spawnSync(helper.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", helper.script], {
    input: directory, encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 4096, env: helper.environment,
  });
  if (result.error) return "helper-error";
  return result.status === 0 && result.stdout === "OK" && !result.stderr.trim() ? "ok" : "invalid";
}

/** Verify the ACL established by ensureProtectedLocalDirectory before reading
 * a plaintext local capability. This runs only when a backend is attached. */
export function assertWindowsPrivateDirectory(directory: string): void {
  if (checkDirectory(directory) !== "ok") throw new Error(PRIVATE_DIRECTORY_UNAVAILABLE);
}

/** Retry only a direct helper launch failure after this process just installed
 * the private DACL. The blocking PowerShell work stays off the event loop. */
export async function assertWindowsPrivateDirectoryAfterAcl(directory: string,
  dependencies: WindowsPrivateDirectoryAfterAclDependencies = {}): Promise<void> {
  const direct = dependencies.directCheck?.(directory) ?? checkDirectory(directory);
  if (direct === "ok") return;
  if (direct !== "helper-error") throw new Error(PRIVATE_DIRECTORY_UNAVAILABLE);
  const helper = helperArguments(directory);
  if (!helper) throw new Error(PRIVATE_DIRECTORY_UNAVAILABLE);
  const timeout = dependencies.workerTimeoutMs;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > WORKER_TIMEOUT_MS))
    throw new Error(PRIVATE_DIRECTORY_UNAVAILABLE);
  let result: boolean;
  try { result = await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const createWorker = dependencies.createWorker ?? (() => new Worker(`
      const { spawnSync } = require("node:child_process");
      const { parentPort, workerData } = require("node:worker_threads");
      const result = spawnSync(workerData.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", workerData.script], {
        input: workerData.directory, encoding: "utf8", windowsHide: true, timeout: 2000, maxBuffer: workerData.maxBuffer, env: workerData.environment,
      });
      parentPort.postMessage(!result.error && result.status === 0 && result.stdout === "OK" && !result.stderr.trim());
    `, { eval: true, workerData: { ...helper, directory, maxBuffer: MAX_WORKER_IO_BYTES } }));
    let worker: DirectoryWorker;
    try { worker = createWorker(); } catch (error) { reject(error); return; }
    timer = setTimeout(() => { void worker.terminate(); settle(false); }, timeout ?? WORKER_TIMEOUT_MS);
    worker.once("message", value => { void worker.terminate(); settle(value === true); });
    worker.once("error", () => { void worker.terminate(); settle(false); });
    worker.once("exit", () => settle(false));
  }); } catch { throw new Error(PRIVATE_DIRECTORY_UNAVAILABLE); }
  if (!result) throw new Error(PRIVATE_DIRECTORY_UNAVAILABLE);
}
