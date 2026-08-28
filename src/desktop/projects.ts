import { DesktopUnavailableError, type DesktopProject, type DesktopTask } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { comparablePath } from "./paths.js";

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
    projects.set(id, { id, title, workspace: roots[0] ?? "", workspaceRoots: roots });
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
  const projectFor = (task: DesktopTask): string | null | undefined => {
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
