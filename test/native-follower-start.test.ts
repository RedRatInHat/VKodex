import assert from "node:assert/strict";
import test from "node:test";
import { prepareNativeFollowerStart, type NativeFollowerStartSnapshot } from "../src/codex/native-follower-start.js";

const snapshot: NativeFollowerStartSnapshot = {
  id: "thread-1", cwd: "D:/work", latestModel: "gpt-5.6-sol", latestReasoningEffort: "low", latestServiceTier: "default", workspaceKind: "projectless",
  latestThreadSettings: { serviceTier: "default" },
  currentPermissions: { activePermissionProfile: { id: ":read-only" }, approvalPolicy: "on-request", approvalsReviewer: "user", runtimeWorkspaceRoots: ["D:/work"] },
  latestCollaborationMode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "low", developer_instructions: null } },
};
const envelope = (): Record<string, unknown> => ({
  conversationId: "thread-1",
  turnStart: { request: {
    threadId: "thread-1", clientUserMessageId: "native-msg", input: [{ type: "text", text: "hello", text_elements: [] }],
    cwd: "D:/work", model: null, effort: null, additionalContext: {}, turnTrigger: "composer",
    responsesapiClientMetadata: { source: "codex", client_type: "desktop_app" }, multiAgentMode: "explicitRequestOnly", serviceTier: null,
    collaborationMode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "low", developer_instructions: null } },
  }, context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] } },
});

test("qualifies the full inherited ordinary-text envelope without losing native settings", () => {
  const params = prepareNativeFollowerStart(snapshot, envelope());
  assert.deepEqual(params, {
    threadId: "thread-1", clientUserMessageId: "native-msg", input: [{ type: "text", text: "hello", text_elements: [] }],
    cwd: "D:/work", model: null, effort: null, turnTrigger: "composer", multiAgentMode: "explicitRequestOnly", serviceTier: null,
    responsesapiClientMetadata: { source: "codex", client_type: "desktop_app", workspace_kind: "projectless" }, permissions: ":read-only",
    approvalPolicy: "on-request", approvalsReviewer: "user", runtimeWorkspaceRoots: ["D:/work"],
    collaborationMode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "low", developer_instructions: null } },
  });
});

test("preserves snapshot model and permission override when native collaboration is absent", () => {
  const value = envelope(); const request = ((value.turnStart as Record<string, unknown>).request as Record<string, unknown>);
  delete request.collaborationMode; request.serviceTier = undefined;
  const params = prepareNativeFollowerStart({ ...snapshot, latestServiceTier: null, currentPermissions: { sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalPolicy: "never", approvalsReviewer: "guardian_subagent" } }, value);
  assert.equal(params.model, "gpt-5.6-sol"); assert.equal(params.effort, "low"); assert.equal(params.sandboxPolicy !== undefined, true);
  assert.equal(params.permissions, undefined); assert.equal(params.approvalPolicy, "never"); assert.equal(params.approvalsReviewer, "guardian_subagent");
});

test("rejects unknown fields including null and unqualified rich text", () => {
  const unknown = envelope(); ((unknown.turnStart as Record<string, unknown>).request as Record<string, unknown>).futureIntent = null;
  assert.throws(() => prepareNativeFollowerStart(snapshot, unknown), TypeError);
  const rich = envelope(); (((rich.turnStart as Record<string, unknown>).request as Record<string, unknown>).input as Record<string, unknown>[])[0]!.text_elements = [{ type: "mention" }];
  assert.throws(() => prepareNativeFollowerStart(snapshot, rich), TypeError);
});

test("rejects a native placeholder collaboration mode instead of inheriting a snapshot mode", () => {
  const value = envelope();
  ((value.turnStart as Record<string, unknown>).request as Record<string, unknown>).collaborationMode = {
    mode: "default", settings: { model: "", reasoning_effort: null, developer_instructions: null },
  };
  assert.throws(() => prepareNativeFollowerStart(snapshot, value), TypeError);
});

test("rejects an unrecognized runtime workspace kind when metadata is forwarded", () => {
  const runtimeSnapshot = { ...snapshot, workspaceKind: "remote" } as unknown as NativeFollowerStartSnapshot;
  assert.throws(() => prepareNativeFollowerStart(runtimeSnapshot, envelope()), TypeError);
});
