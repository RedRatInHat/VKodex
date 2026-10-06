import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import test, { after } from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOOTSTRAP_FILES } from "../src/desktop/deployment-binding.js";
import { executeDeployment } from "../src/desktop/deployment-execution.js";
import { desktopLogPath } from "../src/desktop/logging.js";

const execFileAsync = promisify(execFile);
const temporaryParent = process.platform === "win32" ? await fs.realpath(tmpdir()) : tmpdir();
const fixtureRoots: string[] = [];
const retainedFixtureRoots = new Set<string>();
const fixtureAuditScopes = new Map<string, { root: string; launcherPath: string; stableRuntimePath: string; bootstrapRoot: string; wrapperPath?: string }>();
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

after(async () => {
  if (process.platform !== "win32" || fixtureRoots.length === 0) {
    assert.equal(retainedFixtureRoots.size, 0,
      `uncontrolled fixture process identities require operator review; retained roots: ${[...retainedFixtureRoots].join(", ")}`);
    return;
  }
  const canonicalParent = path.resolve(temporaryParent).replace(/[\\/]$/u, "") + path.sep;
  for (const fixtureRoot of fixtureRoots) {
    if (retainedFixtureRoots.has(fixtureRoot)) continue;
    const scope = fixtureAuditScopes.get(fixtureRoot);
    const finalAudit = scope ? await auditFixture(scope) : null;
    if (!finalAudit?.safe || !finalAudit.querySucceeded || finalAudit.remaining.length || finalAudit.uncertainties.length) {
      retainedFixtureRoots.add(fixtureRoot);
      await fs.writeFile(path.join(fixtureRoot, "final-process-audit.json"), JSON.stringify(finalAudit, null, 2), "utf8");
      continue;
    }
    const canonicalTarget = path.resolve(fixtureRoot);
    assert.ok(canonicalTarget.toLowerCase().startsWith(canonicalParent.toLowerCase()), "fixture cleanup is confined to the canonical temporary parent");
    assert.match(path.basename(canonicalTarget), /^vkodex-versioned-launcher-fixture-/u);
    await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_TARGET); $parent=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_PARENT).TrimEnd([char]92)+[char]92; if(-not $target.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notlike 'vkodex-versioned-launcher-fixture-*'){throw 'Unexpected recycle target'}; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)"],
    { windowsHide: true, timeout: 15_000, env: { ...process.env, VKODEX_TEST_RECYCLE_TARGET: canonicalTarget, VKODEX_TEST_RECYCLE_PARENT: temporaryParent } });
  }
  assert.equal(retainedFixtureRoots.size, 0,
    `uncontrolled fixture process identities require operator review; retained roots: ${[...retainedFixtureRoots].join(", ")}`);
});

async function put(root: string, relative: string, bytes: string | Buffer): Promise<void> {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
}

async function readBytes(root: string, relative: string): Promise<Buffer> {
  return fs.readFile(path.join(root, ...relative.split("/")));
}

