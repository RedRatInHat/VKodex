import { DesktopUnavailableError } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";

/** A clientUserMessageId in persisted history proves that Codex accepted input.
 * Absence is not proof of rejection: the owner may still be writing its turn. */
export async function findAcceptedInputTurn(
  threadId: string,
  operationId: string,
  list: (params: IpcObject) => Promise<IpcObject>,
  maxPages = 5,
): Promise<string | null> {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await list({ threadId, limit: 20, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}) });
    pages++;
    if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
      throw new DesktopUnavailableError("Codex не вернул полную историю для проверки отправки.");
    }
    for (const turn of page.data) {
      if (!isObject(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items)) {
        throw new DesktopUnavailableError("Codex вернул неполный ход при проверке отправки.");
      }
      if (turn.items.some(item => isObject(item) && item.type === "userMessage" && item.clientId === operationId)) return turn.id;
    }
    if (page.nextCursor === null) return null;
    if (pages >= maxPages) return null;
    if (!page.nextCursor || cursors.has(page.nextCursor) || cursors.size >= 5_000 || page.data.length === 0) {
      throw new DesktopUnavailableError("Codex не завершил чтение истории для проверки отправки.");
    }
    cursor = page.nextCursor;
    cursors.add(cursor);
  } while (true);
}
