import { createHash } from "node:crypto";
import type { TaskEvent } from "./contracts.js";
import { isObject, type IpcObject } from "./ipc-client.js";
import { comparablePath } from "./paths.js";

export interface ProjectionCheckpoint {
  readonly since: number;
  readonly activeAtAttach: readonly string[];
  /** Turns that were running in the last accepted live snapshot. */
  readonly active?: readonly string[];
  readonly seen: Readonly<Record<string, string>>;
  /**
   * Last accepted semantic content by desktop event identity. Codex can rebuild
   * an edited branch while replacing live msg IDs with canonical item IDs.
   * Hashes keep that rewrite from looking like new user-visible history without
   * storing message text.
   */
  readonly semanticByIdentity?: Readonly<Record<string, string>>;
  /** Exact rollout used for the last snapshot, normalized without exposing it to VK. */
  readonly rolloutPath?: string;
}

export interface ProjectionOptions {
  /**
   * The snapshot is the first one from a new subscription. Treat its history
   * as a baseline, except for the final result of a turn observed running
   * before the disconnect.
   */
  readonly rebaseline?: boolean;
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

type SemanticEvent = Exclude<TaskEvent, { readonly type: "status" }>;

function identityKey(event: TaskEvent): string {
  return JSON.stringify([event.turnId, event.type, event.id]);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function semanticDigest(event: SemanticEvent): string {
  // Desktop rewrites can change line endings or leave an extra terminal space.
  // Preserve all internal whitespace because it can be meaningful source code.
  const text = event.text.replace(/\r\n?/gu, "\n").trimEnd();
  return hash(JSON.stringify([event.type, text]));
}

function counts(values: Readonly<Record<string, string>>): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of Object.values(values)) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function projectSnapshot(state: IpcObject, previous: ProjectionCheckpoint | null, now = Date.now(), options: ProjectionOptions = {}): { checkpoint: ProjectionCheckpoint; events: TaskEvent[] } {
  const turns = turnsFromState(state);
  const since = previous?.since ?? now;
  const attachedActive = turns.filter(turn => turn.status === "inProgress").at(-1);
  const activeAtAttach = previous?.activeAtAttach ?? (attachedActive ? [String(attachedActive.turnId)] : []);
  const previouslyActive = new Set(previous?.active ?? []);
  const rebaseline = previous !== null && options.rebaseline === true;
  const seen: Record<string, string> = { ...previous?.seen };
  const previousSemantic = previous?.semanticByIdentity ?? {};
  const semanticByIdentity: Record<string, string> = { ...previousSemantic };
  const previousSemanticCounts = counts(previousSemantic);
  const currentSemanticCounts = new Map<string, number>();
  const rolloutPath = typeof state.rolloutPath === "string" ? comparablePath(state.rolloutPath) : previous?.rolloutPath;
  const historyRebuilt = previous?.rolloutPath !== undefined && rolloutPath !== undefined && previous.rolloutPath !== rolloutPath;
  const events: TaskEvent[] = [];
  const eligible = (turn: IpcObject): boolean => activeAtAttach.includes(String(turn.turnId)) || Number(turn.turnStartedAtMs ?? 0) >= since;
  const emitStatus = (event: Extract<TaskEvent, { readonly type: "status" }>, allowInitial = false): void => {
    const key = identityKey(event);
    const digest = hash(JSON.stringify(event));
    if (seen[key] !== digest && (previous !== null || allowInitial) && !rebaseline) events.push(event);
    seen[key] = digest;
  };
  const emitSemantic = (event: SemanticEvent, allowRebaseline = false): void => {
    const key = identityKey(event);
    const semantic = semanticDigest(event);
    const occurrence = (currentSemanticCounts.get(semantic) ?? 0) + 1;
    currentSemanticCounts.set(semantic, occurrence);
    const knownSemantic = previousSemantic[key];
    const previousCount = previousSemanticCounts.get(semantic) ?? 0;
    const semanticallyNew = knownSemantic === undefined
      ? historyRebuilt ? previousCount === 0 : occurrence > previousCount
      : knownSemantic !== semantic;
    const digest = hash(JSON.stringify(event));
    const changed = seen[key] !== digest;
    const accepted = changed && semanticallyNew && previous !== null && (!rebaseline || allowRebaseline);
    if (accepted) events.push(event);
    // A duplicate identity created only by history rewriting is deliberately
    // not remembered: otherwise every rewrite would inflate occurrence counts.
    if (previous === null || knownSemantic !== undefined || semanticallyNew) semanticByIdentity[key] = semantic;
    seen[key] = digest;
  };
  for (const turn of turns) {
    const turnId = String(turn.turnId);
    const turnEligible = eligible(turn);
    if (!turnEligible) continue;
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
        if (text) emitSemantic({ type: "user", id, turnId, text, ...(operationId ? { operationId } : {}) });
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        // The first snapshot is a baseline even when the turn is already active.
        // Replaying its accumulated commentary would flood a newly linked VK chat
        // with progress that happened before the user connected it. A later edit
        // to the same item (or genuinely new content) is emitted.
        if (item.phase === "commentary") emitSemantic({ type: "progress", id, turnId, text: item.text });
        else if ((item.phase === "final_answer" || item.phase === "final") && turn.status === "completed") {
          emitSemantic({ type: "final", id, turnId, text: item.text }, previouslyActive.has(turnId));
        }
      }
    }
    const status = turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : null;
    if (status && turnEligible) emitStatus({ type: "status", id: `status:${turnId}`, turnId, status }, turn.status === "inProgress");
  }
  const activeTurn = turns.filter(turn => turn.status === "inProgress" && eligible(turn)).at(-1);
  const active = activeTurn ? [String(activeTurn.turnId)] : [];
  return { checkpoint: { since, activeAtAttach, active, seen, semanticByIdentity, ...(rolloutPath ? { rolloutPath } : {}) }, events };
}
