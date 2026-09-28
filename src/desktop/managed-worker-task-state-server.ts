import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { projectManagedNativeBridgeState, type ManagedNativeBridgeState } from '../codex/managed-native-bridge-projection.js';
import type { NativeProjectionState } from '../codex/managed-native-projection.js';

export interface ManagedWorkerTaskStateEvent {
  readonly seq: number;
  readonly generation: number;
  readonly state: NativeProjectionState;
}
export interface ManagedWorkerTaskStateSource {
  /** Registers before capturing initial. All later events have contiguous seq.
   * Throw if owner projection/event tail cannot supply complete current state. */
  subscribe(listener: (event: ManagedWorkerTaskStateEvent) => void,
    onFailure: (reason: 'owner-lost' | 'projection-failed') => void): Readonly<{
      initial: ManagedWorkerTaskStateEvent;
      detach(): void;
      /** Same-generation owner/projection health, synchronous and without I/O. */
      current(): boolean;
    }>;
}
export interface ManagedWorkerTaskStateServerOptions {
  readonly epoch: string;
  readonly taskId: string;
  readonly backendGeneration: number;
  readonly token: string;
  readonly source: ManagedWorkerTaskStateSource;
  readonly heartbeatMs?: number;
}
export interface ManagedWorkerTaskStateEndpoint { readonly host: '127.0.0.1'; readonly port: number }

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 8192;
const MAX_CLIENTS = 8;
const MAX_EARLY_EVENTS = 128;
const AUTH_TIMEOUT_MS = 5000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validSeq = (seq: unknown): seq is number => Number.isSafeInteger(seq) && (seq as number) >= 0;

interface Peer { readonly socket: Socket; readonly timer: NodeJS.Timeout; stage: 'auth' | 'subscribe' | 'stream'; seq: number }

/** Optional private observation channel. It never issues App Server requests,
 * owns a worker, resumes a thread, or accepts a mutation. */
export class ManagedWorkerTaskStateServer {
  readonly #options: Readonly<ManagedWorkerTaskStateServerOptions>;
  readonly #token: Buffer;
  readonly #server: Server;
  readonly #peers = new Map<Socket, Peer>();
  #source: ReturnType<ManagedWorkerTaskStateSource['subscribe']> | null = null;
  #initial: ManagedNativeBridgeState | null = null;
  #seq = -1;
  #early: ManagedWorkerTaskStateEvent[] = [];
  #earlyBytes = 0;
  #subscribing = false;
  #earlyFailed = false;
  #heartbeat: NodeJS.Timeout | null = null;
  #listen: Promise<ManagedWorkerTaskStateEndpoint> | null = null;
  #close: Promise<void> | null = null;
  #closed = false;

  constructor(options: ManagedWorkerTaskStateServerOptions) {
    const heartbeatMs = options?.heartbeatMs ?? 20_000;
    if (!options || !uuid.test(options.epoch) || typeof options.taskId !== 'string' ||
      !options.taskId || options.taskId.length > 256 ||
      !Number.isSafeInteger(options.backendGeneration) || options.backendGeneration < 1 ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(options.token) ||
      !options.source || typeof options.source.subscribe !== 'function' ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 60_000)
      throw new TypeError('Invalid managed task-state server scope');
    this.#options = Object.freeze({ ...options, heartbeatMs });
    this.#token = Buffer.from(options.token);
    this.#server = createServer(socket => this.#accept(socket));
    this.#server.on('error', () => {});
  }

