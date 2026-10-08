import test from "node:test";
import assert from "node:assert/strict";
import { DotExtensionController } from "../src/dot-browser/extension-controller.js";
import type { DotSubmissionCommandOptions, DotSubmissionCommandResult } from "../src/dot-browser/submission-command.js";
import type { DotControlResponse } from "../src/dot-browser/control-protocol.js";
import { parseDotControlResponse } from "../src/dot-browser/control-protocol.js";
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", other = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const roomId = "a".repeat(32), mid = `${roomId}~${roomId}~CalpicoMessage~Sentinel_${"b".repeat(32)}`;
const binding = { roomId, pageUrl: "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ownerAnchorId: mid,
  dotAnchorId: mid.replace(/b{32}$/u, "c".repeat(32)) };
const base = { version: 1, requestId: id, scope: { roomId, generation: 1, epoch: id } };
const request = { ...base, method: "observe-and-submit", operationId: id, text: "test" };
const observed: DotSubmissionCommandResult = { phase: "observed", messageId: mid, evidence: "same-node-dom-transition" };
test("one command runs automatically, emits bounded stages, and duplicate calls only query", async () => {
  const events: DotControlResponse[] = []; let calls = 0;
  const controller = new DotExtensionController({} as Document, binding, 1, id, e => events.push(e), async options => {
    calls++; options.onStage("armed"); options.onStage("write-attempt"); options.onStage("write-returned"); return observed;
  }, () => true);
  const result = await controller.handle(request);
  assert.equal(result.kind, "result");
  assert.deepEqual(events.map(event => event.kind), ["result", "stage", "stage", "stage"]);
  assert.deepEqual(await controller.handle(request), result); assert.equal(calls, 1);
  const conflict = await controller.handle({ ...request, text: "different" });
  assert.equal(conflict.kind === "error" && conflict.reason, "operation-conflict");
  assert.equal((await controller.handle({ ...base, method: "result", operationId: id })).kind, "result");
});
test("concurrent commands do not overwrite the active operation", async () => {
  let resolve!: (result: DotSubmissionCommandResult) => void;
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => {}, () => new Promise(done => { resolve = done; }), () => true);
  const running = controller.handle(request);
  const duplicate = await controller.handle(request);
  assert.equal(duplicate.kind === "result" && duplicate.result.phase, "accepted");
  const concurrent = await controller.handle({ ...request, operationId: other });
  assert.equal(concurrent.kind === "error" && concurrent.reason, "operation-conflict");
  assert.equal((await controller.handle({ ...base, method: "status" })).kind, "status");
  resolve(observed); await running;
});
test("disconnect and failed stage delivery abort the active command without retry", async () => {
  let calls = 0, captured!: DotSubmissionCommandOptions;
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => { throw new Error("port closed"); }, async options => {
    calls++; captured = options;
    return { phase: "uncertain", reason: "aborted" };
  }, () => true);
  const response = await controller.handle(request);
  assert.equal(captured.signal.aborted, true);
  assert.equal(response.kind === "result" && response.result.phase, "uncertain");
  assert.equal((await controller.handle(request)).kind, "error"); assert.equal(calls, 1);
});
test("wrong scope, foreign command and unqualified page never reach the runner", async () => {
  let calls = 0;
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => {}, async () => { calls++; return observed; }, () => false);
  for (const scope of [{ ...base.scope, epoch: other }, { ...base.scope, generation: 2 }, { ...base.scope, roomId: "b".repeat(32) }])
    assert.equal((await controller.handle({ ...request, scope })).kind, "error");
  await assert.rejects(controller.handle({ ...request, method: "eval", script: "PRIVATE" }), /Invalid dot control request/u);
  assert.equal((await controller.handle(request)).kind, "error"); assert.equal(calls, 0);
});
test("unknown results remain unknown and runner errors become fixed uncertainty", async () => {
  const controller = new DotExtensionController({} as Document, binding, 1, id, () => {}, async () => { throw new Error("PRIVATE"); }, () => true);
  assert.equal((await controller.handle({ ...base, method: "result", operationId: other })).kind, "error");
  const result = await controller.handle(request);
  assert.equal(result.kind === "result" && result.result.phase, "uncertain");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
});

