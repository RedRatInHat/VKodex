import { isDeepStrictEqual } from "node:util";
import type { HomogeneousQueueSettings, PlainTextQueueInput } from "./homogeneous-queue-policy.js";

/** A validated Desktop plain-text entry becomes one stock queue/add input.
 * This module neither owns a worker nor establishes fresh/idle queue evidence.
 * The caller must serialize lifecycle writes and independently qualify activity.
 */
export interface NativeStockTextQualification {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly completeQueueAndHistory: boolean;
  readonly exclusiveLifecycleWriter: boolean;
  readonly ambientContextEmpty: boolean;
  readonly effectiveSettings: HomogeneousQueueSettings;
  readonly initializationReceipt?: unknown;
  readonly tierResolution?: unknown;
}

export interface PreparedNativeStockTextEntry {
  readonly queueAdd: {
    readonly threadId: string;
    readonly clientUserMessageId: string;
    readonly input: readonly PlainTextQueueInput[];
  };
  readonly localAttribution: {
    readonly nativeEntryId: string;
    readonly nativeOptionClientUserMessageId: unknown;
    readonly nativeMessageThreadId: unknown;
    readonly turnTrigger: "composer";
    readonly responsesapiClientMetadata: {
      readonly source: "codex";
      readonly client_type: "desktop_app";
    };
    readonly forwardedUpstream: {
      readonly turnTrigger: false;
      readonly responsesapiClientMetadata: false;
      readonly nativeOptionClientUserMessageId: false;
      readonly nativeMessageThreadId: false;
    };
  };
}

export class NativeStockTextEntryError extends Error {
  constructor(readonly code: string) {
    super(`Native stock text entry refused: ${code}`);
    this.name = "NativeStockTextEntryError";
  }
}

const reject = (code: string): never => { throw new NativeStockTextEntryError(code); };
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function only(value: unknown, fields: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== "string" ||
      !fields.includes(key))) reject(code);
}
const empty = (value: unknown): boolean => value === null || value === undefined ||
  (Array.isArray(value) && value.length === 0 && Reflect.ownKeys(value).length === 1);
const absent = (value: unknown): boolean => value === null || value === undefined;

const entryKeys = ["id", "text", "context", "cwd", "createdAt", "responsesapiClientMetadata",
  "submissionOptions", "writingBlockAdditionalContext", "submissionIntent", "submission",
  "mentionedBrowserFamilies"];
const contextArrays = ["addedFiles", "fileAttachments", "pastedTextAttachments",
  "uploadedFileAttachments", "imageAttachments", "imageCommentDrafts",
  "mcpAppModelContextAttachments", "commentAttachments", "selectedTextAttachments",
  "responseTextAnnotations", "chatGptConversationContexts", "threadReferences",
  "appshotContexts", "pullRequestChecks", "attachmentOrder", "disabledPluginIds",
  "elicitationPluginIds", "artifactFollowupAttributions"];
const contextAbsent = ["ideContext", "inAppBrowserContext", "pullRequestMergeConflict",
  "additionalContext", "additionalDeveloperInstructions", "libraryFileCreation",
  "threadGoalDraft", "priorConversation", "firstTurnReasoningEffort",
  "worktreePrompt", "openingPromptForHistory", "cloudThreadPrototype",
  "existingWorkspaceRoot", "localProjectId", "remoteProjectId", "latexEditorContext"];
const contextKeys = ["prompt", "turnTrigger", "messageThreadId", "workspaceRoots",
  "collaborationMode", "usedDictation", ...contextArrays, ...contextAbsent];
const optionKeys = ["executionHostId", "agentMode", "permissionProfileId", "serviceTier",
  "shouldSendPermissionOverrides", "usePermissionSelection", "permissionSelection",
  "collaborationMode", "clientUserMessageId"];
const settingKeys = ["cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer",
  "permissions", "sandboxPolicy", "model", "serviceTier", "effort", "summary",
  "collaborationMode", "personality"];

