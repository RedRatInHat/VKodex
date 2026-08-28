import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalInputFile, OutboundFile, RemoteAttachment } from "../domain/models.js";
import { UserFacingError } from "../core/errors.js";

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);

export interface InboundLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly timeoutMs: number;
}

export interface OutboundLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface BridgeTurnDirectories {
  readonly baseDir: string;
  readonly inboxDir: string;
  readonly outboxDir: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureRealDirectory(directory: string, containmentRoot: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
    metadata = await lstat(directory);
  }

  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new UserFacingError(`Небезопасный служебный каталог: ${directory}`);
  }

  const [realRoot, realDirectory] = await Promise.all([
    realpath(containmentRoot),
    realpath(directory),
  ]);
  if (!isWithin(realRoot, realDirectory)) {
    throw new UserFacingError(`Служебный каталог вышел за пределы workspace: ${directory}`);
  }
  return realDirectory;
}

export async function prepareBridgeTurnDirectories(
  workspace: string,
  turnId: string,
): Promise<BridgeTurnDirectories> {
  const realWorkspace = await realpath(workspace);
  const baseDir = await ensureRealDirectory(path.join(realWorkspace, ".vkcodex"), realWorkspace);

  try {
    // A nested ignore file containing `*` keeps all bridge state out of Git
    // without modifying the repository's tracked root .gitignore.
    await writeFile(path.join(baseDir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const inboxRoot = await ensureRealDirectory(path.join(baseDir, "inbox"), baseDir);
  const outboxRoot = await ensureRealDirectory(path.join(baseDir, "outbox"), baseDir);
  const inboxDir = await ensureRealDirectory(path.join(inboxRoot, turnId), inboxRoot);
  const outboxDir = await ensureRealDirectory(path.join(outboxRoot, turnId), outboxRoot);

  return { baseDir, inboxDir, outboxDir };
}

export function safeFileName(input: string, fallback: string): string {
  const base = path.basename(input || fallback).normalize("NFKC");
  const sanitized = base
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  return (sanitized || fallback).slice(0, 180);
}

async function uniqueDestination(directory: string, requestedName: string): Promise<string> {
  const extension = path.extname(requestedName);
  const stem = path.basename(requestedName, extension);
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidate = path.join(directory, `${stem}${suffix}${extension}`);
    try {
      const handle = await open(candidate, "wx", 0o600);
      await handle.close();
      await rm(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique attachment filename");
}

async function downloadOne(
  attachment: RemoteAttachment,
  destination: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ sizeBytes: number; mimeType?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const temporary = `${destination}.part`;

  try {
    const response = await fetch(attachment.url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new UserFacingError(`VK attachment download failed: HTTP ${response.status}`);
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new UserFacingError(`Файл «${attachment.fileName}» больше допустимого лимита.`);
    }

    let bytes = 0;
    const reader = response.body.getReader();
    const handle = await open(temporary, "w", 0o600);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          controller.abort();
          throw new UserFacingError(`Файл «${attachment.fileName}» больше допустимого лимита.`);
        }
        await handle.write(value);
      }
    } finally {
      reader.releaseLock();
      await handle.close();
    }

    await rename(temporary, destination);
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    return mimeType ? { sizeBytes: bytes, mimeType } : { sizeBytes: bytes };
  } finally {
    clearTimeout(timeout);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function materializeAttachments(
  attachments: readonly RemoteAttachment[],
  targetDir: string,
  limits: InboundLimits,
): Promise<readonly LocalInputFile[]> {
  if (attachments.length > limits.maxFiles) {
    throw new UserFacingError(`Слишком много вложений: максимум ${limits.maxFiles}.`);
  }

  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const files: LocalInputFile[] = [];
  let totalBytes = 0;

  for (const [index, attachment] of attachments.entries()) {
    if (attachment.sizeBytes !== undefined && attachment.sizeBytes > limits.maxFileBytes) {
      throw new UserFacingError(`Файл «${attachment.fileName}» больше допустимого лимита.`);
    }

    const fallback = attachment.kind === "image" ? `image-${index + 1}.jpg` : `file-${index + 1}`;
    const name = safeFileName(attachment.fileName, fallback);
    const destination = await uniqueDestination(targetDir, name);
    const downloaded = await downloadOne(attachment, destination, limits.maxFileBytes, limits.timeoutMs);
    totalBytes += downloaded.sizeBytes;
    if (totalBytes > limits.maxTotalBytes) {
      await rm(targetDir, { recursive: true, force: true });
      throw new UserFacingError("Суммарный размер вложений превышает допустимый лимит.");
    }

    files.push({
      path: destination,
      originalName: name,
      kind: attachment.kind,
      sizeBytes: downloaded.sizeBytes,
      ...(downloaded.mimeType === undefined ? {} : { mimeType: downloaded.mimeType }),
    });
  }

  return files;
}

async function walkRegularFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) result.push(...(await walkRegularFiles(candidate)));
    if (metadata.isFile()) result.push(candidate);
  }
  return result;
}

export async function collectOutboundFiles(
  outboxDir: string,
  limits: OutboundLimits,
  containmentRoot?: string,
): Promise<readonly OutboundFile[]> {
  if (containmentRoot) await ensureRealDirectory(outboxDir, containmentRoot);
  const paths = await walkRegularFiles(outboxDir);
  if (paths.length > limits.maxFiles) {
    throw new UserFacingError(`Codex подготовил слишком много файлов: максимум ${limits.maxFiles}.`);
  }

  const files: OutboundFile[] = [];
  let totalBytes = 0;
  for (const filePath of paths) {
    const metadata = await stat(filePath);
    if (metadata.size > limits.maxFileBytes) {
      throw new UserFacingError(`Выходной файл «${path.basename(filePath)}» превышает лимит размера.`);
    }
    totalBytes += metadata.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new UserFacingError("Суммарный размер выходных файлов превышает лимит.");
    }
    const extension = path.extname(filePath).toLowerCase();
    files.push({
      path: filePath,
      name: path.basename(filePath),
      kind: IMAGE_EXTENSIONS.has(extension) ? "image" : "file",
      sizeBytes: metadata.size,
    });
  }
  return files;
}

export async function resolveWorkspace(input: string, roots: readonly string[]): Promise<string> {
  if (!input.trim()) throw new UserFacingError("Укажите workspace: /new <путь> | <название>.");

  const candidates = path.isAbsolute(input)
    ? [path.resolve(input)]
    : roots.map((root) => path.resolve(root, input));

  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const metadata = await stat(resolved);
      if (!metadata.isDirectory()) continue;

      for (const root of roots) {
        const realRoot = await realpath(root);
        const relative = path.relative(realRoot, resolved);
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }

  throw new UserFacingError("Workspace не найден или находится вне разрешённых WORKSPACE_ROOTS.");
}
