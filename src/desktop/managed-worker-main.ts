import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopIpcClient } from './ipc-client.js';

export function parseManagedWorkerArguments(args: readonly string[]): Readonly<{
  baseDirectory: string; epoch: string; nativeIpc: 'local';
}> {
  if (args.length !== 6 || args[0] !== '--private-base' || args[2] !== '--epoch' ||
      args[4] !== '--native-ipc' || args[5] !== 'local' ||
      !path.isAbsolute(args[1] ?? '') || /[\u0000-\u001f]/u.test(args[1] ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(args[3] ?? ''))
    throw new TypeError('Invalid managed worker arguments');
  return Object.freeze({ baseDirectory: args[1]!, epoch: args[3]!, nativeIpc: 'local' });
}

async function main(): Promise<void> {
  const options = parseManagedWorkerArguments(process.argv.slice(2));
  const { ManagedWorkerDaemon } = await import('./managed-worker-daemon.js');
  const daemon = new ManagedWorkerDaemon({
    baseDirectory: options.baseDirectory, epoch: options.epoch,
    // The explicit local-native launch opts into this user's native broker.
    // sourceClientId is routing metadata, not independently authenticated identity.
    allowFollower: source => typeof source === 'string' && source.length > 0 &&
      source.length <= 256 && !/[\u0000-\u001f]/u.test(source),
    clientFactory: handler => new DesktopIpcClient(() => createConnection('\\\\.\\pipe\\codex-ipc'), 5000, handler),
    // Never infer family quiescence from an idle parent. The initial CLI route
    // intentionally refuses stop until a qualified family observer is installed.
    verifyFamilyQuiescent: async () => false,
  });
  await daemon.start();
  // Live listeners own the lifetime. No parent IPC, EOF, SIGINT relay or restart loop.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    // Keep any already-started worker handles alive for explicit reconciliation.
    // Do not expose private manifest, commands, prompts, keys or native error text.
    process.stderr.write('Managed worker startup failed; inspect its reserved epoch.\n');
    process.exitCode = 1;
  });
}
