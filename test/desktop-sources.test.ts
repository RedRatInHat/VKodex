import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { configuredCodexHomes } from "../src/bridge/config.js";
import { BridgeStore, migrateBindingSources } from "../src/bridge/store.js";
import { DesktopUnavailableError, taskKey, type DesktopMetadata, type DesktopTask } from "../src/desktop/contracts.js";
import { MultiDesktopCatalog } from "../src/desktop/multi-catalog.js";
import { ProfileDesktopMetadata } from "../src/desktop/metadata.js";
import { comparablePath } from "../src/desktop/paths.js";

const primary = path.resolve("fixture-primary");
const extra = path.resolve("fixture-extra");
const task: DesktopTask = { hostId: "local", threadId: "same-task-id", title: "Fixture", workspace: "/project", projectId: "same-project-id", updatedAt: 1 };
const catalog = (home: string) => ({
  listTasks: async () => [{ ...task, title: home === primary ? "Primary task" : "Extra task", rolloutPath: path.join(home, "sessions", "fixture.jsonl") }],
  listModels: async () => [{ id: home === primary ? "primary-model" : "extra-model", title: "Fixture model", efforts: ["high"], defaultEffort: "high" }],
  listProjects: async () => [{ id: "same-project-id", title: "Fixture project", workspace: "/project" }],
});

test("configured sources keep the primary, expand home paths, and deduplicate extra paths", () => {
  const homes = configuredCodexHomes({ CODEX_HOME: primary, CODEX_EXTRA_HOMES: JSON.stringify([extra, `${extra}${path.sep}`, primary, "~/fixture-codex"]) });
  assert.deepEqual(homes, [primary, extra, path.join(os.homedir(), "fixture-codex")]);
  assert.deepEqual(configuredCodexHomes({ CODEX_HOME: primary }), [primary]);
  assert.equal(configuredCodexHomes({})[0], path.join(os.homedir(), ".codex"));
});

test("invalid source configuration fails without exposing its value", () => {
  for (const value of ["PRIVATE_PATH", '"PRIVATE_PATH"', '{"path":"PRIVATE_PATH"}', '[42]', '[""]', '["a\\u0000b"]', JSON.stringify(Array(17).fill("PRIVATE_PATH"))]) {
    assert.throws(() => configuredCodexHomes({ CODEX_EXTRA_HOMES: value }), error => error instanceof Error && !error.message.includes("PRIVATE_PATH"));
  }
});

test("Windows source comparisons normalize case, separators and extended-length paths", () => {
  assert.equal(comparablePath("\\\\?\\C:\\Profiles\\Codex\\sessions\\task.jsonl"), comparablePath("c:/profiles/codex/sessions/task.jsonl"));
  assert.equal(comparablePath("\\\\?\\UNC\\server\\share\\session.jsonl"), comparablePath("\\\\server\\share\\session.jsonl"));
  assert.notEqual(comparablePath("C:/Profiles/.codex-work/task.jsonl"), comparablePath("C:/Profiles/.codex/task.jsonl"));
});

test("catalog preserves separate copies of an ID and gives extra sources stable identities", async () => {
  const combined = new MultiDesktopCatalog([primary, extra], catalog);
  const tasks = await combined.listTasks();
  assert.equal(tasks.length, 2); assert.equal(tasks[0]!.sourceId, undefined); assert.ok(tasks[1]!.sourceId);
  assert.notEqual(taskKey(tasks[0]!), taskKey(tasks[1]!));
  assert.equal(tasks[1]!.sourceLabel, path.basename(extra));
  const reordered = await new MultiDesktopCatalog([primary, path.resolve("another-home"), extra], catalog).listTasks();
  assert.equal(reordered.find(task => task.sourceLabel === path.basename(extra))!.sourceId, tasks[1]!.sourceId);
  assert.equal((await new MultiDesktopCatalog([primary, extra, extra], catalog).listTasks()).length, 2);
});

test("an unreadable extra source does not hide readable tasks and exposes a static warning", async () => {
  const combined = new MultiDesktopCatalog([primary, extra], home => ({ ...catalog(home), listTasks: async () => {
    if (home === extra) throw new Error("PRIVATE_PATH_OR_SECRET");
    return [task];
  } }));
  assert.equal((await combined.listTasks()).length, 1);
  assert.equal(combined.catalogWarnings().length, 1);
  assert.doesNotMatch(combined.catalogWarnings()[0]!, /PRIVATE_PATH_OR_SECRET/u);
  await assert.rejects(new MultiDesktopCatalog([primary], home => ({ ...catalog(home), listTasks: async () => { throw new Error("offline"); } })).listTasks(), DesktopUnavailableError);
});

