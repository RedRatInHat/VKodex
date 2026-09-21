import type { DesktopModel, TaskDetails } from "./contracts.js";
import { DesktopUnavailableError } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { activeTurnsFromState, inProgressState, turnsFromState } from "./projector.js";

const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

export function taskDetails(state: IpcObject): TaskDetails {
  const turns = turnsFromState(state);
  const activeTurns = activeTurnsFromState(state);
  const runtimeStatus = isObject(state.threadRuntimeStatus) ? state.threadRuntimeStatus.type : undefined;
  const systemError = runtimeStatus === "systemError";
  const progressState = inProgressState(state);
  const running = runtimeStatus === "active" || progressState === "live";
  const turn = (running ? activeTurns.at(-1) : undefined) ?? turns.at(-1);
  const params = isObject(turn?.params) ? turn.params : {};
  const settings = isObject(state.latestThreadSettings) ? state.latestThreadSettings : {};
  const mode = isObject(params.collaborationMode) && isObject(params.collaborationMode.settings) ? params.collaborationMode.settings : {};
  const idleKnown = progressState !== "ambiguous" && (state.resumeState === undefined || state.resumeState === "resumed")
    && (runtimeStatus === "idle" || !!turn && ["completed", "failed", "interrupted"].includes(String(turn.status)));
  const usage = isObject(state.latestTokenUsageInfo) ? state.latestTokenUsageInfo : {};
  const last = isObject(usage.last) ? usage.last : {};
  const window = usage.modelContextWindow;
  const used = last.totalTokens;
  const context = typeof window === "number" && Number.isFinite(window) && window > 0 && typeof used === "number" && Number.isFinite(used) && used >= 0
    ? { used: Math.min(used, window), window, percent: Math.min(100, used / window * 100) } : null;
  const nextModel = string(settings.model) ?? string(state.latestModel);
  const nextEffort = string(settings.effort) ?? string(state.latestReasoningEffort);
  const error = Array.isArray(turn?.items) ? turn.items.filter(isObject).findLast(item => item.type === "error") : undefined;
  const errorInfo = typeof error?.errorInfo === "string" ? error.errorInfo : typeof error?.codexErrorInfo === "string" ? error.codexErrorInfo : null;
  const failure = errorInfo === "usageLimitExceeded" ? "usageLimit" as const
    : errorInfo === "server_overloaded" || errorInfo === "serverOverloaded" ? "serverOverloaded" as const : "systemError" as const;
  return {
    title: string(state.title),
    ...(systemError ? { failure } : {}),
    status: systemError ? "failed" : Array.isArray(state.requests) && state.requests.length > 0 ? "approval" : running ? "running" : !idleKnown ? "unavailable" : turn?.status === "failed" ? "failed" : turn?.status === "interrupted" ? "interrupted" : "idle",
    workspace: string(state.cwd),
    model: running ? string(mode.model) ?? string(params.model) ?? nextModel : nextModel,
    effort: running ? string(mode.reasoning_effort) ?? string(params.effort) ?? nextEffort : nextEffort,
    nextModel, nextEffort, context,
  };
}

export function parseModelsCache(value: unknown, now = Date.now()): DesktopModel[] {
  if (!isObject(value) || !Array.isArray(value.models) || typeof value.fetched_at !== "string") throw new DesktopUnavailableError("Не удалось прочитать список моделей Codex.");
  const fetchedAt = Date.parse(value.fetched_at);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > 24 * 60 * 60_000 || fetchedAt - now > 5 * 60_000) throw new DesktopUnavailableError("Список моделей устарел. Открой выбор модели в Codex для обновления.");
  const seen = new Set<string>();
  const models: DesktopModel[] = [];
  for (const model of value.models.filter(isObject).sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))) {
    if (model.visibility !== "list" || typeof model.slug !== "string" || !model.slug.trim() || seen.has(model.slug)) continue;
    const efforts = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.filter(isObject).map(level => level.effort).filter((level): level is string => typeof level === "string" && !!level) : [];
    if (!efforts.length || typeof model.default_reasoning_level !== "string" || !efforts.includes(model.default_reasoning_level)) continue;
    seen.add(model.slug);
    models.push({ id: model.slug, title: string(model.display_name) ?? model.slug, efforts: [...new Set(efforts)], defaultEffort: model.default_reasoning_level });
  }
  if (!models.length) throw new DesktopUnavailableError("В локальном списке Codex нет доступных моделей.");
  return models;
}

/** The App Server returns the models currently available to this Codex account. */
export function parseNativeModels(value: unknown): DesktopModel[] {
  if (!isObject(value) || !Array.isArray(value.data) || value.nextCursor !== null) {
    throw new DesktopUnavailableError("Codex не вернул полный список моделей.");
  }
  const models: DesktopModel[] = [];
  const seen = new Set<string>();
  for (const item of value.data) {
    if (!isObject(item) || item.hidden === true || typeof item.model !== "string" || !item.model.trim() || seen.has(item.model)) continue;
    const efforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.filter(isObject).map(level => level.reasoningEffort).filter((effort): effort is string => typeof effort === "string" && !!effort)
      : [];
    if (!efforts.length || typeof item.defaultReasoningEffort !== "string" || !efforts.includes(item.defaultReasoningEffort)) continue;
    seen.add(item.model);
    models.push({ id: item.model, title: string(item.displayName) ?? item.model,
      efforts: [...new Set(efforts)], defaultEffort: item.defaultReasoningEffort });
  }
  if (!models.length) throw new DesktopUnavailableError("Codex не сообщил доступных моделей.");
  return models;
}
