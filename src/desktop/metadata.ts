import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, ArchiveOwnerRequiredError, DesktopUnavailableError, UncertainActionError, TransferConflictError, type AccountRateLimit, type AccountRateLimitWindow, type AccountUsage, type AccountUsageProvider, type DesktopGoals, type DesktopMetadata, type TaskGoal, type TaskGoalUpdate, type TaskRef, type SubmitTaskRequest, type TransferCheckpoint, type UsageResetOutcome } from "./contracts.js";
import { normalizeTaskGoalUpdate, parseTaskGoal } from "../core/task-goals.js";
export { parseTaskGoal } from "../core/task-goals.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { mirrorLegacyProjectAssignment } from "./projects.js";
import { comparablePath } from "./paths.js";
import { closeAppServer } from "./app-server-process.js";
import { archiveThroughOwner, inspectThroughOwner } from "./owner-channel.js";
import { OwnerTransportError } from "./owner-transport.js";
import { completedHistoryDigest } from "./history-digest.js";
import { findAcceptedInputTurn } from "./input-reconciliation.js";
export { nativeCodexPath } from "../codex/native-cli.js";
import { nativeCodexPath } from "../codex/native-cli.js";

export type LocalAppServerMethod = "model/list" | "thread/queue/add" | "thread/read" | "thread/turns/list" | "thread/name/set" | "thread/archive" | "thread/metadata/update" | "thread/goal/get" | "thread/goal/set" | "thread/goal/clear" | "account/read" | "account/rateLimits/read" | "account/rateLimitResetCredit/consume";
const methods = new Set<LocalAppServerMethod>(["model/list","thread/queue/add","thread/read", "thread/turns/list", "thread/name/set", "thread/archive", "thread/metadata/update", "thread/goal/get", "thread/goal/set", "thread/goal/clear", "account/read", "account/rateLimits/read", "account/rateLimitResetCredit/consume"]);

function rejectedMetadata(method: LocalAppServerMethod, error: unknown): ActionRejectedError {
  if (method === "thread/queue/add") return new ActionRejectedError("Codex отклонил добавление в штатную очередь. Проверь версию Codex и состояние задачи. В текущий ход запрос не отправлялся.");
  const message = isObject(error) && typeof error.message === "string" ? error.message : "";
  if (method === "thread/archive" && /invalid filename/iu.test(message)) {
    return new ActionRejectedError("Codex не может архивировать задачу: файл её истории имеет нестандартное имя.");
  }
  if (method === "thread/archive" && /already has an active writer/iu.test(message)) {
    return new ArchiveOwnerRequiredError();
  }
  if (method === "account/rateLimitResetCredit/consume") {
    return new ActionRejectedError("Codex отклонил сброс лимита. Обнови /limits и проверь доступные кредиты выбранного аккаунта.");
  }
  return new ActionRejectedError("Codex отклонил операцию с метаданными. Проверь состояние задачи в десктопе.");
}

