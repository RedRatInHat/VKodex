import { ActionRejectedError, DesktopUnavailableError, TaskNotOpenError, TaskOwnedByClientError, taskKey, type TaskRef } from "./codex-tasks.js";

export type TaskState = Record<string, unknown>;
const LAST_ROUTE_FAILURE_FRESH_MS = 5 * 60_000;

/** Route evidence only. It never asserts physical native writer ownership. */
export interface TaskStateRouteDiagnostic {
  readonly kind: "native-observer" | "app-server" | "unknown";
  readonly nativeOwnerClientId?: string;
  readonly routeGeneration?: number;
  readonly selection?: "profile-primary" | "native-discovered" | "native-after-owner-rejection" | "owner-discovery-failed";
  readonly failureClass?: "owner-busy" | "task-not-open" | "desktop-unavailable" | "other";
}

function failureClass(error: unknown): NonNullable<TaskStateRouteDiagnostic["failureClass"]> {
  if (error instanceof TaskOwnedByClientError) return "owner-busy";
  if (error instanceof TaskNotOpenError) return "task-not-open";
  if (error instanceof DesktopUnavailableError) return "desktop-unavailable";
  return "other";
}

/** Never persist raw exception text, task paths, or client identifiers on failure. */
function failedRouteDiagnostic(stream: TaskStateStream, error: unknown, routeGeneration: number): TaskStateRouteDiagnostic {
  let route: TaskStateRouteDiagnostic | undefined;
  try { route = stream.diagnostic?.(); } catch { /* Diagnostics must not mask the connection error. */ }
  return { kind: "unknown", ...(route?.selection ? { selection: route.selection } : {}),
    failureClass: route?.failureClass ?? failureClass(error), routeGeneration };
}

/** A task-scoped state stream owned by one Codex execution adapter. */
export interface TaskStateStream {
  readonly task: TaskRef;
  /** Trusted transport capability, available before the initial callback.
   * This stream cannot resume or acquire an execution writer. */
  readonly readOnly?: true | undefined;
  start(timeoutMs?: number): Promise<void>;
  verifyOwner(timeoutMs?: number): Promise<void>;
  /** Optional local route evidence; never a physical native writer claim. */
  diagnostic?(): TaskStateRouteDiagnostic;
  close(): void;
}

/** Transport boundary used by the bridge core. */
export interface TaskStateTransport {
  readonly readOnly?: true;
  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream;
  close(): void;
}

export interface TaskStateOwnerRoute {
  readonly routingPolicy?: "exclusive";
  owns(task: TaskRef): boolean;
  readonly states: TaskStateTransport;
}

class RoutedTaskStateStream implements TaskStateStream {
  private active: TaskStateStream;
  private closed = false;
  private primaryClosed = false;
  private selection: NonNullable<TaskStateRouteDiagnostic["selection"]> = "profile-primary";
  private failedWith: TaskStateRouteDiagnostic["failureClass"];
  constructor(readonly task: TaskRef, private readonly primary: TaskStateStream,
    private readonly fallback: () => TaskStateStream,
    private readonly preferFallback?: (task: TaskRef) => Promise<boolean>) { this.active = primary; }
  get readOnly(): true | undefined { return this.active.readOnly; }
  async start(timeoutMs?: number): Promise<void> {
    // A live Desktop/VS Code owner can keep thread/resume pending for minutes
    // on a large task. Discover that owner before touching the profile writer.
    let nativeDiscovered = false;
    try { nativeDiscovered = await this.preferFallback?.(this.task) ?? false; }
    catch (error) {
      this.selection = "owner-discovery-failed";
      this.failedWith = failureClass(error);
      throw error;
    }
    if (nativeDiscovered) {
      if (this.closed) throw new Error("Task subscription was closed before owner discovery finished.");
      this.selection = "native-discovered";
      this.primary.close(); this.primaryClosed = true; this.active = this.fallback();
      try { await this.active.start(timeoutMs); }
      catch (error) { this.failedWith = failureClass(error); throw error; }
      return;
    }
    try { await this.primary.start(timeoutMs); }
    catch (error) {
      if (!(error instanceof TaskOwnedByClientError) || this.closed) {
        this.failedWith = failureClass(error);
        throw error;
      }
      this.selection = "native-after-owner-rejection";
      this.primary.close(); this.primaryClosed = true; this.active = this.fallback();
      try { await this.active.start(timeoutMs); }
      catch (fallbackError) { this.failedWith = failureClass(fallbackError); throw fallbackError; }
    }
  }
  verifyOwner(timeoutMs?: number): Promise<void> { return this.active.verifyOwner(timeoutMs); }
  diagnostic(): TaskStateRouteDiagnostic {
    if (this.failedWith) return { kind: "unknown", selection: this.selection, failureClass: this.failedWith };
    return { ...(this.active.diagnostic?.() ?? { kind: "unknown" }), selection: this.selection };
  }
  close(): void {
    this.closed = true; this.active.close();
    if (this.active !== this.primary && !this.primaryClosed) this.primary.close();
  }
}

