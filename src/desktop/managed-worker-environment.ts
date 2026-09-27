import type { SpawnOptions } from 'node:child_process';

/** Copies the parent environment without bridge secrets or executable runtime hooks.
 * Preserve unrelated proxy, TLS trust, PATH, and Codex authentication settings. */
export function buildManagedWorkerEnvironment(source: Readonly<NodeJS.ProcessEnv>,
  home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const blocked = new Set(['BOT_DATA_DIR', 'NODE_OPTIONS', 'NODE_PATH',
    'ELECTRON_RUN_AS_NODE', 'VSCODE_INSPECTOR_OPTIONS']);
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (normalized === 'CODEX_HOME' || blocked.has(normalized) ||
      normalized.startsWith('VK_') || normalized.startsWith('VKODEX_')) continue;
    result[key] = value;
  }
  result.CODEX_HOME = home;
  return result;
}

/** The launcher and backend use the same copy policy at their final spawn boundaries. */
export function buildDetachedWorkerSpawnOptions(cwd: string, home: string,
  source: Readonly<NodeJS.ProcessEnv>): SpawnOptions {
  return { cwd, env: buildManagedWorkerEnvironment(source, home),
    shell: false, detached: true, windowsHide: true, stdio: 'ignore' };
}

export function buildBackendWorkerSpawnOptions(cwd: string, home: string,
  source: Readonly<NodeJS.ProcessEnv>): SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } {
  return { cwd, env: buildManagedWorkerEnvironment(source, home),
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
}
