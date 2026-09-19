import path from "node:path";

export function comparablePath(value: string): string {
  const plain = value.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\/u, "");
  if (process.platform === "win32" || /^[a-z]:[\\/]/iu.test(plain) || plain.startsWith("\\\\")) return path.win32.normalize(plain).replace(/[\\/]+$/u, "").toLowerCase();
  return path.resolve(plain).replace(/\/+$/u, "");
}

/**
 * Returns the CODEX_HOME that owns a rollout stored below `sessions` or
 * `archived_sessions`. A thread may legitimately acquire a new rollout file
 * after compaction, resumption, or a desktop migration, so the filename is not
 * a stable source identity.
 */
export function rolloutSourceHome(value: string): string | null {
  const comparable = comparablePath(value).replaceAll("\\", "/");
  const segments = comparable.split("/");
  const marker = segments.findLastIndex(segment => segment === "sessions" || segment === "archived_sessions");
  if (marker <= 0 || marker === segments.length - 1) return null;
  return segments.slice(0, marker).join("/") || "/";
}

export function sameRolloutSource(expected: string, actual: string): boolean {
  if (comparablePath(expected) === comparablePath(actual)) return true;
  const expectedHome = rolloutSourceHome(expected);
  const actualHome = rolloutSourceHome(actual);
  return expectedHome !== null && actualHome !== null && expectedHome === actualHome;
}
