import type { TaskEvent } from "../desktop/contracts.js";
import { chunkText } from "../lib/text.js";
import { BridgeStore } from "./store.js";
import { MENU_BUTTON } from "./contracts.js";
import type { CommentaryTarget } from "./activity.js";

const USER_REQUEST_PREFIX = "## user request\n\n";
const MENU_FOOTER = "\n\nМеню задачи:";

export class TaskMirror {
  constructor(private readonly store: BridgeStore, private readonly chunkSize = 3_500) {
    if (!Number.isInteger(chunkSize) || chunkSize <= USER_REQUEST_PREFIX.length) {
      throw new RangeError("Mirror chunk size must leave room for the user request label and text");
    }
  }

  accept(bindingId: string, event: TaskEvent): void {
    if (event.type === "status") return;
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
        const targetKey = `latest-commentary:${binding.id}`;
        const target = this.store.getValue<CommentaryTarget>(targetKey);
        const generation = this.store.streamGeneration(binding.id);
        const order = this.store.deliveryOrder(`${key}:0`);
        if (chunks.length && (!target || target.generation !== generation || order >= target.order)) {
          this.store.setValue(targetKey, { itemKey: key, key: `${key}:${chunks.length - 1}`, turnId: event.turnId, generation, order } satisfies CommentaryTarget);
        } else if (!chunks.length && target?.itemKey === key) this.store.setValue(targetKey, null);
        this.store.setValue(key, chunks.length);
        return;
      }
      if (!this.store.rememberEvent(binding.id, event.id)) return;
      if (event.type === "user" && event.operationId && this.store.isOwnOperation(event.operationId, binding)) return;
      const prefix = event.type === "user" ? USER_REQUEST_PREFIX : "";
      const footer = event.type === "final" ? MENU_FOOTER : "";
      // Reserve room for the footer so it cannot become a separate VK message.
      const chunks = chunkText(event.text, this.chunkSize - prefix.length - footer.length);
      chunks.forEach((chunk, index) => {
        this.store.enqueue(`event:${binding.id}:${event.id}:${index}`, peerId, {
          text: `${prefix}${chunk}${index === chunks.length - 1 ? footer : ""}`,
          ...(event.type === "final" && index === chunks.length - 1 ? { buttons: [MENU_BUTTON] } : {}),
        }, binding.id);
      });
    });
  }
}
