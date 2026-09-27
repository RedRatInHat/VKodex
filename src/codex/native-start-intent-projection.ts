// Pure native UI intent overlay. It never admits, dispatches, or settles work.
import { isDeepStrictEqual } from 'node:util';
import type { NativeProjectionState } from './managed-native-projection.js';
import type { NativeStartIntentRecord } from './native-start-intent-store.js';
import type { WorkerOperation } from './managed-worker-operation-journal.js';

type JsonObject = Record<string, unknown>;

export interface NativeStartIntentBinding {
  readonly record: NativeStartIntentRecord;
  readonly operation: WorkerOperation | null;
}

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const clone = <T>(value: T): T => structuredClone(value);
function fail(message: string): never { throw new TypeError(`native start intent projection: ${message}`); }

interface CheckedBinding {
  readonly record: NativeStartIntentRecord;
  readonly operation: WorkerOperation | null;
  readonly threadId: string;
  readonly uiParams: JsonObject | null;
  readonly localMetadata: JsonObject | null;
}

function ownExactly(value: unknown, keys: readonly string[], label: string): asserts value is JsonObject {
  if (!object(value) || Reflect.ownKeys(value).sort().join('|') !== [...keys].sort().join('|')) fail(`${label} fields`);
}

function checkedBinding(value: unknown): CheckedBinding {
  ownExactly(value, ['record', 'operation'], 'binding');
  ownExactly(value.record, ['operationId', 'clientUserMessageId', 'intent'], 'record');
  if (!text(value.record.operationId) || !text(value.record.clientUserMessageId)) fail('record identity');
  ownExactly(value.record.intent, ['envelope', 'command', 'uiParams', 'localMetadata', 'admission'], 'intent');
  const intent = value.record.intent;
  ownExactly(intent.command, ['operationId', 'method', 'params'], 'intent command');
  if (intent.command.operationId !== value.record.operationId || intent.command.method !== 'turn/start' ||
      !object(intent.command.params) || intent.command.params.clientUserMessageId !== value.record.clientUserMessageId ||
      !text(intent.command.params.threadId)) fail('record command identity');
  if (!object(intent.envelope) || intent.envelope.conversationId !== intent.command.params.threadId ||
      !object(intent.envelope.turnStart) || !object(intent.envelope.turnStart.request) ||
      intent.envelope.turnStart.request.threadId !== intent.command.params.threadId ||
      intent.envelope.turnStart.request.clientUserMessageId !== value.record.clientUserMessageId) fail('record envelope identity');
  const admission = intent.admission;
  if (!object(admission) || !text(admission.ownerEpoch) ||
      typeof admission.backendGeneration !== 'number' || !Number.isSafeInteger(admission.backendGeneration) || admission.backendGeneration < 1 ||
      !object(admission.snapshot) || admission.snapshot.id !== intent.command.params.threadId) fail('record admission scope');
  const admissionGeneration = admission.backendGeneration as number;
  if (intent.uiParams !== null && !object(intent.uiParams) || intent.localMetadata !== null && !object(intent.localMetadata)) {
    fail('record UI data');
  }
  const operation = value.operation;
  if (operation !== null) {
    ownExactly(operation, ['operationId', 'clientUserMessageId', 'method', 'fingerprint', 'ownerEpoch',
      'backendGeneration', 'threadId', 'revision', 'state', 'receiptId', 'rejectionCode'], 'operation');
    const candidate = operation as unknown as WorkerOperation;
    if (candidate.operationId !== value.record.operationId || candidate.clientUserMessageId !== value.record.clientUserMessageId ||
        candidate.method !== 'turn/start' || candidate.ownerEpoch !== admission.ownerEpoch ||
        candidate.backendGeneration !== admissionGeneration ||
        candidate.threadId !== intent.command.params.threadId || !text(candidate.fingerprint) ||
        !/^[0-9a-f]{64}$/u.test(candidate.fingerprint) || !text(candidate.ownerEpoch) ||
        !Number.isSafeInteger(candidate.backendGeneration) || candidate.backendGeneration < 1 || !text(candidate.threadId) ||
        !Number.isSafeInteger(candidate.revision) ||
        candidate.revision < 0 || !['dispatching', 'unknown', 'accepted', 'rejected'].includes(candidate.state) ||
        !(candidate.receiptId === null || text(candidate.receiptId)) ||
        !(candidate.rejectionCode === null || Number.isSafeInteger(candidate.rejectionCode))) fail('operation identity or scope');
    if (candidate.state === 'accepted' && candidate.receiptId === null) fail('accepted operation without receipt');
    if (candidate.state !== 'accepted' && candidate.receiptId !== null) fail('unaccepted operation receipt');
  }
  return { record: value.record as unknown as NativeStartIntentRecord, operation: operation as WorkerOperation | null, threadId: intent.command.params.threadId,
    uiParams: intent.uiParams, localMetadata: intent.localMetadata };
}