async function makePrivatePlanFixture(options: { mutateBindingAfterFirst?: boolean; probeLauncherWrite?: boolean; stderrCompletionProbe?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(temporaryParent, "vkodex-versioned-launcher-fixture-"));
  fixtureRoots.push(root);
  const isolatedRoot = path.join(root, "private fixture with spaces – versioned launch");
  const bootstrapRoot = path.join(isolatedRoot, "trusted bootstrap");
  const artifactRoot = path.join(isolatedRoot, "versioned artifact");
  const configurationRoot = path.join(isolatedRoot, "original checkout");
  const stableRuntimePath = path.join(isolatedRoot, "stable runtime", "VKodex.exe");
  const launcherPath = path.join(bootstrapRoot, "launcher", "VKodexSupervisor.exe");
  const codeFilePath = path.join(bootstrapRoot, "scripts", "watch-windows-bridge.ps1");
  const bindingPath = path.join(isolatedRoot, "launch binding.json");
  const descriptorPath = path.join(isolatedRoot, "artifact descriptor.json");
  const resultPath = path.join(isolatedRoot, "fixture entry result.json");
  const stderrCompletionReceiptPath = path.join(isolatedRoot, "stderr completion receipt.json");
  const poisonMarker = path.join(isolatedRoot, "poison preload marker.txt");
  const nativePackage = `@openai/codex-${process.platform}-${process.arch}`;
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const nativeFolder = `${cpu}-pc-windows-msvc`;
  const nativeRelative = `node_modules/${nativePackage}/vendor/${nativeFolder}/codex/codex.exe`;
  const artifactRuntimeRelative = "runtime/VKodex.exe";
  await fs.mkdir(configurationRoot, { recursive: true });
  const poisonUrl = pathToFileURL(path.join(isolatedRoot, "poison-preload.mjs")).href;
  await fs.writeFile(path.join(configurationRoot, ".env"), `BOT_DATA_DIR=relative fixture poison\nNODE_OPTIONS=--import=${poisonUrl}\nNODE_PATH=fixture-poison\n`, "utf8");
  await put(isolatedRoot, "poison-preload.mjs", `import { appendFile } from "node:fs/promises";\nawait appendFile(${JSON.stringify(poisonMarker)}, "executed\\n");\n`);
  const launcherProbe = options.probeLauncherWrite
    ? `let launcherWriteBlocked = false; try { await writeFile(${JSON.stringify(launcherPath)}, "replacement sentinel must not be installed"); } catch { launcherWriteBlocked = true; }\nlet codeFileWriteBlocked = false; try { await appendFile(${JSON.stringify(codeFilePath)}, "# fixture write sentinel must not be installed\\n"); } catch { codeFileWriteBlocked = true; }\n`
    : "const launcherWriteBlocked = null; const codeFileWriteBlocked = null;\n";
  const bindingMutation = options.mutateBindingAfterFirst
    ? `await appendFile(${JSON.stringify(bindingPath)}, " ");\n`
    : "";
  const stderrCompletion = options.stderrCompletionProbe
    ? `await new Promise((resolve, reject) => process.stderr.write("FIXTURE_ENTRY_STDERR_SENTINEL\\n", (error) => { const normalizedError = error ?? null; if (normalizedError === null) resolve(true); else reject(normalizedError); }));\nawait new Promise((resolve) => setTimeout(resolve, 300));\nlet launcherWriteStillBlocked = false; try { await writeFile(${JSON.stringify(launcherPath)}, "late replacement sentinel must not be installed"); } catch { launcherWriteStillBlocked = true; }\nlet codeFileWriteStillBlocked = false; try { await appendFile(${JSON.stringify(codeFilePath)}, "# late fixture write sentinel must not be installed\\n"); } catch { codeFileWriteStillBlocked = true; }\nawait appendFile(${JSON.stringify(stderrCompletionReceiptPath)}, JSON.stringify({ afterStderrCallback: true, stderrWriteCallbackErrorWasNull: true, waitMs: 300, launcherWriteStillBlocked, codeFileWriteStillBlocked, intendedExitCode: 7 }) + "\\n");\nprocess.exitCode = 7;\n`
    : `process.stderr.write("FIXTURE_ENTRY_STDERR_SENTINEL\\n");\n`;
  await put(artifactRoot, "dist/src/desktop-main.js", `import { appendFile, writeFile } from "node:fs/promises";\n${launcherProbe}await appendFile(${JSON.stringify(resultPath)}, JSON.stringify({ executable: process.execPath, argv: process.argv, execArgv: process.execArgv, cwd: process.cwd(), BOT_DATA_DIR: process.env.BOT_DATA_DIR, NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH, VKODEX_RUN_ID: process.env.VKODEX_RUN_ID, launcherWriteBlocked, codeFileWriteBlocked }) + "\\n");\n${stderrCompletion}${bindingMutation}`);
  await put(artifactRoot, "dist/src/codex/native-cli.js", "throw new Error('Native CLI sentinel must never execute');\n");
  await put(artifactRoot, "scripts/run-windows-supervisor.ps1", "throw 'Artifact supervisor sentinel must never execute'\n");
  await put(artifactRoot, "scripts/watch-windows-bridge.ps1", "throw 'Artifact watchdog sentinel must never execute'\n");
  await put(artifactRoot, "scripts/VKodexSupervisor.cs", "// Artifact data only; never compile or execute this file.\n");
  await put(artifactRoot, "docs/logo.ico", "fixture-only-icon-data");
  await put(artifactRoot, "package.json", JSON.stringify({ name: "vkodex", type: "module", dependencies: { "@openai/codex-sdk": "0.160.0" } }));
  await put(artifactRoot, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {
    "": { dependencies: { "@openai/codex-sdk": "0.160.0" } },
    "node_modules/@openai/codex-sdk": { version: "0.160.0" },
    "node_modules/@openai/codex": { version: "0.160.0" },
  } }));
  await put(artifactRoot, "node_modules/@openai/codex-sdk/package.json", JSON.stringify({ name: "@openai/codex-sdk", version: "0.160.0", exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } } }));
  await put(artifactRoot, "node_modules/@openai/codex-sdk/dist/index.js", "throw new Error('SDK sentinel must never execute');\n");
  await put(artifactRoot, "node_modules/@openai/codex-sdk/dist/index.d.ts", "// Fixture-only type sentinel.\n");
  await put(artifactRoot, "node_modules/@openai/codex/package.json", JSON.stringify({ name: "@openai/codex", version: "0.160.0" }));
  await put(artifactRoot, `node_modules/${nativePackage}/package.json`, JSON.stringify({ name: nativePackage, version: `0.160.0-${process.platform}-${process.arch}` }));
  await put(artifactRoot, nativeRelative, "Native executable sentinel; must never execute.\n");
  await fs.mkdir(path.dirname(stableRuntimePath), { recursive: true });
  await fs.copyFile(process.execPath, stableRuntimePath);
  await put(artifactRoot, artifactRuntimeRelative, await fs.readFile(process.execPath));

  const compiler = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  assert.equal((await fs.stat(compiler)).isFile(), true, "the reviewed .NET Framework compiler is available");
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  const supervisorSource = fileURLToPath(new URL("../scripts/VKodexSupervisor.cs", import.meta.url));
  await execFileAsync(compiler, ["/nologo", "/target:exe", `/out:${launcherPath}`, supervisorSource], { windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 });

  const artifactSourceFiles = [
    "dist/src/desktop/deployment-plan-private.js",
    "dist/src/desktop/deployment-binding.js",
    "dist/src/desktop/deployment-artifact.js",
    "dist/src/desktop/runtime.js",
  ];
  for (const relative of artifactSourceFiles) {
    await put(bootstrapRoot, relative, await fs.readFile(fileURLToPath(new URL(`../${relative}`, import.meta.url))));
  }
  await put(bootstrapRoot, "package.json", JSON.stringify({ type: "module" }));
  for (const relative of ["scripts/run-windows-supervisor.ps1", "scripts/watch-windows-bridge.ps1"]) {
    await put(bootstrapRoot, relative, await fs.readFile(fileURLToPath(new URL(`../${relative}`, import.meta.url))));
  }

  const artifactFiles: Record<string, { size: number; sha256: string }> = {};
  const artifactRelativeFiles = [
    "dist/src/desktop-main.js", "dist/src/codex/native-cli.js", "scripts/run-windows-supervisor.ps1",
    "scripts/watch-windows-bridge.ps1", "scripts/VKodexSupervisor.cs", "docs/logo.ico", "package.json", "package-lock.json",
    "node_modules/@openai/codex-sdk/package.json", "node_modules/@openai/codex-sdk/dist/index.js",
    "node_modules/@openai/codex-sdk/dist/index.d.ts", "node_modules/@openai/codex/package.json",
    `node_modules/${nativePackage}/package.json`, nativeRelative, artifactRuntimeRelative,
  ];
  for (const relative of artifactRelativeFiles) {
    const bytes = await readBytes(artifactRoot, relative);
    artifactFiles[relative] = { size: bytes.length, sha256: sha256(bytes) };
  }
  const artifactManifest = { version: 1, sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
    node: { version: process.version, platform: process.platform, arch: process.arch, modules: process.versions.modules }, sdkVersion: "0.160.0", files: artifactFiles };
  const artifactManifestBytes = Buffer.from(JSON.stringify(artifactManifest));
  await put(artifactRoot, "artifact-manifest.json", artifactManifestBytes);
  const descriptor = { version: 1, artifactRoot, configurationRoot,
    dataDirectory: path.join(configurationRoot, "fixture data", "desktop"), manifestSha256: sha256(artifactManifestBytes) };
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  await fs.writeFile(descriptorPath, descriptorBytes);

  const bootstrapFiles: Record<string, { size: number; sha256: string }> = {};
  for (const relative of BOOTSTRAP_FILES) {
    const bytes = await readBytes(bootstrapRoot, relative);
    bootstrapFiles[relative] = { size: bytes.length, sha256: sha256(bytes) };
  }
  const bootstrapManifestBytes = Buffer.from(JSON.stringify({ version: 1, protocol: "deployment-plan-v1", files: bootstrapFiles }));
  await put(bootstrapRoot, "bootstrap-manifest.json", bootstrapManifestBytes);
  const binding = { version: 1, descriptorPath, descriptorSha256: sha256(descriptorBytes), bootstrapRoot,
    bootstrapManifestSha256: sha256(bootstrapManifestBytes), stableRuntimePath, stableRuntimeSha256: sha256(await fs.readFile(stableRuntimePath)) };
  const bindingBytes = Buffer.from(JSON.stringify(binding));
  await fs.writeFile(bindingPath, bindingBytes);

  fixtureAuditScopes.set(root, { root, launcherPath, stableRuntimePath, bootstrapRoot });
  return { root, bootstrapRoot, artifactRoot, configurationRoot, stableRuntimePath, bindingPath, launcherPath, codeFilePath,
    launcherSha256: sha256(await fs.readFile(launcherPath)), bindingSha256: sha256(bindingBytes), descriptor, resultPath,
    poisonMarker, poisonUrl, stderrCompletionReceiptPath,
    mutateBindingAfterFirst: Boolean(options.mutateBindingAfterFirst), probeLauncherWrite: Boolean(options.probeLauncherWrite),
    stderrCompletionProbe: Boolean(options.stderrCompletionProbe), retained: false, monitorInvocationCount: 0 };
}

