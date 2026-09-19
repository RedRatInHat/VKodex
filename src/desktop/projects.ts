import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { ProjectAssignmentUnconfirmedError, DesktopUnavailableError, type DesktopProject, type DesktopTask } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { comparablePath } from "./paths.js";

function migrationForHome(state: IpcObject, codexHome: string): IpcObject | null {
  const migrations = state["app-server-projects-migration-by-host"];
  if (!isObject(migrations)) return null;
  const value = Object.entries(migrations).find(([key]) => key.startsWith("local:")
    && comparablePath(key.slice(6)) === comparablePath(codexHome))?.[1];
  return isObject(value) ? value : null;
}

function legacyProjectId(codexHome: string, nativeProjectId: string): string {
  let database: Database | undefined;
  try {
    database = new DatabaseConstructor(path.join(codexHome, "state_5.sqlite"), { readonly: true, fileMustExist: true });
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    if (!tables.has("project_idempotency_keys")) return nativeProjectId;
    const row = database.prepare("SELECT key FROM project_idempotency_keys WHERE project_id = ? ORDER BY created_at_ms, key LIMIT 1")
      .get(nativeProjectId) as { key: string } | undefined;
    return row?.key || nativeProjectId;
  } catch { return nativeProjectId; }
  finally { database?.close(); }
}

/**
 * Codex desktop can temporarily run with native projects migrated to SQLite
 * while sidebar thread assignments still come from its legacy global state.
 * Mirror a successful native metadata update only in that explicit migration
 * state. Fully migrated and CLI-only profiles remain untouched.
 */
