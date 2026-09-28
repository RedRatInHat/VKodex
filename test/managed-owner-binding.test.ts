import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { BridgeStore, type ManagedOwnerBindingClaim } from "../src/bridge/store.js";

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