type Fixture = Awaited<ReturnType<typeof makePrivatePlanFixture>>;
type Operation = "plan-only" | "run-once" | "supervise" | "supervise-once";
type FixtureAudit = { querySucceeded: boolean; safe: boolean; remaining: unknown[]; uncertainties: unknown[] };
type AuditScope = NonNullable<ReturnType<typeof fixtureAuditScopes.get>>;

async function naturalClose(child: ChildProcess, timeoutMs: number) {
  let stdout = "", stderr = "", overflow = false;
  const capture = (channel: "stdout" | "stderr", chunk: string) => {
    const old = channel === "stdout" ? stdout : stderr;
    if (old.length + chunk.length > 16384) overflow = true;
    const next = (old + chunk).slice(0, 16384);
    if (channel === "stdout") stdout = next; else stderr = next;
  };
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => capture("stdout", chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => capture("stderr", chunk));
  let timer: NodeJS.Timeout | undefined;
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timeout: boolean; error: string }>((resolve) => {
    child.once("error", error => resolve({ code: null, signal: null, timeout: false, error: String(error) }));
    child.once("close", (code, signal) => resolve({ code, signal, timeout: false, error: "" }));
    timer = setTimeout(() => resolve({ code: null, signal: null, timeout: true, error: "natural close deadline elapsed; no signal sent" }), timeoutMs);
  });
  if (timer) clearTimeout(timer);
  if (result.timeout) {
    child.unref();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  return { ...result, stdout, stderr, overflow };
}

