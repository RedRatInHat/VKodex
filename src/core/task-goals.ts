import { ActionRejectedError, DesktopUnavailableError,
  type TaskGoal, type TaskGoalStatus, type TaskGoalUpdate } from "./codex-tasks.js";

const goalStatuses = new Set<TaskGoalStatus>(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

export interface NormalizedTaskGoalUpdate {
  readonly objective?: string;
  readonly status?: TaskGoalStatus;
  readonly tokenBudget?: number | null;
}

export function parseTaskGoal(value: unknown, expectedThreadId: string): TaskGoal | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopUnavailableError("Codex вернул некорректное состояние цели.");
  const goal = value as Record<string, unknown>;
  if (goal.threadId !== expectedThreadId
    || typeof goal.objective !== "string" || !goal.objective.trim() || goal.objective.length > 16_000
    || typeof goal.status !== "string" || !goalStatuses.has(goal.status as TaskGoalStatus)
    || !(goal.tokenBudget === null || (typeof goal.tokenBudget === "number" && Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0))
    || typeof goal.tokensUsed !== "number" || !Number.isSafeInteger(goal.tokensUsed) || goal.tokensUsed < 0
    || typeof goal.timeUsedSeconds !== "number" || !Number.isSafeInteger(goal.timeUsedSeconds) || goal.timeUsedSeconds < 0
    || typeof goal.createdAt !== "number" || !Number.isSafeInteger(goal.createdAt) || goal.createdAt <= 0
    || typeof goal.updatedAt !== "number" || !Number.isSafeInteger(goal.updatedAt) || goal.updatedAt <= 0) {
    throw new DesktopUnavailableError("Codex вернул некорректное состояние цели.");
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status as TaskGoalStatus,
    tokenBudget: goal.tokenBudget as number | null,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function normalizeTaskGoalUpdate(update: TaskGoalUpdate): NormalizedTaskGoalUpdate {
  const objective = update.objective?.trim();
  if (objective !== undefined && (!objective || objective.length > 8_000 || /\x00/u.test(objective))) {
    throw new ActionRejectedError("Цель должна содержать от 1 до 8000 символов.");
  }
  if (update.status !== undefined && !goalStatuses.has(update.status)) throw new ActionRejectedError("Некорректный статус цели.");
  if (update.tokenBudget !== undefined && update.tokenBudget !== null
    && (!Number.isSafeInteger(update.tokenBudget) || update.tokenBudget <= 0 || update.tokenBudget > 100_000_000)) {
    throw new ActionRejectedError("Лимит цели должен быть от 1 до 100 000 000 токенов.");
  }
  if (objective === undefined && update.status === undefined && update.tokenBudget === undefined) {
    throw new ActionRejectedError("Изменения цели не указаны.");
  }
  return {
    ...(objective !== undefined ? { objective } : {}),
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.tokenBudget !== undefined ? { tokenBudget: update.tokenBudget } : {}),
  };
}

export function goalMatchesUpdate(goal: TaskGoal | null, update: NormalizedTaskGoalUpdate): goal is TaskGoal {
  return goal !== null
    && (update.objective === undefined || goal.objective === update.objective)
    && (update.status === undefined || goal.status === update.status)
    && (update.tokenBudget === undefined || goal.tokenBudget === update.tokenBudget);
}
