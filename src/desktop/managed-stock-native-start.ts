import { isDeepStrictEqual } from 'node:util';
import { approveTaskPolicy, type ApprovedTaskPolicy } from '../codex/managed-task-policy.js';
import { prepareNativeFollowerStart } from '../codex/native-follower-start.js';
import type { WorkerCommand, WorkerCommandScope } from '../codex/managed-worker-command-dispatcher.js';
import type { ManagedNativeStockQueueAdapter } from './managed-native-stock-queue-adapter.js';
import { assertManagedStockSettingsPolicy } from './managed-stock-settings-initializer.js';
import { assertManagedStockReadParity, type ManagedStockQueueRuntimeOptions } from './managed-stock-queue-runtime.js';
import type { ManagedNativeStockQueueContext } from './managed-worker-native-owner.js';
import type { NativeStartAuthority, PreparedStockNativeStart, StockNativeStartAdmission } from './managed-worker-native-start.js';
import type { IpcObject } from './ipc-client.js';

const fail = (): never => { throw new Error('Managed stock direct start unavailable'); };
const row = (value: unknown): value is IpcObject => !!value && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function only(value: unknown, keys: readonly string[]): asserts value is IpcObject {
  if (!row(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) fail();
}
function copy<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > 2_000_000) fail();
  const result = JSON.parse(encoded) as T;
  if (!isDeepStrictEqual(value, result)) fail();
  return result;
}
function empty(value: unknown): boolean { return value == null || Array.isArray(value) && value.length === 0; }

/** Pure stock-policy compiler. It does not grant ownership or prove freshness.
 * Explicit Composer-only fields are validated before ordinary normalization. */
