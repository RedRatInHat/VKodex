import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, DesktopUnavailableError, UncertainActionError, ProjectAssignmentUnconfirmedError, TransferConflictError, sameTask,
  type DesktopMetadata, type DesktopTask, type DesktopTaskTransfer, type TransferTaskRequest, type TaskRef, type TransferCheckpoint } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { nativeCodexPath } from "./metadata.js";
import type { MultiDesktopCatalog } from "./multi-catalog.js";
import { comparablePath } from "./paths.js";
import { closeAppServer } from "./app-server-process.js";
import { completedHistoryDigest } from "./history-digest.js";

type TransferMethod = "thread/fork" | "thread/list" | "thread/read" | "thread/turns/list";

interface StagedRollout {
  readonly path: string;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  cleanup(): Promise<void>;
}

export class TransferRpc {
  constructor(
    codexHome: string,
    private readonly launch: () => ChildProcessWithoutNullStreams = () => spawn(nativeCodexPath(), ["app-server", "--stdio"], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...buildCodexEnvironment(process.env), CODEX_HOME: codexHome },
    }),
    private readonly timeoutMs = 90_000,
  ) {}

  call(method: TransferMethod, params: IpcObject, onResult?: (result: IpcObject) => void): Promise<IpcObject> {
    const child = this.launch(); const mutating = method === "thread/fork";
    return new Promise((resolve, reject) => {
      let buffer = ""; let submitted = false; let finished = false;
      const close = (error?: Error, result?: IpcObject) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        void closeAppServer(child).then(() => { if (error) reject(error); else resolve(result!); },
          () => reject(submitted && mutating ? new UncertainActionError() : new DesktopUnavailableError("Процесс переноса Codex не завершился вовремя.")));
      };
      const failed = () => close(submitted && mutating ? new UncertainActionError()
        : new DesktopUnavailableError("Локальный API переноса Codex не ответил."));
      const timer = setTimeout(failed, this.timeoutMs); timer.unref();
      const send = (message: IpcObject) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stderr.resume(); child.on("error", failed); child.on("close", failed); child.stdin.on("error", failed);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (finished) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 * 1024) { failed(); return; }
        while (buffer.includes("\n") && !finished) {
          const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message: unknown;
          try { message = JSON.parse(line); } catch { failed(); return; }
          if (!isObject(message) || (message.id !== 1 && message.id !== 2)) continue;
          if (message.error) {
            close(new ActionRejectedError(method === "thread/fork"
              ? "Установленный Codex отклонил перенос истории. Проверь обновление Codex и состояние исходной задачи."
              : "Codex не смог проверить состояние исходной задачи."));
            return;
          }
          if (!isObject(message.result)) { failed(); return; }
          if (message.id === 1 && !submitted) {
            send({ method: "initialized", params: {} }); submitted = true;
            send({ id: 2, method, params });
          } else if (message.id === 2 && submitted) {
            // Save the identity while the acknowledged result is available,
            // before waiting for the child to release its writer lock.
            try { onResult?.(message.result); } catch { close(new UncertainActionError()); return; }
            close(undefined, message.result);
          }
        }
      });
      send({ id: 1, method: "initialize", params: {
        clientInfo: { name: "vkodex_transfer", title: "VKodex transfer", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      } });
    });
  }
}

