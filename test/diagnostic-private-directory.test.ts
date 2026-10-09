import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDiagnosticDirectory, prepareRunDiagnosticDirectory } from "../src/desktop/diagnostic-private-directory.js";
import { createDiagnosticLog } from "../src/desktop/diagnostic-log.js";

test("a full diagnostic run cannot silence the next run or overwrite its evidence", async () => {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), "vkodex-diagnostic-runs-"));
  assert.equal(await prepareRunDiagnosticDirectory(parent, "../other"), null);
  const first = await prepareRunDiagnosticDirectory(parent, "10000000-0000-0000-0000-000000000001");
  assert.ok(first);
  for (let i = 0; i < 16; i++) await writeFile(path.join(first, `trace-${String(i).padStart(3, "0")}.jsonl`), "old evidence\n");
  assert.equal((await createDiagnosticLog(first)).status().state, "full");
  const second = await prepareRunDiagnosticDirectory(parent, "10000000-0000-0000-0000-000000000002");
  assert.ok(second);
  assert.notEqual(first, second);
  const log = await createDiagnosticLog(second);
  await log.write({ schema: "vkodex.diagnostic.v1", runId: "10000000-0000-0000-0000-000000000002",
    pid: process.pid, seq: 1, at: new Date().toISOString(), event: "input.received" });
  await log.flush();
  assert.equal(log.status().state, "ready");
  assert.equal(log.status().written, 1);
  assert.equal(JSON.parse((await readFile(path.join(second, "trace-000.jsonl"), "utf8")).trim()).event, "input.received");
  assert.equal(await readFile(path.join(first, "trace-000.jsonl"), "utf8"), "old evidence\n");
});

test("diagnostic runs refuse a linked base before creating children in its target", async () => {
  const parent = await mkdtemp(path.join(await realpath(os.tmpdir()), "vkodex-linked-runs-"));
  const target = path.join(parent, "target");
  await mkdir(target);
  const linkedBase = path.join(parent, "linked");
  await symlink(target, linkedBase, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await prepareRunDiagnosticDirectory(linkedBase), null);
  assert.deepEqual(await readdir(target), []);
  assert.equal(await prepareRunDiagnosticDirectory("relative"), null);
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
