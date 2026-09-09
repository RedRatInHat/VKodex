import { DesktopIpcClient } from "../desktop/ipc-client.js";
import { activeTurnsFromState, projectSnapshot, turnsFromState, type ProjectionCheckpoint } from "../desktop/projector.js";
import { TaskSubscription } from "../desktop/subscription.js";
import { RolloutTailer } from "../desktop/rollout-tailer.js";
import type { Binding, BridgeChat, BridgeInput, OwnerAccess } from "./contracts.js";
import { AccessGate, DeliveryWorker } from "./delivery.js";
import { TaskManager } from "./manager.js";
import { TaskMirror } from "./mirror.js";
import { BridgeStore } from "./store.js";
import { DesktopUnavailableError, TaskNotOpenError, sameTask, taskKey, type DesktopTasks, type TaskCreationUpdate, type TaskDetails } from "../desktop/contracts.js";
import { taskDetails } from "../desktop/details.js";
import { TaskActivity } from "./activity.js";
import { TaskFiles, type InboundFileLimits } from "./files.js";
import { BridgeHealthMonitor, type RuntimeHealthState } from "./health.js";
import type { BridgeHealthSnapshot } from "./contracts.js";
import { MENU_BUTTON } from "./contracts.js";
import { taskFailureText } from "./panels.js";
import { systemLoadText } from "./system-load.js";

export class DesktopBridgeRuntime {
  private readonly gate: AccessGate;
  private readonly delivery: DeliveryWorker;
  private readonly manager: TaskManager;
  private readonly mirror: TaskMirror;
  private readonly activity: TaskActivity;
  private readonly files: TaskFiles | undefined;
  private readonly health: BridgeHealthMonitor;
  private readonly subscriptions = new Map<string, TaskSubscription>();
  private readonly subscriptionTasks = new Map<string, string>();
  private readonly readySubscriptions = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly ownerVerifiedAt = new Map<string, number>();
  private readonly ownerChecks = new Map<string, Promise<void>>();
  /** Tasks whose desktop owner exists but does not emit stream snapshots. */
  private readonly rolloutFallback = new Set<string>();
  private readonly rolloutPollAfter = new Map<string, number>();
  private readonly rollout = new RolloutTailer();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private unsubscribeCreation: (() => void) | null = null;
  private readonly startedAt: number;
  private lastTickAt: number;
  private updateStartedAt: number | null = null;
  private lastHealthAt = 0;

  constructor(private readonly access: OwnerAccess, private readonly desktop: DesktopTasks, chat: BridgeChat, private readonly store: BridgeStore,
    private readonly client = new DesktopIpcClient(), private readonly now: () => number = Date.now, fileRoot?: string,
    healthFile?: string, private readonly healthIntervalMs = 60_000,
    private readonly healthCheckOverride?: (force: boolean) => Promise<BridgeHealthSnapshot>, projectlessRoot?: string,
    inboundFileLimits?: InboundFileLimits) {
    store.assertOwner(access.ownerId, access.groupId);
    this.startedAt = now(); this.lastTickAt = this.startedAt;
    this.gate = new AccessGate(access, store);
    this.files = fileRoot ? new TaskFiles(fileRoot, store, chat, this.gate, inboundFileLimits) : undefined;
    this.delivery = new DeliveryWorker(chat, store, this.gate, undefined, now);
    this.health = new BridgeHealthMonitor(access, desktop, chat, store, () => this.runtimeHealth(), healthFile, now);
    this.manager = new TaskManager(access, desktop, chat, store, this.gate, this.files, () => this.checkHealth(true), () => systemLoadText(fileRoot), projectlessRoot);
    this.mirror = new TaskMirror(store);
    this.activity = new TaskActivity(store, now);
    this.unsubscribeCreation = desktop.onCreationUpdate?.(update => this.acceptCreation(update)) ?? null;
  }

  private acceptCreation(update: TaskCreationUpdate): void {
    const binding = this.store.bindings().find(candidate => sameTask(candidate, update.task));
    if (!binding?.attached || binding.peerId === null) {
      // New-task creation starts before the VK conversation necessarily exists.
      // Keep those first-turn events in SQLite so a bridge restart cannot lose
      // the final answer before the conversation is attached.
      this.store.appendPendingCreation(update);
      return;
    }
    this.store.atomic(() => {
      this.mirror.accept(binding.id, update.event);
      this.manager.panels.observe(binding.id, update.details);
      if (update.event.type === "final") this.files?.observe(binding.id, "idle", update.event.turnId);
      else if (update.event.type === "status") this.files?.observe(binding.id, update.details.status, update.event.turnId);
      else this.files?.observe(binding.id, update.details.status);
      this.activity.observe(binding.id, update.details.status, update.details.status === "running" ? update.event.turnId : null);
    });
  }

