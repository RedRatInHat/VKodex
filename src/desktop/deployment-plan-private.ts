import { deploymentBindingArguments, validateDeploymentBinding } from "./deployment-binding.js";
import { RuntimeSetupError } from "./runtime.js";

// Private data protocol for a future verified parent. No env-file loading,
// imports from the observed bundle/artifact, subprocess or installation action.
// Parent must independently verify trusted Node and this code BEFORE starting
// this CLI, and revalidate the plan immediately before any actual launch.
try {
  const { bindingPath, expectedSha256 } = deploymentBindingArguments(process.argv.slice(2));
  const plan = await validateDeploymentBinding(bindingPath, expectedSha256);
  const text = JSON.stringify(plan);
  if (Buffer.byteLength(text) > 16 * 1024) throw new RuntimeSetupError("Launch plan exceeds private protocol limit.");
  process.stdout.write(`${text}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof RuntimeSetupError ? error.message : "Launch plan validation failed."}\n`);
  process.exitCode = 1;
}
