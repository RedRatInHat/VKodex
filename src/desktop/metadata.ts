import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, type AccountRateLimit, type AccountRateLimitWindow, type AccountUsage, type AccountUsageProvider, type DesktopGoals, type DesktopMetadata, type TaskGoal, type TaskGoalStatus, type TaskGoalUpdate, type TaskRef } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";

type MetadataMethod = "thread/read" | "thread/name/set" | "thread/archive" | "thread/metadata/update" | "thread/goal/get" | "thread/goal/set" | "thread/goal/clear" | "account/read" | "account/rateLimits/read";
const methods = new Set<MetadataMethod>(["thread/read", "thread/name/set", "thread/archive", "thread/metadata/update", "thread/goal/get", "thread/goal/set", "thread/goal/clear", "account/read", "account/rateLimits/read"]);

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

// This short-lived process exposes a fixed allowlist of metadata, account and
// goal methods. It cannot submit arbitrary task input or call turn APIs.
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
    const mutating = !["thread/read", "thread/goal/get", "account/read", "account/rateLimits/read"].includes(method);
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

function rateLimitWindow(value: unknown): AccountRateLimitWindow | null {
  if (!isObject(value)) return null;
  const usedPercent = value.usedPercent; const windowMinutes = value.windowDurationMins; const resetsAt = value.resetsAt;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100
    || typeof windowMinutes !== "number" || !Number.isSafeInteger(windowMinutes) || windowMinutes <= 0
    || typeof resetsAt !== "number" || !Number.isSafeInteger(resetsAt) || resetsAt <= 0 || resetsAt > 8_640_000_000_000) return null;
  return { usedPercent, windowMinutes, resetsAt };
}

function rateLimit(value: unknown): AccountRateLimit | null {
  if (!isObject(value) || typeof value.limitId !== "string" || !/^[\w.-]{1,100}$/u.test(value.limitId)) return null;
  const name = typeof value.limitName === "string" && value.limitName.trim() && value.limitName.length <= 120 && !/[\r\n\x00-\x1f]/u.test(value.limitName) ? value.limitName.trim() : null;
  const primary = rateLimitWindow(value.primary); const secondary = rateLimitWindow(value.secondary);
  if (!primary && !secondary) return null;
  return { id: value.limitId, name, primary, secondary };
}

export function parseAccountUsage(response: IpcObject, accountLabel: string | null = null, sourceLabel: string | null = null): AccountUsage {
  const overall = isObject(response.rateLimits) ? response.rateLimits : null;
  const byId = isObject(response.rateLimitsByLimitId) ? Object.values(response.rateLimitsByLimitId).map(rateLimit).filter((limit): limit is AccountRateLimit => !!limit) : [];
  const fallback = rateLimit(overall); const candidates = fallback ? [fallback, ...byId] : byId;
  const limits = candidates.filter((limit, index) => candidates.findIndex(candidate => candidate.id === limit.id) === index);
  if (!limits.length) throw new DesktopUnavailableError("Codex не вернул данные о лимитах аккаунта.");
  const planType = typeof overall?.planType === "string" && /^[\w.-]{1,40}$/u.test(overall.planType) ? overall.planType : null;
  const rawCredits = isObject(overall?.credits) ? overall.credits : null;
  const credits = rawCredits && typeof rawCredits.hasCredits === "boolean" && typeof rawCredits.unlimited === "boolean"
    ? { hasCredits: rawCredits.hasCredits, unlimited: rawCredits.unlimited, balance: typeof rawCredits.balance === "string" && /^\d+(?:[.,]\d+)?$/u.test(rawCredits.balance) ? rawCredits.balance : null } : null;
  const reset = isObject(response.rateLimitResetCredits) ? response.rateLimitResetCredits.availableCount : null;
  const resetCredits = typeof reset === "number" && Number.isSafeInteger(reset) && reset >= 0 ? reset : null;
  return { accountLabel, sourceLabel, planType, limits, credits, resetCredits };
}

export function parseAccountLabel(response: IpcObject): string | null {
  if (!isObject(response.account)) return null;
  const clean = (value: unknown, max: number): string | null => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    && !/[\r\n\x00-\x1f]/u.test(value) ? value.trim() : null;
  const name = clean(response.account.name, 120);
  const email = clean(response.account.email, 254);
  if (name && email) return `${name} · ${email}`;
  if (email) return email;
  if (name) return name;
  return response.account.type === "apiKey" ? "API key" : response.account.type === "chatgpt" ? "ChatGPT" : null;
}

