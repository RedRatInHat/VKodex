import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ActionRejectedError, type TaskDetails } from "../core/codex-tasks.js";
import type { LocalInputFile, RemoteAttachment } from "../domain/models.js";
import { safeFileName } from "../lib/files.js";
import type { Binding, BridgeChat } from "./contracts.js";
import { FileUploadRejectedError, FileUploadStorageFullError, type VkDocumentRecord } from "./contracts.js";
import { AccessGate } from "./delivery.js";
import { BridgeStore } from "./store.js";
import { readWindowsProcessIdentity } from "../desktop/windows-process-identity.js";

export const FILE_LIMITS = { maxFiles: 10, maxFileBytes: 200 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, timeoutMs: 30_000 };
export interface InboundFileLimits { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly timeoutMs: number }
export const INBOUND_FILE_LIMITS: InboundFileLimits = { maxFiles: 10, maxFileBytes: 200 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, timeoutMs: 600_000 };
export interface OutputFile { readonly name: string; readonly contents: Buffer; readonly kind: "image" | "file" }
interface OutputFileReadOptions {
  readonly allowBatchOverflow?: boolean;
  /** Keep valid siblings when one output file is too large. */
  readonly skipOversizedFiles?: boolean;
  readonly onSkippedFile?: (error: OutputFilesError) => void;
  /** A stable, previously processed file need not be loaded again. */
  readonly skipFile?: (relativePath: string, fingerprint: string) => boolean;
  /** Process one bounded file buffer at a time instead of retaining the whole outbox. */
  readonly onFile?: (file: OutputFile, relativePath: string, fingerprint: string) => Promise<void>;
}
interface FileJob {
  operationId: string;
  generation: number;
  directory: string;
  /** Original task identity survives a verified transfer of this file job. */
  threadId?: string;
  sourceId?: string;
  /** Existing jobs retain their original key derivation across an upgrade. */
  keyFormat?: "relative-path-v2";
  state: "prepared" | "accepted" | "rejected" | "uncertain";
  done: boolean;
  /** Completion is persisted so late output remains eligible after restart. */
  completed?: boolean;
  /** Legacy producers are rescanned automatically for a bounded period. */
  autoScanUntil?: number | undefined;
  nextScanAt?: number | undefined;
  scanDelayMs?: number;
  queued?: boolean;
  /** The Codex turn that must finish before its outbox is collected. */
  turnId?: string;
}
interface LegacyStageIdentity { readonly dev: number; readonly ino: number; readonly birthtimeMs: number }
interface ExactStageIdentity { readonly version: 2; readonly dev: string; readonly ino: string; readonly birthtimeNs: string }
type StageIdentity = LegacyStageIdentity | ExactStageIdentity;
type StageBigIntStat = { readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint };
interface StagedFile {
  readonly key: string;
  /** Exact VK message batch containing this version, persisted with :queued. */
  readonly deliveryKey?: string;
  readonly attachment?: string;
  readonly peerId?: number;
  readonly path: string;
  readonly relativePath: string;
  readonly name: string;
  readonly kind: "image" | "file";
  readonly fingerprint: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Filesystem object captured from the open staged file. Legacy receipts omit this and are not recyclable. */
  readonly identity?: StageIdentity;
  readonly bindingId: string;
  readonly threadId: string;
  readonly sourceId?: string;
  readonly operationId: string;
  readonly generation: number;
  readonly stagedAt: number;
  readonly turnId?: string;
}
class OutputFilesError extends ActionRejectedError {
  constructor(message: string, readonly retryable = false) { super(message); this.name = "OutputFilesError"; }
}
class StageQuotaError extends ActionRejectedError {}
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const positiveDecimal = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/u.test(value);
const validStageIdentity = (value: unknown): value is StageIdentity => {
  if (typeof value !== "object" || value === null) return false;
  if ("version" in value) {
    const identity = value as ExactStageIdentity;
    return identity.version === 2 && positiveDecimal(identity.dev) && positiveDecimal(identity.ino)
      && positiveDecimal(identity.birthtimeNs);
  }
  const identity = value as LegacyStageIdentity;
  return Number.isSafeInteger(identity.dev) && identity.dev > 0
    && Number.isSafeInteger(identity.ino) && identity.ino > 0
    && Number.isFinite(identity.birthtimeMs) && identity.birthtimeMs > 0;
};
export const captureStageIdentity = (stat: StageBigIntStat): ExactStageIdentity => ({
  version: 2, dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString(),
});
export const sameStageIdentity = (
  stat: StageBigIntStat, identity: StageIdentity,
  legacyStat?: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number },
): boolean => {
  if (!validStageIdentity(identity) || stat.dev <= 0n || stat.ino <= 0n || stat.birthtimeNs <= 0n) return false;
  if ("version" in identity) return stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino
    && stat.birthtimeNs.toString() === identity.birthtimeNs;
  return !!legacyStat && Number.isSafeInteger(legacyStat.dev) && Number.isSafeInteger(legacyStat.ino)
    && BigInt(legacyStat.dev) === stat.dev && BigInt(legacyStat.ino) === stat.ino
    && legacyStat.dev === identity.dev && legacyStat.ino === identity.ino
    && legacyStat.birthtimeMs === identity.birthtimeMs;
};
const fileFingerprint = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const imageName = (name: string): boolean => /\.(?:png|jpe?g|webp|gif)$/iu.test(name);
const mebibytes = (bytes: number): number => Math.ceil(bytes / (1024 * 1024));
const VK_DOCUMENT_PAGE_LIMIT = 1024 * 1024;
const MAX_OUTPUT_ENTRIES = 4_096;
const VK_DOCUMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INITIAL_LATE_SCAN_MS = 60_000;
const MAX_LATE_SCAN_MS = 60 * 60_000;
const LATE_SCAN_WINDOW_MS = 48 * 60 * 60_000;
const STAGE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MIN_STAGE_FREE_BYTES = 512 * 1024 * 1024;
const execFileAsync = promisify(execFile);
/** Windows-only single-file Recycle Bin move. The caller verifies its durable
 * identity first; pathname replacement during the move remains a race. */
