import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { BridgeStore } from "../src/bridge/store.js";
import { archiveRestartIntent, captureRestartIntent, captureRestartIntentFromDatabase, readRestartIntent } from "../src/desktop/restart-intent.js";

const ownerEpoch = "123e4567-e89b-42d3-a456-426614174000";

test("controlled restart snapshots only active linked tasks and archives its intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-restart-"));
  const store = new BridgeStore();
  try {
    const active = store.ensureBinding({ hostId: "local", threadId: "active", title: "Active", sourceId: "primary", workspace: "D:\\fixture", updatedAt: 1 });
    store.setChat(active.id, 10_001, 1);
    store.setValue(`task-details:${active.id}`, { status: "running" });
    store.setValue(`activity:${active.id}`, { turnId: "turn-1" });
    store.claimManagedOwner(active.id, { ownerEpoch, canonicalHome: "C:\\ManagedOwnerFixture", familyRoot: "active" });
    const idle = store.ensureBinding({ hostId: "local", threadId: "idle", title: "Idle", sourceId: "primary", workspace: "D:\\fixture", updatedAt: 1 });
    store.setChat(idle.id, 10_002, 2);
    store.setValue(`task-details:${idle.id}`, { status: "idle" });
    const intent = await captureRestartIntent(store, root, 1234, 5000);
    assert.deepEqual(intent.tasks.map(task => [task.threadId, task.activeTurnId, task.ownerEpoch]),
      [["active", "turn-1", ownerEpoch]]);
    assert.deepEqual((await readRestartIntent(root))?.id, intent.id);
    const archived = await archiveRestartIntent(root, intent);
    assert.match(archived, /restart-intent\.completed-/u);
    assert.equal(await readRestartIntent(root), null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only restart snapshot succeeds while the bridge holds a writer lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-restart-"));
  const database = path.join(root, "vkodex.sqlite");
  const store = new BridgeStore(database);
  let writer: InstanceType<typeof DatabaseConstructor> | null = null;
  try {
    const binding = store.ensureBinding({ hostId: "local", threadId: "active", title: "Active", sourceId: "primary", workspace: "D:\\fixture", updatedAt: 1 });
    store.setChat(binding.id, 10_001, 1);
    store.setValue(`task-details:${binding.id}`, { status: "running" });
    store.setValue(`activity:${binding.id}`, { turnId: "turn-1" });
    store.setValue(`stream-generation:${binding.id}`, 4);
    store.claimManagedOwner(binding.id, { ownerEpoch, canonicalHome: "C:\\ManagedOwnerFixture", familyRoot: "active" });
    writer = new DatabaseConstructor(database);
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE bridge_values SET value = ? WHERE key = ?")
      .run(JSON.stringify({ status: "idle" }), `task-details:${binding.id}`);
    // BridgeStore's schema setup is a write and cannot run under this lock.
    const competing = new DatabaseConstructor(database, { timeout: 50 });
    try { assert.throws(() => competing.exec("CREATE TABLE bridge_restart_lock_probe (id INTEGER)"), /database is locked/u); }
    finally { competing.close(); }
    const intent = await captureRestartIntentFromDatabase(database, root, 1234, 5000);
    // Uncommitted writer changes must not leak into the committed restart snapshot.
    assert.deepEqual(intent.tasks.map(task => [task.threadId, task.activeTurnId, task.generation, task.ownerEpoch]),
      [["active", "turn-1", 4, ownerEpoch]]);
    assert.deepEqual((await readRestartIntent(root))?.id, intent.id);
  } finally {
    if (writer?.inTransaction) writer.exec("ROLLBACK");
    writer?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