async function auditFixture(scope: AuditScope): Promise<FixtureAudit | null> {
  const powershellPath = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./windows-versioned-launcher-process-monitor.ps1", import.meta.url)),
    "-Mode", "AuditFixture", "-FixtureRoot", scope.root, "-LauncherPath", scope.launcherPath,
    "-StableRuntimePath", scope.stableRuntimePath, "-PowerShellPath", powershellPath,
    "-SupervisorPath", path.join(scope.bootstrapRoot, "scripts", "run-windows-supervisor.ps1"),
    "-WatchdogPath", path.join(scope.bootstrapRoot, "scripts", "watch-windows-bridge.ps1"),
    ...(scope.wrapperPath ? ["-WrapperPath", scope.wrapperPath] : [])];
  const helper = spawn(powershellPath, args, { windowsHide: true, shell: false });
  const result = await naturalClose(helper, 12000);
  if (result.code !== 0 || result.signal !== null || result.timeout || result.error || result.stderr || result.overflow) return null;
  try {
    const audit = JSON.parse(result.stdout.trim()) as FixtureAudit | null;
    return audit && typeof audit.querySucceeded === "boolean" && typeof audit.safe === "boolean"
      && Array.isArray(audit.remaining) && Array.isArray(audit.uncertainties) ? audit : null;
  } catch { return null; }
}

async function runLauncher(fixture: Fixture, operation: Operation, options: { expectedSha256?: string; expectedExitCode?: 0 | 7 | 86 } = {}) {
  assert.equal(operation, "plan-only");
  return runObservedLauncher(fixture, operation, options);
}

async function runObservedLauncher(fixture: Fixture, operation: Operation,
  options: { cp866Parent?: boolean; expectedSha256?: string; expectedExitCode?: 0 | 7 | 86 } = {}) {
  const suffix = "run-" + String(++fixture.monitorInvocationCount).padStart(2, "0");
  const launcherPath = fixture.launcherPath;
  const powershellPath = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const wrapperPath = options.cp866Parent ? path.join(fixture.root, "cp866-supervise-once-wrapper.ps1") : null;
  const encodingReportPath = path.join(fixture.root, "cp866-console-encoding.json");
  if (wrapperPath) {
    assert.equal(operation, "supervise-once", "the encoding wrapper has one fixed, bounded fixture operation");
    await fs.writeFile(wrapperPath, [
      "$ErrorActionPreference = 'Stop'",
      "$encoding = [System.Text.Encoding]::GetEncoding(866)",
      "[Console]::OutputEncoding = $encoding",
      "$OutputEncoding = $encoding",
      "$utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)",
      "$record = @{ consoleOutputCodePage = [Console]::OutputEncoding.CodePage; outputEncodingCodePage = $OutputEncoding.CodePage; wrapperPid = $PID } | ConvertTo-Json -Compress",
      "[IO.File]::WriteAllText($env:VKODEX_TEST_ENCODING_REPORT, $record, $utf8)",
      "$start = New-Object System.Diagnostics.ProcessStartInfo",
      "$start.FileName = $env:VKODEX_TEST_LAUNCHER",
      "$start.Arguments = '--launch-binding \"' + $env:VKODEX_TEST_BINDING + '\" --launch-binding-sha256 ' + $env:VKODEX_TEST_BINDING_SHA256 + ' --operation supervise-once'",
      "$start.WorkingDirectory = $env:VKODEX_TEST_CWD",
      "$start.UseShellExecute = $false",
      "$start.CreateNoWindow = $true",
      "$process = New-Object System.Diagnostics.Process",
      "$process.StartInfo = $start",
      "if (-not $process.Start()) { exit 86 }",
      "$process.WaitForExit()",
      "exit $process.ExitCode",
      "",
    ].join("\n"), "utf8");
  }
  const scope = { root: fixture.root, launcherPath, stableRuntimePath: fixture.stableRuntimePath, bootstrapRoot: fixture.bootstrapRoot,
    ...(wrapperPath ? { wrapperPath } : {}) };
  fixtureAuditScopes.set(fixture.root, scope);
  const args = wrapperPath
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapperPath]
    : ["--launch-binding", fixture.bindingPath, "--launch-binding-sha256", options.expectedSha256 ?? fixture.bindingSha256, "--operation", operation];
  const child = spawn(wrapperPath ? powershellPath : launcherPath, args, {
    cwd: fixture.configurationRoot, shell: false, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "--import=" + fixture.poisonUrl, NODE_PATH: "fixture-inherited-poison",
      ...(wrapperPath ? { VKODEX_TEST_LAUNCHER: launcherPath, VKODEX_TEST_BINDING: fixture.bindingPath,
        VKODEX_TEST_BINDING_SHA256: fixture.bindingSha256, VKODEX_TEST_CWD: fixture.configurationRoot,
        VKODEX_TEST_ENCODING_REPORT: encodingReportPath } : {}) },
  });
  const result = await naturalClose(child, 60000);
  const expectedCode = options.expectedExitCode ?? (operation === "supervise" ? 86 : fixture.stderrCompletionProbe ? 7 : 0);
  const audit = result.timeout || result.error ? null : await auditFixture(scope);
  const safe = result.code === expectedCode && result.signal === null && !result.timeout && !result.error && !result.overflow
    && audit?.querySucceeded === true && audit.safe === true && audit.remaining.length === 0 && audit.uncertainties.length === 0;
  if (!safe) {
    fixture.retained = true;
    retainedFixtureRoots.add(fixture.root);
  }
  await fs.writeFile(path.join(fixture.root, "natural-exit-audit-" + suffix + ".json"), JSON.stringify({
    status: safe ? "natural-close-and-resource-audit-clear" : "retained-no-signal",
    operation, expectedCode, pid: child.pid ?? null, executable: wrapperPath ? powershellPath : launcherPath,
    ...result, audit,
  }, null, 2), "utf8");
  return { ...result, audit, retainedFixture: fixture.retained ? fixture.root : null };
}
async function assertNoFixtureExecution(fixture: Fixture) {
  assert.equal(await fs.access(fixture.resultPath).then(() => true, () => false), false, "no fake artifact entry was launched");
  assert.equal(await fs.access(fixture.poisonMarker).then(() => true, () => false), false, "no poisoned Node preload executed");
}

