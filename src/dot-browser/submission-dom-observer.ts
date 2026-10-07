import { readDotRoomDocument, readDotRoomRow, type DotRoomBinding } from "./room-observation.js";
import { DotSubmissionObservation, type SubmissionObservation } from "./submission-observation.js";

export interface DotSubmissionWatchOptions {
  readonly document: Document;
  readonly binding: DotRoomBinding;
  readonly operationId: string;
  readonly observerEpoch: string;
  readonly expectedText: string;
  readonly timeoutMs: number;
  /** Persist this result in the dispatch ledger. This callback cannot authorize
   * another send. A crash before persistence remains an uncertain operation. */
  readonly onTerminal: (result: SubmissionObservation) => void;
}
export interface DotSubmissionWatch {
  readonly state: SubmissionObservation;
  /** Call before relinquishing exclusive composer ownership or on transport loss. */
  disconnect(): void;
}

const PENDING = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const MAX_MUTATIONS = 2_000;

/** Read-only, one-operation DOM subscription. It neither fills nor clicks the
 * composer and never accesses application internals or the network. Install
 * only in an authorized browser adapter AFTER a durable dispatch fence and
 * while holding exclusive composer ownership. Not installed by any entrypoint.
 *
 * Acceptance needs an observed pending article followed by a canonical ID on
 * the same physical node. A batched mutation that skipped the pending snapshot
 * is deliberately uncertain: attribute oldValue alone is not a full snapshot.
 */
export function watchDotSubmission(options: DotSubmissionWatchOptions): DotSubmissionWatch {
  const { document, binding, expectedText } = options;
  const window = document.defaultView;
  if (!window || !document.body || typeof expectedText !== "string" || !expectedText.trim() ||
      expectedText.length > 100_000 || expectedText.includes("\0") ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
    throw new TypeError("Invalid submission watch");
  const baseline = readDotRoomDocument(document, window.location.href, binding);
  const baselineIds = new Set([...baseline.messages.map(message => message.messageId), ...baseline.unsupportedMessageIds]);
  const tracker = new DotSubmissionObservation({ roomId: binding.roomId, observerEpoch: options.observerEpoch,
    operationId: options.operationId, baselineMessageIds: [...baselineIds] }, "new-fenced-attempt");
  const baselineNodes = new Set(document.querySelectorAll("article[data-message-id]"));
  const identities = new WeakMap<Element, string>();
  let serial = 0, pending: Element | null = null, previousId: string | null = null, closed = false;
  let timeout: number | undefined;
  const nodeId = (node: Element): string => {
    let id = identities.get(node);
    if (!id) { id = `article-${++serial}`; identities.set(node, id); }
    return id;
  };
  const terminal = (): void => {
    if (closed || !["uncertain", "observed"].includes(tracker.state.phase)) return;
    closed = true;
    observer.disconnect();
    if (timeout !== undefined) window.clearTimeout(timeout);
    window.removeEventListener("pagehide", navigation);
    window.removeEventListener("popstate", navigation);
    options.onTerminal(tracker.state);
  };
  const fail = (type: "gap" | "disconnect" | "navigation" | "interference" | "timeout"): void => {
    if (closed) return;
    tracker.observe({ type, observerEpoch: options.observerEpoch }); terminal();
  };
  const navigation = (): void => fail("navigation");
  const scan = (records: readonly MutationRecord[]): void => {
    if (closed) return;
    if (window.location.href !== binding.pageUrl || document.defaultView !== window) { fail("navigation"); return; }
    if (records.length > MAX_MUTATIONS) { fail("gap"); return; }
    // A removed and reinserted node is a continuity gap even if the final
    // snapshot or framework key looks unchanged.
    if (pending && records.some(record => [...record.removedNodes].some(node => node === pending || node.contains(pending)))) {
      fail("gap"); return;
    }
    const articles = [...document.querySelectorAll("article[data-message-id]")];
    if (articles.length > 500 || pending && !articles.includes(pending)) { fail("gap"); return; }
    const candidates = articles.filter(article => article.classList.contains("self") &&
      !baselineIds.has(article.getAttribute("data-message-id") ?? ""));
    if (candidates.length === 0) return;
    if (candidates.length !== 1) { fail("interference"); return; }
    const article = candidates[0]!;
    if (baselineNodes.has(article)) { fail("interference"); return; }
    const id = article.getAttribute("data-message-id");
    const row = readDotRoomRow(article);
    if (!id || row.tagName !== "ARTICLE" || !row.classes.includes("message-row") || row.unsupportedContent ||
        row.classes.some(name => !["message-row", "self", "grouped-next", "grouped-previous"].includes(name)) ||
        row.textBlocks.length !== 1 || row.bodyIds.length !== 1 || row.bodyIds[0] !== id || row.textBlocks[0] !== expectedText) {
      fail("interference"); return;
    }
    if (PENDING.test(id)) {
      tracker.observe({ type: "pending", observerEpoch: options.observerEpoch, nodeId: nodeId(article), pendingId: id,
        ownerLayout: true, exactText: true });
      pending = article; previousId = id;
    } else {
      const transitions = records.filter(record => record.type === "attributes" && record.target === article &&
        record.attributeName === "data-message-id");
      if (transitions.length !== 1 || transitions[0]!.oldValue !== previousId) { fail("gap"); return; }
      tracker.observe({ type: "canonical", observerEpoch: options.observerEpoch, nodeId: nodeId(article),
        previousId: previousId ?? "", messageId: id, ownerLayout: true, exactText: true });
    }
    terminal();
  };
  const observer = new window.MutationObserver(records => {
    // Unexpected markup/access errors invalidate evidence. Consumer errors in
    // onTerminal propagate; closed is already true, so they never trigger retry.
    try { scan(records); } catch (error) { if (closed) throw error; fail("gap"); }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-message-id", "class"], attributeOldValue: true, characterData: true });
  window.addEventListener("pagehide", navigation);
  window.addEventListener("popstate", navigation);
  timeout = window.setTimeout(() => fail("timeout"), options.timeoutMs);
  return { get state() { return tracker.state; }, disconnect: () => fail("disconnect") };
}
