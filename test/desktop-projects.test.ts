import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { type DesktopTask, DesktopUnavailableError } from "../src/desktop/contracts.js";
import { LocalDesktopCatalog, readTaskCatalog } from "../src/desktop/catalog.js";
import { assignTaskProjects, desktopProjects, preflightLegacyProjectAssignment, readDesktopProjectState } from "../src/desktop/projects.js";
import { MultiDesktopCatalog } from "../src/desktop/multi-catalog.js";

const task: DesktopTask = { hostId: "local", threadId: "fixture", title: "Fixture task", workspace: "D:/Fixture/First", updatedAt: 1 };
const state = {
  "local-projects": {
    first: { id: "first", name: "First", rootPaths: ["D:/Fixture/First", "D:/Fixture/Shared"] },
    second: { id: "second", name: "Second", rootPaths: ["D:/Fixture/Second"] },
  },
};

test("partial project migration rejects changed legacy membership without writing sidebar state", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-mirror-"));
  const database = new Database(path.join(home, "state_5.sqlite")); t.after(() => database.close());
  database.exec(`CREATE TABLE project_idempotency_keys (key TEXT, project_id TEXT, created_at_ms INTEGER);
    INSERT INTO project_idempotency_keys VALUES ('legacy-project', 'native-project', 1);`);
  const migration = { [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: false } };
  const file = path.join(home, ".codex-global-state.json");
  await writeFile(file, JSON.stringify({ "app-server-projects-migration-by-host": migration,
    "thread-project-assignments": { untouched: { projectKind: "local", projectId: "other" } },
    "projectless-thread-ids": ["fixture", "another"] }));
  const original = await readFile(file, "utf8");
  await assert.rejects(preflightLegacyProjectAssignment(home, "fixture", "native-project"), { name: "ActionRejectedError" });
  await preflightLegacyProjectAssignment(home, "fixture", null);
  assert.equal(await readFile(file, "utf8"), original);
});

test("fully migrated project state permits native assignment without rewriting legacy state", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-native-"));
  const database = new Database(path.join(home, "state_5.sqlite")); t.after(() => database.close());
  database.exec("CREATE TABLE projects (id TEXT); CREATE TABLE project_roots (project_id TEXT, path TEXT)");
  const file = path.join(home, ".codex-global-state.json");
  const original = JSON.stringify({ "app-server-projects-migration-by-host": {
    [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: true },
  } });
  await writeFile(file, original);
  await preflightLegacyProjectAssignment(home, "fixture", "native-project");
  assert.equal(await readFile(file, "utf8"), original);
});

test("a new native thread does not require a legacy assignment during partial migration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-native-thread-"));
  const migration = { [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: false } };
  const file = path.join(home, ".codex-global-state.json");
  const original = JSON.stringify({ "app-server-projects-migration-by-host": migration,
    "thread-project-assignments": { untouched: { projectKind: "local", projectId: "other" } },
    "projectless-thread-ids": ["another"] });
  await writeFile(file, original);
  await preflightLegacyProjectAssignment(home, "new-native-thread", "native-project");
  assert.equal(await readFile(file, "utf8"), original);
  await preflightLegacyProjectAssignment(home, "new-native-thread", null);
  assert.equal(await readFile(file, "utf8"), original);
});

test("an already matching legacy assignment can pass preflight without a file write", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-matching-"));
  const migration = { [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: false } };
  const file = path.join(home, ".codex-global-state.json");
  const original = JSON.stringify({ "app-server-projects-migration-by-host": migration,
    "thread-project-assignments": { fixture: { projectKind: "local", projectId: "native-project" } },
    "projectless-thread-ids": [] });
  await writeFile(file, original);
  await preflightLegacyProjectAssignment(home, "fixture", "native-project");
  assert.equal(await readFile(file, "utf8"), original);
});

test("a matching ChatGPT-origin assignment is not treated as a local project match", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-cloud-origin-"));
  const file = path.join(home, ".codex-global-state.json");
  const original = JSON.stringify({
    "app-server-projects-migration-by-host": { [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: false } },
    "thread-project-assignments": { fixture: { projectKind: "local", projectOrigin: "chatgpt", projectId: "native-project" } },
    "projectless-thread-ids": [],
  });
  await writeFile(file, original);
  await assert.rejects(preflightLegacyProjectAssignment(home, "fixture", "native-project"), { name: "ActionRejectedError" });
  assert.equal(await readFile(file, "utf8"), original);
});

