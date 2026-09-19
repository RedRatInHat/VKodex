import { createHash } from "node:crypto";
import type { CodexQuestions } from "../core/codex-questions.js";
import type { TaskDetails, TaskEvent, TaskRef } from "../core/codex-tasks.js";
import type { TaskObservation, TaskObservationCheckpoint, TaskObservationOptions, TaskObservedInput } from "../core/task-observation.js";
import type { TaskState, TaskStateStream, TaskStateTransport } from "../core/task-state.js";
import { AppServerUnavailableError, type AppServerEnvelope, type AppServerRpc } from "./app-server-connection.js";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | null => typeof value === "string" && value ? value : null;

interface NativeTurn {
  readonly id: string;
  readonly status: string;
  readonly startedAt: number;
  readonly items: readonly JsonObject[];
  readonly error: JsonObject | null;
}

interface NativeSnapshot extends TaskState {
  readonly kind: "app-server";
  readonly threadId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly runtimeStatus: string;
  readonly context: TaskDetails["context"];
  readonly turns: readonly NativeTurn[];
}

function parseTurn(value: unknown): NativeTurn | null {
  if (!isObject(value) || !string(value.id) || !Array.isArray(value.items)) return null;
  return {
    id: String(value.id), status: String(value.status ?? ""),
    startedAt: typeof value.startedAt === "number" ? value.startedAt * 1000 : 0,
    items: value.items.filter(isObject), error: isObject(value.error) ? value.error : null,
  };
}

