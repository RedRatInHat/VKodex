import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approveTaskPolicy, assertApprovedResumeIntent, type ApprovedTaskPolicy } from "../codex/managed-task-policy.js";
import { assertWindowsPrivateDirectory, assertWindowsPrivateDirectoryAfterAcl } from "./windows-private-directory.js";



const MAX_PROTECTED_BYTES = 64 * 1024;
const POWERSHELL_TIMEOUT_MS = 10_000;
const STATE_FILE = "state.v1.dpapi";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

export interface ManagedWorkerPrivateManifest {
  readonly schemaVersion: 1;
  readonly epoch: string;
  readonly taskId: string;
  readonly familyRoot: string;
  readonly home: string;
  readonly cwd: string;
  readonly cliPath: string;
  readonly cliSha256: string;
  readonly initializeRequest: JsonObject;
  readonly resumeParams: JsonObject;
  readonly approvedTaskPolicy?: ApprovedTaskPolicy;
  readonly registryPath: string;
}

export interface ManagedWorkerPrivateKeyBundle {
  readonly fingerprintKey: string;
  readonly intentKey: string;
  readonly controlToken: string;
}

export interface ManagedWorkerPrivateState {
  readonly manifest: ManagedWorkerPrivateManifest;
  readonly keys: ManagedWorkerPrivateKeyBundle;
  /** Derived only from trusted baseDirectory and manifest.epoch; never persisted in the payload. */
  readonly privateDirectory: string;
}

export interface ManagedWorkerPrivateStateProtector {
  protect(plaintext: Uint8Array): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** Injectable only for private-state protection tests; never a daemon control channel. */
export interface ManagedWorkerPrivateStatePowerShellRunner {
  run(script: string, input: Uint8Array): Promise<Uint8Array>;
}

export interface ManagedWorkerPrivateStateFilesystem {
  ensureProtectedDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, bytes: Uint8Array): Promise<void>;
  readProtectedFile(filePath: string): Promise<Uint8Array>;
}

export interface CreateManagedWorkerPrivateStateOptions {
  readonly baseDirectory: string;
  readonly protector?: ManagedWorkerPrivateStateProtector;
  readonly filesystem?: ManagedWorkerPrivateStateFilesystem;
  readonly powerShellRunner?: ManagedWorkerPrivateStatePowerShellRunner;
}

export interface LoadManagedWorkerPrivateStateOptions extends CreateManagedWorkerPrivateStateOptions {
  readonly epoch: string;
}

