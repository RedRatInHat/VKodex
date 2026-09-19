import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DesktopUnavailableError } from "../core/codex-tasks.js";

/** Resolves the Codex CLI bundled with VKodex, independent of any UI client. */
export function nativeCodexPath(): string {
  const cpu = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
  const suffix = ({ win32: "pc-windows-msvc", linux: "unknown-linux-musl", darwin: "apple-darwin" } as Record<string, string>)[process.platform];
  if (!cpu || !suffix) throw new DesktopUnavailableError("Эта платформа не поддерживает локальный Codex CLI.");
  try {
    const require = createRequire(import.meta.url);
    const cliRequire = createRequire(require.resolve("@openai/codex/package.json"));
    const packageFile = cliRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const root = path.join(path.dirname(packageFile), "vendor", `${cpu}-${suffix}`);
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    const binary = [path.join(root, "bin", name), path.join(root, "codex", name)].find(existsSync);
    if (binary) return binary;
  } catch { /* Present a static error, not local paths or subprocess output. */ }
  throw new DesktopUnavailableError("Не найден локальный Codex CLI из зависимостей VKodex.");
}