export async function recycleStageOnWindows(target: string): Promise<void> {
  if (process.platform !== "win32") throw new ActionRejectedError("Корзина Windows недоступна на этой платформе.");
  if (!path.isAbsolute(target)) throw new ActionRejectedError("Для Корзины требуется абсолютный путь к файлу.");
  const before = await lstat(target).catch(() => { throw new ActionRejectedError("Файл для Корзины недоступен; резерв сохранён."); });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new ActionRejectedError("Файл для Корзины должен быть обычным файлом без ссылок.");
  // The path travels through the child environment, never through PowerShell
  // source or a shell-interpreted argument.
  const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:VKODEX_STAGE_RECYCLE_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)";
  try {
    await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      env: { ...process.env, VKODEX_STAGE_RECYCLE_TARGET: target }, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024,
    });
  } catch { throw new ActionRejectedError("Не удалось переместить staged-файл в Корзину Windows; резерв сохранён."); }
}
function isOwnedDocumentRecord(record: VkDocumentRecord): boolean {
  if (!record.fileKey.startsWith("file:")) return false;
  const match = /^doc(-?\d+)_([0-9]+)(?:_|$)/u.exec(record.attachment);
  return !!match && Number(match[1]) === record.ownerId && Number(match[2]) === record.documentId;
}

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

export async function readOutputFiles(root: string, limits = FILE_LIMITS, options: OutputFileReadOptions = {}): Promise<OutputFile[]> {
  if ((await lstat(root)).isSymbolicLink()) throw new OutputFilesError("Папка выходных файлов не должна быть ссылкой.");
  const canonicalRoot = await realpath(root);
  const checkPath = async (file: string): Promise<void> => {
    const relative = path.relative(canonicalRoot, await realpath(file));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new OutputFilesError("Выходной файл находится вне папки отправки.");
  };
  const files: OutputFile[] = []; let total = 0; let entries = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    const stat = await lstat(folder);
    if (depth > 8 || stat.isSymbolicLink() || !stat.isDirectory()) throw new OutputFilesError("Небезопасная структура папки выходных файлов.");
    await checkPath(folder);
    for (const entry of await readdir(folder)) {
      if (++entries > MAX_OUTPUT_ENTRIES) throw new OutputFilesError(`В папке выдачи больше ${MAX_OUTPUT_ENTRIES} элементов.`);
      if (entry.startsWith(".")) continue;
      const file = path.join(folder, entry); const before = await lstat(file);
      if (before.isSymbolicLink() || (before.isFile() && before.nlink !== 1)) throw new OutputFilesError("Ссылки в папке выходных файлов не отправляются.");
      if (before.isDirectory()) { await walk(file, depth + 1); continue; }
      if (!before.isFile()) continue;
      await checkPath(file);
      const relativePath = path.relative(canonicalRoot, file);
      if (options.skipFile?.(relativePath, fileFingerprint(before))) continue;
      if (!options.allowBatchOverflow && files.length >= limits.maxFiles) throw new OutputFilesError(`В одной выдаче можно отправить не больше ${limits.maxFiles} файлов.`);
      if (before.size > limits.maxFileBytes) {
        const error = new OutputFilesError(`Файл «${safeFileName(entry, "file")}» занимает ${mebibytes(before.size)} МиБ при лимите ${mebibytes(limits.maxFileBytes)} МиБ.`);
        if (options.skipOversizedFiles) { options.onSkippedFile?.(error); continue; }
        throw error;
      }
      if (!options.allowBatchOverflow && total + before.size > limits.maxTotalBytes) throw new OutputFilesError(`Суммарный размер выдачи превышает ${mebibytes(limits.maxTotalBytes)} МиБ.`);
      const handle = await open(file, "r"); const contents = Buffer.allocUnsafe(before.size); let size = 0;
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw new OutputFilesError("Выходной файл изменился во время чтения.", true);
        while (size < contents.length) {
          const read = await handle.read(contents, size, Math.min(64 * 1024, contents.length - size), null); if (!read.bytesRead) break;
          size += read.bytesRead;
          if (!options.allowBatchOverflow && total + size > limits.maxTotalBytes) throw new OutputFilesError(`Суммарный размер выдачи превышает ${mebibytes(limits.maxTotalBytes)} МиБ.`);
        }
        const extra = await handle.read(Buffer.alloc(1), 0, 1, null);
        if (extra.bytesRead) throw new OutputFilesError("Выходной файл изменился во время чтения.", true);
        const after = await handle.stat();
        if (after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new OutputFilesError("Выходной файл ещё записывается; отправка будет повторена позже.", true);
        await checkPath(file);
      } catch (error) {
        if (options.skipOversizedFiles && error instanceof OutputFilesError && /лимит|превышает/iu.test(error.message)) {
          options.onSkippedFile?.(error); continue;
        }
        throw error;
      } finally { await handle.close(); }
      total += size;
      const output = { name: safeFileName(relativePath.replaceAll(path.sep, "_"), "file"), contents, kind: imageName(entry) ? "image" : "file" } as const;
      if (options.onFile) await options.onFile(output, relativePath, fileFingerprint(before));
      else files.push(output);
    }
  };
  await walk(canonicalRoot, 0); return files;
}

