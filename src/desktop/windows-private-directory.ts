import { spawnSync } from "node:child_process";
import path from "node:path";

/** Verify the ACL established by ensureProtectedLocalDirectory before reading
 * a plaintext local capability. This runs only when a backend is attached. */
export function assertWindowsPrivateDirectory(directory: string): void {
  const root = process.env.SystemRoot;
  if (process.platform !== "win32" || !root || !path.win32.isAbsolute(root) ||
    !path.win32.isAbsolute(directory)) throw new Error("Private capability directory unavailable");
  const executable = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd().Trim();" +
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
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: directory, encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 4096,
    env: { ...process.env, PSModulePath: path.win32.join(path.dirname(executable), "Modules") },
  });
  if (result.error || result.status !== 0 || result.stdout !== "OK" || result.stderr.trim())
    throw new Error("Private capability directory unavailable");
}
