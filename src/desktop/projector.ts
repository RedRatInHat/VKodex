import { createHash } from "node:crypto";
import type { TaskEvent } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";

export interface ProjectionCheckpoint {
  readonly since: number;
  readonly activeAtAttach: readonly string[];
  readonly seen: Readonly<Record<string, string>>;
}

export function turnsFromState(state: IpcObject): IpcObject[] {
  const turns = new Map<string, IpcObject>();
  const add = (value: unknown): void => {
    if (isObject(value) && typeof value.turnId === "string" && Array.isArray(value.items)) turns.set(value.turnId, value);
  };
  if (Array.isArray(state.turns)) state.turns.forEach(add);
  const history = isObject(state.turnHistory) ? state.turnHistory.history : undefined;
  const entities = isObject(history) ? history.entitiesByKey : undefined;
  if (isObject(entities)) Object.values(entities).forEach(add);
  return [...turns.values()].sort((a, b) => Number(a.turnStartedAtMs ?? 0) - Number(b.turnStartedAtMs ?? 0));
}

function userText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input.filter(isObject).filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
}

export function projectSnapshot(state: IpcObject, previous: ProjectionCheckpoint | null, now = Date.now()): { checkpoint: ProjectionCheckpoint; events: TaskEvent[] } {
  const turns = turnsFromState(state);
  const since = previous?.since ?? now;
  const activeAtAttach = previous?.activeAtAttach ?? turns.filter(turn => turn.status === "inProgress").map(turn => String(turn.turnId));
  const seen: Record<string, string> = { ...previous?.seen };
  const events: TaskEvent[] = [];
  const emit = (event: TaskEvent, allowInitial = false): void => {
    const key = JSON.stringify([event.turnId, event.type, event.id]);
    const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    if (seen[key] !== digest && (previous !== null || allowInitial)) events.push(event);
    seen[key] = digest;
  };
  for (const turn of turns) {
    const turnId = String(turn.turnId);
    if (!activeAtAttach.includes(turnId) && Number(turn.turnStartedAtMs ?? 0) < since) continue;
    const items = (turn.items as unknown[]).filter(isObject);
    const origins = new Map<string, string>();
    for (const item of items) {
      if (item.type === "steeringUserMessage" && item.status === "accepted" && typeof item.serverUserMessageId === "string" && typeof item.clientUserMessageId === "string") {
        origins.set(item.serverUserMessageId, item.clientUserMessageId);
      }
    }
    for (const item of items) {
      if (typeof item.id !== "string") continue;
      const id = item.id;
      if (item.type === "userMessage") {
        const operationId = origins.get(id) ?? (typeof item.clientId === "string" ? item.clientId : undefined);
        const text = userText(item.content);
        if (text) emit({ type: "user", id, turnId, text, ...(operationId ? { operationId } : {}) });
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "commentary") emit({ type: "progress", id, turnId, text: item.text }, turn.status === "inProgress");
        else if ((item.phase === "final_answer" || item.phase === "final") && turn.status === "completed") emit({ type: "final", id, turnId, text: item.text });
      }
    }
    const status = turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : null;
    if (status) emit({ type: "status", id: `status:${turnId}`, turnId, status }, turn.status === "inProgress");
  }
  return { checkpoint: { since, activeAtAttach, seen }, events };
}