function mode(value: unknown, code: string): Record<string, unknown> {
  only(value, ["mode", "settings"], code);
  only(value.settings, ["model", "reasoning_effort", "developer_instructions"], code);
  const settings = value.settings;
  if (value.mode !== "default" || typeof settings.model !== "string" || !settings.model ||
      typeof settings.reasoning_effort !== "string" || !settings.reasoning_effort ||
      !absent(settings.developer_instructions) && typeof settings.developer_instructions !== "string") reject(code);
  return value;
}

function effectiveSettings(value: unknown): Record<string, unknown> {
  only(value, settingKeys, "effective-settings-shape");
  if (settingKeys.some(key => !Object.hasOwn(value, key))) reject("effective-settings-incomplete");
  only(value.sandboxPolicy, ["type"], "effective-sandbox-shape");
  if (typeof value.cwd !== "string" || !value.cwd ||
      !Array.isArray(value.runtimeWorkspaceRoots) ||
      value.runtimeWorkspaceRoots.some(root => typeof root !== "string" || !root) ||
      value.approvalPolicy !== "never" || value.approvalsReviewer !== "user" ||
      value.permissions !== ":danger-full-access" || value.sandboxPolicy.type !== "dangerFullAccess" ||
      typeof value.model !== "string" || !value.model ||
      typeof value.effort !== "string" || !value.effort ||
      ![null, "default"].includes(value.serviceTier as null | string) ||
      !absent(value.summary) && typeof value.summary !== "string" ||
      !absent(value.personality) && typeof value.personality !== "string") {
    reject("effective-settings-outside-full-access-subset");
  }
  const collaboration = mode(value.collaborationMode, "effective-collaboration-shape");
  const settings = collaboration.settings as Record<string, unknown>;
  if (settings.model !== value.model || settings.reasoning_effort !== value.effort) {
    reject("effective-collaboration-settings-mismatch");
  }
  return value;
}

