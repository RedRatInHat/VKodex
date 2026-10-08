import { parseDotControlRequest, type DotControlRequest, type DotControlResponse, type DotReadinessReason } from "./control-protocol.js";
import { DotRoomObservationRejected, readDotRoomDocument, type DotRoomBinding } from "./room-observation.js";
import { runDotSubmissionCommand, inspectDotSubmissionControls, type DotSubmissionCommandOptions,
  type DotSubmissionCommandResult } from "./submission-command.js";

type Operation = { readonly text: string; result: DotSubmissionCommandResult | null };
type Runner = (options: DotSubmissionCommandOptions) => Promise<DotSubmissionCommandResult>;
type Readiness = { readonly ready: true } | { readonly ready: false; readonly reason: DotReadinessReason };
// Only exact, known collector failures leave the content script. Never reflect an error.
const roomFailures = new Map<string, DotReadinessReason>([
  ["Unqualified room binding", "room-binding-rejected"],
  ["Unqualified room window", "room-window-rejected"], ["Room row limit", "room-window-rejected"],
  ["Room text limit", "room-window-rejected"],
  ["Unqualified room row", "room-row-rejected"], ["Invalid room text", "room-row-rejected"],
  ["Empty role anchor", "room-row-rejected"],
  ["Owner anchor disagrees with layout", "owner-anchor-mismatch"],
  ["Dot anchor disagrees with layout", "dot-anchor-mismatch"],
  ["Role anchors are outside the observed window", "anchors-not-visible"],
]);

/** Per-port extension controller. The caller authenticates the native host and
 * pins configuration/epoch; web pages must never call this handler directly.
 * No network, installation, browser profile or account access here.
 */
export class DotExtensionController {
  private readonly operations = new Map<string, Operation>();
  private readonly binding: DotRoomBinding;
  private active: AbortController | null = null;
  private closed = false;
  constructor(private readonly document: Document, binding: DotRoomBinding,
    private readonly generation: number, private readonly epoch: string,
    private readonly emit: (response: DotControlResponse) => void,
    private readonly run: Runner = runDotSubmissionCommand,
    private readonly inspectReady?: () => boolean) {
    this.binding = { ...binding };
    // Validate wire scope without running any page action.
    parseDotControlRequest({ version: 1, requestId: epoch, scope: { roomId: binding.roomId, generation, epoch }, method: "status" });
  }

  async handle(value: unknown): Promise<DotControlResponse> {
    const request = parseDotControlRequest(value);
    const base = { version: 1 as const, requestId: request.requestId, scope: request.scope };
    const error = (reason: "wrong-scope" | "not-ready" | "unknown-operation" | "operation-conflict"): DotControlResponse =>
      ({ ...base, kind: "error", reason });
    if (request.scope.roomId !== this.binding.roomId || request.scope.generation !== this.generation || request.scope.epoch !== this.epoch)
      return error("wrong-scope");
    if (this.closed) return error("not-ready");
    if (request.method === "status") {
      if (this.active) return { ...base, kind: "status", state: "busy" };
      const readiness = this.readiness();
      return readiness.ready ? { ...base, kind: "status", state: "ready" } :
        { ...base, kind: "status", state: "qualifying", reason: readiness.reason };
    }
    const old = this.operations.get(request.operationId);
    if (request.method === "result") return old ? this.result(request, old) : error("unknown-operation");
    if (old) return old.text === request.text ? this.result(request, old) : error("operation-conflict");
    if (this.active || this.operations.size >= 512) return error("operation-conflict");
    if (!this.ready()) return error("not-ready");
    const operation: Operation = { text: request.text, result: null };
    this.operations.set(request.operationId, operation);
    const abort = new AbortController(); this.active = abort;
    this.send(this.result(request, operation));
    try {
      operation.result = await this.run({ document: this.document, binding: this.binding,
        operationId: request.operationId, observerEpoch: request.scope.epoch,
        expectedText: request.text, signal: abort.signal, timeoutMs: 25_000,
        onStage: stage => {
          if (stage === "armed" || stage === "write-attempt" || stage === "write-returned")
            this.send({ ...base, kind: "stage", operationId: request.operationId, stage });
        }, onTerminal: () => {},
      });
    } catch { operation.result = { phase: "uncertain", reason: "gap" }; }
    finally { if (this.active === abort) this.active = null; }
    return this.result(request, operation);
  }

  disconnect(): void {
    this.closed = true;
    this.active?.abort();
  }
  private send(response: DotControlResponse): void {
    if (this.closed) return;
    try { this.emit(response); } catch { this.disconnect(); }
  }
  private ready(): boolean {
    return this.readiness().ready;
  }
  private readiness(): Readiness {
    try {
      if (!this.inspectReady) return this.inspectDocument();
      return this.inspectReady() === true ? { ready: true } : { ready: false, reason: "inspection-error" };
    } catch { return { ready: false, reason: "inspection-error" }; }
  }
  private inspectDocument(): Readiness {
    try {
      readDotRoomDocument(this.document, this.document.defaultView?.location.href ?? "", this.binding);
      const controls = inspectDotSubmissionControls(this.document);
      if (!controls.qualified) return { ready: false, reason: "controls-unqualified" };
      if (controls.draftPresent !== false) return { ready: false, reason: "draft-present" };
      return { ready: true };
    } catch (error) {
      return { ready: false, reason: error instanceof DotRoomObservationRejected ?
        roomFailures.get(error.message) ?? "inspection-error" : "inspection-error" };
    }
  }
  private result(request: Exclude<DotControlRequest, { method: "status" }>, operation: Operation): DotControlResponse {
    return { version: 1, requestId: request.requestId, scope: request.scope, kind: "result", operationId: request.operationId,
      result: operation.result ?? { phase: "accepted" } };
  }
}
