import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { type DesktopTask, DesktopUnavailableError } from "../src/desktop/contracts.js";
import { readTaskCatalog } from "../src/desktop/catalog.js";
import { assignTaskProjects, desktopProjects } from "../src/desktop/projects.js";
import { MultiDesktopCatalog } from "../src/desktop/multi-catalog.js";

const task: DesktopTask = { hostId: "local", threadId: "fixture", title: "Fixture task", workspace: "D:/Fixture/First", updatedAt: 1 };
const state = {
  "local-projects": {
    first: { id: "first", name: "First", rootPaths: ["D:/Fixture/First", "D:/Fixture/Shared"] },
    second: { id: "second", name: "Second", rootPaths: ["D:/Fixture/Second"] },
  },
};

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

test("a CLI-only source stays projectless instead of inheriting another source's projects", async () => {
  const combined = new MultiDesktopCatalog(["D:/Fixture/Home", "D:/Fixture/OtherHome"], home => ({
    listModels: async () => [],
    listTasks: async () => assignTaskProjects([task], home.endsWith("OtherHome") ? {} : state),
    listProjects: async () => desktopProjects(home.endsWith("OtherHome") ? {} : state),
  }));
  const tasks = await combined.listTasks();
  assert.equal(tasks[0]!.projectId, "first");
  assert.equal(tasks[1]!.projectId, null);
  assert.notEqual(tasks[0]!.sourceId, tasks[1]!.sourceId);
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
