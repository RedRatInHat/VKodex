import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeStore } from "../src/bridge/store.js";
import { archiveRestartIntent, captureRestartIntent, readRestartIntent } from "../src/desktop/restart-intent.js";

test("controlled restart snapshots only active linked tasks and archives its intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-restart-"));
  const store = new BridgeStore();
  try {
    const active = store.ensureBinding({ hostId: "local", threadId: "active", title: "Active", sourceId: "primary", workspace: "D:\\fixture", updatedAt: 1 });
    store.setChat(active.id, 10_001, 1);
    store.setValue(`task-details:${active.id}`, { status: "running" });
    store.setValue(`activity:${active.id}`, { turnId: "turn-1" });
    const idle = store.ensureBinding({ hostId: "local", threadId: "idle", title: "Idle", sourceId: "primary", workspace: "D:\\fixture", updatedAt: 1 });
    store.setChat(idle.id, 10_002, 2);
    store.setValue(`task-details:${idle.id}`, { status: "idle" });
    const intent = await captureRestartIntent(store, root, 1234, 5000);
    assert.deepEqual(intent.tasks.map(task => [task.threadId, task.activeTurnId]), [["active", "turn-1"]]);
    assert.deepEqual((await readRestartIntent(root))?.id, intent.id);
    const archived = await archiveRestartIntent(root, intent);
    assert.match(archived, /restart-intent\.completed-/u);
    assert.equal(await readRestartIntent(root), null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