/**
 * Split a completed outbox into VKodex delivery batches. The bridge sends one
 * VK attachment per queued message, but keeping the batches explicit prevents
 * the old all-or-nothing file-count and total-size check from discarding an
 * otherwise valid outbox.
 */
export function batchOutputFiles(files: readonly OutputFile[], limits = FILE_LIMITS): OutputFile[][] {
  const batches: OutputFile[][] = [];
  let current: OutputFile[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const startsNewBatch = current.length > 0 && (current.length >= limits.maxFiles || currentBytes + file.contents.length > limits.maxTotalBytes);
    if (startsNewBatch) { batches.push(current); current = []; currentBytes = 0; }
    current.push(file); currentBytes += file.contents.length;
    // A single file is already bounded by maxFileBytes. Keep it as a batch on
    // its own even if a caller supplies a smaller total limit.
    if (current.length >= limits.maxFiles || currentBytes >= limits.maxTotalBytes) { batches.push(current); current = []; currentBytes = 0; }
  }
  if (current.length) batches.push(current);
  return batches;
}

export class TaskFiles {
  private readonly completed = new Set<string>();
  private readonly retries = new Map<string, number>();
  private working: Promise<void> | null = null;
  private readonly collections = new Map<string, Promise<number>>();
  private reconciliation: Promise<number> | null = null;
  private stageWriterIdentity: ReturnType<typeof readWindowsProcessIdentity> = null;
  private stopped = false;
  constructor(private readonly root: string, private readonly store: BridgeStore, private readonly chat: BridgeChat, private readonly gate: AccessGate,
    private readonly inboundLimits: InboundFileLimits = INBOUND_FILE_LIMITS,
    /** Opt-in pilot: stage new output versions before upload; default delivery uses source bytes. */
    private readonly stageNewUploads = false,
    private readonly recycleStage: (target: string) => Promise<void> = recycleStageOnWindows,
    private readonly stageFreeBytes: (folder: string) => Promise<bigint> = async folder => {
      const free = await statfs(folder);
      return BigInt(free.bavail) * BigInt(free.bsize);
    },
    private readonly observeStageWriter: typeof readWindowsProcessIdentity = readWindowsProcessIdentity) {}
  private jobs(bindingId: string): FileJob[] { return this.store.getValue<FileJob[]>(`file-jobs:${bindingId}`) ?? []; }
  private save(bindingId: string, jobs: FileJob[]): void { this.store.setValue(`file-jobs:${bindingId}`, jobs); }
  private terminalTurns(bindingId: string): ReadonlySet<string> {
    return new Set(this.store.getValue<string[]>(`file-terminal-turns:${bindingId}`) ?? []);
  }
  private documentRegistry(): VkDocumentRecord[] {
    return this.store.getValue<VkDocumentRecord[]>("vk-document-registry") ?? [];
  }
  private rememberDocument(record: VkDocumentRecord): void {
    const records = this.documentRegistry().filter(item => item.attachment !== record.attachment);
    this.store.setValue("vk-document-registry", [...records, record].slice(-4096));
  }
  private stageRoot(): string { return path.join(path.dirname(path.resolve(this.root)), `${path.basename(this.root)}-staging`); }
  private stageIndexKey(bindingId: string, operationId: string): string { return `file-stage-index:${bindingId}:${operationId}`; }
  private stageIndex(bindingId: string, operationId: string): Record<string, StagedFile> {
    return this.store.getValue<Record<string, StagedFile>>(this.stageIndexKey(bindingId, operationId)) ?? {};
  }
  private async stageDirectory(job: FileJob, bindingId: string): Promise<string> {
    return directory(this.stageRoot(), digest(bindingId), digest(job.operationId));
  }
  private async stagedContents(receipt: StagedFile, job: FileJob, bindingId: string, reuse?: Buffer): Promise<Buffer> {
    const folder = await this.stageDirectory(job, bindingId);
    // A transfer may advance the job's routing generation; the receipt keeps
    // the generation at capture time as provenance for its immutable bytes.
    if (receipt.bindingId !== bindingId || receipt.operationId !== job.operationId
      || (job.threadId !== undefined &&
        (receipt.threadId !== job.threadId ||
          (receipt.sourceId ?? "") !== (job.sourceId ?? "")))
      || !receipt.threadId || !Number.isSafeInteger(receipt.stagedAt)
      || (receipt.turnId !== undefined && receipt.turnId !== job.turnId)
      || typeof receipt.relativePath !== "string" || !receipt.relativePath
      || receipt.name !== safeFileName(receipt.relativePath.replaceAll(path.sep, "_"), "file")
      || receipt.kind !== (imageName(path.basename(receipt.relativePath)) ? "image" : "file")
      || !/^[0-9a-f-]+\.bin$/u.test(path.basename(receipt.path))
      || path.dirname(path.resolve(receipt.path)) !== folder || receipt.bytes > FILE_LIMITS.maxFileBytes || receipt.bytes < 0
      || !/^[0-9a-f]{64}$/u.test(receipt.sha256)
      || (receipt.identity !== undefined && !validStageIdentity(receipt.identity))) throw new ActionRejectedError("Квитанция staged-файла повреждена; загрузка остановлена.");
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const before = await lstat(receipt.path, { bigint: true });
      const legacyBefore = receipt.identity && !("version" in receipt.identity) ? await lstat(receipt.path) : undefined;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(receipt.bytes)) throw new Error("invalid stage file");
      handle = await open(receipt.path, "r");
      const opened = await handle.stat({ bigint: true });
      const legacyOpened = receipt.identity && !("version" in receipt.identity) ? await handle.stat() : undefined;
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.birthtimeNs !== before.birthtimeNs
        || opened.nlink !== 1n || opened.size !== BigInt(receipt.bytes)) throw new Error("changed stage file");
      if (receipt.identity && (!sameStageIdentity(before, receipt.identity, legacyBefore)
        || !sameStageIdentity(opened, receipt.identity, legacyOpened)))
        throw new Error("replaced stage file");
      const contents = reuse ?? Buffer.allocUnsafe(receipt.bytes);
      if (contents.length !== receipt.bytes) throw new Error("incorrect stage buffer");
      let size = 0;
      while (size < contents.length) {
        const read = await handle.read(contents, size, Math.min(64 * 1024, contents.length - size), null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, null);
      const after = await handle.stat({ bigint: true });
      const legacyAfter = receipt.identity && !("version" in receipt.identity) ? await handle.stat() : undefined;
      if (size !== receipt.bytes || extra.bytesRead || after.size !== before.size || after.nlink !== 1n
        || after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs
        || digest(contents) !== receipt.sha256 || (receipt.identity && !sameStageIdentity(after, receipt.identity, legacyAfter)))
        throw new Error("corrupt stage file");
      return contents;
    } catch {
      throw new ActionRejectedError(`Staged-версия файла «${receipt.name}» отсутствует или повреждена; загрузка остановлена. Исходный файл не будет использован вместо неё.`);
    } finally { await handle?.close(); }
  }
  private async stageFile(file: OutputFile, relativePath: string, fingerprint: string, key: string, job: FileJob, binding: Binding): Promise<StagedFile> {
    const existing = this.stageIndex(binding.id, job.operationId)[key];
    if (existing) return existing;
    const folder = await this.stageDirectory(job, binding.id);
    const observedFree = await this.stageFreeBytes(folder);
    if (observedFree < BigInt(MIN_STAGE_FREE_BYTES + file.contents.length))
      throw new StageQuotaError("Недостаточно свободного места для staged-файла и резерва диска. Загрузка в VK остановлена.");
    const target = path.join(folder, `${randomUUID()}.bin`);
    // The existing Windows observer supplies a kernel birth identity. Other
    // platforms keep their reservations charged as legacy rows on a crash.
    let writer = undefined;
    if (process.platform === "win32") {
      let observed = this.stageWriterIdentity;
      try { observed ??= this.observeStageWriter(process.pid); }
      catch { throw new ActionRejectedError("Не удалось подтвердить процесс записи staged-файла; загрузка остановлена."); }
      if (!observed || observed.pid !== process.pid)
        throw new ActionRejectedError("Не удалось подтвердить процесс записи staged-файла; загрузка остановлена.");
      this.stageWriterIdentity = observed;
      writer = observed;
    }
    const reservation = this.store.reserveStage(key, binding.id, job.operationId, file.contents.length, target, observedFree, writer);
    if (reservation === "limit") throw new StageQuotaError("Превышен лимит staged-файлов для запроса или всего хранилища. Загрузка в VK остановлена; освободи место после проверки сохранённых версий и повтори /files.");
    if (reservation === "existing") throw new ActionRejectedError("Обнаружена незавершённая staged-версия файла. Загрузка остановлена до сверки сохранённых данных; повтор не создаст другую версию автоматически.");
    const handle = await open(target, "wx", 0o600);
    let identity: StageIdentity;
    try {
      await handle.writeFile(file.contents); await handle.sync();
      const staged = await handle.stat({ bigint: true });
      identity = captureStageIdentity(staged);
      if (!validStageIdentity(identity) || !staged.isFile() || staged.nlink !== 1n || staged.size !== BigInt(file.contents.length))
        throw new ActionRejectedError("Не удалось подтвердить идентичность staged-файла; загрузка остановлена.");
    }
    finally { await handle.close(); }
    const sourceId = job.threadId === undefined ? binding.sourceId : job.sourceId;
    const receipt: StagedFile = { key, path: target, relativePath, name: file.name, kind: file.kind, fingerprint,
      sha256: digest(file.contents), bytes: file.contents.length, identity, bindingId: binding.id, threadId: job.threadId ?? binding.threadId,
      ...(sourceId ? { sourceId } : {}), operationId: job.operationId,
      generation: job.generation, stagedAt: Date.now(), ...(job.turnId ? { turnId: job.turnId } : {}) };
    this.store.atomic(() => {
      this.store.setValue(this.stageIndexKey(binding.id, job.operationId), { ...this.stageIndex(binding.id, job.operationId), [key]: receipt });
      this.store.markStageReady(key, target);
    });
    return receipt;
  }
  /** Explicit maintenance entry point. Never runs from tick and never touches
   * incomplete reservations, unknown uploads, or undelivered VK batches. */
  reconcileStagedArtifacts(now = Date.now()): Promise<number> {
    if (this.reconciliation) return this.reconciliation;
    const work = this.reconcileStagedArtifactsNow(now).finally(() => { this.reconciliation = null; });
    this.reconciliation = work;
    return work;
  }
  /** Explicit, bounded repair for a reservation whose writer died before
   * durable receipt creation. It never moves or removes staged bytes. */
  async reconcileAbandonedStageReservations(limit = 64): Promise<number> {
    let abandoned = 0;
    for (const candidate of this.store.abandonedStageCandidates(limit)) {
      let observed;
      try { observed = this.observeStageWriter(candidate.writer.pid); }
      catch { continue; }
      if (observed !== null && (!observed || observed.pid !== candidate.writer.pid
        || !/^[1-9]\d{0,23}$/u.test(observed.birthTicks) || observed.birthTicks === candidate.writer.birthTicks)) continue;
      // ENOENT alone proves absence. Permission and I/O failures retain quota.
      try { await lstat(candidate.path); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; }
      try { if (this.store.abandonStageReservation(candidate)) abandoned++; }
      catch { /* Invalid or inaccessible receipt state keeps the reservation. */ }
    }
    return abandoned;
  }
  private async reconcileStagedArtifactsNow(now: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now < STAGE_RETENTION_MS) throw new RangeError("Invalid stage reconciliation time");
    let recycled = 0;
    for (const row of this.store.stageRecycleCandidates()) {
      const receipt = this.stageIndex(row.bindingId, row.operationId)[row.key];
      if (!receipt || receipt.path !== row.path || receipt.bytes !== row.bytes || receipt.key !== row.key
        || !validStageIdentity(receipt.identity)
        || !receipt.deliveryKey?.startsWith(`files:${row.bindingId}:${row.operationId}:`)
        || !receipt.attachment || !Number.isSafeInteger(receipt.peerId) || receipt.peerId! <= 0
        || !Number.isSafeInteger(receipt.stagedAt) || receipt.stagedAt <= 0 || receipt.stagedAt > now - STAGE_RETENTION_MS
        || this.store.getValue<boolean>(`${row.key}:queued`) !== true
        || this.store.getValue<string>(`${row.key}:upload-state`) !== "uploaded"
        || this.store.getValue<string>(`${row.key}:uploaded`) !== receipt.attachment
        || !this.store.hasConfirmedFileDelivery(receipt.deliveryKey, row.bindingId, receipt.peerId!, receipt.attachment)) continue;
      const job = this.jobs(row.bindingId).find(item => item.operationId === row.operationId);
      if (!job) continue;
      const verified = await lstat(row.path, { bigint: true }).catch(() => null);
      if (!verified) continue;
      try { await this.stagedContents(receipt, job, row.bindingId); }
      catch (error) { if (error instanceof ActionRejectedError) continue; throw error; }
      if (!this.store.markStageRecyclePending(row.key, row.path)) continue;
      // Recheck after journaling: an accidental path replacement during that
      // interval must not recycle another file or release this reservation.
      // A same-user actor can still race a pathname-based Recycle Bin move.
      try { await this.stagedContents(receipt, job, row.bindingId); }
      catch (error) { if (error instanceof ActionRejectedError) continue; throw error; }
      const current = await lstat(row.path, { bigint: true }).catch(() => null);
      const legacyCurrent = current && !("version" in receipt.identity) ? await lstat(row.path).catch(() => null) : undefined;
      if (!current || current.dev !== verified.dev || current.ino !== verified.ino
        || current.birthtimeNs !== verified.birthtimeNs || !sameStageIdentity(current, receipt.identity, legacyCurrent ?? undefined)) continue;
      // A failed or interrupted move leaves the reservation charged. Missing
      // files on a later run are not interpreted as successful recycling.
      await this.recycleStage(row.path);
      this.store.markStageRecycled(row.key, row.path);
      recycled++;
    }
    return recycled;
  }
  private async cleanupDocuments(except: readonly string[]): Promise<"removed" | "no-candidate" | "not-removed"> {
    if (!this.chat.cleanupDocuments) return "not-removed";
    const protectedAttachments = new Set(except);
    for (const delivery of this.store.pendingDeliveries()) for (const attachment of delivery.view.attachments ?? []) protectedAttachments.add(attachment);
    const delivered = this.store.deliveredFileAttachments();
    const cutoff = Date.now() - VK_DOCUMENT_RETENTION_MS;
    const candidates = this.documentRegistry()
      .filter(record => isOwnedDocumentRecord(record) && Number.isSafeInteger(record.uploadedAt) && record.uploadedAt > 0 && record.uploadedAt <= cutoff
        && delivered.has(record.attachment) && !protectedAttachments.has(record.attachment))
      .sort((a, b) => a.uploadedAt - b.uploadedAt)
      .slice(0, 100);
    if (!candidates.length) return "no-candidate";
    const removed = await this.chat.cleanupDocuments(candidates);
    const candidateAttachments = new Set(candidates.map(record => record.attachment));
    const deleted = new Set(removed.filter(attachment => candidateAttachments.has(attachment)));
    if (!deleted.size) return "not-removed";
    this.store.setValue("vk-document-registry", this.documentRegistry().filter(record => !deleted.has(record.attachment)));
    return "removed";
  }
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
    this.save(binding.id, [...this.jobs(binding.id), { operationId, generation, directory: jobDirectory,
      threadId: binding.threadId, ...(binding.sourceId ? { sourceId: binding.sourceId } : {}),
      keyFormat: "relative-path-v2", state: "prepared", done: false, completed: false }]);
    return { inputFiles, outboxDir };
  }
  finish(bindingId: string, operationId: string, state: "accepted" | "rejected" | "uncertain", turnId?: string): void {
    const terminal = !!turnId && this.terminalTurns(bindingId).has(turnId);
    this.save(bindingId, this.jobs(bindingId).map(job => job.operationId === operationId
      ? { ...job, state, ...(turnId ? { turnId } : {}),
        ...(state === "accepted" && terminal ? { completed: true, autoScanUntil: Date.now() + LATE_SCAN_WINDOW_MS, nextScanAt: 0 } : {}) }
      : job));
  }
  markQueued(bindingId: string, operationId: string): void {
    this.save(bindingId, this.jobs(bindingId).map(job => job.operationId === operationId ? { ...job, queued: true } : job));
  }
  pendingQueuedOperations(bindingId: string): ReadonlySet<string> {
    return new Set(this.jobs(bindingId).filter(job => job.queued && !job.turnId).map(job => job.operationId));
  }
  associateTurn(bindingId: string, operationId: string, turnId: string, terminalConfirmed = false): void {
    if (!this.jobs(bindingId).some(job => job.operationId === operationId && !job.turnId)) return;
    const terminal = terminalConfirmed || this.terminalTurns(bindingId).has(turnId);
    this.store.atomic(() => {
      if (terminalConfirmed) {
        const known = this.terminalTurns(bindingId);
        if (!known.has(turnId)) this.store.setValue(`file-terminal-turns:${bindingId}`, [...known, turnId].slice(-128));
      }
      this.save(bindingId, this.jobs(bindingId).map(job => job.operationId === operationId && !job.turnId
        ? { ...job, turnId, done: false, queued: false, completed: terminal,
          autoScanUntil: terminal ? Date.now() + LATE_SCAN_WINDOW_MS : undefined, nextScanAt: terminal ? 0 : undefined }
        : job));
    });
  }
  observe(bindingId: string, status: TaskDetails["status"], turnId?: string | null): void {
    if (["idle", "failed", "interrupted"].includes(status)) {
      this.completed.add(bindingId);
      const jobs = this.jobs(bindingId);
      let changed = false;
      const observed = jobs.map(job => {
        if (job.state !== "accepted" || (job.turnId && job.turnId !== turnId)
          || (job.completed === true && job.autoScanUntil !== undefined)) return job;
        changed = true;
        return { ...job, completed: true,
          autoScanUntil: job.autoScanUntil ?? (job.completed === undefined && job.done ? Date.now() : Date.now() + LATE_SCAN_WINDOW_MS),
          nextScanAt: job.completed === false ? 0 : job.nextScanAt };
      });
      if (changed) this.save(bindingId, observed);
      if (turnId) {
        if (jobs.some(job => job.completed !== true && (!job.turnId || job.turnId === turnId))) {
          const persisted = this.terminalTurns(bindingId);
          if (!persisted.has(turnId)) this.store.setValue(`file-terminal-turns:${bindingId}`, [...persisted, turnId].slice(-128));
        }
      }
    } else this.completed.delete(bindingId);
  }
  collect(binding: Binding, manual = false): Promise<number> {
    const existing = this.collections.get(binding.id); if (existing) return existing;
    const work = this.collectNow(binding, manual).finally(() => { this.collections.delete(binding.id); });
    this.collections.set(binding.id, work); return work;
  }
  private async collectNow(binding: Binding, manual: boolean): Promise<number> {
    const generation = this.store.streamGeneration(binding.id); await this.check(binding, generation);
    if (!this.chat.uploadFile) throw new ActionRejectedError("Загрузка файлов в VK недоступна.");
    const uploadFile = this.chat.uploadFile.bind(this.chat);
    let count = 0; let unknownFiles = 0; let retryableFailure: OutputFilesError | null = null;
    let quotaFailure: ActionRejectedError | null = null;
    let unknownFailure: ActionRejectedError | null = null;
    const completedTurns = this.terminalTurns(binding.id);
    const eligible = this.jobs(binding.id).filter(job => {
      if (job.generation !== generation || job.state !== "accepted" || job.queued) return false;
      if (manual) return true;
      const completed = job.completed === true || (job.completed === undefined && job.done)
        || (job.turnId ? completedTurns.has(job.turnId) : this.completed.has(binding.id));
      return completed && (!job.done || ((job.autoScanUntil === undefined || Date.now() <= job.autoScanUntil)
        && (job.nextScanAt === undefined || Date.now() >= job.nextScanAt)));
    });
    for (const job of eligible) {
      const outbox = await directory(this.root, job.directory, "outbox");
      const skipped: OutputFilesError[] = [];
      const metadataKey = `file-scan:${binding.id}:${job.operationId}`;
      const scanned = this.store.getValue<Record<string, { fingerprint: string; key: string }>>(metadataKey) ?? {};
      const pending: { name: string; key: string; attachment: string; bytes: number }[] = [];
      const processed = new Set<string>();
      let pendingBytes = 0;
      const quotaBlocked = (key: string, name: string, message: string): void => {
        this.store.atomic(() => {
          this.store.setValue(`${key}:upload-state`, null);
          this.store.setValue(`${key}:quota-blocked`, true);
          this.store.enqueue(`${key}:quota-error`, binding.peerId!, {
            text: `Файл «${name}» не отправлен. ${message} Остальные файлы этой выдачи продолжают отправляться. Повтори /files после освобождения места.`,
            silent: true,
          }, binding.id);
        });
        processed.add(key);
        quotaFailure ??= new ActionRejectedError(message);
      };
      const flushPending = async (): Promise<void> => {
        if (!pending.length) return;
        await this.check(binding, generation);
        const batchKey = `files:${binding.id}:${job.operationId}:${digest(pending.map(item => item.key).join("|"))}`;
        const names = pending.map(item => item.name).join("\n");
        this.store.atomic(() => {
          this.store.enqueue(batchKey, binding.peerId!, { text: pending.length === 1 ? pending[0]!.name : `Файлы (${pending.length}):\n${names}`, attachments: pending.map(item => item.attachment) }, binding.id);
          const staged = this.stageIndex(binding.id, job.operationId);
          let stageChanged = false;
          for (const item of pending) {
            const receipt = staged[item.key];
            if (!receipt) continue;
            if (receipt.deliveryKey && (receipt.deliveryKey !== batchKey || receipt.attachment !== item.attachment || receipt.peerId !== binding.peerId))
              throw new ActionRejectedError("Квитанция staged-файла связана с другой доставкой; отправка остановлена.");
            staged[item.key] = { ...receipt, deliveryKey: batchKey, attachment: item.attachment, peerId: binding.peerId! };
            stageChanged = true;
          }
          if (stageChanged) this.store.setValue(this.stageIndexKey(binding.id, job.operationId), staged);
          for (const item of pending) this.store.setValue(`${item.key}:queued`, true);
        });
        count += pending.length; pending.length = 0; pendingBytes = 0;
      };
      const processFile = async (file: OutputFile, relativePath: string, fingerprint: string, staged?: StagedFile): Promise<void> => {
          const contentHash = digest(file.contents);
          const identity = job.keyFormat === "relative-path-v2"
            ? JSON.stringify([relativePath.replaceAll(path.sep, "/"), contentHash])
            : file.name + ":" + contentHash;
          const key = `file:${binding.id}:${job.operationId}:${digest(identity)}`;
          if (processed.has(key)) return;
          if (staged && (staged.key !== key || staged.sha256 !== contentHash || staged.relativePath !== relativePath))
            throw new ActionRejectedError("Квитанция staged-файла не соответствует его содержимому; загрузка остановлена.");
          if (!staged) {
            scanned[relativePath] = { fingerprint, key };
            this.store.setValue(metadataKey, scanned);
          }
          if (this.store.getValue<boolean>(`${key}:queued`)) return;
          if (!manual && this.store.getValue<boolean>(`${key}:rejected`)) return;
          if (!manual && this.store.getValue<boolean>(`${key}:quota-blocked`)) return;
          await this.check(binding, generation);
          let attachment = this.store.getValue<string>(`${key}:uploaded`);
          if (!attachment) {
            const uploadState = this.store.getValue<string>(`${key}:upload-state`);
            if (uploadState === "uploading" || uploadState === "unknown") {
              unknownFiles++;
              this.store.enqueue(`${key}:upload-unknown`, binding.peerId!, { text: `Результат загрузки файла «${file.name}» в VK неизвестен. Автоматический повтор остановлен, чтобы не создать дубль.`, silent: true }, binding.id);
              return;
            }
            let receipt = staged;
            if (!receipt && this.stageNewUploads) {
              try { receipt = await this.stageFile(file, relativePath, fingerprint, key, job, binding); }
              catch (error) {
                if (!(error instanceof StageQuotaError)) throw error;
                quotaBlocked(key, file.name, error.message);
                return;
              }
            }
            // When staging is enabled, VK receives verified staged bytes using
            // the existing bounded buffer. Old jobs continue the old path.
            const uploadBytes = staged || !receipt ? file.contents : await this.stagedContents(receipt, job, binding.id, file.contents);
            let cleanupAttempted = false;
            for (;;) {
              this.store.setValue(`${key}:upload-state`, "uploading");
              try { attachment = await uploadFile(binding.peerId!, receipt?.name ?? file.name, uploadBytes, receipt?.kind ?? file.kind); break; }
              catch (error) {
                if (error instanceof FileUploadStorageFullError) {
                  this.store.setValue(`${key}:upload-state`, null);
                  if (cleanupAttempted) {
                    quotaBlocked(key, file.name, "VK снова сообщил о заполненном хранилище документов после очистки.");
                    attachment = null;
                    break;
                  }
                  cleanupAttempted = true;
                  const cleanup = await this.cleanupDocuments([]);
                  if (cleanup === "no-candidate") {
                    quotaBlocked(key, file.name, "VK не принял файл: хранилище документов заполнено, но нет безопасных документов для автоматической очистки.");
                    attachment = null;
                    break;
                  }
                  if (cleanup !== "removed") {
                    quotaBlocked(key, file.name, "VK не принял файл: хранилище документов заполнено, а очистка не подтвердила удаление.");
                    attachment = null;
                    break;
                  }
                  continue;
                }
                if (!(error instanceof FileUploadRejectedError)) {
                  this.store.setValue(`${key}:upload-state`, "unknown");
                  unknownFiles++;
                  unknownFailure ??= new ActionRejectedError(`Результат загрузки файла «${file.name}» в VK неизвестен. Повтор остановлен, чтобы не создать дубль. Проверь документ в VK перед новой попыткой.`);
                  this.store.enqueue(`${key}:upload-unknown`, binding.peerId!, { text: `Результат загрузки файла «${file.name}» в VK неизвестен. Автоматический повтор остановлен, чтобы не создать дубль.`, silent: true }, binding.id);
                  return;
                }
                this.store.setValue(`${key}:upload-state`, null);
                await this.check(binding, generation);
                this.store.setValue(`${key}:rejected`, true);
                this.store.enqueue(`${key}:error`, binding.peerId!, { text: `Файл «${file.name}» не отправлен. ${error.message}`, silent: true }, binding.id);
                processed.add(key);
                attachment = null;
                break;
              }
            }
            if (!attachment) return;
            const uploadedAttachment = attachment;
            const document = /^doc(-?\d+)_([0-9]+)(?:_|$)/u.exec(uploadedAttachment);
            this.store.atomic(() => {
              if (document) this.rememberDocument({ attachment: uploadedAttachment, ownerId: Number(document[1]), documentId: Number(document[2]), name: file.name, uploadedAt: Date.now(), fileKey: key });
              this.store.setValue(`${key}:uploaded`, uploadedAttachment);
              this.store.setValue(`${key}:upload-state`, "uploaded");
              this.store.setValue(`${key}:quota-blocked`, null);
            });
          }
          if (pending.length && (pending.length >= FILE_LIMITS.maxFiles || pendingBytes + file.contents.length > FILE_LIMITS.maxTotalBytes)) await flushPending();
          pending.push({ name: file.name, key, attachment, bytes: file.contents.length });
          processed.add(key);
          pendingBytes += file.contents.length;
          if (pending.length >= FILE_LIMITS.maxFiles || pendingBytes >= FILE_LIMITS.maxTotalBytes) await flushPending();
      };
      try {
        // Durable staged receipts are recovered before scanning mutable source bytes.
        for (const receipt of Object.values(this.stageIndex(binding.id, job.operationId))) {
          if (this.store.getValue<boolean>(`${receipt.key}:queued`)) continue;
          const uploadState = this.store.getValue<string>(`${receipt.key}:upload-state`);
          if (uploadState === "uploading" || uploadState === "unknown") {
            unknownFiles++;
            this.store.enqueue(`${receipt.key}:upload-unknown`, binding.peerId!, { text: `Результат загрузки файла «${receipt.name}» в VK неизвестен. Автоматический повтор остановлен, чтобы не создать дубль.`, silent: true }, binding.id);
            continue;
          }
          if (!manual && this.store.getValue<boolean>(`${receipt.key}:rejected`)) continue;
          if (!manual && this.store.getValue<boolean>(`${receipt.key}:quota-blocked`)) continue;
          const contents = await this.stagedContents(receipt, job, binding.id);
          await processFile({ name: receipt.name, contents, kind: receipt.kind }, receipt.relativePath, receipt.fingerprint, receipt);
        }
        // Validate the whole tree before the first upload; this pass reads only
        // directory entries and metadata, not file contents.
        await readOutputFiles(outbox, FILE_LIMITS, { allowBatchOverflow: true, skipFile: () => true });
        await readOutputFiles(outbox, FILE_LIMITS, {
          allowBatchOverflow: true, skipOversizedFiles: true, onSkippedFile: error => skipped.push(error),
          skipFile: (relativePath, fingerprint) => {
            const known = scanned[relativePath];
            if (!known || known.fingerprint !== fingerprint) return false;
            if (this.store.getValue<boolean>(`${known.key}:queued`)) return true;
            const uploadState = this.store.getValue<string>(`${known.key}:upload-state`);
            if (uploadState === "uploading" || uploadState === "unknown") {
              unknownFiles++;
              this.store.enqueue(`${known.key}:upload-unknown`, binding.peerId!, { text: `Результат загрузки файла в VK неизвестен. Автоматический повтор остановлен, чтобы не создать дубль.`, silent: true }, binding.id);
              return true;
            }
            return !manual && (!!this.store.getValue<boolean>(`${known.key}:rejected`)
              || !!this.store.getValue<boolean>(`${known.key}:quota-blocked`));
          },
          onFile: processFile,
        });
        await flushPending();
      } catch (error) {
        if (!(error instanceof OutputFilesError)) throw error;
        this.store.enqueue(`files-error:${binding.id}:${job.operationId}`, binding.peerId!, {
          text: `Не удалось забрать файлы одного запроса: ${error.message} Более новые выдачи продолжат отправляться. Исправь эту выдачу и отправь /files.`, silent: true,
        }, binding.id);
        if (error.retryable) retryableFailure ??= error;
        else this.save(binding.id, this.jobs(binding.id).map(item => item.operationId === job.operationId
          ? { ...item, done: true, completed: true, nextScanAt: Number.MAX_SAFE_INTEGER } : item));
        continue;
      }
      for (const error of skipped) this.store.enqueue(`files-error:${binding.id}:${job.operationId}:${digest(error.message)}`, binding.peerId!, {
        text: `Файл не добавлен в очередь VK: ${error.message} Допустимые файлы из этой же выдачи продолжают отправляться.`, silent: true,
      }, binding.id);
      this.save(binding.id, this.jobs(binding.id).map(item => item.operationId === job.operationId
        ? { ...item, done: true, completed: item.completed ?? true,
          autoScanUntil: item.autoScanUntil ?? (item.completed === false ? undefined : Date.now()),
          nextScanAt: Date.now() + (item.scanDelayMs ?? INITIAL_LATE_SCAN_MS),
          scanDelayMs: Math.min((item.scanDelayMs ?? INITIAL_LATE_SCAN_MS) * 2, MAX_LATE_SCAN_MS) } : item));
    }
    if (retryableFailure && !manual) throw retryableFailure;
    if (!count && unknownFiles) throw unknownFailure ?? new ActionRejectedError("Есть файл с неизвестным результатом загрузки в VK. Повтор остановлен, чтобы не создать дубль; проверь документы VK перед новой попыткой.");
    if (!count && quotaFailure) throw quotaFailure;
    return count;
  }
  tick(): Promise<void> {
    if (this.working || this.stopped) return this.working ?? Promise.resolve();
    this.working = this.flush().finally(() => { this.working = null; }); return this.working;
  }
  private async flush(): Promise<void> {
    for (const id of new Set([...this.completed, ...this.store.bindings().map(binding => binding.id)])) {
      const generation = this.store.streamGeneration(id);
      if (this.stopped || Date.now() < (this.retries.get(id) ?? 0) || !this.jobs(id).some(job => job.generation === generation && job.state === "accepted" && !job.queued
        && (job.completed === true || (job.completed === undefined && job.done) || (!job.done && this.completed.has(id)))
        && (!job.done || ((job.autoScanUntil === undefined || Date.now() <= job.autoScanUntil)
          && (job.nextScanAt === undefined || Date.now() >= job.nextScanAt))))) continue;
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
