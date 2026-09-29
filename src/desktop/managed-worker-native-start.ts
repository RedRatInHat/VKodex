import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedWorkerFrontendHost } from '../codex/managed-worker-frontend-host.js';
import { prepareNativeFollowerStart } from '../codex/native-follower-start.js';
import type { NativeFollowerStartSnapshot } from '../codex/native-follower-start.js';
import { compileNativeReadOnlyComposerStart, compileNativeReadOnlyContinuationComposerStart } from '../codex/native-composer-start.js';
import type { NativeStartIntentStore, NativeStartIntent } from '../codex/native-start-intent-store.js';
import type { QualifiedContinuationEvidence } from './managed-worker-bootstrap.js';
import type { IpcIncomingRequest, IpcObject, IpcRequestHandler } from './ipc-client.js';

export interface NativeStartAuthority {
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  /** Settings/authority revision, NOT the revision of streamed turn events. */
  readonly authorityRevision: number;
  /** Optional owner semantic fence. Continuation qualification requires it. */
  readonly semanticRevision?: number;
  readonly snapshot: NativeFollowerStartSnapshot;
  /** Explicit opt-in to the qualified first-turn Composer contract. */
  readonly composer?: { readonly snapshot: IpcObject; readonly defaults: IpcObject | null } | null;
}
interface Options {
  readonly host: Pick<ManagedWorkerFrontendHost, 'metadata' | 'executeCommandWithResponse'> &
    Partial<Pick<ManagedWorkerFrontendHost, 'commandStatusForIntent'>>;
  readonly controlKey: object;
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly authority: () => NativeStartAuthority | null;
  /** Must validate an established follower lease. Broker sourceClientId alone
   * is routing data, not authentication or proof of writer ownership. */
  readonly authorizeFollower: (request: Readonly<IpcIncomingRequest>, authority: NativeStartAuthority) => boolean;
  readonly intentStore?: NativeStartIntentStore;
  /** Qualifies current policy on the same already-loaded worker. Only its
   * fenced ID-only resume/read is allowed; never create or replace a worker. */
  readonly qualifyContinuation?: (authority: NativeStartAuthority) => Promise<QualifiedContinuationEvidence>;
  /** Synchronous first Composer turn fence. For a new command the first phase
   * runs before entering the dispatcher; the second runs at the RPC write. */
  readonly qualifyFirstTurn?: (request: Readonly<IpcIncomingRequest>, authority: NativeStartAuthority,
    command: NativeStartIntent['command'], phase: 'before-reservation' | 'before-write') => void;
  /** Retires a temporary first-phase command grant after the original attempt. */
  readonly onFirstTurnAttemptSettled?: (command: NativeStartIntent['command']) => void;
  /** Refresh local projection only after validating an actual accepted receipt. */
  readonly onAccepted?: () => void;
}
interface Remembered extends NativeStartIntent { readonly bytes: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (v: unknown): v is IpcObject => !!v && typeof v === 'object' && !Array.isArray(v);
const refused = () => new Error('Native worker start is not authorized or representable');

/** Direct follower v2 start handler for an existing native projection owner.
 * Does not advertise ownership, create IPC clients, schedule FWE queues, or
 * stop workers on disconnect. Full Composer/attachments require another
 * qualified compiler; unsupported context is never silently stripped. */
export class ManagedWorkerNativeStartHandler implements IpcRequestHandler {
  readonly #options: Options;
  readonly #commands = new Map<string, Remembered>();
  #bytes = 0;
  #checking = false;
  #qualifyingContinuation = false;
  #closed = false;

  constructor(options: Options) {
    if (!options || !options.taskId || !uuid.test(options.ownerEpoch) ||
        !options.controlKey || typeof options.controlKey !== 'object' ||
        typeof options.authority !== 'function' || typeof options.authorizeFollower !== 'function' ||
        typeof options.host?.executeCommandWithResponse !== 'function' ||
        options.onAccepted !== undefined && typeof options.onAccepted !== 'function' ||
        options.qualifyContinuation !== undefined && typeof options.qualifyContinuation !== 'function' ||
        options.qualifyFirstTurn !== undefined &&
          (typeof options.qualifyFirstTurn !== 'function' ||
            typeof options.host.commandStatusForIntent !== 'function') ||
        options.onFirstTurnAttemptSettled !== undefined &&
          (typeof options.onFirstTurnAttemptSettled !== 'function' || !options.qualifyFirstTurn)) throw refused();
    if (options.intentStore && (options.intentStore.owner.ownerEpoch !== options.ownerEpoch ||
        options.intentStore.owner.threadId !== options.taskId ||
        options.intentStore.owner.backendGeneration !== options.host.metadata.backendGeneration)) throw refused();
    this.#options = Object.freeze({ ...options });
  }