/** Selects the configured source owner before opening a task stream. */
export class RoutedTaskStateTransport implements TaskStateTransport {
  constructor(private readonly fallback: TaskStateTransport, private readonly owners: readonly TaskStateOwnerRoute[],
    private readonly preferFallback?: (task: TaskRef) => Promise<boolean>) {}
  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream {
    const exclusive = this.owners.filter(owner => owner.routingPolicy === "exclusive" && owner.owns(task));
    if (exclusive.length > 1) throw new ActionRejectedError("Для задачи найдено несколько исключительных потоков состояния.");
    if (exclusive.length === 1) return exclusive[0]!.states.subscribe(task, onState, onError);
    const owner = this.owners.find(owner => owner.routingPolicy !== "exclusive" && owner.owns(task));
    if (!owner) return this.fallback.subscribe(task, onState, onError);
    return new RoutedTaskStateStream(task, owner.states.subscribe(task, onState, onError),
      () => this.fallback.subscribe(task, onState, onError), this.preferFallback);
  }
  close(): void {
    this.fallback.close();
    for (const owner of this.owners) owner.states.close();
  }
}

/** Passive native observation must never fall through to a profile writer.
 * Exclusive tasks retain their own fence instead of using Desktop. */
export class ObserverOnlyTaskStateTransport implements TaskStateTransport {
  readonly readOnly = true as const;
  constructor(private readonly native: TaskStateTransport, private readonly blocked: (task: TaskRef) => boolean) {
    if (native.readOnly !== true) throw new Error("Passive transport requires an explicitly read-only native source");
  }
  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream {
    try {
      if (this.blocked(task)) throw new ActionRejectedError("Исключительный исполнитель задачи не допускает наблюдение через другой клиент.");
    } catch { throw new ActionRejectedError("Безопасный маршрут наблюдения задачи не подтверждён."); }
    let upstream: TaskStateStream | undefined;
    let closed = false, upstreamClosed = false;
    let rejection: ActionRejectedError | undefined;
    const closeUpstream = (): void => {
      if (!upstream || upstreamClosed) return;
      upstreamClosed = true;
      try { upstream.close(); } catch { /* Claim loss must still retire and report the stream. */ }
    };
    const allowed = (): boolean => {
      if (closed) return false;
      try { if (!this.blocked(task)) return true; }
      catch { /* Unknown claim is unavailable, never permission to keep observing. */ }
      rejection = new ActionRejectedError("Безопасный маршрут наблюдения задачи больше не подтверждён.");
      closed = true;
      closeUpstream();
      try { onError(rejection); } catch { /* A callback must not prevent upstream handle cleanup. */ }
      return false;
    };
    const assertAllowed = (): void => {
      if (!allowed()) throw rejection ?? new ActionRejectedError("Поток наблюдения задачи уже закрыт.");
    };
    upstream = this.native.subscribe(task,
      (state, initial) => { if (allowed()) onState(state, initial); },
      error => { if (allowed()) onError(error); });
    // A source may synchronously deliver state while subscribe is returning.
    if (closed) closeUpstream();
    return {
      task, readOnly: true,
      async start(timeoutMs) { assertAllowed(); await upstream!.start(timeoutMs); assertAllowed(); },
      async verifyOwner(timeoutMs) { assertAllowed(); await upstream!.verifyOwner(timeoutMs); assertAllowed(); },
      diagnostic: () => upstream!.diagnostic?.() ?? { kind: "native-observer" },
      close() { closed = true; closeUpstream(); },
    };
  }
  close(): void { this.native.close(); }
}

/** Passive routing never opens a writer. A selected exclusive observer stays
 * fenced to that route; a changed selection retires it instead of rerouting. */
