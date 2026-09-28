import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { AppServerConnection, AppServerResponseEnvelope } from './app-server-connection.js';
import { ManagedWorkerOperationJournal } from './managed-worker-operation-journal.js';
import type { WorkerOperation, WorkerMutationMethod, SettingsOperation } from './managed-worker-operation-journal.js';
import type { HomogeneousQueueSettings } from './homogeneous-queue-policy.js';

type JsonObject = Record<string, unknown>;
export interface WorkerCommand {
  readonly operationId: string;
  readonly method: WorkerMutationMethod;
  readonly params: JsonObject;
}
export interface SettingsCommand {
  readonly operationId: string;
  readonly method: 'thread/settings/update';
  readonly params: JsonObject;
}
export interface WorkerCommandScope {
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly threadId: string;
}
/** The response is a copy of the actual native result, or null when unavailable. */
export interface WorkerCommandResponse {
  readonly operation: WorkerOperation;
  readonly response: JsonObject | null;
}
export interface WorkerCommandQuiescence {
  readonly inFlight: number;
  readonly unconfirmed: boolean;
}
export interface WorkerCommandPolicy {
  readonly controlKey: object;
  readonly ownerEpoch: string;
  readonly journalPath: string;
  readonly fingerprintKey: Uint8Array;
  /** Must establish actual authority and the method's full settings/queue policy.
   * A matching directory, registry reservation or task ID alone is insufficient. */
  readonly authorize: (context: Readonly<WorkerCommandScope & WorkerCommand>) => boolean;
  /** Separate opt-in. Absence denies every settings write. */
  readonly authorizeSettings?: (context: Readonly<WorkerCommandScope & SettingsCommand>) => boolean;
  /** Trusted same-host observer. Its synchronous verifier fences a notification
   * revision immediately before durable confirmation. No observer is installed by default. */
  readonly qualifySettingsEffect?: (context: Readonly<WorkerCommandScope & SettingsCommand>,
    assertCurrent: () => void) => Promise<Readonly<{ effectiveSettings: HomogeneousQueueSettings;
      assertCurrent: () => void }>>;
  readonly isOwnerCurrent: (scope: Readonly<WorkerCommandScope>) => boolean;
}
type Backend = Pick<AppServerConnection, 'request' | 'isSessionCurrent'>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function snapshot(command: WorkerCommand): Readonly<WorkerCommand> {
  if (!object(command) || !uuid.test(command.operationId) ||
      (command.method !== 'turn/start' && command.method !== 'thread/queue/add') ||
      !object(command.params)) throw new TypeError('Invalid worker command');
  try {
    const copy = structuredClone(command);
    const encoded = JSON.stringify(copy);
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024 ||
        !isDeepStrictEqual(copy, JSON.parse(encoded))) throw new Error();
    if (Object.keys(copy).some(key => !['operationId', 'method', 'params'].includes(key))) throw new Error();
    return freeze(copy);
  } catch { throw new TypeError('Worker command must be bounded strict JSON'); }
}
function snapshotSettings(command: SettingsCommand): Readonly<SettingsCommand> {
  if (!object(command) || !uuid.test(command.operationId) ||
      command.method !== 'thread/settings/update' || !object(command.params))
    throw new TypeError('Invalid settings command');
  try {
    const copy = structuredClone(command);
    const encoded = JSON.stringify(copy);
    const allowed = ['threadId', 'disabledPluginIds', 'cwd', 'approvalPolicy',
      'approvalsReviewer', 'sandboxPolicy', 'permissions', 'model', 'serviceTier',
      'effort', 'summary', 'collaborationMode', 'multiAgentMode', 'personality'];
    if (Buffer.byteLength(encoded) > 1024 * 1024 ||
        !isDeepStrictEqual(copy, JSON.parse(encoded)) ||
        Object.keys(copy).some(key => !['operationId', 'method', 'params'].includes(key)) ||
        Object.keys(copy.params).some(key => !allowed.includes(key)) ||
        typeof copy.params.threadId !== 'string' ||
        typeof copy.params.model !== 'string' || !copy.params.model ||
        copy.params.effort !== null && typeof copy.params.effort !== 'string') throw new Error();
    return freeze(copy);
  } catch { throw new TypeError('Settings command must be bounded strict JSON'); }
}
const effectiveKeys = ['cwd', 'runtimeWorkspaceRoots', 'approvalPolicy', 'approvalsReviewer',
  'permissions', 'sandboxPolicy', 'model', 'serviceTier', 'effort', 'summary',
  'collaborationMode', 'personality'];
function strictJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || depth > 32 || seen.has(value))
    throw new TypeError('Effective settings must be strict JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1 ||
          Object.keys(value).length !== value.length ||
          Array.from({ length: value.length }, (_, index) => !Object.hasOwn(value, index)).some(Boolean))
        throw new TypeError('Effective settings must be strict JSON');
      for (const item of value) strictJson(item, seen, depth + 1);
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype ||
          Reflect.ownKeys(value).length !== Object.keys(value).length ||
          Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
            ['__proto__', 'prototype', 'constructor'].includes(key)))
        throw new TypeError('Effective settings must be strict JSON');
      for (const item of Object.values(value)) strictJson(item, seen, depth + 1);
    }
  } finally { seen.delete(value); }
}
function snapshotEffectiveSettings(value: unknown): Readonly<HomogeneousQueueSettings> {
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('|') !== [...effectiveKeys].sort().join('|') ||
      typeof value.cwd !== 'string' || !value.cwd ||
      !Array.isArray(value.runtimeWorkspaceRoots) ||
      value.runtimeWorkspaceRoots.some(root => typeof root !== 'string' || !root) ||
      typeof value.model !== 'string' || !value.model ||
      !(value.permissions === null || typeof value.permissions === 'string' && !!value.permissions) ||
      !object(value.sandboxPolicy) || Object.getPrototypeOf(value.sandboxPolicy) !== Object.prototype)
    throw new TypeError('Incomplete effective settings');
  try {
    strictJson(value);
    const copy = structuredClone(value);
    const encoded = JSON.stringify(copy);
    if (Buffer.byteLength(encoded) > 1024 * 1024 ||
        !isDeepStrictEqual(copy, JSON.parse(encoded))) throw new Error();
    return freeze(copy as unknown as HomogeneousQueueSettings);
  } catch { throw new TypeError('Effective settings must be bounded strict JSON'); }
}

/** Copies policy before worker launch. Key bytes never enter journal/metadata. */
export function captureWorkerCommandPolicy(policy: WorkerCommandPolicy): WorkerCommandPolicy {
  if (!policy || !policy.controlKey || typeof policy.controlKey !== 'object' ||
      typeof policy.ownerEpoch !== 'string' || !uuid.test(policy.ownerEpoch) ||
      typeof policy.journalPath !== 'string' || !path.isAbsolute(policy.journalPath) ||
      !(policy.fingerprintKey instanceof Uint8Array) || policy.fingerprintKey.byteLength < 32 ||
      policy.fingerprintKey.byteLength > 128 || typeof policy.authorize !== 'function' ||
      (policy.authorizeSettings !== undefined && typeof policy.authorizeSettings !== 'function') ||
      (policy.qualifySettingsEffect !== undefined && typeof policy.qualifySettingsEffect !== 'function') ||
      typeof policy.isOwnerCurrent !== 'function') throw new TypeError('Explicit worker command policy required');
  return Object.freeze({ controlKey: policy.controlKey, ownerEpoch: policy.ownerEpoch,
    journalPath: policy.journalPath, fingerprintKey: Buffer.from(policy.fingerprintKey),
    authorize: policy.authorize,
    ...(policy.authorizeSettings ? { authorizeSettings: policy.authorizeSettings } : {}),
    ...(policy.qualifySettingsEffect ? { qualifySettingsEffect: policy.qualifySettingsEffect } : {}),
    isOwnerCurrent: policy.isOwnerCurrent });
}

