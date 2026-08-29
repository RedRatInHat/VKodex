import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, type DesktopMetadata, type TaskRef } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";

type MetadataMethod = "thread/read" | "thread/name/set" | "thread/archive" | "thread/metadata/update";
const methods = new Set<MetadataMethod>(["thread/read", "thread/name/set", "thread/archive", "thread/metadata/update"]);

export function nativeCodexPath(): string {
  const cpu = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
  const suffix = ({ win32: "pc-windows-msvc", linux: "unknown-linux-musl", darwin: "apple-darwin" } as Record<string, string>)[process.platform];
  if (!cpu || !suffix) throw new DesktopUnavailableError("Эта платформа не поддерживает операции с метаданными Codex.");
  try {
    const require = createRequire(import.meta.url);
    const cliRequire = createRequire(require.resolve("@openai/codex/package.json"));
    const packageFile = cliRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const root = path.join(path.dirname(packageFile), "vendor", `${cpu}-${suffix}`);
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    const candidates = [path.join(root, "bin", name), path.join(root, "codex", name)];
    const binary = candidates.find(existsSync);
    if (binary) return binary;
  } catch { /* Present a static error, not local paths or subprocess output. */ }
  throw new DesktopUnavailableError("Не найден локальный Codex CLI из зависимостей VKodex.");
}

// This short-lived process only reads or changes metadata. It cannot create,
// resume, steer or start a task; execution remains with the live desktop owner.
export class MetadataRpc {
  constructor(
    private readonly codexHome: string,
    private readonly launch: () => ChildProcessWithoutNullStreams = () => spawn(nativeCodexPath(), ["app-server", "--stdio"], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...buildCodexEnvironment(process.env), CODEX_HOME: this.codexHome },
    }),
    private readonly timeoutMs = 30_000,
  ) {}

  async call(method: MetadataMethod, params: IpcObject): Promise<IpcObject> {
    if (!methods.has(method)) throw new ActionRejectedError("Операция не относится к метаданным Codex.");
    const child = this.launch();
    const mutating = method !== "thread/read";
    return new Promise((resolve, reject) => {
      let buffer = ""; let submitted = false; let finished = false;
      const close = (error?: Error, result?: IpcObject) => {
        if (finished) return;
        finished = true; clearTimeout(timer); child.stdin.end();
        const killTimer = setTimeout(() => child.kill(), 1_000);
        killTimer.unref(); child.once("close", () => clearTimeout(killTimer));
        if (error) reject(error); else resolve(result!);
      };
      const failed = () => close(submitted && mutating ? new UncertainActionError() : new DesktopUnavailableError("Локальный API метаданных Codex не ответил."));
      const timer = setTimeout(failed, this.timeoutMs);
      const send = (message: IpcObject) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stderr.resume();
      child.on("error", failed); child.on("exit", failed); child.stdin.on("error", failed);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (finished) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 * 1024) { failed(); return; }
        while (buffer.includes("\n") && !finished) {
          const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message: unknown;
          try { message = JSON.parse(line); } catch { failed(); return; }
          if (!isObject(message)) { failed(); return; }
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) {
            close(new ActionRejectedError("Codex отклонил операцию с метаданными. Проверь состояние задачи в десктопе.")); return;
          }
          if (!isObject(message.result)) { failed(); return; }
          if (message.id === 1 && !submitted) {
            send({ method: "initialized" }); submitted = true;
            send({ id: 2, method, params });
          } else if (message.id === 2 && submitted) close(undefined, message.result);
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "vkodex_metadata", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
    });
  }
}

export function conversationMarkdown(thread: IpcObject): string {
  if (!Array.isArray(thread.turns)) throw new DesktopUnavailableError("Codex не вернул историю переписки.");
  const title = typeof thread.name === "string" && thread.name ? thread.name.replace(/[\r\n]/gu, " ") : "Задача Codex";
  const sections = [`# ${title}`, "Экспорт видимой переписки на момент запроса. Без команд, файловых изменений и скрытых рассуждений."];
  let length = 0;
  for (const turn of thread.turns) {
    if (!isObject(turn) || !Array.isArray(turn.items) || turn.itemsView !== "full") throw new DesktopUnavailableError("Codex вернул неполную историю; экспорт отменён.");
    for (const item of turn.items) {
      if (!isObject(item)) continue;
      let text = ""; let heading = "";
      if (item.type === "userMessage" && Array.isArray(item.content)) {
        text = item.content.filter(isObject).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
        heading = "Пользователь";
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        text = item.text; heading = item.phase === "commentary" ? "Codex · ход работы" : "Codex";
      }
      if (!text.trim()) continue;
      length += Buffer.byteLength(text, "utf8");
      if (length > 2 * 1024 * 1024) throw new ActionRejectedError("Переписка больше 2 МБ. Экспорт целиком в VK отменён; используй экспорт из десктопа.");
      sections.push(`## ${heading}\n\n${text}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}

export class NativeDesktopMetadata implements DesktopMetadata {
  constructor(private readonly rpc: Pick<MetadataRpc, "call">) {}
  private local(task: TaskRef): void {
    if (task.hostId !== "local" || !task.threadId) throw new ActionRejectedError("Метаданные доступны только для локальных задач.");
  }
  async rename(task: TaskRef, title: string): Promise<void> {
    this.local(task); await this.rpc.call("thread/name/set", { threadId: task.threadId, name: title });
  }
  async archive(task: TaskRef): Promise<void> {
    this.local(task); await this.rpc.call("thread/archive", { threadId: task.threadId });
  }
  async markdown(task: TaskRef): Promise<string> {
    this.local(task);
    const response = await this.rpc.call("thread/read", { threadId: task.threadId, includeTurns: true });
    if (!isObject(response.thread) || response.thread.id !== task.threadId) throw new DesktopUnavailableError("Codex вернул другую задачу; экспорт отменён.");
    return conversationMarkdown(response.thread);
  }
  async assignProject(task: TaskRef, projectId: string | null): Promise<void> {
    this.local(task);
    await this.rpc.call("thread/metadata/update", { threadId: task.threadId, projectId: projectId ?? "" });
  }
}

export class ProfileDesktopMetadata implements DesktopMetadata {
  constructor(
    private readonly sourceHome: (task: TaskRef) => string,
    private readonly createMetadata: (home: string) => DesktopMetadata = home => new NativeDesktopMetadata(new MetadataRpc(home)),
  ) {}
  rename(task: TaskRef, title: string): Promise<void> { return this.createMetadata(this.sourceHome(task)).rename(task, title); }
  archive(task: TaskRef): Promise<void> { return this.createMetadata(this.sourceHome(task)).archive(task); }
  markdown(task: TaskRef): Promise<string> { return this.createMetadata(this.sourceHome(task)).markdown(task); }
  assignProject(task: TaskRef, projectId: string | null): Promise<void> { return this.createMetadata(this.sourceHome(task)).assignProject(task, projectId); }
}
