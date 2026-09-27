/**
 * Qualification guard for an explicitly opted-in, plain-text stock App Server
 * queue subset. It performs no RPC, scheduling, reconnect, or feature enablement.
 *
 * The caller must serialize lifecycle writers and supply complete queue, active,
 * and terminal evidence. A caller-provided revision is a fence for this object;
 * it is not a global atomicity or authority proof.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface HomogeneousQueueSettings {
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly approvalPolicy: JsonValue;
  readonly approvalsReviewer: JsonValue;
  readonly permissions: string | null;
  readonly sandboxPolicy: JsonObject;
  readonly model: string;
  readonly serviceTier: JsonValue;
  readonly effort: JsonValue;
  readonly summary: JsonValue;
  readonly collaborationMode: JsonValue;
  readonly personality: JsonValue;
}

export interface PlainTextQueueInput {
  readonly type: "text";
  readonly text: string;
  readonly text_elements?: readonly [];
}

export interface QueueObservation {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly revision: number;
  readonly complete: boolean;
  readonly serialized: boolean;
  readonly effectiveSettings: HomogeneousQueueSettings;
  readonly queueClientIds: readonly string[];
  readonly activeClientIds: readonly string[];
  readonly terminalClientIds: readonly string[];
  readonly idle: boolean;
}

export interface HomogeneousQueuePolicyOptions {
  readonly taskId: string;
  readonly ownerEpoch: string;
}

export interface ReserveAddRequest {
  readonly ownerEpoch: string;
  readonly clientUserMessageId: string;
  readonly input: readonly PlainTextQueueInput[];
  readonly effectiveSettings: HomogeneousQueueSettings;
}

export interface ReserveSettingsChangeRequest {
  readonly ownerEpoch: string;
  readonly effectiveSettings: HomogeneousQueueSettings;
}

export type MutationOutcome = "accepted" | "definitively-rejected" | "unknown";

interface ObservationTicket {
  readonly kind: "observation";
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly epochGeneration: number;
  readonly serial: number;
  readonly sequence: number;
}

export interface QueueAddTicket {
  readonly kind: "add";
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly epochGeneration: number;
  readonly clientUserMessageId: string;
  readonly sequence: number;
}

export interface SettingsChangeTicket {
  readonly kind: "settings";
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly epochGeneration: number;
  readonly sequence: number;
}

export interface HomogeneousQueuePolicyStatus {
  readonly taskId: string;
  readonly ownerEpoch: string;
  readonly revision: number;
  readonly locked: boolean;
  readonly unresolvedCount: number;
  readonly settingsWriteOutcome: MutationOutcome | "pending" | null;
  readonly foreign: boolean;
  readonly poisoned: boolean;
}

interface Operation {
  readonly ownerEpoch: string;
  readonly epochGeneration: number;
  outcome: MutationOutcome | "pending";
  terminal: boolean;
  readonly sequence: number;
}

interface SettingsWrite {
  readonly sequence: number;
  readonly previous: string;
  readonly desired: string;
  outcome: MutationOutcome | "pending";
}

const settingKeys = ["cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer",
  "permissions", "sandboxPolicy", "model", "serviceTier", "effort", "summary",
  "collaborationMode", "personality"] as const;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonical(value: unknown): string {
  const visit = (current: unknown, seen: Set<object>): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current !== "object" || seen.has(current)) throw new Error("unsupported JSON value");
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.keys(current).length !== current.length
          || Array.from({ length: current.length }, (_, index) => !Object.hasOwn(current, index)).some(Boolean)) {
          throw new Error("sparse or extended JSON array");
        }
        return current.map(item => visit(item, seen));
      }
      if (!isPlainObject(current)) throw new Error("non-plain JSON object");
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of Object.keys(current).sort()) {
        if (unsafeKeys.has(key)) throw new Error("unsafe JSON key");
        result[key] = visit(current[key], seen);
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };
  return JSON.stringify(visit(value, new Set<object>()));
}

function validSettings(value: unknown): string {
  if (!isPlainObject(value) || Object.keys(value).sort().join("|") !== [...settingKeys].sort().join("|")) {
    throw new Error("incomplete or unsupported effective settings");
  }
  if (typeof value.cwd !== "string" || !value.cwd
    || !Array.isArray(value.runtimeWorkspaceRoots)
    || value.runtimeWorkspaceRoots.some(root => typeof root !== "string" || !root)
    || typeof value.model !== "string" || !value.model
    || !((typeof value.permissions === "string" && value.permissions) || value.permissions === null)
    || !isPlainObject(value.sandboxPolicy)) {
    throw new Error("invalid effective execution settings");
  }
  return canonical(value);
}

function validInput(input: readonly PlainTextQueueInput[]): void {
  if (!Array.isArray(input) || input.length !== 1) throw new Error("only one plain text item supported");
  const item: unknown = input[0];
  if (!isPlainObject(item) || item.type !== "text" || typeof item.text !== "string" || !item.text.trim()
    || Object.keys(item).some(key => key !== "type" && key !== "text" && key !== "text_elements")
    || (item.text_elements !== undefined && (!Array.isArray(item.text_elements) || item.text_elements.length !== 0))) {
    throw new Error("unsupported queue input");
  }
  canonical(input);
}

function validIds(value: readonly string[], name: string): readonly string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id) || new Set(value).size !== value.length) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

/** Pure, opt-in admission state. Construction alone changes no runtime behavior. */
export class HomogeneousStockQueuePolicy {
  private readonly taskId: string;
  private ownerEpoch: string;
  private epochGeneration = 0;
  private revision = -1;
  private serial = 0;
  private nextTicket = 0;
  private settings: string | null = null;
  private lockSettings: string | null = null;
  private readonly operations = new Map<string, Operation>();
  private readonly usedIds = new Set<string>();
  private settingsWrite: SettingsWrite | null = null;
  private idle = false;
  private foreign = false;
  private poisoned = false;
  private observedBusy = false;
  private readonly observationTickets = new WeakSet<ObservationTicket>();

