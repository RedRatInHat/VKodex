import { DesktopIpcClient } from "../desktop/ipc-client.js";
import { projectSnapshot, turnsFromState, type ProjectionCheckpoint } from "../desktop/projector.js";
import { TaskSubscription } from "../desktop/subscription.js";
import type { Binding, BridgeChat, BridgeInput, OwnerAccess } from "./contracts.js";
import { AccessGate, DeliveryWorker } from "./delivery.js";
import { TaskManager } from "./manager.js";
import { TaskMirror } from "./mirror.js";
import { BridgeStore } from "./store.js";
import { DesktopUnavailableError, sameTask, taskKey, type DesktopTasks, type DirectTaskUpdate, type TaskDetails } from "../desktop/contracts.js";
import { taskDetails } from "../desktop/details.js";
import { TaskActivity } from "./activity.js";
import { TaskFiles } from "./files.js";
import { BridgeHealthMonitor, type RuntimeHealthState } from "./health.js";
import type { BridgeHealthSnapshot } from "./contracts.js";

export class DesktopBridgeRuntime {
  private readonly gate: AccessGate;
  private readonly delivery: DeliveryWorker;
  private readonly manager: TaskManager;
  private readonly mirror: TaskMirror;
  private readonly activity: TaskActivity;
  private readonly files: TaskFiles | undefined;
  private readonly health: BridgeHealthMonitor;
  private readonly subscriptions = new Map<string, TaskSubscription>();
  private readonly readySubscriptions = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private unsubscribeDirect: (() => void) | null = null;
  private readonly pendingDirect = new Map<string, DirectTaskUpdate[]>();
  private readonly startedAt: number;
  private lastTickAt: number;
  private updateStartedAt: number | null = null;
  private lastHealthAt = 0;

  constructor(private readonly access: OwnerAccess, private readonly desktop: DesktopTasks, chat: BridgeChat, private readonly store: BridgeStore,
    private readonly client = new DesktopIpcClient(), private readonly now: () => number = Date.now, fileRoot?: string,
    healthFile?: string, private readonly healthIntervalMs = 60_000) {
    store.assertOwner(access.ownerId, access.groupId);
    this.startedAt = now(); this.lastTickAt = this.startedAt;
    this.gate = new AccessGate(access, store);
    this.files = fileRoot ? new TaskFiles(fileRoot, store, chat, this.gate) : undefined;
    this.delivery = new DeliveryWorker(chat, store, this.gate, undefined, now);
    this.health = new BridgeHealthMonitor(access, desktop, chat, store, () => this.runtimeHealth(), healthFile, now);
    this.manager = new TaskManager(access, desktop, chat, store, this.gate, this.files, () => this.checkHealth(true));
    this.mirror = new TaskMirror(store);
    this.activity = new TaskActivity(store, now);
    this.unsubscribeDirect = desktop.onDirectUpdate?.(update => this.acceptDirect(update)) ?? null;
  }

  start(): void {
    if (this.timer || this.stopped) throw new Error("Bridge runtime can only be started once");
    for (const binding of this.store.bindings()) if (binding.attached && binding.paused) this.store.setPaused(binding.id, false);
    this.store.recover();
    this.lastHealthAt = this.now();
    this.timer = setInterval(() => {
      this.lastTickAt = this.now();
      try { this.activity.tick(); } catch { /* Retry next tick without interrupting delivery. */ }
      // A slow/offline task must not hold up delivery from other subscriptions.
      void this.delivery.flush().catch(() => {});
      void this.files?.tick().catch(() => {});
      void this.tick().catch(() => {});
    }, 1_000);
    // Establish subscriptions before the first report so a healthy restart does
    // not look degraded merely because its first one-second tick has not run.
    void this.tick().then(() => this.checkHealth(true), () => this.checkHealth(true)).catch(() => {});
  }

