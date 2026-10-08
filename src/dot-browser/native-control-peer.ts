import type { Readable, Writable } from "node:stream";
import { encodeNativeMessage, NativeMessageDecoder } from "./native-message-framing.js";
import { matchDotControlResponse, parseDotControlRequest, type DotControlRequest, type DotControlResponse } from "./control-protocol.js";
import { traceDotControl } from "./control-diagnostics.js";

interface Pending {
  readonly request: DotControlRequest;
  readonly start: number;
  readonly resolve: (result: DotControlResponse) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/** Bounded transport over an ALREADY authenticated Native Messaging channel.
 * No process, registry, permission, browser or network setup. One pending
 * request, no replay. A framing/binding failure permanently closes this peer.
 */
export class DotNativeControlPeer {
  private readonly decoder = new NativeMessageDecoder();
  private pending: Pending | null = null;
  private closed = false;
  constructor(private readonly input: Readable, private readonly output: Writable, private readonly onDisconnect: () => void) {
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("error", this.onError);
    input.on("close", this.onError);
    output.on("error", this.onError);
    output.on("close", this.onError);
  }

  submitAndObserve(request: DotControlRequest, signal: AbortSignal): Promise<DotControlResponse> {
    if (request.method !== "observe-and-submit") return Promise.reject(new Error("Unexpected control command"));
    return this.request(request, signal);
  }
  request(value: DotControlRequest, signal: AbortSignal): Promise<DotControlResponse> {
    const request = parseDotControlRequest(value);
    if (this.closed || signal.aborted) return Promise.reject(new Error("Control peer unavailable"));
    if (this.pending) return Promise.reject(new Error("Control peer busy"));
    const frame = encodeNativeMessage(request);
    return new Promise((resolve, reject) => {
      const abort = () => this.close();
      this.pending = { request, start: performance.now(), resolve, reject,
        cleanup: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { this.close(); return; }
      try { this.output.write(frame, error => { if (error) this.close(); }); }
      catch { this.close(); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending; this.pending = null;
    if (pending) traceDotControl("disconnected", { requestId: pending.request.requestId,
      ...("operationId" in pending.request ? { operationId: pending.request.operationId } : {}),
      epoch: pending.request.scope.epoch, generation: pending.request.scope.generation,
      elapsedMs: performance.now() - pending.start, outcome: "failure", reason: "disconnect" });
    pending?.cleanup();
    pending?.reject(new Error("Control peer disconnected"));
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("close", this.onError);
    this.output.off("close", this.onError);
    // Keep error listeners while destroy/write callbacks settle; never leak raw errors.
    this.input.destroy(); this.output.destroy();
    try { this.onDisconnect(); } catch { /* Caller notification cannot reopen the peer. */ }
  }
  private readonly onError = (): void => { this.close(); };
  private readonly onEnd = (): void => {
    try { this.decoder.finish(); } catch { /* EOF is still a disconnection. */ }
    this.close();
  };
  private readonly onData = (chunk: unknown): void => {
    if (this.closed) return;
    try {
      if (!(chunk instanceof Uint8Array)) throw new Error("Control peer expects binary input");
      for (const value of this.decoder.push(chunk)) {
        const pending = this.pending;
        if (!pending) throw new Error("Unsolicited control response");
        const response = matchDotControlResponse(pending.request, value);
        if (response.kind === "stage") {
          traceDotControl(response.stage === "write-attempt" ? "dispatch" : response.stage, {
            requestId: pending.request.requestId, operationId: response.operationId,
            epoch: pending.request.scope.epoch, generation: pending.request.scope.generation,
            elapsedMs: performance.now() - pending.start, outcome: "success" });
          continue;
        }
        if (response.kind === "result" && response.result.phase === "accepted" && pending.request.method === "observe-and-submit") {
          traceDotControl("acknowledged", { requestId: pending.request.requestId, operationId: pending.request.operationId,
            epoch: pending.request.scope.epoch, generation: pending.request.scope.generation,
            elapsedMs: performance.now() - pending.start, outcome: "accepted" });
          continue;
        }
        this.pending = null; pending.cleanup(); pending.resolve(response);
      }
    } catch { this.close(); }
  };
}
