import { z } from "zod";

/** Wire syntax, not caller authentication. The host must bind an authenticated
 * native port to its configured extension, room and current connection epoch.
 * Unknown fields are rejected, never reflected to diagnostics or replies.
 */
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const room = z.string().regex(/^[a-f0-9]{32}$/u);
const scope = z.object({ roomId: room, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), epoch: uuid }).strict();
const base = { version: z.literal(1), requestId: uuid, scope };
const status = z.object({ ...base, method: z.literal("status") }).strict();
const result = z.object({ ...base, method: z.literal("result"), operationId: uuid }).strict();
const submit = z.object({ ...base, method: z.literal("observe-and-submit"), operationId: uuid,
  text: z.string().min(1).max(100_000).refine(value => value.trim().length > 0 && !value.includes("\0")),
}).strict();
export const dotControlRequestSchema = z.discriminatedUnion("method", [status, result, submit]);
export type DotControlRequest = z.infer<typeof dotControlRequestSchema>;

const failure = z.enum(["interference", "navigation", "gap", "disconnect", "timeout", "transition-rejected",
  "wrong-scope", "not-ready", "invalid-request", "unknown-operation", "operation-conflict", "unqualified-controls", "draft-present", "aborted",
  "tab-missing", "tab-ambiguous", "script-injection", "content-disconnected", "invalid-response", "other"]);
const message = z.string().regex(/^[a-f0-9]{32}~[a-f0-9]{32}~CalpicoMessage~Sentinel_[a-f0-9]{32}$/u);
const responseBase = { version: z.literal(1), requestId: uuid, scope };
export const dotReadinessReasonSchema = z.enum([
  "room-binding-rejected", "room-window-rejected", "room-row-rejected", "owner-anchor-mismatch",
  "dot-anchor-mismatch", "anchors-not-visible", "controls-unqualified", "draft-present", "inspection-error",
]);
export type DotReadinessReason = z.infer<typeof dotReadinessReasonSchema>;
export const dotControlResponseSchema = z.discriminatedUnion("kind", [
  z.object({ ...responseBase, kind: z.literal("stage"), operationId: uuid,
    stage: z.enum(["armed", "write-attempt", "write-returned"]),
  }).strict(),
  z.object({ ...responseBase, kind: z.literal("status"), state: z.enum(["disconnected", "qualifying", "ready", "busy"]),
    reason: dotReadinessReasonSchema.optional() }).strict(),
  z.object({ ...responseBase, kind: z.literal("result"), operationId: uuid,
    result: z.discriminatedUnion("phase", [
      z.object({ phase: z.literal("accepted") }).strict(),
      z.object({ phase: z.literal("observed"), messageId: message, evidence: z.literal("same-node-dom-transition") }).strict(),
      z.object({ phase: z.literal("uncertain"), reason: failure }).strict(),
    ]),
  }).strict(),
  z.object({ ...responseBase, kind: z.literal("error"), reason: failure }).strict(),
]);
export type DotControlResponse = z.infer<typeof dotControlResponseSchema>;

/** Fixed errors intentionally omit Zod issues, received values and prompt text. */
export function parseDotControlRequest(value: unknown): DotControlRequest {
  const parsed = dotControlRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid dot control request");
  return parsed.data;
}
export function parseDotControlResponse(value: unknown): DotControlResponse {
  const parsed = dotControlResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid dot control response");
  const data = parsed.data;
  if (data.kind === "result" && data.result.phase === "observed" &&
      !data.result.messageId.startsWith(`${data.scope.roomId}~${data.scope.roomId}~CalpicoMessage~`))
    throw new Error("Invalid dot control response");
  return data;
}

/** A valid envelope still cannot settle a different command or connection. */
export function matchDotControlResponse(request: DotControlRequest, value: unknown): DotControlResponse {
  const response = parseDotControlResponse(value);
  const scopeMatches = response.requestId === request.requestId && response.scope.roomId === request.scope.roomId &&
    response.scope.generation === request.scope.generation && response.scope.epoch === request.scope.epoch;
  const methodMatches = response.kind === "error" || (request.method === "status" ? response.kind === "status" :
    (response.kind === "result" || request.method === "observe-and-submit" && response.kind === "stage") &&
    response.operationId === request.operationId);
  if (!scopeMatches || !methodMatches)
    throw new Error("Dot control response binding mismatch");
  return response;
}
