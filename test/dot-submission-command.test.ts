import test from "node:test";
import assert from "node:assert/strict";
import { inspectDotSubmissionControls, runDotSubmissionCommand, type DotSubmissionStage, type DotSubmissionCommandResult } from "../src/dot-browser/submission-command.js";
const room = "a".repeat(32);
const id = (n: string) => `${room}~${room}~CalpicoMessage~Sentinel_${n.repeat(32)}`;
const url = "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const pendingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
class Classes extends Set<string> { contains(value: string): boolean { return this.has(value); } }
class ElementFixture {
  readonly classList: Classes;
  children: ElementFixture[] = [];
  tagName = "DIV";
  constructor(classes: string[] = [], public messageId: string | null = null, public innerText = "") {
    this.classList = new Classes(classes);
  }
  getAttribute(name: string): string | null { return name === "data-message-id" ? this.messageId : null; }
  hasAttribute(): boolean { return false; }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(_selector: string): ElementFixture[] { return []; }
}
class Article extends ElementFixture {
  readonly text: ElementFixture;
  readonly body: ElementFixture;
  readonly surface = new ElementFixture(["message-surface"]);
  readonly bubble = new ElementFixture(["message-bubble"]);
  constructor(messageId: string, text: string, owner = true) {
    super(owner ? ["message-row", "self"] : ["message-row"], messageId);
    this.tagName = "ARTICLE";
    this.text = new ElementFixture(["message-text"], null, text);
    this.body = new ElementFixture(["message-body"], messageId);
    this.children = [this.body]; this.body.children = [this.surface]; this.surface.children = [this.bubble]; this.bubble.children = [this.text];
  }
  changeId(value: string): void { this.messageId = value; this.body.messageId = value; }
  override querySelectorAll(selector: string): ElementFixture[] {
    if (selector === ".message-body") return [this.body];
    if (selector === ".message-body .message-text") return [this.text];
    if (selector === ".message-surface") return [this.surface];
    if (selector === ".message-bubble") return [this.bubble];
    if (selector === ".message-surface *") return [this.bubble, this.text];
    return [];
  }
}