  #capture(request: IpcIncomingRequest): NativeStartAuthority {
    if (this.#checking || this.#closed) throw refused();
    this.#checking = true;
    try {
      const o = this.#options;
      if (request.method !== 'thread-follower-start-turn' || request.version !== 2 ||
          request.hostId !== undefined && request.hostId !== 'local' ||
          !request.sourceClientId || !request.requestId || request.params.conversationId !== o.taskId)
        throw refused();
      const a = structuredClone(o.authority());
      const host = o.host.metadata;
      if (!a || a.ownerEpoch !== o.ownerEpoch || a.snapshot.id !== o.taskId ||
          !Number.isSafeInteger(a.authorityRevision) || a.authorityRevision < 0 ||
        !Number.isSafeInteger(a.backendGeneration) || a.backendGeneration < 1 ||
        a.semanticRevision !== undefined && (!Number.isSafeInteger(a.semanticRevision) || a.semanticRevision < 0) ||
          host.taskId !== o.taskId || host.backendGeneration !== a.backendGeneration ||
          host.state !== 'running' || o.authorizeFollower(request, structuredClone(a)) !== true)
        throw refused();
      // Authorization callbacks may revoke settings or stop the host. Do not
      // retain a snapshot taken before that synchronous revocation.
      const after = o.host.metadata;
      if (this.#closed || after.state !== 'running' || after.taskId !== o.taskId ||
          after.backendGeneration !== a.backendGeneration || !isDeepStrictEqual(a, o.authority()))
        throw refused();
      return a;
    } catch { throw refused(); }
    finally { this.#checking = false; }
  }

  canHandle(request: IpcIncomingRequest): boolean {
    try { this.#capture(request); return true; } catch { return false; }
  }

  #sameAuthority(request: IpcIncomingRequest, expected: NativeStartAuthority): void {
    const actual = this.#capture(request);
    if (actual.ownerEpoch !== expected.ownerEpoch || actual.backendGeneration !== expected.backendGeneration ||
        actual.authorityRevision !== expected.authorityRevision ||
        actual.semanticRevision !== expected.semanticRevision ||
        !isDeepStrictEqual(actual.snapshot, expected.snapshot) ||
        !isDeepStrictEqual(actual.composer, expected.composer)) throw refused();
  }

  async handle(incoming: IpcIncomingRequest, signal: AbortSignal): Promise<IpcObject> {
    if (signal.aborted) throw refused();
    // Transport callbacks and caller-owned objects cannot alter the admitted intent.
    const request = structuredClone(incoming);
    const authority = this.#capture(request);
    const envelope = request.params;
    const encoded = JSON.stringify(envelope);
    const envelopeBytes = Buffer.byteLength(encoded);
    if (envelopeBytes > 32 * 1024 * 1024 || !isDeepStrictEqual(envelope, JSON.parse(encoded))) throw refused();
    const start = envelope.turnStart;
    if (!object(start) || !object(start.request) || typeof start.request.clientUserMessageId !== 'string' ||
        !start.request.clientUserMessageId || start.request.clientUserMessageId.length > 128) throw refused();
    const clientId = start.request.clientUserMessageId;
    // Stable across frontend reconnects; not a credential or a native RPC ID.
    const hash = createHash('sha256').update(JSON.stringify([
      'vkodex-native-start-v2', authority.ownerEpoch, this.#options.taskId, clientId,
    ])).digest('hex');
    const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const persisted = this.#options.intentStore?.get(operationId);
    const previous = persisted?.intent ?? this.#commands.get(operationId);
    if (previous && !isDeepStrictEqual(previous.envelope, envelope)) throw refused();
    let intent: NativeStartIntent;
    if (previous) intent = previous;
    else {
      // An extended Composer context must never fall back to the ordinary
      // compiler and lose local metadata or explicit permission settings.
      const context = start.context;
      const ordinary = object(context) && Object.keys(context).every(key => key === 'inheritThreadSettings');
      let compiled: ReturnType<typeof compileNativeReadOnlyComposerStart> | null;
      if (ordinary) compiled = null;
      else if (!authority.composer || !this.#options.intentStore) throw refused();
      else {
        const turns = authority.composer.snapshot.turns;
        if (!Array.isArray(turns) || turns.length === 0) {
          compiled = compileNativeReadOnlyComposerStart(authority.composer.snapshot, envelope, authority.composer.defaults);
        } else {
          if (!this.#options.qualifyContinuation || authority.semanticRevision === undefined || this.#qualifyingContinuation)
            throw refused();
          this.#qualifyingContinuation = true;
          try {
            const evidence = await this.#options.qualifyContinuation(structuredClone(authority));
            if (!evidence || typeof evidence !== 'object' || !evidence.owner || typeof evidence.owner !== 'object' ||
                evidence.owner.ownerEpoch !== authority.ownerEpoch ||
                evidence.owner.backendGeneration !== authority.backendGeneration ||
                evidence.owner.threadId !== this.#options.taskId ||
                evidence.owner.semanticRevision !== authority.semanticRevision) throw refused();
            // The qualifier is asynchronous. Re-capture before any durable
            // native intent record or worker command can be made.
            this.#sameAuthority(request, authority);
            compiled = compileNativeReadOnlyContinuationComposerStart(authority.composer.snapshot, envelope, evidence);
          } finally { this.#qualifyingContinuation = false; }
        }
      }
      intent = { envelope: structuredClone(envelope),
        command: { operationId, method: 'turn/start',
          params: compiled?.request ?? prepareNativeFollowerStart(authority.snapshot, envelope) },
        admission: structuredClone(authority) as unknown as IpcObject,
        uiParams: compiled?.uiParams ?? null, localMetadata: compiled?.localMetadata ?? null };
    }
    const command = intent.command;
    const storedAdmission = intent.admission as unknown as NativeStartAuthority;
    const firstComposer = intent.uiParams !== null &&
      Array.isArray(storedAdmission.composer?.snapshot.turns) &&
      storedAdmission.composer.snapshot.turns.length === 0;
    // A bounded first-turn route must not silently use the ordinary compiler
    // or admit a continuation under a callback intended for an empty task.
    if (this.#options.qualifyFirstTurn && !firstComposer) throw refused();
    let firstTurnFenceCalls = 0;
    const commandBytes = Buffer.byteLength(JSON.stringify(command));
    if (commandBytes > 32 * 1024 * 1024) throw refused();
    const bytes = Buffer.byteLength(JSON.stringify(intent));
    // A durable exact duplicate does not requalify. The dispatcher returns its
    // prior receipt without calling beforeWrite; intent-only records still
    // invoke beforeWrite against their original stored admission below.
    this.#sameAuthority(request, authority);
    if (signal.aborted) throw refused();
    // Record the original settings resolution for retransmission. The worker's
    // durable ledger is authoritative if this bounded memory cache is gone.
    if (!previous) {
      // Failure to durably preserve intent prevents the native write entirely.
      this.#options.intentStore?.reserve(operationId, clientId, intent);
      this.#commands.set(operationId, { ...structuredClone(intent), bytes });
      this.#bytes += bytes;
      while (this.#commands.size > 128 || this.#bytes > 64 * 1024 * 1024) {
        const oldest = this.#commands.keys().next().value!;
        this.#bytes -= this.#commands.get(oldest)!.bytes;
        this.#commands.delete(oldest);
      }
    }
    let prequalified = false;
    if (firstComposer && this.#options.qualifyFirstTurn &&
        !this.#options.host.commandStatusForIntent!(this.#options.controlKey, command)) {
      this.#options.qualifyFirstTurn(request, storedAdmission, command, 'before-reservation');
      firstTurnFenceCalls = 1;
      prequalified = true;
    }
    let outcome: Awaited<ReturnType<ManagedWorkerFrontendHost['executeCommandWithResponse']>>;
    try {
      outcome = await this.#options.host.executeCommandWithResponse(this.#options.controlKey, command,
        () => {
          this.#sameAuthority(request, storedAdmission);
          if (!firstComposer || !this.#options.qualifyFirstTurn) return;
          // The dispatcher invokes this callback once before its journal
          // reservation and once at the actual RPC write. Phase one already
          // ran before entering it, so only the latter is a new qualification.
          if (++firstTurnFenceCalls === 2) return;
          if (firstTurnFenceCalls !== 3) throw refused();
          this.#options.qualifyFirstTurn(request, storedAdmission, command, 'before-write');
        });
    } finally {
      if (prequalified) this.#options.onFirstTurnAttemptSettled?.(command);
    }
    // This signal only gates delivery. Never interrupt an accepted model turn.
    if (signal.aborted) throw new Error('Native response delivery disconnected; worker outcome retained');
    const current = this.#capture(request);
    if (current.ownerEpoch !== authority.ownerEpoch || current.backendGeneration !== authority.backendGeneration)
      throw refused();
    const op = outcome.operation, result = outcome.response;
    if (op.state !== 'accepted' || op.operationId !== operationId || op.method !== 'turn/start' ||
        op.ownerEpoch !== authority.ownerEpoch || op.backendGeneration !== authority.backendGeneration ||
        op.threadId !== this.#options.taskId || op.clientUserMessageId !== clientId ||
        !object(result) || !object(result.turn) || typeof result.turn.id !== 'string' ||
        !result.turn.id || result.turn.id !== op.receiptId)
      throw new Error('Actual native start receipt unavailable; do not replay the command');
    this.#options.onAccepted?.();
    return { result: structuredClone(result) };
  }

  /** Retire this adapter, not its worker. Transport EOF alone is not retirement. */
  close(): void { this.#closed = true; this.#commands.clear(); this.#bytes = 0; }
}