function fail(): never { throw new Error("Invalid managed worker private state"); }
function bounded(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function absolute(value: unknown): string {
  const text = bounded(value, 4096);
  if (!(process.platform === "win32" ? path.win32.isAbsolute(text) : path.isAbsolute(text))) fail();
  return text;
}
function json(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return value; }
  if (Array.isArray(value)) return Object.freeze(value.map(json));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/u.test(key)) fail();
      Object.defineProperty(result, key, { value: json(nested), enumerable: true, writable: true, configurable: true });
    }
    return Object.freeze(result);
  }
  fail();
}
function object(value: unknown): JsonObject {
  const checked = json(value);
  if (checked === null || Array.isArray(checked) || typeof checked !== "object") fail();
  return checked as JsonObject;
}
function exactKey(value: unknown): string {
  const encoded = bounded(value, 128);
  let decoded: Buffer;
  try { decoded = Buffer.from(encoded, "base64"); } catch { fail(); }
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== encoded) fail();
  return encoded;
}
function manifest(value: unknown): ManagedWorkerPrivateManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const item = value as Record<string, unknown>;
  const legacyKeys = ["schemaVersion", "epoch", "taskId", "familyRoot", "home", "cwd", "cliPath",
    "cliSha256", "initializeRequest", "resumeParams", "registryPath"];
  const withPolicy = Object.hasOwn(item, "approvedTaskPolicy");
  const expected = withPolicy ? [...legacyKeys, "approvedTaskPolicy"] : legacyKeys;
  if (Object.keys(item).length !== expected.length || expected.some(key => !Object.hasOwn(item, key)) ||
    item.schemaVersion !== 1) fail();
  const epoch = bounded(item.epoch, 36); if (!UUID.test(epoch)) fail();
  const cliSha256 = bounded(item.cliSha256, 64); if (!SHA256.test(cliSha256)) fail();
  const taskId = bounded(item.taskId, 256), cwd = absolute(item.cwd);
  const resumeParams = object(item.resumeParams);
  let approvedTaskPolicy: ApprovedTaskPolicy | undefined;
  if (withPolicy) {
    try {
      approvedTaskPolicy = approveTaskPolicy(item.approvedTaskPolicy);
      assertApprovedResumeIntent(approvedTaskPolicy, resumeParams, taskId, cwd);
    } catch { fail(); }
  }
  return Object.freeze({ schemaVersion: 1, epoch, taskId: bounded(item.taskId, 256), familyRoot: bounded(item.familyRoot, 256),
    home: absolute(item.home), cwd, cliPath: absolute(item.cliPath), cliSha256: cliSha256.toLowerCase(),
    initializeRequest: object(item.initializeRequest), resumeParams, registryPath: absolute(item.registryPath),
    ...(approvedTaskPolicy ? { approvedTaskPolicy } : {}) });
}
function keyBundle(value: unknown): ManagedWorkerPrivateKeyBundle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3) fail();
  return Object.freeze({ fingerprintKey: exactKey(item.fingerprintKey), intentKey: exactKey(item.intentKey), controlToken: exactKey(item.controlToken) });
}
function state(value: unknown, baseDirectory: string, expectedEpoch: string): ManagedWorkerPrivateState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 2) fail();
  const checkedManifest = manifest(item.manifest);
  if (checkedManifest.epoch !== expectedEpoch) fail();
  return Object.freeze({ manifest: checkedManifest, keys: keyBundle(item.keys), privateDirectory: privateDirectory(baseDirectory, expectedEpoch) });
}
function privateDirectory(baseDirectory: string, epoch: string): string {
  return path.join(absolute(baseDirectory), epoch);
}
function privateStateFile(baseDirectory: string, epoch: string): string {
  return path.join(privateDirectory(baseDirectory, epoch), STATE_FILE);
}


