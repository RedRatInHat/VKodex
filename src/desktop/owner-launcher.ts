import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serveOwnerChannel } from "./owner-channel.js";
import { OwnerTransport } from "./owner-transport.js";

interface LauncherConfig { version: 1; codexHome: string; nativeExecutable: string; extensionRegistry?: string }

/** Resolve the installed extension, not whichever stale version sorts last on disk. */
export async function resolveOwnerExecutable(config: Pick<LauncherConfig, "nativeExecutable" | "extensionRegistry">): Promise<string> {
  if (!config.extensionRegistry) return config.nativeExecutable;
  if (!path.isAbsolute(config.extensionRegistry)) throw new Error("Invalid extension registry path.");
  const entries: unknown = JSON.parse(await readFile(config.extensionRegistry, "utf8"));
  if (!Array.isArray(entries)) throw new Error("Invalid extension registry.");
  const matches = entries.filter(entry => entry?.identifier?.id === "openai.chatgpt");
  if (matches.length !== 1) throw new Error("Expected exactly one installed Codex extension.");
  const entry = matches[0];
  const location = entry.relativeLocation;
  if (typeof location !== "string" || !/^openai\.chatgpt-[a-z0-9.-]+$/iu.test(location)) throw new Error("Invalid Codex extension location.");
  const directory = path.join(path.dirname(config.extensionRegistry), location);
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt" || manifest.version !== entry.version) throw new Error("Codex extension identity mismatch.");
  // Keep the platform-specific suffix selected at installation, not a different binary.
  const executable = path.join(directory, "bin", path.basename(path.dirname(config.nativeExecutable)), path.basename(config.nativeExecutable));
  if (!(await stat(executable)).isFile()) throw new Error("Codex executable is not a file.");
  return executable;
}

export function ownerEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  // This process is launched by the IDE, not by a bridge worker. Preserve its
  // LSP/MCP, proxy and authentication environment; remove only VK bridge values.
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => !/^VK_/iu.test(key) && !/^VKODEX_/iu.test(key) && key !== "BOT_DATA_DIR")), CODEX_HOME: home };
}

export async function runOwnerLauncher(configFile: string, args: readonly string[]): Promise<number> {
  const value: unknown = JSON.parse(await readFile(configFile, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid launcher configuration.");
  const config = value as LauncherConfig;
  if (config.version !== 1 || ![config.codexHome, config.nativeExecutable].every(p => typeof p === "string" && path.isAbsolute(p) && !/[\x00-\x1f]/u.test(p))) throw new Error("Invalid launcher paths.");
  const serverIndex = args.indexOf("app-server");
  const hasSubcommand = args.slice(serverIndex + 1).some(arg => ["daemon", "proxy", "generate-ts", "generate-json-schema", "help"].includes(arg));
  const adapt = serverIndex >= 0 && !hasSubcommand && !args.some(arg => ["--help", "-h", "--version", "--listen"].includes(arg) || arg.startsWith("--listen="));
  const executable = await resolveOwnerExecutable(config);
  const child = spawn(executable, [...args], {
    windowsHide: true,
    stdio: adapt ? ["pipe", "pipe", "inherit"] : "inherit",
    env: ownerEnvironment(process.env, config.codexHome),
  });
  let transport: OwnerTransport | undefined;
  let channel: Awaited<ReturnType<typeof serveOwnerChannel>> | undefined;
  // Unlike metadata writer release, a stdio proxy must drain the final response
  // before exiting; Windows can emit process exit well before pipe close.
  const exited = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
  // Attach the rejection handler immediately; spawn failure can race registry creation.
  void exited.catch(() => {});
  try {
    if (adapt && child.stdin && child.stdout) {
      transport = new OwnerTransport(child.stdin, child.stdout, process.stdin, process.stdout);
      try { channel = await serveOwnerChannel(config.codexHome, transport); }
      catch { process.stderr.write("VKodex owner channel unavailable; native client transport remains connected.\n"); }
    }
    return await exited;
  } finally {
    transport?.close();
    await channel?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runOwnerLauncher(process.argv[2] ?? "", process.argv.slice(3)).then(code => {
    // The parent can keep stdin open after native exit. No owner remains to serve it.
    process.exit(code);
  }, () => {
    process.stderr.write("VKodex owner launcher failed. Check its local configuration and native executable.\n");
    process.exit(1);
  });
}
