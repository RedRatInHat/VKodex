import type { BridgeInput } from "./contracts.js";
import type { BridgeStore, SavedInputBatch } from "./store.js";
import { randomUUID } from "node:crypto";

interface Pending {
  id: string;
  parts: BridgeInput[];
  timer: ReturnType<typeof setTimeout>;
  started: number;
  updated: number;
  resolve: (() => void)[];
  reject: ((error: unknown) => void)[];
}

type BatchStore = Pick<BridgeStore, "saveInputBatch" | "inputBatches" | "removeInputBatch" | "inputState">;

function mergedInput(parts: readonly BridgeInput[]): BridgeInput {
  const first = parts[0]!;
  return parts.length === 1 ? first : { ...first,
    eventId: `merged:${parts.map(part => part.eventId).join(",")}`,
    mergedEventIds: parts.map(part => part.eventId), text: parts.map(part => part.text).join("\n"),
  };
}

/** VK does not provide a split-message ID. Collect a short burst after a long part. */
export class InputBatcher {
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly send: (input: BridgeInput) => Promise<void>, private readonly eligible: (input: BridgeInput) => boolean,
    private readonly delayMs = 1500, private readonly threshold = 3000, private readonly store?: BatchStore) {}

  /** Call after BridgeStore.recover, before accepting new VK events. */
  restore(): void {
    if (!this.store) return;
    for (const saved of this.store.inputBatches()) {
      if (this.pending.has(saved.peerId)) continue;
      const state = this.store.inputState(JSON.stringify([saved.peerId, mergedInput(saved.parts).eventId]));
      const partStates = saved.parts.map(part => this.store!.inputState(JSON.stringify([saved.peerId, part.eventId])));
      // A dispatched batch that may have reached Codex must not be replayed.
      // A collecting batch is also unsafe to resend if a part was processed elsewhere.
      if (["processing", "sending", "done", "uncertain"].includes(state ?? "")
        || partStates.some(value => ["processing", "sending", "done", "uncertain"].includes(value ?? ""))) {
        this.store.removeInputBatch(saved.peerId, saved.id);
        continue;
      }
      const batch: Pending = { id: saved.id, parts: [...saved.parts], timer: setTimeout(() => {}, 0),
        started: saved.startedAt, updated: saved.updatedAt, resolve: [], reject: [] };
      this.pending.set(saved.peerId, batch);
      clearTimeout(batch.timer);
      const delay = saved.state === "dispatching" || Date.now() - saved.startedAt >= 10_000
        ? 0 : Math.max(0, this.delayMs - (Date.now() - saved.updatedAt));
      batch.timer = setTimeout(() => { void this.flush(saved.peerId); }, delay);
    }
  }

  handle(input: BridgeInput): Promise<void> {
    const previous = this.pending.get(input.peerId);
    const plain = this.eligible(input) && !input.action && input.editOfMessageId === undefined && input.replyToMessageId === undefined
      && !input.text.trimStart().startsWith("/") && !!input.text.trim()
      && !input.attachments?.length && !input.hasAttachments && !input.attachmentError;
    if (previous && plain && previous.parts[0]!.senderId === input.senderId
      && Date.now() - previous.started < 10_000
      && previous.parts.reduce((n, p) => n + p.text.length + 1, 0) + input.text.length <= 64_000) {
      return this.append(previous, input);
    }
    // Dispatch the preceding text before a command, attachment or another author.
    if (previous) void this.flush(input.peerId);
    if (!plain || input.text.length < this.threshold) return this.send(input);
    const batch: Pending = { id: randomUUID(), parts: [], timer: setTimeout(() => {}, 0),
      started: Date.now(), updated: Date.now(), resolve: [], reject: [] };
    this.pending.set(input.peerId, batch);
    return this.append(batch, input);
  }

  private append(batch: Pending, input: BridgeInput): Promise<void> {
    if (!batch.parts.some(p => p.eventId === input.eventId)) batch.parts.push(input);
    batch.updated = Date.now();
    this.store?.saveInputBatch({ id: batch.id, peerId: input.peerId, parts: batch.parts, startedAt: batch.started,
      updatedAt: batch.updated, state: "collecting" } satisfies SavedInputBatch);
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => { void this.flush(input.peerId); }, this.delayMs);
    return new Promise((resolve, reject) => { batch.resolve.push(resolve); batch.reject.push(reject); });
  }

  async flush(peerId: number): Promise<void> {
    const batch = this.pending.get(peerId);
    if (!batch) return;
    this.pending.delete(peerId); clearTimeout(batch.timer);
    const input = mergedInput(batch.parts);
    this.store?.saveInputBatch({ id: batch.id, peerId, parts: batch.parts, startedAt: batch.started,
      updatedAt: batch.updated, state: "dispatching" } satisfies SavedInputBatch);
    try { await this.send(input); this.store?.removeInputBatch(peerId, batch.id); batch.resolve.forEach(resolve => resolve()); }
    catch (error) { batch.reject.forEach(reject => reject(error)); }
  }
  async idle(): Promise<void> { await Promise.all([...this.pending.keys()].map(peer => this.flush(peer))); }
  /** Disarm this process's timers without erasing batches for a successor. */
  abandon(): void { for (const batch of this.pending.values()) clearTimeout(batch.timer); this.pending.clear(); }
}
