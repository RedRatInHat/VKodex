import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { RuntimeSetupError } from "./runtime.js";

const MANIFEST = "artifact-manifest.json";
const SDK_VERSION = "0.160.0";
const MAX_METADATA = 16 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_BYTES = 20 * 1024 ** 3;
const HASH = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const unsafeCharacters = /[\x00-\x1f\x7f"']/u;

export async function* boundedArtifactBytes(source: AsyncIterable<Uint8Array>, limit: number): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > limit) refuse("file grew beyond its read limit");
    yield chunk;
  }
}

export interface DeploymentLaunchPlan {
  readonly executable: string;
  readonly entryPoint: string;
  readonly cwd: string;
  readonly environmentFile: string;
  readonly dataDirectory: string;
  readonly nativeCodexPath: string;
  readonly arguments: readonly string[];
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly descriptorSha256: string;
  readonly manifestSha256: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly runtimeSha256: string;
}

function refuse(category: string): never {
  // No parser contents, secret values, local filenames or OS error messages.
  throw new RuntimeSetupError(`Artifact validation refused: ${category}.`);
}

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid metadata object");
  const result = value as Record<string, unknown>;
  if (keys && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) refuse("unexpected metadata fields");
  return result;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) refuse("invalid SHA-256 pin");
  return value;
}

function absolute(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_024 || unsafeCharacters.test(value) || !path.isAbsolute(value)) refuse("invalid absolute path");
  const segments = value.split(/[\\/]/u).filter(Boolean);
  if (segments.some(segment => segment === "." || segment === "..")) refuse("ambiguous absolute path");
  if (process.platform === "win32") {
    if (!/^[a-z]:[\\/]/iu.test(value) || /[:]/u.test(value.slice(2)) || segments.slice(1).some(ambiguousWindowsName)) refuse("ambiguous Windows path");
  }
  const result = path.normalize(value);
  if (result === path.parse(result).root) refuse("root directory is not an installation");
  return result.replace(/[\\/]$/u, "");
}

function ambiguousWindowsName(segment: string): boolean {
  return /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment) || /[<>:|?*]/u.test(segment);
}

function samePath(first: string, second: string): boolean {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Reject aliases and linked ancestors, including junctions above an otherwise ordinary file. */
async function canonical(file: string, kind: "file" | "directory" | "future-directory"): Promise<void> {
  const parsed = path.parse(file);
  const segments = file.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if (kind === "future-directory" && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      refuse("required local path unavailable");
    }
    const last = index === segments.length - 1;
    if (metadata.isSymbolicLink() || !samePath(await realpath(current), current)) refuse("linked or aliased local path");
    if (last && kind === "file") { if (!metadata.isFile()) refuse("expected regular file"); }
    else if (!metadata.isDirectory()) refuse("expected directory");
  }
}

export function uniqueJson(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { refuse("invalid JSON metadata"); }
  // JSON.parse accepts duplicate keys. Scan the already grammar-validated text
  // without evaluating it, remembering keys separately for each nested object.
  const scopes: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{" || character === "[") { scopes.push(character === "{" ? new Set() : null); if (scopes.length > 64) refuse("metadata nesting limit"); }
    else if (character === "}" || character === "]") scopes.pop();
    else if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') { if (text[index] === "\\") index += 1; index += 1; }
      let next = index + 1;
      while (/\s/u.test(text[next] ?? "")) next += 1;
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        const scope = scopes.at(-1);
        if (!scope || scope.has(key)) refuse("duplicate metadata key");
        scope.add(key);
      }
    }
  }
  return value;
}

async function metadataFile(file: string, maximum: number, pin?: string): Promise<unknown> {
  await canonical(file, "file");
  const before = await lstat(file, { bigint: true });
  if (before.size > maximum || before.nlink !== 1n) refuse("metadata file limit or link");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of boundedArtifactBytes(createReadStream(file), maximum)) { chunks.push(chunk); size += chunk.byteLength; }
  const bytes = Buffer.concat(chunks, size);
  const after = await lstat(file, { bigint: true });
  if (!stable(before, after) || bytes.length > maximum) refuse("metadata changed during validation");
  if (pin && createHash("sha256").update(bytes).digest("hex") !== pin) refuse("metadata hash mismatch");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { refuse("metadata is not UTF-8"); }
  return uniqueJson(text);
}

