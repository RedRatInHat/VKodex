import { readDotRoomDocument, type DotRoomBinding } from "./room-observation.js";
import { watchDotSubmission, type DotSubmissionFailure, type DotSubmissionWatch } from "./submission-dom-observer.js";
import type { SubmissionObservation } from "./submission-observation.js";

export type DotSubmissionStage = "armed" | "write-attempt" | "write-returned" | "receipt" | "uncertain";
export type DotSubmissionCommandReason = DotSubmissionFailure | "unqualified-controls" | "draft-present" |
  "aborted" | "operation-conflict";
export type DotSubmissionCommandResult = Extract<SubmissionObservation, { phase: "observed" }> |
  { readonly phase: "uncertain"; readonly reason: DotSubmissionCommandReason };
export interface DotSubmissionCommandOptions {
  readonly document: Document;
  readonly binding: DotRoomBinding;
  readonly operationId: string;
  readonly observerEpoch: string;
  readonly expectedText: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly onStage: (stage: DotSubmissionStage) => void;
  readonly onTerminal: (result: DotSubmissionCommandResult) => void;
}

// This local fence supplements, never replaces, the caller's durable fence.
// No eviction: exhausting the bounded document lifetime refuses further work.
const operations = new WeakMap<Document, Set<string>>();
const active = new WeakSet<Document>();
const MAX_OPERATIONS = 512;

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) return labelledBy.trim().split(/\s+/u).map(id =>
    element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ").trim();
  const direct = element.getAttribute("aria-label");
  if (direct !== null) return direct.trim();
  if (element.tagName === "TEXTAREA") return [...(element as HTMLTextAreaElement).labels ?? []]
    .map(label => label.textContent ?? "").join(" ").trim();
  return (element.textContent ?? "").trim();
}

function controls(document: Document): { composer: HTMLTextAreaElement; send: HTMLButtonElement } | null {
  const window = document.defaultView;
  if (!window) return null;
  const composers = [...document.querySelectorAll("textarea")].filter(node => accessibleName(node) === "Message");
  const sends = [...document.querySelectorAll("button")].filter(node => accessibleName(node) === "Send");
  if (composers.length !== 1 || sends.length !== 1) return null;
  const composer = composers[0]!, send = sends[0]!;
  if (!(composer instanceof window.HTMLTextAreaElement) || !(send instanceof window.HTMLButtonElement) ||
      [composer, send].some(node => !node.isConnected || node.hidden || node.getClientRects().length === 0 ||
        node.closest("[hidden], [inert], [aria-hidden='true']") !== null || node.hasAttribute("role")) || composer.readOnly ||
      composer.matches(":disabled") || composer.getAttribute("aria-readonly") === "true" ||
      composer.getAttribute("aria-disabled") === "true") return null;
  return { composer, send };
}

/** Read-only control preflight; never returns draft text or DOM data. */
export function inspectDotSubmissionControls(document: Document): {
  readonly qualified: boolean; readonly draftPresent: boolean | null;
} {
  try {
    const selected = controls(document);
    return selected ? { qualified: true, draftPresent: selected.composer.value !== "" } :
      { qualified: false, draftPresent: null };
  } catch { return { qualified: false, draftPresent: null }; }
}

/** One fenced command; ordinary native textarea setter/input and one click.
 * Hooks carry only fixed stages/results, never drafts or prompt text. They are
 * advisory: a throwing diagnostic consumer cannot authorize/retry a submission.
 * Preflight failures also remain uncertain; this API never grants a new send.
 */