function inside(root: string, candidate: string): boolean {
  const normalize = (value: string) => comparablePath(value).replaceAll("\\", "/");
  const parent = normalize(root); const child = normalize(candidate);
  return child.startsWith(`${parent}/`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Paginated rollouts keep their visible turn items in a profile-local SQLite
 * projection. A target profile cannot read that projection. The model-visible
 * Responses items are already present in the JSONL, so the transfer copy only
 * needs legacy user/agent events to make the same completed turns visible in
 * the receiving app. The source rollout is never modified.
 */
export function transferCompatibleRecord(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.payload)) return value;
  if (value.type === "session_meta") return { ...value, payload: { ...value.payload, history_mode: "legacy" } };
  if (value.type !== "event_msg" || value.payload.type !== "item_completed" || !isObject(value.payload.item)) return value;
  const item = value.payload.item;
  if (item.type === "UserMessage" && Array.isArray(item.content)) {
    const parts = item.content.filter(isObject);
    const text = parts.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
    const strings = (kind: string, key: string) => parts.filter(part => part.type === kind && typeof part[key] === "string").map(part => part[key] as string);
    return { ...value, payload: {
      type: "user_message", client_id: optionalString(item.client_id) ?? null, message: text,
      images: strings("image", "url"), local_images: strings("localImage", "path"),
      audio: strings("audio", "url"), local_audio: strings("localAudio", "path"), text_elements: [],
    } };
  }
  if (item.type === "AgentMessage" && Array.isArray(item.content)) {
    // Normalized desktop snapshots currently use `Text`, while older builds
    // used `text`. The text field is the stable part of the contract.
    const message = item.content.filter(isObject).filter(part => typeof part.text === "string").map(part => part.text).join("\n");
    return { ...value, payload: { type: "agent_message", message, phase: optionalString(item.phase) ?? null, memory_citation: null } };
  }
  return value;
}

export async function stageTransferRollout(sourcePath: string, sourceHome: string, targetHome: string,
  operationId: string, lastTurnId: string): Promise<StagedRollout> {
  if (!path.isAbsolute(sourcePath) || !inside(sourceHome, sourcePath)) {
    throw new ActionRejectedError("Путь истории исходной задачи не принадлежит выбранному каталогу Codex.");
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(operationId)) throw new ActionRejectedError("Некорректный идентификатор операции переноса.");
  const directory = path.join(targetHome, ".vkodex-transfer-staging", operationId);
  const destination = path.join(directory, "source.jsonl");
  const temporary = path.join(directory, `source.${process.pid}.tmp`);
  await mkdir(directory, { recursive: true });
  await rm(temporary, { force: true });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10 * 60_000);
  const input = createReadStream(sourcePath, { encoding: "utf8", signal: controller.signal });
  const writer = createWriteStream(temporary, { encoding: "utf8", flags: "wx", signal: controller.signal });
  const written = finished(writer);
  void written.catch(() => {}); // Listen from creation, including disk-full failures before the first write.
  let matchingContext: IpcObject | null = null; let latestContext: IpcObject | null = null;
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); }
      catch { throw new ActionRejectedError("Журнал исходной задачи повреждён; перенос отменён."); }
      if (isObject(record) && record.type === "turn_context" && isObject(record.payload)) {
        latestContext = record.payload;
        if (record.payload.turn_id === lastTurnId) matchingContext = record.payload;
      }
      if (!writer.write(`${JSON.stringify(transferCompatibleRecord(record))}\n`)) {
        await once(writer, "drain");
      }
    }
    writer.end(); await written;
    await rm(destination, { force: true }); await rename(temporary, destination);
  } catch (error) {
    input.destroy(); writer.destroy(); await written.catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (controller.signal.aborted) throw new DesktopUnavailableError("Копирование истории не завершилось за 10 минут. Источник не изменён.");
    throw error;
  } finally { clearTimeout(deadline); input.destroy(); }
  const context = matchingContext ?? latestContext;
  const model = optionalString(context?.model); const effort = optionalString(context?.effort); const cwd = optionalString(context?.cwd);
  return {
    path: destination,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(cwd ? { cwd } : {}),
    cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
  };
}

