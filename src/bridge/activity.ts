import { randomUUID } from "node:crypto";
import type { TaskDetails } from "../core/codex-tasks.js";
import { BridgeStore } from "./store.js";
import type { View } from "./contracts.js";

const FRAMES = ["думаю...", "думаю..", "думаю."] as const;
const DEFAULT_INTERVAL_MS = 20_000;
const terminal = (status: TaskDetails["status"]): boolean => ["idle", "failed", "interrupted"].includes(status);
const labels: Record<Exclude<TaskDetails["status"], "running">, string> = {
  idle: "Готово.", failed: "Ход завершился с ошибкой.", interrupted: "Ход остановлен.",
  approval: "Нужен ответ в Codex.", unavailable: "Нет связи с Codex.",
};

interface ActivityState {
  key: string;
  generation: number;
  turnId: string | null;
  status: TaskDetails["status"];
  // Kept only to cleanly migrate indicators embedded into commentary by
  // older bridge versions. New indicators are always standalone messages.
  kind?: "commentary";
}

export class TaskActivity {
  private readonly running = new Map<string, { state: ActivityState; frame: number; nextAt: number }>();
  private readonly observed = new Set<string>();

  constructor(
    private readonly store: BridgeStore,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  private frame(text: string): string {
    const updated = new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(this.now()));
    return `${text} · обновлено ${updated}`;
  }

  private render(state: ActivityState, peerId: number, bindingId: string, frame: string): void {
    this.store.enqueue(state.key, peerId, { text: this.frame(frame), silent: true, activityStatus: state.status }, bindingId, "activity", state.turnId);
  }

  private settle(state: ActivityState, peerId: number, bindingId: string, status: TaskDetails["status"], refresh = false): void {
    if (state.kind === "commentary") {
      const base = this.store.getValue<View>(`commentary-base:${state.key}`);
      if (base) this.store.enqueue(state.key, peerId, status === "running" || status === "idle" ? base : { ...base, text: `${base.text}\n\n${labels[status]}` }, bindingId, true);
    } else if (status === "running") {
      this.store.deleteActivity(state.key);
      return;
    } else this.store.settleActivity(state.key, labels[status], refresh, status);
    this.store.prioritizeDelivery(state.key);
  }

  private retire(state: ActivityState): void {
    if (state.kind !== "commentary") this.store.retireActivity(state.key);
  }

  /** Only a scoped live snapshot confirms transport recovery; rollout status
   * observations may continue while that transport remains unavailable. */
  connected(bindingId: string): void {
    const binding = this.store.getBinding(bindingId);
    const key = `connection-notice:${bindingId}`;
    // Adopt a still-open notice from the earlier presentation implementation.
    const previous = this.store.getValue<ActivityState>(key)
      ?? this.store.getValue<ActivityState>(`activity:${bindingId}`);
    if (!binding?.attached || binding.peerId === null || this.store.bindingDisplayMode(bindingId) !== "final-only"
      || previous?.generation !== this.store.streamGeneration(bindingId) || previous.kind === "commentary"
      || previous.status !== "unavailable") return;
    this.store.settleActivity(previous.key, "Связь с задачей Codex восстановлена.", false, "recovered");
    this.store.prioritizeDelivery(previous.key);
    this.store.setValue(key, { ...previous, status: "idle" } satisfies ActivityState);
  }