test("models and project identities stay with the selected source", async () => {
  const combined = new MultiDesktopCatalog([primary, extra], catalog);
  const tasks = await combined.listTasks();
  assert.equal((await combined.listModels(tasks[0]))[0]!.id, "primary-model");
  assert.equal((await combined.listModels(tasks[1]))[0]!.id, "extra-model");
  assert.equal(combined.sourceHome(tasks[1]!), extra);
  const projects = await combined.listProjects();
  assert.notEqual(projects[0]!.id, projects[1]!.id);
  assert.equal(tasks[0]!.projectId, projects[0]!.id);
  assert.equal(tasks[1]!.projectId, projects[1]!.id);
  await assert.rejects(combined.listModels({ ...task, sourceId: "removed-source" }), DesktopUnavailableError);
});

test("metadata uses the configured source home for rename, archive and export", async () => {
  const combined = new MultiDesktopCatalog([primary, extra], catalog); const selected = (await combined.listTasks())[1]!;
  const calls: string[] = [];
  const metadata = new ProfileDesktopMetadata(ref => combined.sourceHome(ref), home => {
    calls.push(home);
    return { rename: async () => {}, archive: async () => {}, markdown: async () => "fixture" } satisfies DesktopMetadata;
  });
  await metadata.rename(selected, "New title");
  await metadata.archive(selected); await metadata.markdown(selected);
  assert.deepEqual(calls, [extra, extra, extra]);
  assert.throws(() => metadata.markdown({ ...task, sourceId: "removed-source" }), DesktopUnavailableError);
  assert.equal(calls.length, 3);
});

test("bindings and echo suppression distinguish identical task IDs in different sources", t => {
  const store = new BridgeStore(); t.after(() => store.close());
  const first = store.ensureBinding(task), second = store.ensureBinding({ ...task, sourceId: "extra", sourceLabel: "Extra" });
  store.setChat(first.id, 2_000_000_011, 11); store.setChat(second.id, 2_000_000_012, 12);
  assert.notEqual(first.id, second.id);
  assert.equal(store.byPeer(2_000_000_012)!.sourceId, "extra");
  store.recordOperation("operation", second);
  assert.equal(store.isOwnOperation("operation", second), true); assert.equal(store.isOwnOperation("operation", first), false);
  assert.equal(store.ensureBinding({ ...task, sourceId: "extra", title: "Renamed" }).id, second.id);
  assert.equal(store.getBinding(first.id)!.title, task.title);
});

test("source migration preserves existing binding IDs, delivery handles and foreign keys", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE bridge_bindings (id TEXT PRIMARY KEY, host_id TEXT, thread_id TEXT, title TEXT, peer_id INTEGER UNIQUE, chat_id INTEGER, chat_state TEXT, attached INTEGER, paused INTEGER, UNIQUE(host_id, thread_id));
    CREATE TABLE bridge_delivery (id INTEGER PRIMARY KEY, binding_id TEXT REFERENCES bridge_bindings(id), handle TEXT);
    INSERT INTO bridge_bindings VALUES ('binding', 'local', 'task', 'Title', 2000000011, 11, 'ready', 1, 0);
    INSERT INTO bridge_delivery VALUES (42, 'binding', 'original-handle');`);
  const oldDelivery = db.prepare("SELECT * FROM bridge_delivery").get();
  migrateBindingSources(db); migrateBindingSources(db);
  assert.deepEqual(db.prepare("SELECT * FROM bridge_delivery").get(), oldDelivery);
  assert.deepEqual(db.prepare("SELECT id,source_id,peer_id FROM bridge_bindings").get(), { id: "binding", source_id: "", peer_id: 2_000_000_011 });
  db.prepare("INSERT INTO bridge_bindings(id,host_id,thread_id,title,source_id) VALUES ('extra','local','task','Other','extra')").run();
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("changing primary home cannot silently reassign legacy bindings", t => {
  const store = new BridgeStore(); t.after(() => store.close());
  store.assertPrimaryHome(primary); store.assertPrimaryHome(primary);
  assert.throws(() => store.assertPrimaryHome(extra), /separate BOT_DATA_DIR/u);
});
