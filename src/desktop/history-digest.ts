import { createHash } from "node:crypto";
import { ActionRejectedError, DesktopUnavailableError, TransferPageTooLargeError } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";

function isNonPortableProjectionItem(item: IpcObject): boolean {
  // These records belong to the local App Server projection, not to the
  // portable user/agent transcript. A cross-profile fork currently rebuilds
  // the same visible transcript without them: reasoning is private, while
  // file changes and compaction markers are regenerated (or omitted) by the
  // receiving profile. Including them made a valid large-history fork fail
  // verification even though every user and agent message was preserved.
  return ["reasoning", "fileChange", "contextCompaction"].includes(String(item.type));
}

function canonicalUserContent(content: unknown): unknown {
  if (!Array.isArray(content)) return typeof content === "string" ? { text: content.trim() ? content : "", images: [], localImages: [], audio: [], localAudio: [], other: [] } : content;
  // The receiving profile rebuilds its visible user message from a legacy
  // event: all text fragments become one message and each media category is
  // projected separately. Compare that model-visible content, not the local
  // order or number of projection fragments. Unknown parts remain strict.
  const texts: string[] = []; const images: unknown[] = []; const localImages: unknown[] = [];
  const audio: unknown[] = []; const localAudio: unknown[] = []; const other: unknown[] = [];
  for (const part of content) {
    if (!isObject(part)) { other.push(part); continue; }
    if (part.type === "text" && typeof part.text === "string") { texts.push(part.text); continue; }
    const remote = part.type === "image" ? images : part.type === "audio" ? audio : null;
    if (remote) {
      const url = typeof part.image_url === "string" ? part.image_url
        : typeof part.audio_url === "string" ? part.audio_url : part.url;
      if (typeof url === "string") {
        remote.push({ url, ...(typeof part.detail === "string" && part.detail !== "auto" ? { detail: part.detail } : {}),
          ...(typeof part.transcript === "string" ? { transcript: part.transcript } : {}) });
        continue;
      }
    }
    const local = part.type === "local_image" || part.type === "localImage" ? localImages
      : part.type === "local_audio" || part.type === "localAudio" ? localAudio : null;
    if (local && typeof part.path === "string") { local.push(part.path); continue; }
    other.push(part);
  }
  const joinedText = texts.join("\n");
  return { text: joinedText.trim() ? joinedText : "", images, localImages, audio, localAudio, other };
}

function portableTranscriptItem(item: IpcObject, version: 2 | 3): IpcObject | null {
  // A native cross-profile fork preserves the user/agent transcript but
  // rebuilds profile-local IDs and tool projections. Comparing those local
  // projections rejected valid forks (for example when webSearch rows were
  // present only in the source profile). Keep the model-visible conversation
  // strict while making the digest independent of the receiving profile.
  if (item.type === "userMessage") {
    const content = item.content ?? item.text;
    return { type: item.type, content: version === 3 ? canonicalUserContent(content) : content };
  }
  if (item.type === "agentMessage") return { type: item.type, text: item.text, phase: item.phase };
  return null;
}

/** Hash the persisted, model-visible turns rather than rollout file metadata.
 * Forking may assign new item IDs, so those IDs are not part of the digest. */
export async function completedHistoryDigest(
  threadId: string,
  lastTurnId: string,
  list: (params: IpcObject) => Promise<IpcObject>,
  options: { readonly allowNewerTurns?: boolean; readonly version?: 1 | 2 | 3 } = {},
): Promise<string> {
  const hash = createHash("sha256");
  const cursors = new Set<string>();
  const turnIds = new Set<string>();
  let cursor: string | undefined;
  let latest: string | undefined;
  let limit = 100;
  do {
    // Tool projections can make one page tens of MiB even though
    // only user/agent messages enter the digest. Reduce the page size without
    // skipping the cursor boundary or weakening transcript verification.
    let page: IpcObject;
    while (true) {
      try {
        page = await list({ threadId, limit, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}) });
        break;
      } catch (error) {
        if (!(error instanceof TransferPageTooLargeError)) throw error;
        if (limit === 1) throw new DesktopUnavailableError("Один ход истории Codex превышает предел чтения; перенос не начат.");
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
    if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
      throw new DesktopUnavailableError("Codex не вернул полную страницу истории для проверки переноса.");
    }
    for (const value of page.data) {
      if (!isObject(value) || typeof value.id !== "string" || !value.id || turnIds.has(value.id)
        || !["completed", "failed", "interrupted"].includes(String(value.status)) || !Array.isArray(value.items)) {
        throw new ActionRejectedError("История содержит незавершённый или некорректный ход; перенос остановлен.");
      }
      turnIds.add(value.id);
      latest = value.id;
      const items = value.items.map(item => {
        if (!isObject(item) || typeof item.type !== "string") throw new ActionRejectedError("Codex вернул неполный элемент истории.");
        if ((options.version ?? 2) !== 1) return portableTranscriptItem(item, (options.version ?? 2) as 2 | 3);
        if (isNonPortableProjectionItem(item)) return null;
        const { id: _itemId, ...content } = item;
        return content;
      }).filter(item => item !== null);
      hash.update(JSON.stringify({ id: value.id, status: value.status, items }));
      hash.update("\n");
      if (value.id === lastTurnId && options.allowNewerTurns) return hash.digest("hex");
    }
    if (page.nextCursor === null) break;
    if (!page.nextCursor || cursors.has(page.nextCursor) || cursors.size >= 5_000 || page.data.length === 0) {
      throw new DesktopUnavailableError("Пагинация истории Codex не завершилась.");
    }
    cursor = page.nextCursor;
    cursors.add(cursor);
  } while (true);
  if (latest !== lastTurnId) throw new ActionRejectedError("Граница завершённой истории изменилась во время проверки переноса.");
  return hash.digest("hex");
}
