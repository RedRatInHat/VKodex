import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { ActionRejectedError, type TaskDetails } from "../core/codex-tasks.js";
import type { LocalInputFile, RemoteAttachment } from "../domain/models.js";
import { safeFileName } from "../lib/files.js";
import type { Binding, BridgeChat } from "./contracts.js";
import { FileUploadRejectedError } from "./contracts.js";
import { AccessGate } from "./delivery.js";
import { BridgeStore } from "./store.js";

export const FILE_LIMITS = { maxFiles: 10, maxFileBytes: 200 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, timeoutMs: 30_000 };
export interface InboundFileLimits { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly timeoutMs: number }
export const INBOUND_FILE_LIMITS: InboundFileLimits = { maxFiles: 10, maxFileBytes: 200 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, timeoutMs: 600_000 };
interface FileJob {
  operationId: string;
  generation: number;
  directory: string;
  state: "prepared" | "accepted" | "rejected" | "uncertain";
  done: boolean;
  queued?: boolean;
  /** The Codex turn that must finish before its outbox is collected. */
  turnId?: string;
}
class OutputFilesError extends ActionRejectedError {
  constructor(message: string, readonly retryable = false) { super(message); this.name = "OutputFilesError"; }
}
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const imageName = (name: string): boolean => /\.(?:png|jpe?g|webp|gif)$/iu.test(name);
const mebibytes = (bytes: number): number => Math.ceil(bytes / (1024 * 1024));
const VK_DOCUMENT_PAGE_LIMIT = 1024 * 1024;

export function validateVkFileUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ActionRejectedError("Некорректная ссылка вложения VK."); }
  const domains = ["userapi.com", "vkuserphoto.ru", "vkuserdocs.ru", "vk.com", "vk.ru", "vk-cdn.net", "vkuser.net"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new ActionRejectedError("Вложение указывает на неподдерживаемый сервер загрузки VK.");
  }
  return url;
}

export async function downloadVkFile(raw: string, maxBytes: number, timeoutMs = FILE_LIMITS.timeoutMs): Promise<Buffer> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = validateVkFileUrl(raw);
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new ActionRejectedError("VK вернул некорректное перенаправление файла.");
        url = validateVkFileUrl(new URL(location, url).href); continue;
      }
      if (!response.ok || !response.body) throw new ActionRejectedError("Не удалось скачать вложение из VK. Сообщение не отправлено.");
      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new ActionRejectedError("Вложения превышают лимит размера."); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > maxBytes) { controller.abort(); throw new ActionRejectedError("Вложения превышают лимит размера."); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks, size);
    }
    throw new ActionRejectedError("Слишком много перенаправлений при загрузке вложения VK.");
  } catch (error) {
    throw error instanceof ActionRejectedError ? error : new ActionRejectedError("Не удалось скачать вложение из VK. Сообщение не отправлено; повтори позже.");
  } finally { clearTimeout(timer); }
}

/** Download large VK documents directly to the private inbox instead of
 * retaining the complete file in the bridge process heap. */