test("legacy overrides without a completed assignment migration cannot silently pass", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-legacy-"));
  const file = path.join(home, ".codex-global-state.json");
  const original = JSON.stringify({ "thread-project-assignments": { fixture: { projectKind: "local", projectId: "old" } } });
  await writeFile(file, original);
  await assert.rejects(preflightLegacyProjectAssignment(home, "fixture", "new"), { name: "ActionRejectedError" });
  await preflightLegacyProjectAssignment(home, "new-native-thread", "new");
  assert.equal(await readFile(file, "utf8"), original);
});

test("assignment migration flag alone does not authorize a conflicting old override", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-incomplete-"));
  const file = path.join(home, ".codex-global-state.json");
  const original = JSON.stringify({
    "app-server-projects-migration-by-host": { [`local:${home}`]: { projectsMigrated: false, threadAssignmentsMigrated: true } },
    "thread-project-assignments": { fixture: { projectKind: "local", projectId: "old" } },
  });
  await writeFile(file, original);
  await assert.rejects(preflightLegacyProjectAssignment(home, "fixture", "new"), { name: "ActionRejectedError" });
  assert.equal(await readFile(file, "utf8"), original);
});

test("full migration flags without native project tables cannot bypass an old override", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-missing-db-"));
  const file = path.join(home, ".codex-global-state.json");
  const original = JSON.stringify({
    "app-server-projects-migration-by-host": { [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: true } },
    "thread-project-assignments": { fixture: { projectKind: "local", projectId: "old" } },
  });
  await writeFile(file, original);
  await assert.rejects(preflightLegacyProjectAssignment(home, "fixture", "new"), { name: "ActionRejectedError" });
  assert.equal(await readFile(file, "utf8"), original);
});

test("unreadable legacy state fails closed while a native-only profile remains supported", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-project-state-"));
  await preflightLegacyProjectAssignment(home, "fixture", "native-project");
  const file = path.join(home, ".codex-global-state.json");
  await writeFile(file, "not-json");
  await assert.rejects(preflightLegacyProjectAssignment(home, "fixture", "native-project"), DesktopUnavailableError);
  assert.equal(await readFile(file, "utf8"), "not-json");
});

