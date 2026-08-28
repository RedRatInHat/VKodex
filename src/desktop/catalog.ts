import { readFile } from "node:fs/promises";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { DesktopUnavailableError, type DesktopModel, type DesktopProject, type DesktopTask, type TaskRef } from "./contracts.js";
import { parseModelsCache } from "./details.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { assignTaskProjects, desktopProjects } from "./projects.js";

export function parseTaskTitles(index: string): ReadonlyMap<string, string> {
  const latest = new Map<string, { title: string; updatedAt: number }>();
  for (const line of index.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row) || typeof row.id !== "string" || !row.id || typeof row.thread_name !== "string" || !row.thread_name.trim() || typeof row.updated_at !== "string") continue;
    const updatedAt = Date.parse(row.updated_at);
    if (!Number.isFinite(updatedAt)) continue;
    const previous = latest.get(row.id);
    if (!previous || updatedAt >= previous.updatedAt) latest.set(row.id, { title: row.thread_name.trim(), updatedAt });
  }
  return new Map([...latest].map(([id, value]) => [id, value.title]));
}

export function readTaskCatalog(database: Database, limit: number | null = 100, titles: ReadonlyMap<string, string> = new Map()): DesktopTask[] {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new Error("Invalid catalog limit");
  const columns = new Set((database.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map(column => column.name));
  const required = ["id", "name", "title", "cwd", "thread_source", "source", "archived", "updated_at_ms", "updated_at", "is_pinned", "recency_at_ms"];
  if (required.some(column => !columns.has(column))) throw new DesktopUnavailableError("Версия каталога Codex не поддерживается.");
  const rows = database.prepare(`
    SELECT id, name, title, cwd, ${columns.has("rollout_path") ? "rollout_path" : "NULL"} AS rollout_path,
      ${columns.has("project_id") ? "project_id" : "NULL"} AS project_id,
      COALESCE(updated_at_ms, updated_at * 1000) AS updated_at
    FROM threads
    WHERE archived = 0 AND thread_source = 'user' AND source IN ('vscode', 'cli', 'exec')
    ORDER BY is_pinned DESC, COALESCE(recency_at_ms, updated_at_ms, updated_at * 1000) DESC, id
    LIMIT ?
  `).all(limit ?? -1) as { id: string; name: string | null; title: string | null; cwd: string; updated_at: number; rollout_path: string | null; project_id: string | null }[];
  return rows.map(row => {
    // SQLite's title may be the entire initial prompt, while renamed/generated
    // desktop titles live in session_index.jsonl. Exclude long/multiline fallbacks.
    const legacyTitle = row.title?.trim() ?? "";
    const fallback = legacyTitle.length <= 120 && !/[\r\n]/u.test(legacyTitle) ? legacyTitle : "";
    const title = titles.get(row.id)?.trim() || row.name?.trim() || fallback || `Без названия · ${row.id.slice(0, 8)}`;
    return { hostId: "local", threadId: row.id, title, workspace: row.cwd, projectId: row.project_id || null, updatedAt: row.updated_at, ...(row.rollout_path ? { rolloutPath: row.rollout_path } : {}) };
  });
}

export class LocalDesktopCatalog {
  constructor(private readonly codexHome: string) {}

  async listModels(_task?: TaskRef): Promise<readonly DesktopModel[]> {
    try { return parseModelsCache(JSON.parse(await readFile(path.join(this.codexHome, "models_cache.json"), "utf8"))); }
    catch (error) {
      if (error instanceof DesktopUnavailableError) throw error;
      throw new DesktopUnavailableError("Не удалось прочитать список моделей. Открой Codex и его выбор модели.");
    }
  }

  async listTasks(): Promise<readonly DesktopTask[]> {
    let database: Database | undefined;
    try {
      let titles: ReadonlyMap<string, string> = new Map();
      try { titles = parseTaskTitles(await readFile(path.join(this.codexHome, "session_index.jsonl"), "utf8")); }
      catch (error) { if (!isObject(error) || error.code !== "ENOENT") throw error; }
      database = new DatabaseConstructor(path.join(this.codexHome, "state_5.sqlite"), { readonly: true, fileMustExist: true });
      database.pragma("query_only = ON");
      // Filter and paginate in the manager, after loading project membership.
      // A global recent-task limit would hide older tasks in quiet projects.
      const tasks = readTaskCatalog(database, null, titles);
      const state = await this.projectState();
      try { return assignTaskProjects(tasks, state); }
      catch { return assignTaskProjects(tasks, null); }
    } catch (error) {
      if (error instanceof DesktopUnavailableError) throw error;
      throw new DesktopUnavailableError("Не удалось прочитать локальный каталог Codex.");
    } finally { database?.close(); }
  }

  async listProjects(): Promise<readonly DesktopProject[]> {
    const state = await this.projectState();
    if (state === null) throw new DesktopUnavailableError("Не удалось прочитать проекты десктопа Codex.");
    return desktopProjects(state);
  }

  private async projectState(): Promise<IpcObject | null> {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.codexHome, ".codex-global-state.json"), "utf8"));
      return isObject(value) ? value : null;
    } catch (error) {
      // A CLI-only home has no desktop project settings. An unreadable existing
      // file leaves membership unknown, while its tasks remain available in All.
      return isObject(error) && error.code === "ENOENT" ? {} : null;
    }
  }
}
