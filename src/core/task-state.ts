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
  start(timeoutMs?: number): Promise<void>;
  verifyOwner(timeoutMs?: number): Promise<void>;
  /** Optional local route evidence; never a physical native writer claim. */
  diagnostic?(): TaskStateRouteDiagnostic;
  close(): void;
}

/** Transport boundary used by the bridge core. */
export interface TaskStateTransport {
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

  constructor(private readonly transport: TaskStateTransport, private readonly now: () => number = Date.now,
    private readonly onDiagnostic: (id: string, event: TaskStateConnectionEvent, task: TaskRef) => void = () => {}) {}

  private report(id: string, task: TaskRef, event: TaskStateConnectionEvent): void {
    try { this.onDiagnostic(id, event, task); } catch { /* Diagnostics cannot change task ownership. */ }
  }

  ids(): readonly string[] { return [...this.connections.keys()]; }
  has(id: string): boolean { return this.connections.has(id); }
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
    onFailure: (failure: TaskStateConnectionFailure) => void, timeoutMs?: number): Promise<void> {
    this.lastFailureDiagnostic(id);
    const previousFailure = this.lastFailures.get(id);
    this.close(id);
    if (previousFailure?.key === taskKey(task)) this.lastFailures.set(id, previousFailure);
    const generation = ++this.generation;
    const startedAt = this.now();
    this.report(id, task, { phase: "subscribe", outcome: "attempt", routeGeneration: generation });
    let stream!: TaskStateStream;
    try {
      stream = this.transport.subscribe(task, (state, initial) => {
        const connection = this.connections.get(id);
        if (connection?.stream !== stream) return;
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
    if (connection?.stream !== stream) return;
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
    await Promise.allSettled(checks);
  }
}