export async function downloadVkFileToPath(raw: string, target: string, maxBytes: number,
  timeoutMs = INBOUND_FILE_LIMITS.timeoutMs, expectedBytes?: number): Promise<number> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  try {
    let url = validateVkFileUrl(raw);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new ActionRejectedError("VK вернул некорректное перенаправление файла.");
        url = validateVkFileUrl(new URL(location, url).href); continue;
      }
      if (!response.ok || !response.body) throw new ActionRejectedError("Не удалось скачать вложение из VK. Сообщение не отправлено.");

      // For large message documents VK currently returns a small document
      // viewer with HTTP 200. The viewer contains a short-lived CDN URL in
      // Docs.initDoc; saving that page under the original .mp4 name produces
      // a convincing but corrupt attachment.
      if (["vk.com", "vk.ru"].includes(url.hostname) && /^\/doc-?\d+_\d+/u.test(url.pathname)
        && response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        const contentLength = Number(response.headers.get("content-length"));
        if (contentLength > VK_DOCUMENT_PAGE_LIMIT) { await response.body.cancel(); throw new ActionRejectedError("VK вернул слишком большую страницу вместо вложения."); }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let pageSize = 0;
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            pageSize += next.value.length;
            if (pageSize > VK_DOCUMENT_PAGE_LIMIT) { controller.abort(); throw new ActionRejectedError("VK вернул слишком большую страницу вместо вложения."); }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
        const page = Buffer.concat(chunks, pageSize).toString("latin1");
        const marker = "Docs.initDoc("; const markerAt = page.indexOf(marker); const objectAt = markerAt < 0 ? -1 : page.indexOf("{", markerAt + marker.length);
        let objectEnd = -1; let depth = 0; let quoted = false; let escaped = false;
        for (let index = objectAt; index >= 0 && index < page.length; index++) {
          const character = page[index]!;
          if (quoted) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') quoted = false;
            continue;
          }
          if (character === '"') quoted = true;
          else if (character === "{") depth++;
          else if (character === "}" && --depth === 0) { objectEnd = index + 1; break; }
        }
        let init: { docUrl?: unknown; docSize?: unknown } | null = null;
        try { init = objectAt >= 0 && objectEnd > objectAt ? JSON.parse(page.slice(objectAt, objectEnd)) as { docUrl?: unknown; docSize?: unknown } : null; }
        catch { /* A malformed viewer must not be saved as the user's file. */ }
        if (!init || typeof init.docUrl !== "string" || !init.docUrl) throw new ActionRejectedError("VK вернул страницу документа без ссылки на исходный файл. Отправь вложение повторно.");
        if (typeof init.docSize === "number" && init.docSize > maxBytes) throw new ActionRejectedError("Вложения превышают лимит размера.");
        const nextUrl = validateVkFileUrl(new URL(init.docUrl, url).href);
        if (/^\/err404\.php$/u.test(nextUrl.pathname) || nextUrl.href === url.href) throw new ActionRejectedError("Временная ссылка VK на вложение уже недоступна. Отправь файл повторно.");
        url = nextUrl; continue;
      }

      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new ActionRejectedError("Вложения превышают лимит размера."); }
      handle = await open(target, "wx", 0o600); created = true;
      const reader = response.body.getReader(); let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > maxBytes) { controller.abort(); throw new ActionRejectedError("Вложения превышают лимит размера."); }
          await handle.write(next.value);
        }
      } finally { reader.releaseLock(); }
      if (expectedBytes !== undefined && size !== expectedBytes) throw new ActionRejectedError("VK вернул неполное или неверное содержимое вложения. Отправь файл повторно.");
      return size;
    }
    throw new ActionRejectedError("Слишком много перенаправлений при загрузке вложения VK.");
  } catch (error) {
    if (handle) { await handle.close().catch(() => {}); handle = null; }
    if (created) await rm(target, { force: true }).catch(() => {});
    throw error instanceof ActionRejectedError ? error : new ActionRejectedError("Не удалось скачать вложение из VK. Сообщение не отправлено; повтори позже.");
  } finally {
    if (handle) await handle.close().catch(() => {});
    clearTimeout(timer);
  }
}

async function directory(root: string, ...segments: string[]): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new ActionRejectedError("Каталог вложений не должен быть ссылкой.");
  let current = await realpath(root);
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(segment)) throw new ActionRejectedError("Некорректный каталог вложений.");
    current = path.join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ActionRejectedError("Каталог вложений заменён ссылкой или файлом.");
  }
  return current;
}

