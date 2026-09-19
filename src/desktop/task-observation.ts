import type { TaskObservation, TaskObservationCheckpoint, TaskObservationOptions } from "../core/task-observation.js";
import { taskDetails } from "./details.js";
import type { IpcObject } from "./ipc-client.js";
import { isObject } from "./ipc-client.js";
import { activeTurnsFromState, projectSnapshot, turnsFromState } from "./projector.js";
import { pendingCodexQuestions } from "./questions.js";

export type { TaskObservation, TaskObservationCheckpoint, TaskObservationOptions, TaskObservedInput } from "../core/task-observation.js";

/** Converts one client-specific stream snapshot into the bridge domain. */
export function observeTaskState(state: IpcObject, previous: TaskObservationCheckpoint | null,
  now = Date.now(), options: TaskObservationOptions = {}): TaskObservation {
  const turns = turnsFromState(state);
  const projected = projectSnapshot(state, previous, now, options);
  const inputs = turns.flatMap(turn => {
    if (typeof turn.turnId !== "string" || !Array.isArray(turn.items)) return [];
    const operationIds = turn.items.filter(isObject)
      .filter(item => item.type === "userMessage" && typeof item.clientId === "string" && item.clientId)
      .map(item => String(item.clientId));
    return operationIds.length ? [{ turnId: turn.turnId, status: String(turn.status ?? ""), operationIds }] : [];
  });
  const activeTurn = activeTurnsFromState(state).at(-1);
  return {
    checkpoint: projected.checkpoint,
    events: projected.events,
    details: taskDetails(state),
    questions: pendingCodexQuestions(state),
    inputs,
    latestTurnId: String(turns.at(-1)?.turnId ?? "runtime"),
    activeTurnId: typeof activeTurn?.turnId === "string" ? activeTurn.turnId : null,
  };
}
