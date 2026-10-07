import test from "node:test";
import assert from "node:assert/strict";
import { watchDotSubmission } from "../src/dot-browser/submission-dom-observer.js";
import type { SubmissionObservation } from "../src/dot-browser/submission-observation.js";

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
  let callback: MutationCallback | undefined, timeout: (() => void) | undefined, disconnected = 0;
  const listeners = new Map<string, () => void>();
  const window = {
    location: { href: url },
    MutationObserver: class {
      constructor(fn: MutationCallback) { callback = fn; }
      observe() {}
      disconnect() { disconnected++; }
    },
    addEventListener(name: string, fn: () => void) { listeners.set(name, fn); },
    removeEventListener(name: string) { listeners.delete(name); },
    setTimeout(fn: () => void) { timeout = fn; return 1; },
    clearTimeout() { timeout = undefined; },
  };
  const articles = [new Article(id("b"), "owner anchor"), new Article(id("c"), "dot anchor", false)];
  const document = { defaultView: window, body: {}, querySelectorAll: () => articles };
  const results: SubmissionObservation[] = [];
  const watch = watchDotSubmission({ document: document as unknown as Document,
    binding: { pageUrl: url, roomId: room, ownerAnchorId: id("b"), dotAnchorId: id("c") },
    observerEpoch: "epoch-1", operationId: "operation-1", expectedText: "hello", timeoutMs: 100,
    onTerminal: result => results.push(result) });
  const emit = (records: Partial<MutationRecord>[] = []) => callback!(records as MutationRecord[], {} as MutationObserver);
  const transition = (article: Article, nextId = id("d")) => {
    const oldValue = article.messageId; article.changeId(nextId);
    emit([{ type: "attributes", target: article as unknown as Node, attributeName: "data-message-id", oldValue, removedNodes: [] as unknown as NodeList }]);
  };
  const addPending = () => { const article = new Article(pendingId, "hello"); articles.push(article); emit(); return article; };
  return { watch, articles, results, window, listeners, emit, transition, addPending,
    expire: () => timeout?.(), disconnected: () => disconnected };
}

test("DOM watch observes one same-physical-node transition and cleans up", () => {
  const h = harness(); const article = h.addPending();
  assert.equal(h.watch.state.phase, "awaiting-canonical"); h.transition(article);
  assert.deepEqual(h.results, [{ phase: "observed", messageId: id("d"), evidence: "same-node-dom-transition" }]);
  assert.equal(h.disconnected(), 1); assert.equal(h.listeners.size, 0);
  h.watch.disconnect(); h.emit(); h.expire(); assert.equal(h.results.length, 1);
});
test("matching canonical text without an observed pending snapshot is uncertain", () => {
  const h = harness(); h.articles.push(new Article(id("d"), "hello")); h.emit();
  assert.deepEqual(h.results, [{ phase: "uncertain" }]);
});
test("remounting the pending article cannot recover by matching text", () => {
  const h = harness(); h.addPending(); h.articles.pop();
  h.articles.push(new Article(id("d"), "hello")); h.emit();
  assert.equal(h.watch.state.phase, "uncertain");
});
test("removal and reinsertion of the same article is a continuity gap", () => {
  const h = harness(), article = h.addPending();
  h.emit([{ removedNodes: [article] as unknown as NodeList }]);
  assert.equal(h.watch.state.phase, "uncertain");
});
test("canonical transition needs the captured matching old attribute", () => {
  const h = harness(), article = h.addPending(); article.changeId(id("d")); h.emit();
  assert.equal(h.watch.state.phase, "uncertain");
});
test("a concurrent owner message or unrelated draft is interference", () => {
  const h = harness(); h.addPending(); h.articles.push(new Article(id("e"), "another request")); h.emit();
  assert.equal(h.watch.state.phase, "uncertain");
  const second = harness(); second.articles.push(new Article(pendingId, "wrong text")); second.emit();
  assert.equal(second.watch.state.phase, "uncertain");
});
test("an old physical article cannot be reused as a new pending request", () => {
  const h = harness(); h.articles[0]!.changeId(pendingId); h.articles[0]!.text.innerText = "hello"; h.emit();
  assert.equal(h.watch.state.phase, "uncertain");
});
test("navigation, timeout and disconnect terminate once without retry", () => {
  for (const end of [(h: ReturnType<typeof harness>) => h.listeners.get("pagehide")!(),
    (h: ReturnType<typeof harness>) => { h.window.location.href = "https://chatgpt.com/"; h.emit(); },
    (h: ReturnType<typeof harness>) => h.expire(),
    (h: ReturnType<typeof harness>) => h.watch.disconnect()]) {
    const h = harness(); h.addPending(); end(h); h.watch.disconnect();
    assert.deepEqual(h.results, [{ phase: "uncertain" }]); assert.equal(h.disconnected(), 1);
  }
});
test("dot output changes do not masquerade as owner submission", () => {
  const h = harness(); h.articles.push(new Article(id("e"), "hello", false)); h.emit();
  assert.equal(h.watch.state.phase, "awaiting-pending"); assert.equal(h.results.length, 0);
});
test("excessive mutation batches invalidate continuity", () => {
  const h = harness(); h.emit(Array.from({ length: 2001 }, () => ({})));
  assert.equal(h.watch.state.phase, "uncertain");
});
test("unknown markup and multiple ID transitions are not acceptance", () => {
  const first = harness(), a = first.addPending(); a.text.tagName = "IMG"; first.transition(a);
  assert.equal(first.watch.state.phase, "uncertain");
  const second = harness(), b = second.addPending(); b.changeId(id("d"));
  const record = { type: "attributes" as const, target: b as unknown as Node, attributeName: "data-message-id",
    oldValue: pendingId, removedNodes: [] as unknown as NodeList };
  second.emit([record, record]); assert.equal(second.watch.state.phase, "uncertain");
});