test("imported native projects replace stale IDs while assignment migration controls sidebar membership", async t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE projects (id TEXT, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER);
    CREATE TABLE project_idempotency_keys (key TEXT, project_id TEXT);
    INSERT INTO projects VALUES ('native-first', 'First renamed', 0), ('native-second', 'Second', 1);
    INSERT INTO project_roots VALUES ('native-first', 'D:/Fixture/First', 0), ('native-second', 'D:/Fixture/Second', 0);
    INSERT INTO project_idempotency_keys VALUES ('first', 'native-first'), ('second', 'native-second');`);
  const legacy = { ...state, "thread-project-assignments": { fixture: { projectKind: "local", projectId: "first" } } };
  const next = readDesktopProjectState(db, legacy, "D:/Fixture/Home")!;
  assert.equal(desktopProjects(next)[0]!.id, "native-first");
  assert.equal(desktopProjects(next)[0]!.title, "First renamed");
  assert.equal(assignTaskProjects([task], next)[0]!.projectId, "native-first");
  assert.equal(assignTaskProjects([{ ...task, projectId: "native-second" }], next)[0]!.projectId, "native-second");
  const migration = (complete: boolean) => ({ "local:D:/Fixture/Home": { projectsMigrated: true, threadAssignmentsMigrated: complete } });
  const partial = readDesktopProjectState(db, { ...legacy, "app-server-projects-migration-by-host": migration(false) }, "D:/Fixture/Home")!;
  assert.equal(assignTaskProjects([{ ...task, projectId: "native-second" }], partial)[0]!.projectId, "native-first");
  const copied = { ...task, threadId: "new-copy", workspace: "D:/Outside", projectId: "native-second" };
  assert.equal(assignTaskProjects([copied], partial)[0]!.projectId, "native-second");
  assert.equal(assignTaskProjects([{ ...copied, workspace: task.workspace }], { ...partial, "projectless-thread-ids": [copied.threadId] })[0]!.projectId, null);
  const migrated = readDesktopProjectState(db, { ...legacy, "app-server-projects-migration-by-host": migration(true) }, "D:/Fixture/Home")!;
  assert.equal(assignTaskProjects([{ ...task, projectId: "native-second" }], migrated)[0]!.projectId, "native-second");
  assert.equal(assignTaskProjects([{ ...task, projectId: null }], migrated)[0]!.projectId, null);
  const combined = new MultiDesktopCatalog(["D:/Fixture/Home", "D:/Fixture/Extra"], () => ({
    listTasks: async () => assignTaskProjects([task], next), listModels: async () => [], listProjects: async () => desktopProjects(next),
  }));
  const primary = await combined.resolveProject("first");
  assert.equal(primary.rawProjectId, "native-first"); assert.equal(primary.project.id, "native-first");
  const sourceId = combined.listSources()[1]!.id;
  const extra = await combined.resolveProject(JSON.stringify([sourceId, "first"]));
  assert.equal(extra.rawProjectId, "native-first"); assert.equal(extra.sourceId, sourceId);
  assert.equal(extra.project.id, JSON.stringify([sourceId, "native-first"]));
  assert.equal(legacy["thread-project-assignments"].fixture.projectId, "first");
});

test("empty native tables keep legacy projects only before Codex finishes migrating them", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE projects (id TEXT, name TEXT, position INTEGER); CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER)");
  assert.deepEqual(readDesktopProjectState(db, state, "D:/Fixture/Home"), state);
  const native = readDesktopProjectState(db, { ...state,
    "app-server-projects-migration-by-host": { "local:D:/Fixture/Home": { projectsMigrated: true, threadAssignmentsMigrated: true } },
  }, "D:/Fixture/Home")!;
  assert.deepEqual(desktopProjects(native), []);
  assert.equal(assignTaskProjects([{ ...task, projectId: null }], native)[0]!.projectId, null);
});

test("unreadable legacy state keeps native project names but not unverified thread membership", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE projects (id TEXT, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER);
    INSERT INTO projects VALUES ('native-project', 'Native', 0);
    INSERT INTO project_roots VALUES ('native-project', 'D:/Fixture/First', 0);`);
  const unknown = readDesktopProjectState(db, null, "D:/Fixture/Home")!;
  assert.equal(desktopProjects(unknown)[0]!.id, "native-project");
  assert.equal(assignTaskProjects([{ ...task, projectId: "native-project" }], unknown)[0]!.projectId, undefined);
  assert.equal(assignTaskProjects([{ ...task, projectId: null }], unknown)[0]!.projectId, undefined);
});