  observe(bindingId: string, status: TaskDetails["status"], turnId: string | null = null): void {
    const binding = this.store.getBinding(bindingId);
    const valueKey = `activity:${bindingId}`;
    const saved = this.store.getValue<ActivityState>(valueKey);
    const generation = this.store.streamGeneration(bindingId);
    let previous = saved?.generation === generation ? saved : null;
    if (!binding?.attached || binding.peerId === null) {
      this.running.delete(bindingId); this.observed.delete(bindingId);
      if (saved) this.retire(saved);
      return;
    }
    if (this.store.bindingDisplayMode(bindingId) === "final-only") {
      this.running.delete(bindingId); this.observed.delete(bindingId);
      if (status === "running" || status === "idle") {
        if (previous?.status === "unavailable" && previous.kind !== "commentary"
          && this.store.getValue(`connection-notice:${bindingId}`) === null)
          this.store.setValue(`connection-notice:${bindingId}`, previous);
        this.store.setValue(valueKey, null); return;
      }
      if (status === "unavailable") {
        const noticeKey = `connection-notice:${bindingId}`;
        const savedNotice = this.store.getValue<ActivityState>(noticeKey);
        const notice = savedNotice?.generation === generation ? savedNotice
          : previous?.status === "unavailable" && previous.kind !== "commentary" ? previous : null;
        const alert: ActivityState = notice ? { ...notice, status }
          : { key: `activity:${bindingId}:${randomUUID()}`, generation, turnId, status };
        this.store.setValue(noticeKey, alert);
        this.store.enqueue(alert.key, binding.peerId, { text: labels[status], silent: true, activityStatus: status }, bindingId, "activity", alert.turnId);
        this.store.prioritizeDelivery(alert.key);
        return;
      }
      const alert: ActivityState = previous?.kind !== "commentary" && previous?.status === status && previous.turnId === turnId
        ? previous : { key: `activity:${bindingId}:${randomUUID()}`, generation, turnId, status };
      this.store.setValue(valueKey, alert);
      this.store.enqueue(alert.key, binding.peerId, { text: labels[status], silent: true, activityStatus: status }, bindingId, "activity", alert.turnId);
      this.store.prioritizeDelivery(alert.key);
      return;
    }
    if (previous?.kind === "commentary") {
      const base = this.store.getValue<View>(`commentary-base:${previous.key}`);
      if (base) this.store.enqueue(previous.key, binding.peerId, base, binding.id, true);
      previous = null;
    }
    const first = !this.observed.has(bindingId);
    this.observed.add(bindingId);
    if (status !== "running") {
      this.running.delete(bindingId);
      if (previous && (!terminal(previous.status) || previous.status === status)) {
        this.settle(previous, binding.peerId, bindingId, status, first);
        this.store.setValue(valueKey, { ...previous, status });
      }
      return;
    }
    const sameTurn = previous !== null && !terminal(previous.status) && (!turnId || !previous.turnId || turnId === previous.turnId);
    let current: ActivityState = sameTurn
      ? { ...previous!, status, turnId: turnId ?? previous!.turnId }
      : { key: `activity:${bindingId}:${randomUUID()}`, generation, turnId, status };
    const latestMessageId = this.store.latestPeerMessage(binding.peerId);
    const currentMessageId = this.store.deliveryMessageId(current.key);
    const currentOrder = this.store.deliveryOrder(current.key);
    if ((currentMessageId !== null && currentMessageId < latestMessageId)
      || (currentOrder > 0 && currentOrder < this.store.latestPeerDeliveryOrder(binding.peerId))) {
      current = { key: `activity:${bindingId}:${randomUUID()}`, generation, turnId, status };
    }
    if (previous && previous.key !== current.key && !terminal(previous.status)) this.settle(previous, binding.peerId, bindingId, sameTurn ? "running" : "idle");
    if (JSON.stringify(current) !== JSON.stringify(saved)) this.store.setValue(valueKey, current);
    const running = this.running.get(bindingId);
    if (running?.state.key === current.key) {
      running.state = current;
      this.render(current, binding.peerId, bindingId, FRAMES[running.frame]!); return;
    }
    this.running.set(bindingId, { state: current, frame: 0, nextAt: this.now() + this.intervalMs });
    this.render(current, binding.peerId, bindingId, FRAMES[0]);
    this.store.activateActivity(current.key);
  }

  tick(): void {
    for (const [bindingId, activity] of this.running) {
      const binding = this.store.getBinding(bindingId);
      if (!binding?.attached || binding.peerId === null || this.store.streamGeneration(bindingId) !== activity.state.generation) {
        this.running.delete(bindingId); this.retire(activity.state);
        continue;
      }
      if (this.store.bindingDisplayMode(bindingId) === "final-only") {
        this.observe(bindingId, "idle", activity.state.turnId); continue;
      }
      const messageId = this.store.deliveryMessageId(activity.state.key);
      const deliveryOrder = this.store.deliveryOrder(activity.state.key);
      if ((messageId !== null && messageId < this.store.latestPeerMessage(binding.peerId))
        || (deliveryOrder > 0 && deliveryOrder < this.store.latestPeerDeliveryOrder(binding.peerId))) {
        this.observe(bindingId, "running", activity.state.turnId); continue;
      }
      if (this.now() < activity.nextAt) continue;
      activity.frame = (activity.frame + 1) % FRAMES.length;
      activity.nextAt = this.now() + this.intervalMs;
      this.render(activity.state, binding.peerId, bindingId, FRAMES[activity.frame]!);
    }
  }

  disconnected(bindingId: string): void { this.observe(bindingId, "unavailable"); this.observed.delete(bindingId); }

  stop(): void {
    for (const activity of this.running.values()) {
      this.retire(activity.state);
    }
    this.running.clear();
    this.observed.clear();
  }
}
