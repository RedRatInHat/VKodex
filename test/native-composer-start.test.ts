import assert from "node:assert/strict";
import test from "node:test";
import { compileNativeReadOnlyComposerStart } from "../src/codex/native-composer-start.js";

type Row = Record<string, unknown>;
function snapshot(): Row {
  return { id: "thread-1", cwd: "C:/isolated", latestModel: "gpt-6-luna", latestReasoningEffort: "low",
    hostId: "local", resumeState: "resumed", workspaceKind: "projectless", turns: [], environments: [],
    latestThreadSettings: { cwd: "C:/isolated", model: "gpt-6-luna", effort: "low", serviceTier: "default", summary: null,
      personality: "pragmatic", activePermissionProfile: { id: ":read-only" }, sandboxPolicy: { type: "readOnly", networkAccess: false } },
    latestCollaborationMode: { mode: "default", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } },
    currentPermissions: { activePermissionProfile: { id: ":read-only" }, sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "never", approvalsReviewer: "user", runtimeWorkspaceRoots: ["C:/isolated"] } };
}
function envelope(s = snapshot()): Row {
  return { conversationId: "thread-1", turnStart: { request: { threadId: "thread-1", clientUserMessageId: "composer-op",
    input: [{ type: "text", text: "hello", text_elements: [] }], cwd: "C:/isolated", model: null, effort: null,
    serviceTier: null, collaborationMode: structuredClone(s.latestCollaborationMode), permissions: ":read-only",
    approvalPolicy: "on-request", approvalsReviewer: "user", turnTrigger: "composer",
    responsesapiClientMetadata: { source: "codex", client_type: "desktop_app" }, multiAgentMode: "explicitRequestOnly" },
    context: { inheritThreadSettings: true, writingBlockContextPrepared: true,
      localTurnMetadata: { fileAttachmentCount: 0 }, attachments: [], commentAttachments: [], responseItems: [],
      useAppServerPermissionDefault: false, usePermissionSelection: false } } };
}
function parts(f: Row): { request: Row; context: Row } {
  const start = f.turnStart as Row;
  return { request: start.request as Row, context: start.context as Row };
}

