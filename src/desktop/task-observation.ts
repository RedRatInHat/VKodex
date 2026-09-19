import type { TaskDetails, TaskEvent } from "./contracts.js";
import { taskDetails } from "./details.js";
import type { IpcObject } from "./ipc-client.js";
import { isObject } from "./ipc-client.js";
import { activeTurnsFromState, projectSnapshot, turnsFromState,
  type ProjectionCheckpoint, type ProjectionOptions } from "./projector.js";
import { pendingCodexQuestions, type CodexQuestions } from "./questions.js";

export type TaskObservationCheckpoint = ProjectionCheckpoint;
export type TaskObservationOptions = ProjectionOptions;

export interface TaskObservedInput {
  readonly turnId: string;
  readonly status: string;
  readonly operationIds: readonly string[];
}

export interface TaskObservation {
  readonly checkpoint: TaskObservationCheckpoint;
  readonly events: readonly TaskEvent[];
  readonly details: TaskDetails;
  readonly questions: readonly CodexQuestions[];
  readonly inputs: readonly TaskObservedInput[];
  readonly latestTurnId: string;
  readonly activeTurnId: string | null;
}

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