async function assertFixtureInvocation(fixture: Fixture, expectedCount: number) {
  const text = await fs.readFile(fixture.resultPath, "utf8");
  const records = text.trim().split(/\r?\n/u);
  assert.equal(records.length, expectedCount, "the harmless artifact entry ran only the requested number of times");
  const observedRecords: Record<string, unknown>[] = [];
  for (const line of records) {
    const observed = JSON.parse(line) as Record<string, unknown>;
    observedRecords.push(observed);
    assert.equal(String(observed.executable).toLowerCase(), fixture.stableRuntimePath.toLowerCase(), "the pinned private Node path executed");
    assert.deepEqual(observed.argv, [fixture.stableRuntimePath, path.join(fixture.artifactRoot, "dist", "src", "desktop-main.js")]);
    assert.ok(Array.isArray(observed.execArgv) && observed.execArgv.includes(`--env-file=${path.join(fixture.configurationRoot, ".env")}`));
    assert.equal(observed.cwd, fixture.configurationRoot);
    assert.equal(observed.BOT_DATA_DIR, fixture.descriptor.dataDirectory);
    assert.equal(observed.NODE_OPTIONS, "");
    assert.equal(observed.NODE_PATH, "");
    assert.match(String(observed.VKODEX_RUN_ID), /^\d{8}-\d{9}-[a-f0-9]{8}$/u, "each bridge invocation receives the exact compact hexadecimal run-ID grammar");
    if (fixture.probeLauncherWrite) {
      assert.equal(observed.launcherWriteBlocked, true, "pinned launcher remains nonwritable while bridge executes");
      assert.equal(observed.codeFileWriteBlocked, true, "pinned bootstrap code remains nonwritable while bridge executes");
    }
  }
  await assertNoPoisonExecution(fixture);
  return observedRecords;
}

async function assertNoPoisonExecution(fixture: Fixture) {
  assert.equal(await fs.access(fixture.poisonMarker).then(() => true, () => false), false, "inherited and .env Node hooks never execute");
}

function planRecord(stdout: string) {
  const records = stdout.trim().split(/\r?\n/u);
  assert.equal(records.length, 1, "the launcher emits exactly one private plan record");
  return JSON.parse(records[0]!) as Record<string, unknown>;
}

async function makePrivateDiagnosticRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(temporaryParent, "vkodex-versioned-launcher-fixture-diagnostic-"));
  fixtureRoots.push(root);
  return root;
}

const pinnedPlanMockLeaf = [
  "$ErrorActionPreference = 'Stop'",
  "$sourcePath = $env:VKODEX_TEST_SUPERVISOR_SOURCE",
  "$tokens = $null; $parseErrors = $null",
  "$sourceAst = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)",
  "if ($parseErrors.Count -gt 0) { throw 'Production supervisor source did not parse.' }",
  "$functionAst = $sourceAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-PinnedLauncher' }, $true)",
  "if ($null -eq $functionAst) { throw 'Production Invoke-PinnedLauncher function was not found.' }",
  ". ([scriptblock]::Create($functionAst.Extent.Text))",
  "$script:waitCalls = New-Object System.Collections.ArrayList",
  "$script:unboundedWaitCalls = 0; $script:killCalls = 0; $script:disposed = $false",
  "$script:firstWaitReturns = $env:VKODEX_TEST_CASE -eq 'pipes'",
  "$script:secondWaitReturns = $false",
  "$stdoutSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[string]'",
  "$stderrSource = New-Object 'System.Threading.Tasks.TaskCompletionSource[string]'",
  "$stdoutReader = [pscustomobject]@{ completion = $stdoutSource }",
  "$stderrReader = [pscustomobject]@{ completion = $stderrSource }",
  "$stdoutReader | Add-Member -MemberType ScriptMethod -Name ReadToEndAsync -Value { return $this.completion.Task }",
  "$stderrReader | Add-Member -MemberType ScriptMethod -Name ReadToEndAsync -Value { return $this.completion.Task }",
  "$script:fakeProcess = [pscustomobject]@{ StartInfo = $null; StandardOutput = $stdoutReader; StandardError = $stderrReader; ExitCode = 0; HasExited = $true }",
  "$script:fakeProcess | Add-Member -MemberType ScriptMethod -Name Start -Value { return $true }",
  "$script:fakeProcess | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { if ($args.Count -eq 0) { $script:unboundedWaitCalls++; return $true }; $timeout = [int]$args[0]; [void]$script:waitCalls.Add($timeout); if ($timeout -eq 35000) { return $script:firstWaitReturns }; if ($timeout -eq 2000) { return $script:secondWaitReturns }; return $false }",
  "$script:fakeProcess | Add-Member -MemberType ScriptMethod -Name Kill -Value { $script:killCalls++; if ($env:VKODEX_TEST_CASE -eq 'timeout') { throw 'synthetic owned-plan kill failure' } }",
  "$script:fakeProcess | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposed = $true }",
  "function New-Object {",
  "  [CmdletBinding()] param([Parameter(Position=0)][string]$TypeName, [object[]]$ArgumentList)",
  "  if ($TypeName -eq 'System.Diagnostics.Process') { return $script:fakeProcess }",
  "  if ($PSBoundParameters.ContainsKey('ArgumentList')) { return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList }",
  "  return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName",
  "}",
  "$launcherBytes = [IO.File]::ReadAllBytes($env:VKODEX_TEST_LAUNCHER_FILE)",
  "$algorithm = [Security.Cryptography.SHA256]::Create()",
  "try { $script:LauncherSha256 = ([BitConverter]::ToString($algorithm.ComputeHash($launcherBytes))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }",
  "$script:LaunchBindingSha256 = 'b' * 64",
  "$script:canonicalLauncher = [IO.Path]::GetFullPath($env:VKODEX_TEST_LAUNCHER_FILE)",
  "$script:canonicalBinding = [IO.Path]::GetFullPath($env:VKODEX_TEST_BINDING_FILE)",
  "$script:startupVariables = @()",
  "$started = [DateTime]::UtcNow",
  "$result = Invoke-PinnedLauncher 'plan-only' -CapturePlan -WorkingDirectory $env:VKODEX_TEST_CWD",
  "$elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds",
  "$report = [pscustomobject]@{ exitCode=[int]$result.ExitCode; waitCalls=@($script:waitCalls.ToArray()); unboundedWaitCalls=$script:unboundedWaitCalls; killCalls=$script:killCalls; disposed=$script:disposed; stdoutPending=(-not $stdoutSource.Task.IsCompleted); stderrPending=(-not $stderrSource.Task.IsCompleted); elapsedMs=$elapsedMs }",
  "[Console]::Out.WriteLine(($report | ConvertTo-Json -Compress))",
].join("\n");

