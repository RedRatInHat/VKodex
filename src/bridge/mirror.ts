import type { TaskEvent } from "../desktop/contracts.js";
import { chunkText } from "../lib/text.js";
import { BridgeStore } from "./store.js";
import { MENU_BUTTON } from "./contracts.js";

const USER_REQUEST_PREFIX = "## user request\n\n";
const MENU_FOOTER = "\n\nМеню задачи:";

export class TaskMirror {
  constructor(private readonly store: BridgeStore, private readonly chunkSize = 3_500) {
    if (!Number.isInteger(chunkSize) || chunkSize <= USER_REQUEST_PREFIX.length) {
      throw new RangeError("Mirror chunk size must leave room for the user request label and text");
    }
  }

  accept(bindingId: string, event: TaskEvent): void {
    if (event.type === "status") {
      if (event.status !== "running") this.store.retireTurnCommentary(bindingId, event.turnId);
      return;
    }
    const binding = this.store.getBinding(bindingId);
    if (!binding?.attached || binding.peerId === null) return;
    const peerId = binding.peerId;
    this.store.atomic(() => {
      if (event.type === "progress") {
        const key = `commentary:${binding.id}:${event.turnId}:${event.id}`;
        const chunks = chunkText(event.text, this.chunkSize);
        const previousCount = this.store.getValue<number>(key) ?? 0;
        chunks.forEach((text, index) => {
          const view = { text, silent: true };
          this.store.setValue(`commentary-base:${key}:${index}`, view);
          this.store.enqueue(`${key}:${index}`, peerId, view, binding.id, true);
        });
        for (let index = chunks.length; index < previousCount; index++) {
          this.store.setValue(`commentary-base:${key}:${index}`, null);
          this.store.withdrawCommentary(`${key}:${index}`);
        }
        this.store.setValue(key, chunks.length);
        return;
      }
      // Retire stale progress even when this final was already recorded before
      // a crash and is being observed again during recovery.
      if (event.type === "final") this.store.retireTurnCommentary(binding.id, event.turnId);
      if (!this.store.rememberEvent(binding.id, event.id)) return;
      if (event.type === "user" && event.operationId && this.store.isOwnOperation(event.operationId, binding)) return;
      const prefix = event.type === "user" ? USER_REQUEST_PREFIX : "";
      const footer = event.type === "final" ? MENU_FOOTER : "";
      // Reserve room for the footer so it cannot become a separate VK message.
      const chunks = chunkText(event.text, this.chunkSize - prefix.length - footer.length);
      chunks.forEach((chunk, index) => {
        this.store.enqueue(`event:${binding.id}:${event.id}:${index}`, peerId, {
          text: `${prefix}${chunk}${index === chunks.length - 1 ? footer : ""}`,
          ...(event.type === "user" ? { silent: true } : {}),
          ...(event.type === "final" && index === chunks.length - 1 ? { buttons: [MENU_BUTTON] } : {}),
        }, binding.id);
      });
    });
  }
}