function harness() {
  const log: string[] = [], stages: DotSubmissionStage[] = [], results: DotSubmissionCommandResult[] = [];
  const observers: { fn: MutationCallback; connected: boolean }[] = [];
  const timers = new Map<number, () => void>();
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<(event: Event) => void>>();
  let serial = 0, clicks = 0;
  let onInput = () => {}, onClick = () => {};
  const dispatch = (event: Event) => {
    for (const fn of [...documentListeners.get(event.type) ?? []]) fn(event);
  };
  class Control {
    children: unknown[] = [];
    ownerDocument: unknown;
    isConnected = true;
    hidden = false;
    disabled = false;
    readOnly = false;
    textContent = "";
    labels = null;
    constructor(public tagName: string, public name: string) {}
    getAttribute(name: string) { return name === "aria-label" ? this.name : null; }
    hasAttribute() { return false; }
    getClientRects() { return [{}]; }
    closest() { return null; }
    matches(selector: string) { return selector === ":disabled" && this.disabled; }
    contains(node: unknown) { return node === this || this.children.includes(node); }
  }
  class Textarea extends Control {
    private text = "";
    constructor() { super("TEXTAREA", "Message"); }
    get value() { return this.text; }
    set value(value: string) { log.push("setter"); this.text = value; }
    dispatchEvent(event: Event) {
      log.push("input");
      Object.defineProperty(event, "target", { value: this });
      dispatch(event); onInput(); return true;
    }
  }
  class Button extends Control {
    constructor() { super("BUTTON", "Send"); this.disabled = true; }
    click() {
      clicks++; log.push("click");
      const event = new Event("click");
      Object.defineProperty(event, "target", { value: this });
      dispatch(event); onClick();
    }
  }
  const window = {
    location: { href: url }, HTMLTextAreaElement: Textarea, HTMLButtonElement: Button, Event,
    MutationObserver: class {
      readonly record: { fn: MutationCallback; connected: boolean };
      constructor(fn: MutationCallback) { this.record = { fn, connected: false }; observers.push(this.record); }
      observe() { this.record.connected = true; log.push("observe"); }
      disconnect() { this.record.connected = false; }
    },
    setTimeout(fn: () => void) { const key = ++serial; timers.set(key, fn); return key; },
    clearTimeout(key: number) { timers.delete(key); },
    addEventListener(name: string, fn: () => void) {
      const set = windowListeners.get(name) ?? new Set(); set.add(fn); windowListeners.set(name, set);
    },
    removeEventListener(name: string, fn: () => void) { windowListeners.get(name)?.delete(fn); },
  };
  const articles = [new Article(id("b"), "owner anchor"), new Article(id("c"), "dot anchor", false)];
  const composer = new Textarea(), send = new Button();
  const composers = [composer], sends = [send];
  const document = {
    defaultView: window, body: {}, getElementById: () => null,
    querySelectorAll: (selector: string) => selector === "textarea" ? composers : selector === "button" ? sends : articles,
    addEventListener(name: string, fn: (event: Event) => void) {
      const set = documentListeners.get(name) ?? new Set(); set.add(fn); documentListeners.set(name, set);
    },
    removeEventListener(name: string, fn: (event: Event) => void) { documentListeners.get(name)?.delete(fn); },
  };
  composer.ownerDocument = document; send.ownerDocument = document;
  const emit = (records: Partial<MutationRecord>[] = []) => {
    for (const observer of [...observers]) if (observer.connected) observer.fn(records as MutationRecord[], {} as MutationObserver);
  };
  const controller = new AbortController();
  const options = {
    document: document as unknown as Document,
    binding: { pageUrl: url, roomId: room, ownerAnchorId: id("b"), dotAnchorId: id("c") },
    operationId: "operation-1", observerEpoch: "epoch-1", expectedText: "hello", signal: controller.signal,
    timeoutMs: 100, onStage: (stage: DotSubmissionStage) => { stages.push(stage); log.push(stage); },
    onTerminal: (result: DotSubmissionCommandResult) => { results.push(result); },
  };
  const pending = () => { const article = new Article(pendingId, "hello"); articles.push(article); emit(); return article; };
  const canonical = (article: Article) => {
    const oldValue = article.messageId; article.changeId(id("d"));
    emit([{ type: "attributes", target: article as unknown as Node, attributeName: "data-message-id", oldValue,
      removedNodes: [] as unknown as NodeList }]);
  };
  return { options, log, stages, results, composer, send, composers, sends, articles, window, controller, emit, pending, canonical,
    run: () => runDotSubmissionCommand(options), clicks: () => clicks,
    input: (fn: () => void) => { onInput = fn; }, click: (fn: () => void) => { onClick = fn; },
    enable: () => { send.disabled = false; emit(); },
    remount: (kind: "composer" | "send" | "both") => {
      if (kind !== "send") {
        const next = new Textarea(); next.ownerDocument = document;
        composer.isConnected = false; composers.splice(0, composers.length, next);
      }
      if (kind !== "composer") {
        const next = new Button(); next.ownerDocument = document;
        send.isConnected = false; sends.splice(0, sends.length, next);
      }
      emit();
    },
    trustedDescendantClick: () => {
      const svg = { tagName: "svg" }; send.children.push(svg);
      dispatch({ type: "click", isTrusted: true, target: svg } as unknown as Event);
    },
    navigate: () => { for (const fn of [...windowListeners.get("pagehide") ?? []]) fn(); },
    expire: () => { for (const [key, fn] of [...timers]) if (timers.has(key)) fn(); },
    clean: () => timers.size === 0 && observers.every(observer => !observer.connected) &&
      [...windowListeners.values(), ...documentListeners.values()].every(set => set.size === 0),
  };
}

test("observation precedes filling; click alone waits for same-node canonical evidence", async () => {
  const h = harness(), promise = h.run();
  assert.deepEqual(h.log, ["observe", "observe", "armed", "write-attempt", "setter", "input"]);
  h.enable();
  assert.equal(h.clicks(), 1); assert.equal(h.results.length, 0);
  h.canonical(h.pending());
  assert.deepEqual(await promise, { phase: "observed", messageId: id("d"), evidence: "same-node-dom-transition" });
  assert.deepEqual(h.stages, ["armed", "write-attempt", "write-returned", "receipt"]);
  assert.equal(h.clean(), true);
});

test("preexisting draft, wrong URL and aborted signal cannot fill or click", async () => {
  for (const kind of ["draft", "url", "abort"] as const) {
    const h = harness();
    if (kind === "draft") h.composer.value = "my draft";
    if (kind === "url") h.window.location.href = "https://chatgpt.com/";
    if (kind === "abort") h.controller.abort();
    h.log.length = 0;
    assert.deepEqual(await h.run(), { phase: "uncertain", reason: kind === "draft" ? "draft-present" : kind === "url" ? "navigation" : "aborted" });
    assert.equal(h.clicks(), 0); assert.equal(h.log.includes("setter"), false);
    assert.equal(h.composer.value, kind === "draft" ? "my draft" : "");
  }
});