test("qualified first-turn read-only Composer compiles separate wire, UI and local metadata without mutation", () => {
  const s = snapshot(), f = envelope(s), beforeS = structuredClone(s), beforeF = structuredClone(f);
  const actual = compileNativeReadOnlyComposerStart(s, f);
  assert.deepEqual(actual.request, {
    threadId: "thread-1", clientUserMessageId: "composer-op", input: [{ type: "text", text: "hello", text_elements: [] }],
    cwd: "C:/isolated", model: null, effort: null, serviceTier: null, permissions: ":read-only",
    sandboxPolicy: null, approvalPolicy: "on-request", approvalsReviewer: "user", runtimeWorkspaceRoots: ["C:/isolated"],
    collaborationMode: s.latestCollaborationMode, turnTrigger: "composer", multiAgentMode: "explicitRequestOnly",
    responsesapiClientMetadata: { source: "codex", client_type: "desktop_app", workspace_kind: "projectless" },
    summary: null, personality: "pragmatic", outputSchema: null,
  });
  assert.deepEqual(actual.localMetadata, { fileAttachmentCount: 0 });
  assert.equal(actual.uiParams.cwd, "C:/isolated");
  assert.deepEqual(actual.uiParams.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(actual.uiParams.responsesapiClientMetadata, { source: "codex", client_type: "desktop_app" });
  (actual.request.input as Row[])[0]!.text = "changed";
  assert.deepEqual(s, beforeS); assert.deepEqual(f, beforeF);
});

test("rejects unqualified permission and Composer context instead of discarding them", () => {
  const cases: [string, (s: Row, f: Row) => void][] = [
    ["host", s => { s.hostId = "remote"; }], ["resume", s => { s.resumeState = "starting"; }],
    ["profile", s => { (s.currentPermissions as Row).activePermissionProfile = { id: ":danger-full-access" }; }],
    ["settings profile", s => { (s.latestThreadSettings as Row).activePermissionProfile = { id: ":danger-full-access" }; }],
    ["sandbox", s => { (s.currentPermissions as Row).sandboxPolicy = { type: "readOnly", networkAccess: true }; }],
    ["permission", (_, f) => { parts(f).request.permissions = ":danger-full-access"; }],
    ["approval", (_, f) => { parts(f).request.approvalPolicy = "never"; }],
    ["server default", (_, f) => { parts(f).context.useAppServerPermissionDefault = true; }],
    ["selection", (_, f) => { parts(f).context.usePermissionSelection = true; }],
    ["unprepared", (_, f) => { parts(f).context.writingBlockContextPrepared = false; }],
    ["attachment", (_, f) => { parts(f).context.attachments = [{ id: "file" }]; }],
    ["response item", (_, f) => { parts(f).context.responseItems = [{ type: "toolOutput" }]; }],
    ["local metadata", (_, f) => { parts(f).context.localTurnMetadata = { fileAttachmentCount: 1 }; }],
    ["passive context", (_, f) => { parts(f).context.passiveContext = { text: "meaning" }; }],
    ["additional context", (_, f) => { parts(f).request.additionalContext = { text: "meaning" }; }],
    ["cwd", (_, f) => { parts(f).request.cwd = "C:/other"; }],
    ["mode", (_, f) => { ((parts(f).request.collaborationMode as Row).settings as Row).model = "other"; }],
    ["text elements", (_, f) => { ((parts(f).request.input as Row[])[0]!).text_elements = [{ type: "mention" }]; }],
  ];
  for (const [label, change] of cases) {
    const s = snapshot(), f = envelope(s); change(s, f);
    assert.throws(() => compileNativeReadOnlyComposerStart(s, f), { name: "TypeError" }, label);
  }
});

test("rejects unknown envelope fields before ordinary normalization can discard them", () => {
  const cases: [string, (f: Row) => void][] = [
    ["request meaningful", f => { parts(f).request.newMeaningfulField = { instructions: "do more" }; }],
    ["request additionalInstructions", f => { parts(f).request.additionalInstructions = "do more"; }],
    ["request null", f => { parts(f).request.futureNullField = null; }],
    ["follower meaningful", f => { f.newMeaningfulField = { approval: true }; }],
    ["follower null", f => { f.futureNullField = null; }],
    ["turnStart meaningful", f => { (f.turnStart as Row).newMeaningfulField = { approval: true }; }],
    ["turnStart null", f => { (f.turnStart as Row).futureNullField = null; }],
  ];
  for (const [label, change] of cases) {
    const s = snapshot(), f = envelope(s); change(f);
    assert.throws(() => compileNativeReadOnlyComposerStart(s, f), /not qualified/, label);
  }
});

test("requires first turn, exact workspace/snapshot settings and known defaults", () => {
  const cases: ((s: Row) => void)[] = [
    s => { s.workspaceKind = "project"; }, s => { s.turns = [{ turnId: "old" }]; },
    s => { s.environments = null; }, s => { s.environments = [{ id: "remote" }]; },
    s => { (s.latestThreadSettings as Row).cwd = "C:/other"; },
    s => { (s.latestThreadSettings as Row).effort = "high"; },
    s => { delete (s.latestThreadSettings as Row).summary; },
    s => { delete (s.latestThreadSettings as Row).personality; },
    s => { ((s.currentPermissions as Row).runtimeWorkspaceRoots as string[]).push("C:/other"); },
  ];
  for (const change of cases) { const s = snapshot(), f = envelope(s); change(s); assert.throws(() => compileNativeReadOnlyComposerStart(s, f)); }
  const s = snapshot(), f = envelope(s);
  delete (s.latestThreadSettings as Row).summary; delete (s.latestThreadSettings as Row).personality;
  const defaults = { taskId: s.id, cwd: s.cwd, summary: null, personality: "friendly" };
  const actual = compileNativeReadOnlyComposerStart(s, f, defaults);
  assert.equal(actual.request.personality, "friendly");
  assert.throws(() => compileNativeReadOnlyComposerStart(s, f, { ...defaults, taskId: "other" }));
});

test("environment roots and tier requirements preserve wire/UI differences", () => {
  const s = snapshot(), f = envelope(s);
  s.environments = [{ environmentId: "local", cwd: s.cwd, runtimeWorkspaceRoots: [s.cwd] }];
  const actual = compileNativeReadOnlyComposerStart(s, f);
  assert.equal(actual.request.cwd, null); assert.equal(actual.request.runtimeWorkspaceRoots, null);
  assert.deepEqual(actual.request.environments, s.environments);
  assert.equal(actual.uiParams.cwd, s.cwd);
  assert.deepEqual(actual.uiParams.runtimeWorkspaceRoots, [s.cwd]);
  for (const [tier, allowed, expected] of [[null, true, null], [null, false, null], ["default", true, "default"],
    ["default", false, null], [undefined, true, "default"], [undefined, false, null]] as const) {
    const v = envelope(s); parts(v).request.serviceTier = tier;
    const output = compileNativeReadOnlyComposerStart(s, v, { taskId: s.id, cwd: s.cwd, fastModeAllowed: allowed });
    assert.equal(output.request.serviceTier, expected); assert.equal(output.uiParams.serviceTier, expected);
  }
  const invalid = envelope(s); parts(invalid).request.serviceTier = "default";
  assert.throws(() => compileNativeReadOnlyComposerStart(s, invalid));
  assert.throws(() => compileNativeReadOnlyComposerStart(s, invalid, { taskId: s.id, cwd: s.cwd, fastModeAllowed: "true" }));
});
