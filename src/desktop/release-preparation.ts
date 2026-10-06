import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_FILES, validateDeploymentBinding } from "./deployment-binding.js";
import { deploymentValidationIO } from "./deployment-artifact.js";

const execFile = promisify(execFileCallback);
const SDK_VERSION = "0.160.0";
const MAX_FILES = 50_000;
const MAX_BYTES = 20 * 1024 ** 3;
const ARTIFACT_SCRIPTS = ["scripts/run-windows-supervisor.ps1", "scripts/watch-windows-bridge.ps1",
  "scripts/VKodexSupervisor.cs", "scripts/read-vk-document-token.ps1"] as const;
const ARTIFACT_ROOT_FILES = ["package.json", "package-lock.json", "docs/logo.ico"] as const;
const BOOTSTRAP_LAUNCHER = "launcher/VKodexSupervisor.exe";
const forbiddenArtifactSegment = /^(?:\.env(?:\.|$)|auth\.json$)|\.sqlite(?:-|$)/iu;

export interface ReleasePreparationOptions {
  readonly source: string;
  readonly configurationRoot: string;
  readonly dataDirectory: string;
  readonly output: string;
  readonly stableRuntimePath: string;
  readonly launcherPath: string;
  readonly dependenciesRoot: string;
  readonly mode: "dry-run" | "prepare";
}
export interface ReleasePreparationResult {
  readonly status: "validated_not_launched" | "ready_to_prepare";
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly output: string;
  readonly omittedOptionalPackages: readonly string[];
  readonly bindingPath?: string;
  readonly bindingSha256?: string;
}