export async function mirrorLegacyProjectAssignment(codexHome: string, threadId: string, nativeProjectId: string | null): Promise<boolean> {
  const statePath = path.join(codexHome, ".codex-global-state.json");
  const targetProjectId = nativeProjectId === null ? null : legacyProjectId(codexHome, nativeProjectId);
  for (let attempt = 0; attempt < 4; attempt++) {
    let original: string; let before: { size: number; mtimeMs: number };
    try {
      [original, before] = await Promise.all([readFile(statePath, "utf8"), stat(statePath)]);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return false;
      throw new ProjectAssignmentUnconfirmedError();
    }
    let state: unknown;
    try { state = JSON.parse(original); } catch { throw new ProjectAssignmentUnconfirmedError(); }
    if (!isObject(state)) throw new ProjectAssignmentUnconfirmedError();
    const migration = migrationForHome(state, codexHome);
    if (migration?.projectsMigrated !== true || migration.threadAssignmentsMigrated === true) return false;

    const assignments = isObject(state["thread-project-assignments"])
      ? { ...state["thread-project-assignments"] as IpcObject } : {};
    const originalProjectless = Array.isArray(state["projectless-thread-ids"])
      ? state["projectless-thread-ids"].filter((id): id is string => typeof id === "string") : [];
    const existing = assignments[threadId];
    const wasProjectless = originalProjectless.includes(threadId);

    // During partial migration, new App Server threads intentionally have no
    // legacy entry. Their native threads.project_id is authoritative and is
    // already consumed by the catalog. Treat the legacy file as an override
    // only when this thread actually has an old assignment to replace. This
    // prevents harmless concurrent sidebar writes from turning a confirmed
    // native mutation into an uncertain create/transfer result.
    if (existing === undefined && !wasProjectless) return false;
    if (targetProjectId === null && existing === undefined && wasProjectless) return true;
    if (targetProjectId !== null && isObject(existing) && existing.projectKind === "local"
      && existing.projectId === targetProjectId && !wasProjectless) return true;

    const projectless = originalProjectless.filter(id => id !== threadId);
    if (nativeProjectId === null) {
      delete assignments[threadId];
      projectless.push(threadId);
    } else {
      assignments[threadId] = { projectKind: "local", projectId: targetProjectId };
    }
    const next = { ...state, "thread-project-assignments": assignments, "projectless-thread-ids": projectless };
    const serialized = `${JSON.stringify(next)}${original.endsWith("\n") ? "\n" : ""}`;
    const temporary = `${statePath}.vkodex-${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const current = await stat(statePath);
      if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
        await rm(temporary, { force: true });
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
        continue;
      }
      await rename(temporary, statePath);
      return true;
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new ProjectAssignmentUnconfirmedError();
    }
  }
  throw new ProjectAssignmentUnconfirmedError();
}

/** Prefer imported App Server projects, retaining only explicit legacy ID
 * mappings. The desktop can migrate projects before it migrates assignments. */
export function readDesktopProjectState(database: Database, legacy: IpcObject | null, codexHome: string): IpcObject | null {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
  if (!tables.has("projects") || !tables.has("project_roots")) return legacy;
  const projects = database.prepare("SELECT id, name FROM projects ORDER BY position, id").all() as { id: string; name: string }[];
  const migrations = legacy?.["app-server-projects-migration-by-host"];
  const migration = isObject(migrations) ? Object.entries(migrations).find(([key]) => key.startsWith("local:") && comparablePath(key.slice(6)) === comparablePath(codexHome))?.[1] : null;
  if (!projects.length && !(isObject(migration) && migration.projectsMigrated === true)) return legacy;
  const roots = database.prepare("SELECT project_id, path FROM project_roots ORDER BY position").all() as { project_id: string; path: string }[];
  const aliases = tables.has("project_idempotency_keys")
    ? database.prepare("SELECT key, project_id FROM project_idempotency_keys").all() as { key: string; project_id: string }[] : [];
  const ids = new Set(projects.map(project => project.id));
  const resolve = (id: string): string => ids.has(id) ? id : aliases.find(alias => alias.key === id && ids.has(alias.project_id))?.project_id ?? id;
  const assignments = legacy?.["thread-project-assignments"];
  return {
    ...legacy,
    "native-projects": true,
    "native-project-assignments": isObject(migration) && migration.threadAssignmentsMigrated === true,
    "legacy-project-assignments": isObject(migration) && migration.projectsMigrated === true && migration.threadAssignmentsMigrated !== true,
    "local-projects": Object.fromEntries(projects.map(project => [project.id, {
      id: project.id, name: project.name, rootPaths: roots.filter(root => root.project_id === project.id).map(root => root.path),
      legacyIds: aliases.filter(alias => alias.project_id === project.id && alias.key !== project.id).map(alias => alias.key),
    }])),
    "thread-project-assignments": isObject(assignments) ? Object.fromEntries(Object.entries(assignments).map(([id, value]) => [id,
      isObject(value) && typeof value.projectId === "string" && value.projectKind === "local" && value.projectOrigin !== "chatgpt"
        ? { ...value, projectId: resolve(value.projectId) } : value,
    ])) : {},
  };
}

export function desktopProjects(state: IpcObject): DesktopProject[] {
  const entries = state["local-projects"] ?? {};
  if (!isObject(entries) && !Array.isArray(entries)) throw new DesktopUnavailableError("Не удалось прочитать проекты десктопа Codex.");
  const projects = new Map<string, DesktopProject>();
  for (const [key, value] of Object.entries(entries)) {
    if (!isObject(value) || !Array.isArray(value.rootPaths)) continue;
    const id = typeof value.id === "string" ? value.id : key;
    if (!id.trim()) continue;
    const roots = value.rootPaths.filter((root): root is string => typeof root === "string" && !!root.trim());
    const title = typeof value.name === "string" && value.name.trim() ? value.name : `Проект · ${id.slice(0, 8)}`;
    const legacyIds = Array.isArray(value.legacyIds) ? value.legacyIds.filter((id): id is string => typeof id === "string" && !!id) : [];
    projects.set(id, { id, title, workspace: roots[0] ?? "", workspaceRoots: roots, ...(legacyIds.length ? { legacyIds } : {}) });
  }
  return [...projects.values()];
}

/** Desktop assignments override workspace inference, including explicit projectless tasks. */
export function assignTaskProjects(tasks: readonly DesktopTask[], state: IpcObject | null): DesktopTask[] {
  if (state === null) return tasks.map(({ projectId: _projectId, ...task }) => task);
  const projects = desktopProjects(state);
  const assignments = state["thread-project-assignments"] ?? {};
  const projectless = state["projectless-thread-ids"] ?? [];
  const hints = state["thread-workspace-root-hints"] ?? {};
  if (!isObject(assignments) || !Array.isArray(projectless) || !isObject(hints)) return assignTaskProjects(tasks, null);
  const unassigned = new Set(projectless.filter(id => typeof id === "string"));
  // During the staged desktop migration an explicit legacy assignment (or an
  // explicit projectless marker) remains authoritative. Newly created App
  // Server threads have no legacy entry, however, so their native project_id
  // is the only durable membership until the desktop finishes the migration.
  const useLegacyAssignments = state["legacy-project-assignments"] === true;
  const projectFor = (task: DesktopTask): string | null | undefined => {
    if (!useLegacyAssignments && state["native-projects"] === true && task.projectId) return task.projectId;
    if (state["native-project-assignments"] === true) return task.projectId;
    const assignment = assignments[task.threadId];
    if (assignment != null) {
      if (!isObject(assignment) || assignment.projectKind !== "local" || assignment.projectOrigin === "chatgpt" || typeof assignment.projectId !== "string" || !assignment.projectId) return undefined;
      return assignment.projectId;
    }
    if (unassigned.has(task.threadId)) return null;
    if (task.projectId) return task.projectId;
    const hint = hints[task.threadId];
    const workspace = comparablePath(typeof hint === "string" && hint ? hint : task.workspace).replaceAll("\\", "/");
    const matches = projects.flatMap(project => {
      const lengths = (project.workspaceRoots ?? []).map(root => comparablePath(root).replaceAll("\\", "/"))
        .filter(root => workspace === root || workspace.startsWith(`${root}/`)).map(root => root.length);
      return lengths.length ? [{ id: project.id, length: Math.max(...lengths) }] : [];
    }).sort((left, right) => right.length - left.length);
    if (!matches.length) return null;
    // Identical roots in different projects do not establish a unique assignment.
    if (matches[0]!.length === matches[1]?.length) return undefined;
    return matches[0]!.id;
  };
  return tasks.map(task => {
    const { projectId: _projectId, ...unlinked } = task;
    const projectId = projectFor(task);
    return { ...unlinked, ...(projectId === undefined ? {} : { projectId }) };
  });
}
