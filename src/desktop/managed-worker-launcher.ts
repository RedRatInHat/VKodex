import { spawn, type SpawnOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ManagedWorkerRegistry } from '../codex/managed-worker-registry.js';
import { createManagedWorkerPrivateState, type ManagedWorkerPrivateManifest } from './managed-worker-private-state.js';

export interface ManagedWorkerLaunchOptions extends Omit<ManagedWorkerPrivateManifest, 'schemaVersion' | 'epoch'> {
  readonly privateBaseDirectory: string;
  /** Explicitly opt into the local native broker; no shared IPC route is implied. */
  readonly nativeIpc: 'local';
  /** Caller deploys a trusted compiled runtime bundle; entrypoint pin is not a signature for its imports. */
  readonly runtime: Readonly<{ executable: string; sha256: string; entrypoint: string; entrypointSha256: string }>;
}
type DetachedChild = Pick<EventEmitter, 'once'> & { readonly pid?: number; unref(): void };
/** Dependency injection for tests, never selected by an untrusted launch payload. */
export interface ManagedWorkerLaunchDependencies {
  readonly protectState?: (manifest: ManagedWorkerPrivateManifest, baseDirectory: string) => Promise<void>;
  readonly spawn?: (executable: string, args: string[], options: SpawnOptions) => DetachedChild;
}
export class ManagedWorkerLaunchError extends Error {
  constructor(readonly epoch: string, readonly phase: 'private-state' | 'spawn',
    readonly outcome: 'not-dispatched' | 'unknown') {
    super(`Managed worker launch ${phase}: ${outcome}; reservation retained`);
    this.name = 'ManagedWorkerLaunchError';
  }
}
function absolute(value: string): void {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value))
    throw new TypeError('Managed worker launch requires absolute paths');
}
async function pinnedFile(file: string, expected: string): Promise<void> {
  absolute(file);
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/iu.test(expected))
    throw new TypeError('Invalid managed worker executable pin');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid managed worker executable file');
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== expected.toLowerCase())
    throw new Error('Managed worker executable pin mismatch');
}
async function verifyPinnedFiles(input: ManagedWorkerLaunchOptions): Promise<void> {
  await Promise.all([
    pinnedFile(input.cliPath, input.cliSha256),
    pinnedFile(input.runtime.executable, input.runtime.sha256),
    pinnedFile(input.runtime.entrypoint, input.runtime.entrypointSha256),
  ]);
}

/** Opt-in only. Parent does not hold worker pipes, restart it, or equate spawn with readiness.
 * Failed/uncertain launches retain their reservation for explicit reconciliation. */
export async function launchManagedWorker(options: ManagedWorkerLaunchOptions,
  dependencies: ManagedWorkerLaunchDependencies = {}): Promise<Readonly<{ epoch: string; state: 'dispatched'; pid: number }>> {
  // Capture caller-owned objects before the first asynchronous step.
  const input = structuredClone(options);
  for (const file of [input.home, input.cwd, input.registryPath, input.privateBaseDirectory]) absolute(file);
  if (input.nativeIpc !== 'local') throw new TypeError('Managed worker launch requires local native IPC');
  for (const value of [input.taskId, input.familyRoot]) {
    if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f]/u.test(value))
      throw new TypeError('Invalid managed worker launch scope');
  }
  if (path.extname(input.runtime.entrypoint).toLowerCase() !== '.js')
    throw new TypeError('Managed worker entrypoint must be compiled JavaScript');
  await verifyPinnedFiles(input);
  const registry = new ManagedWorkerRegistry(input.registryPath);
  let epoch: string;
  try { epoch = registry.reserve(input.home, input.familyRoot).epoch; }
  finally { registry.close(); }
  const manifest: ManagedWorkerPrivateManifest = {
    schemaVersion: 1, epoch, taskId: input.taskId, familyRoot: input.familyRoot,
    home: input.home, cwd: input.cwd, registryPath: input.registryPath,
    cliPath: input.cliPath, cliSha256: input.cliSha256,
    initializeRequest: input.initializeRequest, resumeParams: input.resumeParams,
  };
  try {
    if (dependencies.protectState) await dependencies.protectState(manifest, input.privateBaseDirectory);
    else await createManagedWorkerPrivateState(manifest, { baseDirectory: input.privateBaseDirectory });
  } catch { throw new ManagedWorkerLaunchError(epoch, 'private-state', 'not-dispatched'); }
  try { await verifyPinnedFiles(input); }
  catch { throw new ManagedWorkerLaunchError(epoch, 'spawn', 'not-dispatched'); }
  const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: input.home };
  // A native client's Node/Electron bootstrap/debug hooks must not become daemon hooks.
  for (const key of Object.keys(environment)) {
    if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'VSCODE_INSPECTOR_OPTIONS'].includes(key.toUpperCase()))
      delete environment[key];
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (outcome: 'not-dispatched' | 'unknown'): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(new ManagedWorkerLaunchError(epoch, 'spawn', outcome));
    };
    const timer = setTimeout(() => fail('unknown'), 10_000);
    try {
      const child = (dependencies.spawn ?? spawn)(input.runtime.executable,
        [input.runtime.entrypoint, '--private-base', input.privateBaseDirectory, '--epoch', epoch, '--native-ipc', input.nativeIpc],
        { cwd: input.cwd, env: environment, shell: false, detached: true, windowsHide: true, stdio: 'ignore' });
      // No exit/EOF listener kills a worker; the durable registry/control plane reports its state.
      child.once('error', () => fail('not-dispatched'));
      child.once('spawn', () => {
        try { child.unref(); } catch { fail('unknown'); return; }
        if (settled) return;
        if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) { fail('unknown'); return; }
        settled = true; clearTimeout(timer);
        resolve(Object.freeze({ epoch, state: 'dispatched', pid: child.pid! }));
      });
    } catch { fail('not-dispatched'); }
  });
}