const ps = (command: string): string => Buffer.from(command, "utf16le").toString("base64");
function windowsPowerShell(): string {
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) throw new Error("Managed worker private state requires Windows PowerShell");
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
async function runPowerShell(encoded: string, input: Uint8Array, requireCompleteInput = false): Promise<Uint8Array> {
  const executable = windowsPowerShell();
  const modulePath = path.win32.join(path.dirname(executable), "Modules");
  const command = requireCompleteInput ? `$expected=${input.byteLength};${encoded}` : encoded;
  const payload = Buffer.from(input);
  const inputHash = createHash("sha256").update(payload).digest();
  const encodedCommand = ps(command);
  const commandHash = createHash("sha256").update(encodedCommand, "utf8").digest();
  input.fill(0);
  let helper: ReturnType<typeof spawn>;
  try {
    // tsx may expose a .js import.meta.url while resolving the module from
    // src/*.ts. Detect the physical source sibling instead of the URL suffix.
    const sourceHelper = fileURLToPath(new URL("./managed-worker-powershell-worker.ts", import.meta.url));
    const sourceMode = existsSync(sourceHelper);
    const helperPath = fileURLToPath(new URL(sourceMode ? "../../dist/src/desktop/managed-worker-powershell-worker.js" :
      "./managed-worker-powershell-worker.js", import.meta.url));
    if (sourceMode) {
      const built = statSync(helperPath), source = statSync(sourceHelper);
      if (!built.isFile() || built.mtimeMs < source.mtimeMs)
        throw new Error("Protected helper build is unavailable or stale");
    }
    helper = spawn(process.execPath, [helperPath], {
      serialization: "advanced", windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, PSModulePath: modulePath },
    });
  } catch {
    payload.fill(0); inputHash.fill(0); commandHash.fill(0);
    throw new Error("Managed worker private state protection failed", { cause: { phase: "spawn-throw" } });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (result?: Uint8Array, phase = "unclassified"): void => {
      if (settled) return;
      settled = true; clearTimeout(timeout); payload.fill(0); inputHash.fill(0); commandHash.fill(0);
      if (result) resolve(result);
      else reject(new Error("Managed worker private state protection failed", { cause: { phase } }));
    };
    const timeout = setTimeout(() => {
      try { helper.kill(); } catch { /* best-effort containment */ }
      settle(undefined, "timeout");
    }, POWERSHELL_TIMEOUT_MS + 3_000);
    helper.once("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("ok" in message)) return settle();
      if (message.ok !== true) {
        const phase = "phase" in message && typeof message.phase === "string" ? message.phase : "unclassified";
        return settle(undefined, /^(?:spawn-throw|process-error|invalid-input|input-mismatch|command-mismatch|input-length|exit-(?:null|\d+)(?:-(?:empty|security|parser(?:-token|-parenthesis)?(?:-l\d{1,4}c\d{1,5})?|runtime|other))?)$/u.test(phase)
          ? phase : "unclassified");
      }
      const output = "output" in message ? message.output : null;
      if (!(output instanceof Uint8Array)) return settle(undefined, "output-limit");
      try {
        if (output.byteLength > MAX_PROTECTED_BYTES) return settle(undefined, "output-limit");
        settle(Uint8Array.from(output));
      } finally { output.fill(0); }
    });
    helper.once("error", () => settle(undefined, "process-error"));
    helper.once("close", code => { if (!settled) settle(undefined, `helper-exit-${code}`); });
    try {
      helper.send({ command: encodedCommand, input: payload, inputHash, commandHash }, error => {
        payload.fill(0); inputHash.fill(0); commandHash.fill(0);
        if (error) settle(undefined, "process-error");
      });
    } catch { settle(undefined, "process-error"); }
  });
}

const protectScript = "$ErrorActionPreference='Stop';try{Add-Type -AssemblyName System.Security}catch{exit 43};try{$raw=[Console]::In.ReadToEnd().Trim()}catch{exit 44};if($raw.Length -ne $expected){exit 42};try{$data=[Convert]::FromBase64String($raw)}catch{exit 45};try{$out=[Security.Cryptography.ProtectedData]::Protect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}catch{exit 46};try{[Console]::Out.Write([Convert]::ToBase64String($out))}catch{exit 47}";
const unprotectScript = "$ErrorActionPreference='Stop';try{Add-Type -AssemblyName System.Security}catch{exit 43};try{$raw=[Console]::In.ReadToEnd().Trim()}catch{exit 44};if($raw.Length -ne $expected){exit 42};try{$data=[Convert]::FromBase64String($raw)}catch{exit 45};try{$out=[Security.Cryptography.ProtectedData]::Unprotect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}catch{exit 46};try{[Console]::Out.Write([Convert]::ToBase64String($out))}catch{exit 47}";
const aclScript = [
  "$ErrorActionPreference='Stop'",
  "$p=[Console]::In.ReadToEnd().Trim()",
  "if(!$p){throw 'path'}",
  "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
  "$acl=[Security.AccessControl.DirectorySecurity]::new()",
  "$acl.SetOwner($sid)",
  "$acl.SetAccessRuleProtection($true,$false)",
  "foreach($id in @($sid,$system)){",
  "$rule=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
  "$acl.AddAccessRule($rule)",
  "}",
  "[IO.Directory]::CreateDirectory($p,$acl)|Out-Null",
  "$d=[IO.DirectoryInfo]::new($p)",
  "if(($d.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'reparse'}",
  "$before=[IO.Directory]::GetAccessControl($p)",
  "$beforeOwner=$before.GetOwner([Security.Principal.SecurityIdentifier])",
  "$actualOwner=$beforeOwner.Value",
  "$expectedOwner=$sid.Value",
  "if($actualOwner -ne $expectedOwner){exit 48}",
  "[IO.Directory]::SetAccessControl($p,$acl)",
  "$check=[IO.DirectoryInfo]::new($p)",
  "if(($check.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'reparse'}",
].join(";");

