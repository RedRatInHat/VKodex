import path from "node:path";

export function comparablePath(value: string): string {
  const plain = value.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\/u, "");
  if (process.platform === "win32" || /^[a-z]:[\\/]/iu.test(plain) || plain.startsWith("\\\\")) return path.win32.normalize(plain).replace(/[\\/]+$/u, "").toLowerCase();
  return path.resolve(plain).replace(/\/+$/u, "");
}
