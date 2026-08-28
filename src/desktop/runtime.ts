import { constants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export class RuntimeSetupError extends Error {}

export function windowsRuntimePath(localAppData: string | undefined): string {
  if (!localAppData || !path.win32.isAbsolute(localAppData) || path.win32.parse(localAppData).root.length < 3) throw new RuntimeSetupError("LOCALAPPDATA must be an absolute Windows path.");
  return path.win32.join(localAppData, "VKodex", "runtime", "VKodex.exe");
}

export interface RuntimeIdentity { readonly arch: string; readonly modules: string }

export function compatibleRuntime(actual: unknown, expected: RuntimeIdentity): boolean {
  if (actual === null || typeof actual !== "object") return false;
  const identity = actual as Record<string, unknown>;
  return identity.arch === expected.arch && identity.modules === expected.modules;
}

export async function prepareRuntime(): Promise<string> {
  if (process.platform !== "win32") return process.execPath;
  const executable = windowsRuntimePath(process.env.LOCALAPPDATA);
  await mkdir(path.dirname(executable), { recursive: true });
  try { await copyFile(process.execPath, executable, constants.COPYFILE_EXCL); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw new RuntimeSetupError("Could not install the private VKodex runtime.");
  }
  const file = await lstat(executable);
  if (!file.isFile() || file.isSymbolicLink()) throw new RuntimeSetupError("The private runtime path must contain a regular executable file.");
  const check = spawnSync(executable, ["-p", "JSON.stringify({arch:process.arch,modules:process.versions.modules})"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  let identity: unknown;
  try { identity = JSON.parse(check.stdout ?? ""); } catch { /* The failure below does not expose child output. */ }
  if (check.error || check.status !== 0 || !compatibleRuntime(identity, { arch: process.arch, modules: process.versions.modules })) {
    throw new RuntimeSetupError("The private runtime is unavailable or incompatible with Node.js. Stop VKodex, move its private VKodex.exe to the Recycle Bin, then run npm run runtime:prepare.");
  }
  return executable;
}

export function launchArguments(mode: string, extra: readonly string[] = []): string[] {
  if (extra.length > 0 && mode !== "probe") throw new RuntimeSetupError("Only desktop:probe accepts an optional task ID.");
  if (extra.length > 1) throw new RuntimeSetupError("desktop:probe accepts at most one task ID.");
  switch (mode) {
    case "dev": return ["--env-file=.env", "--import", "tsx", "src/desktop-main.ts"];
    case "start": return ["--env-file=.env", "dist/src/desktop-main.js"];
    case "check": return ["--env-file=.env", "--import", "tsx", "src/platforms/vk/check.ts"];
    case "probe": return ["--import", "tsx", "src/desktop/probe.ts", ...extra];
    default: throw new RuntimeSetupError("Unknown VKodex launch mode.");
  }
}