export function compileManagedStockNativeStart(authority: NativeStartAuthority, envelope: unknown,
  initialized: ManagedStockQueueRuntimeOptions['initialized'], policy: ApprovedTaskPolicy):
  Pick<PreparedStockNativeStart, 'params' | 'uiParams' | 'localMetadata'> {
  const f = copy(initialized.effectiveSettings), snapshot = authority.snapshot;
  if (snapshot.id !== policy.threadId || snapshot.cwd !== f.cwd ||
      snapshot.latestModel !== f.model || snapshot.latestReasoningEffort !== f.effort ||
      !isDeepStrictEqual(snapshot.latestCollaborationMode, f.collaborationMode)) fail();
  only(envelope, ['conversationId', 'turnStart']);
  only(envelope.turnStart, ['request', 'context']);
  const start = envelope.turnStart;
  only(start.request, ['threadId', 'clientUserMessageId', 'input', 'cwd', 'model', 'effort',
    'additionalContext', 'turnTrigger', 'responsesapiClientMetadata', 'multiAgentMode', 'serviceTier',
    'collaborationMode', 'permissions', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']);
  only(start.context, ['inheritThreadSettings', 'writingBlockContextPrepared', 'localTurnMetadata',
    'attachments', 'commentAttachments', 'responseItems', 'useAppServerPermissionDefault', 'usePermissionSelection']);
  const request = start.request, context = start.context;
  if (context.inheritThreadSettings !== true ||
      ['attachments', 'commentAttachments', 'responseItems'].some(key => !empty(context[key]))) fail();
  const extended = Object.hasOwn(context, 'writingBlockContextPrepared') ||
    Object.hasOwn(context, 'localTurnMetadata') || Object.hasOwn(context, 'useAppServerPermissionDefault') ||
    Object.hasOwn(context, 'usePermissionSelection');
  if (extended) {
    only(context.localTurnMetadata, ['fileAttachmentCount']);
    if (context.writingBlockContextPrepared !== true || context.localTurnMetadata.fileAttachmentCount !== 0 ||
        context.useAppServerPermissionDefault !== false || context.usePermissionSelection !== false ||
        request.permissions !== f.permissions || request.approvalPolicy !== f.approvalPolicy ||
        request.approvalsReviewer !== f.approvalsReviewer || request.sandboxPolicy != null) fail();
  } else if (['permissions', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy'].some(key =>
    Object.hasOwn(request, key))) fail();
  if (!Array.isArray(request.input) || request.input.length !== 1 || !row(request.input[0]) ||
      typeof request.input[0].text !== 'string' || !request.input[0].text.trim()) fail();
  const normalized = copy(request);
  for (const key of ['permissions', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy']) delete normalized[key];
  if (request.serviceTier === 'default' && f.serviceTier === null) {
    const receipt = initialized.tierResolution;
    if (!row(receipt) || receipt.taskId !== policy.threadId || receipt.ownerEpoch !== authority.ownerEpoch ||
        receipt.confirmed !== true || receipt.requested !== 'default' || receipt.effective !== null ||
        receipt.fastModeAllowed !== false) fail();
    normalized.serviceTier = null;
  } else if (request.serviceTier !== undefined && request.serviceTier !== f.serviceTier) fail();
  else delete normalized.serviceTier;
  if (request.collaborationMode != null) {
    if (!isDeepStrictEqual(request.collaborationMode, f.collaborationMode)) {
      const receipt = initialized.initializationReceipt;
      if (!row(receipt) || receipt.taskId !== policy.threadId || receipt.ownerEpoch !== authority.ownerEpoch ||
          receipt.confirmed !== true || receipt.expansionKind !== 'builtin-default-instructions' ||
          !isDeepStrictEqual(receipt.requestedCollaborationMode, request.collaborationMode) ||
          !isDeepStrictEqual(receipt.confirmedEffectiveCollaborationMode, f.collaborationMode) ||
          !isDeepStrictEqual(receipt.confirmedEffectiveSettings, f)) fail();
    }
    delete normalized.collaborationMode; // The proven effective expansion is inherited below.
  }
  const params = prepareNativeFollowerStart(snapshot, { conversationId: envelope.conversationId,
    turnStart: { request: normalized, context: { inheritThreadSettings: true } } });
  if (params.threadId !== policy.threadId || params.cwd !== f.cwd || params.model !== f.model ||
      params.effort !== f.effort || params.permissions !== f.permissions ||
      params.approvalPolicy !== f.approvalPolicy || params.approvalsReviewer !== f.approvalsReviewer ||
      !isDeepStrictEqual(params.runtimeWorkspaceRoots, f.runtimeWorkspaceRoots) ||
      !isDeepStrictEqual(params.collaborationMode, f.collaborationMode)) fail();
  params.serviceTier = f.serviceTier; params.summary = f.summary; params.personality = f.personality;
  params.sandboxPolicy = null; params.outputSchema = null;
  delete params.turnTrigger; delete params.responsesapiClientMetadata;
  if (policy.environments.length) {
    params.environments = copy(policy.environments); params.cwd = null; params.runtimeWorkspaceRoots = null;
  }
  const uiParams = { ...copy(params), cwd: f.cwd, runtimeWorkspaceRoots: copy(f.runtimeWorkspaceRoots),
    sandboxPolicy: copy(f.sandboxPolicy), useAppServerPermissionDefault: false,
    ...(request.responsesapiClientMetadata == null ? {} :
      { responsesapiClientMetadata: copy(request.responsesapiClientMetadata) }),
    ...(request.turnTrigger == null ? {} : { turnTrigger: request.turnTrigger }),
    ...(context.attachments === undefined ? {} : { attachments: copy(context.attachments) }),
    ...(context.commentAttachments === undefined ? {} : { commentAttachments: copy(context.commentAttachments) }) };
  return { params: copy(params), uiParams: copy(uiParams), localMetadata: {
    fileAttachmentCount: 0, forwardedUpstream: { turnTrigger: false, responsesapiClientMetadata: false } } };
}

export type StockNativeStartContext = ManagedNativeStockQueueContext &
  Readonly<{ queueAdapter: ManagedNativeStockQueueAdapter }>;
/** Only this exact pending immutable command is admitted by the daemon policy.
 * Direct ACKs retain real turn IDs; no direct start is converted to queue/add. */
export class ManagedStockNativeStart implements StockNativeStartAdmission {
  readonly #options: ManagedStockQueueRuntimeOptions;
  readonly #context: StockNativeStartContext;
  readonly #policy: ApprovedTaskPolicy;
  #pending: { command: WorkerCommand; current: () => void } | null = null;
  constructor(options: ManagedStockQueueRuntimeOptions, context: StockNativeStartContext) {
    this.#policy = approveTaskPolicy(options.approvedTaskPolicy);
    assertManagedStockSettingsPolicy(this.#policy, context.taskId);
    if (context.ownerEpoch === '' || context.backendGeneration !== options.bootstrap.generation ||
        !context.host.hasCommandClientIdentity || !context.host.acceptedQueueInputs ||
        !context.host.acceptedCommandReceipts || !context.host.commandQuiescence ||
        !context.host.requestQuiescence) fail();
    this.#options = { ...options, initialized: copy({ effectiveSettings: options.initialized.effectiveSettings,
      initializationReceipt: options.initialized.initializationReceipt,
      tierResolution: options.initialized.tierResolution, initialState: options.initialized.initialState }) };
    this.#context = context;
  }
  authorizes(scope: Readonly<WorkerCommandScope & WorkerCommand>): boolean {
    try {
      const pending = this.#pending, context = this.#context;
      if (!pending || scope.ownerEpoch !== context.ownerEpoch || scope.threadId !== context.taskId ||
          scope.backendGeneration !== context.backendGeneration ||
          !isDeepStrictEqual({ operationId: scope.operationId, method: scope.method, params: scope.params },
            pending.command)) return false;
      pending.current(); return this.#pending === pending;
    } catch { return false; }
  }
  async prepare(scope: Parameters<StockNativeStartAdmission['prepare']>[0]): Promise<PreparedStockNativeStart> {
    const o = this.#options, c = this.#context, h = c.host, key = c.controlKey;
    if (this.#pending || o.admissionOpen() !== true || scope.authority.ownerEpoch !== c.ownerEpoch ||
        scope.authority.backendGeneration !== c.backendGeneration) fail();
    const compiled = compileManagedStockNativeStart(scope.authority, scope.request.params, o.initialized, this.#policy);
    const command: WorkerCommand = { operationId: scope.operationId, method: 'turn/start', params: compiled.params };
    const clientValue = command.params.clientUserMessageId;
    if (typeof clientValue !== 'string') fail();
    const clientId = clientValue as string;
    if (c.queueAdapter.hasClientIdentity(clientId) || h.hasCommandClientIdentity!(key, clientId)) fail();
    const ticket = c.captureAuthority(), queue = c.queueAdapter.quiescence();
    const receipts = h.acceptedCommandReceipts!(key), inputs = h.acceptedQueueInputs!(key);
    if (receipts.some(receipt => receipt.method !== 'turn/start' && receipt.method !== 'thread/queue/add')) fail();
    const turnIds = receipts.filter(receipt => receipt.method === 'turn/start').map(receipt => receipt.receiptId);
    const submissionIds = receipts.filter(receipt => receipt.method === 'thread/queue/add')
      .map(receipt => receipt.receiptId);
    const queueClientIds = inputs.map(input => input.clientUserMessageId);
    if (new Set(turnIds).size !== turnIds.length || new Set(submissionIds).size !== submissionIds.length ||
        new Set(queueClientIds).size !== queueClientIds.length ||
        !isDeepStrictEqual(submissionIds, inputs.map(input => input.submissionId))) fail();
    const baseCurrent = (): void => {
      const meta = h.metadata, pending = h.requestQuiescence!(key), quiet = c.queueAdapter.quiescence();
      if (o.isOwnerCurrent() !== true || c.assertCurrent(ticket) !== true || meta.state !== 'running' ||
          meta.taskId !== c.taskId || meta.backendGeneration !== c.backendGeneration ||
          pending.generation !== c.backendGeneration || pending.unresolved !== 0 ||
          quiet.unresolved !== 0 || quiet.unconsumed !== 0 || !isDeepStrictEqual(quiet, queue) ||
          !isDeepStrictEqual(h.acceptedCommandReceipts!(key), receipts) ||
          !isDeepStrictEqual(h.acceptedQueueInputs!(key), inputs)) fail();
    };
    const before = (): void => {
      baseCurrent(); const quiet = h.commandQuiescence!(key);
      if (o.admissionOpen() !== true || quiet.inFlight !== 0 || quiet.unconfirmed ||
          h.hasCommandClientIdentity!(key, clientId)) fail();
    };
    before();
    if (await o.confirmNativeOwner({ taskId: c.taskId, ownerEpoch: c.ownerEpoch }) !== true) fail();
    before();
    if (await o.assertControlledNativeBaseline({ taskId: c.taskId, ownerEpoch: c.ownerEpoch,
      backendGeneration: c.backendGeneration, sourceGeneration: o.sourceGeneration }) !== true) fail();
    before();
    const read = await o.bootstrap.readStockState(before, queueClientIds);
    before();
    assertManagedStockReadParity(ticket, read, o.initialized.initialState, this.#policy,
      c.ownerEpoch, c.backendGeneration);
    const terminal = new Set(read.terminalTurnIds);
    if (turnIds.some(turnId => !terminal.has(turnId))) fail();
    const current = (): void => {
      baseCurrent(); const quiet = h.commandQuiescence!(key);
      const operation = h.commandStatusForIntent(key, command);
      if (operation === null) {
        if (o.admissionOpen() !== true || quiet.inFlight !== 0 || quiet.unconfirmed ||
            h.hasCommandClientIdentity!(key, clientId)) fail();
      } else if (operation.state !== 'dispatching' || quiet.inFlight > 1 || quiet.unconfirmed !== true) fail();
    };
    const pending = { command: copy(command), current };
    this.#pending = pending;
    return { ...compiled, assertCurrent: () => {
      if (this.#pending !== pending) fail(); current();
    }, settle: () => { if (this.#pending === pending) this.#pending = null; } };
  }
}