async function runPinnedPlanTimeoutMock(testCase: "timeout" | "pipes") {
  const root = await makePrivateDiagnosticRoot();
  const launcherPath = path.join(root, "private harmless launcher.exe");
  const bindingPath = path.join(root, "private binding.json");
  const cwd = path.join(root, "private cwd");
  const leafPath = path.join(root, "invoke-production-plan-function.ps1");
  await fs.writeFile(launcherPath, "private non-executable bytes for hash validation\n", "utf8");
  await fs.writeFile(bindingPath, "{}\n", "utf8");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(leafPath, pinnedPlanMockLeaf, "utf8");
  const powershellPath = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const scope = { root, launcherPath, stableRuntimePath: path.join(root, "unused-fixture-runtime.exe"),
    bootstrapRoot: root, wrapperPath: leafPath };
  fixtureAuditScopes.set(root, scope);
  const startedAt = Date.now();
  const helper = spawn(powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", leafPath], {
    windowsHide: true, shell: false,
    env: { ...process.env, VKODEX_TEST_CASE: testCase, VKODEX_TEST_SUPERVISOR_SOURCE: fileURLToPath(new URL("../scripts/run-windows-supervisor.ps1", import.meta.url)),
      VKODEX_TEST_LAUNCHER_FILE: launcherPath, VKODEX_TEST_BINDING_FILE: bindingPath, VKODEX_TEST_CWD: cwd },
  });
  const result = await naturalClose(helper, 12000);
  const audit = result.timeout || result.error ? null : await auditFixture(scope);
  const safe = result.code === 0 && result.signal === null && !result.timeout && !result.error && !result.overflow
    && audit?.querySucceeded === true && audit.safe && audit.remaining.length === 0 && audit.uncertainties.length === 0;
  if (!safe) retainedFixtureRoots.add(root);
  await fs.writeFile(path.join(root, "mock-natural-exit-audit.json"), JSON.stringify({ ...result, audit, safe }, null, 2), "utf8");
  assert.ok(safe, "the real mock helper exits naturally and leaves no live fixture path; uncertainty retains its root");
  const report = JSON.parse(result.stdout.trim()) as { exitCode: number; waitCalls: number[]; unboundedWaitCalls: number; killCalls: number; disposed: boolean; stdoutPending: boolean; stderrPending: boolean; elapsedMs: number };
  return { report, wallMs: Date.now() - startedAt, stderr: result.stderr };
}

test("private plan cleanup stays bounded after failed kill or inherited pending pipes", { skip: process.platform !== "win32", timeout: 30_000 }, async t => {
  for (const testCase of ["timeout", "pipes"] as const) await t.test(testCase, async () => {
    const result = await runPinnedPlanTimeoutMock(testCase);
    assert.equal(result.stderr, "");
    assert.equal(result.report.exitCode, 86, "an uncertain plan is refused rather than used to launch a bridge");
    assert.deepEqual(result.report.waitCalls, testCase === "timeout" ? [35000, 2000] : [35000]);
    assert.equal(result.report.unboundedWaitCalls, 0, "capture cleanup never invokes an unbounded process wait");
    assert.equal(result.report.killCalls, testCase === "timeout" ? 1 : 0);
    assert.equal(result.report.disposed, true);
    assert.equal(result.report.stdoutPending, true);
    assert.equal(result.report.stderrPending, true, "pending streams do not trigger an unbounded GetResult");
    assert.ok(result.report.elapsedMs < 8000, "the actual extracted production function returns within its cleanup bound");
    if (testCase === "pipes") assert.ok(result.report.elapsedMs >= 1500, "the pending-pipe case exercises the timed task wait");
  });
});

