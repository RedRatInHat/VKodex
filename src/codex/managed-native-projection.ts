// Pure Stage A projection. Installed Desktop source anchors are in native-follower-turn-contract.md.
// No I/O, worker management, native IPC, model requests or ownership claims.
import { isDeepStrictEqual } from 'node:util';
type RecordValue = Record<string, unknown>;
type RequestId = string | number;
interface ProjectedItem extends RecordValue { id: string; type: string }
interface ProjectedTurn extends RecordValue {
  turnId: string; items: ProjectedItem[];
  params: RecordValue & { input: RecordValue[]; clientUserMessageId: string | null };
  status: string;
  turnStartedAtMs: number | null; finalAssistantStartedAtMs: number | null;
  durationMs: unknown; error: unknown;
}
interface PendingRequest extends RecordValue { id: RequestId; method: string; params: RecordValue }
interface RequestHistorySnapshot {
  id: string; hostId: 'local'; requests: PendingRequest[];
  turns: { turnId: string; items: ProjectedItem[] }[];
}
export interface NativeProjectionState extends RecordValue {
  id: string; hostId: 'local'; turns: ProjectedTurn[]; requests: PendingRequest[];
  currentPermissions: RecordValue; latestThreadSettings: RecordValue;
  latestModel: unknown; latestReasoningEffort: unknown; cwd: string;
  latestCollaborationMode: RecordValue; previousTurnModel: string | null;
  title: string | null; threadRuntimeStatus: RecordValue; latestTokenUsageInfo: unknown;
  hasUnreadTurn: boolean;
  updatedAt: number | null;
}
export interface NativeProjectionOptions extends RecordValue {
  hostId: 'local'; workspaceKind: 'project' | 'projectless';
  permissionsConfig?: RecordValue; collaborationMode?: RecordValue;
  initialTitle?: string | null; shellEnvironmentPolicy?: unknown;
  codexAppEnabledToolNames?: unknown; ephemeral?: boolean;
  threadStartKind?: unknown; environments?: unknown; workspaceBrowserRoot?: unknown;
  projectlessOutputDirectory?: unknown;
}
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const clone = <T>(value: T): T => structuredClone(value);
function fail(message: string): never { throw new TypeError('native projection: ' + message); }
const ms = (value: unknown): number | null => value == null ? null : typeof value === 'number' && Number.isFinite(value) ? value * 1000 : fail('invalid seconds timestamp');
const unsupportedItems = new Set(['imageGeneration', 'collabAgentToolCall']);

