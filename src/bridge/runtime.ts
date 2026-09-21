import { TaskStateConnections, type TaskStateConnectionFailure, type TaskStateTransport } from "../core/task-state.js";
import type { TaskHistoryRecovery } from "../core/task-history.js";
import type { TaskObservationCheckpoint, TaskStateObserver } from "../core/task-observation.js";
import type { Binding, BridgeChat, BridgeInput, OwnerAccess } from "./contracts.js";
import { AccessGate, DeliveryWorker } from "./delivery.js";
import { TaskManager } from "./manager.js";
import { TaskMirror } from "./mirror.js";
import { BridgeStore } from "./store.js";
import { ActionRejectedError, DesktopUnavailableError, TaskNotOpenError, sameTask, taskKey, type CodexTasks, type TaskCreationUpdate, type TaskDetails } from "../core/codex-tasks.js";
import { TaskActivity } from "./activity.js";
import { TaskFiles, type InboundFileLimits } from "./files.js";
import { BridgeHealthMonitor, type RuntimeHealthState } from "./health.js";
import type { BridgeHealthSnapshot } from "./contracts.js";
import { MENU_BUTTON } from "./contracts.js";
import { taskFailureText } from "./panels.js";
import { systemLoadText } from "./system-load.js";
import { archiveRestartIntent, readRestartIntent, type RestartTaskSnapshot } from "../desktop/restart-intent.js";

export interface BridgeRuntimeAdapters {
  readonly states: TaskStateTransport;
  readonly observe: TaskStateObserver;
  readonly history: TaskHistoryRecovery;
}

export class BridgeRuntime {
  private readonly gate: AccessGate;
  private readonly delivery: DeliveryWorker;
  private readonly manager: TaskManager;
  private readonly mirror: TaskMirror;
  private readonly activity: TaskActivity;
  private readonly files: TaskFiles | undefined;
  private readonly health: BridgeHealthMonitor;
  private readonly connections: TaskStateConnections;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private unsubscribeCreation: (() => void) | null = null;
  private readonly startedAt: number;
  private lastTickAt: number;
  private updateStartedAt: number | null = null;
  private lastHealthAt = 0;
  private operationReconciliation: Promise<void> | null = null;
  private lastOperationReconciliationAt = 0;
  /** Tasks released after a terminal turn stay detached until VK needs them. */
  private readonly releasedIdle = new Set<string>();
  /** A new VK request asks the next update to acquire that task again. */
  private readonly demanded = new Set<string>();
  /** Keeps a just-reacquired task leased until TaskManager has dispatched the VK input. */
  private readonly pendingReacquire = new Set<string>();

  private streamMode(bindingId: string): "attached" | "detached" | null {
    return this.store.getValue<"attached" | "detached">(`task-stream-mode:${bindingId}`);
  }

  private setStreamMode(bindingId: string, mode: "attached" | "detached"): void {
    this.store.setValue(`task-stream-mode:${bindingId}`, mode);
  }

  private recordLease(bindingId: string, mode: "attached" | "detached", activeTurnId: string | null = null): void {
    const key = `task-lease:${bindingId}`;
    const previous = this.store.getValue<{ leaseSince?: number | null }>(key);
    const at = this.now();
    this.store.setValue(key, {
      owner: mode === "attached" ? "vkodex" : "external",
      mode,
      leaseSince: mode === "attached" ? (typeof previous?.leaseSince === "number" ? previous.leaseSince : at) : null,
      lastEventAt: at,
      activeTurnId,
      generation: this.store.streamGeneration(bindingId),
    });
  }

  private readonly observeTaskState: TaskStateObserver;
  private readonly historyRecovery: TaskHistoryRecovery;

