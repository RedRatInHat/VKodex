import { ActionRejectedError, type DesktopModel, type DesktopProject, type DesktopSource } from "../core/codex-tasks.js";

export function commandPage(value?: string): number {
  if (value === undefined) return 0;
  const page = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(page)) throw new ActionRejectedError("Номер страницы должен быть положительным целым числом.");
  return page - 1;
}

function exactChoice<T extends { readonly id: string }>(items: readonly T[], value: string, names: (item: T) => readonly string[], hint: string): T {
  const key = value.toLowerCase();
  const ids = items.filter(item => item.id.toLowerCase() === key);
  const matches = ids.length ? ids : items.filter(item => names(item).some(name => name.toLowerCase() === key));
  if (matches.length !== 1) throw new ActionRejectedError(matches.length ? `Совпало несколько вариантов. ${hint}` : `Вариант «${value.slice(0, 120)}» не найден. ${hint}`);
  return matches[0]!;
}

export function commandSource(sources: readonly DesktopSource[], value: string): DesktopSource {
  return exactChoice(sources, value, source => source.id === "" ? [source.label, ".codex"] : [source.label], "Укажи точный каталог из /sources.");
}

export function commandProject(projects: readonly DesktopProject[], value: string): DesktopProject {
  return exactChoice(projects, value, project => [project.title, ...(project.legacyIds ?? [])], "Укажи точный ID проекта из /projects.");
}

export function modelAlias(id: string): string | undefined {
  const match = /^gpt-(\d+(?:\.\d+)?)-(sol|terra|luna|astra)$/iu.exec(id);
  return match && match[1] && match[2] ? `${match[2]}${match[1]}`.toLowerCase() : undefined;
}

export function commandModel(models: readonly DesktopModel[], value: string, effort?: string): { model: string; effort: string } {
  const model = exactChoice(models, value, item => [modelAlias(item.id) ?? item.id, item.title], "Укажи модель из /models.");
  const selected = effort?.toLowerCase() ?? model.defaultEffort;
  if (!model.efforts.includes(selected)) throw new ActionRejectedError(`У модели ${model.id} доступны уровни: ${model.efforts.join(", ")}.`);
  return { model: model.id, effort: selected };
}
