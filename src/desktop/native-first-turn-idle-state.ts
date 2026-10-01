import type { AppServerRpc } from '../codex/app-server-connection.js';

type Reader = Pick<AppServerRpc, 'request'> & Readonly<{
  initializedSession(): Promise<{ readonly generation: number }>;
  isSessionCurrent(generation: number): boolean;
}>;

export interface NativeFirstTurnIdleObservation {
  readonly threadId: string;
  readonly backendGeneration: number;
  readonly status: 'idle';
  readonly turnsEmpty: true;
  readonly goalEmpty: true;
  readonly queueEmpty: true;
}

const fail = (): never => { throw new Error('Native first-turn idle state unqualified'); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const empty = (value: unknown): value is [] =>
  Array.isArray(value) && value.length === 0 && Reflect.ownKeys(value).length === 1;

/** Observe a newly accepted native task on one initialized backend. The
 * returned scalars are not writer, source, policy or owner authority and must
 * never be used alone to dispatch a first turn. No resume, mutation or retry. */
export async function readAndQualifyFreshFirstTurnIdleState(rpc: Reader,
  threadId: string, assertCurrent?: () => void): Promise<NativeFirstTurnIdleObservation> {
  if (!rpc || typeof rpc.initializedSession !== 'function' ||
      typeof rpc.isSessionCurrent !== 'function' || typeof rpc.request !== 'function' ||
      !uuid.test(threadId) || assertCurrent !== undefined &&
      typeof assertCurrent !== 'function') return fail();
  const session = await rpc.initializedSession().catch(() => fail());
  const generation = session.generation;
  const current = (): void => {
    if (!Number.isSafeInteger(generation) || generation < 1 ||
        !rpc.isSessionCurrent(generation)) fail();
    try { assertCurrent?.(); } catch { fail(); }
  };
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    current();
    const result = await rpc.request(method, params,
      { expectedGeneration: generation, timeoutMs: 10_000 }).catch(() => fail());
    current();
    return result;
  };
  const validRead = (value: unknown): boolean => {
    if (!object(value) || !object(value.thread)) return false;
    const thread = value.thread;
    return thread.id === threadId && object(thread.status) &&
      thread.status.type === 'idle' &&
      (!Object.hasOwn(thread, 'turns') || empty(thread.turns));
  };
  const readParams = { threadId, includeTurns: false };
  const first = await request('thread/read', readParams);
  if (!validRead(first)) return fail();
  const turns = await request('thread/turns/list', { threadId,
    limit: 2, sortDirection: 'asc', itemsView: 'summary' });
  // Empty native pages have been observed both with a null backwardsCursor
  // and without that optional field. A non-null anchor is not empty proof.
  if (!object(turns) || !empty(turns.data) || turns.nextCursor !== null ||
      Object.hasOwn(turns, 'backwardsCursor') && turns.backwardsCursor !== null) return fail();
  const goal = await request('thread/goal/get', { threadId });
  if (!object(goal) || !Object.hasOwn(goal, 'goal') || goal.goal !== null) return fail();
  const queue = await request('thread/queue/list', { threadId, limit: 2 });
  if (!object(queue) || !empty(queue.data) || queue.nextCursor !== null) return fail();
  const after = await request('thread/read', readParams);
  if (!validRead(after)) return fail();
  current();
  return Object.freeze({ threadId, backendGeneration: generation, status: 'idle' as const,
    turnsEmpty: true as const, goalEmpty: true as const, queueEmpty: true as const });
}
