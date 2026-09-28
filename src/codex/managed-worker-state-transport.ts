import { createConnection, type Socket } from 'node:net';
import type { TaskRef } from '../core/codex-tasks.js';
import type { TaskState, TaskStateStream, TaskStateTransport } from '../core/task-state.js';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const MAX_START_TIMEOUT_MS = 60_000;
// The worker permits heartbeatMs up to 60 s; allow one delayed beat while
// still refusing a silent socket that no longer proves the same stream.
const OWNER_FRESHNESS_MS = 90_000;
const decoder = new TextDecoder('utf-8', { fatal: true });
const exactKeys = (value: Row, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nonConversationItems = new Set(['commandExecution', 'fileChange', 'webSearch',
  'mcpToolCall', 'dynamicToolCall', 'reasoning', 'plan', 'contextCompaction',
  'permissionRequest', 'userInputResponse']);

export interface ManagedWorkerStateEndpoint {
  readonly hostId: string;
  readonly sourceId?: string;
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly backendGeneration: number;
  readonly port: number;
  /** Private bearer capability loaded by the caller, never from a public status file. */
  readonly token: string;
}

function invalid(reason: string): Error { return new Error(`managed state stream: ${reason}`); }
function validState(value: unknown, taskId: string): value is TaskState {
  if (!object(value) || value.kind !== 'app-server' || value.threadId !== taskId ||
    !(value.title === null || typeof value.title === 'string') ||
    typeof value.cwd !== 'string' || !value.cwd || typeof value.model !== 'string' || !value.model ||
    !(value.effort === null || typeof value.effort === 'string') ||
    !['idle', 'active', 'systemError', 'notLoaded'].includes(String(value.runtimeStatus)) ||
    typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
    !(value.context === null || object(value.context) &&
      typeof value.context.used === 'number' && Number.isFinite(value.context.used) &&
      typeof value.context.window === 'number' && Number.isFinite(value.context.window) &&
      typeof value.context.percent === 'number' && Number.isFinite(value.context.percent)) ||
    !Array.isArray(value.questions) || value.questions.length !== 0 || !Array.isArray(value.turns)) return false;
  const turnIds = new Set<string>();
  for (const turn of value.turns) {
    if (!object(turn) || typeof turn.id !== 'string' || !turn.id || turnIds.has(turn.id) ||
      !['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status)) ||
      typeof turn.startedAt !== 'number' || !Number.isFinite(turn.startedAt) || turn.startedAt < 0 ||
      !Array.isArray(turn.items)) return false;
    turnIds.add(turn.id);
    const itemIds = new Set<string>();
    for (const item of turn.items) {
      if (!object(item) || typeof item.id !== 'string' || !item.id || itemIds.has(item.id) ||
        typeof item.type !== 'string' || !item.type) return false;
      itemIds.add(item.id);
      if (item.type === 'userMessage' &&
        (!(item.clientId === null || typeof item.clientId === 'string') ||
          !Array.isArray(item.content) || item.content.some(part =>
            !object(part) || part.type !== 'text' || typeof part.text !== 'string'))) return false;
      if (item.type === 'agentMessage' &&
        (typeof item.text !== 'string' ||
          !(item.phase == null || item.phase === 'commentary' || item.phase === 'final_answer') ||
          item.delivery === 'async')) return false;
      if (item.type !== 'userMessage' && item.type !== 'agentMessage' &&
        !nonConversationItems.has(item.type)) return false;
    }
  }
  return true;
}

class ManagedWorkerStateStream implements TaskStateStream {
  private socket: Socket | null = null;
  private pending = Buffer.alloc(0);
  private readonly frameDecoder = decoder;
  private stage: 'new' | 'auth' | 'snapshot' | 'live' | 'closed' = 'new';
  private seq: number | null = null;
  private lastFrameAt = 0;
  private failure: Error | null = null;
  private starting: Promise<void> | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private deadline: NodeJS.Timeout | null = null;

  constructor(readonly task: TaskRef, private readonly endpoint: ManagedWorkerStateEndpoint,
    private readonly onState: (state: TaskState, initial: boolean) => void,
    private readonly onError: (error: Error) => void) {}

  diagnostic(): { kind: 'app-server' | 'unknown' } {
    return { kind: this.stage === 'live' ? 'app-server' : 'unknown' };
  }

  start(timeoutMs = DEFAULT_START_TIMEOUT_MS): Promise<void> {
    if (this.starting) return this.starting;
    if (this.stage !== 'new') return Promise.reject(this.failure ?? invalid('subscription closed'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_START_TIMEOUT_MS)
      return Promise.reject(invalid('invalid start deadline'));
    this.starting = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve; this.rejectStart = reject;
    });
    this.deadline = setTimeout(() => this.fail(invalid('initial snapshot deadline exceeded')), timeoutMs);
    this.socket = createConnection({ host: '127.0.0.1', port: this.endpoint.port });
    this.socket.setNoDelay(true);
    this.socket.on('connect', () => {
      if (this.stage !== 'new') return;
      this.stage = 'auth';
      this.socket?.write(JSON.stringify({ token: this.endpoint.token }) + '\n');
    });
    this.socket.on('data', chunk => this.receive(chunk));
    this.socket.on('error', () => this.fail(invalid('connection failure')));
    this.socket.on('end', () => this.fail(invalid('connection ended')));
    this.socket.on('close', () => this.fail(invalid('connection closed')));
    return this.starting;
  }

  async verifyOwner(): Promise<void> {
    if (this.stage !== 'live' || this.failure || !this.socket || this.socket.destroyed ||
      Date.now() - this.lastFrameAt > OWNER_FRESHNESS_MS)
      throw this.failure ?? invalid('current worker stream not verified');
  }

  close(): void {
    if (this.stage === 'closed') return;
    this.stage = 'closed';
    this.clearDeadline();
    this.socket?.destroy(); this.socket = null;
    this.rejectStart?.(invalid('subscription closed'));
    this.resolveStart = null; this.rejectStart = null;
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private fail(error: Error): void {
    if (this.stage === 'closed') return;
    const hadSnapshot = this.stage === 'live';
    this.failure = error;
    const rejectStart = this.rejectStart;
    this.rejectStart = null;
    this.resolveStart = null;
    this.close();
    rejectStart?.(error);
    if (hadSnapshot) {
      try { this.onError(error); } catch { /* downstream is not a worker lifecycle authority */ }
    }
  }

  private receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.stage === 'closed') return;
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.pending.length + part.length > MAX_FRAME_BYTES) {
        this.fail(invalid('frame exceeds limit')); return;
      }
      this.pending = Buffer.concat([this.pending, part]);
      offset = newline < 0 ? chunk.length : newline + 1;
      if (newline < 0) break;
      let message: unknown;
      try { message = JSON.parse(this.frameDecoder.decode(this.pending)); }
      catch {
        this.fail(invalid('invalid JSONL frame'));
        return;
      }
      this.pending = Buffer.alloc(0);
      try { this.frame(message); }
      catch (error) {
        this.fail(error instanceof Error && error.message.startsWith('managed state stream:')
          ? error : invalid('state callback failed'));
      }
    }
  }

  private frame(value: unknown): void {
    if (!object(value)) throw invalid('invalid frame');
    if (this.stage === 'auth') {
      if (!exactKeys(value, ['ok']) || value.ok !== true) throw invalid('authentication refused');
      this.stage = 'snapshot';
      this.socket?.write(JSON.stringify({ method: 'observe-task-v1', epoch: this.endpoint.ownerEpoch,
        taskId: this.endpoint.taskId, backendGeneration: this.endpoint.backendGeneration }) + '\n');
      return;
    }
    if (this.stage !== 'snapshot' && this.stage !== 'live') throw invalid('unexpected frame');
    if (value.schemaVersion !== 1 || value.epoch !== this.endpoint.ownerEpoch ||
      value.taskId !== this.endpoint.taskId || value.backendGeneration !== this.endpoint.backendGeneration ||
      !Number.isSafeInteger(value.seq) || (value.seq as number) < 0) throw invalid('scope mismatch');
    const seq = value.seq as number;
    if (value.kind === 'heartbeat') {
      if (!exactKeys(value, ['schemaVersion', 'kind', 'epoch', 'taskId', 'backendGeneration', 'seq']) ||
        this.stage !== 'live' || seq !== this.seq) throw invalid('heartbeat sequence mismatch');
      this.lastFrameAt = Date.now();
      return;
    }
    if (this.stage === 'snapshot' ? value.kind !== 'snapshot' : value.kind !== 'changed')
      throw invalid('unexpected state frame');
    if (!exactKeys(value, ['schemaVersion', 'kind', 'epoch', 'taskId', 'backendGeneration',
      'seq', 'historyComplete', 'state'])) throw invalid('unexpected state frame fields');
    if (this.stage === 'live' && seq !== this.seq! + 1) throw invalid('state sequence gap');
    if (value.historyComplete !== true || !validState(value.state, this.endpoint.taskId))
      throw invalid('full history state required');
    const initial = this.stage === 'snapshot';
    this.seq = seq;
    this.lastFrameAt = Date.now();
    this.stage = 'live';
    this.onState(value.state, initial);
    if (initial && this.stage === 'live') {
      this.clearDeadline();
      this.resolveStart?.();
      this.resolveStart = null; this.rejectStart = null;
    }
  }
}

