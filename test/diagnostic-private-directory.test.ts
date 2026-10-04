import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDiagnosticDirectory } from "../src/desktop/diagnostic-private-directory.js";

test("diagnostic directory preparation accepts only a private dedicated leaf", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "vkodex-private-diagnostic-"));
  const directory = path.join(parent, "diagnostics");
  assert.equal(await prepareDiagnosticDirectory(directory), true);
  assert.equal(await prepareDiagnosticDirectory(directory), true);
  const info = await lstat(directory);
  assert.equal(info.isDirectory(), true);
  if (process.platform !== "win32") assert.equal(info.mode & 0o077, 0);
  assert.equal(await prepareDiagnosticDirectory(path.join(parent, "other")), false);
  assert.equal(await prepareDiagnosticDirectory("diagnostics"), false);
  assert.equal(await prepareDiagnosticDirectory(path.parse(parent).root), false);
});

test("diagnostic directory preparation refuses existing public or linked leaves", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "vkodex-public-diagnostic-"));
  const directory = path.join(parent, "diagnostics");
  await mkdir(directory, { mode: 0o755 });
  if (process.platform !== "win32") await chmod(directory, 0o755);
  assert.equal(await prepareDiagnosticDirectory(directory), false);
  const info = await lstat(directory);
  assert.equal(info.isDirectory(), true);
  if (process.platform !== "win32") assert.notEqual(info.mode & 0o077, 0);

  const linkedParent = await mkdtemp(path.join(os.tmpdir(), "vkodex-linked-diagnostic-"));
  const target = path.join(linkedParent, "target");
  await mkdir(target);
  const link = path.join(linkedParent, "diagnostics");
  if (process.platform !== "win32") {
    await symlink(target, link, "dir");
    assert.equal(await prepareDiagnosticDirectory(link), false);
  }
});

test("existing Windows ACL without file inheritance is refused without repair", { skip: process.platform !== "win32" }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "vkodex-acl-inheritance-diagnostic-"));
  const directory = path.join(parent, "diagnostics");
  assert.equal(await prepareDiagnosticDirectory(directory), true);
  const executable = path.win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = (script: string): string => {
    const encoded = Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$p=[Console]::In.ReadToEnd();" + script,
      "utf16le").toString("base64");
    const result = spawnSync(executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        input: directory, encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 4_096,
      });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, "ACL fixture setup failed");
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  const hash = "$acl=Get-Acl -LiteralPath $p;" +
    "$sha=[Security.Cryptography.SHA256]::Create();" +
    "try{[Console]::Out.Write([Convert]::ToBase64String($sha.ComputeHash($acl.GetSecurityDescriptorBinaryForm())))}" +
    "finally{$sha.Dispose()}";
  const badFlags = run(
    "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
    "$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');" +
    "$acl=[Security.AccessControl.DirectorySecurity]::new();" +
    "$acl.SetAccessRuleProtection($true,$false);" +
    "foreach($id in @($me,$system)){" +
    "$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl," +
    "[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None," +
    "[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule)};" +
    "[IO.Directory]::SetAccessControl($p,$acl);" +
    "$acl=Get-Acl -LiteralPath $p;" +
    "if($acl.Access.Count -ne 2 -or @($acl.Access | Where-Object {$_.InheritanceFlags -ne 'None'}).Count -ne 0){exit 19};" +
    hash);
  assert.match(badFlags, /^[A-Za-z0-9+/]{43}=$/u);
  assert.equal(await prepareDiagnosticDirectory(directory), false);
  assert.equal(run(hash), badFlags);
});