// This short-lived process exposes a fixed allowlist for metadata, account and
// goal methods. It cannot submit input or call turn APIs.
export class MetadataRpc {
  constructor(
    private readonly codexHome: string,
    private readonly launch: () => ChildProcessWithoutNullStreams = () => spawn(nativeCodexPath(), ["app-server", "--stdio"], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...buildCodexEnvironment(process.env), CODEX_HOME: this.codexHome },
    }),
    private readonly timeoutMs = 30_000,
  ) {}

  async call(method: LocalAppServerMethod, params: IpcObject): Promise<IpcObject> {
    if (!methods.has(method)) throw new ActionRejectedError("Операция не относится к метаданным Codex.");
    const child = this.launch();
    const mutating = !["model/list","thread/read", "thread/turns/list", "thread/goal/get", "account/read", "account/rateLimits/read"].includes(method);
    return new Promise((resolve, reject) => {
      let buffer = ""; let submitted = false; let finished = false;
      const close = (error?: Error, result?: IpcObject) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        void closeAppServer(child).then(() => { if (error) reject(error); else resolve(result!); },
          () => reject(submitted && mutating ? new UncertainActionError() : new DesktopUnavailableError("Процесс метаданных Codex не завершился вовремя.")));
      };
      const failed = () => close(submitted && mutating ? new UncertainActionError() : new DesktopUnavailableError("Локальный API метаданных Codex не ответил."));
      const timer = setTimeout(failed, this.timeoutMs);
      const send = (message: IpcObject) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stderr.resume();
      child.on("error", failed); child.on("close", failed); child.stdin.on("error", failed);
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
            close(rejectedMetadata(method, message.error)); return;
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
  async consumeReset(idempotencyKey: string): Promise<UsageResetOutcome> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) {
      throw new ActionRejectedError("Некорректный идентификатор операции сброса лимита.");
    }
    const response = await this.rpc.call("account/rateLimitResetCredit/consume", { idempotencyKey });
    const outcomes = new Set<UsageResetOutcome>(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]);
    if (typeof response.outcome !== "string" || !outcomes.has(response.outcome as UsageResetOutcome)) {
      throw new UncertainActionError();
    }
    return response.outcome as UsageResetOutcome;
  }
}