  constructor(private readonly access: OwnerAccess, private readonly desktop: CodexTasks, chat: BridgeChat, private readonly store: BridgeStore,
    adapters: BridgeRuntimeAdapters, private readonly now: () => number = Date.now, fileRoot?: string,
    healthFile?: string, private readonly healthIntervalMs = 60_000,
    private readonly healthCheckOverride?: (force: boolean) => Promise<BridgeHealthSnapshot>, projectlessRoot?: string,
    inboundFileLimits?: InboundFileLimits) {
    store.assertOwner(access.ownerId, access.groupId);
    this.startedAt = now(); this.lastTickAt = this.startedAt;
    this.connections = new TaskStateConnections(adapters.states, now);
    this.observeTaskState = adapters.observe;
    this.historyRecovery = adapters.history;
    this.gate = new AccessGate(access, store);
    this.files = fileRoot ? new TaskFiles(fileRoot, store, chat, this.gate, inboundFileLimits) : undefined;
    this.delivery = new DeliveryWorker(chat, store, this.gate, undefined, now);
    this.health = new BridgeHealthMonitor(access, desktop, chat, store, () => this.runtimeHealth(), healthFile, now);
    this.manager = new TaskManager(access, desktop, chat, store, this.gate, this.files, () => this.checkHealth(true), () => systemLoadText(fileRoot), projectlessRoot,
      binding => this.releaseForExternalClient(binding));
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
    this.manager.recoverInputs();
    this.lastHealthAt = this.now();
    this.timer = setInterval(() => {
      this.lastTickAt = this.now();
      try { this.activity.tick(); } catch { /* Retry next tick without interrupting delivery. */ }
      // A slow/offline task must not hold up delivery from other subscriptions.
      void this.delivery.flush().catch(() => {});
      void this.files?.tick().catch(() => {});
      try { this.manager.replaySavedInputs(); } catch { /* Health reports a broken journal. */ }
      this.reconcileUncertainOperation();
      void this.tick().catch(() => {});
    }, 1_000);
    // Establish subscriptions before the first report so a healthy restart does
    // not look degraded merely because its first one-second tick has not run.
    void this.tick().then(() => this.checkHealth(true), () => this.checkHealth(true)).catch(() => {});
  }

  private runtimeHealth(): RuntimeHealthState {
    const active = this.store.bindings().filter(binding => binding.attached && binding.peerId !== null);
    const isConnected = (binding: Binding): boolean => !!this.desktop.isCreationActive?.(binding) || this.connections.connected(binding.id);
    const connected = active.filter(isConnected).length;
    const required = active.filter(binding => ["running", "approval"].includes(this.store.getValue<TaskDetails>(`task-details:${binding.id}`)?.status ?? ""));
    const bindings = active.map(binding => {
      const details = this.store.getValue<TaskDetails>(`task-details:${binding.id}`);
      const streamMode: "attached" | "detached" | "unknown" = this.streamMode(binding.id) ?? (isConnected(binding) ? "attached" : "unknown");
      const lease = this.store.getValue<{ lastEventAt?: number | null; leaseSince?: number | null }>(`task-lease:${binding.id}`);
      return { id: binding.id, title: binding.title, source: binding.sourceLabel || binding.sourceId || ".codex",
        status: details?.status ?? "unavailable", connected: isConnected(binding),
        lastConfirmedAt: this.connections.lastVerifiedAt(binding.id), failure: details?.failure ?? null,
        streamMode, lastEventAt: lease?.lastEventAt ?? null, leaseSince: lease?.leaseSince ?? null };
    });
    return { startedAt: this.startedAt, lastTickAt: this.lastTickAt, updateStartedAt: this.updateStartedAt, stopped: this.stopped,
      activeBindings: active.length, connectedBindings: connected, requiredBindings: required.length, connectedRequiredBindings: required.filter(isConnected).length,
      failedBindings: bindings.filter(binding => binding.failure !== null).length, bindings };
  }

  private checkHealth(force = false): Promise<BridgeHealthSnapshot> {
    this.lastHealthAt = this.now();
    return this.healthCheckOverride?.(force) ?? this.health.check(force);
  }

