import { DesktopUnavailableError, type TaskRef } from "../core/codex-tasks.js";
import { sameRolloutSource } from "../core/paths.js";
import type { TaskState, TaskStateStream, TaskStateTransport } from "../core/task-state.js";
import { DesktopIpcClient } from "./ipc-client.js";
import { TaskSubscription } from "./subscription.js";

export type { TaskStateConnectionFailure, TaskStateStream, TaskStateTransport } from "../core/task-state.js";
export { TaskStateConnections } from "../core/task-state.js";

interface Consumer {
  readonly onState: (state: TaskState, initial: boolean) => void;
  readonly onError: (error: Error) => void;
  seen: boolean;
  cancelStart: ((error: Error) => void) | null;
  ready: { resolve: () => void; reject: (error: Error) => void } | null;
}

interface SharedSubscription {
  readonly task: TaskRef;
  readonly upstream: TaskSubscription;
  readonly consumers: Set<Consumer>;
  starting: Promise<void> | null;
  error: Error | null;
}

function sameSource(a: TaskRef, b: TaskRef): boolean {
  if ((a.sourceId ?? "") !== (b.sourceId ?? "")) return false;
  if (!a.rolloutPath || !b.rolloutPath) return !a.rolloutPath && !b.rolloutPath;
  return sameRolloutSource(a.rolloutPath, b.rolloutPath);
}

/** The native follower identity is this IPC client, so its observers share a
 * single upstream follow for each wire task. */
export class DesktopTaskStateTransport implements TaskStateTransport {
  private readonly subscriptions = new Map<string, SharedSubscription>();
  private closed = false;

  constructor(private readonly client = new DesktopIpcClient()) {}

  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream {
    if (this.closed) throw new DesktopUnavailableError("Транспорт наблюдения закрыт.");
    const key = JSON.stringify([task.hostId, task.threadId]);
    const consumer: Consumer = { onState, onError, seen: false, cancelStart: null, ready: null };
    let entry: SharedSubscription | null = null;
    let started = false;
    let closed = false;
    const unavailable = () => new DesktopUnavailableError("Подписка на задачу отменена.");
    const active = () => !closed && !this.closed && entry !== null && entry.consumers.has(consumer);
    return {
      task,
      start: async (timeoutMs = 5_000) => {
        if (closed || this.closed) throw unavailable();
        if (started) throw new Error("Subscription is already active");
        started = true;
        const existing = this.subscriptions.get(key);
        if (existing && !sameSource(existing.task, task)) {
          throw new DesktopUnavailableError("Эта задача уже наблюдается через другой каталог Codex.");
        }
        entry = existing ?? this.create(key, task);
        entry.consumers.add(consumer);
        if (entry.error) throw entry.error;
        // Install cancellation before awaiting an upstream that another lease
        // may keep alive after this lease closes.
        const cancelled = new Promise<never>((_resolve, reject) => { consumer.cancelStart = reject; });
        entry.starting ??= Promise.resolve().then(async () => {
          if (!entry!.consumers.size) throw unavailable();
          await entry!.upstream.start(timeoutMs);
        }).catch(error => {
          entry!.error = error instanceof Error ? error : new DesktopUnavailableError();
          throw entry!.error;
        });
        try {
          await Promise.race([(async () => {
            await entry!.starting;
            if (!active()) throw unavailable();
            const current = entry!.upstream.current;
            if (!consumer.seen && current) this.deliver(consumer, current);
            // A late join during revision/source recovery cannot accept the
            // previous snapshot as current. Wait for a verified new base.
            if (!consumer.seen) await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new DesktopUnavailableError("Не получено состояние задачи.")), timeoutMs);
              consumer.ready = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
            });
          })(), cancelled]);
          if (!active()) throw unavailable();
        } finally { consumer.cancelStart = null; consumer.ready = null; }
      },
      verifyOwner: async (timeoutMs = 5_000) => {
        if (!started || !active() || entry!.error) throw entry?.error ?? unavailable();
        await entry!.upstream.verifyOwner(timeoutMs);
        if (!active()) throw unavailable();
      },
      close: () => {
        if (closed) return;
        closed = true;
        consumer.cancelStart?.(unavailable());
        consumer.ready?.reject(unavailable());
        consumer.cancelStart = null;
        if (!entry) return;
        entry.consumers.delete(consumer);
        if (!entry.consumers.size) this.retire(key, entry);
      },
    };
  }

  private create(key: string, task: TaskRef): SharedSubscription {
    const consumers = new Set<Consumer>();
    const entry: SharedSubscription = {
      task,
      upstream: new TaskSubscription(this.client, task, state => {
        for (const consumer of [...consumers]) if (consumers.has(consumer)) this.deliver(consumer, state);
      }, error => {
        entry.error = error;
        for (const consumer of [...consumers]) if (consumers.has(consumer)) {
          consumer.ready?.reject(error);
          this.report(consumer, error);
        }
      }),
      consumers, starting: null, error: null,
    };
    this.subscriptions.set(key, entry);
    return entry;
  }

  private deliver(consumer: Consumer, state: TaskState): void {
    const initial = !consumer.seen;
    consumer.seen = true;
    consumer.ready?.resolve();
    try { consumer.onState(structuredClone(state), initial); }
    catch (error) { this.report(consumer, error instanceof Error ? error : new Error("State consumer failed")); }
  }

  private report(consumer: Consumer, error: Error): void {
    try { consumer.onError(error); } catch { /* One observer cannot break another. */ }
  }

  private retire(key: string, entry: SharedSubscription): void {
    if (this.subscriptions.get(key) === entry) this.subscriptions.delete(key);
    entry.upstream.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [key, entry] of this.subscriptions) {
      for (const consumer of entry.consumers) {
        const error = new DesktopUnavailableError("Транспорт наблюдения закрыт.");
        consumer.cancelStart?.(error);
        consumer.ready?.reject(error);
      }
      entry.consumers.clear();
      this.retire(key, entry);
    }
    this.client.close();
  }
}