export function runDotSubmissionCommand(options: DotSubmissionCommandOptions): Promise<DotSubmissionCommandResult> {
  const { document, signal, expectedText } = options;
  const binding = { ...options.binding };
  return new Promise(resolve => {
    const window = document.defaultView;
    let watch: DotSubmissionWatch | undefined, guard: MutationObserver | undefined, timer: number | undefined;
    let finished = false, ownsDocument = false, filled = false, clicked = false, clicking = false;
    let deferred: DotSubmissionCommandResult | undefined;
    let selected: ReturnType<typeof controls> = null;
    let ownInput: Event | undefined;
    const stage = (value: DotSubmissionStage): void => { try { options.onStage(value); } catch { /* Advisory only. */ } };
    const finish = (result: DotSubmissionCommandResult): void => {
      if (finished) return;
      if (clicking) { deferred ??= result; return; }
      finished = true;
      guard?.disconnect();
      if (timer !== undefined) window?.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      window?.removeEventListener("pagehide", navigation);
      window?.removeEventListener("popstate", navigation);
      for (const name of ["beforeinput", "input", "change", "keydown", "paste", "drop", "compositionstart", "click"])
        document.removeEventListener(name, interference, true);
      watch?.disconnect();
      if (ownsDocument) active.delete(document);
      stage(result.phase === "observed" ? "receipt" : "uncertain");
      resolve(result);
      try { options.onTerminal(result); } catch { /* No retry or change to terminal evidence. */ }
    };
    const stop = (reason: DotSubmissionCommandReason): void => finish({ phase: "uncertain", reason });
    const abort = (): void => stop("aborted");
    const navigation = (): void => stop("navigation");
    const interference = (event: Event): void => {
      if (event === ownInput) return;
      if (event.target === selected?.composer || event.type === "click" && event.isTrusted &&
          event.target !== null && selected?.send.contains(event.target as Node))
        stop("interference");
    };
    const valid = (): boolean => {
      if (finished) return false;
      if (signal.aborted) { abort(); return false; }
      if (!window || document.defaultView !== window || window.location.href !== binding.pageUrl) {
        navigation(); return false;
      }
      const current = controls(document);
      if (!current || current.composer !== selected?.composer || current.send !== selected.send) {
        stop("unqualified-controls"); return false;
      }
      if (!clicked && current.composer.value !== (filled ? expectedText : "")) {
        stop(filled ? "interference" : "draft-present"); return false;
      }
      return true;
    };
    const attempt = (): void => {
      try {
        // Once clicked, receipt continuity belongs to the watcher; the UI may
        // replace the composer or Send control while the receipt is pending.
        if (clicked || !valid() || !filled) return;
        const send = selected!.send;
        if (send.matches(":disabled") || send.getAttribute("aria-disabled") === "true") return;
        // No asynchronous boundary between this final check and the one click.
        if (!valid()) return;
        clicked = true;
        clicking = true;
        try { send.click(); } catch { deferred = { phase: "uncertain", reason: "disconnect" }; }
        clicking = false;
        stage("write-returned");
        if (deferred) finish(deferred);
      } catch { stop("unqualified-controls"); }
    };
    try {
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000 ||
          typeof expectedText !== "string" || !expectedText.trim() || expectedText.length > 100_000 || expectedText.includes("\0")) {
        stop("unqualified-controls"); return;
      }
      if (signal.aborted) { abort(); return; }
      if (!window || !document.body || window.location.href !== binding.pageUrl) { navigation(); return; }
      const seen = operations.get(document) ?? new Set<string>();
      if (active.has(document) || seen.has(options.operationId) || seen.size >= MAX_OPERATIONS) {
        stop("operation-conflict"); return;
      }
      seen.add(options.operationId); operations.set(document, seen); active.add(document); ownsDocument = true;
      readDotRoomDocument(document, window.location.href, binding);
      selected = controls(document);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (!selected || !setter) { stop("unqualified-controls"); return; }
      if (!valid()) return;
      watch = watchDotSubmission({ document, binding, operationId: options.operationId, observerEpoch: options.observerEpoch,
        expectedText, timeoutMs: options.timeoutMs, onTerminal: (result, reason) => {
          if (result.phase === "observed") finish(clicked ? result : { phase: "uncertain", reason: "interference" });
          else finish({ phase: "uncertain", reason: reason ?? "transition-rejected" });
        } });
      guard = new window.MutationObserver(() => attempt());
      guard.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      signal.addEventListener("abort", abort, { once: true });
      window.addEventListener("pagehide", navigation);
      window.addEventListener("popstate", navigation);
      for (const name of ["beforeinput", "input", "change", "keydown", "paste", "drop", "compositionstart", "click"])
        document.addEventListener(name, interference, true);
      timer = window.setTimeout(() => stop("timeout"), options.timeoutMs);
      stage("armed");
      if (!valid()) return;
      stage("write-attempt");
      if (!valid()) return;
      filled = true;
      setter.call(selected.composer, expectedText);
      if (!valid()) return;
      ownInput = new window.Event("input", { bubbles: true });
      selected.composer.dispatchEvent(ownInput);
      ownInput = undefined;
      // Let ordinary input handlers and pending MutationObserver deliveries run.
      void Promise.resolve().then(attempt);
    } catch { stop("gap"); }
  });
}
