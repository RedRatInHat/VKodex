import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

/** Diagnostic evidence only. No consumer may use this channel as command authority. */
export interface DiagnosticContext {
  attemptId?: string | undefined;
  parentAttemptId?: string | undefined;
  connectionAttemptId?: string | undefined;
  connectionId?: string | undefined;
  bindingId?: string | undefined;
  threadId?: string | undefined;
  sourceId?: string | undefined;
  eventId?: string | undefined;
  operationId?: string | undefined;
  peerId?: number | undefined;
  streamGeneration?: number | undefined;
}
export interface DiagnosticFields extends DiagnosticContext {
  stage?: string;
  outcome?: string;
  route?: string;
  intent?: string;
  reason?: string;
  method?: string;
  errorType?: string;
  errorCode?: number;
  elapsedMs?: number;
  queueWaitMs?: number;
  backendGeneration?: number;
  routeGeneration?: number;
  requestId?: number;
  mergedCount?: number;
  turnId?: string;
  submissionId?: string;
  mutating?: boolean;
  ready?: boolean;
  dispatched?: boolean;
}
export interface DiagnosticRecord extends DiagnosticFields {
  readonly schema: "vkodex.diagnostic.v1";
  readonly runId: string;
  readonly pid: number;
  readonly seq: number;
  readonly at: string;
  readonly event: string;
  readonly entrySha256?: string;
}
export type DiagnosticSink = (record: DiagnosticRecord) => void | Promise<void>;
const scopes = new AsyncLocalStorage<{ context: DiagnosticContext; sink?: DiagnosticSink | undefined }>();
const runId = randomUUID();
let sequence = 0;
let processSink: DiagnosticSink | undefined;
let entrySha256: string | undefined;
const events = new Set(["input.received", "input.queued", "input.associated", "input.started", "input.watchdog", "input.prepare",
  "input.journal", "input.adapter", "input.result", "input.finished", "connection.start", "connection.join",
  "connection.skip", "connection.result", "connection.lifecycle", "route.selected", "route.fallback",
  "rpc.stage", "subscription.stage", "mirror.poll", "mirror.discovery", "delivery.queued", "delivery.attempt", "delivery.result"]);
const words = new Set(["start", "success", "failure", "accepted", "rejected", "unknown", "not-dispatched", "finished",
  "prepare", "dispatch", "edit", "queue", "steer", "command", "observe", "passive", "profile-owner", "exclusive-owner",
  "connected-desktop", "base", "owner-conflict", "runtime-stopped", "current", "stale", "matching", "not-attached",
  "already-connecting", "no-client-found", "request-rejected", "request-version-mismatch", "timeout", "closed",
  "unavailable", "source-missing", "source-mismatch", "protocol-mismatch", "revision-recovery", "source-validation",
  "connect", "discover-owner", "snapshot", "ready", "subscribe", "resume", "verify", "notification", "initialize",
  "before-write", "write-attempt", "write-returned", "response", "late-response", "disconnect", "guard-refused",
  "pending", "adapter-returned", "receipt", "history-reconciled", "invalid-response", "abandoned", "dropped",
  "no-passive-route", "connection-not-ready", "route-changed", "cancelled", "model-not-supported-for-account",
  "active-writer", "owner-busy", "task-not-open", "desktop-unavailable", "other",
  "history-gap", "uncertain-input", "stopped", "native-observation-recovery", "passive-snapshot", "opened", "owner-present", "unsupported", "dot-native"]);
const methods = new Set(["tools/list", "tools/call", "initialize", "thread/read", "thread/resume", "turn/start", "turn/steer", "turn/interrupt",
  "thread/queue/add", "thread/queue/list", "thread/settings/update", "thread-owner-discovery", "thread-stream-subscribe",
  "thread-stream-unsubscribe", "thread-stream-state", "model/list", "thread/turns/list", "thread/goal/get"]);
const errors = new Set(["NativeMcpError", "Error", "TypeError", "ActionRejectedError", "TaskNotOpenError", "TaskOwnedByClientError",
  "TaskConnectionLostError", "DesktopUnavailableError", "DesktopRequestRejectedError", "UncertainActionError",
  "AppServerUnavailableError", "AppServerRejectedError", "AppServerUncertainError", "ModelUnavailableForAccountError"]);
const ids = new Set(["attemptId", "parentAttemptId", "connectionAttemptId", "connectionId", "bindingId", "threadId",
  "sourceId", "operationId", "turnId", "submissionId"]);
const numbers = new Set(["peerId", "streamGeneration", "backendGeneration", "routeGeneration", "requestId", "mergedCount"]);
const durations = new Set(["elapsedMs", "queueWaitMs"]);

