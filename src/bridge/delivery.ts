import type { BridgeChat, Delivery, OwnerAccess } from "./contracts.js";
import { ChatRateLimitError } from "./contracts.js";
import { BridgeStore } from "./store.js";

export class AccessGate {
  constructor(private readonly access: OwnerAccess, private readonly store: BridgeStore) {}

  async check(peerId: number, _fresh = false): Promise<boolean> {
    if (peerId === this.access.ownerId) return true;
    if (peerId < 2_000_000_000) return false;
    const binding = this.store.byPeer(peerId);
    return !!binding?.attached;
  }

  async clearLegacyPause(peerId: number, bindingId: string): Promise<boolean> {
    const binding = this.store.getBinding(bindingId);
    if (!binding?.attached || binding.peerId !== peerId) return false;
    if (binding.paused) this.store.setPaused(binding.id, false);
    return true;
  }
}

export class DeliveryWorker {
  private flushing: Promise<void> | null = null;
  private readonly lastCommentaryEdit = new Map<string, number>();
  private readonly retries = new Map<number, { attempts: number; after: number }>();

  constructor(
    private readonly chat: BridgeChat,
    private readonly store: BridgeStore,
    private readonly gate: AccessGate,
    private readonly editIntervalMs = 3_000,
    private readonly now: () => number = Date.now,
  ) {}

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async idle(): Promise<void> { await this.flushing; }

  private active(delivery: Delivery): boolean {
    if (!this.store.isPending(delivery)) return false;
    if (!delivery.bindingId) return true;
    const binding = this.store.getBinding(delivery.bindingId);
    return !!binding?.attached && binding.peerId === delivery.peerId;
  }

  private async deliver(): Promise<void> {
    if (this.now() < (this.store.getValue<number>("vk-delivery-paused-until") ?? 0)) return;
    for (const delivery of this.store.pendingDeliveries()) {
      if (this.now() < (this.retries.get(delivery.id)?.after ?? 0)) continue;
      if (!this.active(delivery)) continue;
      if (delivery.kind !== "send" && delivery.handle && this.now() - (this.lastCommentaryEdit.get(delivery.key) ?? -Infinity) < this.editIntervalMs) continue;
      if (!await this.gate.check(delivery.peerId) || !this.active(delivery)) continue;
      try {
        if (delivery.id > 2_147_483_647) throw new Error("VK random_id range exhausted");
        const firstView = delivery.firstView ?? delivery.view;
        if (!delivery.handle) this.store.sending(delivery);
        const handle = delivery.handle ?? await this.chat.send(delivery.peerId, firstView, delivery.id);
        if (handle.peerId !== delivery.peerId || !Number.isSafeInteger(handle.conversationMessageId) || handle.conversationMessageId <= 0) throw new Error("Invalid message handle");
        this.store.saveHandle(delivery.id, handle);
        if (!this.active(delivery)) continue;
        const view = JSON.stringify(delivery.view);
        const knownView = this.store.getValue<string>(`delivered-view:${delivery.key}`);
        if ((delivery.handle || JSON.stringify(firstView) !== view) && knownView !== view) await this.chat.edit(handle, delivery.view);
        this.store.setValue(`delivered-view:${delivery.key}`, view);
        this.store.delivered(delivery, handle);
        this.store.recordDeliverySuccess(this.now());
        this.retries.delete(delivery.id);
        if (delivery.kind !== "send") this.lastCommentaryEdit.set(delivery.key, this.now());
      } catch (error) {
        if (error instanceof ChatRateLimitError) {
          this.store.recordDeliveryFailure(delivery, "rate_limit", error.retryAfterMs, this.now());
          this.store.setValue("vk-delivery-paused-until", this.now() + error.retryAfterMs);
          return;
        }
        this.store.recordDeliveryFailure(delivery, "transient", undefined, this.now());
        // Keep the same random_id/handle after a timeout. Never turn a failed edit into a new message.
        const attempts = (this.retries.get(delivery.id)?.attempts ?? 0) + 1;
        this.retries.set(delivery.id, { attempts, after: this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)) });
      }
    }
  }
}
