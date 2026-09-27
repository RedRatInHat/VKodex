/**
 * Narrow conversion for the installed Desktop follower v2 ordinary-text start.
 * This is deliberately not a Composer converter: UI contexts, attachments and
 * permission-selection intents require their own qualified route.
 */
type JsonObject = Record<string, unknown>;

export interface NativeFollowerStartSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly latestModel: string;
  readonly latestReasoningEffort?: string | null;
  readonly latestServiceTier?: string | null;
  readonly latestThreadSettings?: Readonly<{ serviceTier?: string | null }>;
  readonly currentPermissions: unknown;
  readonly workspaceKind?: "project" | "projectless" | null;
  readonly latestCollaborationMode?: unknown;
}

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const fail = (reason: string): never => { throw new TypeError(`Unsupported native ordinary text start: ${reason}`); };
const copy = <T>(value: T): T => structuredClone(value);

function only(value: JsonObject, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} is not qualified`);
}
function optional(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = copy(value);
}
function emptyArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length !== 0) fail(`${label} must be an empty array`);
}
function input(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length !== 1 || !isObject(value[0])) fail("ordinary text requires one input item");
  const item = (value as unknown[])[0] as JsonObject;
  only(item, ["type", "text", "text_elements"], "input[0]");
  if (item.type !== "text" || typeof item.text !== "string") fail("ordinary text input is malformed");
  if (item.text_elements !== undefined) emptyArray(item.text_elements, "input[0].text_elements");
  return copy(value) as unknown[];
}
function absolutePath(value: unknown): value is string {
  return typeof value === "string" && (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/"));
}
function validateSandbox(value: unknown): void {
  if (!isObject(value) || !text(value.type)) fail("sandboxPolicy is malformed");
  const policy = value as JsonObject;
  if (policy.type === "dangerFullAccess") { only(policy, ["type"], "sandboxPolicy"); return; }
  if (policy.type === "readOnly") {
    only(policy, ["type", "networkAccess"], "sandboxPolicy");
    if (typeof policy.networkAccess !== "boolean") fail("sandboxPolicy is malformed");
    return;
  }
  if (policy.type === "externalSandbox") {
    only(policy, ["type", "networkAccess"], "sandboxPolicy");
    if (policy.networkAccess !== "restricted" && policy.networkAccess !== "enabled") fail("sandboxPolicy is malformed");
    return;
  }
  if (policy.type === "workspaceWrite") {
    only(policy, ["type", "writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"], "sandboxPolicy");
    if (!Array.isArray(policy.writableRoots) || policy.writableRoots.some((root: unknown) => !absolutePath(root)) ||
        typeof policy.networkAccess !== "boolean" || typeof policy.excludeTmpdirEnvVar !== "boolean" || typeof policy.excludeSlashTmp !== "boolean") fail("sandboxPolicy is malformed");
    return;
  }
  fail("sandboxPolicy is malformed");
}
function validateApproval(value: unknown): void {
  if (value === "untrusted" || value === "on-request" || value === "never") return;
  if (!isObject(value) || !isObject(value.granular)) fail("approvalPolicy is malformed");
  const approval = value as JsonObject; const granular = approval.granular as JsonObject;
  only(approval, ["granular"], "approvalPolicy");
  const keys = ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"];
  only(granular, keys, "approvalPolicy.granular");
  if (keys.some(key => typeof granular[key] !== "boolean")) fail("approvalPolicy is malformed");
}
function permissions(target: JsonObject, value: unknown): void {
  if (!isObject(value)) fail("snapshot.currentPermissions is required");
  const source = value as JsonObject;
  const profile = source.activePermissionProfile;
  if (profile !== undefined && profile !== null) {
    if (!isObject(profile) || !text(profile.id)) fail("activePermissionProfile is malformed");
    const profileRecord = profile as JsonObject;
    target.permissions = profileRecord.id;
  } else {
    if (source.sandboxPolicy === undefined || source.sandboxPolicy === null) fail("permission profile or sandbox policy is required");
    validateSandbox(source.sandboxPolicy); target.sandboxPolicy = copy(source.sandboxPolicy);
  }
  if (source.approvalPolicy !== undefined && source.approvalPolicy !== null) {
    validateApproval(source.approvalPolicy); target.approvalPolicy = copy(source.approvalPolicy);
  }
  if (source.approvalsReviewer !== undefined && source.approvalsReviewer !== null) {
    if (source.approvalsReviewer !== "user" && source.approvalsReviewer !== "auto_review" && source.approvalsReviewer !== "guardian_subagent") fail("approvalsReviewer is malformed");
    target.approvalsReviewer = source.approvalsReviewer;
  }
  if (source.runtimeWorkspaceRoots !== undefined && source.runtimeWorkspaceRoots !== null) {
    if (!Array.isArray(source.runtimeWorkspaceRoots) || source.runtimeWorkspaceRoots.some((root: unknown) => !absolutePath(root))) fail("runtimeWorkspaceRoots is malformed");
    target.runtimeWorkspaceRoots = copy(source.runtimeWorkspaceRoots);
  }
}
function collaboration(value: unknown): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !isObject(value.settings)) fail("collaborationMode is malformed");
  const mode = value as JsonObject; const settings = mode.settings as JsonObject;
  only(mode, ["mode", "settings"], "collaborationMode"); only(settings, ["model", "reasoning_effort", "developer_instructions"], "collaborationMode.settings");
  if ((mode.mode !== "default" && mode.mode !== "plan") || typeof settings.model !== "string" ||
      (settings.reasoning_effort !== null && typeof settings.reasoning_effort !== "string") ||
      (settings.developer_instructions !== null && typeof settings.developer_instructions !== "string")) fail("collaborationMode is malformed");
  if (settings.model === "") {
    if (mode.mode !== "default" || settings.reasoning_effort !== null || settings.developer_instructions !== null) fail("collaborationMode is malformed");
    return null;
  }
  return copy(mode);
}

/** Returns generated App Server TurnStartParams for the qualified ordinary subset. */
export function prepareNativeFollowerStart(snapshot: NativeFollowerStartSnapshot, envelope: unknown): JsonObject {
  if (!text(snapshot.id) || !text(snapshot.cwd) || !text(snapshot.latestModel)) fail("snapshot identity is required");
  if (!isObject(envelope)) fail("envelope is malformed");
  const follower = envelope as JsonObject;
  only(follower, ["conversationId", "turnStart"], "follower");
  if (follower.conversationId !== snapshot.id || !isObject(follower.turnStart)) fail("conversation identity differs");
  const start = follower.turnStart as JsonObject;
  only(start, ["request", "context"], "turnStart");
  if (!isObject(start.request) || !isObject(start.context)) fail("turnStart is malformed");
  const request = start.request as JsonObject; const context = start.context as JsonObject;
  only(request, ["threadId", "clientUserMessageId", "input", "cwd", "model", "effort", "additionalContext", "turnTrigger", "responsesapiClientMetadata", "multiAgentMode", "serviceTier", "collaborationMode"], "turnStart.request");
  if (request.threadId !== snapshot.id || !text(request.clientUserMessageId)) fail("request identity differs");
  if (request.cwd !== undefined && request.cwd !== null && request.cwd !== snapshot.cwd) fail("request cwd differs");
  if ((request.model !== undefined && request.model !== null) || (request.effort !== undefined && request.effort !== null)) fail("request model override is not qualified");
  if (request.additionalContext !== undefined && request.additionalContext !== null && !(isObject(request.additionalContext) && Object.keys(request.additionalContext).length === 0)) emptyArray(request.additionalContext, "request additionalContext");
  if (request.serviceTier !== undefined && request.serviceTier !== null) fail("serviceTier override is not qualified");
  if (request.turnTrigger !== undefined && request.turnTrigger !== null && request.turnTrigger !== "composer") fail("turnTrigger is not qualified");
  if (request.multiAgentMode !== undefined && request.multiAgentMode !== null && request.multiAgentMode !== "explicitRequestOnly") fail("multiAgentMode is not qualified");
  if (request.responsesapiClientMetadata !== undefined && request.responsesapiClientMetadata !== null) {
    const metadata = request.responsesapiClientMetadata;
    if (!isObject(metadata) || Object.keys(metadata).length !== 2 || metadata.source !== "codex" || metadata.client_type !== "desktop_app") fail("responses metadata is not qualified");
  }
  const requestedMode = collaboration(request.collaborationMode);
  if (request.collaborationMode !== undefined && request.collaborationMode !== null && !requestedMode) fail("collaborationMode intent is not qualified");
  if (requestedMode && (requestedMode.mode !== "default" || !isObject(requestedMode.settings) || requestedMode.settings.model !== snapshot.latestModel || requestedMode.settings.reasoning_effort !== (snapshot.latestReasoningEffort ?? null) || requestedMode.settings.developer_instructions !== null)) fail("collaborationMode intent is not qualified");
  only(context, ["inheritThreadSettings", "attachments", "commentAttachments"], "turnStart.context");
  if (context.inheritThreadSettings !== true) fail("inheritThreadSettings:true is required");
  if (context.attachments !== undefined && context.attachments !== null) emptyArray(context.attachments, "turnStart.context.attachments");
  if (context.commentAttachments !== undefined && context.commentAttachments !== null) emptyArray(context.commentAttachments, "turnStart.context.commentAttachments");

  const params: JsonObject = { threadId: snapshot.id, clientUserMessageId: request.clientUserMessageId, input: input(request.input), cwd: snapshot.cwd, model: snapshot.latestModel };
  optional(params, "turnTrigger", request.turnTrigger); optional(params, "multiAgentMode", request.multiAgentMode);
  if (request.responsesapiClientMetadata !== undefined && request.responsesapiClientMetadata !== null) {
    if (snapshot.workspaceKind !== undefined && snapshot.workspaceKind !== null && snapshot.workspaceKind !== "project" && snapshot.workspaceKind !== "projectless") fail("workspaceKind is not qualified");
    params.responsesapiClientMetadata = { ...request.responsesapiClientMetadata as JsonObject, workspace_kind: snapshot.workspaceKind ?? "project" };
  }
  optional(params, "effort", snapshot.latestReasoningEffort);
  if (request.serviceTier === null) params.serviceTier = null;
  else optional(params, "serviceTier", snapshot.latestServiceTier ?? snapshot.latestThreadSettings?.serviceTier);
  permissions(params, snapshot.currentPermissions);
  const mode = requestedMode ?? collaboration(snapshot.latestCollaborationMode);
  if (mode) {
    params.collaborationMode = mode;
    if (request.collaborationMode !== undefined && request.collaborationMode !== null) { params.model = null; params.effort = null; }
  }
  return params;
}
