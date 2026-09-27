import { prepareNativeFollowerStart, type NativeFollowerStartSnapshot } from "./native-follower-start.js";

type Row = Record<string, unknown>;
export interface NativeComposerStartResult {
  readonly request: Row;
  readonly uiParams: Row;
  readonly localMetadata: Row;
}

function fail(reason: string): never { throw new TypeError(`Unsupported native read-only Composer start: ${reason}`); }
function object(value: unknown): value is Row { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function copy<T>(value: T): T { return structuredClone(value); }
function only(value: Row, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}.${key} is not qualified`);
}
function empty(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length !== 0) fail(`${label} must be an empty array`);
}
function checkedProfile(value: Row): void {
  const profile = value.activePermissionProfile, sandbox = value.sandboxPolicy;
  if (!object(profile) || profile.id !== ":read-only" || !object(sandbox) || sandbox.type !== "readOnly" || sandbox.networkAccess !== false) {
    fail("native read-only worker safety is not proven");
  }
  only(sandbox, ["type", "networkAccess"], "sandboxPolicy");
}

/**
 * Pure first-turn local :read-only Composer canary compiler. It is not general
 * native UI compatibility and never starts a turn or decides worker ownership.
 * Caller must fence the same live worker generation before dispatch.
 */
export function compileNativeReadOnlyComposerStart(snapshot: unknown, follower: unknown, defaults: unknown = null): NativeComposerStartResult {
  if (!object(snapshot) || snapshot.hostId !== "local" || snapshot.resumeState !== "resumed" ||
      !text(snapshot.id) || !text(snapshot.cwd) || !text(snapshot.latestModel)) fail("native snapshot is not local/resumed");
  if (snapshot.workspaceKind !== "projectless" || !Array.isArray(snapshot.turns) || snapshot.turns.length !== 0 ||
      !Array.isArray(snapshot.environments) || snapshot.environments.length > 1) fail("native first-turn workspace is not qualified");
  for (const environment of snapshot.environments) {
    if (!object(environment)) fail("native environment is not qualified");
    only(environment, ["environmentId", "cwd", "runtimeWorkspaceRoots"], "native environment");
    if (environment.environmentId !== "local" || environment.cwd !== snapshot.cwd ||
        !Array.isArray(environment.runtimeWorkspaceRoots) || environment.runtimeWorkspaceRoots.length !== 1 ||
        environment.runtimeWorkspaceRoots[0] !== snapshot.cwd) fail("native environment is not qualified");
  }
  if (defaults !== null && (!object(defaults) || defaults.taskId !== snapshot.id || defaults.cwd !== snapshot.cwd)) {
    fail("native config defaults identity differs");
  }
  const settings = snapshot.latestThreadSettings;
  if (!object(settings) || settings.cwd !== snapshot.cwd || settings.model !== snapshot.latestModel ||
      settings.effort !== snapshot.latestReasoningEffort) fail("native settings identity is not proven");
  if (!object(snapshot.currentPermissions)) fail("native read-only worker safety is not proven");
  checkedProfile(snapshot.currentPermissions);
  checkedProfile(settings);
  const roots = snapshot.currentPermissions.runtimeWorkspaceRoots;
  if (!Array.isArray(roots) || roots.length !== 1 || roots[0] !== snapshot.cwd) fail("native workspace roots are not qualified");
  const defaultsRow = defaults === null ? null : defaults as Row;
  const summary = settings.summary !== undefined ? settings.summary : defaultsRow?.summary;
  const personality = settings.personality !== undefined ? settings.personality : defaultsRow?.personality;
  if (summary !== null && !["auto", "concise", "detailed", "none"].includes(summary as string)) fail("native summary default is not known");
  if (personality !== null && !["none", "friendly", "pragmatic"].includes(personality as string)) fail("native personality default is not known");

  if (!object(follower) || !object(follower.turnStart)) fail("native envelope is malformed");
  const start = follower.turnStart;
  if (!object(start.request) || !object(start.context)) fail("native request/context required");
  only(follower, ["conversationId", "turnStart"], "native follower");
  only(start, ["request", "context"], "native turnStart");
  const request = start.request, context = start.context;
  only(context, ["inheritThreadSettings", "writingBlockContextPrepared", "localTurnMetadata", "attachments",
    "commentAttachments", "responseItems", "useAppServerPermissionDefault", "usePermissionSelection"], "native context");
  if (context.inheritThreadSettings !== true || context.writingBlockContextPrepared !== true ||
      context.useAppServerPermissionDefault !== false || context.usePermissionSelection !== false) {
    fail("native preparation/permission selection is not qualified");
  }
  for (const key of ["attachments", "commentAttachments", "responseItems"]) if (context[key] != null) empty(context[key], `native context.${key}`);
  if (!object(context.localTurnMetadata) || Object.keys(context.localTurnMetadata).length !== 1 ||
      context.localTurnMetadata.fileAttachmentCount !== 0) fail("native local metadata is not qualified");
  if (request.permissions !== ":read-only" || request.approvalPolicy !== "on-request" ||
      request.approvalsReviewer !== "user" || request.sandboxPolicy != null) fail("native explicit permission tuple is not qualified");
  if (request.model !== null || request.effort !== null || request.collaborationMode == null ||
      request.turnTrigger !== "composer" || request.multiAgentMode !== "explicitRequestOnly" ||
      request.responsesapiClientMetadata == null) fail("native ordinary Composer settings are not qualified");
  if (request.additionalContext != null && (!object(request.additionalContext) || Object.keys(request.additionalContext).length !== 0)) {
    fail("native additional context is not empty");
  }
  if (!Array.isArray(request.input) || request.input.length !== 1 || !object(request.input[0]) ||
      request.input[0].type !== "text" || typeof request.input[0].text !== "string") fail("ordinary text input is malformed");
  empty(request.input[0].text_elements, "native text_elements");
  const requestedTier = request.serviceTier === undefined ? (settings.serviceTier ?? null) : request.serviceTier;
  if (requestedTier !== null && requestedTier !== "default") fail("native service tier is not qualified");
  if (requestedTier !== null && typeof defaultsRow?.fastModeAllowed !== "boolean") fail("native tier requirements are not known");
  const effectiveTier = requestedTier === null || defaultsRow?.fastModeAllowed === false ? null : requestedTier;

  // Resolve full Composer-only fields above, then run the existing qualified
  // ordinary compiler for its inherited model, mode, metadata and path rules.
  const ordinaryKeys = ["threadId", "clientUserMessageId", "input", "cwd", "model", "effort", "additionalContext",
    "turnTrigger", "responsesapiClientMetadata", "multiAgentMode", "serviceTier", "collaborationMode"] as const;
  only(request, [...ordinaryKeys, "permissions", "approvalPolicy", "approvalsReviewer", "sandboxPolicy"], "native request");
  const normalizedRequest: Row = {};
  for (const key of ordinaryKeys) if (Object.hasOwn(request, key)) normalizedRequest[key] = copy(request[key]);
  normalizedRequest.serviceTier = null;
  const normalized = { conversationId: follower.conversationId,
    turnStart: { request: normalizedRequest, context: { inheritThreadSettings: true } } };
  const ordinarySnapshot: NativeFollowerStartSnapshot = {
    id: snapshot.id, cwd: snapshot.cwd, latestModel: snapshot.latestModel,
    ...(snapshot.latestReasoningEffort === undefined ? {} : { latestReasoningEffort: snapshot.latestReasoningEffort as string | null }),
    ...(snapshot.latestServiceTier === undefined ? {} : { latestServiceTier: snapshot.latestServiceTier as string | null }),
    latestThreadSettings: settings.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier as string | null },
    currentPermissions: snapshot.currentPermissions, workspaceKind: "projectless", latestCollaborationMode: snapshot.latestCollaborationMode,
  };
  const params = prepareNativeFollowerStart(ordinarySnapshot, normalized);
  params.permissions = ":read-only";
  params.sandboxPolicy = null;
  params.approvalPolicy = "on-request";
  params.approvalsReviewer = "user";
  params.serviceTier = effectiveTier;
  params.summary = summary;
  params.personality = personality;
  params.outputSchema = null;
  if (snapshot.environments.length) {
    params.environments = copy(snapshot.environments);
    params.runtimeWorkspaceRoots = null;
    params.cwd = null;
  }
  if (request.additionalContext !== undefined) params.additionalContext = copy(request.additionalContext);
  const uiParams: Row = { ...copy(request), ...copy(params), cwd: snapshot.cwd, runtimeWorkspaceRoots: copy(roots),
    sandboxPolicy: copy(snapshot.currentPermissions.sandboxPolicy),
    responsesapiClientMetadata: copy(request.responsesapiClientMetadata),
    attachments: copy(context.attachments), commentAttachments: copy(context.commentAttachments),
    useAppServerPermissionDefault: false };
  if (!Object.hasOwn(request, "environments")) delete uiParams.environments;
  return { request: params, uiParams, localMetadata: copy(context.localTurnMetadata) };
}
