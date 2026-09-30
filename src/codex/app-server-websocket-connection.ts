import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import WebSocket, { type RawData } from "ws";
import { AppServerConnection, type AppServerWireEndpoint } from "./app-server-connection.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const textFrame = (frame: RawData): Buffer => Array.isArray(frame) ? Buffer.concat(frame)
  : frame instanceof ArrayBuffer ? Buffer.from(frame) : frame;

/** One authenticated client connection. Closing it never stops the native server. */
class AppServerWebSocketEndpoint extends EventEmitter implements AppServerWireEndpoint {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #socket: WebSocket;
  #fragment = "";
  #waiting: string[] = [];
  #waitingBytes = 0;
  #closed = false;

  constructor(url: string, token: string) {
    super();
    this.#socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.#acceptInput(chunk));
    this.stdin.once("end", () => { void this.close(); });
    this.#socket.once("open", () => this.#flush());
    this.#socket.on("message", (frame, binary) => {
      if (this.#closed) return;
      const bytes = textFrame(frame);
      if (binary || bytes.length > MAX_FRAME_BYTES) {
        this.#socket.terminate(); return;
      }
      if (!this.stdout.write(`${bytes.toString("utf8")}\n`)) {
        this.#socket.pause();
        this.stdout.once("drain", () => this.#socket.resume());
      }
    });
    this.#socket.once("error", () => this.#disconnected());
    this.#socket.once("close", () => this.#disconnected());
  }

  #acceptInput(chunk: string): void {
    if (this.#closed) return;
    this.#fragment += chunk;
    if (Buffer.byteLength(this.#fragment, "utf8") > MAX_FRAME_BYTES) {
      this.#socket.terminate(); return;
    }
    let end: number;
    while ((end = this.#fragment.indexOf("\n")) >= 0) {
      const frame = this.#fragment.slice(0, end);
      this.#fragment = this.#fragment.slice(end + 1);
      if (!frame) continue;
      if (this.#socket.readyState === WebSocket.OPEN) this.#send(frame);
      else if (this.#socket.readyState === WebSocket.CONNECTING) {
        this.#waitingBytes += Buffer.byteLength(frame, "utf8");
        if (this.#waitingBytes > MAX_FRAME_BYTES) { this.#socket.terminate(); return; }
        this.#waiting.push(frame);
      } else { this.#disconnected(); return; }
    }
  }

  #send(frame: string): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    if (this.#socket.bufferedAmount + Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      this.#socket.terminate(); return;
    }
    try { this.#socket.send(frame, error => { if (error) this.#socket.terminate(); }); }
    catch { this.#socket.terminate(); }
  }

  #flush(): void {
    for (const frame of this.#waiting) this.#send(frame);
    this.#waiting = []; this.#waitingBytes = 0;
  }

  #disconnected(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#waiting = []; this.#waitingBytes = 0; this.#fragment = "";
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
    this.stdin.destroy(); this.stdout.end(); this.stderr.end();
    this.emit("close");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    else if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close();
    const deadline = setTimeout(() => this.#socket.terminate(), 1_000);
    try {
      if (!this.#closed) await new Promise<void>(resolve => this.once("close", resolve));
    } finally { clearTimeout(deadline); }
  }
}

/** The URL and bearer are private owner capabilities, not a public VK setting. */
export function createAppServerWebSocketConnection(url: string, token: string,
  timeoutMs = 30_000, assertBeforeConnect?: () => void): AppServerConnection {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/" ||
    endpoint.search || endpoint.hash || !/^[A-Za-z0-9_-]{16,512}$/u.test(token))
    throw new TypeError("Invalid local App Server WebSocket capability");
  return new AppServerConnection(() => {
    assertBeforeConnect?.();
    return new AppServerWebSocketEndpoint(endpoint.href, token);
  },
    undefined, timeoutMs, wire => (wire as AppServerWebSocketEndpoint).close());
}