test("no-live-legacy catalog mode never imports live sidebar assignments", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vkodex-no-live-catalog-"));
  t.after(() => {
    if (process.platform !== "win32") return;
    const script = "$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:VKODEX_TEST_RECYCLE_TARGET); $root=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\\')+'\\'; if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected recycle target'}; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)";
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script],
      { env: { ...process.env, VKODEX_TEST_RECYCLE_TARGET: home }, encoding: "utf8" });
    assert.equal(result.status, 0, "Windows test fixture must be moved to Recycle Bin");
  });
  const db = new Database(path.join(home, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, thread_source TEXT, source TEXT,
      archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER, is_pinned INTEGER, recency_at_ms INTEGER, project_id TEXT);
    CREATE TABLE projects (id TEXT, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER);
    INSERT INTO threads VALUES ('fixture', 'Fixture', 'Fixture', 'D:/Fixture/First', 'user', 'cli', 0, 1000, 1, 0, 1000, 'native-second');
    INSERT INTO projects VALUES ('native-first', 'First', 0), ('native-second', 'Second', 1);
    INSERT INTO project_roots VALUES ('native-first', 'D:/Fixture/First', 0), ('native-second', 'D:/Fixture/Second', 0);`);
  db.close();
  const stateFile = path.join(home, ".codex-global-state.json");
  await writeFile(stateFile, JSON.stringify({
    "app-server-projects-migration-by-host": { [`local:${home}`]: { projectsMigrated: true, threadAssignmentsMigrated: false } },
    "thread-project-assignments": { fixture: { projectKind: "local", projectId: "native-first" } },
  }));
  const live = new LocalDesktopCatalog(home, "legacy-file");
  assert.equal((await live.listTasks())[0]!.projectId, "native-first");
  const snapshot = await live.listSnapshot();
  assert.equal(snapshot.tasks.status, "fulfilled");
  assert.equal(snapshot.projects.status, "fulfilled");
  if (snapshot.tasks.status === "fulfilled" && snapshot.projects.status === "fulfilled") {
    assert.equal(snapshot.tasks.value[0]!.projectId, snapshot.projects.value[0]!.id);
  }
  await writeFile(stateFile, "not-json");
  const unreadable = await live.listSnapshot();
  assert.equal(unreadable.tasks.status, "fulfilled");
  assert.equal(unreadable.projects.status, "fulfilled");
  if (unreadable.tasks.status === "fulfilled" && unreadable.projects.status === "fulfilled") {
    assert.equal(unreadable.tasks.value[0]!.projectId, undefined);
    assert.deepEqual(unreadable.projects.value.map(project => project.id), ["native-first", "native-second"]);
  }
  const detached = new LocalDesktopCatalog(home, "no-live-legacy");
  assert.equal((await detached.listTasks())[0]!.projectId, undefined);
  assert.deepEqual((await detached.listProjects()).map(project => project.id), ["native-first", "native-second"]);
  assert.equal((await new LocalDesktopCatalog(home).listTasks())[0]!.projectId, undefined);
  const combined = new MultiDesktopCatalog([home], () => detached);
  await combined.listTasks();
  assert.match(combined.catalogWarnings()[0]!, /назначения проектов задач неизвестны/u);
});

test("multi-source refresh uses one source snapshot for tasks and projects", async () => {
  let splitReads = 0; let snapshotReads = 0;
  const source = {
    listTasks: async () => { splitReads++; throw new Error("split task read"); },
    listProjects: async () => { splitReads++; throw new Error("split project read"); },
    listModels: async () => [],
    listSnapshot: async () => {
      snapshotReads++;
      return {
        tasks: { status: "fulfilled", value: [{ ...task, projectId: "first" }] },
        projects: { status: "fulfilled", value: desktopProjects(state) },
      };
    },
  } as unknown as LocalDesktopCatalog;
  const combined = new MultiDesktopCatalog(["D:/Fixture/Home"], () => source);
  const tasks = await combined.listTasks();
  assert.equal(tasks[0]!.projectId, "first");
  assert.equal(snapshotReads, 1);
  assert.equal(splitReads, 0);
});

test("desktop project catalog preserves all roots and includes projects without folders", () => {
  assert.deepEqual(desktopProjects(state)[0], { id: "first", title: "First", workspace: "D:/Fixture/First", workspaceRoots: ["D:/Fixture/First", "D:/Fixture/Shared"] });
  assert.equal(desktopProjects({ "local-projects": [{ id: "empty", name: "Empty", rootPaths: [] }] })[0]!.workspace, "");
  assert.deepEqual(desktopProjects({}), []);
  assert.throws(() => desktopProjects({ "local-projects": "invalid" }), DesktopUnavailableError);
});

test("explicit desktop assignments win over working directory and legacy projectless entries", () => {
  const assigned = assignTaskProjects([task], { ...state, "thread-project-assignments": { fixture: { projectKind: "local", projectId: "second" } }, "projectless-thread-ids": ["fixture"] });
  assert.equal(assigned[0]!.projectId, "second");
  assert.equal(assigned[0]!.workspace, task.workspace);
  assert.equal(task.projectId, undefined);
  assert.equal(assignTaskProjects([{ ...task, projectId: "native-project" }], { ...state, "projectless-thread-ids": ["fixture"] })[0]!.projectId, null);
});

test("unassigned task inference checks every project root, nested folders and path boundaries", () => {
  const result = assignTaskProjects([
    { ...task, threadId: "nested", workspace: "d:\\fixture\\shared\\src" },
    { ...task, threadId: "sibling", workspace: "D:/Fixture/First-other" },
    { ...task, threadId: "worktree", workspace: "D:/Worktrees/Unrelated" },
  ], { ...state, "thread-workspace-root-hints": { worktree: "D:/Fixture/Second" } });
  assert.deepEqual(result.map(task => task.projectId), ["first", null, "second"]);
});

test("ambiguous roots and unreadable membership are not mislabeled as projectless", () => {
  const shared = { "local-projects": { ...state["local-projects"], duplicate: { id: "duplicate", name: "Duplicate", rootPaths: [task.workspace] } } };
  assert.equal(assignTaskProjects([task], shared)[0]!.projectId, undefined);
  assert.equal(assignTaskProjects([{ ...task, projectId: "first" }], null)[0]!.projectId, undefined);
  assert.equal(assignTaskProjects([task], { ...state, "thread-project-assignments": "unreadable" })[0]!.projectId, undefined);
  assert.equal(assignTaskProjects([task], { ...state, "thread-project-assignments": { fixture: { projectKind: "remote", projectId: "first" } } })[0]!.projectId, undefined);
  assert.equal(assignTaskProjects([task], { ...state, "thread-project-assignments": { fixture: { projectKind: "local", projectOrigin: "chatgpt", projectId: "first" } } })[0]!.projectId, undefined);
});

test("the most specific unique root wins when no explicit assignment exists", () => {
  const projects = { "local-projects": { ...state["local-projects"], nested: { id: "nested", name: "Nested", rootPaths: ["D:/Fixture/First/Nested"] } } };
  assert.equal(assignTaskProjects([{ ...task, workspace: "D:/Fixture/First/Nested/src" }], projects)[0]!.projectId, "nested");
});

test("a CLI-only source inherits an unambiguous shared desktop project by workspace", async () => {
  const combined = new MultiDesktopCatalog(["D:/Fixture/Home", "D:/Fixture/OtherHome"], home => ({
    listModels: async () => [],
    listTasks: async () => assignTaskProjects([task], home.endsWith("OtherHome") ? {} : state),
    listProjects: async () => desktopProjects(home.endsWith("OtherHome") ? {} : state),
  }));
  const tasks = await combined.listTasks();
  assert.equal(tasks[0]!.projectId, "first");
  assert.equal(tasks[1]!.projectId, "first");
  assert.notEqual(tasks[0]!.sourceId, tasks[1]!.sourceId);
  assert.equal((await combined.listProjects())[0]!.title, "First");

  const unmatched = new MultiDesktopCatalog(["D:/Fixture/Home", "D:/Fixture/OtherHome"], home => ({
    listModels: async () => [],
    listTasks: async () => assignTaskProjects([{ ...task, workspace: home.endsWith("OtherHome") ? "D:/Outside" : task.workspace }], home.endsWith("OtherHome") ? {} : state),
    listProjects: async () => desktopProjects(home.endsWith("OtherHome") ? {} : state),
  }));
  assert.equal((await unmatched.listTasks()).find(item => item.sourceId)!.projectId, null);
});

test("stored project IDs are read without modifying the Codex database", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, thread_source TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER, is_pinned INTEGER, recency_at_ms INTEGER, project_id TEXT)");
  db.prepare("INSERT INTO threads VALUES ('fixture','Fixture','Fixture','D:/Fixture','user','cli',0,1000,1,0,1000,'native-project')").run();
  const before = db.prepare("SELECT * FROM threads").all();
  const tasks = readTaskCatalog(db);
  assert.equal(tasks[0]!.projectId, "native-project");
  assert.equal(assignTaskProjects(tasks, {})[0]!.projectId, "native-project");
  assert.deepEqual(db.prepare("SELECT * FROM threads").all(), before);
});

test("the full catalog includes quiet projects beyond the newest hundred tasks", t => {
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, thread_source TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, updated_at INTEGER, is_pinned INTEGER, recency_at_ms INTEGER, project_id TEXT)");
  const insert = db.prepare("INSERT INTO threads VALUES (?, 'Fixture', 'Fixture', 'D:/Fixture', 'user', 'cli', 0, ?, 1, 0, ?, ?)");
  for (let i = 0; i < 105; i++) insert.run(`fixture-${i}`, i, i, i === 0 ? "quiet" : "busy");
  assert.equal(readTaskCatalog(db).length, 100);
  const tasks = readTaskCatalog(db, null);
  assert.equal(tasks.length, 105);
  assert.equal(tasks.filter(task => task.projectId === "quiet").length, 1);
});
