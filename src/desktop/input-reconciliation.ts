import { createHash } from "node:crypto";
import type { QueuedInputHistoryCursor, QueuedInputHistoryScan } from "../core/codex-tasks.js";
import { ActionRejectedError, DesktopUnavailableError, TransferPageTooLargeError } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";

/** A live turn can gain items or change status; its page is not a durable scan boundary. */
export class MutableQueuedInputTurnError extends DesktopUnavailableError {
  constructor() { super("Ход очереди ещё изменяется."); this.name = "MutableQueuedInputTurnError"; }
}

/** Fixed, content-free classification of a failed native history RPC. It is
 * distinct from a successful RPC whose history fails local validation. */
export class QueueHistoryReadError extends DesktopUnavailableError {
  constructor(readonly reason: "read_rejected" | "read_unavailable" | "read_too_large") {
    super("Не удалось прочитать историю очереди из Codex.");
    this.name = "QueueHistoryReadError";
  }
}

/** Keep transport/RPC failure categories separate from a structurally invalid
 * history page, without retaining the native error or any page content. */
export async function readQueuedHistoryPage(
  list: (params: IpcObject) => Promise<IpcObject>, params: IpcObject,
): Promise<IpcObject> {
  try { return await list(params); }
  catch (error) {
    if (error instanceof TransferPageTooLargeError) throw new QueueHistoryReadError("read_too_large");
    if (error instanceof ActionRejectedError) throw new QueueHistoryReadError("read_rejected");
    if (error instanceof DesktopUnavailableError) throw new QueueHistoryReadError("read_unavailable");
    throw error;
  }
}

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

/** Positive-only shortcut for an old queue ACK near the current tail. A miss
 * never settles the ACK: the durable ascending scan still covers all history. */