  private reconcileUncertainOperation(): void {
    if (this.stopped || !this.desktop.findAcceptedInput || this.operationReconciliation
      || this.now() - this.lastOperationReconciliationAt < 30_000) return;
    this.lastOperationReconciliationAt = this.now();
    const operation = this.store.uncertainPromptOperations(this.now(), 1)[0];
    if (!operation) return;
    this.store.markOperationChecked(operation.id, this.now());
    const binding = this.store.getBinding(operation.bindingId);
    if (!binding || !binding.attached || binding.peerId === null || taskKey(binding) !== operation.taskKey) return;
    const work = this.desktop.findAcceptedInput(binding, operation.id).then(turnId => {
      if (!turnId || this.stopped) return;
      const current = this.store.getBinding(binding.id);
      if (!current?.attached || current.peerId !== binding.peerId || taskKey(current) !== operation.taskKey
        || this.store.operationState(operation.id) !== "uncertain") return;
      this.store.atomic(() => {
        this.store.settlePromptDispatch(operation.id, "accepted");
        this.store.rememberAcceptedTurn(binding.id, turnId, operation.id);
        this.files?.finish(binding.id, operation.id, "accepted", turnId);
        this.store.enqueue(`reconciled-operation:${operation.id}`, current.peerId!, {
          text: "Codex подтвердил ранее неопределённый запрос. Повторно отправлять его не нужно.", silent: true,
        }, binding.id);
      });
    }).catch(() => {}).finally(() => { if (this.operationReconciliation === work) this.operationReconciliation = null; });
    this.operationReconciliation = work;
  }

  async handle(input: BridgeInput): Promise<void> {
    if (this.stopped) return;
    const binding = this.store.byPeer(input.peerId);
    const taskInput = binding?.attached && binding.peerId !== null && !input.action;
    if (taskInput) {
      this.releasedIdle.delete(binding.id);
      this.demanded.add(binding.id);
      this.pendingReacquire.add(binding.id);
      // Acquire the task stream before the manager can call turn/start. A
      // resume after turn/start may abort that active turn in Codex, so this
      // ordering is deliberately awaited for an idle, detached task.
      await this.tick();
    }
    try {
      await this.manager.handle(input);
    } finally {
      if (taskInput) this.pendingReacquire.delete(binding.id);
    }
    if (taskInput) {
      const details = this.store.getValue<TaskDetails>(`task-details:${binding.id}`);
      if (details && ["idle", "failed", "interrupted"].includes(details.status) && !this.hasPendingTaskWork(binding.id)) {
        // A known rejection did not create work. Unknown/sending operations
        // remain in hasPendingTaskWork and keep the lease for reconciliation.
        this.demanded.delete(binding.id);
        await this.tick();
      }
    }
    this.closeInactiveSubscriptions();
    if (!this.stopped) await this.delivery.flush();
  }