export async function readOutputFiles(root: string, limits = FILE_LIMITS): Promise<{ name: string; contents: Buffer; kind: "image" | "file" }[]> {
  if ((await lstat(root)).isSymbolicLink()) throw new OutputFilesError("Папка выходных файлов не должна быть ссылкой.");
  const canonicalRoot = await realpath(root);
  const checkPath = async (file: string): Promise<void> => {
    const relative = path.relative(canonicalRoot, await realpath(file));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new OutputFilesError("Выходной файл находится вне папки отправки.");
  };
  const files: { name: string; contents: Buffer; kind: "image" | "file" }[] = []; let total = 0; let entries = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    const stat = await lstat(folder);
    if (depth > 8 || stat.isSymbolicLink() || !stat.isDirectory()) throw new OutputFilesError("Небезопасная структура папки выходных файлов.");
    await checkPath(folder);
    for (const entry of await readdir(folder)) {
      if (++entries > 256) throw new OutputFilesError("В папке выдачи больше 256 элементов.");
      if (entry.startsWith(".")) continue;
      const file = path.join(folder, entry); const before = await lstat(file);
      if (before.isSymbolicLink() || (before.isFile() && before.nlink !== 1)) throw new OutputFilesError("Ссылки в папке выходных файлов не отправляются.");
      if (before.isDirectory()) { await walk(file, depth + 1); continue; }
      if (!before.isFile()) continue;
      await checkPath(file);
      if (files.length >= limits.maxFiles) throw new OutputFilesError(`В одной выдаче можно отправить не больше ${limits.maxFiles} файлов.`);
      if (before.size > limits.maxFileBytes) throw new OutputFilesError(`Файл «${safeFileName(entry, "file")}» занимает ${mebibytes(before.size)} МиБ при лимите ${mebibytes(limits.maxFileBytes)} МиБ.`);
      if (total + before.size > limits.maxTotalBytes) throw new OutputFilesError(`Суммарный размер выдачи превышает ${mebibytes(limits.maxTotalBytes)} МиБ.`);
      const handle = await open(file, "r"); const chunks: Buffer[] = []; let size = 0;
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw new OutputFilesError("Выходной файл изменился во время чтения.", true);
        while (true) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, limits.maxFileBytes - size + 1));
          const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break;
          size += read.bytesRead;
          if (size > limits.maxFileBytes) throw new OutputFilesError(`Файл «${safeFileName(entry, "file")}» превышает лимит ${mebibytes(limits.maxFileBytes)} МиБ.`);
          if (total + size > limits.maxTotalBytes) throw new OutputFilesError(`Суммарный размер выдачи превышает ${mebibytes(limits.maxTotalBytes)} МиБ.`);
          chunks.push(buffer.subarray(0, read.bytesRead));
        }
        const after = await handle.stat();
        if (after.size !== size || after.mtimeMs !== before.mtimeMs) throw new OutputFilesError("Выходной файл ещё записывается; отправка будет повторена позже.", true);
        await checkPath(file);
      } finally { await handle.close(); }
      total += size;
      files.push({ name: safeFileName(path.relative(canonicalRoot, file).replaceAll(path.sep, "_"), "file"), contents: Buffer.concat(chunks, size), kind: imageName(entry) ? "image" : "file" });
    }
  };
  await walk(canonicalRoot, 0); return files;
}

