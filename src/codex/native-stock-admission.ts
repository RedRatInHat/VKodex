// Isolated contract prototype: native full-state admission through stock queue/add.
// No worker launch, native IPC implementation, scheduler, turn/start, or queue/start.
import { isDeepStrictEqual } from 'node:util';
import { classifyNativeQueueState, type QueueEntryIdentity } from './native-queue-state.js';
import type { JsonObject } from './homogeneous-queue-policy.js';
import type { NativeStockQueueJournal, PositiveReconciliationProof, StockQueueOperation } from './native-stock-queue-journal.js';

export interface StockAdmissionQualification {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly confirmed: true;
  readonly effectiveSettings: unknown;
}
export interface PreparedStockEntry { readonly input: readonly unknown[]; readonly forwardedUpstream: unknown }
export interface StockQueuedSubmission { readonly id: string; readonly clientUserMessageId: string;
  readonly input: readonly JsonObject[] }
/** Only the worker's durable final before-write refusal may construct this.
 * It carries identity metadata, never prompt content or a synthetic receipt. */
export class StockAddNotWritten extends Error {
  constructor(readonly worker: Readonly<{ operationId: string; fingerprint: string;
    revision: number; backendGeneration: number }>) {
    super('stock queue/add was not written');
  }
}
type OwnerScope = { readonly taskId: string; readonly ownerEpoch: string };
type DispatchScope = OwnerScope & { readonly effectiveSettings: JsonObject };
export interface NativeStockAdmissionDependencies<Entry extends { readonly id: string },
  Qualification extends StockAdmissionQualification> extends OwnerScope {
  readonly journal: NativeStockQueueJournal;
  readonly identifyEntry: (entry: Entry) => QueueEntryIdentity;
  readonly prepareEntry: (entry: Entry, qualification: Qualification) => PreparedStockEntry | Promise<PreparedStockEntry>;
  readonly qualify: (scope: OwnerScope & { readonly entry: Entry | null }) => Qualification | Promise<Qualification>;
  readonly confirmOwner: (scope: OwnerScope) => boolean | Promise<boolean>;
  readonly assertOwnerCurrent: (scope: OwnerScope) => boolean;
  readonly assertDispatchCurrent: (scope: DispatchScope) => boolean;
  readonly queueAdd: (request: { readonly threadId: string; readonly clientUserMessageId: string;
    readonly input: readonly JsonObject[] }, assertBeforeWrite: () => void) => { readonly queuedSubmission?: StockQueuedSubmission } |
    Promise<{ readonly queuedSubmission?: StockQueuedSubmission }>;
  /** Synchronous hook after durable reserve, before dispatch, for an item
   * observed during asynchronous qualification. Throw leaves a reserved intent. */
  readonly onReserved?: (identity: Readonly<{ opId: string; fingerprint: string }>) => void;
  readonly onNotWrittenPersistenceFailure?: () => void;
  readonly publish: (messages: readonly JsonObject[], metadata: {
    readonly kind: 'outbox' | 'hydrate'; readonly version?: number;
    readonly taskVersion?: number; readonly taskId: string; readonly ownerEpoch: string;
  }) => void | Promise<void>;
}
interface Flight<Entry> { readonly opId: string; readonly fingerprint: string;
  readonly reservedVersion: number; readonly sourceClientId: string | null;
  readonly requestId: string | null;
  readonly incoming: readonly QueueEntryIdentity[]; readonly entry: Entry;
  readonly ingressCurrent: () => void; readonly effectiveSettings: JsonObject;
  readonly input: readonly JsonObject[]; readonly promise: Promise<{ ok: true }>;
  readonly resolve: (value: { ok: true }) => void; readonly reject: (error: unknown) => void }
type Plan<Entry> = { readonly kind: 'replay' } | { readonly kind: 'join'; readonly promise: Promise<{ ok: true }> } |
  { readonly kind: 'dispatch'; readonly flight: Flight<Entry> };
