import type { HomogeneousQueueSettings } from './homogeneous-queue-policy.js';
import type { WorkerCommand, WorkerCommandResponse } from './managed-worker-command-dispatcher.js';
import { prepareNativeCliTurnStart } from './native-cli-turn-start.js';

type JsonObject = Record<string, unknown>;
interface Host {
  readonly metadata: Readonly<{ taskId: string; state: string; backendGeneration: number | null }>;
  executeCommandWithResponse(controlKey: object, command: WorkerCommand,
    beforeWrite?: () => void): Promise<WorkerCommandResponse>;
  commandQuiescence(controlKey: object): Readonly<{ inFlight: number; unconfirmed: boolean }>;
}
export interface NativeCliStartProof {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly semanticRevision: number;
  readonly effectiveSettings: HomogeneousQueueSettings;
  /** Source-qualified state for this same worker, not frontend-supplied flags. */
  readonly idle: true;
  readonly nativeQueueEmpty: true;
  readonly noPendingAutoStart: true;
  /** Synchronous, owner-qualified revision fence; throw on any relevant change. */
  readonly assertCurrent: () => void;
}
export interface ManagedNativeCliStartAdmissionOptions {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly controlKey: object;
  /** Must independently prove source, native queue, active turn and goal state. */
  readonly qualify: () => Promise<NativeCliStartProof>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function assertSync(proof: NativeCliStartProof): void {
  const result: unknown = proof.assertCurrent();
  if (result !== undefined) {
    if (result && typeof result === 'object' && 'then' in result &&
        typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
    throw new TypeError('CLI start fence must be synchronous');
  }
}

/** Opt-in CLI turn/start admission. No backend reference, listener, scheduler or
 * production registration. The host's durable command policy remains the sole
 * writer and independently rechecks authority before its native frame. */
export class ManagedNativeCliStartAdmission {
  readonly ownerEpoch: string;
  readonly #options: ManagedNativeCliStartAdmissionOptions;
  #boundHost: Host | null = null;
  #qualifying = false;

  constructor(options: ManagedNativeCliStartAdmissionOptions) {
    if (!options || typeof options.taskId !== 'string' || !options.taskId ||
        !uuid.test(options.ownerEpoch) || !options.controlKey ||
        typeof options.controlKey !== 'object' ||
        typeof options.qualify !== 'function') throw new TypeError('Native CLI start admission unavailable');
    this.ownerEpoch = options.ownerEpoch;
    this.#options = Object.freeze({ ...options });
  }

  /** Constructor-only host binding; a matching task name alone is insufficient. */
  matchesPolicy(taskId: string, policy: Readonly<{ ownerEpoch: string; controlKey: object }>): boolean {
    return taskId === this.#options.taskId && policy.ownerEpoch === this.ownerEpoch &&
      policy.controlKey === this.#options.controlKey;
  }

  /** One-shot identity binding by the worker host constructor itself. */
  bindHost(host: Host, taskId: string,
    policy: Readonly<{ ownerEpoch: string; controlKey: object }>): void {
    if (this.#boundHost || !host || !this.matchesPolicy(taskId, policy) ||
        host.metadata.taskId !== taskId)
      throw new TypeError('Native CLI admission host mismatch');
    this.#boundHost = host;
  }

  async run({ taskId, generation, params }: Readonly<{ taskId: string;
    generation: number; params: JsonObject }>): Promise<WorkerCommandResponse> {
    if (this.#qualifying || taskId !== this.#options.taskId ||
        !Number.isSafeInteger(generation) || generation < 1)
      throw new Error('Native CLI start scope unavailable');
    const host = this.#boundHost;
    if (!host) throw new Error('Native CLI admission not attached to a worker');
    const exactHost = () => {
      const meta = host.metadata;
      if (!meta || meta.state !== 'running' || meta.taskId !== taskId ||
          meta.backendGeneration !== generation)
        throw new Error('Native CLI worker generation changed');
    };
    exactHost();
    this.#qualifying = true;
    let proof: NativeCliStartProof;
    try { proof = await this.#options.qualify(); }
    finally { this.#qualifying = false; }
    exactHost();
    if (!proof || proof.taskId !== taskId || proof.ownerEpoch !== this.ownerEpoch ||
        proof.backendGeneration !== generation ||
        !Number.isSafeInteger(proof.semanticRevision) || proof.semanticRevision < 0 ||
        proof.idle !== true || proof.nativeQueueEmpty !== true ||
        proof.noPendingAutoStart !== true || typeof proof.assertCurrent !== 'function')
      throw new Error('Native CLI queue or owner proof unavailable');
    assertSync(proof);
    const quiescence = host.commandQuiescence(this.#options.controlKey);
    if (quiescence.inFlight !== 0 || quiescence.unconfirmed !== false)
      throw new Error('Native CLI command ledger unsettled');
    const command = prepareNativeCliTurnStart(params, { taskId,
      ownerEpoch: this.ownerEpoch, effectiveSettings: proof.effectiveSettings });
    exactHost(); assertSync(proof);
    // No await between this final semantic fence and the command dispatcher's
    // own synchronous before-write callback and generation/owner checks.
    return host.executeCommandWithResponse(this.#options.controlKey, command, () => {
      exactHost(); assertSync(proof);
    });
  }
}
