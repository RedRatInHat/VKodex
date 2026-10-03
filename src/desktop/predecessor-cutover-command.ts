import { predecessorCutoverArguments, stopPinnedPredecessor } from './predecessor-cutover-controller.js';

// This trusted command must be started independently of the selected old
// Codex/bridge process tree and only after explicit fresh operator approval.
// No env-file import, PID discovery, automatic launch/retry or installation.
try {
  const invocation = predecessorCutoverArguments(process.argv.slice(2));
  const result = await stopPinnedPredecessor(invocation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.kind !== 'known-predecessor-stopped') process.exitCode = 87;
} catch {
  process.stderr.write('Predecessor cutover refused. Do not replay unknown operations.\n');
  process.exitCode = 87;
}