function safeProtectionPhase(error: unknown): string {
  if (!(error instanceof Error) || !error.cause || typeof error.cause !== "object" ||
    !("phase" in error.cause) || typeof error.cause.phase !== "string") return "unclassified";
  const phase = error.cause.phase;
  return /^(?:timeout|spawn-throw|process-error|output-limit|invalid-input|input-mismatch|command-mismatch|input-length|stdin-end|output-format|exit-(?:null|\d+)(?:-(?:empty|security|parser(?:-token|-parenthesis)?(?:-l\d{1,4}c\d{1,5})?|runtime|other))?|helper-exit-\d+)$/u.test(phase)
    ? phase : "unclassified";
}

class WindowsDpapiProtector implements ManagedWorkerPrivateStateProtector {
  readonly #runner: ManagedWorkerPrivateStatePowerShellRunner;
  constructor(runner: ManagedWorkerPrivateStatePowerShellRunner = { run: (script, input) => runPowerShell(script, input, true) }) { this.#runner = runner; }
  #decodeOutput(output: Uint8Array): Uint8Array {
    const encoded = Buffer.from(output).toString("utf8");
    if (!encoded || encoded.trim() !== encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("Managed worker private state protection failed", { cause: { phase: "output-format" } });
    let decoded: Buffer;
    try { decoded = Buffer.from(encoded, "base64"); } catch { throw new Error("Managed worker private state protection failed", { cause: { phase: "output-format" } }); }
    if (decoded.byteLength < 1 || decoded.byteLength > MAX_PROTECTED_BYTES || decoded.toString("base64") !== encoded)
      throw new Error("Managed worker private state protection failed", { cause: { phase: "output-format" } });
    return Uint8Array.from(decoded);
  }
  async protect(plaintext: Uint8Array): Promise<Uint8Array> {
    if (process.platform !== "win32" || plaintext.byteLength > MAX_PROTECTED_BYTES) throw new Error("Managed worker private state protection failed");
    const output = await this.#runner.run(protectScript, Buffer.from(Buffer.from(plaintext).toString("base64"), "utf8"));
    return this.#decodeOutput(output);
  }
  async unprotect(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (process.platform !== "win32" || ciphertext.byteLength > MAX_PROTECTED_BYTES) throw new Error("Managed worker private state protection failed");
    const output = await this.#runner.run(unprotectScript, Buffer.from(Buffer.from(ciphertext).toString("base64"), "utf8"));
    return this.#decodeOutput(output);
  }
}

async function rejectLinked(directory: string): Promise<void> {
  const parsed = path.parse(directory); let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe");
  }
}
async function createUnlinkedDirectory(directory: string): Promise<void> {
  const parsed = path.parse(directory); let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await lstat(current); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(current);
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe");
  }
}
class DefaultFilesystem implements ManagedWorkerPrivateStateFilesystem {
  async ensureProtectedDirectory(directory: string): Promise<void> {
    try {
      await createUnlinkedDirectory(path.dirname(directory));
      await rejectLinked(path.dirname(directory));
      const leaf = await lstat(directory).catch(error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (leaf && (!leaf.isDirectory() || leaf.isSymbolicLink())) throw new Error("unsafe");
    }
    catch { throw new Error("Managed worker private state directory is unsafe"); }
    if (process.platform !== "win32") throw new Error("Managed worker private state requires Windows");
    try { assertWindowsPrivateDirectory(directory); return; }
    catch { /* A new directory needs its private DACL; an unsafe owner still fails below. */ }
    await runPowerShell(aclScript, Buffer.from(directory, "utf8"));
    try { await rejectLinked(directory); }
    catch { throw new Error("Managed worker private state directory is unsafe"); }
    await assertWindowsPrivateDirectoryAfterAcl(directory);
  }
  async writeExclusive(filePath: string, data: Uint8Array): Promise<void> {
    try {
      const handle = await open(filePath, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    } catch { throw new Error("Managed worker private state already exists or cannot be written"); }
  }
  async readProtectedFile(filePath: string): Promise<Uint8Array> {
    try {
      await rejectLinked(path.dirname(filePath));
      const entry = await lstat(filePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > MAX_PROTECTED_BYTES) throw new Error("unsafe");
      return Uint8Array.from(await readFile(filePath));
    } catch { throw new Error("Managed worker private state is unavailable"); }
  }
}

/** Shared Windows ACL boundary for local capability files. The directory is
 * private to this OS user and SYSTEM; existing reparse points are refused. */
export async function ensureProtectedLocalDirectory(directory: string): Promise<void> {
  await new DefaultFilesystem().ensureProtectedDirectory(directory);
}

function dependencies(options: CreateManagedWorkerPrivateStateOptions): { protector: ManagedWorkerPrivateStateProtector; filesystem: ManagedWorkerPrivateStateFilesystem } {
  return { protector: options.protector ?? new WindowsDpapiProtector(options.powerShellRunner), filesystem: options.filesystem ?? new DefaultFilesystem() };
}
function strictEncode(value: unknown): Uint8Array {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail(); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_PROTECTED_BYTES) fail();
  return Buffer.from(encoded, "utf8");
}
function parseState(bytesValue: Uint8Array, baseDirectory: string, epoch: string): ManagedWorkerPrivateState {
  if (bytesValue.byteLength < 1 || bytesValue.byteLength > MAX_PROTECTED_BYTES) fail();
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(bytesValue).toString("utf8")); } catch { fail(); }
  return state(decoded, baseDirectory, epoch);
}

