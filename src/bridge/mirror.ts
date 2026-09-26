import { createHash } from "node:crypto";
import { taskKey, type TaskEvent } from "../core/codex-tasks.js";
import { comparablePath } from "../core/paths.js";
import { chunkText } from "../lib/text.js";
import { BridgeStore } from "./store.js";
import { MENU_BUTTON, type Binding } from "./contracts.js";

const USER_REQUEST_PREFIX = "## user request\n\n";
const LATE_USER_REQUEST_PREFIX = "Вход этого хода:\n\n";
const MENU_FOOTER = "\n\nМеню задачи:";
export const MIRROR_ORDERING_GRACE_MS = 2_000;
interface MirrorEpoch { taskKey: string; generation: number; rolloutPath?: string; }
interface DeferredMirror extends MirrorEpoch { firstSeenAt: number; events: TaskEvent[]; }
interface ReadyMirror extends MirrorEpoch { withoutInput: boolean; }

export class TaskMirror {
  constructor(private readonly store: BridgeStore, private readonly chunkSize = 3_500, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(chunkSize) || chunkSize <= Math.max(USER_REQUEST_PREFIX.length, LATE_USER_REQUEST_PREFIX.length)) {
      throw new RangeError("Mirror chunk size must leave room for the user request label and text");
    }
  }

  /** Reorder near-simultaneous input/output only. An input, goal, or recognized
   * initiation source is never required to publish visible assistant progress. */
  acceptObservation(bindingId: string, events: readonly TaskEvent[], inputTurnIds: readonly string[], activeTurnIds: readonly string[] = []): void {
    const binding = this.store.getBinding(bindingId);
    if (!binding?.attached || binding.peerId === null) return;
    // Upgrade legacy held events only after fresh evidence of this active turn.
    for (const turnId of activeTurnIds) {
      const pending = this.store.getValue<DeferredMirror | TaskEvent[]>(this.deferredKey(bindingId, turnId));
      if (Array.isArray(pending) && pending.length) this.store.setValue(this.deferredKey(bindingId, turnId),
        { ...this.epoch(binding), firstSeenAt: this.now(), events: pending } satisfies DeferredMirror);
    }
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
      const terminal = group.some(event => event.type === "final" || event.type === "status"
        && ["completed", "failed", "interrupted"].includes(event.status));
      if (terminal) {
        this.store.setValue(`mirror-terminal:${bindingId}:${turnId}`, this.epoch(binding));
        this.store.setValue(this.deferredKey(bindingId, turnId), null);
      }
      if (knownInputs.has(turnId)) this.markReady(binding, turnId, false);
      const ready = knownInputs.has(turnId) || this.ready(binding, turnId) !== null || terminal;
      if (ready) this.flushDeferred(bindingId, turnId);
      for (const event of group) {
        if (event.type === "user") continue;
        if (event.type === "progress" && this.matches(binding, this.store.getValue(`mirror-terminal:${bindingId}:${turnId}`))) continue;
        if ((event.type === "progress" || event.type === "final") && !ready) {
          this.defer(bindingId, event);
        } else this.accept(bindingId, event);
      }
    }
    // A baseline input may become visible with no new event in this snapshot.
    for (const turnId of inputTurnIds) if (!byTurn.has(turnId)) {
      this.markReady(binding, turnId, false);
      this.flushDeferred(bindingId, turnId);
    }
  }

  /** Runs on the delivery timer even if a task stream or owner lookup stalls. */
  tick(): void {
    this.store.atomic(() => {
      for (const { bindingId, turnId } of this.store.deferredMirrors()) {
        const binding = this.store.getBinding(bindingId);
        const key = this.deferredKey(bindingId, turnId);
        const pending = this.store.getValue<DeferredMirror | TaskEvent[]>(key);
        if (!binding?.attached || binding.peerId === null) { this.store.setValue(key, null); continue; }
        if (this.store.getValue<{ quietTurnIds?: readonly string[] }>(`projection:${bindingId}`)?.quietTurnIds?.includes(turnId)) {
          this.store.setValue(key, null); continue;
        }
        if (!pending || Array.isArray(pending)) continue;
        if (!this.matches(binding, pending) || this.matches(binding, this.store.getValue(`mirror-terminal:${bindingId}:${turnId}`))) {
          this.store.setValue(key, null); continue;
        }
        if (this.now() - pending.firstSeenAt < MIRROR_ORDERING_GRACE_MS) continue;
        this.markReady(binding, turnId, true);
        this.flushDeferred(bindingId, turnId);
      }
    });
  }

  private epoch(binding: Binding): MirrorEpoch {
    return { taskKey: taskKey(binding), generation: this.store.streamGeneration(binding.id),
      ...(binding.rolloutPath ? { rolloutPath: comparablePath(binding.rolloutPath) } : {}) };
  }

  private matches(binding: Binding, epoch: MirrorEpoch | null): boolean {
    return !!epoch && epoch.taskKey === taskKey(binding) && epoch.generation === this.store.streamGeneration(binding.id)
      && (epoch.rolloutPath ? comparablePath(epoch.rolloutPath) : undefined)
        === (binding.rolloutPath ? comparablePath(binding.rolloutPath) : undefined);
  }

  private ready(binding: Binding, turnId: string): ReadyMirror | null {
    const ready = this.store.getValue<ReadyMirror>(`mirror-ready:${binding.id}:${turnId}`);
    return this.matches(binding, ready) ? ready : null;
  }

  private markReady(binding: Binding, turnId: string, withoutInput: boolean): void {
    if (this.ready(binding, turnId)?.withoutInput === withoutInput) return;
    this.store.setValue(`mirror-ready:${binding.id}:${turnId}`, { ...this.epoch(binding), withoutInput } satisfies ReadyMirror);
  }

  private deferredKey(bindingId: string, turnId: string): string {
    return `deferred-mirror:${bindingId}:${turnId}`;
  }

  private defer(bindingId: string, event: Extract<TaskEvent, { type: "progress" | "final" }>): void {
    const key = this.deferredKey(bindingId, event.turnId);
    const binding = this.store.getBinding(bindingId)!;
    const saved = this.store.getValue<DeferredMirror | TaskEvent[]>(key);
    const batch: DeferredMirror = saved && !Array.isArray(saved) && this.matches(binding, saved) ? saved
      : { ...this.epoch(binding), firstSeenAt: this.now(), events: Array.isArray(saved) ? saved : [] };
    const pending = batch.events;
    const index = pending.findIndex(item => item.type === event.type && item.id === event.id);
    if (index >= 0) pending[index] = event;
    else pending.push(event);
    // An unbounded commentary stream must not grow the SQLite value forever.
    while (pending.length > 128) {
      const oldestProgress = pending.findIndex(item => item.type === "progress");
      if (oldestProgress < 0) break;
      pending.splice(oldestProgress, 1);
    }
    this.store.setValue(key, batch);
  }

  private flushDeferred(bindingId: string, turnId: string): void {
    const key = this.deferredKey(bindingId, turnId);
    const binding = this.store.getBinding(bindingId);
    const saved = this.store.getValue<DeferredMirror | TaskEvent[]>(key);
    const pending = Array.isArray(saved) ? saved : binding && this.matches(binding, saved) ? saved!.events : [];
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
      if (event.type === "final") {
        const normalize = (text: string): string => text.replace(/\r\n?/gu, "\n").trimEnd();
        const content = normalize(event.text);
        const digest = createHash("sha256").update(content).digest("hex");
        const semanticId = `final-content:${event.turnId}:${digest}`;
        if (!this.store.rememberEvent(binding.id, semanticId)) return;
        // Existing installations have finals in the delivery journal but no
        // semantic marker yet. A later owner snapshot can give that same final
        // a new item ID, especially after the idle stream is reacquired.
        if (this.store.finalDeliveries(binding.id, event.turnId)
          .some(({ text, menu }) => normalize(menu && text.endsWith(MENU_FOOTER) ? text.slice(0, -MENU_FOOTER.length) : text) === content)) return;
      }
      if (event.type === "user" && event.operationId && this.store.isOwnOperation(event.operationId, binding)) return;
      if (event.type === "user" && this.store.consumeExpectedEditedUser(binding.id, event.text)) return;
      // A direct app input recovered from the rollout may later appear with a
      // different item ID in the owner's projected stream. This is scoped to
      // the verified turn; ordinary repeated user text is left untouched.
      if (event.type === "user") {
        const proof = this.store.getValue<{ taskKey: string; rolloutPath?: string; generation: number;
          userId: string; digest: string }>(`native-input-confirmation:${binding.id}:${event.turnId}`);
        if (proof?.taskKey === taskKey(binding) && proof.rolloutPath === binding.rolloutPath
          && proof.generation === this.store.streamGeneration(binding.id) && proof.userId !== event.id
          && proof.digest === createHash("sha256").update(event.text.replace(/\r\n?/gu, "\n").trimEnd()).digest("hex")) return;
      }
      const prefix = event.type === "user" ? this.ready(binding, event.turnId)?.withoutInput
        ? LATE_USER_REQUEST_PREFIX : USER_REQUEST_PREFIX : "";
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