function userClientIds(turn: JsonObject): string[] {
  if (!Array.isArray(turn.items)) fail('turn items');
  const ids: string[] = [];
  for (const item of turn.items) {
    if (!object(item) || !text(item.type)) fail('turn item');
    if (item.type === 'userMessage' && item.clientId !== null) {
      if (!text(item.clientId)) fail('user message client ID');
      ids.push(item.clientId);
    }
  }
  return ids;
}

/**
 * Adds only locally persisted, qualified UI start parameters to an already
 * accepted and observed App Server turn. Absence of that turn is a wait, not
 * an acceptance claim.
 */
export function projectNativeStartIntents(state: NativeProjectionState,
  bindings: readonly NativeStartIntentBinding[]): NativeProjectionState {
  if (!object(state) || !text(state.id) || !Array.isArray(state.turns) || !Array.isArray(bindings)) fail('state');
  const acceptedByReceipt = new Map<string, CheckedBinding>();
  const bindingClients = new Map<string, CheckedBinding>();
  for (const binding of bindings) {
    const checked = checkedBinding(binding);
    if (bindingClients.has(checked.record.clientUserMessageId)) fail('duplicate bound client ID');
    bindingClients.set(checked.record.clientUserMessageId, checked);
    if (checked.operation?.state === 'accepted') {
      const receipt = checked.operation.receiptId!;
      if (acceptedByReceipt.has(receipt)) fail('duplicate accepted receipt');
      acceptedByReceipt.set(receipt, checked);
    }
  }
  if (acceptedByReceipt.size === 0) return state;

  const turnsById = new Map<string, JsonObject>();
  const clientTurns = new Map<string, string[]>();
  for (const turn of state.turns) {
    if (!object(turn) || !text(turn.turnId) || !object(turn.params)) fail('turn identity');
    if (turnsById.has(turn.turnId)) fail('duplicate turn ID');
    turnsById.set(turn.turnId, turn);
    for (const clientId of userClientIds(turn)) {
      if (bindingClients.has(clientId)) (clientTurns.get(clientId) ?? clientTurns.set(clientId, []).get(clientId)!).push(turn.turnId);
    }
  }
  const replacements = new Map<string, JsonObject>();
  for (const [receiptId, binding] of acceptedByReceipt) {
    const turn = turnsById.get(receiptId);
    const clientId = binding.record.clientUserMessageId;
    const seen = clientTurns.get(clientId) ?? [];
    if (new Set(seen).size > 1) fail('bound client ID appears in multiple turns');
    if (!turn) {
      if (seen.length) fail('bound client ID conflicts with missing receipt turn');
      continue; // The accepted journal receipt arrived before projection refresh.
    }
    const params = turn.params, items = turn.items;
    if (!object(params) || !Array.isArray(items) || binding.threadId !== state.id) fail('accepted receipt scope mismatch');
    const turnClients = userClientIds(turn);
    if (seen.length === 0) {
      if (params.clientUserMessageId !== null && params.clientUserMessageId !== undefined && params.clientUserMessageId !== clientId ||
          turnClients.length > 0) fail('accepted receipt client ID mismatch');
      continue; // turn/started can precede its user item and projected params.
    }
    if (params.clientUserMessageId !== clientId || seen.length !== 1 || seen[0] !== receiptId) {
      fail('accepted receipt or client ID mismatch');
    }
    const matchingUsers = items.filter(item => object(item) && item.type === 'userMessage' && item.clientId === clientId);
    if (matchingUsers.length !== 1) fail('accepted turn user message mismatch');
    if (binding.uiParams === null) continue;
    if (!Array.isArray(binding.uiParams.input) || !isDeepStrictEqual(params.input, binding.uiParams.input)) {
      fail('accepted turn input mismatch');
    }
    const overlayParams = { ...clone(binding.uiParams), ...(binding.localMetadata === null ? {} : clone(binding.localMetadata)) };
    delete overlayParams.permissionParamsSource;
    replacements.set(receiptId, overlayParams);
  }
  if (replacements.size === 0) return state;
  const next = clone(state);
  for (const turn of next.turns) {
    const params = replacements.get(turn.turnId);
    if (params) turn.params = params as typeof turn.params;
  }
  return next;
}