  /**
   * Replays only the synthetic, durable recovery inputs captured before a
   * controlled bridge restart. Existing VK inbox state remains the authority:
   * calling this again after a crash cannot submit the same recovery turn twice.
   */
  async recoverRestartIntent(dataDir: string): Promise<void> {
    const intent = await readRestartIntent(dataDir);
    if (!intent || this.stopped) return;
    // Refresh the durable task snapshot before deciding whether a turn truly
    // needs continuation; the value in SQLite is the pre-restart state.
    await this.tick();
    const pending: RestartTaskSnapshot[] = [];
    for (const snapshot of intent.tasks) {
      const binding = this.store.getBinding(snapshot.bindingId);
      if (!binding || !binding.attached || binding.peerId === null || !sameTask(binding, snapshot)
        || this.store.streamGeneration(binding.id) !== snapshot.generation) continue;
      const eventId = `restart-recovery:${intent.id}:${binding.id}`;
      const inputKey = JSON.stringify([binding.peerId, eventId]);
      if (this.store.inputSettled(inputKey)) continue;
      let details: TaskDetails | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { details = await this.desktop.inspectTask(binding); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 1_000)); }
      }
      if (!details) { pending.push(snapshot); continue; }
      // A task that survived the process restart, or still has a question,
      // must not receive a second synthetic turn.
      if (details.status === "running" || details.status === "approval") continue;
      await this.handle({ eventId, peerId: binding.peerId, senderId: this.access.ownerId,
        text: "Продолжи работу, прерванную техническим перезапуском VKodex. Проверь текущее состояние задачи и файлов, не повторяй уже завершённые действия и продолжи с ближайшего незавершённого шага." });
      this.store.enqueue(`restart-recovery-note:${intent.id}:${binding.id}`, binding.peerId, {
        text: "VKodex восстановил эту задачу после контролируемого перезапуска и отправил один запрос на продолжение.", silent: true,
      }, binding.id);
    }
    if (pending.length) throw new Error(`Restart recovery is waiting for ${pending.length} Codex task owner(s)`);
    await archiveRestartIntent(dataDir, intent);
  }
  private closeSubscription(bindingId: string): void {
    this.connections.close(bindingId);
    this.manager.panels.disconnected(bindingId);
    this.activity.disconnected(bindingId);
    this.files?.observe(bindingId, "unavailable");
  }

  private enableRolloutFallback(binding: Binding, since = this.now()): void {
    if (!binding.rolloutPath) return;
    this.historyRecovery.enable(binding.id, since);
  }

  private disableRolloutFallback(binding: Binding): void {
    this.historyRecovery.disable(binding.id, binding);
    if (this.store.getValue(`rollout-failure:${binding.id}`) !== null) this.store.setValue(`rollout-failure:${binding.id}`, null);
  }

  /**
   * A rare renderer failure leaves owner discovery alive while it stops
   * publishing thread-stream snapshots. The rollout is append-only and keeps
   * stable visible assistant message IDs until Codex rebuilds the branch.
   */
  private async mirrorRolloutFallback(binding: Binding): Promise<void> {
    if (!binding.attached || binding.peerId === null) return;
    const checkpoint = this.store.getValue<TaskObservationCheckpoint>(`projection:${binding.id}`);
    // A rewritten Codex branch may assign new item IDs to answers already
    // delivered from the old rollout. Without an owner snapshot there is no
    // authoritative way to distinguish those from new direct-app turns.
    // Recover only turns whose VK submission was durably accepted; wait for the
    // live stream to reconcile the rest of the rebuilt history.
    const result = await this.historyRecovery.poll(binding.id, binding, checkpoint,
      this.store.oldestAcceptedTurnAt(binding.id), new Set(this.store.acceptedTurns(binding.id).map(turn => turn.turnId)), this.now());
    if (!result) return;
    if (result.failure) {
      this.store.setValue(`rollout-failure:${binding.id}`, { at: this.now(), kind: result.failure });
      return;
    }
    const events = result.events;
    if (result.historyRebuilt) {
        const previous = this.store.getValue<{ at: number; kind: string }>(`rollout-failure:${binding.id}`);
        if (previous?.kind !== "historyRebuilt") this.store.setValue(`rollout-failure:${binding.id}`, { at: this.now(), kind: "historyRebuilt" });
    }
    else if (this.store.getValue(`rollout-failure:${binding.id}`) !== null) this.store.setValue(`rollout-failure:${binding.id}`, null);
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

  private subscriptionFailed(bindingId: string, failure: TaskStateConnectionFailure): void {
    const binding = this.store.getBinding(bindingId);
    this.manager.panels.disconnected(bindingId);
    this.activity.disconnected(bindingId);
    this.files?.observe(bindingId, "unavailable");
    if (this.stopped || !binding?.attached || !sameTask(binding, failure.task)) return;
    this.enableRolloutFallback(binding, failure.lastVerifiedAt ?? this.now());
    this.manager.panels.disconnected(bindingId, failure.error instanceof TaskNotOpenError);
    this.connections.postpone(bindingId, 5_000);
    const reason = failure.error instanceof DesktopUnavailableError ? failure.error.message : "Подключение к десктопу Codex недоступно.";
    this.store.enqueue(`disconnected:${bindingId}`, this.access.ownerId, { text: `Связь с задачей «${binding.title.slice(0, 200)}» прервалась. ${reason} Подключение будет повторено; команды автоматически не повторяются.` });
  }

  private closeInactiveSubscriptions(): void {
    for (const id of this.connections.ids()) {
      const binding = this.store.getBinding(id);
      if (!binding?.attached || binding.peerId === null) { this.closeSubscription(id); if (binding) this.disableRolloutFallback(binding); }
    }
  }

  private releaseIdleSubscription(binding: Binding): void {
    if (this.store.getBinding(binding.id)?.attached !== true) return;
    // Releasing the Codex writer is a normal handoff, not a loss of
    // observability. Keep tailing the append-only rollout while Desktop/VS
    // Code owns the task so direct turns still reach VK without reacquiring a
    // competing stream lease.
    this.enableRolloutFallback(binding, this.now());
    this.demanded.delete(binding.id);
    this.pendingReacquire.delete(binding.id);
    this.releasedIdle.add(binding.id);
    this.setStreamMode(binding.id, "detached");
    this.recordLease(binding.id, "detached");
    // This is a normal handoff, not a connection failure. Keep the projected
    // task status and VK controls intact while releasing the Codex writer.
    this.connections.close(binding.id);
  }

  private async releaseForExternalClient(binding: Binding): Promise<void> {
    const details = this.store.getValue<TaskDetails>(`task-details:${binding.id}`);
    if (details && (details.status === "running" || details.status === "approval") || this.hasPendingTaskWork(binding.id)) {
      throw new ActionRejectedError("Задача ещё выполняется, ожидает ответа или сверки результата. Дождись завершения либо используй /stop; управление не передано приложению Codex.");
    }
    if (this.hasPendingCriticalDelivery(binding.id)) {
      throw new ActionRejectedError("Финальный ответ задачи ещё отправляется в VK. Повтори /open после завершения доставки.");
    }
    this.demanded.delete(binding.id);
    this.pendingReacquire.delete(binding.id);
    this.releasedIdle.add(binding.id);
    // The explicit /open handoff follows the same read-only observation path
    // as an idle release. Do not leave the VK projection blind while the
    // external client is working.
    this.enableRolloutFallback(binding, this.now());
    this.setStreamMode(binding.id, "detached");
    this.recordLease(binding.id, "detached");
    this.connections.close(binding.id);
    await new Promise(resolve => setImmediate(resolve));
  }

  private hasPendingTaskWork(bindingId: string): boolean {
    return this.store.acceptedTurns(bindingId).length > 0 || this.store.queuedInputs(bindingId).length > 0
      || this.store.unresolvedPromptOperations(bindingId).length > 0;
  }

  private hasPendingCriticalDelivery(bindingId: string): boolean {
    return this.store.pendingDeliveries().some(delivery => delivery.bindingId === bindingId
      && (delivery.kind === "send" || delivery.kind === "panel"));
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
    await Promise.allSettled(this.store.bindings().map(binding => {
      // Detached ownership is persisted across a bridge restart. Rehydrate
      // the read-only rollout observer before polling, otherwise direct
      // Desktop/VS Code turns become invisible until VK explicitly reopens
      // the task and reacquires its writer lease.
      if (binding.attached && binding.peerId !== null && this.streamMode(binding.id) === "detached") {
        const checkpoint = this.store.getValue<TaskObservationCheckpoint>(`projection:${binding.id}`);
        this.enableRolloutFallback(binding, checkpoint?.lastObservedAt ?? checkpoint?.since ?? this.now());
      }
      return this.mirrorRolloutFallback(binding);
    }));
    await this.manager.panels.tick();
    // Re-reading every profile catalog for each conversation made a full
    // reconnect proportional to the number of bindings. During a renderer
    // outage, serial five-second subscription attempts could hold one update
    // for minutes and make the health report itself stale.
    let listedTasks: Awaited<ReturnType<CodexTasks["listTasks"]>> | null = null;
    const starting = new Set<Promise<void>>();
    for (const listed of this.store.bindings()) {
      let binding = listed;
      let existing = this.connections.has(binding.id);
      if (existing && !this.connections.matches(binding.id, binding)) {
        this.closeSubscription(binding.id); existing = false;
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
      // A final answer is persisted before delivery is attempted. Once the
      // critical VK queue drains, release a still-open stream on the next
      // tick; this also covers the case where the answer was queued while the
      // first terminal snapshot was being handled.
      if (this.connections.has(binding.id)) {
        const details = this.store.getValue<TaskDetails>(`task-details:${binding.id}`);
        if (details && ["idle", "failed", "interrupted"].includes(details.status)
          && !this.demanded.has(binding.id) && !this.hasPendingTaskWork(binding.id) && !this.hasPendingCriticalDelivery(binding.id)) {
          this.releaseIdleSubscription(binding);
        }
      }
      this.flushCreation(binding);
      if (this.desktop.isCreationActive?.(binding)) {
        if (existing) this.closeSubscription(binding.id);
        try {
          const details = await this.desktop.inspectTask(binding);
          this.manager.panels.observe(binding.id, details);
          this.files?.observe(binding.id, details.status);
        } catch { /* The creation owner may have handed off between both checks. */ }
        continue;
      }
      const storedDetails = this.store.getValue<TaskDetails>(`task-details:${binding.id}`);
      const terminal = !storedDetails || ["idle", "failed", "interrupted", "unavailable"].includes(storedDetails.status);
      if (!existing && (this.releasedIdle.has(binding.id) || this.streamMode(binding.id) === "detached") && !this.demanded.has(binding.id)
        && terminal && !this.hasPendingTaskWork(binding.id)) continue;
      if (!existing && !this.connections.canAttempt(binding.id)) continue;
      if (existing) { this.connections.maintain(binding.id); continue; }
      listedTasks ??= await this.desktop.listTasks();
      const task = listedTasks.find(task => sameTask(task, binding));
      const current = this.store.getBinding(binding.id);
      if (this.stopped || !current?.attached) { this.closeSubscription(binding.id); continue; }
      if (!task) {
        this.connections.postpone(binding.id, 30_000);
        this.manager.panels.disconnected(binding.id, true);
        this.activity.disconnected(binding.id);
        this.files?.observe(binding.id, "unavailable");
        continue;
      }
      this.store.ensureBinding(task);
      const checkpointKey = `projection:${binding.id}`;
      const start = (async () => {
        const connectStartedAt = this.now();
        try {
          await this.connections.connect(binding.id, task, (state, initial) => {
            const current = this.store.getBinding(binding.id);
            if (!this.connections.matches(binding.id, task) || !current?.attached || !sameTask(current, task)) return;
            this.store.atomic(() => {
              this.disableRolloutFallback(current);
              this.store.markDesktopHandoff(binding.id, task, "live", this.now());
              // Native queued submissions acquire a turn later, including while the bridge is offline.
              const pendingFiles = this.files?.pendingQueuedOperations(binding.id);
              const pendingQueue = new Set(this.store.queuedInputs(binding.id).map(item => item.operationId));
              const editable = this.store.editableRequest(binding.id);
              if (editable?.turnId) this.files?.associateTurn(binding.id, editable.operationId, editable.turnId);
              const recoverFinalTurnIds = new Set(this.store.acceptedTurns(binding.id).map(turn => turn.turnId));
              if (editable?.turnId) recoverFinalTurnIds.add(editable.turnId);
              const reconnectingOnDemand = this.demanded.has(binding.id) || this.releasedIdle.has(binding.id);
              const observation = this.observeTaskState(state, this.store.getValue<TaskObservationCheckpoint>(checkpointKey), this.now(), {
                // A task released after a completed turn must reconcile direct
                // Desktop/VS Code changes made while VKodex was detached.
                rebaseline: initial && !reconnectingOnDemand,
                recoverFinalTurnIds: [...recoverFinalTurnIds],
                finalRecorded: eventId => this.store.hasEvent(binding.id, eventId),
              });
              if (pendingFiles?.size || pendingQueue.size) for (const input of observation.inputs) {
                for (const operationId of input.operationIds) {
                  if (pendingFiles?.has(operationId)) {
                    this.files?.associateTurn(binding.id, operationId, input.turnId);
                    if (["completed", "failed", "interrupted"].includes(input.status)) this.files?.observe(binding.id, "idle", input.turnId);
                  }
                  if (pendingQueue.has(operationId)) {
                    this.store.settleQueuedInput(binding.id, operationId);
                    this.store.rememberAcceptedTurn(binding.id, input.turnId, operationId);
                  }
                }
              }
              for (const event of observation.events) {
                this.mirror.accept(binding.id, event);
                if (event.type === "final") {
                  this.store.settleAcceptedTurn(binding.id, event.turnId);
                  this.files?.observe(binding.id, "idle", event.turnId);
                } else if (event.type === "status") {
                  this.files?.observe(binding.id, event.status === "running" ? "running" : event.status === "completed" ? "idle" : event.status, event.turnId);
                  if (event.status !== "running") this.store.settleAcceptedTurn(binding.id, event.turnId);
                }
              }
              this.store.setValue(checkpointKey, observation.checkpoint);
              const details = observation.details;
              this.manager.questions.observeQuestions(current, observation.questions);
              this.manager.panels.observe(binding.id, details);
              const failure = taskFailureText(details.failure);
              if (failure) {
                this.store.enqueue(`task-failure:${binding.id}:${observation.latestTurnId}`, current.peerId!, { text: failure, buttons: [MENU_BUTTON] }, binding.id);
              }
              this.files?.observe(binding.id, details.status);
              this.activity.observe(binding.id, details.status, observation.activeTurnId);
              this.recordLease(binding.id, "attached", observation.activeTurnId);
              if (details.status === "running" || details.status === "approval") {
                this.releasedIdle.delete(binding.id);
                this.setStreamMode(binding.id, "attached");
              }
              if (details.status !== "running" && details.status !== "approval" && !this.pendingReacquire.has(binding.id)) {
                this.demanded.delete(binding.id);
              }
            });
            const latest = this.store.getValue<TaskDetails>(`task-details:${binding.id}`);
            if (latest && ["idle", "failed", "interrupted"].includes(latest.status)
              && !this.demanded.has(binding.id) && !this.hasPendingTaskWork(binding.id) && !this.hasPendingCriticalDelivery(binding.id)) {
              this.releaseIdleSubscription(binding);
            }
          }, failure => this.subscriptionFailed(binding.id, failure));
          if (this.stopped || !this.connections.matches(binding.id, task)) return;
          this.store.markDesktopHandoff(binding.id, task, "live", this.now());
        } catch (error) {
          if (this.connections.has(binding.id)) this.closeSubscription(binding.id);
          this.manager.panels.disconnected(binding.id, error instanceof TaskNotOpenError);
          const current = this.store.getBinding(binding.id);
          if (this.stopped || !current?.attached) return;
          this.enableRolloutFallback(current, connectStartedAt);
          this.activity.disconnected(binding.id);
          this.files?.observe(binding.id, "unavailable");
          this.connections.postpone(binding.id, 5_000);
          // A configured launcher may still be bringing the owner online. Keep
          // probing without filling the manager conversation with expected retries.
          if (error instanceof TaskNotOpenError) return;
          const reason = error instanceof DesktopUnavailableError ? error.message : "Не удалось получить состояние Codex.";
          this.store.enqueue(`unavailable:${binding.id}`, this.access.ownerId, {
            text: `Не удалось подключиться к задаче «${binding.title.slice(0, 200)}». ${reason} Подключение будет повторено; новая задача вместо неё не создаётся.`,
          });
        }
      })();
      starting.add(start);
      void start.finally(() => starting.delete(start));
      // Limit concurrent native subscriptions without serializing unrelated
      // conversations behind an unavailable client.
      if (starting.size >= 6) await Promise.race(starting);
      if (this.stopped) break;
      this.closeInactiveSubscriptions();
    }
    await Promise.all(starting);
    // VK writes have their own serialized worker and may take many seconds.
    // Keep task reconciliation independent from that queue; the one-second
    // timer also flushes it, and stop() waits for its in-flight operation.
    void this.delivery.flush().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const transfersStopped = this.manager.panels.transfers.stop();
    this.activity.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Deliver buffered incoming text before closing its native connection.
    await this.manager.idle();
    await this.operationReconciliation?.catch(() => {});
    await this.connections.stop();
    this.unsubscribeCreation?.(); this.unsubscribeCreation = null;
    await this.ticking?.catch(() => {});
    await this.manager.idle();
    await transfersStopped;
    await this.files?.stop();
    await this.delivery.idle();
  }
}

/** @deprecated Use the transport-neutral BridgeRuntime name. */
export { BridgeRuntime as DesktopBridgeRuntime };