  private acceptDirect(update: DirectTaskUpdate): void {
    const binding = this.store.bindings().find(candidate => sameTask(candidate, update.task));
    if (!binding?.attached || binding.peerId === null) {
      const key = taskKey(update.task); const queued = this.pendingDirect.get(key) ?? [];
      queued.push(update); this.pendingDirect.set(key, queued.slice(-100)); return;
    }
    this.store.atomic(() => {
      this.mirror.accept(binding.id, update.event);
      this.manager.panels.observe(binding.id, update.details);
      this.files?.observe(binding.id, update.details.status);
      this.activity.observe(binding.id, update.details.status, update.details.status === "running" ? update.event.turnId : null);
    });
  }

  private flushDirect(binding: Binding): void {
    const key = taskKey(binding); const queued = this.pendingDirect.get(key);
    if (!queued) return;
    this.pendingDirect.delete(key);
    for (const update of queued) this.acceptDirect(update);
  }

  private runtimeHealth(): RuntimeHealthState {
    const active = this.store.bindings().filter(binding => binding.attached && binding.peerId !== null);
    const isConnected = (binding: Binding): boolean => !!this.desktop.isDirectlyManaged?.(binding) || this.readySubscriptions.has(binding.id);
    const connected = active.filter(isConnected).length;
    const required = active.filter(binding => ["running", "approval"].includes(this.store.getValue<TaskDetails>(`task-details:${binding.id}`)?.status ?? ""));
    return { startedAt: this.startedAt, lastTickAt: this.lastTickAt, updateStartedAt: this.updateStartedAt, stopped: this.stopped,
      activeBindings: active.length, connectedBindings: connected, requiredBindings: required.length, connectedRequiredBindings: required.filter(isConnected).length };
  }

  private checkHealth(force = false): Promise<BridgeHealthSnapshot> {
    this.lastHealthAt = this.now();
    return this.health.check(force);
  }

  async handle(input: BridgeInput): Promise<void> {
    if (this.stopped) return;
    await this.manager.handle(input);
    this.closeInactiveSubscriptions();
    if (!this.stopped) await this.delivery.flush();
  }
  private closeSubscription(bindingId: string): void {
    this.subscriptions.get(bindingId)?.close();
    this.subscriptions.delete(bindingId);
    this.readySubscriptions.delete(bindingId);
    this.retryAfter.delete(bindingId);
    this.manager.panels.disconnected(bindingId);
    this.activity.disconnected(bindingId);
    this.files?.observe(bindingId, "unavailable");
  }

  private closeInactiveSubscriptions(): void {
    for (const id of this.subscriptions.keys()) {
      const binding = this.store.getBinding(id);
      if (!binding?.attached || binding.peerId === null) this.closeSubscription(id);
    }
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.updateStartedAt = this.now();
    this.ticking = this.update().finally(() => { this.ticking = null; this.updateStartedAt = null; });
    return this.ticking;
  }

