import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { comparablePath } from "../desktop/paths.js";
import type { OwnerAccess } from "./contracts.js";

export interface DesktopBridgeConfig {
  readonly access: OwnerAccess;
  readonly token: string;
  readonly dataDir: string;
  readonly codexHome: string;
  readonly codexHomes: readonly string[];
}

export function configuredCodexHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const resolve = (value: string): string => {
    const expanded = value === "~" ? os.homedir() : /^~[\\/]/u.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
    const absolute = path.resolve(expanded);
    try { return realpathSync.native(absolute); } catch { return absolute; }
  };
  const primary = resolve(env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"));
  let extra: unknown = [];
  try { extra = env.CODEX_EXTRA_HOMES?.trim() ? JSON.parse(env.CODEX_EXTRA_HOMES) : []; }
  catch { throw new Error("CODEX_EXTRA_HOMES must be a JSON array of directory paths"); }
  if (!Array.isArray(extra) || extra.length > 16 || extra.some(value => typeof value !== "string" || !value.trim() || /[\x00-\x1f]/u.test(value))) throw new Error("CODEX_EXTRA_HOMES must contain up to 16 non-empty directory paths");
  const result: string[] = []; const seen = new Set<string>();
  for (const value of [primary, ...extra as string[]]) {
    const home = resolve(value.trim()); const key = comparablePath(home);
    if (!seen.has(key)) { seen.add(key); result.push(home); }
  }
  return result;
}

export function loadDesktopBridgeConfig(env: NodeJS.ProcessEnv = process.env): DesktopBridgeConfig {
  const id = (name: string): number => {
    const raw = env[name]?.trim();
    const value = Number(raw);
    if (!raw || !/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value >= 2_000_000_000) throw new Error(`${name} must contain one valid numeric ID`);
    return value;
  };
  const token = env.VK_GROUP_TOKEN?.trim();
  if (!token) throw new Error("VK_GROUP_TOKEN is required");
  const codexHomes = configuredCodexHomes(env);
  return {
    token,
    access: { ownerId: id("VK_OWNER_ID"), groupId: id("VK_GROUP_ID") },
    dataDir: path.resolve(env.BOT_DATA_DIR || "./data/desktop"),
    codexHome: codexHomes[0]!, codexHomes,
  };
}
