import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { ManagedWorkerFrontendHost } from './managed-worker-frontend-host.js';
import { readNativeCliIdleEvidence } from './managed-native-cli-source-reader.js';
import type { NativeCliStartProof } from './managed-native-cli-start-admission.js';
import type { NativeCliResumePolicy } from './native-cli-resume-policy.js';

type Host = Pick<ManagedWorkerFrontendHost, 'ownerRead' | 'observeNotifications' |
  'observePendingRequests' | 'commandQuiescence' | 'requestQuiescence' |
  'acceptedCommandReceipts' | 'acceptedQueueInputs'> & {
  readonly metadata: Readonly<{ taskId: string; state: string; backendGeneration: number | null }>;
};
export interface ManagedNativeCliSourceQualifierOptions {
  readonly host: Host;
  readonly adapterKey: object;
  readonly controlKey: object;
  readonly taskId: string;
  readonly ownerEpoch: string;
  /** Physical writer/family proof, supplied by the owner, never a task-path guess. */
  readonly assertOwnerCurrent: () => boolean;
  /** Synchronous stock scheduler/goal proof; not inferred from an empty queue. */
  readonly noPendingAutoStart: () => boolean;
  /** Physical source fence, rechecked synchronously at the command write. */
  readonly assertSourceCurrent?: () => void;
  /** Controlled zero-turn source: reject any intervening native turn. */
  readonly requireEmptyHistory?: true;
}
const fail = (reason: string): never => { throw new Error(`Native CLI source ${reason}`); };

/** Opt-in same-worker source proof. Call start before exposing the frontend
 * bearer. It never starts, resumes, stops or writes to a worker. */
export class ManagedNativeCliSourceQualifier {
  readonly #options: ManagedNativeCliSourceQualifierOptions;
  #generation: number | null = null;
  #revision = 0;
  #started = false;
  #faulted = false;
  #closed = false;
  #detachNotifications: (() => void) | null = null;
  #detachRequests: (() => void) | null = null;

  constructor(options: ManagedNativeCliSourceQualifierOptions) {
    if (!options || !options.host || !options.adapterKey || !options.controlKey ||
        typeof options.taskId !== 'string' || !options.taskId ||
        typeof options.ownerEpoch !== 'string' || !options.ownerEpoch ||
        typeof options.assertOwnerCurrent !== 'function' ||
        typeof options.noPendingAutoStart !== 'function' ||
        options.assertSourceCurrent !== undefined && typeof options.assertSourceCurrent !== 'function')
      fail('qualifier unavailable');
    this.#options = Object.freeze({ ...options });
  }

