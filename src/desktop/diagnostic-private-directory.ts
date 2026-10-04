import { spawnSync } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isWindowsPrivateDirectoryAclAck } from "./windows-private-directory.js";

const WINDOWS_ACL_TIMEOUT_MS = 5_000;
const MAX_PATH_BYTES = 4_096;

function validPath(directory: string): boolean {
  if (typeof directory !== "string" || Buffer.byteLength(directory, "utf8") > MAX_PATH_BYTES ||
      /[\x00-\x1f\x7f]/u.test(directory) || !path.isAbsolute(directory) ||
      path.normalize(directory) !== directory || path.parse(directory).root === directory ||
      path.basename(directory).toLowerCase() !== "diagnostics") return false;
  if (process.platform === "win32" && !/^[a-z]:\\/iu.test(directory)) return false;
  return true;
}

async function unlinkedDirectory(directory: string): Promise<boolean> {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
  }
  const canonical = await realpath(directory);
  return process.platform === "win32" ? canonical.toLowerCase() === directory.toLowerCase() : canonical === directory;
}

const windowsVerify =
  "$entry=Get-Item -LiteralPath $p -Force;" +
  "if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){exit 10};" +
  "if(-not $entry.PSIsContainer){exit 11};" +
  "$acl=Get-Acl -LiteralPath $p;if(-not $acl.AreAccessRulesProtected){exit 12};" +
  "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
  "$administrators='S-1-5-32-544';$system='S-1-5-18';" +
  "$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;" +
  "if(@($me,$administrators) -notcontains $owner){exit 13};" +
  "$allowed=@($me,$administrators,$system);$seen=@{};" +
  "$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';" +
  "try{$rules=$acl.Access}catch{exit 14};" +
  "foreach($rule in $rules){" +
  "try{$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{exit 14};" +
  "if($allowed -notcontains $sid -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or " +
  "$rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or " +
  "($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne " +
  "[Security.AccessControl.FileSystemRights]::FullControl){exit 15};$seen[$sid]=$true};" +
  "if(-not $seen[$me]){exit 16};if(-not $seen[$system]){exit 17};[Console]::Out.Write('OK')";
const windowsCheck = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
  "$p=[Console]::In.ReadToEnd();" + windowsVerify;
const windowsCreate = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
  "$p=[Console]::In.ReadToEnd();" +
  "if([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)){exit 18};" +
  "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
  "$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');" +
  "$acl=[Security.AccessControl.DirectorySecurity]::new();" +
  "$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);" +
  "foreach($id in @($sid,$system)){" +
  "$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl," +
  "[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'," +
  "[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);" +
  "$acl.AddAccessRule($rule)};" +
  "[IO.Directory]::CreateDirectory($p,$acl)|Out-Null;" + windowsVerify;

function windowsAcl(directory: string, create: boolean): boolean {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return false;
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(create ? windowsCreate : windowsCheck, "utf16le").toString("base64");
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input: directory, encoding: "utf8", windowsHide: true, timeout: WINDOWS_ACL_TIMEOUT_MS,
    maxBuffer: 4_096, env: { ...process.env, PSModulePath: path.win32.join(path.dirname(executable), "Modules") },
  });
  return !result.error && result.status === 0 &&
    isWindowsPrivateDirectoryAclAck(Buffer.from(result.stdout, "utf8")) && result.stderr.length === 0;
}

/** Create or verify only the dedicated diagnostics leaf. Failure disables local logging. */
export async function prepareDiagnosticDirectory(directory: string): Promise<boolean> {
  try {
    if (!validPath(directory)) return false;
    const parent = path.dirname(directory);
    if (!await unlinkedDirectory(parent)) return false;
    let exists = false;
    try { await lstat(directory); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    if (process.platform === "win32") {
      if (!windowsAcl(directory, !exists)) return false;
    } else if (!exists) {
      await mkdir(directory, { mode: 0o700 });
    }
    if (!await unlinkedDirectory(directory)) return false;
    if (process.platform !== "win32") {
      const info = await lstat(directory);
      if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return false;
    }
    return true;
  } catch { return false; }
}
