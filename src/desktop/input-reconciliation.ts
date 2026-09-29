import { createHash } from "node:crypto";
import type { QueuedInputHistoryCursor, QueuedInputHistoryScan } from "../core/codex-tasks.js";
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

/** Searches a bounded native history slice. A positive result is exact terminal
 * evidence from a validated page; a negative partial result preserves the ACK. */
export async function scanTerminalQueuedInputTurn(
  threadId: string,
  clientId: string,
  list: (params: IpcObject) => Promise<IpcObject>,
  previous: QueuedInputHistoryCursor | null = null,
): Promise<QueuedInputHistoryScan> {
  if (!threadId || !clientId) throw new DesktopUnavailableError("Не задана задача или операция очереди.");
  if (previous && (typeof previous.headDigest !== "string" || !/^[0-9a-f]{64}$/u.test(previous.headDigest) ||
    typeof previous.cursor !== "string" || !previous.cursor ||
    !Array.isArray(previous.seenCursors) || previous.seenCursors.length !== previous.pages ||
    previous.seenCursors.some(value => typeof value !== "string" || !value) ||
    new Set(previous.seenCursors).size !== previous.seenCursors.length ||
    previous.seenCursors.at(-1) !== previous.cursor ||
    !Number.isSafeInteger(previous.pages) || previous.pages < 1 || previous.pages > 5_000))
    throw new DesktopUnavailableError("Курсор истории очереди повреждён.");
  type Page = IpcObject & { data: unknown[]; nextCursor: string | null };
  const fingerprint = (page: Page): string => createHash("sha256")
    .update(JSON.stringify([page.data, page.nextCursor])).digest("hex");
  const read = async (cursor?: string): Promise<Page> => {
    // Historical turns may contain very large transcripts. A 20-turn page
    // exceeded MetadataRpc's 64 MiB guard on real tasks; one turn per page
    // keeps the bounded scan usable without raising that memory ceiling.
    const page = await list({ threadId, limit: 1, sortDirection: "asc", itemsView: "full",
      ...(cursor ? { cursor } : {}) });
    if (page.threadId !== undefined && page.threadId !== threadId ||
      !Array.isArray(page.data) || page.data.length > 1 ||
      !(page.nextCursor === null || typeof page.nextCursor === "string"))
      throw new DesktopUnavailableError("Codex вернул неполную историю очереди.");
    return page as Page;
  };
  // In ascending order the oldest page stays fixed when a new active turn is
  // appended. Keep the existing cursor field name for persisted checkpoints.
  const oldest = await read();
  const headDigest = fingerprint(oldest);
  if (previous && headDigest !== previous.headDigest)
    throw new DesktopUnavailableError("История очереди изменилась во время проверки.");
  const cursors = new Set(previous?.seenCursors ?? []);
  let cursor: string | null = previous?.cursor ?? null;
  let pages = previous?.pages ?? 0;
  let calls = 1;
  const consume = (page: Page): string | null => {
    const turns = new Set<string>();
    let matched: string | null = null;
    if (page.nextCursor !== null && (!page.nextCursor || cursors.has(page.nextCursor) || page.data.length === 0))
      throw new DesktopUnavailableError("Codex не завершил чтение истории очереди.");
    for (const turn of page.data) {
      if (!isObject(turn) || turn.threadId !== undefined && turn.threadId !== threadId ||
        typeof turn.id !== "string" || !turn.id || turns.has(turn.id) ||
        turn.itemsView !== "full" || !Array.isArray(turn.items) || typeof turn.status !== "string")
        throw new DesktopUnavailableError("Codex вернул неполный ход очереди.");
      turns.add(turn.id);
      for (const item of turn.items) {
        if (!isObject(item) || typeof item.type !== "string")
          throw new DesktopUnavailableError("Codex вернул неполный элемент истории очереди.");
        if (item.type !== "userMessage" || item.clientId !== clientId) continue;
        if (matched || !["completed", "failed", "interrupted"].includes(turn.status))
          throw new DesktopUnavailableError("Ход очереди неоднозначен или ещё не завершён.");
        matched = turn.id;
      }
    }
    pages++;
    cursor = page.nextCursor;
    if (cursor) cursors.add(cursor);
    return matched;
  };
  if (!previous) {
    const matched = consume(oldest);
    if (matched) return { done: true, turnId: matched };
  }
  while (cursor !== null && calls < 20) {
    if (pages >= 5_000) throw new DesktopUnavailableError("История очереди превысила предел чтения.");
    const page = await read(cursor);
    calls++;
    const matched = consume(page);
    if (matched) return { done: true, turnId: matched };
  }
  if (cursor !== null) return { done: false, cursor: { headDigest, cursor,
    seenCursors: [...cursors], pages } };
  return { done: true, turnId: null };
}
