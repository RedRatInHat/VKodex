import { taskKey, type TaskRef } from '../core/codex-tasks.js';
import type { TaskState, TaskStateStream, TaskStateTransport,
  TaskStateRouteDiagnostic } from '../core/task-state.js';

const stale = (): Error => new Error('Managed task-state claim is no longer current');

/** Adds the persisted binding revision to a worker's authenticated stream.
 * The stream itself still proves the worker epoch and backend generation. */
export class ManagedClaimStateTransport implements TaskStateTransport {
  readonly #transport: TaskStateTransport;
  readonly #taskKey: string;
  readonly #isCurrent: () => boolean;
  readonly #streams = new Set<TaskStateStream>();
  #closed = false;

  constructor(transport: TaskStateTransport, task: TaskRef, isCurrent: () => boolean) {
    if (!transport || typeof transport.subscribe !== 'function' ||
      typeof transport.close !== 'function' || !task ||
      typeof isCurrent !== 'function') throw new TypeError('Managed claim stream requires an exact route');
    this.#transport = transport;
    this.#taskKey = taskKey(task);
    this.#isCurrent = isCurrent;
  }

  #current(): boolean {
    if (this.#closed) return false;
    try { return this.#isCurrent() === true; } catch { return false; }
  }

  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void,
    onError: (error: Error) => void): TaskStateStream {
    if (this.#closed || taskKey(task) !== this.#taskKey || !this.#current()) throw stale();
    let active: TaskStateStream | null = null;
    let stopped = false;
    const end = (notify: boolean): void => {
      if (stopped) return;
      stopped = true;
      if (active) { active.close(); this.#streams.delete(active); }
      if (notify) onError(stale());
    };
    active = this.#transport.subscribe(task, (state, initial) => {
      if (stopped) return;
      if (!this.#current()) { end(true); return; }
      onState(state, initial);
    }, error => {
      if (stopped) return;
      stopped = true;
      if (active) {
        this.#streams.delete(active);
        try { active.close(); } catch { /* Report the original state failure. */ }
      }
      onError(error);
    });
    if (stopped) active.close();
    else this.#streams.add(active);
    return {
      task,
      start: async timeoutMs => {
        if (stopped || !this.#current()) { end(false); throw stale(); }
        await active!.start(timeoutMs);
        if (stopped || !this.#current()) { end(false); throw stale(); }
      },
      verifyOwner: async timeoutMs => {
        if (stopped || !this.#current()) { end(false); throw stale(); }
        await active!.verifyOwner(timeoutMs);
        if (stopped || !this.#current()) { end(false); throw stale(); }
      },
      diagnostic: (): TaskStateRouteDiagnostic =>
        stopped || !this.#current() ? { kind: 'unknown' } :
          active?.diagnostic?.() ?? { kind: 'unknown' },
      close: () => end(false),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stream of this.#streams) stream.close();
    this.#streams.clear();
    this.#transport.close();
  }
}
