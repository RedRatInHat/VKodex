import type { BridgeChat, ChatMembershipChange, Delivery, OwnerAccess } from "./contracts.js";
import { BridgeStore } from "./store.js";

export class AccessGate {
  constructor(private readonly access: OwnerAccess, private readonly chat: BridgeChat, private readonly store: BridgeStore) {}

  async check(peerId: number): Promise<boolean> {
    if (peerId === this.access.ownerId) return true;
    if (peerId < 2_000_000_000) return false;
    const binding = this.store.byPeer(peerId);
    if (!binding || !binding.attached || binding.paused) return false;
    if (!await this.verifyMembers(peerId, binding.id)) return false;
    const current = this.store.getBinding(binding.id);
    return !!current?.attached && !current.paused;
  }

  async membershipChanged(change: ChatMembershipChange): Promise<boolean> {
    const binding = this.store.byPeer(change.peerId);
    if (!binding || change.peerId < 2_000_000_000) return false;
    if (change.removedMemberId === this.access.ownerId || change.removedMemberId === -this.access.groupId) {
      this.store.atomic(() => {
        const key = change.eventId ? JSON.stringify([change.peerId, change.eventId]) : null;
        if (key && !this.store.claimInput(key)) return;
        this.stopStreaming(binding.id);
        if (key) this.store.finishInput(key);
      });
      return false;
    }
    return this.check(change.peerId);
  }

  private stopStreaming(bindingId: string): void {
    const binding = this.store.getBinding(bindingId);
    if (!binding) return;
    this.store.atomic(() => {
      this.store.stopStreaming(bindingId);
      if (!binding.attached) return;
      const key = `departure-episode:${bindingId}`;
      const episode = (this.store.getValue<number>(key) ?? 0) + 1;
      this.store.setValue(key, episode);
      this.store.enqueue(`departure:${bindingId}:${episode}`, this.access.ownerId, {
        text: `Трансляция задачи «${binding.title.slice(0, 200)}» отключена: ты или бот больше не участвуете в VK-беседе. Очередь отменена; задача Codex продолжает работать. Для повторного подключения выбери задачу в менеджере.`,
        silent: true,
      });
    });
  }

  async verifyMembers(peerId: number, bindingId: string): Promise<boolean> {
    const generation = this.store.streamGeneration(bindingId);
    const state = await this.inspectMembers(peerId);
    if (generation !== this.store.streamGeneration(bindingId)) return false;
    if (state === "ready") return true;
    if (state === "owner_missing") { this.stopStreaming(bindingId); return false; }
    if (!this.store.getBinding(bindingId)?.attached) return false;
    const previouslyPaused = this.store.getBinding(bindingId)?.paused;
    this.store.setPaused(bindingId, true);
    const episodeKey = `privacy-episode:${bindingId}`;
    const episode = (this.store.getValue<number>(episodeKey) ?? 0) + (previouslyPaused ? 0 : 1);
    this.store.setValue(episodeKey, episode);
    this.store.enqueue(`privacy:${bindingId}:${episode}`, this.access.ownerId, {
      text: "Трансляция задачи приостановлена: не удалось подтвердить, что в беседе только ты и бот. После проверки участников нажми «Возобновить» в менеджере.",
      buttons: [{ label: "Возобновить", action: this.store.action({ type: "resume", bindingId }) }],
    });
    return false;
  }

  async inspectMembers(peerId: number): Promise<"ready" | "owner_missing" | "unsafe"> {
    try {
      const members = await this.chat.members(peerId);
      if (members.length === 1 && members[0] === -this.access.groupId) return "owner_missing";
      const allowed = new Set([this.access.ownerId, -this.access.groupId]);
      return members.length === 2 && new Set(members).size === 2 && members.every(member => allowed.has(member)) ? "ready" : "unsafe";
    } catch { return "unsafe"; }
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
    return !!binding?.attached && !binding.paused && binding.peerId === delivery.peerId;
  }

  private async deliver(): Promise<void> {
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
        if (delivery.handle || JSON.stringify(firstView) !== JSON.stringify(delivery.view)) await this.chat.edit(handle, delivery.view);
        this.store.delivered(delivery, handle);
        this.retries.delete(delivery.id);
        if (delivery.kind !== "send") this.lastCommentaryEdit.set(delivery.key, this.now());
      } catch {
        // Keep the same random_id/handle after a timeout. Never turn a failed edit into a new message.
        const attempts = (this.retries.get(delivery.id)?.attempts ?? 0) + 1;
        this.retries.set(delivery.id, { attempts, after: this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6)) });
      }
    }
  }
}