export async function findRecentTerminalQueuedInputTurn(
  threadId: string,
  clientId: string,
  list: (params: IpcObject) => Promise<IpcObject>,
): Promise<string | null> {
  if (!threadId || !clientId) throw new DesktopUnavailableError("Не задана задача или операция очереди.");
  const limit = 5;
  const read = async (cursor: string | undefined, count: number, itemsView: "summary" | "full") => {
    const page = await list({ threadId, limit: count, sortDirection: "desc", itemsView,
      ...(cursor ? { cursor } : {}) });
    if (page.threadId !== undefined && page.threadId !== threadId ||
      !Array.isArray(page.data) || page.data.length > count ||
      !(page.nextCursor === null || typeof page.nextCursor === "string") ||
      typeof page.nextCursor === "string" && Buffer.byteLength(page.nextCursor, "utf8") > 1_024 ||
      itemsView === "summary" && Buffer.byteLength(JSON.stringify(page.data), "utf8") > 4 * 1024 * 1024)
      throw new DesktopUnavailableError("Codex вернул неполную историю очереди.");
    return page as IpcObject & { data: unknown[]; nextCursor: string | null };
  };
  const page = await read(undefined, limit, "summary");
  const seen = new Set<string>();
  let candidateIndex: number | null = null;
  for (const [index, turn] of page.data.entries()) {
    if (!isObject(turn) || turn.threadId !== undefined && turn.threadId !== threadId ||
      typeof turn.id !== "string" || !turn.id || seen.has(turn.id) ||
      turn.itemsView !== "summary" || typeof turn.status !== "string" || !Array.isArray(turn.items) ||
      turn.items.some(item => !isObject(item) || typeof item.type !== "string"))
      throw new DesktopUnavailableError("Codex вернул неполный ход очереди.");
    seen.add(turn.id);
    if (!["completed", "failed", "interrupted"].includes(turn.status) ||
      !turn.items.some(item => isObject(item) && item.type === "userMessage" && item.clientId === clientId)) continue;
    if (candidateIndex !== null) throw new DesktopUnavailableError("Ход очереди неоднозначен.");
    candidateIndex = index;
  }
  if (candidateIndex === null) return null;
  let cursor: string | undefined;
  for (let index = 0; index < candidateIndex; index++) {
    const one = await read(cursor, 1, "summary");
    const actual = one.data[0], expected = page.data[index];
    if (one.data.length !== 1 || !isObject(actual) || !isObject(expected) ||
      actual.id !== expected.id || actual.status !== expected.status || actual.itemsView !== "summary" ||
      !one.nextCursor)
      throw new DesktopUnavailableError("История очереди изменилась во время проверки.");
    cursor = one.nextCursor;
  }
  const full = await read(cursor, 1, "full");
  const turn = full.data[0], expected = page.data[candidateIndex];
  if (full.data.length !== 1 || !isObject(turn) || !isObject(expected) ||
    turn.threadId !== undefined && turn.threadId !== threadId ||
    turn.id !== expected.id || turn.status !== expected.status || turn.itemsView !== "full" ||
    !["completed", "failed", "interrupted"].includes(String(turn.status)) ||
    !Array.isArray(turn.items) || turn.items.some(item => !isObject(item) || typeof item.type !== "string") ||
    turn.items.filter(item => isObject(item) && item.type === "userMessage" && item.clientId === clientId).length !== 1)
    throw new DesktopUnavailableError("Codex не подтвердил точный завершённый ход очереди.");
  return turn.id as string;
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
  const maxCursorBytes = 1_024;
  const maxCursorHistoryBytes = 1_024 * 1_024;
  const cursorBytes = (value: string): number => Buffer.byteLength(value, "utf8");
  // v2 cursors fingerprinted full one-turn pages. They cannot be interpreted
  // as summary-batch boundaries; a read-only restart from oldest is safe.
  const resume = previous?.scanVersion === 3 ? previous : null;
  if (resume && (typeof resume.headDigest !== "string" || !/^[0-9a-f]{64}$/u.test(resume.headDigest) ||
    typeof resume.cursor !== "string" || !resume.cursor || cursorBytes(resume.cursor) > maxCursorBytes ||
    !Array.isArray(resume.seenCursors) || resume.seenCursors.length !== resume.pages ||
    resume.seenCursors.some(value => typeof value !== "string" || !value || cursorBytes(value) > maxCursorBytes) ||
    resume.seenCursors.reduce((total, value) => total + (typeof value === "string" ? cursorBytes(value) : 0), 0) > maxCursorHistoryBytes ||
    new Set(resume.seenCursors).size !== resume.seenCursors.length ||
    resume.seenCursors.at(-1) !== resume.cursor ||
    !Number.isSafeInteger(resume.pages) || resume.pages < 1 || resume.pages > 5_000))
    throw new DesktopUnavailableError("Курсор истории очереди повреждён.");
  type Page = IpcObject & { data: unknown[]; nextCursor: string | null };
  const batchSize = 12;
  const maxSummaryBytes = 8 * 1024 * 1024;
  const fingerprint = (page: Page): string => createHash("sha256")
    .update(JSON.stringify([page.data, page.nextCursor])).digest("hex");
  const read = async (cursor?: string, limit = batchSize, itemsView = "summary"): Promise<Page> => {
    const page = await list({ threadId, limit, sortDirection: "asc", itemsView,
      ...(cursor ? { cursor } : {}) });
    if (page.threadId !== undefined && page.threadId !== threadId ||
      !Array.isArray(page.data) || page.data.length > limit ||
      !(page.nextCursor === null || typeof page.nextCursor === "string") ||
      typeof page.nextCursor === "string" && cursorBytes(page.nextCursor) > maxCursorBytes)
      throw new DesktopUnavailableError("Codex вернул неполную историю очереди.");
    // Summary can still carry text. Bound parsed data separately from the
    // metadata RPC line ceiling; never enlarge that ceiling for this scan.
    if (itemsView === "summary" && Buffer.byteLength(JSON.stringify(page.data), "utf8") > maxSummaryBytes)
      throw new DesktopUnavailableError("Страница истории очереди слишком велика.");
    return page as Page;
  };
  // In ascending order the oldest page stays fixed when a new active turn is
  // appended. Keep the existing cursor field name for persisted checkpoints.
  // Fingerprint exactly one oldest turn. A short thread's newer active turn
  // may change while its oldest terminal turn stays stable.
  const oldest = await read(undefined, 1);
  const headDigest = fingerprint(oldest);
  if (resume && headDigest !== resume.headDigest)
    throw new DesktopUnavailableError("История очереди изменилась во время проверки.");
  const cursors = new Set(resume?.seenCursors ?? []);
  let totalCursorBytes = resume?.seenCursors.reduce((total, value) => total + cursorBytes(value), 0) ?? 0;
  let cursor: string | null = resume?.cursor ?? null;
  let pages = resume?.pages ?? 0;
  let calls = 1;
  const consume = async (page: Page, startCursor?: string): Promise<string | null> => {
    const turns = new Set<string>();
    let matchedIndex: number | null = null;
    if (page.nextCursor !== null && (!page.nextCursor || cursors.has(page.nextCursor) || page.data.length === 0 ||
      totalCursorBytes + cursorBytes(page.nextCursor) > maxCursorHistoryBytes))
      throw new DesktopUnavailableError("Codex не завершил чтение истории очереди.");
    for (const [index, turn] of page.data.entries()) {
      if (!isObject(turn) || turn.threadId !== undefined && turn.threadId !== threadId ||
        typeof turn.id !== "string" || !turn.id || turns.has(turn.id) ||
        turn.itemsView !== "summary" || !Array.isArray(turn.items) || typeof turn.status !== "string")
        throw new DesktopUnavailableError("Codex вернул неполный ход очереди.");
      if (!["completed", "failed", "interrupted"].includes(turn.status))
        throw new MutableQueuedInputTurnError();
      turns.add(turn.id);
      for (const item of turn.items) {
        if (!isObject(item) || typeof item.type !== "string")
          throw new DesktopUnavailableError("Codex вернул неполный элемент истории очереди.");
        if (item.type !== "userMessage" || item.clientId !== clientId) continue;
        if (matchedIndex !== null || !["completed", "failed", "interrupted"].includes(turn.status))
          throw new DesktopUnavailableError("Ход очереди неоднозначен или ещё не завершён.");
        matchedIndex = index;
      }
    }
    let matched: string | null = null;
    if (matchedIndex !== null) {
      // A summary hit is only a candidate. Replay within this bounded batch
      // to obtain the opaque cursor immediately before that turn, and require
      // exact full-view terminal proof before settling any ACK.
      let candidateCursor = startCursor;
      for (let index = 0; index < matchedIndex; index++) {
        const replay = await read(candidateCursor, 1, "summary");
        const expected = page.data[index];
        const actual = replay.data[0];
        if (replay.data.length !== 1 || !isObject(expected) || !isObject(actual)
          || actual.id !== expected.id || actual.status !== expected.status
          || actual.itemsView !== "summary" || !replay.nextCursor)
          throw new DesktopUnavailableError("История очереди изменилась во время проверки.");
        candidateCursor = replay.nextCursor;
      }
      const full = await read(candidateCursor, 1, "full");
      const turn = full.data[0], expected = page.data[matchedIndex];
      if (full.data.length !== 1 || !isObject(turn) || !isObject(expected)
        || turn.threadId !== undefined && turn.threadId !== threadId
        || turn.id !== expected.id || turn.status !== expected.status
        || turn.itemsView !== "full" || !["completed", "failed", "interrupted"].includes(String(turn.status))
        || !Array.isArray(turn.items) || turn.items.some(item => !isObject(item) || typeof item.type !== "string")
        || turn.items.filter(item => isObject(item) && item.type === "userMessage" && item.clientId === clientId).length !== 1)
        throw new DesktopUnavailableError("Codex не подтвердил точный завершённый ход очереди.");
      matched = turn.id as string;
    }
    pages++;
    cursor = page.nextCursor;
    if (cursor) {
      cursors.add(cursor);
      totalCursorBytes += cursorBytes(cursor);
    }
    return matched;
  };
  if (!resume) {
    const matched = await consume(oldest);
    if (matched) return { done: true, turnId: matched };
  }
  // One additional bounded summary batch per maintenance pass, with durable
  // cursor progress. A candidate may cause at most 12 one-turn replay reads.
  while (cursor !== null && calls < 2) {
    if (pages >= 5_000) throw new DesktopUnavailableError("История очереди превысила предел чтения.");
    const startCursor = cursor;
    const page = await read(startCursor);
    calls++;
    let matched: string | null;
    try { matched = await consume(page, startCursor); }
    catch (error) {
      if (error instanceof MutableQueuedInputTurnError) break;
      throw error;
    }
    if (matched) return { done: true, turnId: matched };
  }
  if (cursor !== null) return { done: false, cursor: { scanVersion: 3, headDigest, cursor,
    seenCursors: [...cursors], pages } };
  return { done: true, turnId: null };
}
