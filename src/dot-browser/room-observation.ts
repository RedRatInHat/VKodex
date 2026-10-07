/** Read-only qualification of a rendered dot room. This is display evidence,
 * never authenticated input, a submission receipt, or a complete history.
 * No browser connection, extension, polling, storage, network or mutation.
 */
export interface DotRoomBinding {
  readonly pageUrl: string;
  readonly roomId: string;
  /** Existing visible messages whose authors were independently verified. */
  readonly ownerAnchorId: string;
  readonly dotAnchorId: string;
}

export interface DotRoomRow {
  readonly tagName: string;
  readonly classes: readonly string[];
  readonly messageId: string | null;
  readonly bodyIds: readonly (string | null)[];
  readonly textBlocks: readonly string[];
  readonly unsupportedContent: boolean;
}

export interface DotRoomTextObservation {
  readonly messageId: string;
  readonly text: string;
  /** Inferred from a qualified UI layout, not server-authoritative identity. */
  readonly displayRole: "owner" | "dot";
  readonly evidence: "rendered-room";
}

export interface DotRoomObservation {
  readonly kind: "partial-room-observation";
  readonly completeHistory: false;
  readonly authoritativeAuthors: false;
  readonly messages: readonly DotRoomTextObservation[];
  readonly unsupportedMessageIds: readonly string[];
}

export class DotRoomObservationRejected extends Error {
  override get name(): string { return "DotRoomObservationRejected"; }
}

const MAX_ROWS = 500;
const MAX_TEXT = 100_000;
const MAX_TOTAL_TEXT = 2_000_000;
const ROOM = /^[a-f0-9]{32}$/u;
const MESSAGE = /^Sentinel_[a-f0-9]{32}$/u;
const DOT_URL = /^https:\/\/chatgpt\.com\/dots\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

function reject(reason: string): never { throw new DotRoomObservationRejected(reason); }
function boundId(id: unknown, roomId: string): id is string {
  if (typeof id !== "string") return false;
  const parts = id.split("~");
  return parts.length === 4 && parts[0] === roomId && parts[1] === roomId &&
    parts[2] === "CalpicoMessage" && MESSAGE.test(parts[3]!);
}

/** Validation is all-or-nothing. DOM order is only the loaded window's order.
 * Repeated text with distinct IDs is preserved; repeated IDs are rejected.
 * Anchors must both be present. A virtualized/missing window is not authority
 * to reset a cursor, replay history, infer an author, or resubmit anything.
 */
export function qualifyDotRoomRows(pageUrl: string, rows: readonly DotRoomRow[], binding: DotRoomBinding): DotRoomObservation {
  if (!DOT_URL.test(binding.pageUrl) || pageUrl !== binding.pageUrl || !ROOM.test(binding.roomId) ||
      !boundId(binding.ownerAnchorId, binding.roomId) || !boundId(binding.dotAnchorId, binding.roomId) ||
      binding.ownerAnchorId === binding.dotAnchorId) reject("Unqualified room binding");
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) reject("Unqualified room window");
  const seen = new Set<string>();
  const messages: DotRoomTextObservation[] = [];
  const unsupportedMessageIds: string[] = [];
  let ownerAnchor = false, dotAnchor = false, textSize = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.tagName !== "ARTICLE" || !Array.isArray(row.classes) ||
        !row.classes.includes("message-row") || row.classes.some((name: unknown) =>
          name !== "message-row" && name !== "self" && name !== "grouped-next" && name !== "grouped-previous") ||
        !boundId(row.messageId, binding.roomId) || seen.has(row.messageId) ||
        !Array.isArray(row.bodyIds) || row.bodyIds.length !== 1 || row.bodyIds[0] !== row.messageId ||
        !Array.isArray(row.textBlocks) || row.textBlocks.length > 1 ||
        typeof row.unsupportedContent !== "boolean") reject("Unqualified room row");
    seen.add(row.messageId);
    const isOwner = row.classes.includes("self");
    if (row.messageId === binding.ownerAnchorId) {
      if (!isOwner || row.unsupportedContent || row.textBlocks.length !== 1) reject("Owner anchor disagrees with layout");
      ownerAnchor = true;
    }
    if (row.messageId === binding.dotAnchorId) {
      if (isOwner || row.unsupportedContent || row.textBlocks.length !== 1) reject("Dot anchor disagrees with layout");
      dotAnchor = true;
    }
    const text = row.textBlocks[0];
    if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT || text.includes("\0")))
      reject("Invalid room text");
    textSize += text?.length ?? 0;
    if (textSize > MAX_TOTAL_TEXT) reject("Room text limit");
    if (row.unsupportedContent || text === undefined || !text.trim()) {
      if (row.messageId === binding.ownerAnchorId || row.messageId === binding.dotAnchorId) reject("Empty role anchor");
      unsupportedMessageIds.push(row.messageId);
      continue;
    }
    messages.push({ messageId: row.messageId, text, displayRole: isOwner ? "owner" : "dot", evidence: "rendered-room" });
  }
  if (!ownerAnchor || !dotAnchor) reject("Role anchors are outside the observed window");
  return { kind: "partial-room-observation", completeHistory: false, authoritativeAuthors: false, messages, unsupportedMessageIds };
}

/** A conservative DOM collector for the observed room layout. Call only from
 * an independently authorized browser surface. It reads the supplied DOM and
 * never reaches into application state, cookies, renderer APIs or the network.
 * Unknown markup is explicitly unsupported rather than silently flattened.
 */
export function readDotRoomDocument(document: Document, pageUrl: string, binding: DotRoomBinding): DotRoomObservation {
  const articles = [...document.querySelectorAll("article[data-message-id]")];
  if (articles.length > MAX_ROWS) reject("Room row limit");
  const allowed = new Set(["DIV", "SPAN", "P", "BR", "STRONG", "EM", "B", "I", "S", "DEL", "CODE", "PRE",
    "OL", "UL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6"]);
  const rows = articles.map(article => {
    const bodies = [...article.querySelectorAll(".message-body")];
    const blocks = [...article.querySelectorAll(".message-body .message-text")];
    const unsupportedContent = article.querySelectorAll(".message-surface").length !== 1 ||
      article.querySelectorAll(".message-bubble").length !== 1 ||
      bodies.some(body => [...body.children].some(child =>
      !child.classList.contains("message-surface") && !child.classList.contains("message-inline-actions"))) ||
      [...article.querySelectorAll(".message-surface *")].some(element => !allowed.has(element.tagName) ||
        element.hasAttribute("role") || element.hasAttribute("contenteditable")) ||
      [...article.querySelectorAll(".message-surface")].some(surface =>
        [...surface.children].some(child => !child.classList.contains("message-bubble"))) ||
      [...article.querySelectorAll(".message-bubble")].some(bubble =>
        [...bubble.children].some(child => !child.classList.contains("message-text")));
    return { tagName: article.tagName, classes: [...article.classList], messageId: article.getAttribute("data-message-id"),
      bodyIds: bodies.map(body => body.getAttribute("data-message-id")),
      textBlocks: blocks.map(block => (block as HTMLElement).innerText), unsupportedContent };
  });
  return qualifyDotRoomRows(pageUrl, rows, binding);
}
