import { taskKey, type TaskRef } from '../core/codex-tasks.js';
import type { TaskState, TaskStateStream, TaskStateTransport } from '../core/task-state.js';
import { ManagedClaimStateTransport } from '../codex/managed-claim-state-transport.js';
import type { ManagedOwnerBinding } from './store.js';
import type { ManagedOwnerRouteResolution } from './managed-owner-route-resolver.js';
import type { RestartTaskSnapshot } from '../desktop/restart-intent.js';

/** Read-only subset used by the optional exclusive state-route composition. */
export interface ManagedOwnerRouteObserver {
  resolve(task: TaskRef): Promise<ManagedOwnerRouteResolution>;
  isCurrent(claim: ManagedOwnerBinding): boolean;
}

const unavailable = (): Error => new Error('Managed owner observed state is unavailable');

/**
 * Lazily proves an already-registered managed route before exposing its private
 * observation stream.  It neither launches a worker nor falls back to another
 * state transport.  The returned claim wrapper rechecks the durable revision
 * on every frame and owner verification.
 */
export class ManagedOwnerObservedTaskStateTransport implements TaskStateTransport {
  readonly #resolver: ManagedOwnerRouteObserver;
  readonly #task: Readonly<TaskRef>;
  readonly #key: string;
  readonly #streams = new Set<() => void>();
  #closed = false;

  constructor(resolver: ManagedOwnerRouteObserver, task: TaskRef,
    private readonly expectedClaim?: Readonly<{ epoch: string; id: string; revision: number }>) {
    if (!resolver || typeof resolver.resolve !== 'function' || typeof resolver.isCurrent !== 'function' ||
      !task || typeof task.hostId !== 'string' || !task.hostId || typeof task.threadId !== 'string' || !task.threadId)
      throw new TypeError('Managed owner observed transport requires an exact task and resolver');
    this.#resolver = resolver;
    this.#task = Object.freeze({ ...task });
    this.#key = taskKey(task);
  }

  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void,
    onError: (error: Error) => void): TaskStateStream {
    if (this.#closed || taskKey(task) !== this.#key) throw unavailable();
    let active: TaskStateStream | null = null;
    let fenced: ManagedClaimStateTransport | null = null;
    let pendingStates: TaskStateTransport | null = null;
    let closed = false;
    let started: Promise<void> | null = null;
    const close = (): void => {
      if (closed) return;
      closed = true;
      active?.close();
      this.#streams.delete(close);
      fenced?.close();
      pendingStates?.close();
    };
    const begin = async (timeoutMs?: number): Promise<void> => {
      if (closed || this.#closed) throw unavailable();
      let resolution: ManagedOwnerRouteResolution;
      try { resolution = await this.#resolver.resolve(this.#task); }
      catch { close(); throw unavailable(); }
      if (resolution.kind === 'statically-qualified') pendingStates = resolution.states;
      if (closed || this.#closed || resolution.kind !== 'statically-qualified' ||
        resolution.claim.hostId !== this.#task.hostId || resolution.claim.threadId !== this.#task.threadId ||
        resolution.claim.sourceId !== (this.#task.sourceId ?? '') ||
        this.expectedClaim !== undefined && (resolution.claim.ownerEpoch !== this.expectedClaim.epoch ||
          resolution.claim.id !== this.expectedClaim.id || resolution.claim.revision !== this.expectedClaim.revision ||
          resolution.claim.state !== 'ready') ||
        !this.#resolver.isCurrent(resolution.claim)) {
        if (closed) pendingStates?.close();
        else close();
        throw unavailable();
      }
      let status;
      try { status = await resolution.controlStatus(); }
      catch { close(); throw unavailable(); }
      if (closed || this.#closed || !this.#resolver.isCurrent(resolution.claim) ||
        status.ownerEpoch !== resolution.claim.ownerEpoch || status.taskId !== this.#task.threadId ||
        status.backendGeneration !== resolution.claim.evidence.backendGeneration || status.hostState !== 'running') {
        close(); throw unavailable();
      }
      fenced = new ManagedClaimStateTransport(resolution.states, this.#task,
        () => !closed && !this.#closed && this.#resolver.isCurrent(resolution.claim));
      pendingStates = null;
      try {
        active = fenced.subscribe(this.#task, onState, onError);
        await active.start(timeoutMs);
        if (closed || this.#closed || !this.#resolver.isCurrent(resolution.claim)) {
          close(); throw unavailable();
        }
      } catch {
        close();
        throw unavailable();
      }
    };
    const start = (timeoutMs?: number): Promise<void> => {
      if (!started) started = begin(timeoutMs);
      return started;
    };
    this.#streams.add(close);
    return Object.freeze({ task: { ...this.#task }, start,
      verifyOwner: async (timeoutMs?: number): Promise<void> => {
        if (!active || closed || this.#closed) throw unavailable();
        try { await active.verifyOwner(timeoutMs); }
        catch { close(); throw unavailable(); }
        if (closed || this.#closed) throw unavailable();
      },
      diagnostic: () => active?.diagnostic?.() ?? { kind: 'unknown' as const },
      close });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const close of this.#streams) close();
    this.#streams.clear();
  }
}

/** Read only one exact managed turn through its confirmed owner epoch. A
 * missing turn, a changed claim or any stream failure is never restart proof. */
export async function inspectManagedRestartTurn(observer: ManagedOwnerRouteObserver,
  task: TaskRef, snapshot: RestartTaskSnapshot):
  Promise<'active' | 'settled' | 'unknown'> {
  const { ownerEpoch, ownerClaimId, ownerClaimRevision, activeTurnId } = snapshot;
  if (!ownerEpoch || !ownerClaimId || ownerClaimRevision === undefined || !activeTurnId) return 'unknown';
  const transport = new ManagedOwnerObservedTaskStateTransport(observer, task,
    { epoch: ownerEpoch, id: ownerClaimId, revision: ownerClaimRevision });
  let stateSnapshot: TaskState | null = null;
  let failed = false;
  const stream = transport.subscribe(task, value => { stateSnapshot = value; }, () => { failed = true; });
  try {
    await stream.start(10_000);
    await stream.verifyOwner();
    if (failed || !stateSnapshot) return 'unknown';
    const turns: unknown = stateSnapshot['turns'];
    if (!Array.isArray(turns)) return 'unknown';
    const exact = turns.find((turn: unknown) => turn !== null && typeof turn === 'object' &&
      !Array.isArray(turn) && 'id' in turn && turn.id === activeTurnId);
    if (!exact || typeof exact !== 'object' || !('status' in exact)) return 'unknown';
    return exact.status === 'inProgress' ?
      stateSnapshot['runtimeStatus'] === 'active' ? 'active' : 'unknown' :
      ['completed', 'failed'].includes(String(exact.status)) ? 'settled' : 'unknown';
  } catch { return 'unknown'; }
  finally { transport.close(); }
}
