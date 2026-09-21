import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { comparablePath } from "../core/paths.js";
import type { OwnerAccess } from "./contracts.js";

export interface DesktopBridgeConfig {
  readonly access: OwnerAccess;
  readonly token: string;
  readonly dataDir: string;
  readonly projectlessRoot: string;
  readonly codexHome: string;
  readonly codexHomes: readonly string[];
  readonly codexSources: readonly CodexSourceConfig[];
  readonly healthIntervalMs: number;
  readonly inboundFileLimits: { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly timeoutMs: number };
  /** DPAPI-protected file read by the local PowerShell helper on demand. */
  readonly documentTokenPath: string;
}

export type CodexLauncherConfig =
  | { readonly type: "desktop" }
  | { readonly type: "vscode"; readonly executable: string; readonly userDataDir: string; readonly arguments?: readonly string[] }
  | { readonly type: "command"; readonly executable: string; readonly arguments: readonly string[]; readonly environment?: Readonly<Record<string, string>> };

export interface CodexSourceConfig {
  readonly home: string;
  /** Explicit execution owner. Omitted keeps the existing UI-client contract. */
  readonly owner?: "client" | "app-server";
  readonly launcher?: CodexLauncherConfig;
}

function resolveDirectory(value: string): string {
  const expanded = value === "~" ? os.homedir() : /^~[\\/]/u.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  const absolute = path.resolve(expanded);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function cleanString(value: unknown, name: string, max = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/u.test(value)) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function launcher(value: unknown, index: number): CodexLauncherConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`CODEX_SOURCES[${index}].launcher must be an object`);
  const item = value as Record<string, unknown>;
  if (item.type === "desktop") return { type: "desktop" };
  if (item.type === "vscode") {
    const executable = cleanString(item.executable, `CODEX_SOURCES[${index}].launcher.executable`);
    const userDataDir = resolveDirectory(cleanString(item.userDataDir, `CODEX_SOURCES[${index}].launcher.userDataDir`));
    const args = item.arguments ?? [];
    if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== "string" || arg.length > 2_048 || /[\x00-\x1f]/u.test(arg))) throw new Error(`CODEX_SOURCES[${index}].launcher.arguments must be an array of strings`);
    return { type: "vscode", executable: path.resolve(executable), userDataDir, ...(args.length ? { arguments: args as string[] } : {}) };
  }
  if (item.type === "command") {
    const executable = cleanString(item.executable, `CODEX_SOURCES[${index}].launcher.executable`);
    if (!Array.isArray(item.arguments) || item.arguments.length > 64 || item.arguments.some(arg => typeof arg !== "string" || arg.length > 2_048 || /[\x00-\x1f]/u.test(arg))) throw new Error(`CODEX_SOURCES[${index}].launcher.arguments must be an array of strings`);
    const rawEnvironment = item.environment ?? {};
    if (!rawEnvironment || typeof rawEnvironment !== "object" || Array.isArray(rawEnvironment) || Object.keys(rawEnvironment).length > 32) throw new Error(`CODEX_SOURCES[${index}].launcher.environment must be an object`);
    const environment: Record<string, string> = {};
    for (const [key, entry] of Object.entries(rawEnvironment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || typeof entry !== "string" || entry.length > 8_192 || /\x00/u.test(entry)) throw new Error(`CODEX_SOURCES[${index}].launcher.environment contains an invalid entry`);
      environment[key] = entry;
    }
    return { type: "command", executable: path.resolve(executable), arguments: item.arguments as string[], ...(Object.keys(environment).length ? { environment } : {}) };
  }
  throw new Error(`CODEX_SOURCES[${index}].launcher.type is not supported`);
}