function textInput(content: unknown): string {
  return Array.isArray(content) ? content.filter(isObject)
    .filter(item => item.type === "text" && typeof item.text === "string")
    .map(item => String(item.text)).join("\n") : "";
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function eventKey(event: TaskEvent): string { return JSON.stringify([event.turnId, event.type, event.id]); }

/** Maps the native App Server snapshot directly into bridge events and status. */
export function observeAppServerTaskState(state: TaskState, previous: TaskObservationCheckpoint | null,
  now = Date.now(), options: TaskObservationOptions = {}): TaskObservation {
  if (state.kind !== "app-server" || !Array.isArray(state.turns)) throw new AppServerUnavailableError("Codex App Server вернул неизвестное состояние задачи.");
  const snapshot = state as NativeSnapshot;
  const turns = snapshot.turns;
  // Native turn timestamps have one-second precision. Floor the attachment
  // boundary so a turn started later in the same second is not classified as history.
  const since = previous?.since ?? Math.floor(now / 1_000) * 1_000;
  const active = turns.filter(turn => turn.status === "inProgress").map(turn => turn.id);
  const activeAtAttach = previous?.activeAtAttach ?? active;
  const previousActive = new Set(previous?.active ?? []);
  const rebaseline = previous !== null && options.rebaseline === true;
  const seen: Record<string, string> = { ...previous?.seen };
  const events: TaskEvent[] = [];
  const recoverFinal = new Set(options.recoverFinalTurnIds ?? []);
  const emit = (event: TaskEvent, recover = false): void => {
    const key = eventKey(event); const hash = digest(event);
    const changed = seen[key] !== hash;
    if ((changed && previous !== null && !rebaseline) || recover) events.push(event);
    seen[key] = hash;
  };
  const inputs: TaskObservedInput[] = [];
  for (const turn of turns) {
    const eligible = activeAtAttach.includes(turn.id) || turn.startedAt >= since;
    const operationIds: string[] = [];
    const agentItems = turn.items.filter(item => item.type === "agentMessage");
    const lastAgentId = string(agentItems.at(-1)?.id);
    for (const item of turn.items) {
      const id = string(item.id); if (!id) continue;
      if (item.type === "userMessage") {
        const operationId = string(item.clientId); if (operationId) operationIds.push(operationId);
        const text = textInput(item.content);
        if (eligible && text) emit({ type: "user", id, turnId: turn.id, text, ...(operationId ? { operationId } : {}) });
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.delivery !== "async" && eligible) {
        if (turn.status === "inProgress" || item.phase === "commentary") {
          emit({ type: "progress", id, turnId: turn.id, text: item.text });
        } else if (turn.status === "completed" && (item.phase === "final_answer" || item.phase == null) && id === lastAgentId) {
          const event = { type: "final", id, turnId: turn.id, text: item.text } as const;
          const missingAcceptedFinal = recoverFinal.has(turn.id) && !(options.finalRecorded?.(id) ?? false);
          emit(event, missingAcceptedFinal || rebaseline && previousActive.has(turn.id));
        }
      }
    }
    if (operationIds.length) inputs.push({ turnId: turn.id, status: turn.status, operationIds });
    if (eligible) {
      const status = turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed"
        : turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : null;
      if (status) emit({ type: "status", id: `status:${turn.id}`, turnId: turn.id, status }, previous === null && status === "running");
    }
  }
  const latest = turns.at(-1);
  const failureInfo = latest?.error?.codexErrorInfo;
  const failed = snapshot.runtimeStatus === "systemError" || latest?.status === "failed";
  const details: TaskDetails = {
    title: snapshot.title,
    ...(failed ? { failure: failureInfo === "usageLimitExceeded" ? "usageLimit" as const : "systemError" as const } : {}),
    status: snapshot.runtimeStatus === "active" || active.length ? "running" : failed ? "failed"
      : latest?.status === "interrupted" ? "interrupted" : snapshot.runtimeStatus === "idle" ? "idle" : "unavailable",
    workspace: snapshot.cwd, model: snapshot.model, effort: snapshot.effort,
    nextModel: snapshot.model, nextEffort: snapshot.effort, context: snapshot.context,
  };
  return {
    checkpoint: { since, lastObservedAt: now, activeAtAttach, active, seen }, events, details,
    questions: [] as CodexQuestions[], inputs, latestTurnId: latest?.id ?? "runtime", activeTurnId: active.at(-1) ?? null,
  };
}

class AppServerTaskStream implements TaskStateStream {
  private unsubscribeNotification: (() => void) | null = null;
  private unsubscribeDisconnect: (() => void) | null = null;
  private snapshot: NativeSnapshot | null = null;
  private readonly queued: AppServerEnvelope[] = [];
  private closed = false;

  constructor(private readonly rpc: AppServerRpc, readonly task: TaskRef,
    private readonly onState: (state: TaskState, initial: boolean) => void,
    private readonly onError: (error: Error) => void) {}

  async start(): Promise<void> {
    this.unsubscribeNotification = this.rpc.onNotification(notification => this.receive(notification));
    this.unsubscribeDisconnect = this.rpc.onDisconnect?.(error => { if (!this.closed) this.onError(error); }) ?? null;
    try {
      const result = await this.rpc.request("thread/resume", {
        threadId: this.task.threadId, excludeTurns: true,
        initialTurnsPage: { limit: 100, sortDirection: "desc", itemsView: "full" },
      });
      const thread = isObject(result.thread) ? result.thread : null;
      if (!thread || thread.id !== this.task.threadId) throw new AppServerUnavailableError("Codex открыл другую задачу.");
      const initial = isObject(result.initialTurnsPage) ? result.initialTurnsPage : {};
      const turns = Array.isArray(initial.data) ? initial.data.map(parseTurn).filter((turn): turn is NativeTurn => !!turn) : [];
      let cursor = string(initial.nextCursor); const cursors = new Set<string>();
      while (cursor) {
        if (cursors.has(cursor)) throw new AppServerUnavailableError("Codex повторил страницу истории.");
        cursors.add(cursor);
        const page = await this.rpc.request("thread/turns/list", {
          threadId: this.task.threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "full",
        });
        if (!Array.isArray(page.data)) throw new AppServerUnavailableError("Codex вернул неполную историю.");
        turns.push(...page.data.map(parseTurn).filter((turn): turn is NativeTurn => !!turn));
        cursor = string(page.nextCursor);
      }
      this.snapshot = this.makeSnapshot(thread, result, turns);
      for (const notification of this.queued.splice(0)) this.apply(notification);
      if (!this.closed) this.onState(this.snapshot, true);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async verifyOwner(): Promise<void> {
    const result = await this.rpc.request("thread/read", { threadId: this.task.threadId, includeTurns: false });
    if (!isObject(result.thread) || result.thread.id !== this.task.threadId) throw new AppServerUnavailableError("Codex больше не владеет задачей.");
  }

  private makeSnapshot(thread: JsonObject, result: JsonObject, values: NativeTurn[]): NativeSnapshot {
    const byId = new Map(values.map(turn => [turn.id, turn]));
    const turns = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    const status = isObject(thread.status) ? String(thread.status.type ?? "") : "";
    return { kind: "app-server", threadId: this.task.threadId, title: string(thread.name), cwd: string(result.cwd) ?? string(thread.cwd),
      model: string(result.model), effort: string(result.reasoningEffort), runtimeStatus: status, context: null, turns };
  }

  private receive(notification: AppServerEnvelope): void {
    if (notification.params.threadId !== this.task.threadId) return;
    if (!this.snapshot) { this.queued.push(notification); return; }
    this.apply(notification);
    if (!this.closed) this.onState(this.snapshot, false);
  }

  private apply(notification: AppServerEnvelope): void {
    const current = this.snapshot; if (!current) return;
    let turns = [...current.turns];
    const upsert = (value: unknown): void => {
      const turn = parseTurn(value); if (!turn) return;
      const index = turns.findIndex(item => item.id === turn.id);
      const existing = index >= 0 ? turns[index] : undefined;
      const complete = { ...turn,
        startedAt: turn.startedAt || existing?.startedAt || Date.now(),
        items: turn.items.length ? turn.items : existing?.items ?? [],
      };
      if (index >= 0) turns[index] = complete; else turns.push(complete);
      turns.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    };
    if (notification.method === "turn/started" || notification.method === "turn/completed") upsert(notification.params.turn);
    else if (notification.method === "item/started" || notification.method === "item/completed") {
      const turnId = string(notification.params.turnId); const item = isObject(notification.params.item) ? notification.params.item : null;
      if (turnId && item) turns = turns.map(turn => turn.id !== turnId ? turn : { ...turn,
        items: [...turn.items.filter(existing => existing.id !== item.id), item] });
    } else if (notification.method === "item/agentMessage/delta") {
      const turnId = string(notification.params.turnId); const itemId = string(notification.params.itemId);
      if (turnId && itemId && typeof notification.params.delta === "string") turns = turns.map(turn => turn.id !== turnId ? turn : { ...turn,
        items: turn.items.map(item => item.id === itemId ? { ...item, text: `${typeof item.text === "string" ? item.text : ""}${notification.params.delta}` } : item) });
    }
    let title = current.title; let model = current.model; let effort = current.effort;
    let cwd = current.cwd; let runtimeStatus = current.runtimeStatus; let context = current.context;
    if (notification.method === "thread/name/updated") title = string(notification.params.threadName);
    if (notification.method === "thread/status/changed" && isObject(notification.params.status)) runtimeStatus = String(notification.params.status.type ?? "");
    if (notification.method === "thread/settings/updated" && isObject(notification.params.threadSettings)) {
      const settings = notification.params.threadSettings; model = string(settings.model); effort = string(settings.effort); cwd = string(settings.cwd);
    }
    if (notification.method === "thread/tokenUsage/updated" && isObject(notification.params.tokenUsage)) {
      const usage = notification.params.tokenUsage; const last = isObject(usage.last) ? usage.last : {};
      const window = usage.modelContextWindow; const used = last.totalTokens;
      context = typeof window === "number" && window > 0 && typeof used === "number" && used >= 0
        ? { used: Math.min(used, window), window, percent: Math.min(100, used / window * 100) } : null;
    }
    this.snapshot = { ...current, title, model, effort, cwd, runtimeStatus, context, turns };
  }

  close(): void {
    this.closed = true; this.unsubscribeNotification?.(); this.unsubscribeDisconnect?.();
    this.unsubscribeNotification = null; this.unsubscribeDisconnect = null; this.queued.length = 0;
  }
}

/** Native task streams for one profile-scoped App Server connection. */
export class AppServerTaskStateTransport implements TaskStateTransport {
  private readonly streams = new Set<AppServerTaskStream>();
  constructor(private readonly rpc: AppServerRpc) {}
  subscribe(task: TaskRef, onState: (state: TaskState, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream {
    const stream = new AppServerTaskStream(this.rpc, task, onState, onError);
    this.streams.add(stream); return stream;
  }
  close(): void { for (const stream of this.streams) stream.close(); this.streams.clear(); }
}