test("compiled Windows supervisor validates a pinned private launch plan in plan-only mode", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture();
  const result = await runLauncher(fixture, "plan-only");

  assert.equal(result.code, 0, `plan-only must succeed; exit=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`);
  assert.equal(result.stderr, "", "private validation errors do not expose raw diagnostics");
  const plan = planRecord(result.stdout);
  assert.equal(plan.version, 1);
  assert.equal(plan.protocol, "deployment-plan-v1");
  assert.equal(plan.status, "validated_not_launched");
  assert.equal(plan.executable, fixture.stableRuntimePath);
  assert.equal(plan.entryPoint, path.join(fixture.artifactRoot, "dist", "src", "desktop-main.js"));
  assert.equal(plan.cwd, fixture.configurationRoot);
  assert.equal(plan.environmentFile, path.join(fixture.configurationRoot, ".env"));
  assert.deepEqual(plan.arguments, [`--env-file=${path.join(fixture.configurationRoot, ".env")}`, path.join(fixture.artifactRoot, "dist", "src", "desktop-main.js")]);
  assert.deepEqual(plan.environmentOverrides, { BOT_DATA_DIR: fixture.descriptor.dataDirectory, NODE_OPTIONS: "", NODE_PATH: "" });
  assert.equal(plan.bindingSha256, fixture.bindingSha256);
  assert.equal(plan.runtimeSha256, sha256(await fs.readFile(fixture.stableRuntimePath)));
  assert.equal(plan.launcherSha256, fixture.launcherSha256);
  await assertNoFixtureExecution(fixture);
});

test("pinned run-once launches only the harmless artifact entry with selected absolute paths and sanitized environment", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture();
  for (let run = 0; run < 2; run++) {
    const result = await runObservedLauncher(fixture, "run-once");
    assert.equal(result.code, 0, `run-once #${run + 1} must succeed; exit=${result.code}; stderr=${result.stderr}`);
    assert.equal(result.stdout.length <= 8 * 1024, true, "private output stays bounded");
    assert.equal(result.stderr.length <= 8 * 1024, true, "diagnostic output stays bounded");
  }
  const invocations = await assertFixtureInvocation(fixture, 2);
  const runIds = invocations.map((record) => String(record.VKODEX_RUN_ID));
  assert.equal(new Set(runIds).size, 2, "sequential launches receive distinct run IDs");
  const logPaths = runIds.map((id) => desktopLogPath(fixture.descriptor.dataDirectory, { VKODEX_RUN_ID: id }));
  assert.ok(logPaths.every((logPath, index) => path.basename(logPath) === `vkodex-${runIds[index]}.log`));
  assert.equal(new Set(logPaths).size, 2, "each recorded run ID maps to its own versioned log path");
});

test("pinned supervise-once performs one harmless iteration without starting an ongoing supervisor", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture();
  const result = await runObservedLauncher(fixture, "supervise-once", { cp866Parent: true });
  assert.equal(result.code, 0, `supervise-once must succeed; exit=${result.code}; stderr=${result.stderr}`);
  assert.equal(result.stdout.length <= 8 * 1024, true, "private output stays bounded");
  assert.equal(result.stderr.length <= 8 * 1024, true, "diagnostic output stays bounded");
  const encodingRecord = JSON.parse(await fs.readFile(path.join(fixture.root, "cp866-console-encoding.json"), "utf8")) as Record<string, unknown>;
  assert.equal(encodingRecord.consoleOutputCodePage, 866, "the owning Windows PowerShell parent used its explicitly selected CP866 console encoding");
  assert.equal(encodingRecord.outputEncodingCodePage, 866);
  await assertFixtureInvocation(fixture, 1);
  const supervisorLog = await fs.readFile(path.join(fixture.descriptor.dataDirectory, "logs", "supervisor.log"), "utf8");
  assert.match(supervisorLog, /Bounded versioned run-once completed/iu, "the bounded run records its completed single iteration");
  assert.doesNotMatch(supervisorLog, /watchdog started/iu, "bounded fixture supervision must not start the watchdog");
  assert.doesNotMatch(supervisorLog, /restarting in/iu, "bounded fixture supervision must not enter the restart loop");
});

test("supervise revalidates the original binding before a second iteration and stops without retry", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture({ mutateBindingAfterFirst: true });
  const originalBinding = await fs.readFile(fixture.bindingPath);
  const result = await runObservedLauncher(fixture, "supervise");
  assert.equal(result.code, 86, `a changed binding pin must stop the supervisor; exit=${result.code}; stderr=${result.stderr}; monitor=${JSON.stringify(result.audit)}; monitorError=${result.error}`);
  await assertFixtureInvocation(fixture, 1);
  assert.notDeepEqual(await fs.readFile(fixture.bindingPath), originalBinding, "the harmless first fixture iteration changed only its private binding fixture");
  const supervisorLog = await fs.readFile(path.join(fixture.descriptor.dataDirectory, "logs", "supervisor.log"), "utf8");
  const firstExit = supervisorLog.indexOf("Versioned run exited with code 0; retrying after the configured delay.");
  const refused = supervisorLog.indexOf("Versioned launch validation refused; supervision stopped without retry.");
  assert.ok(firstExit >= 0 && refused > firstExit, "one successful first iteration is followed by refusal of the changed original binding");
  assert.equal(supervisorLog.indexOf("retrying after the configured delay", refused), -1, "refusal stops without another retry");
});

