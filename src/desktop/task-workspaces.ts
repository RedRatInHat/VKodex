import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { ActionRejectedError } from "./contracts.js";
import type { ResolvedDesktopProject } from "./multi-catalog.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    throw new ActionRejectedError("Для worktree нужен локальный Git-репозиторий с доступной базовой ревизией.");
  }
}

export async function createTaskWorktree(project: ResolvedDesktopProject, operationId: string): Promise<string> {
  if (!path.isAbsolute(project.project.workspace)) throw new ActionRejectedError("У проекта нет локальной рабочей папки для worktree.");
  const root = path.resolve(await git(project.project.workspace, ["rev-parse", "--show-toplevel"]));
  let startPoint: string;
  try { startPoint = await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]); }
  catch { startPoint = await git(root, ["rev-parse", "HEAD"]); }
  const name = `${path.basename(root)}_VKodex_${operationId.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 8) || randomUUID().slice(0, 8)}_worktree`;
  const destination = path.join(path.dirname(root), name);
  try {
    await execFileAsync("git", ["-C", root, "worktree", "add", "--detach", destination, startPoint], { encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch {
    throw new ActionRejectedError("Git не смог создать отдельный worktree. Проверь занятое имя, состояние репозитория и базовую ветку.");
  }
  return destination;
}
