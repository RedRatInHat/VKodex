import { createHash } from "node:crypto";
import { ActionRejectedError, DesktopUnavailableError } from "./contracts.js";
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

/** Hash the persisted, model-visible turns rather than rollout file metadata.
 * Forking may assign new item IDs, so those IDs are not part of the digest. */
export async function completedHistoryDigest(
  threadId: string,
  lastTurnId: string,
  list: (params: IpcObject) => Promise<IpcObject>,
  options: { readonly allowNewerTurns?: boolean } = {},
): Promise<string> {
  const hash = createHash("sha256");
  const cursors = new Set<string>();
  const turnIds = new Set<string>();
  let cursor: string | undefined;
  let latest: string | undefined;
  do {
    const page = await list({ threadId, limit: 20, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}) });
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