const serverRequestMethods = new Set(['item/tool/requestUserInput', 'item/permissions/requestApproval',
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const requestId = (id: unknown): id is RequestId => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function pendingItem(request: PendingRequest): ProjectedItem | null {
  const p = request.params;
  if (request.method === 'item/permissions/requestApproval') {
    if (!object(p.permissions) || (p.reason != null && typeof p.reason !== 'string')) fail('invalid permission request');
    return { id: `permission-request-${request.id}`, type: 'permissionRequest', requestId: request.id,
      turnId: p.turnId, reason: p.reason, permissions: clone(p.permissions), completed: false, response: null };
  }
  if (request.method === 'item/tool/requestUserInput') {
    if (!Array.isArray(p.questions)) fail('invalid user input questions');
    const questions = p.questions.map(q => {
      if (!object(q) || typeof q.id !== 'string' || typeof q.header !== 'string' || typeof q.question !== 'string'
        || typeof q.isSecret !== 'boolean' || typeof q.isOther !== 'boolean'
        || (q.options != null && !Array.isArray(q.options))) fail('invalid user input question');
      const options = (q.options ?? []).map(o => {
        if (!object(o) || typeof o.description !== 'string' || typeof o.label !== 'string') fail('invalid user input option');
        return { description: o.description, label: o.label };
      });
      return { id: q.id, header: q.header, options, question: q.question };
    });
    return { id: `user-input-response-${request.id}`, type: 'userInputResponse', requestId: request.id,
      turnId: p.turnId, questions, answers: {}, completed: false };
  }
  return null;
}

// Native hbe/gy/_y retain the original request for actionable UI (including
// isOther/isSecret), separately from the smaller transcript item. No reply.
export function projectNativeServerRequest(state: NativeProjectionState, request: unknown): NativeProjectionState {
  if (!object(state) || !Array.isArray(state.requests) || !Array.isArray(state.turns)) fail('invalid pending request state');
  if (!object(request) || !requestId(request.id) || typeof request.method !== 'string' || !serverRequestMethods.has(request.method)
    || !object(request.params) || request.params.threadId !== state.id
    || !nonempty(request.params.turnId) || !nonempty(request.params.itemId)) fail('invalid server request identity');
  const validated = request as PendingRequest;
  const previous = state.requests.find(r => r.id === validated.id);
  if (previous) {
    if (!isDeepStrictEqual(previous, validated)) fail('conflicting pending server request');
    return state;
  }
  const item = pendingItem(validated);
  const turn = state.turns.find(t => t.turnId === validated.params.turnId);
  if (item && turn?.items.some(i => i.id === item.id)) fail('ambiguous native request item identity');
  const next = clone(state);
  next.requests.push(clone(validated)); next.hasUnreadTurn = true;
  // Native does not synthesize a missing turn merely to display a request.
  if (item && turn) next.turns.find(t => t.turnId === turn.turnId)!.items.push(item);
  return next;
}

// This observes server-origin resolution. It is NOT an acknowledgement that
// our decision was accepted, and must not manufacture answers or permissions.
export function resolveNativeServerRequest(state: NativeProjectionState, notification: unknown): NativeProjectionState {
  if (!object(notification) || !requestId(notification.requestId)) fail('invalid resolved request identity');
  if (notification.threadId !== state.id) return state;
  const request = state.requests.find(r => r.id === notification.requestId);
  if (!request) return state;
  const item = pendingItem(request);
  const next = clone(state);
  next.requests = next.requests.filter(r => r.id !== notification.requestId);
  const turn = next.turns.find(t => t.turnId === request.params.turnId);
  if (item && turn) {
    const index = turn.items.findIndex(i => i.id === item.id);
    if (index >= 0) {
      if (turn.items[index]!.requestId !== request.id || turn.items[index]!.type !== item.type) fail('resolved request item identity conflict');
      turn.items[index] = { ...item, completed: true };
    }
  }
  return next;
}

// Request transcript items originate from the live owner, not item-list pages.
// Reconcile only within one fenced snapshot lineage; never invent missing turns.
export function preserveNativeRequestItems<T extends RequestHistorySnapshot>(previous: T, incoming: T): T {
  if (previous?.id !== incoming?.id || previous?.hostId !== incoming?.hostId
    || !Array.isArray(previous?.turns) || !Array.isArray(incoming?.turns)
    || !isDeepStrictEqual(previous.requests ?? [], incoming.requests ?? [])) fail('pending history identity changed');
  const next = clone(incoming);
  const special = (item: ProjectedItem) => item.type === 'userInputResponse' || item.type === 'permissionRequest';
  for (const oldTurn of previous.turns) {
    const localItems = oldTurn.items.filter(special);
    if (!localItems.length) continue;
    const target = next.turns.find(turn => turn.turnId === oldTurn.turnId);
    if (!target) fail('request transcript turn missing from history');
    for (const item of localItems) {
      const collision = target.items.find(value => value.id === item.id);
      if (collision) {
        if (!isDeepStrictEqual(collision, item)) fail('request transcript history collision');
        continue;
      }
      const oldIndex = oldTurn.items.indexOf(item);
      const nextAnchor = oldTurn.items.slice(oldIndex + 1).find(value => !special(value) && target.items.some(candidate => candidate.id === value.id));
      let index;
      if (nextAnchor) index = target.items.findIndex(value => value.id === nextAnchor.id);
      else {
        const prior = oldTurn.items.slice(0, oldIndex).reverse().find(value => target.items.some(candidate => candidate.id === value.id));
        index = prior ? target.items.findIndex(value => value.id === prior.id) + 1 : 0;
      }
      target.items.splice(index, 0, clone(item));
    }
  }
  return next;
}

function requireThread(value: unknown, label: string): RecordValue & { id: string; turns: unknown[] } {
  if (!object(value) || !nonempty(value.id)) fail(label + '.id required');
  if (!Array.isArray(value.turns)) fail(label + '.turns array required');
  return value as RecordValue & { id: string; turns: unknown[] };
}
function validateItem(item: unknown): ProjectedItem {
  if (!object(item) || !nonempty(item.id) || !nonempty(item.type)) fail('item id/type required');
  if (unsupportedItems.has(item.type)) fail('special item mapping required: ' + item.type);
  if (item.type === 'userMessage' && !(typeof item.clientId === 'string' || item.clientId === null)) {
    fail('userMessage.clientId string/null required');
  }
  return clone(item) as ProjectedItem;
}
function mapItems(items: unknown): ProjectedItem[] {
  if (!Array.isArray(items)) fail('turn.items array required');
  return items.map(validateItem);
}
function rawInput(items: readonly ProjectedItem[]): { input: RecordValue[]; clientUserMessageId: string | null } {
  // Locally projected server-request transcript items can precede the native
  // userMessage after a full-list refresh; they are never submitted input.
  const first = items.find(item => item.type !== 'contextCompaction' &&
    item.type !== 'userInputResponse' && item.type !== 'permissionRequest');
  if (first?.type === 'userMessage') {
    if (!Array.isArray(first.content)) fail('userMessage.content array required');
    if (first.content.some(part => !object(part) || part.type !== 'text' || typeof part.text !== 'string')) {
      fail('non-text user input needs native attachment mapping');
    }
    return { input: clone(first.content) as RecordValue[], clientUserMessageId: first.clientId as string | null };
  }
  return { input: [], clientUserMessageId: null };
}
// Native Lx: preserve actual App Server permissions, with its one explicit
// permission-config fallback for the :danger-full-access profile.
export function resolvePermissions(startResponse: unknown, permissionsConfig?: unknown): RecordValue {
  if (!object(startResponse)) fail('thread/start response object required');
  if (permissionsConfig != null && !object(permissionsConfig)) fail('permissionsConfig object required');
  const fallback = permissionsConfig && object(permissionsConfig.activePermissionProfile)
    ? permissionsConfig.activePermissionProfile : null;
  if (startResponse.activePermissionProfile == null && fallback?.id === ':danger-full-access') return clone(permissionsConfig!);
  return {
    activePermissionProfile: startResponse.activePermissionProfile ??
      (fallback != null && typeof fallback.id === 'string' && !fallback.id.startsWith(':') ? clone(fallback) : null),
    runtimeWorkspaceRoots: clone(startResponse.runtimeWorkspaceRoots),
    approvalPolicy: startResponse.approvalPolicy,
    approvalsReviewer: startResponse.approvalsReviewer,
    sandboxPolicy: clone(startResponse.sandbox),
  };
}
function settingsFromStart(start: RecordValue, cwd: string, collaborationMode: RecordValue) {
  // Native iy followed by ry, restricted to fresh-thread fields.
  const profile = object(start.activePermissionProfile) ? start.activePermissionProfile.id ?? null : null;
  return {
    disabledPluginIds: clone(start.disabledPluginIds),
    cwd,
    approvalPolicy: start.approvalPolicy,
    approvalsReviewer: start.approvalsReviewer,
    activePermissionProfile: clone(start.activePermissionProfile),
    sandboxPolicy: clone(start.sandbox),
    permissions: profile,
    model: start.model ?? '',
    serviceTier: start.serviceTier,
    effort: start.reasoningEffort ?? null,
    multiAgentMode: start.multiAgentMode,
    collaborationMode: clone(collaborationMode),
  };
}
function mapTurn(turn: unknown, context: NativeProjectionState): ProjectedTurn {
  if (!object(turn) || !nonempty(turn.id) || !nonempty(turn.status)) fail('turn id/status required');
  const items = mapItems(turn.items);
  const first = rawInput(items);
  const permissions = context.currentPermissions;
  const params = {
    threadId: context.id,
    input: first.input,
    clientUserMessageId: first.clientUserMessageId,
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandboxPolicy: clone(permissions.sandboxPolicy),
    permissions: object(permissions.activePermissionProfile) ? permissions.activePermissionProfile.id ?? null : null,
    runtimeWorkspaceRoots: clone(permissions.runtimeWorkspaceRoots),
    model: context.latestModel,
    cwd: context.cwd,
    effort: context.latestReasoningEffort,
    summary: 'none',
    personality: null,
    outputSchema: null,
    collaborationMode: null,
    attachments: [],
  };
  return {
    params,
    permissionParamsSource: 'inferred',
    turnId: turn.id,
    turnStartedAtMs: ms(turn.startedAt),
    durationMs: turn.durationMs ?? null,
    finalAssistantStartedAtMs: ms(turn.completedAt),
    status: turn.status,
    error: clone(turn.error ?? null),
    diff: null,
    items,
    itemsPagination: undefined,
  };
}
function applyTurn(next: NativeProjectionState, turn: unknown, completed: boolean): void {
  if (!object(turn) || !nonempty(turn.id)) fail('notification turn.id required');
  const index = next.turns.findIndex(value => value.turnId === turn.id);
  if (index < 0) {
    if (completed) fail('turn/completed before turn/started');
    const incoming = { ...turn, items: Array.isArray(turn.items) ? turn.items : [] };
    next.turns.push(mapTurn(incoming, next));
    return;
  }
  const existing = next.turns[index]!;
  if (turn.itemsView != null && (typeof turn.itemsView !== 'string' || !['notLoaded', 'summary', 'full'].includes(turn.itemsView))) fail('turn.itemsView invalid');
  if (turn.items != null && !Array.isArray(turn.items)) fail('notification turn.items must be array');
  // A list explicitly marked full is authoritative, including an empty list.
  // Summary/notLoaded lists are partial views and must not erase the live item
  // stream; legacy notifications without itemsView retain prior nonempty-list
  // behavior until their exact source contract is known.
  const replaceItems = turn.itemsView === 'full' || turn.itemsView == null && Array.isArray(turn.items) && turn.items.length > 0;
  if (replaceItems) {
    if (!Array.isArray(turn.items)) fail('full turn.items array required');
    // App Server full lists cannot contain locally projected server-request
    // transcript items. Reconcile them only within this same turn/request
    // lineage, using the same identity and collision rules as history reload.
    const nativeItems = mapItems(turn.items);
    const first = rawInput(nativeItems);
    const scope = { id: next.id, hostId: next.hostId, requests: next.requests };
    existing.items = preserveNativeRequestItems(
      { ...scope, turns: [{ turnId: existing.turnId, items: existing.items }] },
      { ...scope, turns: [{ turnId: existing.turnId, items: nativeItems }] },
    ).turns[0]!.items;
    existing.params.input = first.input;
    existing.params.clientUserMessageId = first.clientUserMessageId;
  }
  if (nonempty(turn.status)) existing.status = turn.status;
  if (turn.error !== undefined) existing.error = clone(turn.error);
  if (turn.durationMs !== undefined) existing.durationMs = turn.durationMs;
  if (Number.isFinite(turn.startedAt)) existing.turnStartedAtMs = ms(turn.startedAt);
  if (Number.isFinite(turn.completedAt)) existing.finalAssistantStartedAtMs = ms(turn.completedAt);
  if (completed && existing.status === 'inProgress') fail('turn/completed still inProgress');
}
function applyItem(next: NativeProjectionState, params: RecordValue, completed: boolean): void {
  const turn = next.turns.find(value => value.turnId === params.turnId);
  if (!turn) fail('item notification before turn/started');
  const item = validateItem(params.item);
  const index = turn.items.findIndex(value => value.id === item.id);
  if (index >= 0) turn.items[index] = item;
  else turn.items.push(item);
  if (item.type === 'userMessage') {
    const first = rawInput(turn.items);
    turn.params.input = first.input;
    turn.params.clientUserMessageId = first.clientUserMessageId;
  }
  if (item.type === 'agentMessage' && !completed && Number.isFinite(params.startedAtMs)) {
    turn.finalAssistantStartedAtMs = params.startedAtMs as number;
  }
}
// Only an exhausted page reader may call this constructor. Caller fences the
// read against live revision changes before publishing its result.
export function projectCompleteTurns(state: NativeProjectionState, turns: unknown): NativeProjectionState {
  if (!object(state) || !nonempty(state.id) || state.hostId !== 'local' || state.turnHistory !== undefined
    || !Array.isArray(turns)) fail('unsupported complete history snapshot');
  const seen = new Set();
  for (const turn of turns) {
    if (!object(turn) || !nonempty(turn.id) || turn.itemsView !== 'full') fail('full items required for history');
    if (seen.has(turn.id)) fail('duplicate turn in history');
    seen.add(turn.id);
  }
  const next = clone(state);
  next.turns = turns.map(turn => mapTurn(turn, state));
  next.turnsPagination = { olderCursor: null, oldestLoadedTurnId: turns[0]?.id ?? null, isLoadingOlder: false, hasLoadedOldest: true };
  return next;
}
// Takes real responses: thread/start => {thread,...}, thread/read => {thread}.
export function createProjection(startResponse: unknown, threadReadResponse: unknown, options: NativeProjectionOptions): NativeProjectionState {
  if (!object(startResponse) || !object(threadReadResponse) || !object(options)) fail('response/options objects required');
  const started = requireThread(startResponse.thread, 'thread/start.thread');
  const read = requireThread(threadReadResponse.thread, 'thread/read.thread');
  if (started.id !== read.id) fail('thread/start and thread/read IDs differ');
  if (options.hostId !== 'local') fail('only local host supported');
  if (options.workspaceKind !== 'projectless' && options.workspaceKind !== 'project') fail('explicit workspaceKind required');
  const cwd = startResponse.cwd || read.cwd || started.cwd;
  if (!nonempty(cwd)) fail('actual cwd required');
  if (!Number.isFinite(read.createdAt) || !Number.isFinite(read.updatedAt)) fail('actual thread timestamps required');
  const permissions = resolvePermissions(startResponse, options.permissionsConfig);
  const collaborationMode = options.collaborationMode ?? {
    mode: 'default', settings: { model: '', reasoning_effort: null, developer_instructions: null },
  };
  if (!object(collaborationMode) || !object(collaborationMode.settings)) fail('collaborationMode invalid');
  const settings = settingsFromStart(startResponse, cwd, collaborationMode);
  const initialTitle = options.initialTitle ?? read.name ?? null;
  if (initialTitle !== null && typeof initialTitle !== 'string') fail('title must be string or null');
  if (!object(read.status) || !nonempty(read.status.type)) fail('actual runtime status required');
  const state: NativeProjectionState = {
    id: read.id,
    sessionId: read.sessionId,
    shellEnvironmentPolicy: clone(options.shellEnvironmentPolicy),
    codexAppEnabledToolNames: clone(options.codexAppEnabledToolNames),
    forkedFromId: read.forkedFromId ?? null,
    ephemeral: options.ephemeral ?? read.ephemeral ?? false,
    sideConversation: false,
    hostId: 'local',
    turns: [],
    requests: [],
    createdAt: ms(read.createdAt),
    updatedAt: ms(read.updatedAt),
    recencyAt: ms(read.recencyAt ?? read.updatedAt),
    title: initialTitle,
    mode: read.mode,
    threadStartKind: options.threadStartKind ?? read.threadStartKind,
    modelProvider: read.modelProvider,
    daybreakEnabled: read.daybreakEnabled,
    latestThreadSettings: settings,
    latestModel: settings.model,
    latestReasoningEffort: settings.effort,
    previousTurnModel: null,
    latestCollaborationMode: clone(collaborationMode),
    hasUnreadTurn: false,
    rolloutPath: read.path ?? '',
    cwd,
    gitInfo: read.gitInfo ?? null,
    resumeState: 'resumed',
    latestTokenUsageInfo: null,
    currentPermissions: permissions,
    environments: clone(read.environments ?? options.environments),
    workspaceKind: options.workspaceKind,
    workspaceBrowserRoot: options.workspaceBrowserRoot ?? null,
    projectlessOutputDirectory: options.projectlessOutputDirectory ?? null,
    originator: read.originator,
    source: read.source,
    agentNickname: read.agentNickname,
    threadSource: read.threadSource,
    historyMode: read.historyMode,
    threadRuntimeStatus: clone(read.status),
    turnsPagination: { olderCursor: null, oldestLoadedTurnId: null, isLoadingOlder: false, hasLoadedOldest: true },
  };
  state.turns = read.turns.map(turn => mapTurn(turn, state));
  return state;
}
// No in-place mutation. Unknown same-thread events fail closed, so no output is silently lost.
export function applyNotification(state: NativeProjectionState, notification: unknown): NativeProjectionState {
  if (!object(state) || !nonempty(state.id) || !object(notification) || !object(notification.params)) fail('state/notification invalid');
  const params = notification.params;
  // Native Desktop routes MCP startup through its separate tool/catalog view.
  // It does not mutate the conversation snapshot, even with a threadId.
  if (notification.method === 'mcpServer/startupStatus/updated') return state;
  // Native Mb relays warnings via its notification emitter, not conversation
  // state. The runner retains this separate event; no fake turn item is made.
  if (notification.method === 'warning' && (params.threadId === null || params.threadId === state.id)) {
    if (typeof params.message !== 'string') fail('warning message invalid');
    return state;
  }
  if (params.threadId !== state.id) return state;
  if (notification.method === 'serverRequest/resolved') return resolveNativeServerRequest(state, params);
  // Native itemStreamState logs this delimiter; summary text deltas grow the
  // actual summary array. It is not a missing content event.
  if (notification.method === 'item/reasoning/summaryPartAdded') {
    if (!nonempty(params.turnId) || !nonempty(params.itemId)
      || !nonnegativeInteger(params.summaryIndex)) fail('summary part invalid');
    return state;
  }
  const next = clone(state);
  switch (notification.method) {
    case 'thread/settings/updated': {
      const settings = params.threadSettings;
      if (!object(settings) || !nonempty(settings.cwd) || !nonempty(settings.model)
        || !nonempty(settings.modelProvider) || !object(settings.collaborationMode)
        || !object(settings.collaborationMode.settings)
        || typeof settings.collaborationMode.settings.model !== 'string') fail('thread settings invalid');
      const oldModeModel = object(next.latestCollaborationMode.settings) ? next.latestCollaborationMode.settings.model : null;
      next.latestThreadSettings = clone(settings);
      if (isDeepStrictEqual(next.pendingDisabledPluginIds, settings.disabledPluginIds)) delete next.pendingDisabledPluginIds;
      next.latestModel = settings.model;
      next.modelProvider = settings.modelProvider;
      next.latestReasoningEffort = settings.effort;
      next.latestCollaborationMode = clone(settings.collaborationMode);
      next.cwd = settings.cwd;
      const newModeModel = settings.collaborationMode.settings.model;
      if (next.turns.length > 0 && nonempty(oldModeModel) && oldModeModel !== newModeModel) {
        if (next.previousTurnModel == null) next.previousTurnModel = oldModeModel;
        else if (next.previousTurnModel === newModeModel) next.previousTurnModel = null;
      }
      // Matches native pve/oy. It does not refresh currentPermissions or timestamps.
      break;
    }
    case 'thread/tokenUsage/updated': {
      const usage = params.tokenUsage;
      const keys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
      if (!nonempty(params.turnId) || !object(usage)
        || ![usage.total, usage.last].every(part => object(part) && keys.every(key => nonnegativeInteger(part[key])))
        || !(usage.modelContextWindow === null || positiveInteger(usage.modelContextWindow))) fail('token usage invalid');
      // Native ub permits usage arriving after the corresponding turn ends.
      next.latestTokenUsageInfo = clone(usage);
      break;
    }
    case 'turn/started': applyTurn(next, params.turn, false); break;
    case 'turn/completed': applyTurn(next, params.turn, true); break;
    case 'item/started': applyItem(next, params, false); break;
    case 'item/completed': applyItem(next, params, true); break;
    case 'item/agentMessage/delta': {
      if (!nonempty(params.turnId) || !nonempty(params.itemId) || typeof params.delta !== 'string') fail('agent delta invalid');
      const turn = next.turns.find(value => value.turnId === params.turnId);
      const item = turn?.items.find(value => value.id === params.itemId);
      if (!item || item.type !== 'agentMessage' || typeof item.text !== 'string') fail('agent delta before item/started');
      item.text += params.delta;
      break;
    }
    case 'item/plan/delta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
    case 'item/commandExecution/outputDelta': {
      if (!nonempty(params.turnId) || !nonempty(params.itemId) || typeof params.delta !== 'string') fail('text/output delta invalid');
      const turn = next.turns.find(value => value.turnId === params.turnId);
      const item = turn?.items.find(value => value.id === params.itemId);
      const field = notification.method === 'item/plan/delta' ? 'text' :
        notification.method === 'item/commandExecution/outputDelta' ? 'aggregatedOutput' : null;
      const expectedType = field === 'text' ? 'plan' : field === 'aggregatedOutput' ? 'commandExecution' : 'reasoning';
      if (!item || item.type !== expectedType) fail('text/output delta before matching item/started');
      if (field) {
        if (item[field] != null && typeof item[field] !== 'string') fail('delta target text field invalid');
        item[field] = ((item[field] ?? '') as string) + params.delta;
      } else {
        const summary = notification.method === 'item/reasoning/summaryTextDelta';
        const key = summary ? 'summaryIndex' : 'contentIndex';
        const fieldName = summary ? 'summary' : 'content';
        if (!nonnegativeInteger(params[key])) fail('reasoning delta index invalid');
        if (!Array.isArray(item[fieldName])) fail('reasoning ' + fieldName + ' array required');
        const parts = item[fieldName] as unknown[];
        const partIndex = params[key];
        while (parts.length <= partIndex) parts.push('');
        if (typeof parts[partIndex] !== 'string') fail('reasoning text part invalid');
        parts[partIndex] = (parts[partIndex] as string) + params.delta;
      }
      break;
    }
    case 'thread/name/updated':
      if (typeof params.threadName !== 'string') fail('threadName invalid');
      next.title = params.threadName;
      break;
    case 'thread/status/changed':
      if (!object(params.status) || !nonempty(params.status.type)) fail('runtime status invalid');
      next.threadRuntimeStatus = clone(params.status);
      break;
    default: fail('unsupported notification: ' + String(notification.method));
  }
  return next;
}