export class ProfileAccountUsage implements AccountUsageProvider {
  constructor(
    private readonly homes: readonly string[],
    private readonly sourceHome: (task: TaskRef) => string,
    private readonly createReader: (home: string) => Pick<NativeAccountUsage, "read"> & Partial<Pick<NativeAccountUsage, "consumeReset">> = home => new NativeAccountUsage(new MetadataRpc(home)),
    private readonly listSources: () => readonly { readonly id: string; readonly label: string }[] = () =>
      homes.map((home, index) => ({ id: index === 0 ? "" : path.basename(home), label: path.basename(home) })),
  ) {}
  private source(home: string): { readonly id: string; readonly label: string } | null {
    for (const source of this.listSources()) {
      try {
        if (comparablePath(this.sourceHome({ hostId: "local", threadId: "", ...(source.id ? { sourceId: source.id } : {}) })) === comparablePath(home)) return source;
      } catch { /* Ignore sources removed during this read. */ }
    }
    return null;
  }
  async read(task?: TaskRef): Promise<readonly AccountUsage[]> {
    const homes = task ? [this.sourceHome(task)] : this.homes;
    return Promise.all(homes.map(async home => {
      const source = this.source(home);
      const sourceId = task?.sourceId ?? source?.id ?? (home === this.homes[0] ? "" : undefined);
      return { ...await this.createReader(home).read(), sourceLabel: source?.label ?? path.basename(home), ...(sourceId === undefined ? {} : { sourceId }) };
    }));
  }
  async consumeReset(task: TaskRef, idempotencyKey: string): Promise<UsageResetOutcome> {
    const reader = this.createReader(this.sourceHome(task));
    if (!reader.consumeReset) throw new ActionRejectedError("Сброс лимита недоступен в этом подключении.");
    return reader.consumeReset(idempotencyKey);
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
  private async currentTitle(task: TaskRef): Promise<string | null> {
    const response = await this.rpc.call("thread/read", { threadId: task.threadId, includeTurns: false });
    const thread = isObject(response.thread) && response.thread.id === task.threadId ? response.thread : null;
    if (!thread) throw new DesktopUnavailableError("Codex вернул другую задачу; изменение имени не подтверждено.");
    return typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : null;
  }
  async rename(task: TaskRef, title: string): Promise<void> {
    this.local(task);
    const write = () => this.rpc.call("thread/name/set", { threadId: task.threadId, name: title });
    try {
      await write();
      return;
    } catch (firstError) {
      // Setting an exact title is idempotent. A short-lived App Server can time
      // out either before initialization or after accepting the write. Read the
      // selected thread back first; retry only transient failures and only when
      // the requested title is still absent.
      try { if (await this.currentTitle(task) === title) return; }
      catch { /* Preserve the original mutation result below. */ }
      if (!(firstError instanceof DesktopUnavailableError || firstError instanceof UncertainActionError)) throw firstError;
      try {
        await write();
      } catch (retryError) {
        try { if (await this.currentTitle(task) === title) return; }
        catch { /* The retry error remains the best description of the failure. */ }
        throw retryError;
      }
    }
  }
  async queue(request: SubmitTaskRequest, input: readonly IpcObject[]): Promise<string> {
    this.local(request.task);
    const result = await this.rpc.call("thread/queue/add", {
      threadId: request.task.threadId, clientUserMessageId: request.operationId, input,
    });
    const queued = result.queuedSubmission;
    if (!isObject(queued) || typeof queued.id !== "string" || !queued.id
      || queued.clientUserMessageId !== request.operationId) throw new UncertainActionError();
    return queued.id;
  }
  async archive(task: TaskRef): Promise<void> {
    this.local(task); await this.rpc.call("thread/archive", { threadId: task.threadId });
  }
  async read(task: TaskRef): Promise<{ title: string | null; projectId: string | null }> {
    this.local(task);
    const response = await this.rpc.call("thread/read", { threadId: task.threadId, includeTurns: false });
    const thread = isObject(response.thread) && response.thread.id === task.threadId ? response.thread : null;
    if (!thread || !(thread.projectId === null || typeof thread.projectId === "string")
      || !(thread.name === null || typeof thread.name === "string")) throw new DesktopUnavailableError("Codex не подтвердил нативные метаданные выбранной задачи.");
    return { title: typeof thread.name === "string" ? thread.name : null, projectId: typeof thread.projectId === "string" && thread.projectId ? thread.projectId : null };
  }
  async markdown(task: TaskRef): Promise<string> {
    this.local(task);
    const response = await this.rpc.call("thread/read", { threadId: task.threadId, includeTurns: true });
    if (!isObject(response.thread) || response.thread.id !== task.threadId) throw new DesktopUnavailableError("Codex вернул другую задачу; экспорт отменён.");
    return conversationMarkdown(response.thread);
  }
  async assignProject(task: TaskRef, projectId: string | null): Promise<void> {
    this.local(task);
    try {
      await this.rpc.call("thread/metadata/update", { threadId: task.threadId, projectId: projectId ?? "" });
    } catch (error) {
      // Some App Server builds reject an unchanged project assignment. Treat
      // that response as an idempotent success only after a read confirms both
      // the same thread and the exact requested project.
      if (!(error instanceof ActionRejectedError)) throw error;
      let response: IpcObject;
      try { response = await this.rpc.call("thread/read", { threadId: task.threadId, includeTurns: false }); }
      catch { throw error; }
      const thread = isObject(response.thread) && response.thread.id === task.threadId ? response.thread : null;
      const actual = thread && typeof thread.projectId === "string" && thread.projectId ? thread.projectId : null;
      if (!thread || actual !== projectId) throw error;
    }
  }
}

export function unownedArchiveReady(read: IpcObject, turns: IpcObject, threadId: string): boolean {
  const thread = isObject(read.thread) && read.thread.id === threadId ? read.thread : null;
  const turn = Array.isArray(turns.data) && isObject(turns.data[0]) ? turns.data[0] : null;
  return isObject(thread?.status) && thread.status.type === "notLoaded"
    && !!turn && typeof turn.id === "string" && !!turn.id
    && ["completed", "failed", "interrupted"].includes(String(turn.status));
}

export class ProfileDesktopMetadata implements DesktopMetadata {
  constructor(
    private readonly sourceHome: (task: TaskRef) => string,
    private readonly createMetadata: (home: string) => DesktopMetadata = home => new NativeDesktopMetadata(new MetadataRpc(home)),
    private readonly ownerArchive: (home: string, threadId: string) => Promise<boolean> = archiveThroughOwner,
  ) {}
  async ownerAdapterStatus(task: TaskRef): Promise<"ready" | "missing"> {
    if (task.hostId !== "local") return "missing";
    return await inspectThroughOwner(this.sourceHome(task), task.threadId, undefined, 3_000) === null ? "missing" : "ready";
  }
  async archiveRetryReady(task: TaskRef): Promise<boolean> {
    if (task.hostId !== "local") return false;
    const home = this.sourceHome(task);
    const owner = await inspectThroughOwner(home, task.threadId);
    if (owner !== null) return owner === "idle";
    // No registered client owns this thread. A separate App Server may archive
    // it, but only after native reads confirm it is unloaded and its latest
    // turn is terminal. An unregistered writer may still reject the write.
    const rpc = new MetadataRpc(home, undefined, 10_000);
    const [read, turns] = await Promise.all([
      rpc.call("thread/read", { threadId: task.threadId, includeTurns: false }),
      rpc.call("thread/turns/list", { threadId: task.threadId, limit: 1, sortDirection: "desc", itemsView: "summary" }),
    ]);
    return unownedArchiveReady(read, turns, task.threadId);
  }
  rename(task: TaskRef, title: string): Promise<void> { return this.createMetadata(this.sourceHome(task)).rename(task, title); }
  findAcceptedInput(task: TaskRef, operationId: string): Promise<string | null> {
    const rpc = new MetadataRpc(this.sourceHome(task), undefined, 10_000);
    return findAcceptedInputTurn(task.threadId, operationId, params => rpc.call("thread/turns/list", params));
  }
  async queue(request: SubmitTaskRequest, input: readonly IpcObject[]): Promise<string> {
    const metadata = this.createMetadata(this.sourceHome(request.task));
    if (!metadata.queue) throw new ActionRejectedError("Штатная очередь недоступна в выбранном каталоге Codex.");
    return metadata.queue(request, input);
  }