test("unsupported, ambiguous, readonly and disabled composer controls are refused", async () => {
  for (const kind of ["missing", "ambiguous", "readonly", "disabled", "label"] as const) {
    const h = harness();
    if (kind === "missing") h.composers.pop();
    if (kind === "ambiguous") h.sends.push(h.send);
    if (kind === "readonly") h.composer.readOnly = true;
    if (kind === "disabled") h.composer.disabled = true;
    if (kind === "label") h.composer.name = "Other";
    assert.deepEqual(await h.run(), { phase: "uncertain", reason: "unqualified-controls" });
    assert.equal(h.clicks(), 0); assert.equal(h.composer.value, "");
  }
});

test("repeated mutations and duplicate/concurrent operations never click twice", async () => {
  const h = harness(), promise = h.run();
  assert.deepEqual(await h.run(), { phase: "uncertain", reason: "operation-conflict" });
  assert.deepEqual(await runDotSubmissionCommand({ ...h.options, operationId: "operation-2" }), { phase: "uncertain", reason: "operation-conflict" });
  h.enable(); h.emit(); h.emit(); await Promise.resolve();
  assert.equal(h.clicks(), 1);
  h.canonical(h.pending()); await promise;
  assert.deepEqual(await h.run(), { phase: "uncertain", reason: "operation-conflict" });
  assert.equal(h.clicks(), 1);
});

test("text, control identity, navigation or abort before click stops without clearing draft", async () => {
  for (const kind of ["text", "identity", "navigation", "abort"] as const) {
    const h = harness();
    h.input(() => {
      if (kind === "text") h.composer.value = "owner edit";
      if (kind === "identity") h.composers.pop();
      if (kind === "navigation") h.window.location.href = "https://chatgpt.com/";
      if (kind === "abort") h.controller.abort();
    });
    const promise = h.run(); await Promise.resolve();
    const result = await promise;
    assert.equal(result.phase, "uncertain"); assert.equal(h.clicks(), 0);
    assert.equal(h.composer.value, kind === "text" ? "owner edit" : "hello");
    assert.equal(h.clean(), true);
  }
});

test("transport abort or navigation after click remains uncertain, with no retry", async () => {
  for (const kind of ["abort", "navigation"] as const) {
    const h = harness(), promise = h.run(); h.enable();
    if (kind === "abort") h.controller.abort(); else h.navigate();
    assert.deepEqual(await promise, { phase: "uncertain", reason: kind === "abort" ? "aborted" : "navigation" });
    h.canonical(h.pending()); h.emit(); h.expire();
    assert.equal(h.clicks(), 1); assert.equal(h.results.length, 1); assert.equal(h.clean(), true);
  }
});

test("canonical-only and foreign owner observations are never accepted", async () => {
  for (const kind of ["canonical", "foreign"] as const) {
    const h = harness(), promise = h.run(); h.enable();
    h.articles.push(new Article(kind === "canonical" ? id("d") : pendingId, kind === "canonical" ? "hello" : "other message"));
    h.emit();
    assert.deepEqual(await promise, { phase: "uncertain", reason: kind === "canonical" ? "gap" : "interference" });
    assert.equal(h.clicks(), 1); assert.equal(h.clean(), true);
  }
});

test("bounded waiting for Send enablement times out without clicking or clearing", async () => {
  const h = harness(), promise = h.run(); h.expire();
  assert.deepEqual(await promise, { phase: "uncertain", reason: "timeout" });
  h.enable(); await Promise.resolve();
  assert.equal(h.clicks(), 0); assert.equal(h.composer.value, "hello"); assert.equal(h.clean(), true);
});

test("ARIA labelledby takes priority and explicit role overrides are unqualified", async () => {
  const labelled = harness();
  labelled.send.getAttribute = name => name === "aria-labelledby" ? "missing-label" : name === "aria-label" ? "Send" : null;
  assert.deepEqual(await labelled.run(), { phase: "uncertain", reason: "unqualified-controls" });
  const role = harness(); role.send.hasAttribute = () => true;
  assert.deepEqual(await role.run(), { phase: "uncertain", reason: "unqualified-controls" });
  assert.equal(labelled.clicks() + role.clicks(), 0);
});

test("synchronous receipt during click emits write-returned before receipt without popup coordination", async () => {
  const h = harness(); h.click(() => h.canonical(h.pending())); h.input(() => h.enable());
  assert.equal((await h.run()).phase, "observed");
  assert.deepEqual(h.stages, ["armed", "write-attempt", "write-returned", "receipt"]);
  assert.equal(h.clicks(), 1); assert.equal(h.results.length, 1); assert.equal(h.clean(), true);
});

