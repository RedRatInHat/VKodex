import { randomUUID } from "node:crypto";
import type { TaskDetails } from "../desktop/contracts.js";
import { BridgeStore } from "./store.js";
import type { View } from "./contracts.js";

const FRAMES = ["думаю...", "думаю..", "думаю."] as const;
const INTERVAL_MS = 6_000;
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
  kind?: "activity" | "commentary";
}

export interface CommentaryTarget { itemKey: string; key: string; turnId: string; generation: number; order: number }

export class TaskActivity {
  private readonly running = new Map<string, { state: ActivityState; frame: number; nextAt: number }>();
  private readonly observed = new Set<string>();

  constructor(private readonly store: BridgeStore, private readonly now: () => number = Date.now) {}

  private render(state: ActivityState, peerId: number, bindingId: string, frame: string): void {
    if (state.kind === "commentary") {
      const base = this.store.getValue<View>(`commentary-base:${state.key}`);
      if (base) this.store.enqueue(state.key, peerId, { ...base, text: `${base.text}\n\n${frame}`, silent: true }, bindingId, true);
    } else this.store.enqueue(state.key, peerId, { text: frame, silent: true }, bindingId, "activity");
  }

  private settle(state: ActivityState, peerId: number, bindingId: string, status: TaskDetails["status"], refresh = false): void {
    if (state.kind === "commentary") {
      const base = this.store.getValue<View>(`commentary-base:${state.key}`);
      if (base) this.store.enqueue(state.key, peerId, status === "running" || status === "idle" ? base : { ...base, text: `${base.text}\n\n${labels[status]}` }, bindingId, true);
    } else this.store.settleActivity(state.key, status === "running" ? "Работа продолжается в сообщениях ниже." : labels[status], refresh);
  }

  private retire(state: ActivityState): void {
    if (state.kind !== "commentary") this.store.retireActivity(state.key);
  }

  observe(bindingId: string, status: TaskDetails["status"], turnId: string | null = null): void {
    const binding = this.store.getBinding(bindingId);
    const valueKey = `activity:${bindingId}`;
    const saved = this.store.getValue<ActivityState>(valueKey);
    const generation = this.store.streamGeneration(bindingId);
    const previous = saved?.generation === generation ? saved : null;
    if (!binding?.attached || binding.peerId === null) {
      this.running.delete(bindingId); this.observed.delete(bindingId);
      if (saved) this.retire(saved);
      return;
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
    const sameTurn = previous && !terminal(previous.status) && (!turnId || !previous.turnId || turnId === previous.turnId);
    let current: ActivityState = sameTurn
      ? { ...previous, status, turnId: turnId ?? previous.turnId }
      : { key: `activity:${bindingId}:${randomUUID()}`, generation, turnId, status };
    const commentary = this.store.getValue<CommentaryTarget>(`latest-commentary:${bindingId}`);
    const latestMessageId = this.store.latestPeerMessage(binding.peerId);
    const commentaryMessageId = commentary ? this.store.deliveryMessageId(commentary.key) : null;
    if (commentary?.generation === generation && commentary.turnId === turnId && (commentaryMessageId === null || commentaryMessageId >= latestMessageId) && this.store.getValue<View>(`commentary-base:${commentary.key}`)) {
      current = { ...current, key: commentary.key, kind: "commentary" };
    } else if (current.kind === "commentary") {
      current = { key: `activity:${bindingId}:${randomUUID()}`, generation, turnId, status };
    }
    const currentMessageId = this.store.deliveryMessageId(current.key);
    if (currentMessageId !== null && currentMessageId < latestMessageId) current = { key: `activity:${bindingId}:${randomUUID()}`, generation, turnId, status };
    if (previous && previous.key !== current.key && !terminal(previous.status)) this.settle(previous, binding.peerId, bindingId, sameTurn ? "running" : "idle");
    if (JSON.stringify(current) !== JSON.stringify(saved)) this.store.setValue(valueKey, current);
    const running = this.running.get(bindingId);
    if (running?.state.key === current.key) {
      running.state = current;
      this.render(current, binding.peerId, bindingId, FRAMES[running.frame]!); return;
    }
    this.running.set(bindingId, { state: current, frame: 0, nextAt: this.now() + INTERVAL_MS });
    this.render(current, binding.peerId, bindingId, FRAMES[0]);
    if (current.kind !== "commentary") this.store.activateActivity(current.key);
  }

  tick(): void {
    for (const [bindingId, activity] of this.running) {
      const binding = this.store.getBinding(bindingId);
      if (!binding?.attached || binding.peerId === null || this.store.streamGeneration(bindingId) !== activity.state.generation) {
        this.running.delete(bindingId); this.retire(activity.state);
        continue;
      }
      const messageId = this.store.deliveryMessageId(activity.state.key);
      if (messageId !== null && messageId < this.store.latestPeerMessage(binding.peerId)) {
        this.observe(bindingId, "running", activity.state.turnId); continue;
      }
      if (this.now() < activity.nextAt) continue;
      activity.frame = (activity.frame + 1) % FRAMES.length;
      activity.nextAt = this.now() + INTERVAL_MS;
      this.render(activity.state, binding.peerId, bindingId, FRAMES[activity.frame]!);
    }
  }

  disconnected(bindingId: string): void { this.observe(bindingId, "unavailable"); this.observed.delete(bindingId); }

  stop(): void {
    for (const [bindingId, activity] of this.running) {
      const binding = this.store.getBinding(bindingId);
      if (activity.state.kind === "commentary" && binding?.attached && binding.peerId !== null) this.settle(activity.state, binding.peerId, bindingId, "idle");
      else this.retire(activity.state);
    }
    this.running.clear();
    this.observed.clear();
  }
}
