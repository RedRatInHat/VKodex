import { parseDotControlRequest, matchDotControlResponse, type DotControlRequest } from "../../src/dot-browser/control-protocol.js";
import type { DotRoomBinding } from "../../src/dot-browser/room-observation.js";
declare const chrome: any;
declare const VKODEX_CONTROL_CONFIG: DotRoomBinding & { generation: number; nativeHost: string; enabled: boolean };

let port: any = null;
let active: { request: DotControlRequest; tabId: number; port: any } | null = null;
let bound: { epoch: string; tabId: number } | null = null;
const RECONNECT = "vkodex-dot-native-reconnect";

async function clearBound(): Promise<void> {
  const old = bound; bound = null;
  if (old) await chrome.tabs.sendMessage(old.tabId, { channel: "vkodex-dot-control", disconnect: true, epoch: old.epoch }).catch(() => {});
}
function close(): void {
  const old = port; port = null; active = null;
  void clearBound();
  try { old?.disconnect(); } catch { /* Already disconnected. */ }
  if (VKODEX_CONTROL_CONFIG.enabled) chrome.alarms.create(RECONNECT, { delayInMinutes: 1 });
}
async function command(value: unknown, sourcePort: any): Promise<void> {
  if (sourcePort !== port) return;
  let request: DotControlRequest;
  try { request = parseDotControlRequest(value); } catch { close(); return; }
  if (active !== null) { close(); return; }
  active = { request, tabId: -1, port: sourcePort };
  let reason = "not-ready";
  const fail = (): void => {
    if (sourcePort === port) sourcePort.postMessage({ version: 1, requestId: request.requestId,
      scope: request.scope, kind: "error", reason });
  };
  try {
    if (request.scope.roomId !== VKODEX_CONTROL_CONFIG.roomId || request.scope.generation !== VKODEX_CONTROL_CONFIG.generation) {
      reason = "wrong-scope"; fail(); return;
    }
    const tabs = (await chrome.tabs.query({ url: VKODEX_CONTROL_CONFIG.pageUrl })).filter((tab: any) => tab.url === VKODEX_CONTROL_CONFIG.pageUrl);
    if (sourcePort !== port) return;
    if (tabs.length !== 1 || !Number.isSafeInteger(tabs[0].id)) { reason = tabs.length > 1 ? "tab-ambiguous" : "tab-missing"; fail(); return; }
    const tabId = tabs[0].id;
    if (bound && (bound.epoch !== request.scope.epoch || bound.tabId !== tabId)) { close(); return; }
    if (!bound && request.method !== "status") { fail(); return; }
    active = { request, tabId, port: sourcePort };
    reason = "script-injection";
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.bundle.js"] });
    if (sourcePort !== port) return;
    bound = { epoch: request.scope.epoch, tabId };
    reason = "content-disconnected";
    const value = await chrome.tabs.sendMessage(tabId, { channel: "vkodex-dot-control", request });
    if (sourcePort !== port) return;
    reason = "invalid-response";
    const response = matchDotControlResponse(request, value);
    sourcePort.postMessage(response);
  } catch { try { fail(); } catch { close(); } }
  finally { if (active?.port === sourcePort) active = null; }
}

chrome.runtime.onMessage.addListener((message: any, sender: any, respond: (value: unknown) => void) => {
  if (message?.channel !== "vkodex-dot-control" || !active || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      sender.tab?.id !== active.tabId || sender.url !== VKODEX_CONTROL_CONFIG.pageUrl || active.port !== port) return false;
  try {
    const response = matchDotControlResponse(active.request, message.response);
    // Content may stream stages/acknowledgements only; final receipt comes from
    // the outstanding command response and cannot be duplicated here.
    if (response.kind !== "stage" && !(response.kind === "result" && response.result.phase === "accepted")) throw new Error("Unexpected event");
    port.postMessage(response); respond({ accepted: true });
  } catch { close(); respond({ accepted: false }); }
  return false;
});
function connect(): void {
  if (!VKODEX_CONTROL_CONFIG.enabled || port !== null) return;
  try {
    const next = chrome.runtime.connectNative(VKODEX_CONTROL_CONFIG.nativeHost); port = next;
    next.onMessage.addListener((value: unknown) => { void command(value, next); });
    next.onDisconnect.addListener(() => { if (port === next) close(); });
  } catch { close(); }
}
chrome.alarms.onAlarm.addListener((alarm: { name: string }) => { if (alarm.name === RECONNECT) connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
