const { watchDotSubmission } = vkodexLoad("./submission-dom-observer.js");
let watch = null;
const knownFailures = new Map([
  ["Unqualified room binding", "room-binding"], ["Unqualified room window", "room-window"],
  ["Unqualified room row", "room-row"], ["Owner anchor disagrees with layout", "owner-anchor-layout"],
  ["Dot anchor disagrees with layout", "dot-anchor-layout"], ["Invalid room text", "room-text"],
  ["Room text limit", "room-text-limit"], ["Empty role anchor", "empty-anchor"],
  ["Role anchors are outside the observed window", "anchors-missing"], ["Room row limit", "room-row-limit"],
  ["Invalid submission watch", "watch-options"],
]);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  try {
    if (message?.type === "stop") { watch?.disconnect(); respond({ phase: watch?.state.phase || "idle" }); return false; }
    if (message?.type !== "arm" || watch !== null) throw new Error("Observer is already armed or request is unknown");
    const config = message.config;
    watch = watchDotSubmission({ document,
      binding: { pageUrl: config.pageUrl, roomId: config.roomId, ownerAnchorId: config.ownerAnchorId, dotAnchorId: config.dotAnchorId },
      expectedText: config.expectedText, operationId: config.operationId, observerEpoch: config.operationId,
      timeoutMs: 120_000,
      onTerminal: result => { void chrome.runtime.sendMessage({ type: "receipt", operationId: config.operationId, phase: result.phase,
        ...(result.phase === "observed" ? { messageId: result.messageId } : {}) }).catch(() => {}); } });
    respond({ phase: watch.state.phase });
  } catch (error) {
    const reason = knownFailures.get(error?.message) || "observer-start-failed";
    let diagnostics = {};
    try {
      const ids = [...document.querySelectorAll("article[data-message-id]")].map(row => row.getAttribute("data-message-id"));
      diagnostics = { rowCount: ids.length, ownerAnchorPresent: ids.includes(message.config?.ownerAnchorId),
        dotAnchorPresent: ids.includes(message.config?.dotAnchorId), pageMatches: document.defaultView?.location.href === message.config?.pageUrl };
    } catch { /* Diagnostics must not replace the original bounded category. */ }
    respond({ phase: "uncertain", reason, diagnostics });
  }
  return false;
});
