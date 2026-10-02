import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NativeStockAdmission, StockAddNotWritten,
  type StockAdmissionQualification } from '../codex/native-stock-admission.js';
import { NativeStockQueueJournal, type NativeStockQueueQuiescence } from '../codex/native-stock-queue-journal.js';
import { prepareNativeStockTextEntry, type NativeStockTextQualification } from '../codex/native-stock-text-entry.js';
import type { JsonObject as StrictJsonObject } from '../codex/homogeneous-queue-policy.js';
import type { WorkerCommand, WorkerCommandResponse } from '../codex/managed-worker-command-dispatcher.js';
import type { IpcIncomingRequest } from './ipc-client.js';

type JsonObject = Record<string, unknown>;
type Qualification = NativeStockTextQualification & StockAdmissionQualification;
type Entry = JsonObject & { id: string };
export type ManagedNativeStockPublish = ConstructorParameters<typeof NativeStockAdmission<Entry, Qualification>>[0]['publish'];
type Publish = ManagedNativeStockPublish;
type Host = { executeCommandWithResponse(controlKey: object, command: WorkerCommand,
  beforeWrite?: () => void): Promise<WorkerCommandResponse> };
export interface ManagedNativeStockQueueAdapterOptions {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly sourceGeneration: string;
  readonly journalPath: string;
  readonly controlKey: object;
  readonly host: Host;
  /** Must prove this native FWE queue began empty under controlled creation;
   * stock thread/queue/list alone is insufficient. Required even for [] replay. */
  readonly assertInitialNativeQueueBaseline: (scope: { taskId: string; ownerEpoch: string;
    backendGeneration: number; sourceGeneration: string }) => boolean | Promise<boolean>;
  /** Qualified same-worker, homogeneous settings; never inferred from native entry. */
  readonly qualify: (scope: { taskId: string; ownerEpoch: string; entry: Entry | null }) =>
    Qualification | Promise<Qualification>;
  readonly confirmOwner: (scope: { taskId: string; ownerEpoch: string }) => boolean | Promise<boolean>;
  readonly assertOwnerCurrent: (scope: { taskId: string; ownerEpoch: string }) => boolean;
  /** Must include live generation and semantic settings/queue fence. */
  readonly assertDispatchCurrent: (scope: { taskId: string; ownerEpoch: string;
    effectiveSettings: JsonObject }) => boolean;
  /** Native v2 queue-state publisher, not a stock queue notification. */
  readonly publish: Publish;
  /** Advances caller-owned semantic queue fence; triggers qualified reread. */
  readonly onStockQueueChanged: () => void;
  /** Retire the native route if an early authoritative item cannot be mapped. */
  readonly onFailure: (reason: 'early-user-message-unattributed' |
    'early-user-message-before-dispatch' | 'not-written-persistence-failed' |
    'not-written-user-message-conflict') => void;
}

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
type QueueRefusalCode = 'request-shape' | 'baseline' | 'owner-fence' | 'other';
export class ManagedNativeQueueRefusal extends TypeError {
  constructor(readonly code: QueueRefusalCode) {
    super('Managed native stock queue request refused');
  }
}
function fail(code: QueueRefusalCode = 'other'): never { throw new ManagedNativeQueueRefusal(code); }
function strictJson(value: unknown): JsonObject {
  if (!object(value)) fail();
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > 32 * 1024 * 1024 ||
        !isDeepStrictEqual(value, JSON.parse(encoded))) fail();
    return JSON.parse(encoded) as JsonObject;
  } catch { return fail(); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Stable UUID solely for the same-host command journal; the native entry ID
 * remains the stock clientUserMessageId and native journal operation identity. */
export function managedStockCommandId(ownerEpoch: string, taskId: string, nativeEntryId: string): string {
  if (![ownerEpoch, taskId, nativeEntryId].every(value => typeof value === 'string' && value.length > 0)) fail();
  const bytes = createHash('sha256').update('vkodex-native-stock-queue-add-v1\0')
    .update(JSON.stringify([ownerEpoch, taskId, nativeEntryId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Opt-in bridge for the previously qualified homogeneous plain-text subset.
 * It does not attach to NativeOwner or authorize a follower by itself. */
export class ManagedNativeStockQueueAdapter {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly #journal: NativeStockQueueJournal;
  readonly #admission: NativeStockAdmission<Entry, Qualification>;
  readonly #assertInitialNativeQueueBaseline: ManagedNativeStockQueueAdapterOptions['assertInitialNativeQueueBaseline'];
  readonly #onStockQueueChanged: () => void;
  readonly #onFailure: ManagedNativeStockQueueAdapterOptions['onFailure'];
  readonly #baselineScope: Readonly<{ taskId: string; ownerEpoch: string;
    backendGeneration: number; sourceGeneration: string }>;
  readonly #pendingClaims = new Map<string, number>();
  readonly #earlyItems = new Map<string, { turnId: string; assertEventCurrent: () => boolean }>();
  #closed = false;
  #faulted = false;

  #fault(reason: Parameters<ManagedNativeStockQueueAdapterOptions['onFailure']>[0]): void {
    if (this.#faulted) return;
    this.#faulted = true;
    try { this.#onFailure(reason); } catch { /* fail closed */ }
  }

  constructor(options: ManagedNativeStockQueueAdapterOptions) {
    if (!options || typeof options.taskId !== 'string' || !options.taskId ||
        typeof options.ownerEpoch !== 'string' || !options.ownerEpoch ||
        !Number.isSafeInteger(options.backendGeneration) || options.backendGeneration < 1 ||
        typeof options.sourceGeneration !== 'string' || !options.sourceGeneration ||
        !options.controlKey || typeof options.controlKey !== 'object' ||
        !options.host || typeof options.host.executeCommandWithResponse !== 'function') fail();
    if (typeof options.assertInitialNativeQueueBaseline !== 'function' ||
        typeof options.onStockQueueChanged !== 'function' ||
        typeof options.onFailure !== 'function') fail();
    const taskId = options.taskId, ownerEpoch = options.ownerEpoch;
    const backendGeneration = options.backendGeneration, sourceGeneration = options.sourceGeneration;
    const controlKey = options.controlKey;
    const executeCommandWithResponse = options.host.executeCommandWithResponse.bind(options.host);
    const qualify = options.qualify, confirmOwner = options.confirmOwner;
    const ownerCheck = options.assertOwnerCurrent, dispatchCheck = options.assertDispatchCurrent;
    const assertOwnerCurrent = (scope: { taskId: string; ownerEpoch: string }) =>
      !this.#closed && !this.#faulted && ownerCheck(scope) === true;
    const assertDispatchCurrent = (scope: { taskId: string; ownerEpoch: string;
      effectiveSettings: JsonObject }) =>
      !this.#closed && !this.#faulted && dispatchCheck(scope) === true;
    const publish = options.publish;
    this.taskId = taskId;
    this.ownerEpoch = ownerEpoch;
    this.#assertInitialNativeQueueBaseline = options.assertInitialNativeQueueBaseline;
    this.#onStockQueueChanged = options.onStockQueueChanged;
    this.#onFailure = options.onFailure;
    this.#baselineScope = Object.freeze({ taskId, ownerEpoch, backendGeneration, sourceGeneration });
    this.#journal = new NativeStockQueueJournal({ filePath: options.journalPath,
      taskId, ownerEpoch, sourceGeneration });
    try {
      this.#admission = new NativeStockAdmission<Entry, Qualification>({
        taskId, ownerEpoch, journal: this.#journal,
        identifyEntry: entry => {
          const snapshot = strictJson(entry);
          if (typeof snapshot.id !== 'string' || !snapshot.id) fail();
          return { id: snapshot.id, fingerprint: createHash('sha256')
            .update(canonical(snapshot)).digest('hex') };
        },
        prepareEntry: (entry, qualification) => {
          const prepared = prepareNativeStockTextEntry(entry, qualification,
            taskId, ownerEpoch);
          return { input: prepared.queueAdd.input,
            forwardedUpstream: prepared.localAttribution.forwardedUpstream };
        },
        qualify, confirmOwner, assertOwnerCurrent, assertDispatchCurrent,
        onReserved: identity => {
          const early = this.#earlyItems.get(identity.opId);
          if (!early) return;
          if (early.assertEventCurrent() !== true) fail();
          this.#journal.consume({ opId: identity.opId, fingerprint: identity.fingerprint,
            turnId: early.turnId, authoritative: true });
          this.#earlyItems.delete(identity.opId);
          // The item predates our fresh stock add. Do not create a duplicate
          // submission or claim causal acceptance from this partial proof.
          this.#fault('early-user-message-before-dispatch');
          fail();
        },
        onNotWrittenPersistenceFailure: () => this.#fault('not-written-persistence-failed'),
        queueAdd: async (request, assertBeforeWrite) => {
          const command: WorkerCommand = { operationId: managedStockCommandId(ownerEpoch,
            taskId, request.clientUserMessageId), method: 'thread/queue/add',
          params: { threadId: request.threadId, clientUserMessageId: request.clientUserMessageId,
            input: structuredClone(request.input) } };
          const observed = await executeCommandWithResponse(controlKey,
            command, assertBeforeWrite);
          const operation = observed?.operation, response = observed?.response;
          const exactWorker = operation &&
            operation.ownerEpoch === ownerEpoch &&
            operation.backendGeneration === backendGeneration &&
            operation.threadId === taskId &&
            operation.operationId === command.operationId &&
            operation.method === 'thread/queue/add' &&
            operation.clientUserMessageId === request.clientUserMessageId &&
            typeof operation.fingerprint === 'string' &&
            /^[a-f0-9]{64}$/u.test(operation.fingerprint) &&
            Number.isSafeInteger(operation.revision) && operation.revision >= 1;
          if (exactWorker && operation.state === 'rejected' &&
              operation.receiptId === null && operation.rejectionCode === null &&
              response === null) {
            throw new StockAddNotWritten({ operationId: operation.operationId,
              fingerprint: operation.fingerprint, revision: operation.revision,
              backendGeneration: operation.backendGeneration });
          }
          if (!operation || operation.state !== 'accepted' || !object(response) ||
              !exactWorker ||
              !object(response.queuedSubmission) ||
              typeof response.queuedSubmission.id !== 'string' ||
              response.queuedSubmission.id !== operation.receiptId ||
              response.queuedSubmission.clientUserMessageId !== request.clientUserMessageId ||
              !Array.isArray(response.queuedSubmission.input) ||
              !isDeepStrictEqual(response.queuedSubmission.input, request.input)) fail();
          return { queuedSubmission: { id: response.queuedSubmission.id as string,
            clientUserMessageId: response.queuedSubmission.clientUserMessageId as string,
            input: response.queuedSubmission.input as StrictJsonObject[] } };
        },
        publish,
      });
    } catch (error) { this.#journal.close(); throw error; }
  }

  async accept(request: IpcIncomingRequest, assertIngressCurrent: () => boolean): Promise<{ ok: true }> {
    if (typeof assertIngressCurrent !== 'function' ||
        !object(request) || request.method !== 'thread-follower-set-queued-follow-ups-state' ||
        request.version !== 1 || request.hostId !== undefined && request.hostId !== 'local' ||
        typeof request.requestId !== 'string' || !request.requestId ||
        typeof request.sourceClientId !== 'string' || !request.sourceClientId ||
        !object(request.params) || request.params.hostId !== undefined && request.params.hostId !== 'local' ||
        request.params.conversationId !== this.taskId || !object(request.params.state) ||
        Object.keys(request.params.state).length !== 1 ||
        !Object.hasOwn(request.params.state, this.taskId) ||
        !Array.isArray(request.params.state[this.taskId])) fail('request-shape');
    if (this.#closed || this.#faulted || assertIngressCurrent() !== true) fail('owner-fence');
    // Current Desktop includes this optional field even when nothing was
    // discarded. [] is a no-op, not an upstream cancellation capability.
    // Actual discards remain unsupported until exact stock removal receipts
    // can be reconciled; never ACK or silently drop a requested cancellation.
    if (Object.hasOwn(request.params, 'discardedMessageIds') &&
        (!Array.isArray(request.params.discardedMessageIds) ||
          request.params.discardedMessageIds.length !== 0)) fail('request-shape');
    if (Object.keys(request).some(key => !['requestId', 'sourceClientId', 'hostId',
        'method', 'version', 'params'].includes(key)) ||
        Object.keys(request.params).some(key =>
          !['hostId', 'conversationId', 'state', 'discardedMessageIds'].includes(key))) fail('request-shape');
    const sourceClientId = request.sourceClientId, nativeRequestId = request.requestId;
    const snapshot = strictJson(request);
    const params = snapshot.params;
    if (!object(params) || !object(params.state) ||
        !Array.isArray(params.state[this.taskId])) fail();
    const state = params.state[this.taskId] as unknown[];
    if (state.length > 1024) fail();
    const claims = new Set<string>();
    for (const entry of state) {
      if (!object(entry) || typeof entry.id !== 'string' || !entry.id) fail();
      claims.add(entry.id);
    }
    if (this.#pendingClaims.size + claims.size > 2048) fail();
    for (const id of claims) this.#pendingClaims.set(id, (this.#pendingClaims.get(id) ?? 0) + 1);
    try {
      if (await this.#assertInitialNativeQueueBaseline(this.#baselineScope) !== true) fail('baseline');
      if (assertIngressCurrent() !== true || this.#closed || this.#faulted) fail('owner-fence');
      return await this.#admission.acceptFullState({ state: state as Entry[], ownerEpoch: this.ownerEpoch,
        sourceClientId, requestId: nativeRequestId,
        assertIngressCurrent });
    } finally {
      for (const id of claims) {
        const remaining = (this.#pendingClaims.get(id) ?? 1) - 1;
        if (remaining > 0) this.#pendingClaims.set(id, remaining);
        else {
          this.#pendingClaims.delete(id);
          if (this.#earlyItems.has(id)) {
            this.#earlyItems.delete(id);
            this.#fault('early-user-message-unattributed');
          }
        }
      }
    }
  }

  /** Return false for unrelated CLI/interagent messages; never manufacture a
   * native queue operation for an item absent from this journal. */
  async consumeUserMessage(clientId: string, turnId: string,
    assertEventCurrent: () => boolean): Promise<boolean> {
    if (this.#closed || this.#faulted || typeof clientId !== 'string' || !clientId ||
        typeof turnId !== 'string' || !turnId || typeof assertEventCurrent !== 'function') fail();
    const operation = this.#journal.readOperation(clientId);
    if (!operation) {
      if (!this.#pendingClaims.has(clientId)) return false;
      if (assertEventCurrent() !== true) fail();
      if (!this.#earlyItems.has(clientId) && this.#earlyItems.size >= 128) fail();
      const existing = this.#earlyItems.get(clientId);
      if (existing && existing.turnId !== turnId) fail();
      this.#earlyItems.set(clientId, { turnId, assertEventCurrent });
      return true;
    }
    if (operation.phase === 'not-written') {
      this.#fault('not-written-user-message-conflict');
      fail();
    }
    await this.#admission.consumeUserMessage({ taskId: this.taskId, ownerEpoch: this.ownerEpoch,
      clientId, turnId, authoritative: true, assertEventCurrent });
    return true;
  }

  async hydrateFollower(publish?: Publish): Promise<void> {
    if (this.#closed || this.#faulted) fail();
    if (await this.#assertInitialNativeQueueBaseline(this.#baselineScope) !== true ||
        this.#closed || this.#faulted) fail();
    return this.#admission.hydrateFollower(publish);
  }

  /** Owner calls this before generic native projection. Stock queue change is
   * not a native FWE snapshot, but it invalidates queue admission evidence. */
  observeBackendNotification(notification: unknown, assertEventCurrent: () => boolean): boolean {
    if (this.#closed || this.#faulted || typeof assertEventCurrent !== 'function') fail();
    if (!object(notification) || notification.method !== 'thread/queue/changed') return false;
    if (!object(notification.params) || notification.params.threadId !== this.taskId) return false;
    if (assertEventCurrent() !== true) fail();
    this.#onStockQueueChanged();
    if (assertEventCurrent() !== true) fail();
    return true;
  }

  /** Refuses local ingress claims and unattributed early items even when the
   * durable journal happens to have no unresolved row yet. */
  quiescence(): NativeStockQueueQuiescence {
    if (this.#closed || this.#faulted || this.#pendingClaims.size !== 0 ||
        this.#earlyItems.size !== 0) fail();
    return this.#journal.quiescence();
  }

  close(): void { if (!this.#closed) { this.#closed = true; this.#journal.close(); } }
}