/** Nonstandard identifiers are hashed, never truncated (they can contain secret material). */
export function diagnosticId(value: string): string {
  return /^sha256:[a-f0-9]{24}$/u.test(value) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value)
    || /^[a-f0-9]{24}$/iu.test(value) || value === "" ? value
    : `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
function safeFields(fields: DiagnosticFields): DiagnosticFields {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ids.has(key) && typeof value === "string") safe[key] = diagnosticId(value);
    else if (key === "eventId" && typeof value === "string")
      safe[key] = /^message:\d{1,20}$/u.test(value) ? value : diagnosticId(value);
    else if (numbers.has(key) && typeof value === "number" && Number.isSafeInteger(value)) safe[key] = value;
    else if (durations.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)
      safe[key] = Math.round(value);
    else if (key === "errorCode" && typeof value === "number" && Number.isSafeInteger(value)) safe[key] = value;
    else if (["mutating", "ready", "dispatched"].includes(key) && typeof value === "boolean") safe[key] = value;
    else if (key === "method" && typeof value === "string") safe[key] = methods.has(value) ? value : "other";
    else if (key === "errorType" && typeof value === "string") safe[key] = errors.has(value) ? value : "Error";
    else if (["stage", "outcome", "route", "intent", "reason"].includes(key) && typeof value === "string")
      safe[key] = words.has(value) ? value : "unknown";
  }
  return safe;
}
export function diagnosticError(error: unknown): DiagnosticFields {
  try {
    if (!(error instanceof Error)) return { errorType: "Error" };
    const typed = error as Error & { code?: unknown; reason?: unknown };
    return safeFields({ errorType: typed.name, ...(typeof typed.code === "number" ? { errorCode: typed.code } : {}),
      ...(typeof typed.reason === "string" ? { reason: typed.reason } : {}) });
  } catch { return { errorType: "Error" }; }
}
export function installDiagnosticSink(sink: DiagnosticSink, identity?: { entrySha256: string }): void {
  processSink = sink;
  entrySha256 = identity && /^[a-f0-9]{64}$/u.test(identity.entrySha256) ? identity.entrySha256 : undefined;
}
/** Re-allowlist on read too: edited or malformed log files must not become an exfiltration path. */
export function readDiagnosticRecord(value: unknown): DiagnosticRecord | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as DiagnosticRecord;
    if (record.schema !== "vkodex.diagnostic.v1" || !events.has(record.event)
        || typeof record.runId !== "string" || !/^[a-f0-9-]{36}$/iu.test(record.runId)
        || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.seq) || record.seq < 1
        || typeof record.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(record.at)
        || !Number.isFinite(Date.parse(record.at))) return null;
    return { ...safeFields(record), schema: "vkodex.diagnostic.v1", runId: record.runId, pid: record.pid,
      seq: record.seq, at: record.at, event: record.event,
      ...(typeof record.entrySha256 === "string" && /^[a-f0-9]{64}$/u.test(record.entrySha256)
        ? { entrySha256: record.entrySha256 } : {}) };
  } catch { return null; }
}
/** Tests and isolated tools can use a sink without changing the process sink. */
export function withDiagnosticSink<T>(sink: DiagnosticSink, work: () => T): T {
  return scopes.run({ context: {}, sink }, work);
}
export function diagnosticScope<T>(context: DiagnosticContext, work: () => T): T {
  const previous = scopes.getStore();
  return scopes.run({ context: { ...previous?.context, ...context }, sink: previous?.sink }, work);
}
export function captureDiagnostic(): (event: string, fields?: DiagnosticFields) => void {
  const current = scopes.getStore();
  const captured = { context: { ...current?.context }, sink: current?.sink };
  return (event, fields = {}) => {
    scopes.run(captured, () => diagnosticEvent(event, fields));
  };
}
export function diagnosticOperation(operationId: string): void {
  const scope = scopes.getStore();
  if (scope) scope.context.operationId = operationId;
}
export function diagnosticUpdate(context: DiagnosticContext): void {
  try { const scope = scopes.getStore(); if (scope) Object.assign(scope.context, context); } catch { /* observational only */ }
}
export function diagnosticHasOperation(): boolean { return !!scopes.getStore()?.context.operationId; }
export function diagnosticEvent(event: string, fields: DiagnosticFields = {}): void {
  try {
    if (!events.has(event)) return;
    const scope = scopes.getStore();
    const sink = scope?.sink ?? processSink;
    if (!sink) return;
    const record = Object.freeze({ ...safeFields({ ...scope?.context, ...fields }), schema: "vkodex.diagnostic.v1" as const,
      runId, pid: process.pid, seq: ++sequence, at: new Date().toISOString(), event,
      ...(entrySha256 ? { entrySha256 } : {}) });
    // A sink is observational: even rejection or a malicious error getter cannot replace the original outcome.
    const result = sink(record);
    if (result) void Promise.resolve(result).catch(() => {});
  } catch { /* Best-effort diagnostics never authorize, reject or retry commands. */ }
}