export class NativeAccountUsage {
  constructor(private readonly rpc: Pick<MetadataRpc, "call">) {}
  async read(): Promise<AccountUsage> {
    const [account, limits] = await Promise.allSettled([
      this.rpc.call("account/read", { refreshToken: false }),
      this.rpc.call("account/rateLimits/read", {}),
    ]);
    if (limits.status === "rejected") throw limits.reason;
    return parseAccountUsage(limits.value, account.status === "fulfilled" ? parseAccountLabel(account.value) : null);
  }
}

export class ProfileAccountUsage implements AccountUsageProvider {
  constructor(
    private readonly homes: readonly string[],
    private readonly sourceHome: (task: TaskRef) => string,
    private readonly createReader: (home: string) => Pick<NativeAccountUsage, "read"> = home => new NativeAccountUsage(new MetadataRpc(home)),
  ) {}
  async read(task?: TaskRef): Promise<readonly AccountUsage[]> {
    const homes = task ? [this.sourceHome(task)] : this.homes;
    return Promise.all(homes.map(async home => ({ ...await this.createReader(home).read(), sourceLabel: path.basename(home) })));
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

const goalStatuses = new Set<TaskGoalStatus>(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

export function parseTaskGoal(value: unknown, expectedThreadId: string): TaskGoal | null {
  if (value === null) return null;
  if (!isObject(value)
    || value.threadId !== expectedThreadId
    || typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 16_000
    || typeof value.status !== "string" || !goalStatuses.has(value.status as TaskGoalStatus)
    || !(value.tokenBudget === null || (typeof value.tokenBudget === "number" && Number.isSafeInteger(value.tokenBudget) && value.tokenBudget > 0))
    || typeof value.tokensUsed !== "number" || !Number.isSafeInteger(value.tokensUsed) || value.tokensUsed < 0
    || typeof value.timeUsedSeconds !== "number" || !Number.isSafeInteger(value.timeUsedSeconds) || value.timeUsedSeconds < 0
    || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
    || typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) {
    throw new DesktopUnavailableError("Codex вернул некорректное состояние цели.");
  }
  return {
    threadId: value.threadId,
    objective: value.objective,
    status: value.status as TaskGoalStatus,
    tokenBudget: value.tokenBudget,
    tokensUsed: value.tokensUsed,
    timeUsedSeconds: value.timeUsedSeconds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export class NativeDesktopGoals implements DesktopGoals {
  constructor(private readonly rpc: Pick<MetadataRpc, "call">) {}
  private local(task: TaskRef): void {
    if (task.hostId !== "local" || !task.threadId) throw new ActionRejectedError("Цели доступны только для локальных задач.");
  }
  async get(task: TaskRef): Promise<TaskGoal | null> {
    this.local(task);
    const response = await this.rpc.call("thread/goal/get", { threadId: task.threadId });
    return parseTaskGoal(response.goal ?? null, task.threadId);
  }
  async set(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> {
    this.local(task);
    const objective = update.objective?.trim();
    if (objective !== undefined && (!objective || objective.length > 8_000 || /\x00/u.test(objective))) throw new ActionRejectedError("Цель должна содержать от 1 до 8000 символов.");
    if (update.status !== undefined && !goalStatuses.has(update.status)) throw new ActionRejectedError("Некорректный статус цели.");
    if (update.tokenBudget !== undefined && update.tokenBudget !== null && (!Number.isSafeInteger(update.tokenBudget) || update.tokenBudget <= 0 || update.tokenBudget > 100_000_000)) {
      throw new ActionRejectedError("Лимит цели должен быть от 1 до 100 000 000 токенов.");
    }
    if (objective === undefined && update.status === undefined && update.tokenBudget === undefined) throw new ActionRejectedError("Изменения цели не указаны.");
    const response = await this.rpc.call("thread/goal/set", {
      threadId: task.threadId,
      ...(objective !== undefined ? { objective } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.tokenBudget !== undefined ? { tokenBudget: update.tokenBudget } : {}),
    });
    return parseTaskGoal(response.goal, task.threadId)!;
  }
  async clear(task: TaskRef): Promise<boolean> {
    this.local(task);
    const response = await this.rpc.call("thread/goal/clear", { threadId: task.threadId });
    if (typeof response.cleared !== "boolean") throw new DesktopUnavailableError("Codex не подтвердил снятие цели.");
    return response.cleared;
  }
}

export class ProfileDesktopGoals implements DesktopGoals {
  constructor(
    private readonly sourceHome: (task: TaskRef) => string,
    private readonly createGoals: (home: string) => DesktopGoals = home => new NativeDesktopGoals(new MetadataRpc(home)),
  ) {}
  get(task: TaskRef): Promise<TaskGoal | null> { return this.createGoals(this.sourceHome(task)).get(task); }
  set(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> { return this.createGoals(this.sourceHome(task)).set(task, update); }
  clear(task: TaskRef): Promise<boolean> { return this.createGoals(this.sourceHome(task)).clear(task); }
}
