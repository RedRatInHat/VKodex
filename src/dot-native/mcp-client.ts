import { randomUUID } from "node:crypto";
import { diagnosticEvent, diagnosticError } from "../bridge/diagnostics.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const nativeReasons: Readonly<Record<string, string>> = Object.freeze({
  "Native session is closed": "closed", "Installed MCP server is absent": "source-missing",
  "Unqualified MCP version": "protocol-mismatch", "Required native tools are absent": "unsupported",
  "Native target mismatch": "source-mismatch", "Native send target mismatch": "source-mismatch",
  "Native tool returned an error": "request-rejected", "Invalid native tool result": "invalid-response",
  "Native session is disconnected": "disconnect", "Native request timed out": "timeout",
  "Native RPC rejected or malformed": "invalid-response", "Native session disconnected": "disconnect",
});
export class NativeMcpError extends Error {
  readonly reason: string;
  constructor(readonly outcome: "unavailable" | "rejected" | "uncertain", message: string) {
    super(message); this.name = "NativeMcpError"; this.reason = Object.hasOwn(nativeReasons, message) ? nativeReasons[message]! : "other";
  }
}
export interface NativeMcpOptions {
  /** Installed official plugin directory, never a downloaded server. */
  readonly pluginRoot: string;
  /** Actual app task that owns this bridge process. Never impersonate the dot. */
  readonly callerThreadId: string;
  readonly callerHostId: "local" | "durable";
  readonly targetThreadId: string;
  /** Supplied by the app to this executor; no pipe enumeration or guessing. */
  readonly pipePath: string;
  readonly timeoutMs?: number;
}
/** Pass only runtime necessities to the installed pipe client, not VK/API credentials. */
export function nativeChildEnvironment(env: NodeJS.ProcessEnv, pipePath: string, callerHostId: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const allowed = new Set(["path","systemroot","windir","temp","tmp","home","userprofile","localappdata","appdata","lang","tz","node_options"]);
  for(const [key,value] of Object.entries(env)) if(allowed.has(key.toLowerCase()) && value!==undefined)result[key]=value;
  result.CODEX_APP_TOOLS_PIPE_PATH=pipePath; result.CODEX_APP_TOOLS_CALLER_HOST_ID=callerHostId;
  return result;
}
interface Pending {
  readonly mutation: boolean;
  readonly resolve: (result: Obj) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
/** A single official MCP session. No automatic restart or mutation retry.
 * Callers may reconnect read-only polling; an uncertain send needs reconciliation.
 * Native history stays inside the process until the public-reply allowlist runs.
 */
export class NativeDotMcpClient {
  private readonly connectionId = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private ready = false;
  private starting: Promise<void> | null = null;
  private disposed = false;
  constructor(private readonly options: NativeMcpOptions,
    private readonly launch: () => ChildProcessWithoutNullStreams = () => spawn(process.execPath,
      [join(options.pluginRoot, "server.mjs")], {
        cwd: options.pluginRoot, stdio: ["pipe", "pipe", "pipe"],
        env: nativeChildEnvironment(process.env, options.pipePath, options.callerHostId),
      })) {
    if (!isAbsolute(options.pluginRoot) || !options.pipePath ||
        !options.callerThreadId || !options.targetThreadId ||
        options.callerThreadId === options.targetThreadId ||
        !["local", "durable"].includes(options.callerHostId)) throw new TypeError("Invalid native task binding");
  }
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new NativeMcpError("unavailable", "Native session is closed"));
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    const started = Date.now();
    const fields = { route: "dot-native", connectionId: this.connectionId, threadId: this.options.targetThreadId };
    diagnosticEvent("connection.start", { ...fields, stage: "initialize" });
    return this.starting = this.initialize().then(() => {
      diagnosticEvent("connection.result", { ...fields, outcome: "success", elapsedMs: Date.now() - started });
    }, error => {
      diagnosticEvent("connection.result", { ...fields, outcome: "failure", elapsedMs: Date.now() - started, ...diagnosticError(error) });
      throw error;
    });
  }
  private async initialize(): Promise<void> {
    if (!existsSync(join(this.options.pluginRoot, "server.mjs")))
      throw new NativeMcpError("unavailable", "Installed MCP server is absent");
    const child = this.launch(); this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // Never log native stderr: it may contain private tool arguments.
    child.stderr.resume();
    child.on("error", () => this.fail());
    child.on("close", () => this.fail());
    child.stdin.on("error", () => this.fail());
    try {
      const init = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "vkodex-dot-native", version: "0.1.0" } });
      if (init.protocolVersion !== "2024-11-05") throw new NativeMcpError("rejected", "Unqualified MCP version");
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      const catalog = await this.request("tools/list", {});
      if (!Array.isArray(catalog.tools) || !["read_thread", "send_message_to_thread"].every(name =>
        (catalog.tools as unknown[]).some(t => object(t) && t.name === name)))
        throw new NativeMcpError("unavailable", "Required native tools are absent");
      this.ready = true;
    } catch (error) { this.close(); throw error; }
  }
  async read(cursor?: string): Promise<Obj> {
    await this.start();
    const result = await this.call("read_thread", {
      threadId: this.options.targetThreadId, hostId: "durable", turnLimit: 10,
      includeOutputs: false, maxOutputCharsPerItem: 0, ...(cursor ? { cursor } : {}),
    }, false);
    if (!object(result.thread) || result.thread.id !== this.options.targetThreadId || result.thread.hostId !== "durable")
      throw new NativeMcpError("rejected", "Native target mismatch");
    return result;
  }
  async send(prompt: string): Promise<Obj> {
    if (!prompt.trim() || prompt.length > 100_000 || prompt.includes("\0")) throw new TypeError("Invalid dot prompt");
    await this.start();
    const result = await this.call("send_message_to_thread", {
      threadId: this.options.targetThreadId, hostId: "durable", prompt,
    }, true);
    if (result.threadId !== this.options.targetThreadId) throw new NativeMcpError("uncertain", "Native send target mismatch");
    return result;
  }
  private async call(name: string, args: Obj, mutation: boolean): Promise<Obj> {
    const reply = await this.request("tools/call", { name, arguments: args,
      _meta: { "openai/threadId": this.options.callerThreadId } }, mutation);
    if (reply.isError === true) throw new NativeMcpError(mutation ? "uncertain" : "rejected", "Native tool returned an error");
    let body: unknown = reply.structuredContent;
    if (body === undefined && Array.isArray(reply.content)) {
      const text = reply.content.find(c => object(c) && c.type === "text" && typeof c.text === "string");
      if (object(text) && typeof text.text === "string") {
        try { body = JSON.parse(text.text); } catch { /* Fail closed. */ }
      }
    }
    if (!object(body)) throw new NativeMcpError(mutation ? "uncertain" : "rejected", "Invalid native tool result");
    return body;
  }
  private write(value: Obj): void {
    if (!this.child || this.child.stdin.destroyed) throw new NativeMcpError("unavailable", "Native session is disconnected");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private request(method: string, params: Obj, mutation = false): Promise<Obj> {
    if (!this.child || this.disposed) return Promise.reject(new NativeMcpError("unavailable", "Native session is disconnected"));
    const id = this.nextId++;
    const started = Date.now();
    const fields = { route: "dot-native", connectionId: this.connectionId, threadId: this.options.targetThreadId,
      requestId: id, method, mutating: mutation };
    diagnosticEvent("rpc.stage", { ...fields, stage: "start" });
    return new Promise<Obj>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeMcpError(mutation ? "uncertain" : "unavailable", "Native request timed out"));
        this.close();
      }, this.options.timeoutMs ?? 40_000);
      this.pending.set(id, { mutation, resolve, reject, timer });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch { this.fail(); }
    }).then(result => {
      diagnosticEvent("rpc.stage", { ...fields, stage: "response", outcome: "success", elapsedMs: Date.now() - started });
      return result;
    }, error => {
      diagnosticEvent("rpc.stage", { ...fields, stage: "response", outcome: "failure", elapsedMs: Date.now() - started, ...diagnosticError(error) });
      throw error;
    });
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) { this.close(); return; }
    for (;;) {
      const end = this.buffer.indexOf("\n"); if (end < 0) return;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { this.close(); return; }
      if (!object(msg)) { this.close(); return; }
      if (typeof msg.method === "string") {
        if (msg.id !== undefined) {
          try { this.write({ jsonrpc: "2.0", id: msg.id,
            error: { code: -32601, message: "VKodex does not service server approval or sampling requests" } }); }
          catch { this.close(); return; }
        }
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const p = this.pending.get(msg.id); if (!p) continue;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error != null || !object(msg.result)) p.reject(new NativeMcpError(p.mutation ? "uncertain" : "rejected", "Native RPC rejected or malformed"));
      else p.resolve(msg.result);
    }
  }
  private fail(): void {
    this.disposed = true; this.ready = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new NativeMcpError(p.mutation ? "uncertain" : "unavailable", "Native session disconnected"));
    }
    this.pending.clear();
  }
  close(): void {
    this.disposed = true; this.fail();
    const child = this.child; this.child = null;
    if (child) { child.stdin.end(); child.kill(); }
    this.buffer = "";
  }
}