function stable(first: { size: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }, second: typeof first): boolean {
  return first.size === second.size && first.ino === second.ino && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function inventoryPath(relative: string): void {
  if (relative.length > 512 || unsafeCharacters.test(relative) || relative.includes("\\") || relative.includes(":")) refuse("invalid inventory path");
  const segments = relative.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || ambiguousWindowsName(segment))) refuse("ambiguous inventory path");
  if (!(relative === "package.json" || relative === "package-lock.json" || relative === "docs/logo.ico" || /^(?:dist|scripts|node_modules|runtime)\//u.test(relative))) refuse("unsupported artifact file scope");
  if (segments[0]?.toLowerCase() !== "node_modules" && segments.some(segment => segment.toLowerCase() === "node_modules")) refuse("application dependency shadow");
  if (segments.some(segment => /^(?:\.env(?:\.|$)|auth\.json$)|\.sqlite(?:-|$)/iu.test(segment))) refuse("configuration or data in artifact");
}

export interface InventoryFile { readonly size: number; readonly sha256: string }

async function verifyInventory(root: string, inventory: ReadonlyMap<string, InventoryFile>, manifestName = MANIFEST,
  strictDirectories = false): Promise<() => Promise<void>> {
  const found = new Set<string>();
  const observed = new Map<string, BigIntStats>();
  let nodes = 0;
  async function walk(directory: string): Promise<void> {
    const before = await lstat(directory, { bigint: true });
    observed.set(directory, before);
    const names = await readdir(directory);
    const caseNames = new Set<string>();
    for (const name of names) {
      nodes += 1;
      if (nodes > MAX_FILES * 2 || caseNames.has(name.toLowerCase())) refuse("artifact inventory limit or case collision");
      caseNames.add(name.toLowerCase());
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      const fileBefore = await lstat(file, { bigint: true });
      observed.set(file, fileBefore);
      if (fileBefore.isSymbolicLink() || !samePath(await realpath(file), file)) refuse("linked artifact file");
      if (fileBefore.isDirectory()) {
        if (strictDirectories && ![...inventory.keys()].some(entry => entry.startsWith(`${relative}/`))) refuse("unlisted inventory directory");
        await walk(file); continue;
      }
      if (!fileBefore.isFile() || fileBefore.nlink !== 1n) refuse("artifact file is not private and regular");
      if (relative === manifestName) continue;
      const expected = inventory.get(relative);
      if (!expected || fileBefore.size !== BigInt(expected.size)) refuse("unlisted or changed artifact file");
      const hash = createHash("sha256");
      for await (const chunk of boundedArtifactBytes(createReadStream(file), expected.size)) hash.update(chunk);
      if (hash.digest("hex") !== expected.sha256 || !stable(fileBefore, await lstat(file, { bigint: true }))) refuse("artifact hash mismatch or concurrent change");
      found.add(relative);
    }
    if (!stable(before, await lstat(directory, { bigint: true }))) refuse("artifact directory changed during validation");
  }
  await walk(root);
  if (found.size !== inventory.size) refuse("artifact inventory incomplete");
  return async () => {
    // A previously verified file may change while later files/package metadata
    // are being read. Recheck the whole observation, not just the last stream.
    for (const [file, before] of observed) {
      const after = await lstat(file, { bigint: true });
      if (after.isSymbolicLink() || !stable(before, after) || before.nlink !== after.nlink ||
          before.mode !== after.mode || !samePath(await realpath(file), file)) refuse("artifact changed during validation");
    }
  };
}

/** Internal, read-only building blocks shared by the trusted binding planner.
 * Exporting these does not authorize executing any of the observed bytes.
 */
export const deploymentValidationIO = Object.freeze({ object, sha, absolute, contained, canonical, metadataFile, verifyInventory });

export async function verifyDeploymentRuntime(file: string, expectedSha256: string): Promise<() => Promise<void>> {
  await canonical(file, "file");
  const before = await lstat(file, { bigint: true });
  if (before.nlink !== 1n || before.size > 2n * 1024n ** 3n) refuse("runtime file limit or link");
  const hash = createHash("sha256");
  for await (const chunk of boundedArtifactBytes(createReadStream(file), Number(before.size))) hash.update(chunk);
  if (hash.digest("hex") !== sha(expectedSha256) || !stable(before, await lstat(file, { bigint: true }))) refuse("runtime hash mismatch or concurrent change");
  return async () => {
    await canonical(file, "file");
    const after = await lstat(file, { bigint: true });
    if (after.nlink !== 1n || after.mode !== before.mode || !stable(before, after)) refuse("runtime changed during validation");
  };
}

async function criticalPackages(root: string, inventory: ReadonlyMap<string, InventoryFile>): Promise<string> {
  const read = async (relative: string) => object(await metadataFile(path.join(root, relative), MAX_METADATA));
  const packageFile = await read("package.json");
  if (packageFile.type !== "module" || object(packageFile.dependencies)["@openai/codex-sdk"] !== SDK_VERSION) refuse("artifact SDK pin mismatch");
  const lock = await read("package-lock.json");
  const packages = object(lock.packages);
  if (lock.lockfileVersion !== 3 || object(object(packages[""]).dependencies)["@openai/codex-sdk"] !== SDK_VERSION ||
      object(packages["node_modules/@openai/codex-sdk"]).version !== SDK_VERSION || object(packages["node_modules/@openai/codex"]).version !== SDK_VERSION) refuse("artifact lock mismatch");
  const sdk = await read("node_modules/@openai/codex-sdk/package.json");
  if (sdk.name !== "@openai/codex-sdk" || sdk.version !== SDK_VERSION) refuse("artifact SDK version mismatch");
  // All app-directory node_modules shadows are refused above. Validate the
  // pinned SDK's ESM export rather than using a different CJS require condition.
  const sdkExport = object(object(sdk.exports, ["."])["."], ["import", "types"]);
  if (sdkExport.import !== "./dist/index.js" || sdkExport.types !== "./dist/index.d.ts" ||
      !inventory.has("node_modules/@openai/codex-sdk/dist/index.js") || !inventory.has("node_modules/@openai/codex-sdk/dist/index.d.ts")) refuse("unsupported SDK ESM export");
  const require = createRequire(path.join(root, "dist/src/codex/native-cli.js"));
  const ownPackage = (file: string): string => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!contained(root, file) || !inventory.has(relative)) refuse("dependency resolved outside artifact");
    return file;
  };
  const cliPackage = ownPackage(require.resolve("@openai/codex/package.json"));
  if (object(await metadataFile(cliPackage, MAX_METADATA)).version !== SDK_VERSION) refuse("artifact CLI version mismatch");
  const nativePackage = ownPackage(createRequire(cliPackage).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  if (object(await metadataFile(nativePackage, MAX_METADATA)).version !== `${SDK_VERSION}-${process.platform}-${process.arch}`) refuse("artifact native CLI version mismatch");
  const cpu = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
  const suffix = ({ win32: "pc-windows-msvc", linux: "unknown-linux-musl", darwin: "apple-darwin" } as Record<string, string>)[process.platform];
  if (!cpu || !suffix) refuse("unsupported native platform");
  const vendor = path.join(path.dirname(nativePackage), "vendor", `${cpu}-${suffix}`);
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  for (const folder of ["bin", "codex"]) {
    const candidate = path.join(vendor, folder, name);
    if (inventory.has(path.relative(root, candidate).split(path.sep).join("/"))) return candidate;
  }
  refuse("artifact native CLI missing");
}

