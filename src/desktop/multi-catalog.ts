import { createHash } from "node:crypto";
import path from "node:path";
import { DesktopUnavailableError, type DesktopModel, type DesktopProject, type DesktopTask, type TaskRef } from "./contracts.js";
import { LocalDesktopCatalog } from "./catalog.js";
import { comparablePath } from "./paths.js";

type Catalog = Pick<LocalDesktopCatalog, "listTasks" | "listProjects" | "listModels">;
interface Source { readonly id: string; readonly label: string; readonly home: string; readonly catalog: Catalog }
interface SourceSnapshot {
  readonly source: Source;
  readonly tasks: PromiseSettledResult<readonly DesktopTask[]>;
  readonly projects: PromiseSettledResult<readonly DesktopProject[]>;
}

export interface ResolvedDesktopProject {
  readonly project: DesktopProject;
  readonly rawProjectId: string;
  readonly sourceHome: string;
  readonly sourceId?: string;
  readonly sourceLabel: string;
}

function sourceProject(source: Source, project: DesktopProject, showLabel: boolean): DesktopProject {
  return {
    ...project,
    id: source.id ? JSON.stringify([source.id, project.id]) : project.id,
    title: showLabel ? `[${source.label}] ${project.title}` : project.title,
  };
}

function inferredProject(task: DesktopTask, projects: readonly DesktopProject[]): string | null | undefined {
  const workspace = comparablePath(task.workspace).replaceAll("\\", "/");
  const matches = projects.flatMap(project => {
    const lengths = (project.workspaceRoots ?? [project.workspace]).map(root => comparablePath(root).replaceAll("\\", "/"))
      .filter(root => !!root && (workspace === root || workspace.startsWith(`${root}/`))).map(root => root.length);
    return lengths.length ? [{ id: project.id, length: Math.max(...lengths) }] : [];
  }).sort((left, right) => right.length - left.length);
  if (!matches.length) return null;
  if (matches[0]!.length === matches[1]?.length) return undefined;
  return matches[0]!.id;
}

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

  private async snapshot(): Promise<readonly SourceSnapshot[]> {
    return Promise.all(this.sources.map(async source => {
      const [tasks, projects] = await Promise.allSettled([source.catalog.listTasks(), source.catalog.listProjects()]);
      return { source, tasks, projects };
    }));
  }

  private updateWarnings(snapshot: readonly SourceSnapshot[]): number {
    this.warnings = [];
    let readable = 0;
    for (const entry of snapshot) {
      if (entry.tasks.status === "fulfilled") readable++;
      else this.warnings.push(`Не удалось прочитать каталог «${entry.source.label}». Проверь путь и доступ.`);
    }
    return readable;
  }

  async listTasks(): Promise<readonly DesktopTask[]> {
    const snapshot = await this.snapshot();
    const readable = this.updateWarnings(snapshot);
    if (!readable) throw new DesktopUnavailableError("Не удалось прочитать ни один настроенный каталог Codex.");
    const active = snapshot.filter((entry): entry is SourceSnapshot & { tasks: PromiseFulfilledResult<readonly DesktopTask[]> } => entry.tasks.status === "fulfilled" && entry.tasks.value.length > 0);
    const showSource = active.length > 1;
    const projectSources = active.filter((entry): entry is typeof entry & { projects: PromiseFulfilledResult<readonly DesktopProject[]> } => entry.projects.status === "fulfilled" && entry.projects.value.length > 0);
    const showProjectSource = projectSources.length > 1;
    const allProjects = projectSources.flatMap(entry => entry.projects.value.map(project => sourceProject(entry.source, project, showProjectSource)));
    const tasks: DesktopTask[] = [];
    for (const entry of active) {
      const ownProjects = entry.projects.status === "fulfilled" ? entry.projects.value : [];
      for (const task of entry.tasks.value) {
        let projectId = task.projectId;
        if (projectId && entry.source.id) projectId = JSON.stringify([entry.source.id, projectId]);
        // A secondary CLI/work profile often has session data but no desktop
        // project state. In that case use the shared desktop projects only when
        // the workspace has one unambiguous longest-root match.
        if (projectId === null && ownProjects.length === 0) projectId = inferredProject(task, allProjects);
        tasks.push({
          ...task,
          ...(entry.source.id ? { sourceId: entry.source.id } : {}),
          ...(showSource ? { sourceLabel: entry.source.label } : {}),
          ...(projectId === undefined ? {} : { projectId }),
        });
      }
    }
    return tasks.sort((left, right) => right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId));
  }

  async listModels(task?: TaskRef): Promise<readonly DesktopModel[]> {
    const home = this.sourceHome(task ?? { hostId: "local", threadId: "" });
    return this.sources.find(source => source.home === home)!.catalog.listModels(task);
  }

  async listProjects(): Promise<readonly DesktopProject[]> {
    const snapshot = await this.snapshot();
    const readable = this.updateWarnings(snapshot);
    if (!readable) throw new DesktopUnavailableError("Не удалось прочитать ни один настроенный каталог Codex.");
    const active = snapshot.filter(entry => entry.tasks.status === "fulfilled" && entry.tasks.value.length > 0 && entry.projects.status === "fulfilled" && entry.projects.value.length > 0);
    const showSource = active.length > 1;
    return active.flatMap(entry => entry.projects.status === "fulfilled" ? entry.projects.value.map(project => sourceProject(entry.source, project, showSource)) : []);
  }

  async resolveProject(projectId: string): Promise<ResolvedDesktopProject> {
    const snapshot = await this.snapshot();
    const readable = this.updateWarnings(snapshot);
    if (!readable) throw new DesktopUnavailableError("Не удалось прочитать ни один настроенный каталог Codex.");
    const active = snapshot.filter(entry => entry.tasks.status === "fulfilled" && entry.tasks.value.length > 0 && entry.projects.status === "fulfilled" && entry.projects.value.length > 0);
    const showSource = active.length > 1;
    for (const entry of active) {
      if (entry.projects.status !== "fulfilled") continue;
      for (const project of entry.projects.value) {
        const visible = sourceProject(entry.source, project, showSource);
        if (visible.id !== projectId) continue;
        return { project: visible, rawProjectId: project.id, sourceHome: entry.source.home, sourceLabel: entry.source.label,
          ...(entry.source.id ? { sourceId: entry.source.id } : {}) };
      }
    }
    throw new DesktopUnavailableError("Выбранный проект больше не доступен в настроенных каталогах Codex.");
  }
}