test("unqualified anchors refuse before fill; owner input while waiting preserves the edit", async () => {
  const wrong = harness(); wrong.articles[1]!.changeId(id("e"));
  assert.deepEqual(await wrong.run(), { phase: "uncertain", reason: "gap" });
  assert.equal(wrong.composer.value, ""); assert.equal(wrong.clicks(), 0);
  const edited = harness(), promise = edited.run();
  edited.composer.value = "owner draft";
  edited.composer.dispatchEvent(new Event("input", { bubbles: true }));
  assert.deepEqual(await promise, { phase: "uncertain", reason: "interference" });
  edited.enable(); assert.equal(edited.clicks(), 0); assert.equal(edited.composer.value, "owner draft");
});

test("click exception remains uncertain and throwing diagnostic hooks cannot trigger retry", async () => {
  const h = harness(); h.click(() => { throw new Error("transport lost"); });
  const promise = runDotSubmissionCommand({ ...h.options,
    onStage: () => { throw new Error("diagnostic failed"); },
    onTerminal: () => { throw new Error("diagnostic failed"); } });
  h.enable();
  assert.deepEqual(await promise, { phase: "uncertain", reason: "disconnect" });
  h.emit(); assert.equal(h.clicks(), 1); assert.equal(h.clean(), true);
});

test("after one click, remounted composer/Send or Stop label cannot cancel canonical receipt", async () => {
  for (const kind of ["composer", "send", "both", "label"] as const) {
    const h = harness(), promise = h.run(); h.enable();
    assert.equal(h.clicks(), 1);
    if (kind === "label") { h.send.name = "Stop"; h.emit(); } else h.remount(kind);
    assert.equal(h.results.length, 0);
    h.canonical(h.pending());
    assert.deepEqual(await promise, { phase: "observed", messageId: id("d"), evidence: "same-node-dom-transition" });
    assert.equal(h.clicks(), 1); assert.equal(h.clean(), true);
  }
});

test("after click and control remount, abort and both forms of navigation remain uncertain", async () => {
  for (const kind of ["abort", "event", "url"] as const) {
    const h = harness(), promise = h.run(); h.enable(); h.remount("both");
    assert.equal(h.results.length, 0);
    if (kind === "abort") h.controller.abort();
    else if (kind === "event") h.navigate();
    else { h.window.location.href = "https://chatgpt.com/"; h.emit(); }
    assert.deepEqual(await promise, { phase: "uncertain", reason: kind === "abort" ? "aborted" : "navigation" });
    h.canonical(h.pending()); h.emit(); h.expire();
    assert.equal(h.clicks(), 1); assert.equal(h.results.length, 1); assert.equal(h.clean(), true);
  }
});

test("trusted click on SVG inside Send stops before automatic click with no retry", async () => {
  const h = harness(), promise = h.run(); h.trustedDescendantClick();
  assert.deepEqual(await promise, { phase: "uncertain", reason: "interference" });
  h.enable(); h.emit(); await Promise.resolve();
  assert.equal(h.clicks(), 0); assert.equal(h.composer.value, "hello");
  assert.equal(h.results.length, 1); assert.equal(h.clean(), true);
});

test("read-only control inspection reports draft presence without modifying or exposing it", () => {
  const h = harness();
  assert.deepEqual(inspectDotSubmissionControls(h.options.document), { qualified: true, draftPresent: false });
  for (const draft of ["owner draft", " "]) {
    h.composer.value = draft; h.log.length = 0;
    assert.deepEqual(inspectDotSubmissionControls(h.options.document), { qualified: true, draftPresent: true });
    assert.equal(h.composer.value, draft); assert.deepEqual(h.log, []);
  }
  assert.equal(h.clicks(), 0); assert.equal(h.clean(), true);
});

test("read-only inspection refuses unknown controls or exceptions without draft data", () => {
  const unknown = harness(); unknown.composer.name = "Other"; unknown.composer.value = "private draft";
  unknown.log.length = 0;
  assert.deepEqual(inspectDotSubmissionControls(unknown.options.document), { qualified: false, draftPresent: null });
  assert.equal(unknown.composer.value, "private draft"); assert.deepEqual(unknown.log, []);
  const broken = harness(); broken.send.getClientRects = () => { throw new Error("unsupported DOM"); };
  assert.deepEqual(inspectDotSubmissionControls(broken.options.document), { qualified: false, draftPresent: null });
  assert.equal(unknown.clicks() + broken.clicks(), 0);
});