/** Read-only observation of bytes, not a launch authorization or a cutover.
 * Run this validator with trusted code/runtime, never from the unverified artifact.
 * It intentionally does not read .env, import package code, spawn or create files.
 */
export async function validateDeploymentArtifact(descriptorPath: string, expectedSha256: string): Promise<DeploymentLaunchPlan> {
  try {
    descriptorPath = absolute(descriptorPath);
    expectedSha256 = sha(expectedSha256);
    const descriptor = object(await metadataFile(descriptorPath, 32 * 1024, expectedSha256),
      ["version", "artifactRoot", "configurationRoot", "dataDirectory", "manifestSha256"]);
    if (descriptor.version !== 1) refuse("unsupported descriptor version");
    const artifactRoot = absolute(descriptor.artifactRoot);
    const configurationRoot = absolute(descriptor.configurationRoot);
    const dataDirectory = absolute(descriptor.dataDirectory);
    const manifestSha256 = sha(descriptor.manifestSha256);
    for (const other of [configurationRoot, dataDirectory, descriptorPath]) {
      if (contained(artifactRoot, other) || contained(other, artifactRoot)) refuse("artifact overlaps configuration or data");
    }
    await canonical(artifactRoot, "directory");
    await canonical(configurationRoot, "directory");
    await canonical(dataDirectory, "future-directory");
    const environmentFile = path.join(configurationRoot, ".env");
    await canonical(environmentFile, "file"); // Metadata only; never read configuration contents.
    const manifest = object(await metadataFile(path.join(artifactRoot, MANIFEST), MAX_METADATA, manifestSha256),
      ["version", "sourceCommit", "sourceTree", "node", "sdkVersion", "files"]);
    if (manifest.version !== 1 || typeof manifest.sourceCommit !== "string" || !REVISION.test(manifest.sourceCommit) ||
        typeof manifest.sourceTree !== "string" || !REVISION.test(manifest.sourceTree) || manifest.sdkVersion !== SDK_VERSION) refuse("unsupported artifact provenance");
    const node = object(manifest.node, ["version", "platform", "arch", "modules"]);
    if (node.version !== process.version || node.platform !== process.platform || node.arch !== process.arch || node.modules !== process.versions.modules) refuse("artifact runtime identity mismatch");
    const entries = Object.entries(object(manifest.files));
    if (entries.length === 0 || entries.length > MAX_FILES) refuse("artifact file limit");
    const inventory = new Map<string, InventoryFile>();
    const casePaths = new Set<string>();
    let totalBytes = 0;
    for (const [relative, value] of entries) {
      inventoryPath(relative);
      if (casePaths.has(relative.toLowerCase())) refuse("inventory case collision");
      casePaths.add(relative.toLowerCase());
      const entry = object(value, ["size", "sha256"]);
      if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 2 * 1024 ** 3) refuse("invalid artifact file size");
      totalBytes += entry.size;
      if (totalBytes > MAX_BYTES) refuse("artifact total size limit");
      inventory.set(relative, { size: entry.size, sha256: sha(entry.sha256) });
    }
    const runtimeRelative = `runtime/${process.platform === "win32" ? "VKodex.exe" : "node"}`;
    for (const required of [runtimeRelative, "dist/src/desktop-main.js", "dist/src/codex/native-cli.js", "scripts/run-windows-supervisor.ps1",
      "scripts/watch-windows-bridge.ps1", "scripts/VKodexSupervisor.cs", "docs/logo.ico", "package.json", "package-lock.json",
      "node_modules/@openai/codex-sdk/package.json", "node_modules/@openai/codex/package.json"]) {
      if (!inventory.has(required)) refuse("required artifact file missing");
    }
    const recheckInventory = await verifyInventory(artifactRoot, inventory);
    const nativeCodexPath = await criticalPackages(artifactRoot, inventory);
    await recheckInventory();
    // Recheck the pins after all IO, rather than using a manifest replaced during the walk.
    await metadataFile(path.join(artifactRoot, MANIFEST), MAX_METADATA, manifestSha256);
    await metadataFile(descriptorPath, 32 * 1024, expectedSha256);
    const entryPoint = path.join(artifactRoot, "dist/src/desktop-main.js");
    return Object.freeze({ executable: path.join(artifactRoot, runtimeRelative), entryPoint, cwd: configurationRoot, environmentFile,
      dataDirectory, nativeCodexPath, arguments: Object.freeze([`--env-file=${environmentFile}`, entryPoint]),
      environmentOverrides: Object.freeze({ BOT_DATA_DIR: dataDirectory, NODE_OPTIONS: "", NODE_PATH: "" }),
      descriptorSha256: expectedSha256, manifestSha256, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree,
      runtimeSha256: inventory.get(runtimeRelative)!.sha256 });
  } catch (error) {
    if (error instanceof RuntimeSetupError) throw error;
    refuse("required artifact metadata unavailable");
  }
}

/** Match the current BOT_DATA_DIR cwd semantics without reading configuration. */
export function deploymentDataDirectory(configurationRoot: string, configuredValue?: string): string {
  return absolute(path.resolve(absolute(configurationRoot), configuredValue || "./data/desktop"));
}

export function deploymentValidationArguments(arguments_: readonly string[]): { descriptorPath: string; expectedSha256: string } {
  if (arguments_.length !== 4 || arguments_[0] !== "--descriptor" || arguments_[2] !== "--sha256") refuse("expected descriptor and independent hash arguments");
  return { descriptorPath: absolute(arguments_[1]), expectedSha256: sha(arguments_[3]) };
}
