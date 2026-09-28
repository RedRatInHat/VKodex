import type { TaskDetails } from '../core/codex-tasks.js';
import type { TaskState } from '../core/task-state.js';
import type { NativeProjectionState } from './managed-native-projection.js';

type Row = Record<string, unknown>;
export interface ManagedNativeBridgeTurn extends Row {
  readonly id: string;
  readonly status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  readonly startedAt: number;
  readonly items: readonly (Row & { readonly id: string; readonly type: string })[];
  readonly error: Row | null;
}
export interface ManagedNativeBridgeState extends TaskState {
  readonly kind: 'app-server';
  readonly threadId: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly model: string;
  readonly effort: string | null;
  readonly runtimeStatus: 'idle' | 'active' | 'systemError' | 'notLoaded';
  readonly context: TaskDetails['context'];
  readonly questions: readonly [];
  readonly turns: readonly ManagedNativeBridgeTurn[];
}

const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const clone = <T>(value: T): T => structuredClone(value);
const turnStatuses = new Set(['inProgress', 'completed', 'failed', 'interrupted']);
const runtimeStatuses = new Set(['idle', 'active', 'systemError', 'notLoaded']);
// The App Server observer intentionally ignores these non-conversation items.
// Validate their identity, but omit their potentially huge tool output from
// this bridge-only projection. The native UI retains the complete owner state.
const nonConversationItems = new Set(['commandExecution', 'fileChange', 'webSearch',
  'mcpToolCall', 'dynamicToolCall', 'reasoning', 'plan', 'contextCompaction',
  'permissionRequest', 'userInputResponse']);
function fail(reason: string): never { throw new TypeError('managed native bridge projection: ' + reason); }

function contextFromUsage(value: unknown): TaskDetails['context'] {
  if (value === null) return null;
  if (!object(value) || !object(value.last) || !Number.isSafeInteger(value.last.totalTokens) ||
    (value.last.totalTokens as number) < 0 ||
    !(value.modelContextWindow === null || Number.isSafeInteger(value.modelContextWindow) &&
      (value.modelContextWindow as number) > 0)) fail('context shape unsupported');
  if (value.modelContextWindow === null) return null;
  const used = value.last.totalTokens as number;
  const window = value.modelContextWindow as number;
  return { used: Math.min(used, window), window, percent: Math.min(100, used / window * 100) };
}

/** Pure, opt-in projection for the existing App Server bridge observer. A
 * caller must provide a same-generation, fully qualified NativeProjectionState;
 * this function never claims worker ownership or fills missing IDs/content. */
export function projectManagedNativeBridgeState(state: NativeProjectionState): ManagedNativeBridgeState {
  if (!object(state) || !text(state.id) || state.hostId !== 'local' ||
    !Array.isArray(state.turns) || !Array.isArray(state.requests) || state.requests.length !== 0 ||
    !object(state.turnsPagination) || state.turnsPagination.hasLoadedOldest !== true ||
    state.turnsPagination.olderCursor !== null ||
    !object(state.threadRuntimeStatus) || !runtimeStatuses.has(String(state.threadRuntimeStatus.type)) ||
    !(state.title === null || typeof state.title === 'string') || !text(state.cwd) ||
    !text(state.latestModel) || !(state.latestReasoningEffort === null ||
      typeof state.latestReasoningEffort === 'string') ||
    !finite(state.createdAt) || !finite(state.updatedAt)) fail('thread shape unsupported');
  const turns: ManagedNativeBridgeTurn[] = [];
  const seenTurns = new Set<string>();
  let lastStartedAt = -1;
  for (const source of state.turns) {
    if (!object(source) || !text(source.turnId) || seenTurns.has(source.turnId) ||
      !turnStatuses.has(String(source.status)) || !finite(source.turnStartedAtMs) ||
      !Array.isArray(source.items) || !(source.error === null || object(source.error)) ||
      !(source.finalAssistantStartedAtMs === null || finite(source.finalAssistantStartedAtMs)) ||
      !(source.durationMs === null || finite(source.durationMs)) || !object(source.params))
      fail('turn identity/status/timestamp unsupported or duplicate');
    if (source.turnStartedAtMs < lastStartedAt) fail('turn order ambiguous');
    lastStartedAt = source.turnStartedAtMs;
    seenTurns.add(source.turnId);
    const items: Array<Row & { id: string; type: string }> = [];
    const seenItems = new Set<string>();
    let firstClientId: string | null | undefined;
    for (const sourceItem of source.items) {
      if (!object(sourceItem) || !text(sourceItem.id) || !text(sourceItem.type) ||
        seenItems.has(sourceItem.id)) fail('item identity missing or duplicate');
      seenItems.add(sourceItem.id);
      if (sourceItem.type === 'userMessage') {
        if (!(typeof sourceItem.clientId === 'string' || sourceItem.clientId === null) ||
          !Array.isArray(sourceItem.content) || sourceItem.content.some(part =>
            !object(part) || part.type !== 'text' || typeof part.text !== 'string'))
          fail('user input content unsupported');
        if (firstClientId === undefined) firstClientId = sourceItem.clientId;
      } else if (sourceItem.type === 'agentMessage') {
        if (typeof sourceItem.text !== 'string' ||
          !(sourceItem.phase == null || sourceItem.phase === 'commentary' ||
            sourceItem.phase === 'final_answer') || sourceItem.delivery === 'async')
          fail('visible assistant content unsupported');
      } else if (nonConversationItems.has(sourceItem.type)) continue;
      else fail('unsupported item type');
      items.push(clone(sourceItem) as Row & { id: string; type: string });
    }
    if (source.params.clientUserMessageId !== (firstClientId ?? null))
      fail('user client identity mismatch');
    turns.push({ id: source.turnId, status: source.status as ManagedNativeBridgeTurn['status'],
      startedAt: source.turnStartedAtMs,
      ...(source.finalAssistantStartedAtMs === null ? {} :
        { completedAt: source.finalAssistantStartedAtMs }),
      durationMs: source.durationMs, items, error: clone(source.error) as Row | null });
  }
  return {
    kind: 'app-server', threadId: state.id, title: state.title, cwd: state.cwd,
    model: state.latestModel, effort: state.latestReasoningEffort,
    runtimeStatus: state.threadRuntimeStatus.type as ManagedNativeBridgeState['runtimeStatus'],
    context: contextFromUsage(state.latestTokenUsageInfo), questions: [], turns,
    createdAt: state.createdAt, updatedAt: state.updatedAt,
    ...(state.recencyAt === undefined ? {} : { recencyAt: clone(state.recencyAt) }),
    ...(state.originator === undefined ? {} : { originator: clone(state.originator) }),
    ...(state.source === undefined ? {} : { source: clone(state.source) }),
    ...(state.threadSource === undefined ? {} : { threadSource: clone(state.threadSource) }),
    ...(state.agentNickname === undefined ? {} : { agentNickname: clone(state.agentNickname) }),
  };
}