/** Opt-in bridge transport. The caller binds its private capability to one
 * exact worker epoch/task/generation; this transport never resumes a worker or
 * routes to a legacy profile on failure. */
export class ManagedWorkerStateTransport implements TaskStateTransport {
  private readonly endpoint: ManagedWorkerStateEndpoint;
  private readonly streams = new Set<ManagedWorkerStateStream>();
  private closed = false;

  constructor(options: ManagedWorkerStateEndpoint) {
    if (options.hostId !== 'local' || typeof options.taskId !== 'string' || !options.taskId ||
      !uuid.test(options.ownerEpoch) || !Number.isSafeInteger(options.backendGeneration) ||
      options.backendGeneration < 1 || !Number.isSafeInteger(options.port) ||
      options.port < 1 || options.port > 65535 || typeof options.token !== 'string' ||
      !options.token || options.token.length > 4096 ||
      !(options.sourceId === undefined || typeof options.sourceId === 'string'))
      throw invalid('invalid private endpoint scope');
    this.endpoint = Object.freeze({ hostId: options.hostId,
      ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
      taskId: options.taskId, ownerEpoch: options.ownerEpoch,
      backendGeneration: options.backendGeneration, port: options.port, token: options.token });
  }

  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void,
    onError: (error: Error) => void): TaskStateStream {
    if (this.closed || task.hostId !== this.endpoint.hostId || task.threadId !== this.endpoint.taskId ||
      (task.sourceId ?? '') !== (this.endpoint.sourceId ?? '')) throw invalid('task outside exclusive scope');
    const stream = new ManagedWorkerStateStream(task, this.endpoint, onState, onError);
    this.streams.add(stream);
    return { task, start: timeoutMs => stream.start(timeoutMs), verifyOwner: () => stream.verifyOwner(),
      diagnostic: () => stream.diagnostic(), close: () => { stream.close(); this.streams.delete(stream); } };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams) stream.close();
    this.streams.clear();
  }
}
