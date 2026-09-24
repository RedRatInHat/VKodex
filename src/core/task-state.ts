import { TaskOwnedByClientError, taskKey, type TaskRef } from "./codex-tasks.js";

export type TaskState = Record<string, unknown>;

/** A task-scoped state stream owned by one Codex execution adapter. */
export interface TaskStateStream {
  readonly task: TaskRef;
  start(timeoutMs?: number): Promise<void>;
  verifyOwner(timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Transport boundary used by the bridge core. */
export interface TaskStateTransport {
  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream;
  close(): void;
}

export interface TaskStateOwnerRoute {
  owns(task: TaskRef): boolean;
  readonly states: TaskStateTransport;
}

class RoutedTaskStateStream implements TaskStateStream {
  private active: TaskStateStream;
  private closed = false;
  private primaryClosed = false;
  constructor(readonly task: TaskRef, private readonly primary: TaskStateStream,
    private readonly fallback: () => TaskStateStream,
    private readonly preferFallback?: (task: TaskRef) => Promise<boolean>) { this.active = primary; }
  async start(timeoutMs?: number): Promise<void> {
    // A live Desktop/VS Code owner can keep thread/resume pending for minutes
    // on a large task. Discover that owner before touching the profile writer.
    if (this.preferFallback && await this.preferFallback(this.task)) {
      if (this.closed) throw new Error("Task subscription was closed before owner discovery finished.");
      this.primary.close(); this.primaryClosed = true; this.active = this.fallback();
      await this.active.start(timeoutMs);
      return;
    }
    try { await this.primary.start(timeoutMs); }
    catch (error) {
      if (!(error instanceof TaskOwnedByClientError) || this.closed) throw error;
      this.primary.close(); this.primaryClosed = true; this.active = this.fallback();
      await this.active.start(timeoutMs);
    }
  }
  verifyOwner(timeoutMs?: number): Promise<void> { return this.active.verifyOwner(timeoutMs); }
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
    const owner = this.owners.find(owner => owner.owns(task));
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

interface TaskStateConnection {
  readonly task: TaskRef;
  readonly key: string;
  readonly stream: TaskStateStream;
  readonly onFailure: (failure: TaskStateConnectionFailure) => void;
  ready: boolean;
  lastVerifiedAt: number | null;
  verifying: Promise<void> | null;
}

/** Owns task stream identity, retry gates and periodic owner verification. */
export class TaskStateConnections {
  private readonly connections = new Map<string, TaskStateConnection>();
  private readonly retryAfter = new Map<string, number>();

  constructor(private readonly transport: TaskStateTransport, private readonly now: () => number = Date.now) {}

  ids(): readonly string[] { return [...this.connections.keys()]; }
  has(id: string): boolean { return this.connections.has(id); }
  matches(id: string, task: TaskRef): boolean { return this.connections.get(id)?.key === taskKey(task); }
  lastVerifiedAt(id: string): number | null { return this.connections.get(id)?.lastVerifiedAt ?? null; }
  connected(id: string, freshnessMs = 45_000): boolean {
    const connection = this.connections.get(id);
    return !!connection?.ready && connection.lastVerifiedAt !== null && this.now() - connection.lastVerifiedAt <= freshnessMs;
  }
  canAttempt(id: string): boolean { return this.now() >= (this.retryAfter.get(id) ?? 0); }
  postpone(id: string, delayMs: number): void { this.retryAfter.set(id, this.now() + delayMs); }

  close(id: string): void {
    const connection = this.connections.get(id);
    connection?.stream.close();
    this.connections.delete(id);
    this.retryAfter.delete(id);
  }

  async connect(id: string, task: TaskRef, onState: (state: TaskState, initial: boolean) => void,
    onFailure: (failure: TaskStateConnectionFailure) => void, timeoutMs?: number): Promise<void> {
    this.close(id);
    let stream!: TaskStateStream;
    stream = this.transport.subscribe(task, (state, initial) => {
      const connection = this.connections.get(id);
      if (connection?.stream !== stream) return;
      connection.ready = true;
      onState(state, initial);
    }, error => this.fail(id, stream, error));
    const connection: TaskStateConnection = {
      task, key: taskKey(task), stream, onFailure, ready: false, lastVerifiedAt: null, verifying: null,
    };
    this.connections.set(id, connection);
    try {
      await stream.start(timeoutMs);
      if (this.connections.get(id)?.stream !== stream) return;
      connection.ready = true;
      connection.lastVerifiedAt = this.now();
      this.retryAfter.delete(id);
    } catch (error) {
      if (this.connections.get(id)?.stream !== stream) return;
      this.close(id);
      throw error;
    }
  }

  maintain(id: string, intervalMs = 30_000): void {
    const connection = this.connections.get(id);
    if (!connection || connection.verifying || connection.lastVerifiedAt !== null
      && this.now() - connection.lastVerifiedAt < intervalMs) return;
    const check = connection.stream.verifyOwner().then(() => {
      if (this.connections.get(id) === connection) connection.lastVerifiedAt = this.now();
    }, error => this.fail(id, connection.stream, error)).finally(() => {
      if (connection.verifying === check) connection.verifying = null;
    });
    connection.verifying = check;
  }

  private fail(id: string, stream: TaskStateStream, error: Error): void {
    const connection = this.connections.get(id);
    if (connection?.stream !== stream) return;
    const failure = { task: connection.task, error, lastVerifiedAt: connection.lastVerifiedAt } satisfies TaskStateConnectionFailure;
    this.close(id);
    connection.onFailure(failure);
  }

  async stop(): Promise<void> {
    const checks = [...this.connections.values()].flatMap(connection => connection.verifying ? [connection.verifying] : []);
    for (const id of this.ids()) this.close(id);
    this.transport.close();
    await Promise.allSettled(checks);
  }
}