  listen(): Promise<ManagedWorkerTaskStateEndpoint> {
    if (this.#closed) return Promise.reject(new Error('Task-state server closed'));
    if (this.#listen) return this.#listen;
    try {
      this.#subscribing = true;
      const source = this.#options.source.subscribe(event => this.#receive(event), () => {
        if (this.#subscribing) this.#earlyFailed = true;
        else this.#fail();
      });
      this.#source = source;
      if (!source || typeof source.detach !== 'function' || typeof source.current !== 'function' ||
        this.#earlyFailed || source.current() !== true || this.#closed)
        throw new Error('Task-state source unavailable');
      const initial = source.initial;
      if (!this.#validEvent(initial)) throw new Error('Task-state source scope invalid');
      this.#initial = this.#project(initial.state);
      this.#seq = initial.seq;
      this.#subscribing = false;
      for (const event of this.#early.splice(0)) {
        if (event.generation !== this.#options.backendGeneration) throw new Error('Task-state source generation changed');
        if (event.seq > this.#seq) this.#acceptEvent(event);
      }
      this.#earlyBytes = 0;
      if (this.#closed || source.current() !== true) throw new Error('Task-state source unavailable');
    } catch {
      this.#subscribing = false;
      this.#fail();
      return Promise.reject(new Error('Task-state source unavailable'));
    }
    this.#listen = new Promise((resolve, reject) => {
      const failed = () => { this.#server.off('listening', ready); this.#fail(); reject(new Error('Task-state listener unavailable')); };
      const ready = () => {
        this.#server.off('error', failed);
        const address = this.#server.address();
        if (this.#closed || !address || typeof address === 'string') { failed(); return; }
        this.#heartbeat = setInterval(() => this.#heartbeatTick(), this.#options.heartbeatMs);
        this.#heartbeat.unref();
        resolve(Object.freeze({ host: '127.0.0.1', port: address.port }));
      };
      this.#server.once('error', failed); this.#server.once('listening', ready);
      this.#server.listen(0, '127.0.0.1');
    });
    return this.#listen;
  }

  #validEvent(event: ManagedWorkerTaskStateEvent): boolean {
    return object(event) && validSeq(event.seq) &&
      event.generation === this.#options.backendGeneration && object(event.state) &&
      event.state.id === this.#options.taskId && event.state.hostId === 'local';
  }

  #project(state: NativeProjectionState): ManagedNativeBridgeState {
    const projected = projectManagedNativeBridgeState(state);
    if (projected.threadId !== this.#options.taskId) throw new Error('Task-state projection scope changed');
    // Fail before publication if even a complete initial state cannot fit a
    // bounded frame. Never truncate turns and silently lose an accepted input.
    const probe = { schemaVersion: 1, kind: 'snapshot', epoch: this.#options.epoch,
      taskId: this.#options.taskId, backendGeneration: this.#options.backendGeneration,
      seq: this.#seq < 0 ? 0 : this.#seq, historyComplete: true, state: projected };
    if (Buffer.byteLength(JSON.stringify(probe), 'utf8') > MAX_FRAME_BYTES)
      throw new Error('Task-state snapshot exceeds bounded frame');
    return structuredClone(projected);
  }

  #receive(event: ManagedWorkerTaskStateEvent): void {
    if (this.#closed) return;
    if (this.#subscribing) {
      try {
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (this.#early.length >= MAX_EARLY_EVENTS ||
          bytes > MAX_FRAME_BYTES || this.#earlyBytes + bytes > MAX_SOCKET_BUFFER)
          this.#earlyFailed = true;
        else { this.#earlyBytes += bytes; this.#early.push(event); }
      } catch { this.#earlyFailed = true; }
      return;
    }
    try { this.#acceptEvent(event); } catch { this.#fail(); }
  }

  #acceptEvent(event: ManagedWorkerTaskStateEvent): void {
    if (!this.#validEvent(event) || event.seq !== this.#seq + 1 ||
      this.#source?.current() !== true || this.#closed) throw new Error('Task-state sequence unavailable');
    const projected = this.#project(event.state);
    this.#seq = event.seq;
    this.#initial = projected;
    for (const peer of this.#peers.values()) if (peer.stage === 'stream') {
      if (peer.seq + 1 !== event.seq || !this.#send(peer.socket, this.#frame('changed', projected)))
        peer.socket.destroy();
      else peer.seq = event.seq;
    }
  }

  #frame(kind: 'snapshot' | 'changed', state: ManagedNativeBridgeState): object {
    return { schemaVersion: 1, kind, epoch: this.#options.epoch, taskId: this.#options.taskId,
      backendGeneration: this.#options.backendGeneration, seq: this.#seq,
      historyComplete: true, state };
  }

  #send(socket: Socket, frame: object): boolean {
    try {
      const encoded = JSON.stringify(frame) + '\n';
      if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES ||
        socket.destroyed || socket.writableLength + Buffer.byteLength(encoded, 'utf8') > MAX_SOCKET_BUFFER)
        return false;
      socket.write(encoded);
      return true;
    } catch { return false; }
  }

  #accept(socket: Socket): void {
    if (this.#closed || this.#peers.size >= MAX_CLIENTS) { socket.destroy(); return; }
    const timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    timer.unref();
    const peer: Peer = { socket, timer, stage: 'auth', seq: -1 };
    this.#peers.set(socket, peer);
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); this.#peers.delete(socket); });
    socket.on('data', (chunk: Buffer) => {
      if (this.#closed || peer.stage === 'stream') { socket.destroy(); return; }
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > MAX_INPUT_BYTES) { socket.destroy(); return; }
      while (!socket.destroyed && buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        let frame: unknown;
        try { frame = JSON.parse(buffer.slice(0, index)); } catch { socket.destroy(); return; }
        buffer = buffer.slice(index + 1);
        if (!object(frame)) { socket.destroy(); return; }
        if (peer.stage === 'auth') {
          const presented = typeof frame.token === 'string' ? Buffer.from(frame.token) : Buffer.alloc(0);
          if (!exact(frame, ['token']) || presented.length !== this.#token.length ||
            !timingSafeEqual(presented, this.#token)) { socket.destroy(); return; }
          peer.stage = 'subscribe';
          if (!this.#send(socket, { ok: true })) socket.destroy();
          continue;
        }
        let sourceCurrent = false;
        try { sourceCurrent = this.#source?.current() === true; } catch { /* unavailable */ }
        if (!exact(frame, ['method', 'epoch', 'taskId', 'backendGeneration']) ||
          frame.method !== 'observe-task-v1' || frame.epoch !== this.#options.epoch ||
          frame.taskId !== this.#options.taskId ||
          frame.backendGeneration !== this.#options.backendGeneration ||
          !sourceCurrent || this.#closed || !this.#initial) { socket.destroy(); return; }
        peer.stage = 'stream'; peer.seq = this.#seq; clearTimeout(timer);
        if (!this.#send(socket, this.#frame('snapshot', this.#initial))) socket.destroy();
        if (buffer.length) { socket.destroy(); return; }
      }
    });
  }

  #heartbeatTick(): void {
    if (this.#closed) return;
    try { if (this.#source?.current() !== true || this.#closed) { this.#fail(); return; } }
    catch { this.#fail(); return; }
    const frame = { schemaVersion: 1, kind: 'heartbeat', epoch: this.#options.epoch,
      taskId: this.#options.taskId, backendGeneration: this.#options.backendGeneration,
      seq: this.#seq };
    for (const peer of this.#peers.values()) if (peer.stage === 'stream' && !this.#send(peer.socket, frame))
      peer.socket.destroy();
  }

  #fail(): void { void this.close(); }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    try { this.#source?.detach(); } catch { /* observation is already retired */ }
    this.#source = null;
    this.#early.length = 0;
    this.#earlyBytes = 0;
    for (const peer of this.#peers.values()) peer.socket.destroy();
    this.#close = (async () => {
      // A close arriving between listen() and its 'listening' callback must
      // wait for that bind attempt before deciding whether a socket exists.
      await this.#listen?.catch(() => {});
      if (!this.#server.listening) return;
      await new Promise<void>(resolve => this.#server.close(() => resolve()));
    })();
    return this.#close;
  }
}