  private flushCreation(binding: Binding): void {
    const queued = this.store.pendingCreation(binding);
    if (!queued.length) return;
    for (const update of queued) this.acceptCreation(update);
    // Clear only after all events have been projected. If the process dies
    // earlier, their stable event IDs make replay harmless on the next start.
    this.store.clearPendingCreation(binding);
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

  private runtimeHealth(): RuntimeHealthState {
    const active = this.store.bindings().filter(binding => binding.attached && binding.peerId !== null);
    const isConnected = (binding: Binding): boolean => !!this.desktop.isCreationActive?.(binding)
      || (this.readySubscriptions.has(binding.id) && this.now() - (this.ownerVerifiedAt.get(binding.id) ?? 0) <= 45_000);
    const connected = active.filter(isConnected).length;
    const required = active.filter(binding => ["running", "approval"].includes(this.store.getValue<TaskDetails>(`task-details:${binding.id}`)?.status ?? ""));
    return { startedAt: this.startedAt, lastTickAt: this.lastTickAt, updateStartedAt: this.updateStartedAt, stopped: this.stopped,
      activeBindings: active.length, connectedBindings: connected, requiredBindings: required.length, connectedRequiredBindings: required.filter(isConnected).length,
      failedBindings: active.filter(binding => this.store.getValue<TaskDetails>(`task-details:${binding.id}`)?.failure !== undefined).length };
  }

  private checkHealth(force = false): Promise<BridgeHealthSnapshot> {
    this.lastHealthAt = this.now();
    return this.healthCheckOverride?.(force) ?? this.health.check(force);
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
    this.subscriptionTasks.delete(bindingId);
    this.readySubscriptions.delete(bindingId);
    this.ownerVerifiedAt.delete(bindingId);
    this.retryAfter.delete(bindingId);
    this.manager.panels.disconnected(bindingId);
    this.activity.disconnected(bindingId);
    this.files?.observe(bindingId, "unavailable");
  }

  private enableRolloutFallback(binding: Binding): void {
    if (!binding.rolloutPath) return;
    this.rolloutFallback.add(binding.id);
    this.rolloutPollAfter.delete(binding.id);
  }

  private disableRolloutFallback(binding: Binding): void {
    this.rolloutFallback.delete(binding.id);
    this.rolloutPollAfter.delete(binding.id);
    this.rollout.clear(binding);
  }

  /**
   * A rare renderer failure leaves owner discovery alive while it stops
   * publishing thread-stream snapshots. The rollout is append-only and keeps
   * the same visible assistant message IDs, so it is a safe recovery source.
   */
  private async mirrorRolloutFallback(binding: Binding): Promise<void> {
    if (!this.rolloutFallback.has(binding.id) || !binding.attached || binding.peerId === null) return;
    if (this.now() < (this.rolloutPollAfter.get(binding.id) ?? 0)) return;
    this.rolloutPollAfter.set(binding.id, this.now() + 1_000);
    const checkpoint = this.store.getValue<ProjectionCheckpoint>(`projection:${binding.id}`);
    const events = await this.rollout.poll(binding, checkpoint?.since ?? this.now());
    if (!events.length || this.stopped || !this.store.getBinding(binding.id)?.attached) return;
    this.store.atomic(() => {
      for (const event of events) {
        this.mirror.accept(binding.id, event);
        if (event.type === "final") {
          this.store.settleAcceptedTurn(binding.id, event.turnId);
          this.files?.observe(binding.id, "idle", event.turnId);
        } else if (event.type === "status") {
          this.files?.observe(binding.id, event.status === "running" ? "running" : "idle", event.turnId);
          this.activity.observe(binding.id, event.status === "running" ? "running" : "idle", event.status === "running" ? event.turnId : null);
        }
      }
    });
  }

  private subscriptionFailed(bindingId: string, subscription: TaskSubscription, error: Error): void {
    if (this.subscriptions.get(bindingId) !== subscription) return;
    const binding = this.store.getBinding(bindingId);
    this.closeSubscription(bindingId);
    if (this.stopped || !binding?.attached || !sameTask(binding, subscription.task)) return;
    this.enableRolloutFallback(binding);
    this.manager.panels.disconnected(bindingId, error instanceof TaskNotOpenError);
    this.retryAfter.set(bindingId, this.now() + 5_000);
    const reason = error instanceof DesktopUnavailableError ? error.message : "Подключение к десктопу Codex недоступно.";
    this.store.enqueue(`disconnected:${bindingId}`, this.access.ownerId, { text: `Связь с задачей «${binding.title.slice(0, 200)}» прервалась. ${reason} Подключение будет повторено; команды автоматически не повторяются.` });
  }

  private verifySubscription(bindingId: string, subscription: TaskSubscription): void {
    if (this.ownerChecks.has(bindingId) || this.now() - (this.ownerVerifiedAt.get(bindingId) ?? 0) < 30_000) return;
    // Independent bounded reads: an unresponsive owner must not delay other
    // subscriptions, VK messages or the activity timer.
    const check = subscription.verifyOwner().then(() => {
      if (this.subscriptions.get(bindingId) === subscription) this.ownerVerifiedAt.set(bindingId, this.now());
    }, error => this.subscriptionFailed(bindingId, subscription, error)).finally(() => {
      if (this.ownerChecks.get(bindingId) === check) this.ownerChecks.delete(bindingId);
    });
    this.ownerChecks.set(bindingId, check);
  }

  private closeInactiveSubscriptions(): void {
    for (const id of this.subscriptions.keys()) {
      const binding = this.store.getBinding(id);
      if (!binding?.attached || binding.peerId === null) { this.closeSubscription(id); if (binding) this.disableRolloutFallback(binding); }
    }
  }

  tick(): Promise<void> {
    // Health must keep running while a previous update waits for an unavailable
    // client. Otherwise its stale pre-restart report can mask that very stall.
    if (!this.stopped && this.now() - this.lastHealthAt >= this.healthIntervalMs) void this.checkHealth().catch(() => {});
    if (this.ticking) return this.ticking;
    this.updateStartedAt = this.now();
    this.ticking = this.update().finally(() => { this.ticking = null; this.updateStartedAt = null; });
    return this.ticking;
  }

  private async update(): Promise<void> {
    if (this.stopped) return;
    this.manager.panels.transfers.tick();
    this.closeInactiveSubscriptions();
    this.activity.tick();
    await Promise.allSettled(this.store.bindings().map(binding => this.mirrorRolloutFallback(binding)));
    await this.manager.panels.tick();
    for (const listed of this.store.bindings()) {
      let binding = listed;
      let existing = this.subscriptions.get(binding.id);
      if (existing && this.subscriptionTasks.get(binding.id) !== taskKey(binding)) {
        this.closeSubscription(binding.id); existing = undefined;
      }
      if (!binding.attached || binding.peerId === null) {
        this.closeSubscription(binding.id); this.disableRolloutFallback(binding); continue;
      }
      if (binding.paused) {
        // Clear privacy pauses left by versions that treated conversation
        // membership as an authorization boundary.
        this.store.setPaused(binding.id, false);
        binding = this.store.getBinding(binding.id)!;
      }
      this.flushCreation(binding);
      if (this.desktop.isCreationActive?.(binding)) {
        if (existing) {
          existing.close(); this.subscriptions.delete(binding.id); this.subscriptionTasks.delete(binding.id); this.readySubscriptions.delete(binding.id); this.retryAfter.delete(binding.id);
        }
        try {
          const details = await this.desktop.inspectTask(binding);
          this.manager.panels.observe(binding.id, details);
          this.files?.observe(binding.id, details.status);
        } catch { /* The creation owner may have handed off between both checks. */ }
        continue;
      }
      if (!existing && this.now() < (this.retryAfter.get(binding.id) ?? 0)) continue;
      if (existing) { this.verifySubscription(binding.id, existing); continue; }
      const task = (await this.desktop.listTasks()).find(task => sameTask(task, binding));
      const current = this.store.getBinding(binding.id);
      if (this.stopped || !current?.attached) { this.closeSubscription(binding.id); continue; }
      if (!task) {
        this.retryAfter.set(binding.id, this.now() + 30_000);
        this.manager.panels.disconnected(binding.id, true);
        this.activity.disconnected(binding.id);
        this.files?.observe(binding.id, "unavailable");
        continue;
      }
      this.store.ensureBinding(task);
      const checkpointKey = `projection:${binding.id}`;
      const subscription = new TaskSubscription(this.client, task, (state, initial) => {
        const current = this.store.getBinding(binding.id);
        if (this.subscriptions.get(binding.id) !== subscription || !current?.attached || !sameTask(current, task)) return;
        this.store.atomic(() => {
          this.readySubscriptions.add(binding.id);
          this.disableRolloutFallback(current);
          this.store.markDesktopHandoff(binding.id, task, "live", this.now());
          const editable = this.store.editableRequest(binding.id);
          if (editable?.turnId) this.files?.associateTurn(binding.id, editable.operationId, editable.turnId);
          const recoverFinalTurnIds = new Set(this.store.acceptedTurns(binding.id).map(turn => turn.turnId));
          if (editable?.turnId) recoverFinalTurnIds.add(editable.turnId);
          const projected = projectSnapshot(state, this.store.getValue<ProjectionCheckpoint>(checkpointKey), this.now(), {
            rebaseline: initial,
            recoverFinalTurnIds: [...recoverFinalTurnIds],
            finalRecorded: eventId => this.store.hasEvent(binding.id, eventId),
          });
          for (const event of projected.events) {
            this.mirror.accept(binding.id, event);
            if (event.type === "final") {
              this.store.settleAcceptedTurn(binding.id, event.turnId);
              this.files?.observe(binding.id, "idle", event.turnId);
            } else if (event.type === "status") {
              this.files?.observe(binding.id, event.status === "running" ? "running" : event.status === "completed" ? "idle" : event.status, event.turnId);
              if (event.status !== "running") this.store.settleAcceptedTurn(binding.id, event.turnId);
            }
          }
          this.store.setValue(checkpointKey, projected.checkpoint);
          const details = taskDetails(state);
          this.manager.panels.observe(binding.id, details);
          const failure = taskFailureText(details.failure);
          if (failure) {
            const turnId = String(turnsFromState(state).at(-1)?.turnId ?? "runtime");
            this.store.enqueue(`task-failure:${binding.id}:${turnId}`, current.peerId!, { text: failure, buttons: [MENU_BUTTON] }, binding.id);
          }
          this.files?.observe(binding.id, details.status);
          const activeTurn = activeTurnsFromState(state).at(-1);
          this.activity.observe(binding.id, details.status, typeof activeTurn?.turnId === "string" ? activeTurn.turnId : null);
        });
      }, error => this.subscriptionFailed(binding.id, subscription, error));
      this.subscriptions.set(binding.id, subscription);
      this.subscriptionTasks.set(binding.id, taskKey(task));
      try {
        await subscription.start();
        this.readySubscriptions.add(binding.id);
        this.ownerVerifiedAt.set(binding.id, this.now());
        this.store.markDesktopHandoff(binding.id, task, "live", this.now());
      }
      catch (error) {
        this.manager.panels.disconnected(binding.id, error instanceof TaskNotOpenError);
        subscription.close(); this.subscriptions.delete(binding.id); this.subscriptionTasks.delete(binding.id); this.readySubscriptions.delete(binding.id);
        const current = this.store.getBinding(binding.id);
        if (this.stopped || !current?.attached) continue;
        this.enableRolloutFallback(current);
        this.activity.disconnected(binding.id);
        this.files?.observe(binding.id, "unavailable");
        this.retryAfter.set(binding.id, this.now() + 5_000);
        // A configured launcher may still be bringing the owner online. Keep
        // probing without filling the manager conversation with expected retries.
        if (error instanceof TaskNotOpenError) continue;
        const reason = error instanceof DesktopUnavailableError ? error.message : "Не удалось получить состояние Codex.";
        this.store.enqueue(`unavailable:${binding.id}`, this.access.ownerId, {
          text: `Не удалось подключиться к задаче «${binding.title.slice(0, 200)}». ${reason} Подключение будет повторено; новая задача вместо неё не создаётся.`,
        });
      }
      if (this.stopped) { subscription.close(); this.subscriptions.delete(binding.id); this.subscriptionTasks.delete(binding.id); this.readySubscriptions.delete(binding.id); return; }
      this.closeInactiveSubscriptions();
    }
    await this.delivery.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const transfersStopped = this.manager.panels.transfers.stop();
    this.activity.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
    this.subscriptionTasks.clear();
    this.readySubscriptions.clear();
    this.ownerVerifiedAt.clear();
    this.client.close();
    await Promise.allSettled(this.ownerChecks.values());
    this.unsubscribeCreation?.(); this.unsubscribeCreation = null;
    await this.ticking?.catch(() => {});
    await this.manager.idle();
    await transfersStopped;
    await this.files?.stop();
    await this.delivery.idle();
  }
}
