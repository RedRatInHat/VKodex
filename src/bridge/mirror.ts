import type { TaskEvent } from "../desktop/contracts.js";
import { chunkText } from "../lib/text.js";
import { BridgeStore } from "./store.js";

const USER_REQUEST_PREFIX = "## user request\n\n";

export class TaskMirror {
  constructor(private readonly store: BridgeStore, private readonly chunkSize = 3_500) {
    if (!Number.isInteger(chunkSize) || chunkSize <= USER_REQUEST_PREFIX.length) {
      throw new RangeError("Mirror chunk size must leave room for the user request label and text");
    }
  }

  accept(bindingId: string, event: TaskEvent): void {
    if (event.type === "status") return;
    const binding = this.store.getBinding(bindingId);
    if (!binding?.attached || binding.paused || binding.peerId === null) return;
    const peerId = binding.peerId;
    this.store.atomic(() => {
      if (event.type === "progress") {
        const key = `commentary:${binding.id}:${event.turnId}:${event.id}`;
        const chunks = chunkText(event.text, this.chunkSize);
        const previousCount = this.store.getValue<number>(key) ?? 0;
        chunks.forEach((text, index) => this.store.enqueue(`${key}:${index}`, peerId, { text, silent: true }, binding.id, true));
        for (let index = chunks.length; index < previousCount; index++) this.store.withdrawCommentary(`${key}:${index}`);
        this.store.setValue(key, chunks.length);
        return;
      }
      if (!this.store.rememberEvent(binding.id, event.id)) return;
      if (event.type === "user" && event.operationId && this.store.isOwnOperation(event.operationId, binding)) return;
      const prefix = event.type === "user" ? USER_REQUEST_PREFIX : "";
      chunkText(event.text, this.chunkSize - prefix.length).forEach((chunk, index) => {
        this.store.enqueue(`event:${binding.id}:${event.id}:${index}`, peerId, { text: `${prefix}${chunk}` }, binding.id);
      });
    });
  }
}