export class PassiveTaskStateTransport implements TaskStateTransport {
  readonly readOnly = true as const;
  constructor(private readonly native: TaskStateTransport, private readonly owners: readonly TaskStateOwnerRoute[]) {
    if (native.readOnly !== true) throw new Error("Passive routing requires a read-only native source");
  }
  private exclusive(task: TaskRef): readonly TaskStateOwnerRoute[] {
    return this.owners.filter(owner => owner.routingPolicy === "exclusive" && owner.owns(task));
  }
  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream {
    let exclusive: readonly TaskStateOwnerRoute[];
    try { exclusive = this.exclusive(task); }
    catch { throw new ActionRejectedError("Безопасный маршрут наблюдения задачи не подтверждён."); }
    if (exclusive.length > 1) throw new ActionRejectedError("Для задачи найдено несколько исключительных потоков состояния.");
    const selected = exclusive[0];
    const source = selected?.states ?? this.native;
    if (source.readOnly !== true) throw new ActionRejectedError("Исключительный исполнитель не предоставляет безопасный поток наблюдения.");
    const fenced = new ObserverOnlyTaskStateTransport(source, requested => {
      const current = this.exclusive(requested);
      return selected ? current.length !== 1 || current[0] !== selected : current.length !== 0;
    });
    return fenced.subscribe(task, onState, onError);
  }
  close(): void {
    const sources = new Set([this.native, ...this.owners.filter(owner => owner.routingPolicy === "exclusive"
      && owner.states.readOnly === true).map(owner => owner.states)]);
    for (const source of sources) source.close();
  }
}

export interface TaskStateConnectionFailure {
  readonly task: TaskRef;
  readonly error: Error;
  readonly lastVerifiedAt: number | null;
}

export interface TaskStateConnectionEvent {
  readonly phase: "subscribe" | "resume" | "verify" | "notification";
  readonly outcome: "attempt" | "confirmed" | "failed";
  readonly reason?: NonNullable<TaskStateRouteDiagnostic["failureClass"]>;
  readonly routeGeneration: number;
  readonly elapsedMs?: number;
}

interface TaskStateConnection {
  readonly task: TaskRef;
  readonly key: string;
  readonly stream: TaskStateStream;
  readonly onFailure: (failure: TaskStateConnectionFailure) => void;
  ready: boolean;
  lastVerifiedAt: number | null;
  verifying: Promise<void> | null;
  generation: number;
}

/** Owns task stream identity, retry gates and periodic owner verification. */
export class TaskStateConnections {
  private readonly connections = new Map<string, TaskStateConnection>();
  private readonly lastFailures = new Map<string, { key: string; at: number; diagnostic: TaskStateRouteDiagnostic }>();
  private readonly retryAfter = new Map<string, { since: number; until: number }>();
  private generation = 0;
  private readonly additionalTransports = new Set<TaskStateTransport>();

  constructor(private readonly transport: TaskStateTransport, private readonly now: () => number = Date.now,
    private readonly onDiagnostic: (id: string, event: TaskStateConnectionEvent, task: TaskRef) => void = () => {}) {}

  private report(id: string, task: TaskRef, event: TaskStateConnectionEvent): void {
    try { this.onDiagnostic(id, event, task); } catch { /* Diagnostics cannot change task ownership. */ }
  }

  ids(): readonly string[] { return [...this.connections.keys()]; }
  has(id: string): boolean { return this.connections.has(id); }
  isReadOnly(id: string): boolean { return this.connections.get(id)?.stream.readOnly === true; }
  matches(id: string, task: TaskRef): boolean { return this.connections.get(id)?.key === taskKey(task); }
  lastVerifiedAt(id: string): number | null { return this.connections.get(id)?.lastVerifiedAt ?? null; }
  diagnostic(id: string): TaskStateRouteDiagnostic | null {
    const connection = this.connections.get(id);
    if (!connection) return null;
    if (!this.connected(id)) return { kind: "unknown", routeGeneration: connection.generation };
    const diagnostic = connection.stream.diagnostic?.() ?? { kind: "unknown" as const };
    return { ...diagnostic, routeGeneration: connection.generation };
  }
  lastFailureDiagnostic(id: string): TaskStateRouteDiagnostic | null {
    const failure = this.lastFailures.get(id);
    if (!failure) return null;
    const age = this.now() - failure.at;
    if (age < 0 || age > LAST_ROUTE_FAILURE_FRESH_MS) {
      this.lastFailures.delete(id);
      return null;
    }
    return failure.diagnostic;
  }
  connected(id: string, freshnessMs = 45_000): boolean {
    const connection = this.connections.get(id);
    if (!connection?.ready || connection.lastVerifiedAt === null) return false;
    const age = this.now() - connection.lastVerifiedAt;
    return age >= 0 && age <= freshnessMs;
  }
  canAttempt(id: string): boolean {
    const gate = this.retryAfter.get(id);
    if (!gate) return true;
    const now = this.now();
    if (now >= gate.since && now < gate.until) return false;
    // A backwards clock adjustment invalidates the old wall-clock deadline.
    this.retryAfter.delete(id);
    return true;
  }
  postpone(id: string, delayMs: number): void {
    const since = this.now();
    this.retryAfter.set(id, { since, until: since + delayMs });
  }

