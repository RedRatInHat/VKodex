import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { BridgeStore } from "../src/bridge/store.js";
import { archiveRestartIntent, captureRestartIntent, captureRestartIntentFromDatabase, parseRestartIntent, parseRestartRecoveryPolicy, readRestartIntent } from "../src/desktop/restart-intent.js";

const ownerEpoch = "123e4567-e89b-42d3-a456-426614174000";

test("restart reconciliation policy is versioned and cannot silently downgrade to replay", () => {
  const metadata = { id: "fixture-intent", createdAt: 5000, sourcePid: 1234, tasks: [] };
  assert.deepEqual(parseRestartIntent({ ...metadata, version: 2, recoveryPolicy: "reconcile-only" }),
    { ...metadata, version: 2, recoveryPolicy: "reconcile-only" });
  for (const value of [
    { ...metadata, version: 1, recoveryPolicy: "reconcile-only" },
    { ...metadata, version: 1, recoveryPolicy: "resume-interrupted" },
    { ...metadata, version: 1, policy: "reconcile-only" },
    { ...metadata, version: 1, recoveryMode: "reconcile-only" },
    { ...metadata, version: 2 },
    { ...metadata, version: 2, recoveryPolicy: "resume-interrupted" },
    { ...metadata, version: 2, recoveryPolicy: "unknown" },
  ]) assert.throws(() => parseRestartIntent(value), /Invalid restart intent/u);
});

test("restart policy arguments cannot fall back to continuation after a typo", () => {
  assert.equal(parseRestartRecoveryPolicy([]), "resume-interrupted");
  assert.equal(parseRestartRecoveryPolicy(["--recovery-policy", "resume-interrupted"]), "resume-interrupted");
  assert.equal(parseRestartRecoveryPolicy(["--recovery-policy", "reconcile-only"]), "reconcile-only");
  for (const args of [["reconcile-only"], ["--recovery-policy"], ["--recovery-policy", "unknown"],
    ["--recovery-policy", "Reconcile-Only"], ["--recovery-mode", "reconcile-only"],
    ["--recovery-policy", "reconcile-only", "--recovery-policy", "resume-interrupted"]]) {
    assert.throws(() => parseRestartRecoveryPolicy(args), /Invalid restart recovery policy arguments/u);
  }
});

test("controlled restart snapshots only active linked tasks and archives its intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-restart-"));
  const database = path.join(root, "vkodex.sqlite");
  const store = new BridgeStore(database);
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
    // An independent helper must honor the same journal lock. A Promise race
    // in this process alone cannot establish the cross-process guarantee.
    const journalLock = new DatabaseConstructor(path.join(root, "restart-intent-lock.sqlite"));
    try {
      journalLock.exec("BEGIN IMMEDIATE");
      const moduleUrl = new URL("../src/desktop/restart-intent.ts", import.meta.url).href;
      const helper = `import { captureRestartIntentFromDatabase } from ${JSON.stringify(moduleUrl)};
        try {
          await captureRestartIntentFromDatabase(process.argv[1], process.argv[2], process.pid, 5001, "reconcile-only");
          process.stdout.write(JSON.stringify({ outcome: "published" }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ outcome: "blocked", code: error?.code ?? null }));
        }`;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", helper, database, root],
        { encoding: "utf8", timeout: 30_000, windowsHide: true });
      assert.equal(child.status, 0);
      assert.deepEqual(JSON.parse(child.stdout) as unknown, { outcome: "blocked", code: "SQLITE_BUSY" });
      assert.deepEqual(await readRestartIntent(root), intent);
    } finally {
      if (journalLock.inTransaction) journalLock.exec("ROLLBACK");
      journalLock.close();
    }
    await assert.rejects(captureRestartIntent(store, root, 1234, 5001, "reconcile-only"), /unconsumed restart intent/u);
    assert.deepEqual(await readRestartIntent(root), intent);
    const archived = await archiveRestartIntent(root, intent);
    assert.match(archived, /restart-intent\.completed-/u);
    assert.equal(await readRestartIntent(root), null);
    const contenders = await Promise.allSettled([
      captureRestartIntent(store, root, 1234, 5002, "reconcile-only"),
      captureRestartIntent(store, root, 1234, 5003, "reconcile-only"),
    ]);
    assert.equal(contenders.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(contenders.filter(result => result.status === "rejected").length, 1);
    const reconciled = await readRestartIntent(root);
    assert.equal(reconciled?.version, 2);
    assert.ok(reconciled);
    await assert.rejects(archiveRestartIntent(root, intent), /intent changed/u);
    assert.deepEqual(await readRestartIntent(root), reconciled);
    await archiveRestartIntent(root, reconciled);
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
