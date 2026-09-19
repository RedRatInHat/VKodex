import { spawn } from "node:child_process";
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
  ) {
    for (const source of sources) this.sources.set(comparablePath(source.home), source);
  }

  async open(task: TaskRef): Promise<void> {
    if (task.hostId !== "local" || !task.threadId) throw new ActionRejectedError("Автоматическое открытие доступно только локальным задачам Codex.");
    const home = this.sourceHome(task);
    const source = this.sources.get(comparablePath(home));
    if (!source) throw new DesktopUnavailableError("Для каталога задачи не найдена настройка запуска клиента Codex.");
    if (!source.launcher) throw new ActionRejectedError(`Для каталога «${path.basename(home)}» не настроено приложение Codex.`);
    const command = this.command(source.launcher, task, home);
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

  private command(config: CodexLauncherConfig, task: TaskRef, home: string): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
    const env = { ...buildCodexEnvironment(process.env), CODEX_HOME: home };
    if (config.type === "desktop") {
      const command = externalCommand(`codex://threads/${encodeURIComponent(task.threadId)}`);
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