/** Validates execution semantics without reserving the stock queue or claiming freshness. */
export function prepareNativeStockTextEntry(entryValue: unknown,
  qualificationValue: NativeStockTextQualification, taskId: string,
  ownerEpoch: string): PreparedNativeStockTextEntry {
  const q = qualificationValue;
  if (!plain(q) || !taskId || !ownerEpoch || q.taskId !== taskId ||
      q.ownerEpoch !== ownerEpoch || q.completeQueueAndHistory !== true ||
      q.exclusiveLifecycleWriter !== true || q.ambientContextEmpty !== true) {
    reject("task-owner-or-completeness-unqualified");
  }
  const f = effectiveSettings(q.effectiveSettings);
  only(entryValue, entryKeys, "entry-shape");
  const entry = entryValue;
  only(entry.context, contextKeys, "context-shape");
  const context = entry.context;
  only(entry.submissionOptions, optionKeys, "options-shape");
  const options = entry.submissionOptions;
  only(entry.submission, ["hostId", "status", "queueModeOverride"], "submission-shape");
  const submission = entry.submission;
  only(entry.responsesapiClientMetadata, ["source", "client_type"], "attribution-shape");
  const metadata = entry.responsesapiClientMetadata;
  if (entry.mentionedBrowserFamilies !== undefined &&
      !(Array.isArray(entry.mentionedBrowserFamilies) && entry.mentionedBrowserFamilies.length === 0 &&
        Reflect.ownKeys(entry.mentionedBrowserFamilies).length === 1)) {
    reject("browser-mentions-unsupported");
  }
  if (typeof entry.id !== "string" || !entry.id ||
      !Number.isSafeInteger(entry.createdAt) || (entry.createdAt as number) <= 0) {
    reject("entry-identity-or-created-at-invalid");
  }
  const nativeEntryId = entry.id as string;
  if (typeof entry.text !== "string" || !entry.text.trim() || /[\r\n]/u.test(entry.text) ||
      context.prompt !== entry.text) reject("plain-text-unsupported");
  if (entry.cwd !== f.cwd || !isDeepStrictEqual(context.workspaceRoots, f.runtimeWorkspaceRoots)) {
    reject("workspace-settings-mismatch");
  }
  if (context.turnTrigger !== "composer" || metadata.source !== "codex" ||
      metadata.client_type !== "desktop_app" || entry.writingBlockAdditionalContext !== null) {
    reject("composer-attribution-unsupported");
  }
  if (contextArrays.some(key => !empty(context[key])) ||
      contextAbsent.some(key => !absent(context[key])) || context.usedDictation !== false) {
    reject("native-context-nonempty");
  }
  const legacyFullAccess = options.permissionProfileId === null &&
    options.shouldSendPermissionOverrides === true && !Object.hasOwn(options, "permissionSelection");
  const namedFullAccess = options.permissionProfileId === ":danger-full-access" &&
    options.shouldSendPermissionOverrides === false &&
    Object.hasOwn(options, "permissionSelection") && options.permissionSelection === null;
  if (options.executionHostId !== "local" || options.agentMode !== "full-access" ||
      options.serviceTier !== "default" || options.usePermissionSelection !== false ||
      !legacyFullAccess && !namedFullAccess) reject("native-permission-selection-unsupported");
  if (entry.submissionIntent !== "send-now" || submission.hostId !== "local" ||
      submission.status !== "pending" || submission.queueModeOverride !== "queue") {
    reject("native-first-send-intent-unsupported");
  }
  const requestedMode = mode(options.collaborationMode, "native-collaboration-shape");
  const requestedSettings = requestedMode.settings as Record<string, unknown>;
  if (requestedSettings.model !== f.model || requestedSettings.reasoning_effort !== f.effort) {
    reject("native-collaboration-settings-mismatch");
  }
  if (!absent(context.collaborationMode)) {
    mode(context.collaborationMode, "context-collaboration-shape");
    if (!isDeepStrictEqual(context.collaborationMode, requestedMode)) {
      reject("context-collaboration-mode-mismatch");
    }
  }
  if (!isDeepStrictEqual(requestedMode, f.collaborationMode)) {
    const receipt = q.initializationReceipt;
    only(receipt, ["taskId", "ownerEpoch", "confirmed", "expansionKind",
      "requestedCollaborationMode", "confirmedEffectiveCollaborationMode",
      "requestedSettings", "confirmedEffectiveSettings"], "builtin-expansion-receipt-shape");
    const expectedRequested = { ...f, sandboxPolicy: null, serviceTier: options.serviceTier,
      collaborationMode: requestedMode };
    const effectiveMode = f.collaborationMode as Record<string, unknown>;
    const effectiveModeSettings = effectiveMode.settings as Record<string, unknown>;
    if (receipt.taskId !== taskId || receipt.ownerEpoch !== ownerEpoch ||
        receipt.confirmed !== true || receipt.expansionKind !== "builtin-default-instructions" ||
        !isDeepStrictEqual(receipt.requestedCollaborationMode, requestedMode) ||
        !isDeepStrictEqual(receipt.confirmedEffectiveCollaborationMode, f.collaborationMode) ||
        !isDeepStrictEqual(receipt.requestedSettings, expectedRequested) ||
        !isDeepStrictEqual(receipt.confirmedEffectiveSettings, f) ||
        requestedSettings.developer_instructions !== null ||
        typeof effectiveModeSettings.developer_instructions !== "string" ||
        !effectiveModeSettings.developer_instructions) reject("builtin-expansion-unconfirmed");
  }
  if (f.serviceTier === null) {
    const tier = q.tierResolution;
    only(tier, ["taskId", "ownerEpoch", "requested", "effective",
      "fastModeAllowed", "confirmed"], "tier-resolution-shape");
    if (tier.taskId !== taskId || tier.ownerEpoch !== ownerEpoch ||
        tier.requested !== "default" || tier.effective !== null ||
        tier.fastModeAllowed !== false || tier.confirmed !== true) reject("tier-resolution-unconfirmed");
  }
  const queueAdd = { threadId: taskId, clientUserMessageId: nativeEntryId,
    input: [{ type: "text" as const, text: `${entry.text}\n`, text_elements: [] as [] }] };
  return { queueAdd, localAttribution: {
    nativeEntryId,
    nativeOptionClientUserMessageId: options.clientUserMessageId,
    nativeMessageThreadId: context.messageThreadId,
    turnTrigger: "composer", responsesapiClientMetadata: { source: "codex", client_type: "desktop_app" },
    forwardedUpstream: { turnTrigger: false, responsesapiClientMetadata: false,
      nativeOptionClientUserMessageId: false, nativeMessageThreadId: false },
  } };
}