  start(): void {
    if (this.#started || this.#closed) fail('observer already used');
    const meta = this.#options.host.metadata;
    if (meta.taskId !== this.#options.taskId || meta.state !== 'running' ||
        !Number.isSafeInteger(meta.backendGeneration) ||
        (meta.backendGeneration ?? 0) < 1 ||
        this.#options.assertOwnerCurrent() !== true) fail('owner unavailable');
    this.#generation = meta.backendGeneration;
    this.#started = true;
    const changed = () => {
      if (!Number.isSafeInteger(this.#revision + 1)) this.#faulted = true;
      else this.#revision++;
    };
    try {
      this.#detachNotifications = this.#options.host.observeNotifications(
        this.#options.adapterKey, event => {
          if (event.taskId !== this.#options.taskId ||
              event.generation !== this.#generation) this.#faulted = true;
          changed();
        }, () => { this.#faulted = true; changed(); });
      this.#detachRequests = this.#options.host.observePendingRequests(
        this.#options.adapterKey, event => {
          if (event.taskId !== this.#options.taskId ||
              event.generation !== this.#generation) this.#faulted = true;
          changed();
        }, () => { this.#faulted = true; changed(); });
      // Attaching the read-only observer must remain possible while a goal,
      // queue item, or external scheduler is busy. Only a later write
      // qualification requires those sources to be empty and stable.
      const current = this.#options.host.metadata;
      if (this.#faulted || current.taskId !== this.#options.taskId ||
          current.state !== 'running' || current.backendGeneration !== this.#generation ||
          this.#options.assertOwnerCurrent() !== true)
        fail('owner or worker changed');
    } catch (error) { this.close(); throw error; }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#faulted = true;
    this.#detachNotifications?.(); this.#detachRequests?.();
    this.#detachNotifications = null; this.#detachRequests = null;
  }

  #check(revision?: number): void {
    if (!this.#started || this.#closed || this.#faulted || this.#generation === null)
      fail('observer unavailable');
    const host = this.#options.host, meta = host.metadata;
    if (meta.taskId !== this.#options.taskId || meta.state !== 'running' ||
        meta.backendGeneration !== this.#generation ||
        this.#options.assertOwnerCurrent() !== true)
      fail('owner or worker changed');
    const sourceCheck: unknown = this.#options.assertSourceCurrent?.();
    if (sourceCheck !== undefined) {
      if (sourceCheck && typeof sourceCheck === 'object' && 'then' in sourceCheck &&
          typeof sourceCheck.then === 'function') void Promise.resolve(sourceCheck).catch(() => {});
      fail('source fence must be synchronous');
    }
    if (revision !== undefined && this.#revision !== revision) fail('revision changed');
    const requests = host.requestQuiescence(this.#options.controlKey);
    if (requests.generation !== this.#generation || requests.unresolved !== 0)
      fail('pending request');
    // This first CLI write subset does not claim that an accepted stock queue
    // item has been consumed. A future shared-queue qualifier must prove it.
    if (host.acceptedQueueInputs(this.#options.controlKey).length !== 0)
      fail('accepted queue input unqualified');
    if (this.#options.noPendingAutoStart() !== true) fail('pending auto start');
    if (revision !== undefined && this.#revision !== revision) fail('revision changed');
  }

  /** Native startup can emit status notifications during the first read. Retry
   * only this known pre-write race, with every attempt re-reading all sources.
   * An unsettled stream or any different refusal remains closed. */
  async qualify(resume: NativeCliResumePolicy): Promise<NativeCliStartProof> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.#qualifyOnce(resume); }
      catch (error) {
        if (!(error instanceof Error) ||
            error.message !== 'Native CLI source revision changed' || attempt === 2)
          throw error;
        await this.#waitForQuietRevision();
      }
    }
    return fail('revision unsettled');
  }

  async #waitForQuietRevision(): Promise<void> {
    const deadline = performance.now() + 1500;
    let revision = this.#revision;
    while (performance.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      this.#check();
      if (this.#revision === revision) return;
      revision = this.#revision;
    }
    fail('revision unsettled');
  }

  async #qualifyOnce(resume: NativeCliResumePolicy): Promise<NativeCliStartProof> {
    this.#check();
    const generation = this.#generation!, revision = this.#revision;
    const current = () => this.#check(revision);
    const before = this.#options.host.commandQuiescence(this.#options.controlKey);
    if (before.inFlight !== 0 || before.unconfirmed !== false)
      fail('command ledger unsettled');
    const receipts = this.#options.host.acceptedCommandReceipts(this.#options.controlKey);
    if (receipts.some(receipt => receipt.method !== 'turn/start'))
      fail('non-CLI command receipt unqualified');
    const evidence = await readNativeCliIdleEvidence({ host: this.#options.host,
      controlKey: this.#options.controlKey, taskId: this.#options.taskId,
      generation, expectedCwd: resume.cwd, expectedModel: resume.model,
      expectedEffort: resume.effort as string, assertCurrent: current });
    current();
    if (this.#options.requireEmptyHistory && evidence.turnCount !== 0)
      fail('controlled first-start history is no longer empty');
    const after = this.#options.host.commandQuiescence(this.#options.controlKey);
    if (after.inFlight !== 0 || after.unconfirmed !== false ||
        !isDeepStrictEqual(receipts,
          this.#options.host.acceptedCommandReceipts(this.#options.controlKey)) ||
        receipts.some(receipt => !evidence.terminalTurnIds.includes(receipt.receiptId)))
      fail('command history changed or incomplete');
    current();
    return Object.freeze({ taskId: this.#options.taskId,
      ownerEpoch: this.#options.ownerEpoch, backendGeneration: generation,
      semanticRevision: revision,
      // The default mode echoes the model and effort independently proved by
      // native resume. It must carry no developer-instruction override. This
      // canonical tuple is an allowed CLI request, not a claim that resume
      // exposes the full per-thread collaboration settings.
      effectiveSettings: Object.freeze({ ...resume, summary: null,
        personality: null, collaborationMode: Object.freeze({ mode: 'default',
          settings: Object.freeze({ model: resume.model,
            reasoning_effort: resume.effort, developer_instructions: null }) }) }),
      idle: true, nativeQueueEmpty: true, noPendingAutoStart: true,
      assertCurrent: current });
  }
}