  constructor({ taskId, ownerEpoch }: HomogeneousQueuePolicyOptions) {
    if (typeof taskId !== "string" || !taskId || typeof ownerEpoch !== "string" || !ownerEpoch) {
      throw new Error("task and owner epoch required");
    }
    this.taskId = taskId;
    this.ownerEpoch = ownerEpoch;
  }

  beginObservation(): ObservationTicket {
    const ticket = Object.freeze({ kind: "observation" as const, taskId: this.taskId, ownerEpoch: this.ownerEpoch,
      epochGeneration: this.epochGeneration, serial: this.serial, sequence: ++this.nextTicket });
    this.observationTickets.add(ticket);
    return ticket;
  }

  observe(ticket: ObservationTicket, state: QueueObservation): HomogeneousQueuePolicyStatus {
    this.checkTicket(ticket, "observation");
    if (!this.observationTickets.has(ticket)) throw new Error("unknown or reused observation ticket");
    if (ticket.serial !== this.serial || state.taskId !== this.taskId || state.ownerEpoch !== this.ownerEpoch
      || state.complete !== true || state.serialized !== true || !Number.isSafeInteger(state.revision)
      || state.revision <= this.revision || typeof state.idle !== "boolean") {
      throw new Error("stale, incomplete, or non-serialized observation");
    }
    const observedSettings = validSettings(state.effectiveSettings);
    const queue = validIds(state.queueClientIds, "queue IDs");
    const active = validIds(state.activeClientIds, "active IDs");
    const terminal = validIds(state.terminalClientIds, "terminal IDs");
    if (queue.some(id => active.includes(id) || terminal.includes(id)) || active.some(id => terminal.includes(id))) {
      throw new Error("contradictory queue, active, terminal state");
    }
    this.observationTickets.delete(ticket);
    this.revision = state.revision;
    this.idle = state.idle;
    this.foreign = [...queue, ...active].some(id => !this.operations.has(id));
    this.observedBusy = !state.idle || queue.length > 0 || active.length > 0;
    if (this.lockSettings !== null && observedSettings !== this.lockSettings) this.poisoned = true;
    if (this.settingsWrite) {
      const drained = state.idle && queue.length === 0 && active.length === 0;
      if ((this.settingsWrite.outcome === "accepted" && observedSettings === this.settingsWrite.desired && drained)
        || (this.settingsWrite.outcome === "definitively-rejected" && observedSettings === this.settingsWrite.previous && drained)) {
        this.settingsWrite = null;
      }
    }
    this.settings = observedSettings;
    for (const id of terminal) {
      const operation = this.operations.get(id);
      if (operation && operation.ownerEpoch === this.ownerEpoch && operation.epochGeneration === this.epochGeneration
        && operation.outcome !== "definitively-rejected") operation.terminal = true;
    }
    if (state.idle && queue.length === 0 && active.length === 0 && !this.foreign && !this.poisoned && !this.settingsWrite
      && [...this.operations.values()].every(operation => operation.outcome === "definitively-rejected"
        || (operation.terminal && (operation.outcome === "accepted" || operation.outcome === "unknown")))) {
      this.operations.clear();
      this.lockSettings = null;
    }
    return this.status();
  }

