import { randomUUID } from "node:crypto";
import type { BridgeInput } from "../bridge/contracts.js";
import { DotBrowserConnectionGate, type DotBrowserLease } from "./connection-gate.js";
import { DotRoomInputJournal } from "./input-journal.js";
import { matchDotControlResponse, type DotControlRequest } from "./control-protocol.js";
import { traceDotControl, type DotControlReason } from "./control-diagnostics.js";

export interface DotControlTransport {
  /** Authenticated, bound port. Arm observer + submit is ONE extension operation.
   * Returns its terminal result, not merely a command acknowledgement. Aborting
   * must prevent a not-yet-started submission, but cannot undo an issued send.
   */
  submitAndObserve(request: DotControlRequest, signal: AbortSignal): Promise<unknown>;
}
export type DotControlRun = { readonly phase: "queued" | "not-dispatched" } |
  { readonly phase: "observed" | "uncertain"; readonly operationId: string };

/** Orchestration over the existing durable inbox, not an exposed server.
 * No automatic retries, authentication provisioning or browser launching.
 */
export class DotRoomControlService {
  constructor(private readonly journal: DotRoomInputJournal, private readonly gate: DotBrowserConnectionGate,
    private readonly transport: DotControlTransport, private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError("Invalid control deadline");
  }

  async run(input: BridgeInput, lease: DotBrowserLease): Promise<DotControlRun> {
    // Snapshot caller-owned data before the first await.
    const stableInput = { ...input }, stableLease = { ...lease };
    const requestId = randomUUID(), start = performance.now();
    this.journal.receive(stableInput);
    traceDotControl("received", { requestId, epoch: stableLease.epoch, generation: stableLease.generation,
      elapsedMs: performance.now() - start, outcome: "accepted" });
    if (!this.gate.canDispatch(stableLease, this.clock())) return { phase: "queued" };
    const attempt = this.journal.dispatch(stableInput, stableLease.epoch);
    if (attempt === null) return { phase: "not-dispatched" };
    const request: DotControlRequest = { version: 1, requestId, method: "observe-and-submit",
      operationId: attempt.operationId, scope: { roomId: attempt.roomId, generation: stableLease.generation, epoch: stableLease.epoch }, text: stableInput.text };
    const trace = (stage: "received" | "dispatch" | "receipt" | "finished", outcome: "start" | "success" | "failure", reason?: DotControlReason) => {
      traceDotControl(stage, { requestId: request.requestId, operationId: attempt.operationId, epoch: stableLease.epoch,
        generation: stableLease.generation, elapsedMs: performance.now() - start, outcome, ...(reason ? { reason } : {}) });
    };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reason: DotControlReason = "other";
    try {
      if (!this.gate.isBoundTo(attempt.roomId, stableLease.generation) || !this.gate.canDispatch(stableLease, this.clock())) {
        reason = "not-ready";
        throw new Error("Browser connection not ready");
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reason = "timeout"; abort.abort(); reject(new Error("Control deadline expired")); }, this.timeoutMs);
      });
      trace("dispatch", "start");
      const raw = await Promise.race([this.transport.submitAndObserve(request, abort.signal), timeout]);
      reason = "wrong-scope";
      const response = matchDotControlResponse(request, raw);
      reason = response.kind === "error" ? response.reason : "other";
      if (response.kind !== "result" || response.result.phase === "accepted") throw new Error("Missing terminal control result");
      trace("receipt", response.result.phase === "observed" ? "success" : "failure",
        response.result.phase === "uncertain" ? response.result.reason : undefined);
      const phase = this.journal.settle(attempt, response.result.phase === "observed" ? response.result : { phase: "uncertain" });
      trace("finished", phase === "observed" ? "success" : "failure", phase === "uncertain" ? "other" : undefined);
      return { phase, operationId: attempt.operationId };
    } catch {
      // Failure after the durable dispatch fence cannot authorize another send.
      this.journal.settle(attempt, { phase: "uncertain" });
      trace("finished", "failure", reason);
      return { phase: "uncertain", operationId: attempt.operationId };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
    }
  }
}
