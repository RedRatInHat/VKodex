import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { TextDecoder } from 'node:util';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { FrontendAttachment, FrontendFrame, FrontendSessions } from './frontend-local-transport.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface FrontendWebSocketTransportOptions {
  readonly sessions: FrontendSessions;
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly authTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
}

interface FrontendState {
  readonly socket: WebSocket;
  readonly generation: number;
  attachment: FrontendAttachment | null;
  detached: boolean;
}

export interface FrontendWebSocketMetadata {
  readonly address: AddressInfo | null;
  readonly authenticatedCount: 0 | 1;
  readonly authenticatedConnections: number;
  readonly generation: number;
  readonly hasFrontend: boolean;
}

function validToken(token: unknown): token is string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  const decoded = Buffer.from(token, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === token;
}

function equalToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'ascii'); const right = Buffer.from(expected, 'ascii');
  return left.length === right.length && timingSafeEqual(left, right);
}

function object(value: unknown): value is FrontendFrame {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Optional loopback WebSocket frontend for a native CLI. It owns only the
 * frontend attachment; session/backend ownership remains with FrontendSessions. */
export class PersistentFrontendWebSocketTransport {
  readonly host: string;
  readonly port: number;
  readonly authTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly sessions: FrontendSessions;
  #token: string;
  #server: Server;
  #wss: WebSocketServer;
  #sockets = new Set<Socket>();
  #current: FrontendState | null = null;
  #generation = 0;
  #authenticated = 0;
  #closed = false;
  #listenPromise: Promise<AddressInfo> | null = null;
  #cancelListen: (() => void) | null = null;
  #closePromise: Promise<void> | null = null;

  constructor({ sessions, host = LOOPBACK_HOST, port = 0, token = randomBytes(32).toString('base64url'),
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxBufferedBytes = DEFAULT_MAX_FRAME_BYTES }: FrontendWebSocketTransportOptions) {
    if (!sessions || typeof sessions.attach !== 'function') throw new TypeError('sessions.attach is required');
    if (host !== LOOPBACK_HOST) throw new TypeError('only 127.0.0.1 is permitted');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid loopback port');
    if (!validToken(token)) throw new TypeError('token must be a canonical 256-bit base64url secret');
    if (!Number.isSafeInteger(authTimeoutMs) || authTimeoutMs < 1 || authTimeoutMs > 60_000) throw new TypeError('invalid authentication timeout');
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 64 * 1024 * 1024)
      throw new TypeError('invalid maxFrameBytes');
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1024 || maxBufferedBytes > 64 * 1024 * 1024)
      throw new TypeError('invalid maxBufferedBytes');
    this.sessions = sessions; this.host = host; this.port = port; this.authTimeoutMs = authTimeoutMs;
    this.maxFrameBytes = maxFrameBytes; this.maxBufferedBytes = maxBufferedBytes; this.#token = token;
    this.#server = createServer((_request, response) => { response.writeHead(404, { 'Content-Length': '0' }); response.end(); });
    this.#wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: maxFrameBytes,
      perMessageDeflate: false });
    this.#wss.on('wsClientError', (_error, socket) => { socket.destroy(); });
    this.#server.on('connection', socket => {
      this.#sockets.add(socket);
      socket.setTimeout(this.authTimeoutMs, () => socket.destroy());
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => {});
    });
    this.#server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
  }

  /** Capability for a private launch channel; never put it in argv, URL, or logs. */
  authToken(): string { return this.#token; }
  get address(): AddressInfo | null {
    const address = this.#server.address();
    return address && typeof address !== 'string' ? address : null;
  }
  get metadata(): FrontendWebSocketMetadata {
    return Object.freeze({ address: this.address, authenticatedCount: this.#current ? 1 : 0,
      authenticatedConnections: this.#authenticated, generation: this.#generation,
      hasFrontend: this.#current !== null });
  }

  listen(): Promise<AddressInfo> {
    if (this.#closed) return Promise.reject(new Error('transport is closed'));
    if (this.#listenPromise) return this.#listenPromise;
    const attempt = new Promise<AddressInfo>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.#server.off('listening', onListening);
        this.#server.off('error', onError);
        this.#server.off('close', onClose);
        this.#cancelListen = null;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; cleanup();
        if (error) { reject(error); return; }
        const address = this.address;
        if (address) resolve(address);
        else reject(new Error('frontend WebSocket transport did not bind'));
      };
      const onListening = () => finish(this.#closed ? new Error('transport is closed') : undefined);
      const onError = () => finish(new Error('frontend WebSocket transport could not bind'));
      const onClose = () => finish(new Error('transport is closed'));
      this.#cancelListen = onClose;
      this.#server.once('listening', onListening);
      this.#server.once('error', onError);
      this.#server.once('close', onClose);
      try { this.#server.listen(this.port, this.host); }
      catch { finish(new Error('frontend WebSocket transport could not bind')); }
    });
    this.#listenPromise = attempt;
    void attempt.catch(() => { if (this.#listenPromise === attempt) this.#listenPromise = null; });
    return attempt;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const onError = () => {};
    this.#server.on('error', onError);
    this.#cancelListen?.();
    this.#retire(this.#current);
    for (const socket of this.#sockets) socket.destroy();
    this.#closePromise = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error | null) => {
        this.#server.off('error', onError);
        this.#wss.close();
        if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error);
        else resolve();
      };
      try { this.#server.close(finish); }
      catch (error) { finish(error instanceof Error ? error : new Error('frontend WebSocket transport close failed')); }
    });
    return this.#closePromise;
  }

  #authorized(request: IncomingMessage): boolean {
    if (request.method !== 'GET' || request.url !== '/' || request.socket.remoteAddress !== LOOPBACK_HOST) return false;
    const headers: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === 'authorization') headers.push(request.rawHeaders[index + 1] ?? '');
    }
    if (headers.length !== 1 || !headers[0]!.startsWith('Bearer ')) return false;
    return equalToken(headers[0]!.slice('Bearer '.length), this.#token);
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.#closed || !this.#authorized(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    try {
      this.#wss.handleUpgrade(request, socket, head, frontend => {
        if (this.#closed) { frontend.terminate(); return; }
        request.socket.setTimeout(0);
        const next: FrontendState = { socket: frontend, generation: ++this.#generation, attachment: null, detached: false };
        this.#retire(this.#current);
        this.#current = next;
        frontend.on('error', () => this.#retire(next));
        frontend.on('close', () => this.#retire(next));
        try {
          next.attachment = this.sessions.attach(payload => this.#send(next, payload));
          if (!next.attachment || typeof next.attachment.receive !== 'function' ||
            typeof next.attachment.detach !== 'function') throw new TypeError('invalid frontend attachment');
        } catch { this.#retire(next); return; }
        this.#authenticated++;
        frontend.on('message', (data, binary) => this.#receive(next, data, binary));
      });
    } catch { socket.destroy(); }
  }

  #receive(state: FrontendState, data: RawData, binary: boolean): void {
    if (state !== this.#current || !state.attachment || binary) { this.#retire(state); return; }
    let frame: unknown;
    try {
      const bytes = rawBuffer(data);
      if (bytes.length > this.maxFrameBytes) throw new Error('frame too large');
      frame = JSON.parse(utf8.decode(bytes));
    } catch { this.#retire(state); return; }
    if (!object(frame)) { this.#retire(state); return; }
    try {
      Promise.resolve(state.attachment.receive(frame)).catch(() => this.#retire(state));
    } catch { this.#retire(state); }
  }

  #send(state: FrontendState, frame: FrontendFrame): boolean {
    if (state !== this.#current || state.socket.readyState !== WebSocket.OPEN || !object(frame)) return false;
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
      if (typeof serialized !== 'string') throw new TypeError('frontend frame is not JSON serializable');
    }
    catch { this.#retire(state); return false; }
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxFrameBytes || state.socket.bufferedAmount + bytes + 14 > this.maxBufferedBytes) {
      this.#retire(state); return false;
    }
    try { state.socket.send(serialized, { binary: false, compress: false }, error => { if (error) this.#retire(state); }); }
    catch { this.#retire(state); return false; }
    return true;
  }

  #retire(state: FrontendState | null): void {
    if (!state || state.detached) return;
    state.detached = true;
    if (this.#current === state) this.#current = null;
    try { state.attachment?.detach(); } catch { /* Session cleanup is isolated. */ }
    state.socket.terminate();
  }
}
