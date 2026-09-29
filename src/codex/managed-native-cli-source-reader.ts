import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedWorkerFrontendHost } from './managed-worker-frontend-host.js';

type JsonObject = Record<string, unknown>;
type Host = Pick<ManagedWorkerFrontendHost, 'ownerRead'> & {
  readonly metadata: Readonly<{ taskId: string; state: string; backendGeneration: number | null }>;
};
const terminal = new Set(['completed', 'failed', 'interrupted']);
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (reason: string): never => { throw new Error(`Native CLI source ${reason}`); };

export interface NativeCliIdleReaderOptions {
  readonly host: Host;
  readonly controlKey: object;
  readonly taskId: string;
  readonly generation: number;
  readonly expectedCwd: string;
  readonly expectedModel: string;
  readonly expectedEffort: string;
  /** Synchronous owner/semantic-revision fence supplied by a live observer. */
  readonly assertCurrent: () => void;
}
export interface NativeCliIdleEvidence {
  readonly taskId: string;
  readonly generation: number;
  readonly turnCount: number;
  readonly terminalTurnIds: readonly string[];
  /** Ephemeral digest only; no transcript or model text is persisted here. */
  readonly historyDigest: string;
}

/** Exact same-worker native history/queue/goal proof. It does not infer current
 * permissions or grant write authority; callers must separately qualify the
 * effective settings and carry the live observer fence through dispatch. */
export async function readNativeCliIdleEvidence(options: NativeCliIdleReaderOptions):
  Promise<NativeCliIdleEvidence> {
  if (!options || !options.host || !options.controlKey ||
      typeof options.taskId !== 'string' || !options.taskId ||
      !Number.isSafeInteger(options.generation) || options.generation < 1 ||
      typeof options.expectedCwd !== 'string' || !options.expectedCwd ||
      typeof options.expectedModel !== 'string' || !options.expectedModel ||
      typeof options.expectedEffort !== 'string' || !options.expectedEffort ||
      typeof options.assertCurrent !== 'function') fail('reader unavailable');
  const check = () => {
    const returned: unknown = options.assertCurrent();
    if (returned !== undefined) {
      if (returned && typeof returned === 'object' && 'then' in returned &&
          typeof returned.then === 'function') void Promise.resolve(returned).catch(() => {});
      fail('owner fence must be synchronous');
    }
    const meta = options.host.metadata;
    if (meta.state !== 'running' || meta.taskId !== options.taskId ||
        meta.backendGeneration !== options.generation) fail('worker changed');
  };
  const read = async (method: string, params: JsonObject): Promise<JsonObject> => {
    check();
    const result = await options.host.ownerRead(options.controlKey,
      options.generation, method, params);
    check();
    if (!object(result)) fail('response unavailable');
    return result;
  };
  const thread = async (): Promise<JsonObject> => {
    const result = await read('thread/read', { threadId: options.taskId, includeTurns: true });
    const value = result.thread;
    if (!object(value) || value.id !== options.taskId || !object(value.status) ||
        value.status.type !== 'idle' || !Array.isArray(value.turns) ||
        value.model !== options.expectedModel ||
        value.reasoningEffort !== options.expectedEffort ||
        value.cwd !== options.expectedCwd ||
        typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt))
      fail('thread not idle or settings drifted');
    return value as JsonObject;
  };
  const history = async (): Promise<JsonObject[]> => {
    const turns: JsonObject[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await read('thread/turns/list', { threadId: options.taskId,
        limit: 100, sortDirection: 'asc', itemsView: 'full',
        ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) return fail('history page unavailable');
      for (const item of result.data as unknown[]) {
        if (!object(item)) return fail('history nonterminal or malformed');
        if (typeof item.id !== 'string' || !item.id ||
            ids.has(item.id) || !terminal.has(item.status as string) ||
            item.itemsView !== 'full' || !Array.isArray(item.items))
          return fail('history nonterminal or malformed');
        ids.add(item.id); turns.push(item);
      }
      const next = result.nextCursor;
      if (next === null) return turns;
      if (typeof next !== 'string' || !next ||
          next.length > 512 || cursors.has(next))
        fail('history cursor unavailable');
      cursor = next as string; cursors.add(cursor);
    }
    return fail('history page limit');
  };
  const emptyWork = async (): Promise<void> => {
    const goal = await read('thread/goal/get', { threadId: options.taskId });
    if (!Object.hasOwn(goal, 'goal') || goal.goal !== null) fail('goal not empty');
    const queue = await read('thread/queue/list', { threadId: options.taskId,
      limit: 100 });
    if (!Array.isArray(queue.data) || queue.data.length !== 0 ||
        queue.nextCursor !== null) fail('queue not empty');
  };
  const before = await thread(), turns = await history();
  await emptyWork();
  const after = await thread(), finalTurns = await history();
  await emptyWork();
  check();
  if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(turns, finalTurns) ||
      (after.turns as unknown[]).length !== turns.length ||
      !turns.every((turn, index) => {
        const listed = (after.turns as unknown[])[index];
        return object(listed) && listed.id === turn.id && listed.status === turn.status;
      })) fail('unstable history');
  return Object.freeze({ taskId: options.taskId, generation: options.generation,
    turnCount: turns.length, terminalTurnIds: Object.freeze(turns.map(turn => turn.id as string)),
    historyDigest: createHash('sha256').update(JSON.stringify(turns)).digest('hex') });
}
