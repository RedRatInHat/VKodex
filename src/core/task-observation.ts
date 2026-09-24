import type { CodexQuestions } from "./codex-questions.js";
import type { TaskDetails, TaskEvent } from "./codex-tasks.js";
import type { TaskState } from "./task-state.js";

export interface TaskObservationCheckpoint {
  readonly since: number;
  readonly lastObservedAt?: number;
  readonly activeAtAttach: readonly string[];
  readonly active?: readonly string[];
  readonly seen: Readonly<Record<string, string>>;
  readonly semanticByIdentity?: Readonly<Record<string, string>>;
  readonly rolloutPath?: string;
}

export interface TaskObservationOptions {
  readonly rebaseline?: boolean;
  readonly recoverFinalTurnIds?: readonly string[];
  readonly finalRecorded?: (eventId: string) => boolean;
}

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
  /** Turns whose user input is present in this snapshot, even if it was part of the baseline. */
  readonly inputTurnIds: readonly string[];
  readonly latestTurnId: string;
  readonly activeTurnId: string | null;
}

export type TaskStateObserver = (state: TaskState, previous: TaskObservationCheckpoint | null,
  now?: number, options?: TaskObservationOptions) => TaskObservation;
