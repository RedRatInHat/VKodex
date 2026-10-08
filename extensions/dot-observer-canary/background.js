importScripts("config.js");
const config = globalThis.VKODEX_CANARY_CONFIG;
let queue = Promise.resolve();
const read = async () => (await chrome.storage.session.get("canary")).canary || { phase: "idle" };
const save = async state => { await chrome.storage.session.set({ canary: state }); return state; };
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error("Другой отправитель расширения");
  if (message?.type === "receipt") {
    const state = await read();
    if (state.phase !== "armed" || sender.tab?.id !== state.tabId || sender.frameId !== 0 || sender.url !== config.pageUrl ||
        message.operationId !== config.operationId || !["observed", "uncertain"].includes(message.phase))
      throw new Error("Результат не соответствует запущенному наблюдению");
    const prefix = `${config.roomId}~${config.roomId}~CalpicoMessage~`;
    if (message.phase === "observed" && (typeof message.messageId !== "string" || !message.messageId.startsWith(prefix) ||
        !/^Sentinel_[a-f0-9]{32}$/.test(message.messageId.slice(prefix.length)))) throw new Error("Неверный ID результата");
    const reasons = ["gap", "disconnect", "navigation", "interference", "timeout", "transition-rejected"];
    return await save({ ...state, phase: message.phase, finishedAt: Date.now(),
      ...(message.phase === "observed" ? { messageId: message.messageId, evidence: "same-node-dom-transition" } :
        { reason: reasons.includes(message.reason) ? message.reason : "unknown" }) });
  }
  if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("Команда доступна только из окна расширения");
  if (message?.type === "status") return await read();
  const state = await read();
  if (message?.type === "stop") {
    if (state.phase === "armed") await chrome.tabs.sendMessage(state.tabId, { type: "stop" }).catch(() => {});
    return state.phase === "armed" || state.phase === "arming" ? await save({ ...state, phase: "uncertain", finishedAt: Date.now() }) : state;
  }
  if (message?.type !== "arm" || state.phase !== "idle") throw new Error("Повторное наблюдение не разрешено этим сеансом");
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length !== 1 || !Number.isSafeInteger(tabs[0].id) || tabs[0].url !== config.pageUrl)
    throw new Error("Откройте именно настроенный чат перед наблюдением");
  const started = { phase: "arming", operationId: config.operationId, tabId: tabs[0].id, startedAt: Date.now() };
  await save(started); // A failed injection is not automatically retried.
  let stage = "script-injection";
  try {
    await chrome.scripting.executeScript({ target: { tabId: started.tabId }, files: ["observer.bundle.js"] });
    stage = "observer-handshake";
    const response = await chrome.tabs.sendMessage(started.tabId, { type: "arm", config });
    if (response?.phase !== "awaiting-pending") {
      const allowed = ["room-binding", "room-window", "room-row", "owner-anchor-layout", "dot-anchor-layout",
        "room-text", "room-text-limit", "empty-anchor", "anchors-missing", "room-row-limit", "watch-options", "observer-start-failed"];
      const diagnostics = {};
      const supplied = response?.diagnostics;
      if (Number.isSafeInteger(supplied?.rowCount) && supplied.rowCount >= 0) diagnostics.rowCount = supplied.rowCount;
      for (const key of ["ownerAnchorPresent", "dotAnchorPresent", "pageMatches"])
        if (typeof supplied?.[key] === "boolean") diagnostics[key] = supplied[key];
      return await save({ ...started, phase: "uncertain", finishedAt: Date.now(), reason: "arm-failed", stage: "room-qualification",
        category: allowed.includes(response?.reason) ? response.reason : "observer-start-failed", diagnostics });
    }
    return await save({ ...started, phase: "armed" });
  } catch { return await save({ ...started, phase: "uncertain", finishedAt: Date.now(), reason: "arm-failed", stage }); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const operation = queue.then(() => handle(message, sender));
  queue = operation.catch(() => {});
  operation.then(state => respond({ ok: true, state }), error => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
