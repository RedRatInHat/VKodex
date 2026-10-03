import { spawn } from "node:child_process";
import { validateDeploymentBinding } from "./deployment-binding.js";
import { verifyDeploymentRuntime } from "./deployment-artifact.js";
import { RuntimeSetupError } from "./runtime.js";

/** Narrow startup-hook overrides, not a sandbox or a general environment filter.
 * The caller, this module, Node and the host's system interpreters must already
 * be trusted. Empty Node values also override hooks in the later --env-file.
 */
export function deploymentStartupEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...base };
  const cleared = new Set(["node_options", "node_path", "cor_profiler", "cor_profiler_path", "cor_profiler_path_32",
    "cor_profiler_path_64", "appdomain_manager_asm", "appdomain_manager_type", "complus_profapi_profilercompatibilitysetting"]);
  for (const key of Object.keys(result)) if (cleared.has(key.toLowerCase()) || key.toLowerCase() === "cor_enable_profiling") delete result[key];
  return { ...result, NODE_OPTIONS: "", NODE_PATH: "", COR_ENABLE_PROFILING: "0", COR_PROFILER: "", COR_PROFILER_PATH: "",
    COR_PROFILER_PATH_32: "", COR_PROFILER_PATH_64: "", APPDOMAIN_MANAGER_ASM: "", APPDOMAIN_MANAGER_TYPE: "" };
}

/** Explicit execution boundary. Does not install a task, prepare a runtime or
 * stop existing processes. Validation is point-in-time; a protected immutable
 * bundle is a deployment prerequisite, not supplied by a content hash alone.
 * The private planning CLI never imports this module.
 */
export async function executeDeployment(bindingPath: string, expectedSha256: string,
  operation: "plan-only" | "run-once" | "supervise" | "supervise-once"): Promise<number> {
  if (process.platform !== "win32") throw new RuntimeSetupError("Versioned executable launch requires Windows.");
  if (!["plan-only", "run-once", "supervise", "supervise-once"].includes(operation)) throw new RuntimeSetupError("Unsupported deployment operation.");
  const plan = await validateDeploymentBinding(bindingPath, expectedSha256);
  const recheck = await verifyDeploymentRuntime(plan.launcherPath, plan.launcherSha256);
  await recheck();
  return new Promise<number>((resolve, reject) => {
    const child = spawn(plan.launcherPath, ["--launch-binding", plan.bindingPath, "--launch-binding-sha256", plan.bindingSha256,
      "--operation", operation], { cwd: plan.cwd, env: deploymentStartupEnvironment(process.env), shell: false, windowsHide: true, stdio: "inherit" });
    child.once("error", () => reject(new RuntimeSetupError("Verified deployment launcher could not start.")));
    child.once("exit", code => resolve(code ?? 1));
  });
}