  async archive(task: TaskRef): Promise<void> {
    if (task.hostId !== "local") throw new ActionRejectedError("Архивация доступна только локальным задачам.");
    const home = this.sourceHome(task);
    try { if (await this.ownerArchive(home, task.threadId)) return; }
    catch (error) {
      // Once dispatched to an owner, do not retry through a different connection.
      if (error instanceof OwnerTransportError && error.outcome === "unknown") throw new UncertainActionError();
      if (error instanceof OwnerTransportError && error.outcome === "rejected") throw new ActionRejectedError("Владелец задачи не разрешил безопасную архивацию. Проверь завершение ходов, состояние цели и дочерних задач.");
      if (error instanceof OwnerTransportError && error.outcome === "outdated") throw new DesktopUnavailableError("Адаптер клиента Codex для исходного каталога устарел. Перезапусти этот клиент с текущим адаптером VKodex; архивация не выполнялась.");
      throw new DesktopUnavailableError("Канал владельца задачи недоступен; архивация не подтверждена.");
    }
    await this.createMetadata(home).archive(task);
  }
  markdown(task: TaskRef): Promise<string> { return this.createMetadata(this.sourceHome(task)).markdown(task); }
  async read(task: TaskRef): Promise<{ title: string | null; projectId: string | null }> {
    const metadata = this.createMetadata(this.sourceHome(task));
    if (!metadata.read) throw new DesktopUnavailableError("Чтение нативных метаданных недоступно.");
    return metadata.read(task);
  }
  async isArchived(task: TaskRef, checkpoint?: TransferCheckpoint): Promise<boolean> {
    // Exact persisted state, including archived tasks. Absence from the active
    // display catalog is NOT proof: that catalog may be unreadable or filtered.
    let db: DatabaseConstructor.Database | undefined;
    try {
      const home = this.sourceHome(task);
      db = new DatabaseConstructor(path.join(home, "state_5.sqlite"), { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      const row = db.prepare("SELECT archived FROM threads WHERE id = ?").get(task.threadId) as { archived: number } | undefined;
      if (!row || (row.archived !== 0 && row.archived !== 1)) throw new Error("Missing archive state");
      if (row.archived === 1 && checkpoint) {
        const archived = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(task.threadId) as { rollout_path: string } | undefined;
        const relative = archived && path.relative(home, archived.rollout_path);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid archive path");
        if (checkpoint.semanticDigest) {
          const digest = await completedHistoryDigest(task.threadId, checkpoint.lastTurnId,
            params => new MetadataRpc(home).call("thread/turns/list", params));
          if (digest !== checkpoint.semanticDigest) {
            throw new TransferConflictError("Содержимое истории источника изменилось перед архивацией. Архив сохранён, перенос требует проверки.");
          }
        } else {
          const file = await stat(archived!.rollout_path);
          if (file.size !== checkpoint.size || file.mtimeMs !== checkpoint.mtimeMs) {
            throw new TransferConflictError("История источника изменилась перед архивацией. Архив сохранён, но перенос требует проверки новых сообщений.");
          }
        }
      }
      return row.archived === 1;
    } catch (error) {
      if (error instanceof TransferConflictError) throw error;
      throw new DesktopUnavailableError("Исходный каталог не подтвердил состояние архива задачи.");
    }
    finally { db?.close(); }
  }
  async assignProject(task: TaskRef, projectId: string | null): Promise<void> {
    const home = this.sourceHome(task);
    await this.createMetadata(home).assignProject(task, projectId);
    await mirrorLegacyProjectAssignment(home, task.threadId, projectId);
  }
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
    const normalized = normalizeTaskGoalUpdate(update);
    const response = await this.rpc.call("thread/goal/set", {
      threadId: task.threadId,
      ...normalized,
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
  async get(task: TaskRef): Promise<TaskGoal | null> {
    const home = this.sourceHome(task);
    try { return await this.createGoals(home).get(task); }
    catch (error) {
      if (!(error instanceof ActionRejectedError) || task.hostId !== "local") throw error;
      // Native goal/get rejects archived threads in some versions. Read ONLY
      // an exact archived row from this profile; never hide an active API error
      // or recreate a missing database. Native timestamps are seconds.
      let state: DatabaseConstructor.Database | undefined; let goals: DatabaseConstructor.Database | undefined;
      try {
        state = new DatabaseConstructor(path.join(home, "state_5.sqlite"), { readonly: true, fileMustExist: true });
        const thread = state.prepare("SELECT archived FROM threads WHERE id = ?").get(task.threadId) as { archived: number } | undefined;
        if (thread?.archived !== 1) throw error;
        goals = new DatabaseConstructor(path.join(home, "goals_1.sqlite"), { readonly: true, fileMustExist: true });
        const row = goals.prepare("SELECT * FROM thread_goals WHERE thread_id = ?").get(task.threadId) as Record<string, unknown> | undefined;
        if (!row) return null;
        const status = row.status === "usage_limited" ? "usageLimited" : row.status === "budget_limited" ? "budgetLimited" : row.status;
        return parseTaskGoal({ threadId: row.thread_id, objective: row.objective, status, tokenBudget: row.token_budget,
          tokensUsed: row.tokens_used, timeUsedSeconds: row.time_used_seconds,
          createdAt: typeof row.created_at_ms === "number" ? Math.floor(row.created_at_ms / 1000) : null,
          updatedAt: typeof row.updated_at_ms === "number" ? Math.floor(row.updated_at_ms / 1000) : null }, task.threadId);
      } catch { throw error; }
      finally { goals?.close(); state?.close(); }
    }
  }
  set(task: TaskRef, update: TaskGoalUpdate): Promise<TaskGoal> { return this.createGoals(this.sourceHome(task)).set(task, update); }
  clear(task: TaskRef): Promise<boolean> { return this.createGoals(this.sourceHome(task)).clear(task); }
}