  reserveAdd({ ownerEpoch, clientUserMessageId, input, effectiveSettings }: ReserveAddRequest): QueueAddTicket {
    this.requireEpoch(ownerEpoch);
    validInput(input);
    const requested = validSettings(effectiveSettings);
    if (typeof clientUserMessageId !== "string" || !clientUserMessageId || this.usedIds.has(clientUserMessageId)) {
      throw new Error("missing or reused client message ID");
    }
    if (this.settings === null || this.settingsWrite || this.poisoned || this.foreign || (this.observedBusy && this.operations.size === 0)
      || requested !== this.settings || (this.lockSettings !== null && requested !== this.lockSettings)) {
      throw new Error("stock queue setting admission denied");
    }
    const ticket = Object.freeze({ kind: "add" as const, taskId: this.taskId, ownerEpoch, epochGeneration: this.epochGeneration,
      clientUserMessageId, sequence: ++this.nextTicket });
    this.operations.set(clientUserMessageId, { ownerEpoch, epochGeneration: this.epochGeneration, outcome: "pending", terminal: false, sequence: ticket.sequence });
    this.usedIds.add(clientUserMessageId);
    this.lockSettings = requested;
    this.serial++;
    return ticket;
  }

  recordAddOutcome(ticket: QueueAddTicket, outcome: MutationOutcome): void {
    this.checkTicket(ticket, "add");
    const operation = this.operations.get(ticket.clientUserMessageId);
    if (!operation || operation.sequence !== ticket.sequence || operation.outcome !== "pending"
      || (outcome !== "accepted" && outcome !== "definitively-rejected" && outcome !== "unknown")) throw new Error("invalid add outcome");
    operation.outcome = outcome;
    this.serial++;
  }

  reserveSettingsChange({ ownerEpoch, effectiveSettings }: ReserveSettingsChangeRequest): SettingsChangeTicket {
    this.requireEpoch(ownerEpoch);
    const desired = validSettings(effectiveSettings);
    if (this.settings === null || this.lockSettings !== null || this.operations.size > 0 || this.settingsWrite || this.foreign
      || this.poisoned || !this.idle || this.observedBusy) throw new Error("settings frozen until authoritative drain");
    const ticket = Object.freeze({ kind: "settings" as const, taskId: this.taskId, ownerEpoch, epochGeneration: this.epochGeneration,
      sequence: ++this.nextTicket });
    this.settingsWrite = { sequence: ticket.sequence, previous: this.settings, desired, outcome: "pending" };
    this.serial++;
    return ticket;
  }

  recordSettingsOutcome(ticket: SettingsChangeTicket, outcome: MutationOutcome): void {
    this.checkTicket(ticket, "settings");
    if (!this.settingsWrite || this.settingsWrite.sequence !== ticket.sequence || this.settingsWrite.outcome !== "pending"
      || (outcome !== "accepted" && outcome !== "definitively-rejected" && outcome !== "unknown")) {
      throw new Error("invalid settings outcome");
    }
    this.settingsWrite.outcome = outcome;
    this.serial++;
  }

  changeOwnerEpoch(ownerEpoch: string): void {
    if (typeof ownerEpoch !== "string" || !ownerEpoch || ownerEpoch === this.ownerEpoch) throw new Error("new owner epoch required");
    this.ownerEpoch = ownerEpoch;
    this.epochGeneration++;
    this.revision = -1;
    this.serial++;
    this.settings = null;
    this.idle = false;
    this.observedBusy = false;
    for (const operation of this.operations.values()) if (operation.outcome === "pending") operation.outcome = "unknown";
    if (this.settingsWrite?.outcome === "pending") this.settingsWrite.outcome = "unknown";
  }

  status(): HomogeneousQueuePolicyStatus {
    return Object.freeze({ taskId: this.taskId, ownerEpoch: this.ownerEpoch, revision: this.revision,
      locked: this.lockSettings !== null || this.operations.size > 0 || this.settingsWrite !== null || this.observedBusy || this.foreign || this.poisoned,
      unresolvedCount: [...this.operations.values()].filter(operation => operation.outcome !== "definitively-rejected" && !operation.terminal).length,
      settingsWriteOutcome: this.settingsWrite?.outcome ?? null, foreign: this.foreign, poisoned: this.poisoned });
  }

  private requireEpoch(ownerEpoch: string): void {
    if (ownerEpoch !== this.ownerEpoch) throw new Error("owner epoch mismatch");
  }

  private checkTicket(ticket: ObservationTicket | QueueAddTicket | SettingsChangeTicket, kind: "observation" | "add" | "settings"): void {
    if (ticket.kind !== kind || ticket.taskId !== this.taskId || ticket.ownerEpoch !== this.ownerEpoch || ticket.epochGeneration !== this.epochGeneration) {
      throw new Error("stale task or owner ticket");
    }
  }
}
