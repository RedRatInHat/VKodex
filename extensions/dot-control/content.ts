import { DotExtensionController } from "../../src/dot-browser/extension-controller.js";
import { parseDotControlRequest, type DotControlResponse } from "../../src/dot-browser/control-protocol.js";
import type { DotRoomBinding } from "../../src/dot-browser/room-observation.js";

declare const chrome: any;
declare const VKODEX_CONTROL_CONFIG: DotRoomBinding & { generation: number; nativeHost: string };
const globals = globalThis as typeof globalThis & { vkodexDotControlInstalled?: boolean };
if (!globals.vkodexDotControlInstalled) {
  globals.vkodexDotControlInstalled = true;
  let controller: DotExtensionController | null = null;
  let epoch: string | null = null;
  const emit = (response: DotControlResponse): void => {
    void chrome.runtime.sendMessage({ channel: "vkodex-dot-control", response }).catch(() => controller?.disconnect());
  };
  chrome.runtime.onMessage.addListener((message: any, sender: any, respond: (value: unknown) => void) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== "vkodex-dot-control") return false;
    if (message.disconnect === true) {
      if (message.epoch === epoch) { controller?.disconnect(); controller = null; epoch = null; }
      respond({ disconnected: true }); return false;
    }
    try {
      const request = parseDotControlRequest(message.request);
      if (location.href !== VKODEX_CONTROL_CONFIG.pageUrl || request.scope.roomId !== VKODEX_CONTROL_CONFIG.roomId ||
          request.scope.generation !== VKODEX_CONTROL_CONFIG.generation) throw new Error("Wrong control scope");
      if (controller === null) {
        if (request.method !== "status") throw new Error("Status qualification required");
        epoch = request.scope.epoch;
        controller = new DotExtensionController(document, VKODEX_CONTROL_CONFIG, VKODEX_CONTROL_CONFIG.generation, epoch, emit);
      }
      void controller.handle(request).then(respond).catch(() => respond({ rejected: true }));
      return true;
    } catch { respond({ rejected: true }); return false; }
  });
}