export class TaskFiles {
  private readonly completed = new Set<string>();
  private readonly completedTurns = new Map<string, Set<string>>();
  private readonly retries = new Map<string, number>();
  private working: Promise<void> | null = null;
  private readonly collections = new Map<string, Promise<number>>();
  private stopped = false;
  constructor(private readonly root: string, private readonly store: BridgeStore, private readonly chat: BridgeChat, private readonly gate: AccessGate,
    private readonly inboundLimits: InboundFileLimits = INBOUND_FILE_LIMITS) {}
  private jobs(bindingId: string): FileJob[] { return this.store.getValue<FileJob[]>(`file-jobs:${bindingId}`) ?? []; }
  private save(bindingId: string, jobs: FileJob[]): void { this.store.setValue(`file-jobs:${bindingId}`, jobs); }
  private async check(binding: Binding, generation: number): Promise<void> {
    if (this.stopped || binding.peerId === null || this.store.streamGeneration(binding.id) !== generation || !await this.gate.check(binding.peerId) || this.store.streamGeneration(binding.id) !== generation) throw new ActionRejectedError("Передача файлов остановлена: беседа больше не подключена.");
  }
  async prepare(binding: Binding, operationId: string, attachments: readonly RemoteAttachment[]): Promise<{ inputFiles: LocalInputFile[]; outboxDir: string }> {
    if (attachments.length > this.inboundLimits.maxFiles) throw new ActionRejectedError(`За одно сообщение можно передать до ${this.inboundLimits.maxFiles} файлов.`);
    const generation = this.store.streamGeneration(binding.id); await this.check(binding, generation);
    const jobDirectory = digest(`${binding.id}:${operationId}`);
    const inbox = await directory(this.root, jobDirectory, "inbox"); const outboxDir = await directory(this.root, jobDirectory, "outbox");
    const inputFiles: LocalInputFile[] = []; let total = 0;
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.sizeBytes !== undefined && attachment.sizeBytes > this.inboundLimits.maxFileBytes) throw new ActionRejectedError(`Вложение больше ${mebibytes(this.inboundLimits.maxFileBytes)} МиБ.`);
      if (attachment.sizeBytes !== undefined && total + attachment.sizeBytes > this.inboundLimits.maxTotalBytes) throw new ActionRejectedError(`Суммарный размер вложений больше ${mebibytes(this.inboundLimits.maxTotalBytes)} МиБ.`);
      await this.check(binding, generation);
      const originalName = safeFileName(attachment.fileName, `file-${index + 1}`); const target = path.join(inbox, `${index + 1}-${originalName}`);
      const size = await downloadVkFileToPath(attachment.url, target,
        Math.min(this.inboundLimits.maxFileBytes, this.inboundLimits.maxTotalBytes - total), this.inboundLimits.timeoutMs, attachment.sizeBytes);
      total += size;
      inputFiles.push({ path: target, originalName, kind: attachment.kind, sizeBytes: size });
    }
    await this.check(binding, generation);
    this.completed.delete(binding.id);
    this.save(binding.id, [...this.jobs(binding.id), { operationId, generation, directory: jobDirectory, state: "prepared", done: false }]);
    return { inputFiles, outboxDir };
  }
  finish(bindingId: string, operationId: string, state: "accepted" | "rejected" | "uncertain", turnId?: string): void {
    this.save(bindingId, this.jobs(bindingId).map(job => job.operationId === operationId
      ? { ...job, state, ...(turnId ? { turnId } : {}) }
      : job));
  }
  markQueued(bindingId: string, operationId: string): void {
    this.save(bindingId, this.jobs(bindingId).map(job => job.operationId === operationId ? { ...job, queued: true } : job));
  }
  pendingQueuedOperations(bindingId: string): ReadonlySet<string> {
    return new Set(this.jobs(bindingId).filter(job => job.queued && !job.turnId).map(job => job.operationId));
  }
  associateTurn(bindingId: string, operationId: string, turnId: string): void {
    if (!this.jobs(bindingId).some(job => job.operationId === operationId && !job.turnId)) return;
    this.save(bindingId, this.jobs(bindingId).map(job => job.operationId === operationId && !job.turnId
      ? { ...job, turnId, done: false, queued: false }
      : job));
  }
  observe(bindingId: string, status: TaskDetails["status"], turnId?: string | null): void {
    if (["idle", "failed", "interrupted"].includes(status)) {
      this.completed.add(bindingId);
      if (turnId) {
        const turns = this.completedTurns.get(bindingId) ?? new Set<string>();
        turns.add(turnId); this.completedTurns.set(bindingId, turns);
      }
    } else if (!this.completedTurns.get(bindingId)?.size) this.completed.delete(bindingId);
  }
  collect(binding: Binding, manual = false): Promise<number> {
    const existing = this.collections.get(binding.id); if (existing) return existing;
    const work = this.collectNow(binding, manual).finally(() => { this.collections.delete(binding.id); });
    this.collections.set(binding.id, work); return work;
  }
  private async collectNow(binding: Binding, manual: boolean): Promise<number> {
    const generation = this.store.streamGeneration(binding.id); await this.check(binding, generation);
    if (!this.chat.uploadFile) throw new ActionRejectedError("Загрузка файлов в VK недоступна.");
    let count = 0; let retryableFailure: OutputFilesError | null = null;
    const completedTurns = this.completedTurns.get(binding.id) ?? new Set<string>();
    for (const job of this.jobs(binding.id).filter(job => job.generation === generation && job.state === "accepted" && !job.queued
      && (manual || (!job.done && (job.turnId ? completedTurns.has(job.turnId) : this.completed.has(binding.id)))))) {
      const outbox = await directory(this.root, job.directory, "outbox");
      let outputFiles: Awaited<ReturnType<typeof readOutputFiles>>;
      try { outputFiles = await readOutputFiles(outbox); }
      catch (error) {
        if (!(error instanceof OutputFilesError)) throw error;
        this.store.enqueue(`files-error:${binding.id}:${job.operationId}`, binding.peerId!, {
          text: `Не удалось забрать файлы одного запроса: ${error.message} Более новые выдачи продолжат отправляться. Исправь эту выдачу и отправь /files.`, silent: true,
        }, binding.id);
        if (error.retryable) retryableFailure ??= error;
        else this.save(binding.id, this.jobs(binding.id).map(item => item.operationId === job.operationId ? { ...item, done: true } : item));
        continue;
      }
      for (const file of outputFiles) {
        const key = `file:${binding.id}:${job.operationId}:${digest(file.name + ":" + digest(file.contents))}`;
        if (this.store.getValue<boolean>(`${key}:queued`)) continue;
        if (!manual && this.store.getValue<boolean>(`${key}:rejected`)) continue;
        await this.check(binding, generation);
        let attachment = this.store.getValue<string>(`${key}:uploaded`);
        if (!attachment) {
          try { attachment = await this.chat.uploadFile(binding.peerId!, file.name, file.contents, file.kind); }
          catch (error) {
            if (!(error instanceof FileUploadRejectedError)) throw error;
            await this.check(binding, generation);
            this.store.setValue(`${key}:rejected`, true);
            this.store.enqueue(`${key}:error`, binding.peerId!, { text: `Файл «${file.name}» не отправлен. ${error.message}`, silent: true }, binding.id);
            continue;
          }
          this.store.setValue(`${key}:uploaded`, attachment);
        }
        await this.check(binding, generation);
        this.store.atomic(() => {
          this.store.enqueue(key, binding.peerId!, { text: file.name, attachments: [attachment!] }, binding.id);
          this.store.setValue(`${key}:queued`, true);
        }); count++;
      }
      this.save(binding.id, this.jobs(binding.id).map(item => item.operationId === job.operationId ? { ...item, done: true } : item));
    }
    if (retryableFailure && !manual) throw retryableFailure;
    return count;
  }
  tick(): Promise<void> {
    if (this.working || this.stopped) return this.working ?? Promise.resolve();
    this.working = this.flush().finally(() => { this.working = null; }); return this.working;
  }
  private async flush(): Promise<void> {
    for (const id of this.completed) {
      const generation = this.store.streamGeneration(id);
      if (this.stopped || Date.now() < (this.retries.get(id) ?? 0) || !this.jobs(id).some(job => job.generation === generation && job.state === "accepted" && !job.done)) continue;
      const binding = this.store.getBinding(id); if (!binding?.attached || binding.peerId === null) continue;
      try { await this.collect(binding); this.retries.delete(id); }
      catch (error) {
        this.retries.set(id, Date.now() + 60_000);
        const current = this.store.getBinding(id);
        if (current?.attached && this.store.streamGeneration(id) === generation && !(error instanceof OutputFilesError)) this.store.enqueue(`files-error:${id}:${this.jobs(id).at(-1)?.operationId}`, binding.peerId, { text: error instanceof ActionRejectedError ? error.message : "Не удалось отправить выходные файлы. Можно повторить командой /files.", silent: true }, id);
      }
    }
  }
  async stop(): Promise<void> { this.stopped = true; this.completed.clear(); await this.working; await Promise.allSettled(this.collections.values()); }
}