test("wrong external binding pin refuses before artifact execution", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture();
  const result = await runLauncher(fixture, "plan-only", { expectedSha256: "0".repeat(64), expectedExitCode: 86 });
  assert.equal(result.code, 86);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.length <= 8 * 1024);
  await assertNoFixtureExecution(fixture);
});

test("changed bootstrap or stable runtime refuses before artifact execution", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  for (const changed of ["bootstrap", "runtime"] as const) {
    const fixture = await makePrivatePlanFixture();
    const target = changed === "bootstrap"
      ? path.join(fixture.bootstrapRoot, "scripts", "run-windows-supervisor.ps1")
      : fixture.stableRuntimePath;
    await fs.appendFile(target, "fixture mutation after pin\n");
    const result = await runLauncher(fixture, "plan-only", { expectedExitCode: 86 });
    assert.equal(result.code, 86, `${changed} mutation must be refused`);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length <= 8 * 1024);
    await assertNoFixtureExecution(fixture);
  }
});

test("escaped duplicate binding keys refuse even with the supplied byte hash updated", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture();
  const original = await fs.readFile(fixture.bindingPath, "utf8");
  const duplicate = original.replace("{\"version\":1,", "{\"version\":1,\"vers\\u0069on\":1,");
  assert.notEqual(duplicate, original, "the serialized fixture binding has the expected leading key");
  await fs.writeFile(fixture.bindingPath, duplicate, "utf8");
  const result = await runLauncher(fixture, "plan-only", { expectedSha256: sha256(duplicate), expectedExitCode: 86 });
  assert.equal(result.code, 86);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.length <= 8 * 1024);
  await assertNoFixtureExecution(fixture);
});

test("trusted TypeScript launch validation refuses a newly added launcher config before artifact execution", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture();
  await fs.writeFile(`${fixture.launcherPath}.config`, "<configuration />\n", "utf8");
  await assert.rejects(executeDeployment(fixture.bindingPath, fixture.bindingSha256, "plan-only"));
  await assertNoFixtureExecution(fixture);
});

test("pinned run-once holds the launcher against artifact writes", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture({ probeLauncherWrite: true });
  const originalLauncherSha256 = sha256(await fs.readFile(fixture.launcherPath));
  const originalCodeFileSha256 = sha256(await fs.readFile(fixture.codeFilePath));
  const result = await runObservedLauncher(fixture, "run-once");
  assert.equal(result.code, 0, `run-once must succeed; exit=${result.code}; stderr=${result.stderr}`);
  assert.equal(sha256(await fs.readFile(fixture.launcherPath)), originalLauncherSha256, "artifact code cannot replace the pinned launcher");
  assert.equal(sha256(await fs.readFile(fixture.codeFilePath)), originalCodeFileSha256, "artifact code cannot alter a pinned bootstrap script");
  await assertFixtureInvocation(fixture, 1);
});

test("supervise-once waits for a stderr flush and post-stderr completion before returning exit code 7", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const fixture = await makePrivatePlanFixture({ probeLauncherWrite: true, stderrCompletionProbe: true });
  const originalLauncherSha256 = sha256(await fs.readFile(fixture.launcherPath));
  const originalCodeFileSha256 = sha256(await fs.readFile(fixture.codeFilePath));
  const result = await runObservedLauncher(fixture, "supervise-once");
  assert.equal(result.code, 7, `the wrapper must wait for the child exit after the stderr callback and receipt; exit=${result.code}; stderr=${result.stderr}; monitor=${JSON.stringify(result.audit)}`);
  assert.equal(result.stderr.length <= 8 * 1024, true, "diagnostic output remains bounded without assuming stderr is relayed");
  await assertFixtureInvocation(fixture, 1);
  const receipt = JSON.parse(await fs.readFile(fixture.stderrCompletionReceiptPath, "utf8")) as Record<string, unknown>;
  assert.equal(receipt.afterStderrCallback, true);
  assert.equal(receipt.stderrWriteCallbackErrorWasNull, true, "the stderr write callback completed without an error before the delayed receipt");
  assert.equal(receipt.waitMs, 300);
  assert.equal(receipt.launcherWriteStillBlocked, true, "the launcher remains nonwritable after the stderr delay");
  assert.equal(receipt.codeFileWriteStillBlocked, true, "the ordinary bootstrap script remains nonwritable after the stderr delay");
  assert.equal(receipt.intendedExitCode, 7);
  assert.equal(sha256(await fs.readFile(fixture.launcherPath)), originalLauncherSha256, "the launcher stays held against writes for the entire child lifetime");
  assert.equal(sha256(await fs.readFile(fixture.codeFilePath)), originalCodeFileSha256, "the bootstrap script stays held against writes for the entire child lifetime");
  const supervisorLog = await fs.readFile(path.join(fixture.descriptor.dataDirectory, "logs", "supervisor.log"), "utf8");
  assert.match(supervisorLog, /Bounded versioned run-once completed with exit code 7\./u);
  assert.doesNotMatch(supervisorLog, /watchdog started/iu);
  assert.doesNotMatch(supervisorLog, /restarting in/iu);
});