export async function rolloutContainsThread(rolloutPath: string, threadId: string): Promise<boolean> {
  try {
    const lines = createInterface({ input: createReadStream(rolloutPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      // A fork of a fork appends its parent session metadata after inherited
      // history. Limiting this scan to the header misses return transfers.
      if (!line.includes('"session_meta"')) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return false; }
      if (isObject(record) && record.type === "session_meta" && isObject(record.payload)
        && (record.payload.id === threadId || record.payload.session_id === threadId)) return true;
    }
  } catch { return false; }
  return false;
}

function threadTask(value: unknown, sourceId: string, sourceLabel: string, targetHome: string, fallbackTitle: string): DesktopTask | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)
    || typeof value.path !== "string" || !path.isAbsolute(value.path) || !inside(targetHome, value.path)) return null;
  const updated = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt * 1_000 : Date.now();
  const title = typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallbackTitle;
  return { hostId: "local", threadId: value.id, title, workspace: value.cwd, projectId: null,
    rolloutPath: value.path, updatedAt: updated, ...(sourceId ? { sourceId } : {}), ...(sourceLabel ? { sourceLabel } : {}) };
}

export class AppServerTaskTransfer implements DesktopTaskTransfer {
  constructor(
    private readonly catalog: Pick<MultiDesktopCatalog, "sourceHome" | "listSources" | "listTasks" | "listProjects"> & Partial<Pick<MultiDesktopCatalog, "resolveProject">>,
    private readonly metadata: DesktopMetadata,
    private readonly createRpc: (home: string) => Pick<TransferRpc, "call"> = home => new TransferRpc(home),
    private readonly stage: typeof stageTransferRollout = stageTransferRollout,
    private readonly hasSourceThread: (rolloutPath: string, threadId: string) => Promise<boolean> = rolloutContainsThread,
  ) {}

  async fork(request: TransferTaskRequest): Promise<DesktopTask> {
    if (request.task.hostId !== "local" || !request.task.rolloutPath || !path.isAbsolute(request.task.rolloutPath)) {
      throw new ActionRejectedError("Исходный каталог не сообщил путь истории задачи. Обнови список и повтори перенос.");
    }
    if ((request.task.sourceId ?? "") === request.targetSourceId) throw new ActionRejectedError("Задача уже находится в выбранном каталоге Codex.");
    const targetRef = { hostId: "local", threadId: "", ...(request.targetSourceId ? { sourceId: request.targetSourceId } : {}) };
    const targetHome = this.catalog.sourceHome(targetRef);
    const sourceHome = this.catalog.sourceHome(request.task);
    const source = this.catalog.listSources().find(item => item.id === request.targetSourceId);
    if (!source) throw new ActionRejectedError("Целевой каталог больше не подключён к VKodex.");
    const project = await this.targetProject(request.projectId, request.targetSourceId);
    const rawProjectId = project?.rawId ?? null;
    const rpc = this.createRpc(targetHome);
    // New operations only reconcile after a persisted submission. The legacy
    // path remains available for explicit recovery of records made before v2.
    let target = request.existingTarget ?? (request.checkpoint ? null : await this.reconcile(request));
    if (target && ((target.sourceId ?? "") !== request.targetSourceId || !target.rolloutPath || !inside(targetHome, target.rolloutPath)
      || !await this.hasSourceThread(target.rolloutPath, request.task.threadId))) {
      throw new ActionRejectedError("Сохранённая копия не подтверждает исходную историю. Новый fork не создан.");
    }
    if (target) await this.verifyLineage(request.task, target);
    if (!target) {
      if (request.forkSubmitted) throw new TransferConflictError("Отправка fork зафиксирована, но ID результата не подтверждён. Источник сохранён; новая копия автоматически не создаётся. Нужна проверка операции.");
      const lastTurnId = request.checkpoint?.lastTurnId ?? await this.lastTerminalTurn(sourceHome, request.task.threadId);
      if (request.checkpoint) await this.verifySource(request.task, request.checkpoint);
      const staged = await this.stage(request.task.rolloutPath, sourceHome, targetHome, request.operationId, lastTurnId);
      try {
        if (request.checkpoint) await this.verifySource(request.task, request.checkpoint);
        request.onForkSubmitted?.();
        const response = await rpc.call("thread/fork", {
          threadId: request.task.threadId,
          path: staged.path,
          lastTurnId,
          ...(staged.model ? { model: staged.model } : {}),
          ...(staged.cwd ? { cwd: staged.cwd } : {}),
          ...(staged.effort ? { config: { model_reasoning_effort: staged.effort } } : {}),
          threadSource: "user",
          excludeTurns: true,
          deferGoalContinuation: true,
        }, result => {
          const created = threadTask(result.thread, request.targetSourceId, source.label, targetHome, request.task.title);
          if (!created) throw new UncertainActionError();
          request.onForkCreated?.(created); target = created;
        });
        target = threadTask(response.thread, request.targetSourceId, source.label, targetHome, request.task.title);
        if (!target) throw new UncertainActionError();
      } catch (error) {
        if (!(error instanceof UncertainActionError)) throw error;
        if (request.checkpoint && !target) throw new TransferConflictError("Codex не подтвердил ID созданной копии. Источник сохранён; автоматическое создание второй копии запрещено.");
        target ??= await this.waitForReconciliation(request);
        if (!target) throw error;
      } finally {
        await staged.cleanup().catch(() => {});
      }
    }
    request.onForkCreated?.(target);
    // The fork reply falls back to the requested title when App Server returns
    // `name: null`. Read the actual catalog row before deciding whether the
    // canonical user title survived the cross-profile import.
    target = await this.waitForCatalog(target);
    // Preserve the name independently: a rejected project write must not leave
    // an already-created copy named after its initial prompt.
    if (target.title !== request.task.title) await this.metadata.rename(target, request.task.title);
    target = await this.waitForCatalog(target, { title: request.task.title });
    // A cross-profile fork starts projectless. Clearing that already-empty
    // assignment is rejected by some App Server builds, while a real target
    // project still needs an explicit metadata update.
    if (rawProjectId !== null) await this.metadata.assignProject(target, rawProjectId);
    const expected: DesktopTask & { readonly projectId: string | null } = { ...target, title: request.task.title, projectId: project?.id ?? null };
    // `projectId: null` means that no explicit native assignment was requested.
    // The merged catalog can still derive a display project from the unchanged
    // workspace path; that inference is not evidence that the fork failed.
    return this.waitForCatalog(expected, project
      ? { title: request.task.title, projectId: project.id }
      : { title: request.task.title });
  }

