import { createHash } from "node:crypto";
import path from "node:path";
import { DesktopUnavailableError, type DesktopModel, type DesktopProject, type DesktopTask, type TaskRef } from "./contracts.js";
import { LocalDesktopCatalog } from "./catalog.js";
import { comparablePath } from "./paths.js";

type Catalog = Pick<LocalDesktopCatalog, "listTasks" | "listProjects" | "listModels">;
interface Source { readonly id: string; readonly label: string; readonly home: string; readonly catalog: Catalog }

export class MultiDesktopCatalog {
  private readonly sources: readonly Source[];
  private warnings: string[] = [];

  constructor(homes: readonly string[], createCatalog: (home: string) => Catalog = home => new LocalDesktopCatalog(home)) {
    if (!homes.length) throw new Error("At least one Codex directory is required");
    const unique = [...new Map(homes.map(home => [comparablePath(home), home])).values()];
    this.sources = unique.map((home, index) => ({
      // The primary source retains legacy task/binding keys. Extra-source IDs
      // depend on the path, not array order or a directory's display name.
      id: index === 0 ? "" : createHash("sha256").update(comparablePath(home)).digest("hex").slice(0, 24),
      label: path.basename(home), home, catalog: createCatalog(home),
    }));
  }

  sourceHome(task: TaskRef): string {
    const source = this.sources.find(source => source.id === (task.sourceId ?? ""));
    if (!source) throw new DesktopUnavailableError("Каталог этой задачи больше не подключён в конфигурации VKodex.");
    return source.home;
  }

  catalogWarnings(): readonly string[] { return this.warnings; }

  async listTasks(): Promise<readonly DesktopTask[]> {
    const results = await Promise.allSettled(this.sources.map(source => source.catalog.listTasks()));
    this.warnings = [];
    const tasks: DesktopTask[] = [];
    let readable = 0;
    for (const [index, result] of results.entries()) {
      const source = this.sources[index]!;
      if (result.status === "rejected") { this.warnings.push(`Не удалось прочитать каталог «${source.label}». Проверь путь и доступ.`); continue; }
      readable++;
      for (const task of result.value) tasks.push({ ...task, ...(source.id ? { sourceId: source.id } : {}), sourceLabel: source.label,
        ...(task.projectId ? { projectId: source.id ? JSON.stringify([source.id, task.projectId]) : task.projectId } : {}) });
    }
    if (!readable) throw new DesktopUnavailableError("Не удалось прочитать ни один настроенный каталог Codex.");
    return tasks;
  }

  async listModels(task?: TaskRef): Promise<readonly DesktopModel[]> {
    const home = this.sourceHome(task ?? { hostId: "local", threadId: "" });
    return this.sources.find(source => source.home === home)!.catalog.listModels(task);
  }

  async listProjects(): Promise<readonly DesktopProject[]> {
    const results = await Promise.allSettled(this.sources.map(source => source.catalog.listProjects()));
    const projects: DesktopProject[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") continue; // CLI-only homes need not contain desktop project settings.
      const source = this.sources[index]!;
      for (const project of result.value) projects.push({ ...project, id: source.id ? JSON.stringify([source.id, project.id]) : project.id,
        title: this.sources.length > 1 ? `[${source.label}] ${project.title}` : project.title });
    }
    return projects;
  }
}