export function configuredCodexSources(env: NodeJS.ProcessEnv = process.env): CodexSourceConfig[] {
  const raw = env.CODEX_SOURCES?.trim();
  if (!raw) return configuredCodexHomes(env).map((home, index) => ({ home, ...(index === 0 ? { launcher: { type: "desktop" as const } } : {}) }));
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("CODEX_SOURCES must be a JSON array"); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 16) throw new Error("CODEX_SOURCES must contain from 1 to 16 sources");
  const result: CodexSourceConfig[] = []; const seen = new Set<string>();
  for (const [index, value] of parsed.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`CODEX_SOURCES[${index}] must be an object`);
    const item = value as Record<string, unknown>;
    const home = resolveDirectory(cleanString(item.home, `CODEX_SOURCES[${index}].home`));
    const key = comparablePath(home);
    if (seen.has(key)) throw new Error("CODEX_SOURCES contains duplicate homes");
    seen.add(key);
    const owner = item.owner === undefined ? undefined : item.owner;
    if (owner !== undefined && owner !== "client" && owner !== "app-server") throw new Error(`CODEX_SOURCES[${index}].owner is not supported`);
    const configuredLauncher = launcher(item.launcher, index);
    result.push({ home, ...(owner ? { owner } : {}), ...(configuredLauncher ? { launcher: configuredLauncher } : {}) });
  }
  return result;
}

export function configuredCodexHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = resolveDirectory(env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"));
  let extra: unknown = [];
  try { extra = env.CODEX_EXTRA_HOMES?.trim() ? JSON.parse(env.CODEX_EXTRA_HOMES) : []; }
  catch { throw new Error("CODEX_EXTRA_HOMES must be a JSON array of directory paths"); }
  if (!Array.isArray(extra) || extra.length > 16 || extra.some(value => typeof value !== "string" || !value.trim() || /[\x00-\x1f]/u.test(value))) throw new Error("CODEX_EXTRA_HOMES must contain up to 16 non-empty directory paths");
  const result: string[] = []; const seen = new Set<string>();
  for (const value of [primary, ...extra as string[]]) {
    const home = resolveDirectory(value.trim()); const key = comparablePath(home);
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
  const healthIntervalMs = Number(env.HEALTH_CHECK_INTERVAL_MS?.trim() || "60000");
  if (!Number.isSafeInteger(healthIntervalMs) || healthIntervalMs < 30_000 || healthIntervalMs > 60 * 60_000) throw new Error("HEALTH_CHECK_INTERVAL_MS must be between 30000 and 3600000");
  const positive = (name: string, fallback: number, maximum: number): number => {
    const value = Number(env[name]?.trim() || String(fallback));
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${name} must be a positive integer within its supported maximum`);
    return value;
  };
  const maxInboundFiles = positive("MAX_INBOUND_FILES", 10, 10);
  const maxInboundFileBytes = positive("MAX_INBOUND_FILE_BYTES", 200 * 1024 * 1024, 200 * 1024 * 1024);
  const maxInboundTotalBytes = positive("MAX_INBOUND_TOTAL_BYTES", 200 * 1024 * 1024, 200 * 1024 * 1024);
  if (maxInboundTotalBytes < maxInboundFileBytes) throw new Error("MAX_INBOUND_TOTAL_BYTES must not be smaller than MAX_INBOUND_FILE_BYTES");
  const downloadTimeoutMs = positive("DOWNLOAD_TIMEOUT_MS", 600_000, 60 * 60_000);
  const codexSources = configuredCodexSources(env);
  const codexHomes = codexSources.map(source => source.home);
  const automaticRoot = env.VKODEX_PROJECTLESS_ROOT?.trim();
  if (automaticRoot && /[\x00-\x1f]/u.test(automaticRoot)) throw new Error("VKODEX_PROJECTLESS_ROOT must be a valid directory path");
  const localData = env.LOCALAPPDATA?.trim() || env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  const documentTokenPath = path.resolve(env.VK_DOCUMENT_TOKEN_PATH?.trim() || path.join(localData, "VKodex", "secrets", "vk-document-token.xml"));
  return {
    token,
    access: { ownerId: id("VK_OWNER_ID"), groupId: id("VK_GROUP_ID") },
    dataDir: path.resolve(env.BOT_DATA_DIR || "./data/desktop"),
    projectlessRoot: path.resolve(automaticRoot || path.join(localData, "VKodex", "workspaces")),
    codexHome: codexHomes[0]!, codexHomes, codexSources, healthIntervalMs,
    inboundFileLimits: { maxFiles: maxInboundFiles, maxFileBytes: maxInboundFileBytes, maxTotalBytes: maxInboundTotalBytes, timeoutMs: downloadTimeoutMs },
    documentTokenPath,
  };
}