  async checkpoint(task: TaskRef): Promise<TransferCheckpoint> {
    const home = this.catalog.sourceHome(task);
    if (task.hostId !== "local" || !task.rolloutPath || !inside(home, task.rolloutPath)) {
      throw new TransferConflictError("Путь истории не принадлежит выбранному исходному каталогу.");
    }
    const before = await stat(task.rolloutPath);
    const lastTurnId = await this.lastTerminalTurn(home, task.threadId);
    const semanticDigest = await completedHistoryDigest(task.threadId, lastTurnId,
      params => this.createRpc(home).call("thread/turns/list", params));
    const after = await stat(task.rolloutPath);
    if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new DesktopUnavailableError("История ещё обновляется; снимок переноса будет повторён после завершения записи.");
    }
    return { lastTurnId, rolloutPath: task.rolloutPath, size: after.size, mtimeMs: after.mtimeMs, semanticDigest };
  }

  async verifySource(task: TaskRef, expected: TransferCheckpoint): Promise<void> {
    const actual = await this.checkpoint(task);
    if (actual.lastTurnId !== expected.lastTurnId || comparablePath(actual.rolloutPath) !== comparablePath(expected.rolloutPath)
      || (expected.semanticDigest ? actual.semanticDigest !== expected.semanticDigest
        : actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs)) {
      throw new TransferConflictError("Исходная история изменилась после снимка. Переключение и архивация остановлены, чтобы не потерять новые сообщения.");
    }
  }

  async verifyTarget(request: TransferTaskRequest, target: DesktopTask): Promise<void> {
    if (!request.checkpoint || !this.metadata.read) throw new TransferConflictError("Нет контракта проверки истории и метаданных назначения.");
    if ((target.sourceId ?? "") !== request.targetSourceId || target.threadId === request.task.threadId
      || !target.rolloutPath || !inside(this.catalog.sourceHome(target), target.rolloutPath)) {
      throw new TransferConflictError("Назначение не соответствует выбранному каталогу или новой копии.");
    }
    const targetHome = this.catalog.sourceHome(target);
    await this.verifyLineage(request.task, target);
    const project = await this.targetProject(request.projectId, request.targetSourceId);
    const current = await this.metadata.read(target);
    if (current.title !== request.task.title || current.projectId !== (project?.rawId ?? null)) {
      throw new DesktopUnavailableError("Название или нативное назначение проекта не подтверждено. VK-беседа ещё не переключена.");
    }
    if (await this.lastTerminalTurn(targetHome, target.threadId) !== request.checkpoint.lastTurnId) {
      throw new TransferConflictError("Последний ход копии не совпадает со снимком исходной задачи.");
    }
    if (request.checkpoint.semanticDigest && await completedHistoryDigest(target.threadId, request.checkpoint.lastTurnId,
      params => this.createRpc(targetHome).call("thread/turns/list", params)) !== request.checkpoint.semanticDigest) {
      throw new TransferConflictError("Содержимое истории копии не совпадает с исходной задачей. VK-беседа не переключена.");
    }
  }

  private async verifyLineage(source: TaskRef, target: DesktopTask): Promise<void> {
    const native = await this.createRpc(this.catalog.sourceHome(target)).call("thread/read", { threadId: target.threadId, includeTurns: false });
    if (!isObject(native.thread) || native.thread.id !== target.threadId) {
      throw new DesktopUnavailableError("Codex не подтвердил идентичность целевой задачи.");
    }
    // Current App Server exposes direct fork lineage. It is stronger than a
    // matching title or copied prefix. Older builds may omit it, so history
    // verification remains mandatory for every version.
    if (typeof native.thread.forkedFromId === "string" && native.thread.forkedFromId !== source.threadId) {
      throw new TransferConflictError("Целевая задача создана из другого источника. VK-беседа не переключена.");
    }
  }

  async verifyLegacyArchivedPair(source: TaskRef, target: DesktopTask, checkpoint: TransferCheckpoint): Promise<void> {
    if (checkpoint.semanticDigest || !this.metadata.isArchived || source.threadId === target.threadId
      || comparablePath(this.catalog.sourceHome(source)) === comparablePath(this.catalog.sourceHome(target))) {
      throw new TransferConflictError("Старая архивная копия не соответствует межкаталожному переносу.");
    }
    if (!await this.metadata.isArchived(source)) throw new TransferConflictError("Источник ещё не архивирован.");
    const sourceHome = this.catalog.sourceHome(source);
    const targetHome = this.catalog.sourceHome(target);
    try {
      await this.verifyLineage(source, target);
      if (await this.lastTerminalTurn(sourceHome, source.threadId) !== checkpoint.lastTurnId) {
        throw new TransferConflictError("После снимка у источника появились новые ходы.");
      }
      const [sourceDigest, targetDigest] = await Promise.all([
        completedHistoryDigest(source.threadId, checkpoint.lastTurnId,
          params => this.createRpc(sourceHome).call("thread/turns/list", params)),
        completedHistoryDigest(target.threadId, checkpoint.lastTurnId,
          params => this.createRpc(targetHome).call("thread/turns/list", params), { allowNewerTurns: true }),
      ]);
      if (sourceDigest !== targetDigest) throw new TransferConflictError("Архив источника и копия содержат разную историю.");
    } catch (error) {
      if (error instanceof TransferConflictError || error instanceof DesktopUnavailableError) throw error;
      throw new TransferConflictError("Старую архивную историю не удалось подтвердить до сохранённой границы.");
    }
  }

  private async targetProject(projectId: string | null, targetSourceId: string): Promise<{ id: string; rawId: string } | null> {
    if (projectId === null) return null;
    if (this.catalog.resolveProject) {
      const resolved = await this.catalog.resolveProject(projectId);
      if ((resolved.sourceId ?? "") !== targetSourceId) throw new ActionRejectedError("Проект относится к другому каталогу Codex.");
      return { id: resolved.project.id, rawId: resolved.rawProjectId };
    }
    const project = (await this.catalog.listProjects(targetSourceId)).find(candidate => candidate.id === projectId);
    if (!project) throw new ActionRejectedError("Проект относится к другому каталогу Codex или больше не существует.");
    return { id: project.id, rawId: project.id };
  }

  private async lastTerminalTurn(sourceHome: string, threadId: string): Promise<string> {
    const response = await this.createRpc(sourceHome).call("thread/turns/list", {
      threadId, limit: 1, sortDirection: "desc", itemsView: "summary",
    });
    const turn = Array.isArray(response.data) && isObject(response.data[0]) ? response.data[0] : null;
    if (!turn || typeof turn.id !== "string" || !turn.id) {
      throw new ActionRejectedError("У задачи нет завершённого хода, который можно перенести.");
    }
    if (turn.status === "inProgress") throw new ActionRejectedError("Сначала дождись завершения текущего хода.");
    if (!["completed", "failed", "interrupted"].includes(String(turn.status))) {
      throw new ActionRejectedError("Codex вернул неизвестное состояние последнего хода; перенос отменён.");
    }
    return turn.id;
  }

  private async reconcile(request: TransferTaskRequest): Promise<DesktopTask | null> {
    const since = request.startedAt - 5_000;
    const candidates = (await this.catalog.listTasks()).filter(task => (task.sourceId ?? "") === request.targetSourceId
      && task.updatedAt >= since && !!task.rolloutPath);
    const inspected = await Promise.all(candidates.map(async task => ({ task,
      matches: await this.hasSourceThread(task.rolloutPath!, request.task.threadId) })));
    const matches = inspected.filter(candidate => candidate.matches).map(candidate => candidate.task);
    if (matches.length > 1) throw new ActionRejectedError("В целевом каталоге найдено несколько возможных копий. Автоматический повтор остановлен; выбери нужную задачу вручную.");
    const match = matches[0];
    if (match) await this.verifyLineage(request.task, match);
    if (match && request.checkpoint) {
      // Ancestry alone is not enough: a fork of an older fork also contains the
      // source ID. Check the exact copied boundary before accepting recovery.
      if (await this.lastTerminalTurn(this.catalog.sourceHome(match), match.threadId) !== request.checkpoint.lastTurnId) return null;
      if (request.checkpoint.semanticDigest && await completedHistoryDigest(match.threadId, request.checkpoint.lastTurnId,
        params => this.createRpc(this.catalog.sourceHome(match)).call("thread/turns/list", params)) !== request.checkpoint.semanticDigest) return null;
    }
    return match ?? null;
  }

  private async waitForReconciliation(request: TransferTaskRequest): Promise<DesktopTask | null> {
    const deadline = Date.now() + 10_000;
    do {
      const task = await this.reconcile(request);
      if (task) return task;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return null;
  }

  private async waitForCatalog(expected: DesktopTask, required?: { readonly title: string; readonly projectId?: string | null }): Promise<DesktopTask> {
    const deadline = Date.now() + 10_000;
    let projectMismatch = false;
    do {
      const task = (await this.catalog.listTasks()).find(candidate => sameTask(candidate, expected));
      projectMismatch = !!task && required?.projectId !== undefined && task.projectId !== required.projectId;
      if (task?.rolloutPath && (!required || task.title === required.title) && !projectMismatch) return { ...expected, ...task,
        ...(expected.sourceId ? { sourceId: expected.sourceId } : {}), ...(expected.sourceLabel ? { sourceLabel: expected.sourceLabel } : {}) };
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (projectMismatch) throw new ProjectAssignmentUnconfirmedError();
    throw new UncertainActionError();
  }
}
