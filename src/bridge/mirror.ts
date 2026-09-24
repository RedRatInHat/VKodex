import type { TaskEvent } from "../core/codex-tasks.js";
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

  /** Owner snapshots can publish assistant items before their user item. Keep
   * those items durable until the input is visible, then enqueue in causal order. */
  acceptObservation(bindingId: string, events: readonly TaskEvent[], inputTurnIds: readonly string[]): void {
    const knownInputs = new Set(inputTurnIds);
    const byTurn = new Map<string, TaskEvent[]>();
    for (const event of events) {
      const group = byTurn.get(event.turnId) ?? [];
      group.push(event);
      byTurn.set(event.turnId, group);
      if (event.type === "user") knownInputs.add(event.turnId);
    }
    for (const [turnId, group] of byTurn) {
      for (const event of group) if (event.type === "user") this.accept(bindingId, event);
      // A terminal answer with no visible input can be a system-started turn
      // or a truncated recovery snapshot. Never strand its answer forever.
      const ready = knownInputs.has(turnId) || group.some(event => event.type === "final");
      if (ready) this.flushDeferred(bindingId, turnId);
      for (const event of group) {
        if (event.type === "user") continue;
        if ((event.type === "progress" || event.type === "final") && !ready) {
          this.defer(bindingId, event);
        } else this.accept(bindingId, event);
      }
    }
    // A baseline input may become visible with no new event in this snapshot.
    for (const turnId of inputTurnIds) if (!byTurn.has(turnId)) this.flushDeferred(bindingId, turnId);
  }

  private deferredKey(bindingId: string, turnId: string): string {
    return `deferred-mirror:${bindingId}:${turnId}`;
  }

  private defer(bindingId: string, event: Extract<TaskEvent, { type: "progress" | "final" }>): void {
    const key = this.deferredKey(bindingId, event.turnId);
    const pending = this.store.getValue<TaskEvent[]>(key) ?? [];
    const index = pending.findIndex(item => item.type === event.type && item.id === event.id);
    if (index >= 0) pending[index] = event;
    else pending.push(event);
    // An unbounded commentary stream must not grow the SQLite value forever.
    while (pending.length > 128) {
      const oldestProgress = pending.findIndex(item => item.type === "progress");
      if (oldestProgress < 0) break;
      pending.splice(oldestProgress, 1);
    }
    this.store.setValue(key, pending);
  }

  private flushDeferred(bindingId: string, turnId: string): void {
    const key = this.deferredKey(bindingId, turnId);
    const pending = this.store.getValue<TaskEvent[]>(key) ?? [];
    if (!pending.length) return;
    for (const event of pending) this.accept(bindingId, event);
    this.store.setValue(key, null);
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
          this.store.enqueue(`${key}:${index}`, peerId, view, binding.id, true, event.turnId);
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
      if (event.type === "user" && this.store.consumeExpectedEditedUser(binding.id, event.text)) return;
      const prefix = event.type === "user" ? USER_REQUEST_PREFIX : "";
      const showMenu = event.type === "final" && event.showMenu !== false;
      const footer = showMenu ? MENU_FOOTER : "";
      // Reserve room for the footer so it cannot become a separate VK message.
      const chunks = chunkText(event.text, this.chunkSize - prefix.length - footer.length);
      chunks.forEach((chunk, index) => {
        this.store.enqueue(`event:${binding.id}:${event.id}:${index}`, peerId, {
          text: `${prefix}${chunk}${index === chunks.length - 1 ? footer : ""}`,
          ...(event.type === "user" ? { silent: true } : {}),
          ...(showMenu && index === chunks.length - 1 ? { buttons: [MENU_BUTTON] } : {}),
        }, binding.id, false, event.turnId);
      });
    });
  }
}
