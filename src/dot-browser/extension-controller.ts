import { parseDotControlRequest, type DotControlRequest, type DotControlResponse } from "./control-protocol.js";
import { readDotRoomDocument, type DotRoomBinding } from "./room-observation.js";
import { runDotSubmissionCommand, inspectDotSubmissionControls, type DotSubmissionCommandOptions,
  type DotSubmissionCommandResult } from "./submission-command.js";

type Operation = { readonly text: string; result: DotSubmissionCommandResult | null };
type Runner = (options: DotSubmissionCommandOptions) => Promise<DotSubmissionCommandResult>;

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
    private readonly inspectReady: () => boolean = () => this.inspectDocument()) {
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
    if (request.method === "status") return { ...base, kind: "status", state: this.active ? "busy" : this.ready() ? "ready" : "qualifying" };
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
    try { return this.inspectReady() === true; } catch { return false; }
  }
  private inspectDocument(): boolean {
    try {
      readDotRoomDocument(this.document, this.document.defaultView?.location.href ?? "", this.binding);
      const controls = inspectDotSubmissionControls(this.document);
      return controls.qualified && controls.draftPresent === false;
    } catch { return false; }
  }
  private result(request: Exclude<DotControlRequest, { method: "status" }>, operation: Operation): DotControlResponse {
    return { version: 1, requestId: request.requestId, scope: request.scope, kind: "result", operationId: request.operationId,
      result: operation.result ?? { phase: "accepted" } };
  }
}