const absolute = deploymentValidationIO.absolute;
const contained = deploymentValidationIO.contained;
const canonical = deploymentValidationIO.canonical;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function refuse(reason: string): never { throw new Error(`Release preparation refused: ${reason}.`); }
async function git(source: string, ...args: string[]): Promise<string> {
  try { const result = await execFile("git", ["-C", source, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return result.stdout.trim(); }
  catch { return refuse("source Git state unavailable"); }
}
async function sourceRevision(source: string): Promise<{ commit: string; tree: string }> {
  const topLevel = await git(source, "rev-parse", "--show-toplevel");
  if (path.resolve(topLevel).toLowerCase() !== path.resolve(source).toLowerCase()) refuse("source is not the checkout root");
  if (await git(source, "status", "--porcelain=v1", "--untracked-files=no")) refuse("tracked source is not clean");
  const untracked = await git(source, "ls-files", "--others", "--", "src", "scripts/assert-production-build.mjs",
    "tsconfig.json", "tsconfig.build.json", "package.json", "package-lock.json");
  if (untracked.split(/\r?\n/u).some(file => /^src\/.*\.ts$/u.test(file) ||
      ["scripts/assert-production-build.mjs", "tsconfig.json", "tsconfig.build.json", "package.json", "package-lock.json"].includes(file)))
    refuse("untracked build input");
  const commit = await git(source, "rev-parse", "HEAD");
  const tree = await git(source, "rev-parse", "HEAD^{tree}");
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) refuse("source revision invalid");
  return { commit, tree };
}
async function regular(file: string): Promise<number> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || path.resolve(await realpath(file)) !== path.resolve(file))
    refuse("linked or non-regular input");
  return info.size;
}
async function walk(source: string, relative: string, result: Map<string, string>, skipNestedModules = false): Promise<void> {
  const root = path.join(source, relative);
  const info = await lstat(root);
  if (info.isSymbolicLink() || path.resolve(await realpath(root)) !== path.resolve(root)) refuse("linked input directory");
  if (info.isFile()) { await regular(root); result.set(relative.split(path.sep).join("/"), root); return; }
  if (!info.isDirectory()) refuse("unsupported input node");
  for (const name of (await readdir(root)).sort()) {
    if (skipNestedModules && name === "node_modules") continue;
    await walk(source, path.join(relative, name), result, skipNestedModules);
  }
}
async function productionPackages(source: string, dependenciesRoot: string): Promise<{ selected: string[]; omittedOptional: string[] }> {
  const lock = JSON.parse(await readFile(path.join(source, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { dev?: boolean; optional?: boolean; version?: string }> };
  const packages = lock.packages;
  if (!packages || packages[""]?.dev || JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).dependencies?.["@openai/codex-sdk"] !== SDK_VERSION ||
      packages["node_modules/@openai/codex-sdk"]?.dev || !packages["node_modules/@openai/codex-sdk"] ||
      !packages["node_modules/@openai/codex"] || packages["node_modules/@openai/codex"]?.dev)
    refuse("production dependency pin unavailable");
  const selected: string[] = [], omittedOptional: string[] = [];
  for (const [relative, item] of Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!relative.startsWith("node_modules/") || item.dev) continue;
    const location = path.join(dependenciesRoot, relative.slice("node_modules/".length));
    try { await lstat(location); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && item.optional) {
      omittedOptional.push(relative); continue; }
      refuse("required production dependency missing"); }
    if (!item.version || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(item.version)) refuse("dependency lock version invalid");
    let metadata: { version?: string };
    try {
      const packageFile = path.join(location, "package.json");
      await regular(packageFile);
      metadata = JSON.parse(await readFile(packageFile, "utf8")) as { version?: string };
    } catch { refuse("installed production dependency metadata unavailable"); }
    if (metadata.version !== item.version) refuse("installed production dependency version differs from lock");
    selected.push(relative);
  }
  const native = `node_modules/@openai/codex-${process.platform}-${process.arch}`;
  if (!selected.includes(native)) refuse("current-platform native CLI dependency missing");
  return { selected, omittedOptional };
}
async function gather(source: string, dependenciesRoot: string, runtime: string): Promise<{
  files: Map<string, string>; omittedOptional: string[] }> {
  const files = new Map<string, string>();
  for (const relative of [...ARTIFACT_ROOT_FILES, ...ARTIFACT_SCRIPTS, "dist"]) await walk(source, relative, files);
  const packages = await productionPackages(source, dependenciesRoot);
  for (const relative of packages.selected) {
    const packageRoot = path.join(dependenciesRoot, relative.slice("node_modules/".length));
    const packageFiles = new Map<string, string>();
    await walk(packageRoot, ".", packageFiles, true);
    for (const [inside, file] of packageFiles) files.set(`${relative}/${inside === "." ? "" : inside}`, file);
  }
  files.set(process.platform === "win32" ? "runtime/VKodex.exe" : "runtime/node", runtime);
  for (const required of ["dist/src/desktop-main.js", "dist/src/codex/native-cli.js",
    "node_modules/@openai/codex-sdk/package.json", "node_modules/@openai/codex/package.json"])
    if (!files.has(required)) refuse("required artifact file missing");
  if (files.size > MAX_FILES) refuse("artifact file limit");
  let bytes = 0;
  for (const [relative, file] of files) {
    if (!/^(?:dist|scripts|node_modules|runtime)\//u.test(relative) && !(ARTIFACT_ROOT_FILES as readonly string[]).includes(relative))
      refuse("unsupported artifact file scope");
    if (relative.startsWith("dist/") && !/\.js(?:\.map)?$/u.test(relative)) refuse("unexpected compiled output");
    if (relative.split("/").some(segment => forbiddenArtifactSegment.test(segment))) refuse("configuration or data in artifact");
    bytes += await regular(file);
    if (bytes > MAX_BYTES) refuse("artifact size limit");
  }
  return { files, omittedOptional: packages.omittedOptional };
}
async function build(source: string): Promise<void> {
  try {
    await execFile(process.execPath, [path.join(source, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
      { cwd: source, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true });
    await execFile(process.execPath, [path.join(source, "scripts/assert-production-build.mjs")],
      { cwd: source, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch { refuse("production build failed"); }
}
function json(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), "utf8"); }
async function fileHash(file: string, limit: number): Promise<string> {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.byteLength;
    if (size > limit) refuse("file grew while hashing");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function writeJson(file: string, value: unknown): Promise<string> {
  const bytes = json(value);
  await writeFile(file, bytes, { flag: "wx" });
  return sha256(bytes);
}
export async function copyReleaseInventory(files: ReadonlyMap<string, string>, destination: string): Promise<Record<string, { size: number; sha256: string }>> {
  const entries: Record<string, { size: number; sha256: string }> = {};
  for (const [relative, source] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await regular(source);
    const before = await lstat(source);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await regular(source);
    const after = await lstat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino)
      refuse("input changed while copying");
    const size = await regular(target);
    if (size !== before.size || size > 2 * 1024 ** 3) refuse("copied file size invalid");
    entries[relative] = { size, sha256: await fileHash(target, size) };
  }
  return entries;
}

/** Materializes only an exclusive new output directory. It never starts a bridge. */
export async function prepareRelease(options: ReleasePreparationOptions,
  buildProduction: (source: string) => Promise<void> = build): Promise<ReleasePreparationResult> {
  const source = absolute(options.source), configurationRoot = absolute(options.configurationRoot);
  const dataDirectory = absolute(options.dataDirectory), output = absolute(options.output);
  const stableRuntimePath = absolute(options.stableRuntimePath), launcherPath = absolute(options.launcherPath);
  const dependenciesRoot = absolute(options.dependenciesRoot);
  if (!["dry-run", "prepare"].includes(options.mode)) refuse("invalid mode");
  for (const other of [source, configurationRoot, dataDirectory, stableRuntimePath, launcherPath, dependenciesRoot])
    if (contained(other, output) || contained(output, other)) refuse("output overlaps source, configuration, data or runtime");
  await canonical(source, "directory"); await canonical(configurationRoot, "directory");
  await canonical(path.join(configurationRoot, ".env"), "file");
  await canonical(dataDirectory, "future-directory");
  await canonical(stableRuntimePath, "file"); await canonical(launcherPath, "file");
  await canonical(dependenciesRoot, "directory");
  await canonical(path.dirname(output), "directory");
  try { await lstat(output); refuse("output already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const revision = await sourceRevision(source);
  if (options.mode === "prepare") { await buildProduction(source); const post = await sourceRevision(source);
    if (post.commit !== revision.commit || post.tree !== revision.tree) refuse("source changed during build"); }
  const { files, omittedOptional } = await gather(source, dependenciesRoot, stableRuntimePath);
  const bootstrap = new Map<string, string>();
  for (const relative of BOOTSTRAP_FILES) {
    if (relative === "package.json") continue;
    bootstrap.set(relative, relative === BOOTSTRAP_LAUNCHER ? launcherPath : path.join(source, relative));
  }
  for (const file of bootstrap.values()) await regular(file);
  const totalBytes = (await Promise.all([...files.values()].map(regular))).reduce((a, b) => a + b, 0);
  if (options.mode === "dry-run") return { status: "ready_to_prepare", sourceCommit: revision.commit,
    sourceTree: revision.tree, fileCount: files.size, totalBytes, output, omittedOptionalPackages: omittedOptional };
  await mkdir(output); // EEXIST is a hard refusal: no overwrite or reuse.
  const artifactRoot = path.join(output, "artifact"), bootstrapRoot = path.join(output, "bootstrap");
  await mkdir(artifactRoot); await mkdir(bootstrapRoot);
  const artifactInventory = await copyReleaseInventory(files, artifactRoot);
  const artifactManifestSha256 = await writeJson(path.join(artifactRoot, "artifact-manifest.json"), {
    version: 1, sourceCommit: revision.commit, sourceTree: revision.tree,
    node: { version: process.version, platform: process.platform, arch: process.arch, modules: process.versions.modules },
    sdkVersion: SDK_VERSION, files: artifactInventory });
  const descriptorPath = path.join(output, "descriptor.json");
  const descriptorSha256 = await writeJson(descriptorPath, { version: 1, artifactRoot, configurationRoot, dataDirectory,
    manifestSha256: artifactManifestSha256 });
  const bootstrapInventory = await copyReleaseInventory(bootstrap, bootstrapRoot);
  const bootstrapPackage = json({ type: "module" });
  await writeFile(path.join(bootstrapRoot, "package.json"), bootstrapPackage, { flag: "wx" });
  bootstrapInventory["package.json"] = { size: bootstrapPackage.length, sha256: sha256(bootstrapPackage) };
  const bootstrapManifestSha256 = await writeJson(path.join(bootstrapRoot, "bootstrap-manifest.json"),
    { version: 1, protocol: "deployment-plan-v1", files: bootstrapInventory });
  const bindingPath = path.join(output, "binding.json");
  const runtimeSha256 = await fileHash(stableRuntimePath, 2 * 1024 ** 3);
  const bindingSha256 = await writeJson(bindingPath, { version: 1, descriptorPath, descriptorSha256, bootstrapRoot,
    bootstrapManifestSha256, stableRuntimePath, stableRuntimeSha256: runtimeSha256 });
  const plan = await validateDeploymentBinding(bindingPath, bindingSha256);
  if (plan.sourceCommit !== revision.commit || plan.sourceTree !== revision.tree || plan.status !== "validated_not_launched")
    refuse("prepared release validation disagreed with source");
  const finalRevision = await sourceRevision(source);
  if (finalRevision.commit !== revision.commit || finalRevision.tree !== revision.tree) refuse("source changed during release copy");
  return { status: plan.status, sourceCommit: revision.commit, sourceTree: revision.tree,
    fileCount: files.size, totalBytes, output, bindingPath, bindingSha256, omittedOptionalPackages: omittedOptional };
}

function parseArguments(args: readonly string[]): ReleasePreparationOptions {
  const names = ["--source", "--configuration-root", "--data-dir", "--output", "--runtime", "--launcher", "--dependencies-root"] as const;
  const values = new Map<string, string>(); let mode: "dry-run" | "prepare" | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run" || arg === "--prepare") { if (mode) refuse("duplicate mode"); mode = arg === "--dry-run" ? "dry-run" : "prepare"; continue; }
    if (!names.includes(arg as typeof names[number]) || values.has(arg) || !args[index + 1]) refuse("invalid arguments");
    values.set(arg, args[++index]!);
  }
  if (!mode || values.size !== names.length) refuse("missing arguments");
  return { source: values.get("--source")!, configurationRoot: values.get("--configuration-root")!,
    dataDirectory: values.get("--data-dir")!, output: values.get("--output")!,
    stableRuntimePath: values.get("--runtime")!, launcherPath: values.get("--launcher")!,
    dependenciesRoot: values.get("--dependencies-root")!, mode };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  prepareRelease(parseArguments(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Release preparation refused"}\n`);
    process.exitCode = 1;
  });
}