  private async update(): Promise<void> {
    if (this.stopped) return;
    this.closeInactiveSubscriptions();
    this.activity.tick();
    if (this.now() - this.lastHealthAt >= this.healthIntervalMs) void this.checkHealth();
    await this.manager.panels.tick();
    for (const listed of this.store.bindings()) {
      let binding = listed;
      const existing = this.subscriptions.get(binding.id);
      if (!binding.attached || binding.peerId === null) {
        this.closeSubscription(binding.id); continue;
      }
      if (binding.paused) {
        // Clear privacy pauses left by versions that treated conversation
        // membership as an authorization boundary.
        this.store.setPaused(binding.id, false);
        binding = this.store.getBinding(binding.id)!;
      }
      if (this.desktop.isDirectlyManaged?.(binding)) {
        if (existing) {
          existing.close(); this.subscriptions.delete(binding.id); this.readySubscriptions.delete(binding.id); this.retryAfter.delete(binding.id);
        }
        this.flushDirect(binding);
        try {
          const details = await this.desktop.inspectTask(binding);
          this.manager.panels.observe(binding.id, details);
          this.files?.observe(binding.id, details.status);
        } catch { /* Direct updates remain authoritative for this local run. */ }
        continue;
      }
      if (!existing && this.now() < (this.retryAfter.get(binding.id) ?? 0)) continue;
      if (existing) continue;
      const task = (await this.desktop.listTasks()).find(task => sameTask(task, binding));
      const current = this.store.getBinding(binding.id);
      if (this.stopped || !current?.attached) { this.closeSubscription(binding.id); continue; }
      if (!task) {
        this.retryAfter.set(binding.id, this.now() + 30_000);
        this.manager.panels.disconnected(binding.id);
        this.activity.disconnected(binding.id);
        this.files?.observe(binding.id, "unavailable");
        continue;
      }
      this.store.ensureBinding(task);
      const checkpointKey = `projection:${binding.id}`;
      const subscription = new TaskSubscription(this.client, task, (state, initial) => {
        const current = this.store.getBinding(binding.id);
        if (!current?.attached) return;
        this.store.atomic(() => {
          this.readySubscriptions.add(binding.id);
          const projected = projectSnapshot(state, this.store.getValue<ProjectionCheckpoint>(checkpointKey), this.now(), { rebaseline: initial });
          for (const event of projected.events) this.mirror.accept(binding.id, event);
          this.store.setValue(checkpointKey, projected.checkpoint);
          const details = taskDetails(state);
          this.manager.panels.observe(binding.id, details);
          this.files?.observe(binding.id, details.status);
          const activeTurn = turnsFromState(state).filter(turn => turn.status === "inProgress").at(-1);
          this.activity.observe(binding.id, details.status, typeof activeTurn?.turnId === "string" ? activeTurn.turnId : null);
        });
      }, error => {
        this.manager.panels.disconnected(binding.id);
        this.subscriptions.delete(binding.id);
        this.readySubscriptions.delete(binding.id);
        const current = this.store.getBinding(binding.id);
        if (this.stopped || !current?.attached) return;
        this.activity.disconnected(binding.id);
        this.files?.observe(binding.id, "unavailable");
        this.retryAfter.set(binding.id, this.now() + 5_000);
        const reason = error instanceof DesktopUnavailableError ? error.message : "Подключение к десктопу Codex недоступно.";
        this.store.enqueue(`disconnected:${binding.id}`, this.access.ownerId, { text: `Связь с задачей «${binding.title.slice(0, 200)}» прервалась. ${reason} Подключение будет повторено; команды автоматически не повторяются.` });
      });
      this.subscriptions.set(binding.id, subscription);
      try { await subscription.start(); this.readySubscriptions.add(binding.id); }
      catch (error) {
        this.manager.panels.disconnected(binding.id);
        subscription.close(); this.subscriptions.delete(binding.id); this.readySubscriptions.delete(binding.id);
        const current = this.store.getBinding(binding.id);
        if (this.stopped || !current?.attached) continue;
        this.activity.disconnected(binding.id);
        this.files?.observe(binding.id, "unavailable");
        this.retryAfter.set(binding.id, this.now() + 5_000);
        const reason = error instanceof DesktopUnavailableError ? error.message : "Не удалось получить состояние Codex.";
        this.store.enqueue(`unavailable:${binding.id}`, this.access.ownerId, {
          text: `Не удалось подключиться к задаче «${binding.title.slice(0, 200)}». ${reason} Подключение будет повторено; новая задача вместо неё не создаётся.`,
        });
      }
      if (this.stopped) { subscription.close(); this.subscriptions.delete(binding.id); this.readySubscriptions.delete(binding.id); return; }
      this.closeInactiveSubscriptions();
    }
    await this.delivery.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.activity.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
    this.readySubscriptions.clear();
    this.client.close();
    this.unsubscribeDirect?.(); this.unsubscribeDirect = null;
    await this.ticking?.catch(() => {});
    await this.manager.idle();
    await this.files?.stop();
    await this.delivery.idle();
  }
}
