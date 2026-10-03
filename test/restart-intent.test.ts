import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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

test("committed predecessor snapshot uses SQLite backup to include WAL-only final rows", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-predecessor-snapshot-"));
  const databasePath = path.join(root, "vkodex.sqlite");
  const naivePath = path.join(root, "main-only-copy.sqlite");
  const operationId = "fixture-operation-0001";
  const backupRoot = path.join(root, "private cutover journal", operationId, "backup");
  const store = new BridgeStore(databasePath);
  const binding = store.ensureBinding({ hostId: "local", threadId: "snapshot-fixture", title: "Snapshot fixture",
    sourceId: "legacy-fixture", workspace: "D:\\fixture", updatedAt: 1 });
  const defaultBinding = store.ensureBinding({ hostId: "local", threadId: "snapshot-default-source", title: "Default source fixture",
    workspace: "D:\\fixture", updatedAt: 1 });
  const writer = new DatabaseConstructor(databasePath, { timeout: 1000 });
  let fixtureMayRecycle = true;
  try {
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec(`CREATE TABLE fixture_snapshot_opaque (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      BEGIN IMMEDIATE;
      INSERT INTO bridge_values(key, value) VALUES ('stream-generation:${binding.id}', '23');
      INSERT INTO bridge_inbox(id, state, payload, received_at, replay_after)
        VALUES ('fixture-uncertain', 'uncertain', '{"opaque":"preserve-me"}', 101, NULL);
      INSERT INTO bridge_input_batches(peer_id, batch_id, parts, started_at, updated_at, state)
        VALUES (987654, 'fixture-batch', '["one","two"]', 102, 103, 'pending');
      INSERT INTO bridge_operations(id, task_key, state) VALUES ('fixture-operation', 'legacy-fixture:snapshot', 'accepted');
      INSERT INTO bridge_managed_operation_authorities(operation_id, task_key, binding_id, authority)
        VALUES ('fixture-operation', 'legacy-fixture:snapshot', '${binding.id}', '{"opaque":"authority-preserved"}');
      INSERT INTO bridge_managed_queue_receipts(operation_id, submission_id, state, last_checked_at, terminal_turn_id)
        VALUES ('fixture-operation', 'fixture-submission', 'accepted', 104, 'fixture-turn');
      INSERT INTO fixture_snapshot_opaque(id, value) VALUES ('ack-fixture', '{"state":"accepted","opaque":"keep"}');
      COMMIT;`);

    const walPath = `${databasePath}-wal`;
    assert.ok((await stat(walPath)).size > 0, "fixture must contain committed WAL frames");
    const mainShaBefore = createHash("sha256").update(await readFile(databasePath)).digest("hex");
    const walShaBefore = createHash("sha256").update(await readFile(walPath)).digest("hex");
    await copyFile(databasePath, naivePath);
    const naive = new DatabaseConstructor(naivePath, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(naive.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'bridge_values'")
        .get() as { count: number } | undefined, { count: 0 }, "a main-file-only copy must miss even schema committed in the WAL");
    } finally { naive.close(); }

    const sourceIdentity = await stat(databasePath, { bigint: true });
    const snapshotModule = await import("../src/desktop/predecessor-final-snapshot.js");
    const capture = snapshotModule.captureCommittedPredecessorSnapshot;
    assert.equal(typeof capture, "function");
    const snapshot = await capture({
      sourceDatabasePath: databasePath,
      privateBackupRoot: backupRoot,
      expectedFileIdentity: { dev: String(sourceIdentity.dev), ino: String(sourceIdentity.ino) },
      legacySourceIds: ["legacy-fixture", ""],
      operationId,
      actionScopeSha256: "a".repeat(64),
      deadlineMs: 10_000,
    });
    assert.equal(snapshot.kind, "committed-predecessor-snapshot");
    assert.equal(snapshot.operationId, operationId);
    assert.equal(snapshot.actionScopeSha256, "a".repeat(64));
    assert.match(snapshot.backupSha256, /^[a-f0-9]{64}$/u);
    assert.equal(createHash("sha256").update(await readFile(snapshot.backupPath)).digest("hex"), snapshot.backupSha256);
    assert.deepEqual(snapshot.bindingVector, [{ bindingId: binding.id, hostId: "local", threadId: "snapshot-fixture",
      sourceId: "legacy-fixture", generation: 23 }, { bindingId: defaultBinding.id, hostId: "local",
      threadId: "snapshot-default-source", sourceId: "", generation: 0 }]
      .sort((a, b) => a.bindingId.localeCompare(b.bindingId)));
    const source = new DatabaseConstructor(databasePath, { readonly: true, fileMustExist: true });
    const backup = new DatabaseConstructor(snapshot.backupPath, { readonly: true, fileMustExist: true });
    try {
      for (const table of ["bridge_bindings", "bridge_values", "bridge_inbox", "bridge_input_batches", "bridge_operations",
        "bridge_managed_operation_authorities", "bridge_managed_queue_receipts", "fixture_snapshot_opaque"]) {
        assert.deepEqual(backup.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
          source.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), `${table} logical contents must remain unchanged`);
      }
      assert.deepEqual(backup.prepare("SELECT value FROM bridge_values WHERE key = ?")
        .get(`stream-generation:${binding.id}`), { value: "23" });
      assert.deepEqual(backup.prepare("SELECT state, payload FROM bridge_inbox WHERE id = 'fixture-uncertain'").get(),
        { state: "uncertain", payload: '{"opaque":"preserve-me"}' });
      assert.deepEqual(backup.prepare("SELECT state, terminal_turn_id FROM bridge_managed_queue_receipts WHERE operation_id = 'fixture-operation'").get(),
        { state: "accepted", terminal_turn_id: "fixture-turn" });
      assert.equal(createHash("sha256").update(await readFile(databasePath)).digest("hex"), mainShaBefore,
        "snapshot capture must not modify the source main database");
      assert.equal(createHash("sha256").update(await readFile(walPath)).digest("hex"), walShaBefore,
        "snapshot capture must not checkpoint, truncate, or modify the source WAL");
      fixtureMayRecycle = true;
    } finally { backup.close(); source.close(); }
  } finally {
    writer.close();
    store.close();
    if (fixtureMayRecycle) {
      const recycle = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_TARGET); $parent=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_PARENT).TrimEnd('\\')+'\\'; if(-not $target.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($target) -notlike 'vkodex-predecessor-snapshot-*'){throw 'Unexpected recycle target'}; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)"], {
        encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { ...process.env, VKODEX_TEST_RECYCLE_PARENT: os.tmpdir(), VKODEX_TEST_RECYCLE_TARGET: root },
      });
      assert.equal(recycle.status, 0, "fixture cleanup must move the private root to Recycle Bin");
    }
  }
});
