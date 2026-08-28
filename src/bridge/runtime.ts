import { DesktopIpcClient } from "../desktop/ipc-client.js";
import { projectSnapshot, type ProjectionCheckpoint } from "../desktop/projector.js";
import { TaskSubscription } from "../desktop/subscription.js";
import type { BridgeChat, BridgeInput, ChatMembershipChange, OwnerAccess } from "./contracts.js";
import { AccessGate, DeliveryWorker } from "./delivery.js";
import { TaskManager } from "./manager.js";
import { TaskMirror } from "./mirror.js";
import { BridgeStore } from "./store.js";
import { sameTask, type DesktopTasks } from "../desktop/contracts.js";
import { taskDetails } from "../desktop/details.js";

export class DesktopBridgeRuntime {
  private readonly gate: AccessGate;
  private readonly delivery: DeliveryWorker;
  private readonly manager: TaskManager;
  private readonly mirror: TaskMirror;
  private readonly subscriptions = new Map<string, TaskSubscription>();
  private readonly retryAfter = new Map<string, number>();
  private readonly membershipCheckAfter = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly access: OwnerAccess, private readonly desktop: DesktopTasks, chat: BridgeChat, private readonly store: BridgeStore,
    private readonly client = new DesktopIpcClient(), private readonly now: () => number = Date.now) {
    store.assertOwner(access.ownerId, access.groupId);
    this.gate = new AccessGate(access, chat, store);
    this.delivery = new DeliveryWorker(chat, store, this.gate);
    this.manager = new TaskManager(access, desktop, chat, store, this.gate);
    this.mirror = new TaskMirror(store);
  }

  start(): void {
    if (this.timer || this.stopped) throw new Error("Bridge runtime can only be started once");
    this.store.recover();
    this.timer = setInterval(() => {
      // A slow/offline task must not hold up delivery from other subscriptions.
      void this.delivery.flush().catch(() => {});
      void this.tick().catch(() => {});
    }, 1_000);
  }

  async handle(input: BridgeInput): Promise<void> {
    if (this.stopped) return;
    await this.manager.handle(input);
    this.closeInactiveSubscriptions();
    if (!this.stopped) await this.delivery.flush();
  }
  async membershipChanged(change: ChatMembershipChange): Promise<void> {
    if (this.stopped) return;
    await this.gate.membershipChanged(change);
    this.closeInactiveSubscriptions();
    if (!this.stopped) await this.delivery.flush();
  }

  private closeSubscription(bindingId: string): void {
    this.subscriptions.get(bindingId)?.close();
    this.subscriptions.delete(bindingId);
    this.retryAfter.delete(bindingId);
    this.membershipCheckAfter.delete(bindingId);
    this.manager.panels.disconnected(bindingId);
  }

  private closeInactiveSubscriptions(): void {
    for (const id of this.subscriptions.keys()) {
      const binding = this.store.getBinding(id);
      if (!binding?.attached || binding.paused || binding.peerId === null) this.closeSubscription(id);
    }
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.update().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async update(): Promise<void> {
    if (this.stopped) return;
    this.closeInactiveSubscriptions();
    await this.manager.panels.tick();
    for (const binding of this.store.bindings()) {
      const existing = this.subscriptions.get(binding.id);
      if (!binding.attached || binding.paused || binding.peerId === null) {
        this.closeSubscription(binding.id); continue;
      }
      if (!existing && this.now() < (this.retryAfter.get(binding.id) ?? 0)) continue;
      // Long Poll events can be missed while the bridge is offline, including in idle tasks.
      if (!existing || this.now() >= (this.membershipCheckAfter.get(binding.id) ?? 0)) {
        if (!await this.gate.check(binding.peerId)) { this.closeSubscription(binding.id); continue; }
        this.membershipCheckAfter.set(binding.id, this.now() + 30_000);
      }
      if (existing) continue;
      const task = (await this.desktop.listTasks()).find(task => sameTask(task, binding));
      const current = this.store.getBinding(binding.id);
      if (this.stopped || !current?.attached || current.paused) { this.closeSubscription(binding.id); continue; }
      if (!task) {
        this.retryAfter.set(binding.id, this.now() + 30_000);
        this.manager.panels.disconnected(binding.id);
        continue;
      }
      this.store.ensureBinding(task);
      const checkpointKey = `projection:${binding.id}`;
      const subscription = new TaskSubscription(this.client, task, state => {
        const current = this.store.getBinding(binding.id);
        if (!current?.attached || current.paused) return;
        this.store.atomic(() => {
          const projected = projectSnapshot(state, this.store.getValue<ProjectionCheckpoint>(checkpointKey));
          for (const event of projected.events) this.mirror.accept(binding.id, event);
          this.store.setValue(checkpointKey, projected.checkpoint);
          this.manager.panels.observe(binding.id, taskDetails(state));
        });
      }, () => {
        this.manager.panels.disconnected(binding.id);
        this.subscriptions.delete(binding.id);
        const current = this.store.getBinding(binding.id);
        if (this.stopped || !current?.attached || current.paused) return;
        this.retryAfter.set(binding.id, this.now() + 5_000);
        this.store.enqueue(`disconnected:${binding.id}`, this.access.ownerId, { text: "Связь с одной из задач Codex прервалась. Подключение будет повторено; команды автоматически не повторяются." });
      });
      this.subscriptions.set(binding.id, subscription);
      try { await subscription.start(); }
      catch {
        this.manager.panels.disconnected(binding.id);
        subscription.close(); this.subscriptions.delete(binding.id);
        const current = this.store.getBinding(binding.id);
        if (this.stopped || !current?.attached || current.paused) continue;
        this.retryAfter.set(binding.id, this.now() + 5_000);
        this.store.enqueue(`unavailable:${binding.id}`, this.access.ownerId, {
          text: `Не удалось подключиться к задаче «${binding.title.slice(0, 200)}». Открой её в десктопе Codex. Подключение будет повторено; новая задача вместо неё не создаётся.`,
        });
      }
      if (this.stopped) { subscription.close(); this.subscriptions.delete(binding.id); return; }
      this.closeInactiveSubscriptions();
    }
    await this.delivery.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
    this.client.close();
    await this.ticking?.catch(() => {});
    await this.manager.idle();
    await this.delivery.idle();
  }
}
