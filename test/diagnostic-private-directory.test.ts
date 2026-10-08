import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyDiagnosticAclResult, prepareDiagnosticDirectory, prepareDiagnosticDirectoryResult } from "../src/desktop/diagnostic-private-directory.js";

test("ACL helper diagnostics are bounded and preserve exact quiet acknowledgement", () => {
  const raw = "PRIVATE_PATH_ENV_STDERR";
  const response = (overrides: Partial<SpawnSyncReturns<string>>) =>
    ({ status: 0, stdout: "OK", stderr: "", ...overrides } as SpawnSyncReturns<string>);
  assert.deepEqual(classifyDiagnosticAclResult(response({})), { ok: true });
  for (const [code, reason] of [["ENOENT", "acl-helper-missing"], ["ETIMEDOUT", "acl-helper-timeout"],
    ["EACCES", "acl-helper-error"], ["ENOBUFS", "acl-helper-error"], [raw, "acl-helper-error"]] as const) {
    const error = Object.assign(new Error(raw), { code, path: raw });
    const result = classifyDiagnosticAclResult(response({ error, stdout: raw, stderr: raw }));
    assert.deepEqual(result, { ok: false, reason }); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH_ENV_STDERR/u);
  }
  assert.deepEqual(classifyDiagnosticAclResult(response({ status: 15, stdout: raw, stderr: raw })),
    { ok: false, reason: "acl-helper-exit", exitCode: 15 });
  assert.deepEqual(classifyDiagnosticAclResult(response({ status: null, signal: "SIGTERM", stderr: raw })),
    { ok: false, reason: "acl-helper-error" });
  for (const overrides of [{ stdout: "OK\n" }, { stdout: raw }, { stderr: raw }])
    assert.deepEqual(classifyDiagnosticAclResult(response(overrides)), { ok: false, reason: "acl-helper-invalid-ack" });
});

test("directory result distinguishes invalid paths and linked parents/leaves without relaxing the boolean gate", async () => {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), "vkodex-bounded-diagnostic-"));
  const target = path.join(parent, "target"); await mkdir(target);
  const link = path.join(parent, "alias");
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  const leaf = path.join(parent, "diagnostics");
  await symlink(target, leaf, process.platform === "win32" ? "junction" : "dir");
  for (const [directory, reason] of [["diagnostics", "invalid-path"],
    [path.join(link, "diagnostics"), "linked-parent"], [leaf, "linked-leaf"]] as const) {
    assert.deepEqual(await prepareDiagnosticDirectoryResult(directory), { ok: false, reason });
    assert.equal(await prepareDiagnosticDirectory(directory), false);
  }
  const missing = path.join(parent, "missing", "diagnostics");
  assert.deepEqual(await prepareDiagnosticDirectoryResult(missing), { ok: false, reason: "filesystem-error" });
});

test("Unix mode result preserves refusal of an existing public leaf", { skip: process.platform === "win32" }, async () => {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), "vkodex-mode-diagnostic-"));
  const leaf = path.join(parent, "diagnostics"); await mkdir(leaf); await chmod(leaf, 0o755);
  assert.deepEqual(await prepareDiagnosticDirectoryResult(leaf), { ok: false, reason: "unsuitable-unix-mode" });
  assert.equal(await prepareDiagnosticDirectory(leaf), false);
  assert.equal((await lstat(leaf)).mode & 0o077, 0o055);
  await chmod(leaf, 0o700);
  assert.deepEqual(await prepareDiagnosticDirectoryResult(leaf), { ok: true });
});

test("diagnostic directory preparation accepts only a private dedicated leaf", async () => {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), "vkodex-private-diagnostic-"));
  const directory = path.join(parent, "diagnostics");
  const lexicalAlias = `${parent}${path.sep}..${path.sep}${path.basename(parent)}${path.sep}diagnostics`;
  assert.equal(await prepareDiagnosticDirectory(lexicalAlias), false);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
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
  const tempRoot = await realpath(os.tmpdir());
  const parent = await mkdtemp(path.join(tempRoot, "vkodex-public-diagnostic-"));
  const directory = path.join(parent, "diagnostics");
  await mkdir(directory, { mode: 0o755 });
  if (process.platform !== "win32") await chmod(directory, 0o755);
  assert.equal(await prepareDiagnosticDirectory(directory), false);
  const info = await lstat(directory);
  assert.equal(info.isDirectory(), true);
  if (process.platform !== "win32") assert.notEqual(info.mode & 0o077, 0);

  const linkedParent = await mkdtemp(path.join(tempRoot, "vkodex-linked-diagnostic-"));
  const target = path.join(linkedParent, "target");
  await mkdir(target);
  const link = path.join(linkedParent, "diagnostics");
  if (process.platform !== "win32") {
    await symlink(target, link, "dir");
    assert.equal(await prepareDiagnosticDirectory(link), false);
  }
});

test("existing Windows ACL without file inheritance is refused without repair", { skip: process.platform !== "win32" }, async () => {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), "vkodex-acl-inheritance-diagnostic-"));
  const directory = path.join(parent, "diagnostics");
  assert.equal(await prepareDiagnosticDirectory(directory), true);
  const executable = path.win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = (script: string): string => {
    const encoded = Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$p=[Console]::In.ReadToEnd();" + script,
      "utf16le").toString("base64");
    const result = spawnSync(executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        input: directory, encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 4_096,
        env: { ...process.env, PSModulePath: path.win32.join(path.dirname(executable), "Modules") },
      });
    assert.equal(result.error, undefined);
    const detail = result.stderr.replaceAll(directory, "<diagnostics>").replaceAll(parent, "<fixture>")
      .replaceAll(os.homedir(), "<home>").slice(0, 600);
    assert.equal(result.status, 0, `ACL fixture setup failed: ${detail}`);
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
