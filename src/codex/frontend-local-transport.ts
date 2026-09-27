import { createServer, connect as connectTcp } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const LOOPBACK_HOST = '127.0.0.1';

export type FrontendFrame = Record<string, unknown>;
export interface FrontendAttachment {
  receive(frame: FrontendFrame): unknown | Promise<unknown>;
  detach(): void;
}
export interface FrontendSessions {
  attach(send: (payload: FrontendFrame) => boolean): FrontendAttachment;
}
export interface FrontendLocalTransportOptions {
  readonly sessions: FrontendSessions;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly authTimeoutMs?: number;
  readonly maxFrameBytes?: number;
}
interface FrontendState {
  readonly socket: Socket;
  attachment: FrontendAttachment | null;
  readonly generation: number;
  detached: boolean;
}
export interface FrontendTransportMetadata {
  readonly address: AddressInfo | null;
  readonly authenticatedCount: 0 | 1;
  readonly authenticatedConnections: number;
  readonly generation: number;
  readonly hasFrontend: boolean;
}

function tokenMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function closeSocket(socket: Socket): void { if (!socket.destroyed) socket.destroy(); }
function requireLoopback(host: string): void { if (host !== LOOPBACK_HOST) throw new TypeError('only 127.0.0.1 is permitted'); }
function object(value: unknown): value is FrontendFrame {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Single-owner local frontend transport. `sessions.attach(send)` must return
 * `{ receive(frame), detach() }`; neither callback may own the backend process.
 */
export class PersistentFrontendLocalTransport {
  #server: Server;
  #token: string;
  #current: FrontendState | null = null;
  #generation = 0;
  #authenticated = 0;
  #closed = false;
  #sockets = new Set<Socket>();
  readonly sessions: FrontendSessions;
  readonly host: string;
  readonly port: number;
  readonly authTimeoutMs: number;
  readonly maxFrameBytes: number;

  constructor({ sessions, host = LOOPBACK_HOST, port = 0, token = randomBytes(32).toString('base64url'),
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES }: FrontendLocalTransportOptions) {
    if (!sessions || typeof sessions.attach !== 'function') throw new TypeError('sessions.attach is required');
    requireLoopback(host);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid loopback port');
    if (!Number.isSafeInteger(authTimeoutMs) || authTimeoutMs < 1 || authTimeoutMs > 60_000)
      throw new TypeError('invalid authentication timeout');
    if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new TypeError('token must be a 256-bit secret');
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024) throw new TypeError('maxFrameBytes is invalid');
    this.sessions = sessions;
    this.host = host;
    this.port = port;
    this.authTimeoutMs = authTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.#token = token;
    this.#server = createServer(socket => this.#accept(socket));
  }

  /** Keep this capability in memory or a private file; never place it in argv/logs. */
  authToken(): string { return this.#token; }
  get address(): AddressInfo | null {
    const address = this.#server.address();
    return address && typeof address !== 'string' ? address : null;
  }
  get metadata(): FrontendTransportMetadata { return Object.freeze({ address: this.address, authenticatedCount: this.#current ? 1 : 0,
    authenticatedConnections: this.#authenticated, generation: this.#generation, hasFrontend: this.#current !== null }); }

  async listen(): Promise<AddressInfo> {
    if (this.#closed) throw new Error('transport is closed');
    this.#server.listen(this.port, this.host);
    await once(this.#server, 'listening');
    const address = this.address;
    if (!address) throw new Error('frontend transport did not bind');
    return address;
  }
  onClose(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('close listener must be a function');
    this.#server.on('close', listener);
    return () => this.#server.off('close', listener);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#sockets) closeSocket(socket);
    await new Promise<void>(resolve => this.#server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let state: FrontendState | null = null;
    let authenticated = false;
    const authTimer = setTimeout(() => closeSocket(socket), this.authTimeoutMs);
    authTimer.unref?.();
    const fail = () => closeSocket(socket);
    socket.on('data', (chunk: Buffer) => {
      if (socket.destroyed) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > this.maxFrameBytes) fail();
          return;
        }
        if (newline > this.maxFrameBytes) return fail();
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length && line[line.length - 1] === 0x0d) return fail();
        let frame: unknown;
        try { frame = JSON.parse(line.toString('utf8')); } catch { return fail(); }
        if (!object(frame)) return fail();
        if (!authenticated) {
          if (Object.keys(frame).length !== 1 || typeof frame.token !== 'string' || !tokenMatches(frame.token, this.#token)) return fail();
          authenticated = true;
          clearTimeout(authTimer);
          const next: FrontendState = { socket, attachment: null, generation: ++this.#generation, detached: false };
          this.#retire(this.#current);
          this.#current = next;
          try {
            next.attachment = this.sessions.attach(payload => this.#send(next, payload));
            if (!next.attachment || typeof next.attachment.receive !== 'function' || typeof next.attachment.detach !== 'function') throw new TypeError('session attachment must provide receive and detach');
          } catch { this.#retire(next); return fail(); }
          this.#authenticated++;
          if (!this.#send(next, { ok: true, generation: next.generation })) return;
          state = next;
          continue;
        }
        if (!state || state !== this.#current || !state.attachment) return fail();
        try {
          Promise.resolve(state.attachment.receive(frame)).catch(() => {
            if (state === this.#current) this.#retire(state);
          });
        } catch { return fail(); }
      }
    });
    socket.once('close', () => {
      clearTimeout(authTimer);
      this.#sockets.delete(socket);
      if (state === this.#current) this.#retire(state);
    });
  }

  #send(state: FrontendState, payload: FrontendFrame): boolean {
    if (state !== this.#current || state.socket.destroyed) return false;
    let text;
    try { text = `${JSON.stringify(payload)}\n`; } catch { this.#retire(state); return false; }
    const size = Buffer.byteLength(text);
    if (size > this.maxFrameBytes || state.socket.writableLength + size > this.maxFrameBytes) {
      this.#retire(state); return false;
    }
    try {
      const accepted = state.socket.write(text);
      if (!accepted && state.socket.writableLength > this.maxFrameBytes) { this.#retire(state); return false; }
      return true;
    } catch { this.#retire(state); return false; }
  }
  #retire(state: FrontendState | null): void {
    if (!state || state.detached) return;
    state.detached = true;
    if (this.#current === state) this.#current = null;
    try { state.attachment?.detach(); } catch { /* frontend cleanup is isolated */ }
    closeSocket(state.socket);
  }
}

/** Authenticate a local JSONL frontend then pipe raw frame bytes. */
export interface FrontendPipeOptions {
  readonly host?: string;
  readonly port: number;
  readonly token: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly authTimeoutMs?: number;
}

export async function connectAndPipe({ host = LOOPBACK_HOST, port, token, stdin, stdout,
  authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS }: FrontendPipeOptions): Promise<Socket> {
  requireLoopback(host);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid loopback port');
  if (!Number.isSafeInteger(authTimeoutMs) || authTimeoutMs < 1 || authTimeoutMs > 60_000)
    throw new TypeError('invalid authentication timeout');
  if (typeof token !== 'string') throw new TypeError('token is required');
  if (!stdin || !stdout) throw new TypeError('stdin and stdout are required');
  const socket = connectTcp({ host, port });
  socket.on('error', () => {}); // socket errors must not become an uncaught shim failure.
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ token })}\n`);
  let remainder = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('authentication acknowledgement timed out')), authTimeoutMs);
    timer.unref?.();
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); socket.off('data', onData); socket.off('close', onClose); socket.off('error', onError);
      if (error) { closeSocket(socket); reject(error); } else resolve();
    };
    const onClose = () => finish(new Error('socket closed before authentication acknowledgement'));
    const onError = () => finish(new Error('socket failed before authentication acknowledgement'));
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024) return finish(new Error('authentication acknowledgement is oversized'));
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let ack: unknown;
      try { ack = JSON.parse(buffer.subarray(0, newline).toString('utf8')); } catch { return finish(new Error('invalid authentication acknowledgement')); }
      if (!object(ack) || ack.ok !== true) return finish(new Error('authentication rejected'));
      remainder = buffer.subarray(newline + 1);
      finish();
    };
    socket.on('data', onData); socket.once('close', onClose); socket.once('error', onError);
  });
  if (remainder.length) stdout.write(remainder);
  socket.pipe(stdout, { end: false });
  stdin.pipe(socket);
  socket.once('close', () => { stdin.unpipe(socket); stdin.pause?.(); });
  return socket;
}

/** Start one authenticated loopback endpoint without exposing the secret in argv. */
export async function startFrontendServer(options: FrontendLocalTransportOptions): Promise<Readonly<{
  host: string; port: number; token: string; metadata: () => FrontendTransportMetadata;
  close: () => Promise<void>; onClose: (listener: () => void) => () => void;
  transport: PersistentFrontendLocalTransport;
}>> {
  const transport = new PersistentFrontendLocalTransport(options);
  const address = await transport.listen();
  return Object.freeze({ host: address.address, port: address.port, token: transport.authToken(),
    metadata: () => transport.metadata, close: () => transport.close(), onClose: listener => transport.onClose(listener), transport });
}
/** Connect and raw-pipe a local frontend; token is supplied in memory only. */
export async function connectFrontend(options: Omit<FrontendPipeOptions, 'stdin' | 'stdout'> & {
  readonly input?: Readable; readonly output?: Writable;
  readonly stdin?: Readable; readonly stdout?: Writable;
}): Promise<Socket> {
  const stdin = options.input ?? options.stdin;
  const stdout = options.output ?? options.stdout;
  if (!stdin || !stdout) throw new TypeError('stdin and stdout are required');
  return connectAndPipe({ ...options, stdin, stdout });
}
