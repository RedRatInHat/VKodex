import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ActionRejectedError, DesktopUnavailableError, TransferPageTooLargeError, UncertainActionError, ProjectAssignmentUnconfirmedError, TransferConflictError, sameTask,
  type DesktopMetadata, type DesktopTask, type DesktopTaskTransfer, type TransferTaskRequest, type TaskRef, type TransferCheckpoint } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { nativeCodexPath } from "./metadata.js";
import type { MultiDesktopCatalog } from "./multi-catalog.js";
import { comparablePath } from "./paths.js";
import { closeAppServer } from "./app-server-process.js";
import { completedHistoryDigest } from "./history-digest.js";
import { transferRolloutSlices } from "./transfer-rollout-segments.js";

type TransferMethod = "thread/fork" | "thread/list" | "thread/read" | "thread/turns/list";

interface StagedRollout {
  readonly path: string;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  cleanup(): Promise<void>;
}

interface TransferContext {
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
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
      let fragments: Buffer[] = []; let bufferedBytes = 0;
      let submitted = false; let finished = false;
      const close = (error?: Error, result?: IpcObject) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        void closeAppServer(child).then(() => { if (error) reject(error); else resolve(result!); },
          () => reject(submitted && mutating ? new UncertainActionError() : new DesktopUnavailableError("Процесс переноса Codex не завершился вовремя.")));
      };
      const failed = () => close(submitted && mutating ? new UncertainActionError()
        : new DesktopUnavailableError("Локальный API переноса Codex не ответил."));
      // Large portable rollouts can take several minutes to import. A timeout
      // after submission is uncertain and must never trigger a second fork.
      const timer = setTimeout(failed, mutating ? Math.max(this.timeoutMs, 10 * 60_000) : this.timeoutMs); timer.unref();
      const send = (message: IpcObject) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stderr.resume(); child.on("error", failed); child.on("close", failed); child.stdin.on("error", failed);
      child.stdout.on("data", (chunk: Buffer) => {
        if (finished) return;
        let start = 0;
        while (start < chunk.length && !finished) {
          const end = chunk.indexOf(0x0a, start);
          const part = chunk.subarray(start, end < 0 ? chunk.length : end);
          if (part.length) { fragments.push(part); bufferedBytes += part.length; }
          if (bufferedBytes > 64 * 1024 * 1024) {
            close(mutating && submitted ? new UncertainActionError() : new TransferPageTooLargeError()); return;
          }
          if (end < 0) break;
          const line = Buffer.concat(fragments, bufferedBytes).toString("utf8");
          fragments = []; bufferedBytes = 0; start = end + 1;
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

async function readTransferContext(rolloutPath: string, lastTurnId: string): Promise<TransferContext> {
  let matching: IpcObject | null = null; let latest: IpcObject | null = null;
  try {
    const lines = createInterface({ input: createReadStream(rolloutPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"turn_context"')) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw new TransferConflictError("Журнал задачи повреждён; настройки переноса не подтверждены."); }
      if (!isObject(record) || record.type !== "turn_context" || !isObject(record.payload)) continue;
      latest = record.payload;
      if (record.payload.turn_id === lastTurnId) matching = record.payload;
    }
  } catch (error) {
    if (error instanceof TransferConflictError) throw error;
    throw new DesktopUnavailableError("Не удалось прочитать настройки из истории задачи.");
  }
  const context = matching ?? latest;
  const model = optionalString(context?.model); const effort = optionalString(context?.effort); const cwd = optionalString(context?.cwd);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(cwd ? { cwd } : {}) };
}

function contextChanged(expected: TransferCheckpoint, actual: TransferContext): boolean {
  return (expected.model !== undefined && actual.model !== expected.model)
    || (expected.effort !== undefined && actual.effort !== expected.effort)
    || (expected.workspace !== undefined && (actual.cwd === undefined || comparablePath(actual.cwd) !== comparablePath(expected.workspace)));
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
    const strings = (kinds: readonly string[], keys: readonly string[]) => parts
      .filter(part => kinds.includes(String(part.type)))
      .flatMap(part => {
        const value = keys.map(key => part[key]).find(candidate => typeof candidate === "string");
        return typeof value === "string" ? [value] : [];
      });
    return { ...value, payload: {
      type: "user_message", client_id: optionalString(item.client_id) ?? null, message: text,
      // Current paginated snapshots use snake_case normalized fields
      // (`image_url`, `local_image`). Older clients used `url` and camelCase.
      // Accept both when producing the legacy events consumed by the target
      // profile; otherwise the fork keeps the model input but loses the
      // visible attachment in the receiving app projection.
      images: strings(["image"], ["image_url", "url"]),
      local_images: strings(["local_image", "localImage"], ["path"]),
      audio: strings(["audio"], ["audio_url", "url"]),
      local_audio: strings(["local_audio", "localAudio"], ["path"]), text_elements: [],
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

async function portableRolloutDigest(rolloutPath: string, home: string, lastTurnId: string): Promise<string> {
  const hash = createHash("sha256");
  let messages = 0; let terminalTurns = 0; let boundarySeen = false;
  const events = new Set(["user_message", "agent_message", "task_complete", "task_failed", "task_aborted"]);
  for (const slice of await transferRolloutSlices(rolloutPath, home)) {
    const input = createReadStream(slice.path, { encoding: "utf8" });
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (!line.includes('"event_msg"') && !line.includes('"turn_context"')) continue;
        let record: unknown;
        try { record = transferCompatibleRecord(JSON.parse(line)); }
        catch { throw new TransferConflictError("Один из журналов истории повреждён. Переключение VK остановлено."); }
        if (!isObject(record)) continue;
        const ordinal = typeof record.ordinal === "number" ? record.ordinal : undefined;
        if (ordinal !== undefined && (ordinal < slice.from || ordinal >= slice.until)) continue;
        if (!isObject(record.payload)) continue;
        if (record.type === "turn_context") {
          const turnId = record.payload.turn_id;
          if (typeof turnId !== "string" || !turnId) throw new TransferConflictError("В истории отсутствует ID одного из ходов.");
          if (turnId === lastTurnId) boundarySeen = true;
          hash.update(JSON.stringify({ type: "turn_context", turn_id: turnId })); hash.update("\n");
          continue;
        }
        if (record.type !== "event_msg" || !events.has(String(record.payload.type))) continue;
        const { client_id: _clientId, ...payload } = record.payload;
        hash.update(JSON.stringify(payload)); hash.update("\n");
        if (payload.type === "user_message" || payload.type === "agent_message") messages++;
        else terminalTurns++;
      }
    } finally { input.destroy(); }
  }
  if (!boundarySeen || messages === 0 || terminalTurns === 0) {
    throw new TransferConflictError("Граница или сообщения истории отсутствуют в одном из журналов. Переключение VK остановлено.");
  }
  return hash.digest("hex");
}

async function rolloutHistoryMode(rolloutPath: string): Promise<string | null> {
  const input = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record: unknown;
      try { record = JSON.parse(line); } catch { return null; }
      return isObject(record) && record.type === "session_meta" && isObject(record.payload)
        && typeof record.payload.history_mode === "string" ? record.payload.history_mode : null;
    }
  } catch { return null; }
  finally { lines.close(); input.destroy(); }
  return null;
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
  const writer = createWriteStream(temporary, { encoding: "utf8", flags: "wx", signal: controller.signal });
  const written = finished(writer);
  void written.catch(() => {}); // Listen from creation, including disk-full failures before the first write.
  let matchingContext: IpcObject | null = null; let latestContext: IpcObject | null = null;
  try {
    const slices = await transferRolloutSlices(sourcePath, sourceHome);
    let nextOrdinal: number | undefined = slices.length > 1 ? 0 : undefined;
    let boundarySeen = false;
    for (const slice of slices) {
      const input = createReadStream(slice.path, { encoding: "utf8", signal: controller.signal });
      try {
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          let record: unknown;
          try { record = JSON.parse(line); }
          catch { throw new ActionRejectedError("Журнал исходной задачи повреждён; перенос отменён."); }
          const ordinal = isObject(record) && typeof record.ordinal === "number" ? record.ordinal : undefined;
          if (ordinal !== undefined && ordinal < slice.from) continue;
          if (ordinal !== undefined && ordinal >= slice.until) break;
          if (nextOrdinal !== undefined) {
            if (ordinal !== nextOrdinal) throw new TransferConflictError("В цепочке истории Codex обнаружен пропуск или повтор записи. Копия не создана.");
            nextOrdinal++;
          }
          if (isObject(record) && record.type === "turn_context" && isObject(record.payload)) {
            latestContext = record.payload;
            if (record.payload.turn_id === lastTurnId) { matchingContext = record.payload; boundarySeen = true; }
          }
          if (!writer.write(`${JSON.stringify(transferCompatibleRecord(record))}\n`)) await once(writer, "drain");
        }
      } finally { input.destroy(); }
      if (nextOrdinal !== undefined && nextOrdinal < slice.until && Number.isFinite(slice.until)) {
        throw new TransferConflictError("Сегмент истории Codex обрывается до следующего журнала. Копия не создана.");
      }
    }
    if (slices.length > 1 && !boundarySeen) {
      throw new TransferConflictError("Завершённый ход отсутствует в собранной истории. Копия не создана.");
    }
    writer.end(); await written;
    await rm(destination, { force: true }); await rename(temporary, destination);
  } catch (error) {
    writer.destroy(); await written.catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (controller.signal.aborted) throw new DesktopUnavailableError("Копирование истории не завершилось за 10 минут. Источник не изменён.");
    throw error;
  } finally { clearTimeout(deadline); }
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

async function lastInheritedThread(rolloutPath: string, targetThreadId: string): Promise<string | null> {
  // When a paginated fork is assembled from its ancestor segments, Codex may
  // report the first inherited session as forkedFromId. The final inherited
  // session header identifies the actual source of the copied branch.
  let inherited: string | null = null;
  try {
    const lines = createInterface({ input: createReadStream(rolloutPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"session_meta"')) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return null; }
      if (!isObject(record) || record.type !== "session_meta" || !isObject(record.payload)) continue;
      const id = record.payload.id ?? record.payload.session_id;
      if (typeof id === "string" && id !== targetThreadId) inherited = id;
    }
  } catch { return null; }
  return inherited;
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
        if (request.checkpoint && contextChanged(request.checkpoint, staged)) {
          throw new TransferConflictError("Модель, effort или рабочая папка источника изменились после снимка. Перенос остановлен.");
        }
        const model = request.checkpoint?.model ?? staged.model;
        const effort = request.checkpoint?.effort ?? staged.effort;
        const cwd = request.checkpoint?.workspace ?? staged.cwd;
        request.onForkSubmitted?.();
        try {
          const response = await rpc.call("thread/fork", {
            threadId: request.task.threadId,
            path: staged.path,
            lastTurnId,
            ...(model ? { model } : {}),
            ...(cwd ? { cwd } : {}),
            ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
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
          if (!(error instanceof ActionRejectedError) || error instanceof TransferConflictError) throw error;
          target = await this.reconcile(request);
          if (!target) { request.onForkRejected?.(); throw error; }
        }
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

  async checkpoint(task: TaskRef, version: 2 | 3 = 3): Promise<TransferCheckpoint> {
    const home = this.catalog.sourceHome(task);
    if (task.hostId !== "local" || !task.rolloutPath || !inside(home, task.rolloutPath)) {
      throw new TransferConflictError("Путь истории не принадлежит выбранному исходному каталогу.");
    }
    const before = await stat(task.rolloutPath);
    const lastTurnId = await this.lastTerminalTurn(home, task.threadId);
    const semanticDigest = await completedHistoryDigest(task.threadId, lastTurnId,
      params => this.createRpc(home).call("thread/turns/list", params), { version });
    const context = await readTransferContext(task.rolloutPath, lastTurnId);
    const after = await stat(task.rolloutPath);
    if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new DesktopUnavailableError("История ещё обновляется; снимок переноса будет повторён после завершения записи.");
    }
    return { lastTurnId, rolloutPath: task.rolloutPath, size: after.size, mtimeMs: after.mtimeMs, semanticDigest,
      semanticDigestVersion: version,
      ...(context.cwd ? { workspace: context.cwd } : {}), ...(context.model ? { model: context.model } : {}),
      ...(context.effort ? { effort: context.effort } : {}) };
  }

  async verifySource(task: TaskRef, expected: TransferCheckpoint): Promise<void> {
    const version = expected.semanticDigestVersion ?? 1;
    const actual = expected.semanticDigest && version === 1
      ? await this.legacyCheckpoint(task) : await this.checkpoint(task, version === 2 ? 2 : 3);
    if (actual.lastTurnId !== expected.lastTurnId || comparablePath(actual.rolloutPath) !== comparablePath(expected.rolloutPath)
      || (expected.semanticDigest ? actual.semanticDigest !== expected.semanticDigest
        : actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs)
      || contextChanged(expected, { ...(actual.workspace ? { cwd: actual.workspace } : {}),
        ...(actual.model ? { model: actual.model } : {}), ...(actual.effort ? { effort: actual.effort } : {}) })) {
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
    if (request.checkpoint.workspace !== undefined && comparablePath(target.workspace) !== comparablePath(request.checkpoint.workspace)) {
      throw new TransferConflictError("Рабочая папка копии не совпадает со снимком исходной задачи.");
    }
    if (request.checkpoint.model !== undefined || request.checkpoint.effort !== undefined || request.checkpoint.workspace !== undefined) {
      const context = await readTransferContext(target.rolloutPath, request.checkpoint.lastTurnId);
      if (contextChanged(request.checkpoint, context)) {
        throw new TransferConflictError("Модель, effort или рабочая папка копии не совпадают со снимком источника.");
      }
    }
    const project = await this.targetProject(request.projectId, request.targetSourceId);
    const current = await this.metadata.read(target);
    if (current.title !== request.task.title || current.projectId !== (project?.rawId ?? null)) {
      throw new DesktopUnavailableError("Название или нативное назначение проекта не подтверждено. VK-беседа ещё не переключена.");
    }
    if (await this.lastTerminalTurn(targetHome, target.threadId) !== request.checkpoint.lastTurnId) {
      throw new TransferConflictError("Последний ход копии не совпадает со снимком исходной задачи.");
    }
    if (request.checkpoint.semanticDigest) {
      const version = request.checkpoint.semanticDigestVersion ?? 1;
      const sourceHome = this.catalog.sourceHome(request.task);
      const sourcePathSafe = !!request.task.rolloutPath && path.isAbsolute(request.task.rolloutPath)
        && inside(sourceHome, request.task.rolloutPath);
      const crossMode = version === 3 && sourcePathSafe
        && await rolloutHistoryMode(request.task.rolloutPath) === "paginated"
        && await rolloutHistoryMode(target.rolloutPath) === "legacy";
      let nativeMismatch = false;
      if (!crossMode) {
        const targetDigest = await completedHistoryDigest(target.threadId, request.checkpoint.lastTurnId,
          params => this.createRpc(targetHome).call("thread/turns/list", params), { version: 3 });
        const expectedDigest = version === 3 ? request.checkpoint.semanticDigest
          : await completedHistoryDigest(request.task.threadId, request.checkpoint.lastTurnId,
            params => this.createRpc(sourceHome).call("thread/turns/list", params), { version: 3 });
        nativeMismatch = targetDigest !== expectedDigest;
      }
      if (crossMode || nativeMismatch) {
        // A paginated source and its legacy fork can expose different native
        // projections of identical persisted messages. The ordered persisted
        // transcript and terminal boundaries are exact and much cheaper to
        // verify than rebuilding a multi-GiB target projection through RPC.
        if (!sourcePathSafe) {
          throw new TransferConflictError("Переносимая переписка копии не совпадает с исходной задачей. VK-беседа не переключена.");
        }
        const [sourceRollout, targetRollout] = await Promise.all([
          portableRolloutDigest(request.task.rolloutPath, sourceHome, request.checkpoint.lastTurnId),
          portableRolloutDigest(target.rolloutPath, targetHome, request.checkpoint.lastTurnId),
        ]);
        if (sourceRollout !== targetRollout) {
          throw new TransferConflictError("Переносимая переписка копии не совпадает с исходной задачей. VK-беседа не переключена.");
        }
      }
    }
  }

  private async legacyCheckpoint(task: TaskRef): Promise<TransferCheckpoint> {
    const home = this.catalog.sourceHome(task);
    if (task.hostId !== "local" || !task.rolloutPath || !inside(home, task.rolloutPath)) {
      throw new TransferConflictError("Путь истории не принадлежит выбранному исходному каталогу.");
    }
    const before = await stat(task.rolloutPath);
    const lastTurnId = await this.lastTerminalTurn(home, task.threadId);
    const semanticDigest = await completedHistoryDigest(task.threadId, lastTurnId,
      params => this.createRpc(home).call("thread/turns/list", params), { version: 1 });
    const context = await readTransferContext(task.rolloutPath, lastTurnId);
    const after = await stat(task.rolloutPath);
    if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new DesktopUnavailableError("История ещё обновляется; проверка переноса будет повторена после завершения записи.");
    }
    return { lastTurnId, rolloutPath: task.rolloutPath, size: after.size, mtimeMs: after.mtimeMs, semanticDigest,
      semanticDigestVersion: 1, ...(context.cwd ? { workspace: context.cwd } : {}),
      ...(context.model ? { model: context.model } : {}), ...(context.effort ? { effort: context.effort } : {}) };
  }

  private async verifyLineage(source: TaskRef, target: DesktopTask): Promise<void> {
    const native = await this.createRpc(this.catalog.sourceHome(target)).call("thread/read", { threadId: target.threadId, includeTurns: false });
    if (!isObject(native.thread) || native.thread.id !== target.threadId) {
      throw new DesktopUnavailableError("Codex не подтвердил идентичность целевой задачи.");
    }
    // Current App Server exposes direct fork lineage. It is stronger than a
    // matching title or copied prefix. Older builds may omit it, so history
    // verification remains mandatory for every version.
    if (typeof native.thread.forkedFromId === "string" && native.thread.forkedFromId !== source.threadId
      && (!target.rolloutPath || await lastInheritedThread(target.rolloutPath, target.threadId) !== source.threadId)) {
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
          params => this.createRpc(sourceHome).call("thread/turns/list", params), { version: 3 }),
        completedHistoryDigest(target.threadId, checkpoint.lastTurnId,
          params => this.createRpc(targetHome).call("thread/turns/list", params), { allowNewerTurns: true, version: 3 }),
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
      if (request.checkpoint.semanticDigest) {
        const targetDigest = await completedHistoryDigest(match.threadId, request.checkpoint.lastTurnId,
          params => this.createRpc(this.catalog.sourceHome(match)).call("thread/turns/list", params), { version: 3 });
        const expectedDigest = (request.checkpoint.semanticDigestVersion ?? 1) === 3 ? request.checkpoint.semanticDigest
          : await completedHistoryDigest(request.task.threadId, request.checkpoint.lastTurnId,
            params => this.createRpc(this.catalog.sourceHome(request.task)).call("thread/turns/list", params), { version: 3 });
        if (targetDigest !== expectedDigest) return null;
      }
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
