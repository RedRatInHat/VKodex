import { diagnosticEvent, type DiagnosticFields } from "../bridge/diagnostics.js";

export type DotControlStage = "received" | "acknowledged" | "qualified" | "armed" | "dispatch" | "receipt" | "finished" | "disconnected";
export type DotControlReason = "interference" | "navigation" | "gap" | "disconnect" | "timeout" | "transition-rejected" |
  "wrong-scope" | "not-ready" | "invalid-request" | "unknown-operation" | "operation-conflict" | "other";
export interface DotControlTrace {
  readonly requestId: string;
  readonly operationId?: string;
  readonly epoch: string;
  readonly generation: number;
  readonly elapsedMs: number;
  readonly outcome: "start" | "success" | "failure" | "accepted" | "unknown";
  readonly reason?: DotControlReason;
}
const stages: Record<DotControlStage, [string, string]> = {
  received: ["input.received", "command"], qualified: ["input.prepare", "verify"],
  acknowledged: ["rpc.stage", "response"],
  armed: ["input.adapter", "armed"], dispatch: ["input.adapter", "dispatch"],
  receipt: ["input.result", "receipt"], finished: ["input.finished", "finished"],
  disconnected: ["connection.lifecycle", "disconnect"],
};

/** Reuses the application's sanitized sink, timestamp, process/run ID and
 * sequence. Whitelist fields explicitly: never spread a request or error here.
 * Logs are diagnostic evidence and cannot authorize replay or settle a send.
 */
export function traceDotControl(stage: DotControlStage, trace: DotControlTrace): void {
  const entry = stages[stage];
  if (!entry) return;
  const fields: DiagnosticFields = {
    attemptId: trace.requestId, connectionId: trace.epoch, routeGeneration: trace.generation,
    elapsedMs: trace.elapsedMs, outcome: trace.outcome, route: "dot-browser", stage: entry[1],
  };
  if (trace.operationId !== undefined) fields.operationId = trace.operationId;
  if (trace.reason !== undefined) fields.reason = trace.reason;
  diagnosticEvent(entry[0], fields);
}
