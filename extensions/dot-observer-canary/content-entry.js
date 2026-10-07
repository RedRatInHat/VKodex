const { watchDotSubmission } = vkodexLoad("./submission-dom-observer.js");
let watch = null;
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
  } catch { respond({ phase: "uncertain" }); }
  return false;
});