/** Create exactly one DPAPI-protected, epoch-scoped daemon state record. */
export async function createManagedWorkerPrivateState(manifestInput: ManagedWorkerPrivateManifest,
  options: CreateManagedWorkerPrivateStateOptions): Promise<ManagedWorkerPrivateState> {
  const baseDirectory = absolute(options?.baseDirectory);
  const checkedManifest = manifest(manifestInput);
  const { protector, filesystem } = dependencies(options);
  const initial = state({ manifest: checkedManifest, keys: {
    fingerprintKey: randomBytes(32).toString("base64"), intentKey: randomBytes(32).toString("base64"), controlToken: randomBytes(32).toString("base64"),
  } }, baseDirectory, checkedManifest.epoch);
  const plaintext = strictEncode({ manifest: initial.manifest, keys: initial.keys });
  let protectedBytes: Uint8Array;
  try { protectedBytes = await protector.protect(plaintext); } catch (error) {
    throw new Error("Managed worker private state protection failed", { cause: { phase: safeProtectionPhase(error) } });
  }
  if (protectedBytes.byteLength < 1 || protectedBytes.byteLength > MAX_PROTECTED_BYTES) fail();
  await filesystem.ensureProtectedDirectory(initial.privateDirectory);
  await filesystem.writeExclusive(privateStateFile(baseDirectory, checkedManifest.epoch), protectedBytes);
  return initial;
}

/** Load and validate an immutable state record only from its expected epoch directory. */
export async function loadManagedWorkerPrivateState(options: LoadManagedWorkerPrivateStateOptions): Promise<ManagedWorkerPrivateState> {
  const baseDirectory = absolute(options?.baseDirectory);
  const epoch = bounded(options?.epoch, 36); if (!UUID.test(epoch)) fail();
  const { protector, filesystem } = dependencies(options);
  const ciphertext = await filesystem.readProtectedFile(privateStateFile(baseDirectory, epoch));
  let plaintext: Uint8Array;
  try { plaintext = await protector.unprotect(ciphertext); } catch (error) {
    throw new Error("Managed worker private state protection failed", { cause: { phase: safeProtectionPhase(error) } });
  }
  return parseState(plaintext, baseDirectory, epoch);
}
