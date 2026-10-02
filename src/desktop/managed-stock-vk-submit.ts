import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ActionRejectedError, UncertainActionError, type SubmitTaskRequest } from '../core/codex-tasks.js';
import { taskInput } from '../core/task-input.js';
import { approveTaskPolicy, type ApprovedTaskPolicy } from '../codex/managed-task-policy.js';
import type { WorkerCommand, WorkerCommandResponse, WorkerCommandQuiescence } from '../codex/managed-worker-command-dispatcher.js';
import type { WorkerOperation } from '../codex/managed-worker-operation-journal.js';
import type { StockReadState } from './managed-worker-bootstrap.js';
import type { NativeProjectionState } from '../codex/managed-native-projection.js';
import type { ManagedNativeStockQueueAuthority } from './managed-worker-native-owner.js';
import { assertManagedStockReadParity } from './managed-stock-queue-runtime.js';
import type { AppServerRequestOptions } from '../codex/app-server-connection.js';

type Host = Readonly<{
  executeCommandWithResponse(key: object, command: WorkerCommand, beforeWrite?: () => void,
    withWriteGuard?: AppServerRequestOptions['withWriteGuard']): Promise<WorkerCommandResponse>;
  commandStatusForIntent(key: object, command: WorkerCommand): WorkerOperation | null;
  commandQuiescence(key: object): WorkerCommandQuiescence;
  acceptedCommandReceipts(key: object): ReadonlyArray<Readonly<{ method: WorkerCommand['method']; receiptId: string }>>;
  acceptedQueueInputs(key: object): ReadonlyArray<Readonly<{ clientUserMessageId: string; submissionId: string }>>;
  hasCommandClientIdentity(key: object, clientId: string): boolean;
}>;
export interface ManagedStockVkLease {
  /** Synchronous fence immediately adjacent to the durable reserve and wire write. */
  assertCurrent(): void;
  /** Unknown retains admission ownership until an exact durable late outcome. */
  finish(outcome: 'accepted' | 'rejected' | 'unknown'): void;
}
export interface ManagedStockVkSubmitterOptions {
  readonly capability: object;
  readonly controlKey: object;
  readonly sourceId: string;
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly approvedTaskPolicy: ApprovedTaskPolicy;
  readonly host: Host;
  readonly readStockState: (assertCurrent: () => void,
    expectedQueueClientIds: readonly string[]) => Promise<StockReadState>;
  readonly initialState: NativeProjectionState;
  readonly captureAuthority: () => ManagedNativeStockQueueAuthority;
  readonly assertAuthorityCurrent: (ticket: ManagedNativeStockQueueAuthority) => boolean;
  /** Acquires the shared native/VK admission lease before the first await. */
  readonly acquireLease: () => ManagedStockVkLease;
  /** Daemon-owned union of direct intents and native queue identities. Unknown refuses. */
  readonly isClientReservedForNativeInput: (clientId: string) => boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const refuse = (): never => { throw new ActionRejectedError('Managed VK stock input unavailable'); };
/** Separate from both the VK client ID and native-FWE operation namespace. */
export function managedVkStockCommandId(ownerEpoch: string, taskId: string, clientId: string): string {
  if (!uuid.test(ownerEpoch) || !uuid.test(clientId) || typeof taskId !== 'string' || !taskId) refuse();
  const bytes = createHash('sha256').update('vkodex-managed-vk-stock-queue-v1\0')
    .update(JSON.stringify([ownerEpoch, taskId, clientId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** In-process, capability-bound queue ingress. It never presents a native IPC
 * envelope or starts a turn, and never treats a submission ID as a turn ID. */
export class ManagedStockVkSubmitter {
  readonly #options: ManagedStockVkSubmitterOptions;
  readonly #policy: ApprovedTaskPolicy;
  readonly #leases = new Map<string, { readonly lease: ManagedStockVkLease;
    readonly command: WorkerCommand; current: (() => void) | null }>();

  constructor(options: ManagedStockVkSubmitterOptions) {
    if (!options || !options.capability || typeof options.capability !== 'object' ||
      !options.controlKey || typeof options.controlKey !== 'object' ||
      typeof options.sourceId !== 'string' || options.sourceId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(options.sourceId) ||
      typeof options.taskId !== 'string' || !options.taskId || !uuid.test(options.ownerEpoch) ||
      !Number.isSafeInteger(options.backendGeneration) || options.backendGeneration < 1 ||
      !options.host || typeof options.host.executeCommandWithResponse !== 'function' ||
      typeof options.host.commandStatusForIntent !== 'function' ||
      typeof options.host.commandQuiescence !== 'function' ||
      typeof options.host.acceptedCommandReceipts !== 'function' ||
      typeof options.host.acceptedQueueInputs !== 'function' ||
      typeof options.host.hasCommandClientIdentity !== 'function' ||
      typeof options.readStockState !== 'function' || !options.initialState ||
      typeof options.captureAuthority !== 'function' ||
      typeof options.assertAuthorityCurrent !== 'function' ||
      typeof options.acquireLease !== 'function' ||
      typeof options.isClientReservedForNativeInput !== 'function')
      throw new TypeError('Explicit managed VK stock policy required');
    const policy = approveTaskPolicy(options.approvedTaskPolicy);
    if (policy.threadId !== options.taskId) throw new TypeError('Managed VK stock task scope differs');
    this.#policy = policy;
    this.#options = Object.freeze({ ...options,
      initialState: structuredClone(options.initialState) });
  }

  get pending(): number { return this.#leases.size; }

  /** Called only by the daemon's same-host WorkerCommandPolicy. */
  authorizes(context: Readonly<WorkerCommand & { ownerEpoch: string;
    backendGeneration: number; threadId: string }>): boolean {
    const pending = this.#leases.get(context.operationId);
    if (!pending?.current || context.ownerEpoch !== this.#options.ownerEpoch ||
      context.backendGeneration !== this.#options.backendGeneration ||
      context.threadId !== this.#options.taskId ||
      !isDeepStrictEqual({ operationId: context.operationId, method: context.method,
        params: context.params }, pending.command)) return false;
    try { pending.current(); return this.#leases.get(context.operationId) === pending; }
    catch { return false; }
  }

  #command(request: SubmitTaskRequest): Readonly<{ command: WorkerCommand; beforeSend?: () => Promise<void> }> {
    if (!request || request.task?.hostId !== 'local' || request.task.threadId !== this.#options.taskId ||
      (request.task.sourceId ?? '') !== this.#options.sourceId || !uuid.test(request.operationId) ||
      typeof request.text !== 'string' || !request.text.trim() || request.text.length > 64_000 ||
      request.inputFiles !== undefined && (!Array.isArray(request.inputFiles) ||
        request.inputFiles.length !== 0 || Reflect.ownKeys(request.inputFiles).length !== 1) ||
      request.task.rolloutPath !== undefined &&
        (typeof request.task.rolloutPath !== 'string' || !path.win32.isAbsolute(request.task.rolloutPath) ||
          request.task.rolloutPath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(request.task.rolloutPath)) ||
      request.outboxDir !== undefined && (!path.win32.isAbsolute(request.outboxDir) ||
        request.outboxDir.length > 4096 || /[\u0000-\u001f\u007f]/u.test(request.outboxDir))) refuse();
    if (request.beforeSend !== undefined && typeof request.beforeSend !== 'function') refuse();
    if (Reflect.ownKeys(request).some(key => typeof key !== 'string' ||
      !['operationId', 'task', 'text', 'author', 'inputFiles', 'outboxDir', 'beforeSend'].includes(key))) refuse();
    if (Reflect.ownKeys(request.task).some(key => typeof key !== 'string' ||
      !['hostId', 'threadId', 'sourceId', 'rolloutPath'].includes(key))) refuse();
    // Snapshot every semantic field before awaiting owner/read checks. The
    // callback is captured by identity and invoked once just before admission.
    const snapshot = structuredClone({ operationId: request.operationId, task: request.task,
      text: request.text, author: request.author ?? null, inputFiles: request.inputFiles ?? [],
      outboxDir: request.outboxDir ?? null });
    const prepared = taskInput({ operationId: snapshot.operationId, task: snapshot.task,
      text: snapshot.text, ...(snapshot.author ? { author: snapshot.author } : {}),
      ...(snapshot.outboxDir ? { outboxDir: snapshot.outboxDir } : {}) });
    if (!prepared.text || prepared.input.length !== 1 || prepared.attachments.length !== 0) refuse();
    const input = structuredClone(prepared.input);
    const command: WorkerCommand = { operationId: managedVkStockCommandId(this.#options.ownerEpoch,
      this.#options.taskId, snapshot.operationId), method: 'thread/queue/add',
    params: { threadId: this.#options.taskId, clientUserMessageId: snapshot.operationId, input } };
    return Object.freeze({ command, ...(request.beforeSend ? { beforeSend: request.beforeSend } : {}) });
  }

  #known(command: WorkerCommand): WorkerOperation | null {
    const prior = this.#options.host.commandStatusForIntent(this.#options.controlKey, command);
    if (prior && (prior.ownerEpoch !== this.#options.ownerEpoch ||
      prior.backendGeneration !== this.#options.backendGeneration ||
      prior.threadId !== this.#options.taskId || prior.method !== 'thread/queue/add' ||
      prior.clientUserMessageId !== command.params.clientUserMessageId)) refuse();
    if (prior && (prior.state === 'accepted' || prior.state === 'rejected') &&
      this.#options.host.commandQuiescence(this.#options.controlKey).inFlight === 0) {
      this.#leases.get(command.operationId)?.lease.finish(prior.state);
      this.#leases.delete(command.operationId);
    }
    return prior;
  }

  status(capability: object, request: SubmitTaskRequest): WorkerOperation | null {
    if (capability !== this.#options.capability) refuse();
    return this.#known(this.#command(request).command);
  }

  async submit(capability: object, request: SubmitTaskRequest,
    assertScopeCurrent?: () => void,
    withWriteGuard?: AppServerRequestOptions['withWriteGuard']): Promise<Readonly<{ submissionId: string }>> {
    if (capability !== this.#options.capability) refuse();
    if (assertScopeCurrent !== undefined && typeof assertScopeCurrent !== 'function') refuse();
    if (withWriteGuard !== undefined && typeof withWriteGuard !== 'function') refuse();
    // Trusted in-process scope only; never a serialized caller assertion. It
    // stays bound to this operation through preparation and actual wire write.
    const assertScope = (): void => {
      if (!assertScopeCurrent) return;
      const result: unknown = assertScopeCurrent();
      if (result !== undefined) {
        // An async assertion cannot qualify a synchronous write fence. Observe
        // a rejected promise without awaiting or granting it authority.
        void Promise.resolve(result).catch(() => {});
        refuse();
      }
    };
    const { command, beforeSend } = this.#command(request);
    assertScope();
    const prior = this.#known(command);
    if (prior) {
      if (prior.state === 'accepted' && prior.receiptId) return { submissionId: prior.receiptId };
      if (prior.state === 'rejected') refuse();
      throw new UncertainActionError();
    }
    // The lease is acquired synchronously before the first await. A second
    // ingress source must see it even while beforeSend/readStockState waits.
    const lease = this.#options.acquireLease();
    const pending = { lease, command, current: null as (() => void) | null };
    this.#leases.set(command.operationId, pending);
    let outcome: 'accepted' | 'rejected' | 'unknown' = 'rejected';
    try {
      lease.assertCurrent();
      const ticket = this.#options.captureAuthority();
      const host = this.#options.host, key = this.#options.controlKey;
      const receipts = structuredClone(host.acceptedCommandReceipts(key));
      const inputs = structuredClone(host.acceptedQueueInputs(key));
      if (!Array.isArray(receipts) || !Array.isArray(inputs) ||
          receipts.some(receipt => !receipt ||
            !['turn/start', 'thread/queue/add'].includes(receipt.method) ||
            typeof receipt.receiptId !== 'string' || !receipt.receiptId) ||
          inputs.some(input => !input || typeof input.clientUserMessageId !== 'string' ||
            !input.clientUserMessageId || typeof input.submissionId !== 'string' || !input.submissionId)) refuse();
      const turnIds = receipts.filter(receipt => receipt.method === 'turn/start').map(receipt => receipt.receiptId);
      const submissionIds = receipts.filter(receipt => receipt.method === 'thread/queue/add').map(receipt => receipt.receiptId);
      const clientIds = inputs.map(input => input.clientUserMessageId);
      if (new Set(turnIds).size !== turnIds.length || new Set(submissionIds).size !== submissionIds.length ||
          new Set(clientIds).size !== clientIds.length ||
          !isDeepStrictEqual(submissionIds, inputs.map(input => input.submissionId))) refuse();
      const assertTicket = () => {
        assertScope();
        lease.assertCurrent();
        if (this.#leases.get(command.operationId) !== pending ||
            this.#options.assertAuthorityCurrent(ticket) !== true ||
            !isDeepStrictEqual(host.acceptedCommandReceipts(key), receipts) ||
            !isDeepStrictEqual(host.acceptedQueueInputs(key), inputs) ||
            this.#options.isClientReservedForNativeInput(command.params.clientUserMessageId as string) !== false)
          throw new Error('Managed VK native authority changed');
        const own = host.commandStatusForIntent(key, command), quiet = host.commandQuiescence(key);
        if (!Number.isSafeInteger(quiet.inFlight) || quiet.inFlight < 0) refuse();
        if (own === null) {
          if (quiet.inFlight !== 0 || quiet.unconfirmed !== false ||
              host.hasCommandClientIdentity(key, command.params.clientUserMessageId as string) !== false) refuse();
        } else if (!pending.current || own.operationId !== command.operationId || own.state !== 'dispatching' ||
            own.ownerEpoch !== this.#options.ownerEpoch || own.backendGeneration !== this.#options.backendGeneration ||
            own.threadId !== this.#options.taskId || own.method !== command.method ||
            own.clientUserMessageId !== command.params.clientUserMessageId ||
            quiet.inFlight > 1 || quiet.unconfirmed !== true) refuse();
      };
      assertTicket();
      // Queue removal is not canonical consumption. Prove every prior accepted
      // queue client in exhaustive terminal history on this same generation.
      const read = await this.#options.readStockState(assertTicket, clientIds);
      assertTicket();
      assertManagedStockReadParity(ticket, read, this.#options.initialState,
        this.#policy, this.#options.ownerEpoch, this.#options.backendGeneration);
      const terminal = new Set(read.terminalTurnIds);
      if (turnIds.some(turnId => !terminal.has(turnId))) refuse();
      lease.assertCurrent();
      await beforeSend?.();
      assertTicket();
      // Holding admission blocks competitors, but grants no command authority
      // until history, policy and bridge-local preparation have all completed.
      pending.current = assertTicket;
      // From this point a durable reservation or partial stdin write can exist.
      outcome = 'unknown';
      let flight: Promise<WorkerCommandResponse>;
      try {
        flight = this.#options.host.executeCommandWithResponse(this.#options.controlKey,
          command, assertTicket, withWriteGuard);
      } catch (error) {
        // The dispatcher reserves synchronously before creating its RPC
        // promise. A null exact row plus no flight proves this invocation did
        // not write; lookup failure or a row leaves outcome unknown.
        try {
          if (!this.#options.host.commandStatusForIntent(this.#options.controlKey, command) &&
              this.#options.host.commandQuiescence(this.#options.controlKey).inFlight === 0)
            outcome = 'rejected';
        } catch { /* retain unknown */ }
        if (outcome === 'rejected') refuse();
        throw error;
      }
      const observed = await flight;
      const operation = observed.operation;
      if (operation.operationId !== command.operationId ||
        operation.ownerEpoch !== this.#options.ownerEpoch ||
        operation.backendGeneration !== this.#options.backendGeneration ||
        operation.threadId !== this.#options.taskId ||
        operation.method !== 'thread/queue/add' ||
        operation.clientUserMessageId !== command.params.clientUserMessageId ||
        operation.state === 'unknown' || operation.state === 'dispatching')
        throw new UncertainActionError();
      if (operation.state === 'rejected') { outcome = 'rejected'; refuse(); }
      if (!operation.receiptId) throw new UncertainActionError();
      outcome = 'accepted';
      return { submissionId: operation.receiptId };
    } catch (error) {
      // Preparation has no worker reservation or write until dispatch begins.
      // Generic idle/history/parity/authority failures here are definitive
      // refusals, so control must not tell the caller that input was uncertain.
      // Once dispatch begins, preserve unknown and any actual durable receipt.
      if (outcome === 'rejected') refuse();
      throw error;
    } finally {
      lease.finish(outcome);
      if (outcome !== 'unknown') this.#leases.delete(command.operationId);
    }
  }
}