/** Owner control API, NOT a synthetic native RPC response or a scheduler. */
export class ManagedWorkerCommandDispatcher {
  readonly #policy: WorkerCommandPolicy;
  readonly #scope: Readonly<WorkerCommandScope>;
  readonly #journal: ManagedWorkerOperationJournal;
  readonly #inFlight = new Map<string, Promise<WorkerOperation>>();
  readonly #settingsInFlight = new Map<string, Promise<SettingsOperation>>();
  readonly #responses = new Map<string, { receiptId: string; value: JsonObject; bytes: number }>();
  #responseBytes = 0;
  #closed = false;
  #checkingPolicy = false;
  #confirmingSettings = false;
  #confirmationInFlight: Promise<SettingsOperation> | null = null;

  constructor(readonly backend: Backend, threadId: string, backendGeneration: number,
    policy: WorkerCommandPolicy, readonly canExecute: () => boolean) {
    this.#policy = captureWorkerCommandPolicy(policy);
    this.#scope = Object.freeze({ ownerEpoch: policy.ownerEpoch, backendGeneration, threadId });
    this.#journal = new ManagedWorkerOperationJournal({ filePath: policy.journalPath, ...this.#scope });
  }

  #authenticate(key: object): void {
    if (key !== this.#policy.controlKey || this.#closed) throw new Error('Worker control unavailable');
  }
  #current(): boolean {
    return !this.#closed && this.canExecute() && this.backend.isSessionCurrent(this.#scope.backendGeneration) &&
      this.#policy.isOwnerCurrent(this.#scope) === true;
  }
  #checkPolicy<T>(check: () => T): T {
    if (this.#checkingPolicy) throw new Error('Reentrant worker command policy');
    this.#checkingPolicy = true;
    try { return check(); } finally { this.#checkingPolicy = false; }
  }
  get(key: object, operationId: string): WorkerOperation | null {
    this.#authenticate(key);
    return this.#journal.get(operationId);
  }
  getSettings(key: object, operationId: string): SettingsOperation | null {
    this.#authenticate(key);
    return this.#journal.getSettings(operationId);
  }
  /** Read-only snapshot. Caller must close new admission before using it as
   * one part of a stop proof; this says nothing about worker idle/history. */
  quiescence(key: object): WorkerCommandQuiescence {
    this.#authenticate(key);
    return Object.freeze({ inFlight: this.#inFlight.size + this.#settingsInFlight.size +
      (this.#confirmingSettings ? 1 : 0),
      unconfirmed: this.#journal.hasUnconfirmed() });
  }
  acceptedReceipts(key: object): ReadonlyArray<Readonly<{ method: WorkerMutationMethod; receiptId: string }>> {
    this.#authenticate(key);
    return this.#journal.acceptedReceipts();
  }
  /**
   * Read-only attested lookup for an immutable native intent. It never calls
   * authorization, reserves a journal row, or writes to the backend.
   */
  getForIntent(key: object, value: WorkerCommand): WorkerOperation | null {
    this.#authenticate(key);
    const command = snapshot(value);
    const prior = this.#journal.get(command.operationId);
    if (!prior) return null;
    const clientUserMessageId = command.params.clientUserMessageId;
    if (typeof clientUserMessageId !== 'string' || prior.clientUserMessageId !== clientUserMessageId ||
        prior.method !== command.method || prior.fingerprint !== this.#fingerprint(command))
      throw new Error('Worker command intent conflict');
    return prior;
  }
  execute(key: object, value: WorkerCommand): Promise<WorkerOperation> {
    return this.#execute(key, value, false);
  }

  /** ACK records only RPC completion; settings remain unknown until a separate effective-state proof API exists. */
  executeSettings(key: object, value: SettingsCommand, beforeWrite?: () => void): Promise<SettingsOperation> {
    this.#authenticate(key);
    if (this.#checkingPolicy || this.#confirmingSettings) throw new Error('Reentrant worker command admission');
    if (beforeWrite !== undefined && typeof beforeWrite !== 'function')
      throw new TypeError('Scoped before-write callback must be a function');
    const command = snapshotSettings(value);
    if (command.params.threadId !== this.#scope.threadId) throw new TypeError('Exact settings thread required');
    const fingerprint = this.#settingsFingerprint(command);
    const intent = { operationId: command.operationId, fingerprint };
    if (this.#journal.getSettings(command.operationId)) {
      const prior = this.#journal.reserveSettings(intent).operation;
      return this.#settingsInFlight.get(command.operationId) ?? Promise.resolve(prior);
    }
    const authorize = () => this.#checkPolicy(() => {
      if (!this.#current() || this.#policy.authorizeSettings?.(Object.freeze({ ...this.#scope,
          ...command })) !== true) throw new Error('Settings authority unavailable');
      beforeWrite?.();
      if (!this.#current()) throw new Error('Settings authority changed');
    });
    authorize();
    const reserved = this.#journal.reserveSettings(intent);
    if (!reserved.created) return Promise.resolve(reserved.operation);
    const work = this.#dispatchSettings(command, authorize);
    this.#settingsInFlight.set(command.operationId, work);
    void work.then(() => this.#settingsInFlight.delete(command.operationId),
      () => this.#settingsInFlight.delete(command.operationId));
    return work;
  }

  /** Durable confirmation of a separately observed actual effective tuple.
   * A native `{}` ACK alone cannot call this; absence of an observer leaves unknown. */
  confirmSettings(key: object, value: SettingsCommand): Promise<SettingsOperation> {
    this.#authenticate(key);
    if (this.#checkingPolicy || this.#confirmingSettings) throw new Error('Reentrant settings confirmation');
    const command = snapshotSettings(value);
    if (command.params.threadId !== this.#scope.threadId) throw new TypeError('Exact settings thread required');
    const prior = this.#journal.getSettings(command.operationId);
    if (!prior || prior.fingerprint !== this.#settingsFingerprint(command))
      throw new Error('Settings intent conflict');
    if (prior.state === 'confirmed') return Promise.resolve(prior);
    if (!prior.rpcAck || prior.state !== 'unknown' || this.#settingsInFlight.size !== 0 ||
        !this.#policy.qualifySettingsEffect || !this.#current())
      throw new Error('Settings effect qualification unavailable');
    this.#confirmingSettings = true;
    const work = this.#confirmSettingsEffect(command, prior);
    this.#confirmationInFlight = work;
    void work.finally(() => { this.#confirmingSettings = false; this.#confirmationInFlight = null; }).catch(() => {});
    return work;
  }

  async #confirmSettingsEffect(command: Readonly<SettingsCommand>, prior: SettingsOperation): Promise<SettingsOperation> {
    const assertCurrent = () => {
      if (!this.#current() || this.#settingsInFlight.size !== 0 || this.#closed)
        throw new Error('Settings owner or generation changed');
    };
    assertCurrent();
    const qualified = await this.#policy.qualifySettingsEffect!(
      Object.freeze({ ...this.#scope, ...command }), assertCurrent);
    assertCurrent();
    if (!object(qualified) || Object.keys(qualified).sort().join('|') !== 'assertCurrent|effectiveSettings' ||
        typeof qualified.assertCurrent !== 'function') throw new TypeError('Qualified settings effect required');
    const effective = snapshotEffectiveSettings(qualified.effectiveSettings);
    // No await after the observer's synchronous revision check: the callback
    // must reject if a relevant notification arrived during observation.
    const verified: unknown = qualified.assertCurrent();
    if (verified !== undefined) {
      if (object(verified) && typeof verified.then === 'function')
        void Promise.resolve(verified).catch(() => {});
      throw new TypeError('Settings effect verifier must be synchronous');
    }
    assertCurrent();
    const digest = createHmac('sha256', this.#policy.fingerprintKey)
      .update(canonical(effective)).digest('hex');
    return this.#journal.confirmSettings(prior, digest);
  }

  executeWithResponse(key: object, value: WorkerCommand,
    beforeWrite?: () => void): Promise<WorkerCommandResponse> {
    const work = this.#execute(key, value, true, beforeWrite);
    return work.then(operation => {
      const current = this.#journal.get(operation.operationId) ?? operation;
      const cached = current.state === 'accepted' ? this.#responses.get(operation.operationId) : null;
      return { operation: current, response: cached && cached.receiptId === current.receiptId
        ? structuredClone(cached.value) : null };
    });
  }

  #execute(key: object, value: WorkerCommand, awaitDuplicate: boolean,
    beforeWrite?: () => void): Promise<WorkerOperation> {
    this.#authenticate(key);
    if (beforeWrite !== undefined && typeof beforeWrite !== 'function')
      throw new TypeError('Scoped before-write callback must be a function');
    // Owner callbacks must not recursively admit either this or a different
    // operation before the outer reservation/write has been fenced.
    if (this.#checkingPolicy || this.#confirmingSettings) throw new Error('Reentrant worker command admission');
    const command = snapshot(value);
    if (command.params.threadId !== this.#scope.threadId ||
        typeof command.params.clientUserMessageId !== 'string' ||
        !Array.isArray(command.params.input) || command.params.input.length === 0)
      throw new TypeError('Exact thread, client input identity and input required');
    const authorize = () => this.#checkPolicy(() => {
      if (!this.#current() || this.#policy.authorize(Object.freeze({ ...this.#scope, ...command })) !== true)
        throw new Error('Worker command authority unavailable');
      beforeWrite?.();
      // Policy code may synchronously revoke the owner or stop this host.
      if (!this.#current()) throw new Error('Worker command authority changed');
    });
    const fingerprint = this.#fingerprint(command);
    const intent = { operationId: command.operationId,
      clientUserMessageId: command.params.clientUserMessageId, method: command.method, fingerprint };
    // Retrieving an immutable prior outcome is not a fresh execution. A now
    // active turn may legitimately make the original start policy inadmissible.
    if (this.#journal.get(command.operationId)) {
      const previous = this.#journal.reserve(intent).operation;
      return awaitDuplicate ? this.#inFlight.get(command.operationId) ?? Promise.resolve(previous) :
        Promise.resolve(previous);
    }
    authorize();
    const reservation = this.#journal.reserve(intent);
    if (!reservation.created) return Promise.resolve(reservation.operation);
    const work = this.#dispatch(command, authorize);
    this.#inFlight.set(command.operationId, work);
    void work.then(() => this.#inFlight.delete(command.operationId),
      () => this.#inFlight.delete(command.operationId));
    return work;
  }

  #fingerprint(command: Readonly<WorkerCommand>): string {
    return createHmac('sha256', this.#policy.fingerprintKey)
      .update(canonical({ ...this.#scope, ...command })).digest('hex');
  }
  #settingsFingerprint(command: Readonly<SettingsCommand>): string {
    return createHmac('sha256', this.#policy.fingerprintKey)
      .update(canonical({ ...this.#scope, ...command })).digest('hex');
  }

  #cacheResponse(operation: WorkerOperation, result: JsonObject): void {
    if (operation.state !== 'accepted' || operation.receiptId === null || this.#closed) return;
    let copy: JsonObject; let bytes: number;
    try {
      copy = structuredClone(result);
      const encoded = JSON.stringify(copy);
      bytes = Buffer.byteLength(encoded);
      if (bytes > 64 * 1024 * 1024 || !isDeepStrictEqual(copy, JSON.parse(encoded))) return;
    } catch { return; }
    const old = this.#responses.get(operation.operationId);
    if (old) this.#responseBytes -= old.bytes;
    this.#responses.delete(operation.operationId);
    while (this.#responses.size >= 128 || this.#responseBytes + bytes > 64 * 1024 * 1024) {
      const oldest = this.#responses.keys().next().value;
      if (oldest === undefined) break;
      this.#responseBytes -= this.#responses.get(oldest)!.bytes;
      this.#responses.delete(oldest);
    }
    this.#responses.set(operation.operationId,
      { receiptId: operation.receiptId, value: copy, bytes });
    this.#responseBytes += bytes;
  }

  #receipt(command: WorkerCommand, envelope: AppServerResponseEnvelope): void {
    if (!this.#checkPolicy(() => this.#current())) return;
    const operation = this.#journal.get(command.operationId);
    if (!operation) return;
    if ('error' in envelope) {
      // Generic internal/server failures may occur after side effects. Only
      // standard request/method/parameter validation errors prove rejection.
      if (typeof envelope.error.message === 'string' &&
          [-32600, -32601, -32602].includes(envelope.error.code as number))
        this.#journal.reject(operation, envelope.error.code as number);
      return;
    }
    const result = envelope.result;
    if (command.method === 'turn/start') {
      if (object(result.turn) && typeof result.turn.id === 'string')
        this.#cacheResponse(this.#journal.accept(operation, result.turn.id), result);
    } else if (object(result.queuedSubmission) &&
        typeof result.queuedSubmission.id === 'string' &&
        result.queuedSubmission.clientUserMessageId === command.params.clientUserMessageId &&
        isDeepStrictEqual(result.queuedSubmission.input, command.params.input)) {
      this.#cacheResponse(this.#journal.accept(operation, result.queuedSubmission.id), result);
    }
  }

  async #dispatch(command: WorkerCommand, authorize: () => void): Promise<WorkerOperation> {
    const receipt = (envelope: AppServerResponseEnvelope) => this.#receipt(command, envelope);
    try {
      await this.backend.request(command.method, structuredClone(command.params), {
        mutating: true, expectedGeneration: this.#scope.backendGeneration,
        assertBeforeWrite: authorize, onResponseEnvelope: receipt, onLateResponseEnvelope: receipt,
      });
    } catch { /* RPC failure never justifies replay or stopping the worker. */ }
    const observed = this.#journal.get(command.operationId);
    if (!observed) throw new Error('Worker operation result unavailable');
    // Only durable receipt processing establishes acceptance. Even a successful
    // raw RPC result is unknown if its shape or persistence could not be proven.
    return observed.state === 'dispatching' ? this.#journal.markUnknown(observed) : observed;
  }

  #settingsAck(command: SettingsCommand, envelope: AppServerResponseEnvelope): void {
    if (!this.#checkPolicy(() => this.#current()) || !('result' in envelope) ||
        !object(envelope.result) || Object.keys(envelope.result).length !== 0) return;
    const current = this.#journal.getSettings(command.operationId);
    if (current && !current.rpcAck) this.#journal.noteSettingsAck(current);
  }

  async #dispatchSettings(command: SettingsCommand, authorize: () => void): Promise<SettingsOperation> {
    const ack = (envelope: AppServerResponseEnvelope) => this.#settingsAck(command, envelope);
    try {
      await this.backend.request(command.method, structuredClone(command.params), {
        mutating: true, expectedGeneration: this.#scope.backendGeneration,
        assertBeforeWrite: authorize, onResponseEnvelope: ack, onLateResponseEnvelope: ack,
      });
    } catch { /* A settings timeout/error is never a safe replay or effective-state proof. */ }
    const observed = this.#journal.getSettings(command.operationId);
    if (!observed) throw new Error('Settings operation result unavailable');
    return observed.state === 'dispatching' ? this.#journal.markSettingsUnknown(observed) : observed;
  }

  /** Call only after stopping/invalidation of the RPC, so in-flight calls settle. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#inFlight.values(), ...this.#settingsInFlight.values(),
      ...(this.#confirmationInFlight ? [this.#confirmationInFlight] : [])]);
    this.#responses.clear(); this.#responseBytes = 0;
    this.#journal.close();
    this.#policy.fingerprintKey.fill(0);
  }
}
