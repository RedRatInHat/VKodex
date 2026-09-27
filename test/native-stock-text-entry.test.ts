import test from "node:test";
import assert from "node:assert/strict";
import { prepareNativeStockTextEntry, type NativeStockTextQualification } from "../src/codex/native-stock-text-entry.js";

const taskId = "thread-1";
const ownerEpoch = "owner-1";
const cwd = "C:/isolated";
const publicText = "Answer with PUBLIC_OK";

function modes() {
  const requested = { mode: "default", settings: { model: "gpt-5.6-sol",
    reasoning_effort: "medium", developer_instructions: null } };
  const effective = { mode: "default", settings: { ...requested.settings,
    developer_instructions: "verified built-in instructions" } };
  return { requested, effective };
}

function fixture() {
  const { requested, effective } = modes();
  const settings = { cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: "never",
    approvalsReviewer: "user", permissions: ":danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" }, model: "gpt-5.6-sol",
    serviceTier: null, effort: "medium", summary: null,
    collaborationMode: effective, personality: "pragmatic" };
  const entry = {
    id: "entry-1", text: publicText, cwd, createdAt: 1780000000000,
    context: { prompt: publicText, turnTrigger: "composer", workspaceRoots: [cwd],
      usedDictation: false, existingWorkspaceRoot: null, localProjectId: null,
      fileAttachments: [] as string[], addedFiles: [] },
    responsesapiClientMetadata: { source: "codex", client_type: "desktop_app" },
    submissionOptions: { executionHostId: "local", agentMode: "full-access",
      permissionProfileId: ":danger-full-access", serviceTier: "default",
      shouldSendPermissionOverrides: false, usePermissionSelection: false,
      permissionSelection: null, collaborationMode: requested,
      clientUserMessageId: "different-native-option-id" },
    writingBlockAdditionalContext: null, mentionedBrowserFamilies: [],
    submissionIntent: "send-now",
    submission: { hostId: "local", status: "pending", queueModeOverride: "queue" },
  };
  const qualification: NativeStockTextQualification = {
    taskId, ownerEpoch, completeQueueAndHistory: true, exclusiveLifecycleWriter: true,
    ambientContextEmpty: true, effectiveSettings: settings,
    initializationReceipt: { taskId, ownerEpoch, confirmed: true,
      expansionKind: "builtin-default-instructions",
      requestedCollaborationMode: requested,
      confirmedEffectiveCollaborationMode: effective,
      requestedSettings: { ...settings, sandboxPolicy: null,
        serviceTier: "default", collaborationMode: requested },
      confirmedEffectiveSettings: settings },
    tierResolution: { taskId, ownerEpoch, requested: "default", effective: null,
      fastModeAllowed: false, confirmed: true },
  };
  return { entry, qualification };
}

test("source-derived plain entry maps only text to stock and keeps native attribution local", () => {
  const { entry, qualification } = fixture();
  const prepared = prepareNativeStockTextEntry(entry, qualification, taskId, ownerEpoch);
  assert.deepEqual(prepared.queueAdd, { threadId: taskId, clientUserMessageId: "entry-1",
    input: [{ type: "text", text: `${publicText}\n`, text_elements: [] }] });
  assert.deepEqual(prepared.localAttribution, {
    nativeEntryId: "entry-1", nativeOptionClientUserMessageId: "different-native-option-id",
    nativeMessageThreadId: undefined, turnTrigger: "composer",
    responsesapiClientMetadata: { source: "codex", client_type: "desktop_app" },
    forwardedUpstream: { turnTrigger: false, responsesapiClientMetadata: false,
      nativeOptionClientUserMessageId: false, nativeMessageThreadId: false },
  });
  assert.equal(Object.hasOwn(qualification, "freshIdle"), false,
    "freshness is orchestration evidence, not a mapper-invented requirement");
});

test("absent and null context collaboration preserve option precedence; matching non-null also works", () => {
  for (const contextMode of [undefined, null, modes().requested]) {
    const { entry, qualification } = fixture();
    if (contextMode !== undefined) Object.assign(entry.context, { collaborationMode: contextMode });
    assert.equal(prepareNativeStockTextEntry(entry, qualification, taskId, ownerEpoch)
      .queueAdd.clientUserMessageId, entry.id);
  }
});

test("inert native option and message thread IDs preserve differing numeric metadata", () => {
  const { entry, qualification } = fixture();
  Object.assign(entry.submissionOptions, { clientUserMessageId: 42 });
  Object.assign(entry.context, { messageThreadId: 7 });
  const prepared = prepareNativeStockTextEntry(entry, qualification, taskId, ownerEpoch);
  assert.equal(prepared.queueAdd.clientUserMessageId, entry.id);
  assert.equal(prepared.localAttribution.nativeOptionClientUserMessageId, 42);
  assert.equal(prepared.localAttribution.nativeMessageThreadId, 7);
});

test("unknown or nonempty native context rejects before a stock request exists", () => {
  const changes: Array<(entry: ReturnType<typeof fixture>["entry"]) => void> = [
    entry => { Object.assign(entry, { privateKey: "not forwarded" }); },
    entry => { Object.assign(entry.context, { [Symbol("private")]: "not forwarded" }); },
    entry => { entry.context.fileAttachments.push("file"); },
    entry => { Object.assign(entry.context, { inAppBrowserContext: { text: "private" } }); },
    entry => { Object.assign(entry.context, { additionalDeveloperInstructions: "private" }); },
    entry => { entry.text = "line one\nline two"; entry.context.prompt = entry.text; },
    entry => { entry.context.prompt = "different"; },
    entry => { Object.assign(entry, { mentionedBrowserFamilies: null }); },
  ];
  for (const change of changes) {
    const { entry, qualification } = fixture(); change(entry);
    assert.throws(() => prepareNativeStockTextEntry(entry, qualification, taskId, ownerEpoch));
  }
});

test("task and owner qualification, permissions, model and non-null context mode must match", () => {
  const changes: Array<(value: ReturnType<typeof fixture>) => void> = [
    value => { Object.assign(value.qualification, { taskId: "other" }); },
    value => { Object.assign(value.qualification, { ownerEpoch: "other" }); },
    value => { Object.assign(value.qualification, { completeQueueAndHistory: false }); },
    value => { Object.assign(value.qualification, { exclusiveLifecycleWriter: false }); },
    value => { Object.assign(value.qualification, { ambientContextEmpty: false }); },
    value => { value.entry.submissionOptions.permissionProfileId = ":read-only"; },
    value => { Object.assign(value.qualification.effectiveSettings, { permissions: ":read-only" }); },
    value => { value.entry.submissionOptions.collaborationMode.settings.model = "different"; },
    value => { Object.assign(value.entry.context, { collaborationMode: {
      mode: "plan", settings: { model: "gpt-5.6-sol", reasoning_effort: "medium",
        developer_instructions: null } } }); },
  ];
  for (const change of changes) {
    const value = fixture(); change(value);
    assert.throws(() => prepareNativeStockTextEntry(value.entry, value.qualification, taskId, ownerEpoch));
  }
});

test("empty effective built-in instructions cannot confirm expansion", () => {
  const { entry, qualification } = fixture();
  const effective = qualification.effectiveSettings.collaborationMode as ReturnType<typeof modes>["effective"];
  effective.settings.developer_instructions = "";
  assert.throws(() => prepareNativeStockTextEntry(entry, qualification, taskId, ownerEpoch));
});
