import { deploymentValidationArguments, validateDeploymentArtifact } from "./deployment-artifact.js";
import { RuntimeSetupError } from "./runtime.js";

// Deliberately separate from launch.ts: no runtime:prepare, .env loader,
// process launch, database, scheduled task or production imports.
try {
  const { descriptorPath, expectedSha256 } = deploymentValidationArguments(process.argv.slice(2));
  const plan = await validateDeploymentArtifact(descriptorPath, expectedSha256);
  process.stdout.write(`${JSON.stringify({ status: "validated_not_launched", descriptorSha256: plan.descriptorSha256,
    manifestSha256: plan.manifestSha256, sourceCommit: plan.sourceCommit, sourceTree: plan.sourceTree })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof RuntimeSetupError ? error.message : "Artifact validation failed."}\n`);
  process.exitCode = 1;
}
