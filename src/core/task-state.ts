import { taskKey, type TaskRef } from "./codex-tasks.js";

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
