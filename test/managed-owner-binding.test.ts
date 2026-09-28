import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { BridgeStore, type ManagedOwnerBindingClaim } from "../src/bridge/store.js";
import { ManagedOwnerHandoffCoordinator } from "../src/bridge/managed-owner-handoff-coordinator.js";
import type { ManagedOwnerHandoffResolution } from "../src/bridge/managed-owner-route-resolver.js";

const epoch = "123e4567-e89b-42d3-a456-426614174000";
const endpoint = "123e4567-e89b-42d3-a456-426614174001";
const home = "C:\\ManagedOwnerFixture";
const proof: ManagedOwnerBindingClaim = {
  ownerEpoch: epoch, canonicalHome: home, familyRoot: "fixture-family",
  evidence: { backendGeneration: 1, registryRevision: 3, endpointRef: endpoint,
    host: { pid: 101, birthTicks: "10" }, backend: { pid: 102, birthTicks: "11" } },
};
const task = (threadId: string, sourceId = "source-a") => ({ hostId: "local", threadId, title: threadId,
  sourceId, workspace: "C:\\workspace", updatedAt: 1 });

test("managed owner claim persists across a BridgeStore restart and is exact-task scoped", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-managed-owner-"));
  const database = path.join(directory, "bridge.sqlite");
  let store = new BridgeStore(database);
  try {
    const first = store.ensureBinding(task("thread-a"));
    const other = store.ensureBinding(task("thread-b"));
    const claim = store.claimManagedOwner(first.id, proof);
    assert.equal(claim.state, "registering");
    assert.equal(store.managedOwner(task("thread-a"))?.id, claim.id);
    assert.equal(store.managedOwner(task("thread-b")), null);
    store.close();
    store = new BridgeStore(database);
    assert.equal(store.managedOwner(task("thread-a"))?.ownerEpoch, epoch);
    assert.equal(store.managedOwner(task("thread-b"))?.bindingId, undefined);
    assert.equal(store.getBinding(other.id)?.threadId, "thread-b");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed owner claim survives source-id migration with clean foreign keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-managed-owner-legacy-"));
  const database = path.join(directory, "bridge.sqlite");
  const legacy = new Database(database);
  let store: BridgeStore | null = null;
  try {
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`CREATE TABLE bridge_bindings (
      id TEXT PRIMARY KEY, host_id TEXT, thread_id TEXT, title TEXT,
      peer_id INTEGER UNIQUE, chat_id INTEGER, chat_state TEXT, attached INTEGER, paused INTEGER,
      UNIQUE(host_id, thread_id));
      INSERT INTO bridge_bindings VALUES ('legacy-binding', 'local', 'legacy-thread', 'Legacy', NULL, NULL, 'planned', 1, 0);`);
    legacy.close();
    store = new BridgeStore(database);
    const legacyTask = task("legacy-thread", "");
    const claim = store.claimManagedOwner("legacy-binding", proof);
    assert.equal(store.managedOwner(legacyTask)?.id, claim.id);
    store.close(); store = null;
    const verified = new Database(database);
    try { assert.deepEqual(verified.pragma("foreign_key_check"), []); }
    finally { verified.close(); }
    store = new BridgeStore(database);
    assert.equal(store.managedOwner(legacyTask)?.ownerEpoch, epoch);
    assert.equal(store.getBinding("legacy-binding")?.sourceId, undefined);
  } finally {
    store?.close();
    try { legacy.close(); } catch { /* Closed after legacy setup. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed owner claim refuses a competing epoch for its exact task", () => {
  const store = new BridgeStore();
  try {
    const binding = store.ensureBinding(task("thread-a"));
    store.claimManagedOwner(binding.id, proof);
    assert.throws(() => store.claimManagedOwner(binding.id, { ...proof,
      ownerEpoch: "123e4567-e89b-42d3-a456-426614174002" }), /active managed owner/i);
    assert.throws(() => store.claimManagedOwner(binding.id, { ...proof, evidence: {
      ...proof.evidence, endpointRef: "123e4567-e89b-42d3-a456-426614174003" } }), /active managed owner/i);
  } finally { store.close(); }
});

test("endpoint loss makes an exact ready claim unavailable without releasing it", () => {
  const store = new BridgeStore();
  try {
    const binding = store.ensureBinding(task("thread-a"));
    const registering = store.claimManagedOwner(binding.id, proof);
    const ready = store.transitionManagedOwner(registering, "ready", proof.evidence);
    const unavailable = store.transitionManagedOwner(ready, "unavailable");
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.evidence.endpointRef, endpoint);
    assert.equal(store.managedOwner(task("thread-a"))?.id, unavailable.id);
  } finally { store.close(); }
});

test("managed owner handoff and retirement are revision-CAS fenced", () => {
  const store = new BridgeStore();
  try {
    const binding = store.ensureBinding(task("thread-a"));
    const registering = store.claimManagedOwner(binding.id, proof);
    const ready = store.transitionManagedOwner(registering, "ready", proof.evidence);
    assert.throws(() => store.retireManagedOwner(ready), /handoff/i);
    assert.equal(store.managedOwner(task("thread-a"))?.id, ready.id);
    const handoff = store.transitionManagedOwner(ready, "handoff_pending");
    const retired = store.retireManagedOwner(handoff);
    assert.equal(retired.state, "retired");
    assert.throws(() => store.retireManagedOwner(handoff), /stale/i);
    assert.equal(store.managedOwner(task("thread-a")), null);
  } finally { store.close(); }
});

function handoffFixture() {
  const store = new BridgeStore();
  const target = task("thread-a");
  const binding = store.ensureBinding(target);
  const registering = store.claimManagedOwner(binding.id, proof);
  const ready = store.transitionManagedOwner(registering, "ready");
  const handoffProof = { ownerEpoch: epoch, taskId: target.threadId,
    backendGeneration: 1, registryRevision: 3,
    host: proof.evidence!.host!, backend: { ...proof.evidence!.backend!, generation: 1 },
    endpointRef: endpoint, nonce: "123e4567-e89b-42d3-a456-426614174004" };
  return { store, target, ready, handoffProof };
}

test("handoff coordinator revokes worker ingress before qualifying and CAS transition", async () => {
  const f = handoffFixture();
  const calls: string[] = [];
  const resolver = { resolveHandoff: async () => ({ kind: "statically-qualified", claim: f.ready,
    revokeIngress: async () => {
      assert.equal(f.store.managedOwner(f.target)?.state, "ready");
      calls.push("revoke"); return { backendGeneration: 1, registryRevision: 3 };
    }, qualify: async () => {
      assert.deepEqual(calls, ["revoke"]);
      assert.equal(f.store.managedOwner(f.target)?.state, "ready");
      calls.push("qualify"); return f.handoffProof;
    },
  }) as unknown as ManagedOwnerHandoffResolution };
  try {
    const result = await new ManagedOwnerHandoffCoordinator(f.store, resolver).beginHandoff(f.target);
    assert.deepEqual(calls, ["revoke", "qualify"]);
    assert.equal(result.state, "handoff_pending");
    assert.equal(result.revision, f.ready.revision + 1);
    assert.equal(f.store.managedOwner(f.target)?.id, f.ready.id);
  } finally { f.store.close(); }
});

test("handoff coordinator retains the exact exclusive claim after revoke uncertainty", async () => {
  const f = handoffFixture();
  let qualified = false;
  const resolver = { resolveHandoff: async () => ({ kind: "statically-qualified", claim: f.ready,
    revokeIngress: async () => { throw new Error("control timeout"); },
    qualify: async () => { qualified = true; return f.handoffProof; },
  }) as unknown as ManagedOwnerHandoffResolution };
  try {
    await assert.rejects(new ManagedOwnerHandoffCoordinator(f.store, resolver).beginHandoff(f.target),
      /control timeout/);
    assert.equal(qualified, false);
    assert.deepEqual(f.store.managedOwner(f.target), f.ready);
  } finally { f.store.close(); }
});

test("handoff coordinator refuses mismatched proof and a concurrent claim revision", async () => {
  const f = handoffFixture();
  let stale = false;
  const resolver = { resolveHandoff: async () => ({ kind: "statically-qualified", claim: f.ready,
    revokeIngress: async () => ({ backendGeneration: 1, registryRevision: 3 }),
    qualify: async () => {
        if (stale) f.store.transitionManagedOwner(f.ready, "unavailable");
        return stale ? f.handoffProof : { ...f.handoffProof, endpointRef: "123e4567-e89b-42d3-a456-426614174005" };
    },
  }) as unknown as ManagedOwnerHandoffResolution };
  try {
    const coordinator = new ManagedOwnerHandoffCoordinator(f.store, resolver);
    await assert.rejects(coordinator.beginHandoff(f.target), /proof/i);
    assert.deepEqual(f.store.managedOwner(f.target), f.ready);
    stale = true;
    await assert.rejects(coordinator.beginHandoff(f.target), /stale|changed/i);
    assert.equal(f.store.managedOwner(f.target)?.state, "unavailable");
  } finally { f.store.close(); }
});