  close(id: string): void {
    const connection = this.connections.get(id);
    connection?.stream.close();
    this.connections.delete(id);
    this.retryAfter.delete(id);
    this.lastFailures.delete(id);
  }

  async connect(id: string, task: TaskRef, onState: (state: TaskState, initial: boolean) => void,
    onFailure: (failure: TaskStateConnectionFailure) => void, timeoutMs?: number,
    transport: TaskStateTransport = this.transport): Promise<void> {
    if (transport !== this.transport) this.additionalTransports.add(transport);
    this.lastFailureDiagnostic(id);
    const previousFailure = this.lastFailures.get(id);
    this.close(id);
    if (previousFailure?.key === taskKey(task)) this.lastFailures.set(id, previousFailure);
    const generation = ++this.generation;
    const startedAt = this.now();
    this.report(id, task, { phase: "subscribe", outcome: "attempt", routeGeneration: generation });
    let stream!: TaskStateStream;
    try {
      stream = transport.subscribe(task, (state, initial) => {
        const connection = this.connections.get(id);
        if (!connection || !stream || connection.stream !== stream) return;
        connection.ready = true;
        onState(state, initial);
      }, error => this.fail(id, stream, error));
    } catch (error) {
      this.report(id, task, { phase: "subscribe", outcome: "failed", reason: failureClass(error),
        routeGeneration: generation, elapsedMs: Math.max(0, this.now() - startedAt) });
      this.lastFailures.set(id, { key: taskKey(task), at: this.now(),
        diagnostic: { kind: "unknown", failureClass: failureClass(error), routeGeneration: generation } });
      throw error;
    }
    const connection: TaskStateConnection = {
      task, key: taskKey(task), stream, onFailure, ready: false, lastVerifiedAt: null, verifying: null, generation,
    };
    this.connections.set(id, connection);
    try {
      await stream.start(timeoutMs);
      if (this.connections.get(id)?.stream !== stream) return;
      connection.ready = true;
      connection.lastVerifiedAt = this.now();
      this.report(id, task, { phase: "resume", outcome: "confirmed", routeGeneration: generation,
        elapsedMs: Math.max(0, this.now() - startedAt) });
      this.retryAfter.delete(id);
      this.lastFailures.delete(id);
    } catch (error) {
      if (this.connections.get(id)?.stream !== stream) return;
      const diagnostic = failedRouteDiagnostic(stream, error, generation);
      this.report(id, task, { phase: "resume", outcome: "failed", reason: diagnostic.failureClass ?? "other",
        routeGeneration: generation, elapsedMs: Math.max(0, this.now() - startedAt) });
      this.close(id);
      this.lastFailures.set(id, { key: connection.key, at: this.now(), diagnostic });
      throw error;
    }
  }

  maintain(id: string, intervalMs = 30_000): void {
    const connection = this.connections.get(id);
    if (!connection || connection.verifying) return;
    const age = connection.lastVerifiedAt === null ? null : this.now() - connection.lastVerifiedAt;
    if (age !== null && age >= 0 && age < intervalMs) return;
    const check = connection.stream.verifyOwner().then(() => {
      if (this.connections.get(id) === connection) connection.lastVerifiedAt = this.now();
    }, error => this.fail(id, connection.stream, error, "verify")).finally(() => {
      if (connection.verifying === check) connection.verifying = null;
    });
    connection.verifying = check;
  }

  private fail(id: string, stream: TaskStateStream, error: Error, phase: "verify" | "notification" = "notification"): void {
    const connection = this.connections.get(id);
    if (!connection || !stream || connection.stream !== stream) return;
    const failure = { task: connection.task, error, lastVerifiedAt: connection.lastVerifiedAt } satisfies TaskStateConnectionFailure;
    const diagnostic = failedRouteDiagnostic(stream, error, connection.generation);
    this.report(id, connection.task, { phase, outcome: "failed", reason: diagnostic.failureClass ?? "other",
      routeGeneration: connection.generation });
    this.close(id);
    this.lastFailures.set(id, { key: connection.key, at: this.now(), diagnostic });
    connection.onFailure(failure);
  }

  async stop(): Promise<void> {
    const checks = [...this.connections.values()].flatMap(connection => connection.verifying ? [connection.verifying] : []);
    for (const id of this.ids()) this.close(id);
    this.transport.close();
    for (const transport of this.additionalTransports) transport.close();
    this.additionalTransports.clear();
    await Promise.allSettled(checks);
  }
}
