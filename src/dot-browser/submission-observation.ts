/** Pure evidence tracker; it cannot submit, retry, persist or authorize input.
 * Create only AFTER an external durable dispatch fence. A browser adapter must
 * additionally enforce the exact page, empty draft and exclusive UI operation.
 */
export interface SubmissionObservationBinding {
  readonly roomId: string;
  readonly observerEpoch: string;
  readonly operationId: string;
  readonly baselineMessageIds: readonly string[];
}
export type SubmissionObservation =
  | { readonly phase: "awaiting-pending" }
  | { readonly phase: "awaiting-canonical"; readonly nodeId: string; readonly pendingId: string }
  | { readonly phase: "observed"; readonly messageId: string; readonly evidence: "same-node-dom-transition" }
  | { readonly phase: "uncertain" };

export type SubmissionObservationEvent =
  | { readonly type: "pending"; readonly observerEpoch: string; readonly nodeId: string; readonly pendingId: string;
      readonly ownerLayout: boolean; readonly exactText: boolean }
  | { readonly type: "canonical"; readonly observerEpoch: string; readonly nodeId: string; readonly previousId: string;
      readonly messageId: string; readonly ownerLayout: boolean; readonly exactText: boolean }
  | { readonly type: "gap" | "disconnect" | "navigation" | "interference" | "timeout"; readonly observerEpoch: string };

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const opaque = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);

/** nodeId must be an adapter-owned WeakMap identity for the physical article,
 * scoped to observerEpoch. Never derive it from text, position, React internals
 * or message ID. React keys suggest continuity but do not guarantee a DOM node
 * survives: missing/remounted evidence is uncertainty, not a matching heuristic.
 */
export class DotSubmissionObservation {
  private current: SubmissionObservation;
  private readonly baseline: ReadonlySet<string>;
  private readonly roomId: string;
  private readonly epoch: string;
  readonly operationId: string;
  constructor(binding: SubmissionObservationBinding, recovery: "new-fenced-attempt" | "uncertain-after-restart") {
    if (!/^[a-f0-9]{32}$/u.test(binding.roomId) || !opaque(binding.observerEpoch) || !opaque(binding.operationId) ||
        !Array.isArray(binding.baselineMessageIds) || binding.baselineMessageIds.length > 500 ||
        !binding.baselineMessageIds.every(opaque) ||
        !["new-fenced-attempt", "uncertain-after-restart"].includes(recovery)) throw new TypeError("Invalid observation binding");
    this.roomId = binding.roomId;
    this.epoch = binding.observerEpoch;
    this.operationId = binding.operationId;
    this.baseline = new Set(binding.baselineMessageIds);
    this.current = recovery === "new-fenced-attempt" ? { phase: "awaiting-pending" } : { phase: "uncertain" };
  }
  get state(): SubmissionObservation { return { ...this.current }; }
  observe(event: SubmissionObservationEvent): SubmissionObservation {
    // Terminal evidence never grants another attempt. The external durable
    // ledger decides whether a previously observed result was committed.
    if (this.current.phase === "observed" || this.current.phase === "uncertain") return this.state;
    if (event.observerEpoch !== this.epoch || !["pending", "canonical"].includes(event.type)) return this.uncertain();
    if (event.type === "pending") {
      if (!opaque(event.nodeId) || typeof event.pendingId !== "string" || !uuid.test(event.pendingId) || this.baseline.has(event.pendingId) ||
          event.ownerLayout !== true || event.exactText !== true) return this.uncertain();
      if (this.current.phase === "awaiting-canonical" &&
          (this.current.nodeId !== event.nodeId || this.current.pendingId !== event.pendingId)) return this.uncertain();
      this.current = { phase: "awaiting-canonical", nodeId: event.nodeId, pendingId: event.pendingId };
      return this.state;
    }
    if (event.type !== "canonical") return this.uncertain();
    const prefix = `${this.roomId}~${this.roomId}~CalpicoMessage~`;
    if (this.current.phase !== "awaiting-canonical" || event.nodeId !== this.current.nodeId ||
        event.previousId !== this.current.pendingId || event.ownerLayout !== true || event.exactText !== true ||
        typeof event.messageId !== "string" || !event.messageId.startsWith(prefix) ||
        !/^Sentinel_[a-f0-9]{32}$/u.test(event.messageId.slice(prefix.length)) ||
        this.baseline.has(event.messageId)) return this.uncertain();
    this.current = { phase: "observed", messageId: event.messageId, evidence: "same-node-dom-transition" };
    return this.state;
  }
  private uncertain(): SubmissionObservation { this.current = { phase: "uncertain" }; return this.state; }
}
