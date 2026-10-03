import path from "node:path";
import { deploymentValidationIO, validateDeploymentArtifact, verifyDeploymentRuntime, type DeploymentLaunchPlan,
  type InventoryFile } from "./deployment-artifact.js";
import { RuntimeSetupError } from "./runtime.js";

export const BOOTSTRAP_FILES = Object.freeze([
  "launcher/VKodexSupervisor.exe", "package.json", "dist/src/desktop/deployment-plan-private.js",
  "dist/src/desktop/deployment-binding.js", "dist/src/desktop/deployment-artifact.js", "dist/src/desktop/runtime.js",
  "scripts/run-windows-supervisor.ps1", "scripts/watch-windows-bridge.ps1",
] as const);

export interface VersionedDeploymentPlan extends DeploymentLaunchPlan {
  readonly version: 1;
  readonly status: "validated_not_launched";
  readonly protocol: "deployment-plan-v1";
  readonly bindingPath: string;
  readonly bindingSha256: string;
  readonly bootstrapManifestSha256: string;
  readonly runtimeSha256: string;
  readonly launcherPath: string;
  readonly launcherSha256: string;
  readonly supervisorPath: string;
  readonly watchdogPath: string;
}

const { object, sha, absolute, contained, canonical, metadataFile, verifyInventory } = deploymentValidationIO;
const BINDING_KEYS = ["version", "descriptorPath", "descriptorSha256", "bootstrapRoot", "bootstrapManifestSha256", "stableRuntimePath", "stableRuntimeSha256"];

function refuse(category: string): never {
  throw new RuntimeSetupError(`Launch binding validation refused: ${category}.`);
}

export function deploymentBindingArguments(arguments_: readonly string[]): { bindingPath: string; expectedSha256: string } {
  if (arguments_.length !== 4 || arguments_[0] !== "--launch-binding" || arguments_[2] !== "--launch-binding-sha256") refuse("expected binding and independent hash arguments");
  return { bindingPath: absolute(arguments_[1]), expectedSha256: sha(arguments_[3]) };
}

/** This code and the Node process running it must already be trusted. The bundle
 * is observed as data, never imported/executed; this is not self-authentication
 * of a private CLI that was started from an unverified bundle.
 */
export async function validateDeploymentBinding(bindingPath: string, expectedSha256: string): Promise<VersionedDeploymentPlan> {
  try {
    bindingPath = absolute(bindingPath);
    expectedSha256 = sha(expectedSha256);
    const binding = object(await metadataFile(bindingPath, 32 * 1024, expectedSha256), BINDING_KEYS);
    if (binding.version !== 1) refuse("unsupported binding version");
    const descriptorPath = absolute(binding.descriptorPath);
    const descriptorSha256 = sha(binding.descriptorSha256);
    const bootstrapRoot = absolute(binding.bootstrapRoot);
    const bootstrapManifestSha256 = sha(binding.bootstrapManifestSha256);
    const stableRuntimePath = absolute(binding.stableRuntimePath);
    const runtimeSha256 = sha(binding.stableRuntimeSha256);
    await canonical(bootstrapRoot, "directory");
    for (const file of [bindingPath, descriptorPath, stableRuntimePath]) {
      if (contained(bootstrapRoot, file) || contained(file, bootstrapRoot)) refuse("bootstrap overlaps mutable inputs or runtime");
    }
    // Pin the actual selected stable runtime before any artifact observation;
    // never prepare/copy it or fall back to the artifact's executable.
    const recheckRuntime = await verifyDeploymentRuntime(stableRuntimePath, runtimeSha256);
    const manifestPath = path.join(bootstrapRoot, "bootstrap-manifest.json");
    const manifest = object(await metadataFile(manifestPath, 128 * 1024, bootstrapManifestSha256), ["version", "protocol", "files"]);
    if (manifest.version !== 1 || manifest.protocol !== "deployment-plan-v1") refuse("unsupported bootstrap protocol");
    const files = object(manifest.files, BOOTSTRAP_FILES);
    const inventory = new Map<string, InventoryFile>();
    for (const relative of BOOTSTRAP_FILES) {
      const entry = object(files[relative], ["size", "sha256"]);
      if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024) refuse("bootstrap file limit");
      inventory.set(relative, { size: entry.size, sha256: sha(entry.sha256) });
    }
    const recheckBootstrap = await verifyInventory(bootstrapRoot, inventory, "bootstrap-manifest.json", true);
    const packageFile = object(await metadataFile(path.join(bootstrapRoot, "package.json"), 1_024), ["type"]);
    if (packageFile.type !== "module") refuse("bootstrap module type mismatch");
    const artifact = await validateDeploymentArtifact(descriptorPath, descriptorSha256);
    const artifactRoot = path.dirname(path.dirname(path.dirname(artifact.entryPoint)));
    for (const root of [artifactRoot, artifact.cwd, artifact.dataDirectory]) {
      if (contained(bootstrapRoot, root) || contained(root, bootstrapRoot)) refuse("bootstrap overlaps artifact, configuration or data");
      if (contained(root, stableRuntimePath)) refuse("stable runtime overlaps artifact, configuration or data");
    }
    for (const file of [bindingPath, descriptorPath]) {
      if (contained(artifactRoot, file) || contained(artifact.dataDirectory, file)) refuse("pinned metadata overlaps code or data");
    }
    if (artifact.runtimeSha256 !== runtimeSha256) refuse("stable runtime differs from artifact inventory");
    // Final fences after every async inventory/package/artifact read. A plan is
    // a momentary observation, not a durable capability to launch later.
    await recheckBootstrap();
    await recheckRuntime();
    await canonical(artifact.cwd, "directory");
    await canonical(artifact.environmentFile, "file");
    await canonical(artifact.dataDirectory, "future-directory");
    await metadataFile(manifestPath, 128 * 1024, bootstrapManifestSha256);
    await metadataFile(bindingPath, 32 * 1024, expectedSha256);
    await metadataFile(descriptorPath, 32 * 1024, descriptorSha256);
    return Object.freeze({ ...artifact, executable: stableRuntimePath, version: 1, status: "validated_not_launched", protocol: "deployment-plan-v1", bindingPath,
      bindingSha256: expectedSha256, bootstrapManifestSha256, runtimeSha256,
      launcherPath: path.join(bootstrapRoot, "launcher/VKodexSupervisor.exe"),
      launcherSha256: inventory.get("launcher/VKodexSupervisor.exe")!.sha256,
      supervisorPath: path.join(bootstrapRoot, "scripts/run-windows-supervisor.ps1"),
      watchdogPath: path.join(bootstrapRoot, "scripts/watch-windows-bridge.ps1") });
  } catch (error) {
    if (error instanceof RuntimeSetupError) throw error;
    refuse("required binding metadata unavailable");
  }
}

export async function planDeploymentAction(bindingPath: string, expectedSha256: string) {
  const plan = await validateDeploymentBinding(bindingPath, expectedSha256);
  return Object.freeze({ status: "proposed_action_not_installed", executable: plan.launcherPath, cwd: plan.cwd,
    arguments: Object.freeze(["--launch-binding", plan.bindingPath, "--launch-binding-sha256", plan.bindingSha256, "--operation", "supervise"]) });
}
