import { randomUUID } from "node:crypto";
import path from "node:path";
import { BridgeStore } from "../bridge/store.js";
import { DotBrowserConnectionGate, type DotBrowserLease } from "./connection-gate.js";
import { DotRoomInputJournal } from "./input-journal.js";
import { DotNativeControlPeer } from "./native-control-peer.js";
import { DotRoomControlService, type DotControlRun } from "./control-service.js";
import { matchDotControlResponse, type DotControlRequest } from "./control-protocol.js";
import { traceDotControl, type DotControlReason } from "./control-diagnostics.js";
import { assertCanaryDatabase, isCanaryInput, parseDotCanaryConfig, type DotCanaryConfig } from "./canary-config.js";

export type DotCanaryTick = DotControlRun | { readonly phase: "busy" | "idle" | "blocked" | "rejected" | "unknown" };
const active = new WeakSet<BridgeStore>();

/** Diagnostic DB only, already authenticated peer. No startup/recovery loop. */
export class DotCanaryCoordinator {
  private readonly config: Readonly<DotCanaryConfig>;
  private readonly journal: DotRoomInputJournal;
  private readonly service: DotRoomControlService;
  constructor(config: DotCanaryConfig, private readonly store: BridgeStore,
    private readonly gate: DotBrowserConnectionGate, private readonly peer: DotNativeControlPeer,
    private readonly clock: () => number = Date.now, private readonly statusTimeoutMs = 5_000, submitTimeoutMs = 30_000) {
    this.config = parseDotCanaryConfig(config);
    if (!store.databasePath || path.resolve(store.databasePath) !== path.resolve(this.config.databasePath) ||
        !gate.isBoundTo(this.config.roomId, this.config.generation)) throw new Error("Canary scope mismatch");
    if (!Number.isSafeInteger(statusTimeoutMs) || statusTimeoutMs < 1 || statusTimeoutMs > 120_000)
      throw new Error("Invalid canary status deadline");
    this.journal = new DotRoomInputJournal(store, this.config);
    this.service = new DotRoomControlService(this.journal, gate, peer, clock, submitTimeoutMs);
  }

  async tick(lease: DotBrowserLease): Promise<DotCanaryTick> {
    if (active.has(this.store)) return { phase: "busy" };
    active.add(this.store);
    const stableLease = { ...lease }, requestId = randomUUID(), start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    let reason: DotControlReason = "not-ready";
    let serviceEntered = false;
    const failure = (failureReason: DotControlReason): void => {
      traceDotControl("qualified", { requestId, epoch: stableLease.epoch, generation: stableLease.generation,
        elapsedMs: performance.now() - start, outcome: "failure", reason: failureReason });
    };
    try {
      assertCanaryDatabase(this.config.databasePath);
      if (stableLease.generation !== this.config.generation ||
          ["disabled", "disconnected"].includes(this.gate.availability(this.clock()))) return { phase: "queued" };
      const request: DotControlRequest = { version: 1, requestId, method: "status",
        scope: { roomId: this.config.roomId, generation: this.config.generation, epoch: stableLease.epoch } };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reason = "timeout"; abort.abort(); reject(new Error("Status deadline")); }, this.statusTimeoutMs);
      });
      reason = "wrong-scope";
      const response = matchDotControlResponse(request, await Promise.race([this.peer.request(request, abort.signal), timeout]));
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      reason = "not-ready";
      if (response.kind === "error") {
        if (response.reason === "wrong-scope") this.gate.disconnect(stableLease);
        failure(response.reason); return { phase: "queued" };
      }
      if (response.kind !== "status" || response.state !== "ready" ||
          !this.gate.qualify(stableLease, { roomId: this.config.roomId, pageUrl: this.config.pageUrl, qualified: true }, this.clock()) ||
          !this.gate.canDispatch(stableLease, this.clock())) {
        failure(response.kind === "status" && response.state !== "ready" ? response.reason ?? "not-ready" : "not-ready");
        return { phase: "queued" };
      }
      traceDotControl("qualified", { requestId, epoch: stableLease.epoch, generation: stableLease.generation,
        elapsedMs: performance.now() - start, outcome: "success" });
      if (this.journal.projectionBlocked()) return { phase: "blocked" };
      const input = this.store.reserveReplayableInputs(this.clock(), 1)[0];
      if (!input) return { phase: "idle" };
      if (!isCanaryInput(this.config, input) || this.journal.eventStatus(input.eventId)?.state !== "received")
        return { phase: "rejected" };
      serviceEntered = true;
      return await this.service.run(input, stableLease);
    } catch {
      this.gate.disconnect(stableLease);
      if (serviceEntered) {
        // A terminal DB write may fail after the transport issued the send.
        // Preserve the durable fence; neither queued nor a retry is justified.
        traceDotControl("finished", { requestId, epoch: stableLease.epoch, generation: stableLease.generation,
          elapsedMs: performance.now() - start, outcome: "unknown", reason: "other" });
        return { phase: "unknown" };
      }
      failure(reason);
      return { phase: "queued" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort(); active.delete(this.store);
    }
  }
}
