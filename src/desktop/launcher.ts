import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CodexLauncherConfig, CodexSourceConfig } from "../bridge/config.js";
import { ActionRejectedError, DesktopUnavailableError, type DesktopTaskLauncher, type TaskRef } from "./contracts.js";
import { comparablePath } from "./paths.js";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";

type Spawn = (executable: string, args: readonly string[], options: {
  readonly detached: boolean;
  readonly windowsHide: boolean;
  readonly stdio: "ignore";
  readonly env: NodeJS.ProcessEnv;
}) => { once(event: "error" | "spawn", listener: () => void): unknown; unref(): void };

type DesktopExecutable = () => Promise<string | undefined>;

/** AppX updates replace the versioned ChatGPT.exe path. Resolve it at open time. */
export function installedCodexDesktopExecutable(): Promise<string | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  const script = "$p=@(Get-AppxPackage -Name 'OpenAI.Codex'|%{Join-Path $_.InstallLocation 'app\\ChatGPT.exe'}|?{Test-Path -LiteralPath $_ -PathType Leaf});if($p.Count -ne 1){exit 2};[Console]::Out.Write($p[0])";
  return new Promise(resolve => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      const executable = String(stdout ?? "").trim();
      const normalized = path.win32.normalize(executable).toLowerCase();
      resolve(!error && path.win32.isAbsolute(executable) && existsSync(executable)
        && normalized.startsWith("c:\\program files\\windowsapps\\openai.codex_")
        && normalized.endsWith("\\app\\chatgpt.exe") ? executable : undefined);
    }));
}

const replace = (value: string, task: TaskRef, home: string): string => value
  .replaceAll("{threadId}", task.threadId)
  .replaceAll("{codexHome}", home);

function externalCommand(uri: string): { executable: string; args: string[] } {
  if (process.platform === "win32") return { executable: "explorer.exe", args: [uri] };
  if (process.platform === "darwin") return { executable: "open", args: [uri] };
  return { executable: "xdg-open", args: [uri] };
}

export class SourceTaskLauncher implements DesktopTaskLauncher {
  private readonly sources = new Map<string, CodexSourceConfig>();

  constructor(
    sources: readonly CodexSourceConfig[],
    private readonly sourceHome: (task: TaskRef) => string,
    private readonly launch: Spawn = (executable, args, options) => spawn(executable, [...args], options),
    private readonly desktopExecutable: DesktopExecutable = installedCodexDesktopExecutable,
  ) {
    for (const source of sources) this.sources.set(comparablePath(source.home), source);
  }

  async open(task: TaskRef): Promise<void> {
    if (task.hostId !== "local" || !task.threadId) throw new ActionRejectedError("Автоматическое открытие доступно только локальным задачам Codex.");
    const home = this.sourceHome(task);
    const source = this.sources.get(comparablePath(home));
    if (!source) throw new DesktopUnavailableError("Для каталога задачи не найдена настройка запуска клиента Codex.");
    if (!source.launcher) throw new ActionRejectedError(`Для каталога «${path.basename(home)}» не настроено приложение Codex.`);
    const command = await this.command(source.launcher, task, home);
    if (path.isAbsolute(command.executable) && !existsSync(command.executable)) throw new ActionRejectedError("Настроенное приложение Codex не найдено. Проверь путь launcher в CODEX_SOURCES.");
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<Spawn>;
      try {
        child = this.launch(command.executable, command.args, { detached: true, windowsHide: false, stdio: "ignore", env: command.env });
      } catch {
        reject(new DesktopUnavailableError("Не удалось запустить настроенное приложение Codex.")); return;
      }
      child.once("error", () => reject(new DesktopUnavailableError("Не удалось запустить настроенное приложение Codex.")));
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }

  private async command(config: CodexLauncherConfig, task: TaskRef, home: string): Promise<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> {
    const env = { ...buildCodexEnvironment(process.env), CODEX_HOME: home };
    if (config.type === "desktop") {
      const uri = `codex://threads/${encodeURIComponent(task.threadId)}`;
      const executable = await this.desktopExecutable();
      const command = executable ? { executable, args: ["--open-url", uri] } : externalCommand(uri);
      return { ...command, env };
    }
    if (config.type === "vscode") {
      const uri = `vscode://openai.chatgpt/local/${encodeURIComponent(task.threadId)}`;
      return { executable: config.executable,
        args: [`--user-data-dir=${config.userDataDir}`, ...(config.arguments ?? []), "--open-url", uri], env };
    }
    return {
      executable: config.executable,
      args: config.arguments.map(value => replace(value, task, home)),
      env: { ...env, ...Object.fromEntries(Object.entries(config.environment ?? {}).map(([key, value]) => [key, replace(value, task, home)])) },
    };
  }
}