const fail = (reason: string): never => { throw new Error(`Native repeated admission refused: ${reason}`); };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const clone = <T>(value: T): T => structuredClone(value);
function asJsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail('non-JSON qualification or native entry');
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { fail('non-JSON qualification or native entry'); }
  if (encoded === undefined) fail('non-JSON qualification or native entry');
  const parsed: unknown = JSON.parse(encoded ?? fail('non-JSON qualification or native entry'));
  if (!isDeepStrictEqual(value, parsed)) fail('non-JSON qualification or native entry');
  return parsed as JsonObject;
}

export class NativeStockAdmission<Entry extends { readonly id: string },
  Qualification extends StockAdmissionQualification> {
  readonly taskId: string;
  readonly ownerEpoch: string;
  private readonly journal: NativeStockQueueJournal;
  private readonly identifyEntry: NativeStockAdmissionDependencies<Entry, Qualification>['identifyEntry'];
  private readonly prepareEntry: NativeStockAdmissionDependencies<Entry, Qualification>['prepareEntry'];
  private readonly qualify: NativeStockAdmissionDependencies<Entry, Qualification>['qualify'];
  private readonly confirmOwner: NativeStockAdmissionDependencies<Entry, Qualification>['confirmOwner'];
  private readonly assertOwnerCurrent: NativeStockAdmissionDependencies<Entry, Qualification>['assertOwnerCurrent'];
  private readonly assertDispatchCurrent: NativeStockAdmissionDependencies<Entry, Qualification>['assertDispatchCurrent'];
  private readonly queueAdd: NativeStockAdmissionDependencies<Entry, Qualification>['queueAdd'];
  private readonly onReserved: NativeStockAdmissionDependencies<Entry, Qualification>['onReserved'];
  private readonly onNotWrittenPersistenceFailure:
    NativeStockAdmissionDependencies<Entry, Qualification>['onNotWrittenPersistenceFailure'];
  private readonly publish: NativeStockAdmissionDependencies<Entry, Qualification>['publish'];
  private taskTail: Promise<unknown> = Promise.resolve();
  private publicationTail: Promise<unknown> = Promise.resolve();
  private inFlight: Flight<Entry> | null = null;

  constructor({ taskId, ownerEpoch, journal, identifyEntry, prepareEntry,
    qualify, confirmOwner, assertOwnerCurrent, assertDispatchCurrent, queueAdd, onReserved,
    onNotWrittenPersistenceFailure, publish }:
    NativeStockAdmissionDependencies<Entry, Qualification>) {
    if (!nonempty(taskId) || !nonempty(ownerEpoch) || !journal ||
        ![identifyEntry, prepareEntry, qualify, confirmOwner, assertOwnerCurrent,
          assertDispatchCurrent, queueAdd, publish]
          .every(value => typeof value === 'function') ||
        onReserved !== undefined && typeof onReserved !== 'function' ||
        onNotWrittenPersistenceFailure !== undefined &&
          typeof onNotWrittenPersistenceFailure !== 'function') fail('dependencies required');
    if (journal.taskId !== taskId || journal.ownerEpoch !== ownerEpoch) fail('journal scope differs');
    this.taskId = taskId; this.ownerEpoch = ownerEpoch; this.journal = journal;
    this.identifyEntry = identifyEntry; this.prepareEntry = prepareEntry; this.qualify = qualify;
    this.confirmOwner = confirmOwner; this.assertOwnerCurrent = assertOwnerCurrent;
    this.assertDispatchCurrent = assertDispatchCurrent; this.queueAdd = queueAdd; this.publish = publish;
    this.onReserved = onReserved;
    this.onNotWrittenPersistenceFailure = onNotWrittenPersistenceFailure;
  }

  private task<T>(fn: () => T | Promise<T>): Promise<T> {
    const work = this.taskTail.then(fn);
    this.taskTail = work.catch(() => {});
    return work;
  }
  private publication<T>(fn: () => T | Promise<T>): Promise<T> {
    const work = this.publicationTail.then(fn);
    this.publicationTail = work.catch(() => {});
    return work;
  }

  private identities(entries: readonly Entry[]): QueueEntryIdentity[] {
    if (!Array.isArray(entries)) fail('full native state array required');
    return entries.map(entry => {
      const row = this.identifyEntry(entry);
      if (!row || row.id !== entry?.id) fail('entry identity differs');
      return row;
    });
  }

  private async ownerConfirmed(): Promise<void> {
    if (await this.confirmOwner({ taskId: this.taskId, ownerEpoch: this.ownerEpoch }) !== true) {
      fail('owner not confirmed');
    }
  }

  private ownerCurrent(): void {
    if (this.assertOwnerCurrent({ taskId: this.taskId, ownerEpoch: this.ownerEpoch }) !== true) {
      fail('owner source changed');
    }
  }

  private async qualified(entry: Entry | null): Promise<{ qualification: Qualification;
    settings: JsonObject; evidence: JsonObject }> {
    const result = await this.qualify({ taskId: this.taskId, ownerEpoch: this.ownerEpoch, entry });
    if (!result || result.taskId !== this.taskId || result.ownerEpoch !== this.ownerEpoch ||
        result.confirmed !== true || !result.effectiveSettings) {
      fail('unconfirmed homogeneous qualification');
    }
    const settings = asJsonObject(result.effectiveSettings);
    const evidence = asJsonObject(result);
    const durable = this.journal.readTask().effectiveSettings;
    if (durable !== null && !isDeepStrictEqual(durable, settings)) {
      fail('effective settings changed');
    }
    return { qualification: result, settings, evidence };
  }

  private readClassification(incoming: readonly QueueEntryIdentity[]) {
    const initial = this.journal.readTask();
    const currentPending: QueueEntryIdentity[] = [];
    let cursor = 0;
    for (;;) {
      const page = this.journal.pendingPage({ afterSeq: cursor, limit: 100 });
      if (page.taskVersion !== initial.version) fail('pending snapshot changed');
      currentPending.push(...page.items.map(op => ({ id: op.opId, fingerprint: op.fingerprint })));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    const found: NonNullable<ReturnType<NativeStockQueueJournal['lookupIncomingIdentities']>['items'][number]>[] = [];
    for (let start = 0; start < incoming.length; start += 500) {
      const batch = this.journal.lookupIncomingIdentities({ ids: incoming.slice(start, start + 500).map(row => row.id) });
      if (batch.taskVersion !== initial.version) fail('identity snapshot changed');
      found.push(...batch.items.filter(row => row !== null));
    }
    if (this.journal.readTask().version !== initial.version) fail('classification snapshot changed');
    const consumed = found.filter(row => row.consumed).sort((a, b) => a.seq - b.seq)
      .map(row => ({ id: row.id, fingerprint: row.fingerprint }));
    return { version: initial.version,
      classification: classifyNativeQueueState({ currentPending, consumed, incoming }) };
  }

  async acceptFullState({ state, ownerEpoch = this.ownerEpoch, assertIngressCurrent = null,
    sourceClientId = null, requestId = null }: {
    state: readonly Entry[]; ownerEpoch?: string; assertIngressCurrent?: (() => boolean) | null;
    sourceClientId?: string | null; requestId?: string | null;
  }): Promise<{ ok: true }> {
    if (ownerEpoch !== this.ownerEpoch) fail('owner epoch mismatch');
    if (assertIngressCurrent !== null && typeof assertIngressCurrent !== 'function') {
      fail('request ingress fence must be synchronous callback');
    }
    const ingressCurrent = () => {
      if (assertIngressCurrent !== null && assertIngressCurrent() !== true) fail('request ingress changed');
    };
    const entries = clone(state);
    const incoming = this.identities(entries);
    const plan: Plan<Entry> = await this.task(async (): Promise<Plan<Entry>> => {
      await this.ownerConfirmed();
      if (this.inFlight) {
        if (!isDeepStrictEqual(this.inFlight.incoming, incoming)) fail('another stock add is unresolved');
        const { settings } = await this.qualified(entries.at(-1) ?? null);
        if (!isDeepStrictEqual(this.inFlight.effectiveSettings, settings)) {
          fail('in-flight effective settings changed');
        }
        this.ownerCurrent();
        ingressCurrent();
        return { kind: 'join', promise: this.inFlight.promise };
      }
      const { version, classification } = this.readClassification(incoming);
      if (classification.kind === 'replay') {
        this.journal.confirmReplay({ expectedVersion: version, ownerEpoch: this.ownerEpoch });
        this.ownerCurrent();
        ingressCurrent();
        return { kind: 'replay' };
      }
      const entry = entries.find(value => value.id === classification.newId) ?? fail('new entry missing');
      const { qualification, settings, evidence } = await this.qualified(entry);
      const prepared = await this.prepareEntry(entry, qualification);
      if (!prepared || !Array.isArray(prepared.input) || !prepared.forwardedUpstream) {
        fail('native entry preparation incomplete');
      }
      const stockInput = prepared.input.map(asJsonObject);
      const forwardedUpstream = asJsonObject(prepared.forwardedUpstream);
      // Qualify/prepare may have awaited a worker read; reserve CAS closes that race.
      this.ownerCurrent();
      ingressCurrent();
      this.journal.reserve({ expectedVersion: version, opId: classification.newId,
        fingerprint: incoming.find(row => row.id === classification.newId)?.fingerprint ?? fail('new fingerprint absent'),
        nativeEntry: asJsonObject(entry), effectiveSettings: settings,
        admissionEvidence: evidence,
        stockInput, forwardedUpstream });
      this.onReserved?.({ opId: classification.newId,
        fingerprint: incoming.find(row => row.id === classification.newId)?.fingerprint ?? fail('new fingerprint absent') });
      if (this.journal.readOperation(classification.newId)?.consumed) {
        fail('entry consumed before stock dispatch');
      }
      let resolve!: Flight<Entry>['resolve'], reject!: Flight<Entry>['reject'];
      const promise = new Promise<{ ok: true }>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      const flight: Flight<Entry> = { opId: classification.newId,
        fingerprint: incoming.find(row => row.id === classification.newId)?.fingerprint ?? fail('new fingerprint absent'),
        reservedVersion: version + 1,
        sourceClientId, requestId,
        incoming, entry, ingressCurrent, effectiveSettings: clone(settings),
        input: clone(stockInput), promise, resolve, reject };
      this.inFlight = flight;
      return { kind: 'dispatch', flight };
    });
    if (plan.kind === 'replay') { this.ownerCurrent(); ingressCurrent(); return { ok: true }; }
    if (plan.kind === 'dispatch') void this.dispatch(plan.flight);
    const result = await (plan.kind === 'dispatch' ? plan.flight.promise : plan.promise);
    this.ownerCurrent();
    ingressCurrent();
    return result;
  }

  private async dispatch(flight: Flight<Entry>): Promise<void> {
    let queued: StockQueuedSubmission | undefined;
    try {
      await this.ownerConfirmed();
      const { settings } = await this.qualified(flight.entry);
      if (!isDeepStrictEqual(settings, flight.effectiveSettings)) {
        fail('post-reserve effective settings changed');
      }
      // This synchronous generation/revision fence is adjacent to the call.
      // A failed predispatch check leaves a durable reserved intent for review.
      if (this.assertDispatchCurrent({ taskId: this.taskId, ownerEpoch: this.ownerEpoch,
        effectiveSettings: flight.effectiveSettings }) !== true) fail('dispatch fence changed');
      flight.ingressCurrent();
    } catch (error) {
      await this.task(() => { if (this.inFlight === flight) this.inFlight = null; });
      flight.reject(error);
      return;
    }
    try {
      const response = await this.queueAdd({ threadId: this.taskId,
        clientUserMessageId: flight.opId, input: clone(flight.input) }, () => {
        if (this.journal.readOperation(flight.opId)?.consumed) fail('entry consumed before stock write');
        this.ownerCurrent();
        if (this.assertDispatchCurrent({ taskId: this.taskId, ownerEpoch: this.ownerEpoch,
          effectiveSettings: flight.effectiveSettings }) !== true) fail('dispatch fence changed');
        flight.ingressCurrent();
      });
      queued = response?.queuedSubmission;
      if (!queued || !nonempty(queued.id) || queued.clientUserMessageId !== flight.opId ||
          !isDeepStrictEqual(queued.input, flight.input)) return fail('stock queue/add receipt uncertain');
    } catch (error) {
      if (error instanceof StockAddNotWritten) await this.finishNotWritten(flight, error);
      else await this.finishUnknown(flight, error);
      return;
    }
    try {
      await this.task(() => {
        this.journal.markAccepted({ opId: flight.opId,
          fingerprint: flight.fingerprint, stockId: queued.id,
          input: queued.input, sourceGeneration: this.journal.sourceGeneration,
          clientUserMessageId: queued.clientUserMessageId, threadId: this.taskId,
          assertSourceCurrent: () => {
            this.ownerCurrent();
            return true;
          } });
        if (this.inFlight === flight) this.inFlight = null;
      });
      // Publisher has its own serial writer. Failure leaves durable outbox;
      // accepted native queue state does not become an unknown stock add.
      try { await this.publishLatest(); } catch { /* durable publication remains pending */ }
      await this.ownerConfirmed();
      this.ownerCurrent();
      flight.resolve({ ok: true });
    } catch (error) {
      // A stock receipt can be known while local persistence/owner proof fails.
      // Do not dispatch again; leave reserved/accepted evidence for review.
      if (this.inFlight === flight) this.inFlight = null;
      flight.reject(error);
    }
  }

  private async finishUnknown(flight: Flight<Entry>, error: unknown): Promise<void> {
    try {
      await this.task(() => {
        this.journal.markUnknown({ opId: flight.opId, fingerprint: flight.fingerprint });
        if (this.inFlight === flight) this.inFlight = null;
      });
      flight.reject(new Error('stock queue/add outcome unknown; no replay', { cause: error }));
    } catch (persistError) {
      if (this.inFlight === flight) this.inFlight = null;
      flight.reject(new Error('stock outcome and unknown-intent persistence need review', { cause: persistError }));
    }
  }

  private async finishNotWritten(flight: Flight<Entry>, error: StockAddNotWritten): Promise<void> {
    try {
      await this.task(() => {
        const sourceClientId = flight.sourceClientId ?? fail('native source attribution required');
        const requestId = flight.requestId ?? fail('native request attribution required');
        if (!nonempty(sourceClientId) || !nonempty(requestId))
          fail('native source attribution required for not-written proof');
        this.journal.markNotWritten({ expectedVersion: flight.reservedVersion,
          opId: flight.opId, fingerprint: flight.fingerprint,
          sourceClientId, requestId,
          workerOperationId: error.worker.operationId,
          workerFingerprint: error.worker.fingerprint,
          workerRevision: error.worker.revision,
          backendGeneration: error.worker.backendGeneration });
        if (this.inFlight === flight) this.inFlight = null;
      });
      flight.reject(error);
    } catch (persistError) {
      if (this.inFlight === flight) this.inFlight = null;
      try { this.onNotWrittenPersistenceFailure?.(); } catch { /* still reject the native request */ }
      flight.reject(new Error('not-written proof persistence needs review', { cause: persistError }));
    }
  }

  // The adapter must collect authoritative same-generation proof, never infer
  // acceptance from queue absence. This seam performs no dispatch or retry.
  async reconcileOutcome({ opId, readProof, assertProofCurrent }: {
    opId: string;
    readProof: (operation: StockQueueOperation) => Promise<PositiveReconciliationProof | null>;
    assertProofCurrent: (proof: PositiveReconciliationProof) => boolean;
  }): Promise<{ reconciled: boolean }> {
    if (!nonempty(opId) || typeof readProof !== 'function' || typeof assertProofCurrent !== 'function') {
      fail('reconciliation dependencies required');
    }
    const result = await this.task(async () => {
      // Do not compete with a still-live RPC. Once it settles, its durable
      // unknown/reserved record can be recovered without running it twice.
      if (this.inFlight) fail('stock add still in flight');
      await this.ownerConfirmed();
      this.ownerCurrent();
      const version = this.journal.readTask().version;
      const op = this.journal.readOperation(opId) ?? fail('reconciliation operation absent');
      const observed = await readProof(op);
      this.ownerCurrent();
      if (observed === null) return { reconciled: false };
      const proof = clone(observed);
      if (proof.clientUserMessageId !== opId) fail('reconciliation operation differs');
      this.journal.reconcilePositive({ expectedVersion: version, proof,
        assertSourceCurrent: () => {
          this.ownerCurrent();
          return assertProofCurrent(proof) === true;
        } });
      return { reconciled: true };
    });
    // Publication has its own writer and durable retry checkpoint. Never wait
    // for it while holding the task gate used by publication acknowledgments.
    if (result.reconciled) {
      try { await this.publishLatest(); } catch { /* accepted proof stays durable */ }
    }
    return result;
  }

  async consumeUserMessage({ taskId, ownerEpoch, clientId, turnId, authoritative,
    assertEventCurrent = null }: OwnerScope & {
    clientId: string; turnId: string; authoritative: boolean;
    assertEventCurrent?: (() => boolean) | null;
  }): Promise<{ consumed: true }> {
    if (taskId !== this.taskId || ownerEpoch !== this.ownerEpoch ||
        !nonempty(clientId) || !nonempty(turnId) || authoritative !== true) fail('unqualified worker event');
    if (assertEventCurrent !== null && typeof assertEventCurrent !== 'function') {
      fail('worker event fence must be synchronous callback');
    }
    const eventCurrent = () => {
      if (assertEventCurrent !== null && assertEventCurrent() !== true) fail('worker event source changed');
    };
    eventCurrent();
    return this.task(async () => {
      eventCurrent();
      await this.ownerConfirmed();
      this.ownerCurrent();
      eventCurrent();
      const op = this.journal.readOperation(clientId) ?? fail('worker event has no durable operation');
      eventCurrent();
      this.journal.consume({ opId: clientId, fingerprint: op.fingerprint, turnId, authoritative: true });
      // Do not wait for an in-flight native send: it may itself await this
      // authoritative event. The separate writer preserves publication order.
      void this.publishLatest().catch(() => {});
      return { consumed: true as const };
    });
  }

  private readQueuePages(kind: 'outbox' | 'current', version: number): JsonObject[] {
    const messages: JsonObject[] = [];
    let cursor = 0;
    for (;;) {
      const page = kind === 'outbox'
        ? this.journal.publicationPage({ version, afterSeq: cursor, limit: 100 })
        : this.journal.currentQueuePage({ expectedVersion: version, afterSeq: cursor, limit: 100 });
      messages.push(...page.items.map(item => item.nativeEntry));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    return messages;
  }

  publishLatest(): Promise<void> {
    return this.publication(async () => {
      for (;;) {
        const status = this.journal.publicationStatus();
        if (!status.pending) return;
        const messages = this.readQueuePages('outbox', status.version);
        if (this.journal.publicationStatus().version !== status.version) continue;
        await this.ownerConfirmed();
        this.ownerCurrent();
        if (this.journal.publicationStatus().version !== status.version) continue;
        await this.publish(messages, { kind: 'outbox', version: status.version,
          taskId: this.taskId, ownerEpoch: this.ownerEpoch });
        await this.ownerConfirmed();
        await this.task(() => {
          this.ownerCurrent();
          this.journal.acknowledgePublication({ version: status.version });
        });
      }
    });
  }

  hydrateFollower(publish: NativeStockAdmissionDependencies<Entry, Qualification>['publish'] = this.publish): Promise<void> {
    return this.publication(async () => {
      const version = this.journal.readTask().version;
      const messages = this.readQueuePages('current', version);
      if (this.journal.readTask().version !== version) fail('hydration snapshot changed');
      await this.ownerConfirmed();
      this.ownerCurrent();
      if (this.journal.readTask().version !== version) fail('hydration snapshot changed');
      await publish(messages, { kind: 'hydrate', taskVersion: version,
        taskId: this.taskId, ownerEpoch: this.ownerEpoch });
    });
  }
}