function readinessFixture() {
  class Classes extends Set<string> { contains(value: string): boolean { return this.has(value); } }
  class Element {
    tagName = "DIV";
    children: Element[] = [];
    classList: Classes;
    constructor(classes: string[] = [], public messageId: string | null = null, public innerText = "PRIVATE_RENDERED_TEXT") {
      this.classList = new Classes(classes);
    }
    getAttribute(name: string) { return name === "data-message-id" ? this.messageId : null; }
    hasAttribute() { return false; }
  }
  class Article extends Element {
    body: Element;
    surface = new Element(["message-surface"]);
    bubble = new Element(["message-bubble"]);
    text = new Element(["message-text"]);
    constructor(messageId: string, owner: boolean) {
      super(owner ? ["message-row", "self"] : ["message-row"], messageId); this.tagName = "ARTICLE";
      this.body = new Element(["message-body"], messageId);
      this.body.children = [this.surface]; this.surface.children = [this.bubble]; this.bubble.children = [this.text];
    }
    querySelectorAll(selector: string) {
      return selector === ".message-body" ? [this.body] : selector === ".message-body .message-text" ? [this.text] :
        selector === ".message-surface" ? [this.surface] : selector === ".message-bubble" ? [this.bubble] :
        selector === ".message-surface *" ? [this.bubble, this.text] : [];
    }
  }
  class Control {
    isConnected = true; hidden = false; readOnly = false; disabled = false; value = "";
    constructor(public name: string) {}
    getAttribute(name: string) { return name === "aria-label" ? this.name : null; }
    hasAttribute() { return false; }
    getClientRects() { return [{}]; }
    closest() { return null; }
    matches() { return this.disabled; }
  }
  class Textarea extends Control {}
  class Button extends Control {}
  const composer = new Textarea("Message"), send = new Button("Send");
  const articles = [new Article(binding.ownerAnchorId, true), new Article(binding.dotAnchorId, false)];
  const window = { location: { href: binding.pageUrl }, HTMLTextAreaElement: Textarea, HTMLButtonElement: Button };
  const document = { defaultView: window, querySelectorAll: (selector: string): unknown[] =>
    selector === "textarea" ? [composer] : selector === "button" ? [send] : articles };
  let calls = 0;
  const controller = new DotExtensionController(document as unknown as Document, binding, 1, id, () => {},
    async () => { calls++; return observed; });
  return { document, window, articles, composer, controller, calls: () => calls };
}

test("status reports exact bounded readiness rejection without text or DOM leakage", async () => {
  const cases: [string, (h: ReturnType<typeof readinessFixture>) => void][] = [
    ["room-binding-rejected", h => { h.window.location.href = binding.pageUrl + "?other"; }],
    ["room-window-rejected", h => { h.articles.length = 0; }],
    ["room-row-rejected", h => { h.articles[0]!.tagName = "DIV"; }],
    ["owner-anchor-mismatch", h => { h.articles[0]!.classList.delete("self"); }],
    ["dot-anchor-mismatch", h => { h.articles[1]!.classList.add("self"); }],
    ["anchors-not-visible", h => { h.articles.shift(); }],
    ["controls-unqualified", h => { h.composer.readOnly = true; }],
    ["controls-unqualified", h => { h.composer.disabled = true; }],
    ["draft-present", h => { h.composer.value = "PRIVATE_DRAFT"; }],
    ["inspection-error", h => { h.document.querySelectorAll = () => { throw new Error("PRIVATE_RAW_ERROR"); }; }],
  ];
  for (const [reason, mutate] of cases) {
    const h = readinessFixture(); mutate(h);
    const draft = h.composer.value;
    const response = await h.controller.handle({ ...base, method: "status" });
    assert.deepEqual(response, { ...base, kind: "status", state: "qualifying", reason });
    assert.deepEqual(parseDotControlResponse(response), response);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE|CalpicoMessage/u);
    assert.equal((await h.controller.handle(request)).kind, "error");
    assert.equal(h.calls(), 0); assert.equal(h.composer.value, draft);
  }
});

test("qualified empty composer remains ready without a failure reason", async () => {
  const h = readinessFixture();
  assert.deepEqual(await h.controller.handle({ ...base, method: "status" }), { ...base, kind: "status", state: "ready" });
  assert.equal(h.calls(), 0);
});
