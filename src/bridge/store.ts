import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { taskKey, type DesktopTask, type TaskCreationUpdate, type TaskRef } from "../core/codex-tasks.js";
import type { Binding, BridgeInput, Delivery, ManagerAction, MessageHandle, NewTaskDraft, TaskTransferRecord, View } from "./contracts.js";
import { VK_MAX_INLINE_BUTTONS } from "./contracts.js";
import { comparablePath } from "../core/paths.js";
import type { LocalInputFile } from "../domain/models.js";
import type { TaskObservationCheckpoint } from "../core/task-observation.js";

const bindingColumns = `id TEXT PRIMARY KEY, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL,
  peer_id INTEGER UNIQUE, chat_id INTEGER, chat_state TEXT NOT NULL DEFAULT 'planned',
  attached INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
  source_id TEXT NOT NULL DEFAULT '', source_label TEXT, rollout_path TEXT,
  UNIQUE(host_id, thread_id, source_id)`;

export function migrateBindingSources(db: Database): void {
  if ((db.prepare("PRAGMA table_info(bridge_bindings)").all() as { name: string }[]).some(column => column.name === "source_id")) return;
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE bridge_bindings_v2 (${bindingColumns});
        INSERT INTO bridge_bindings_v2(id, host_id, thread_id, title, peer_id, chat_id, chat_state, attached, paused)
          SELECT id, host_id, thread_id, title, peer_id, chat_id, chat_state, attached, paused FROM bridge_bindings;
        DROP TABLE bridge_bindings;
        ALTER TABLE bridge_bindings_v2 RENAME TO bridge_bindings;`);
      if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Binding migration failed reference validation");
    })();
  } finally { db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`); }
}

export function migrateInboxJournal(db: Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(bridge_inbox)").all() as { name: string }[]).map(column => column.name));
  if (!columns.has("payload")) db.exec("ALTER TABLE bridge_inbox ADD COLUMN payload TEXT");
  if (!columns.has("received_at")) db.exec("ALTER TABLE bridge_inbox ADD COLUMN received_at INTEGER");
  if (!columns.has("replay_after")) db.exec("ALTER TABLE bridge_inbox ADD COLUMN replay_after INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS bridge_inbox_replay ON bridge_inbox(state, replay_after)");
}

interface BindingRow { id: string; host_id: string; thread_id: string; title: string; peer_id: number | null; chat_id: number | null; chat_state: Binding["chatState"]; attached: number; paused: number; source_id: string; source_label: string | null; rollout_path: string | null }
export type ManagedOwnerBindingState = "registering" | "ready" | "unavailable" | "handoff_pending" | "retired";
export interface ManagedOwnerProcessIdentity { readonly pid: number; readonly birthTicks: string; }
export interface ManagedOwnerBindingEvidence {
  readonly backendGeneration?: number;
  readonly registryRevision?: number;
  readonly endpointRef?: string;
  readonly host?: ManagedOwnerProcessIdentity;
  readonly backend?: ManagedOwnerProcessIdentity;
}
export interface ManagedOwnerBindingClaim {
  readonly ownerEpoch: string;
  readonly canonicalHome: string;
  readonly familyRoot: string;
  readonly evidence?: ManagedOwnerBindingEvidence;
}
export interface ManagedOwnerBinding {
  readonly id: string;
  readonly bindingId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly sourceId: string;
  readonly ownerEpoch: string;
  readonly canonicalHome: string;
  readonly familyRoot: string;
  readonly state: ManagedOwnerBindingState;
  readonly revision: number;
  readonly evidence: Readonly<{
    readonly backendGeneration: number | null;
    readonly registryRevision: number | null;
    readonly endpointRef: string | null;
    readonly host: ManagedOwnerProcessIdentity | null;
    readonly backend: ManagedOwnerProcessIdentity | null;
  }>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface ManagedOwnerBindingRow {
  id: string; binding_id: string; host_id: string; thread_id: string; source_id: string;
  owner_epoch: string; canonical_home: string; family_root: string; state: ManagedOwnerBindingState;
  revision: number; backend_generation: number | null; registry_revision: number | null; endpoint_ref: string | null;
  host_pid: number | null; host_birth: string | null; backend_pid: number | null; backend_birth: string | null;
  created_at: number; updated_at: number;
}
export interface DeliveryFailure {
  readonly at: number;
  readonly type: "rate_limit" | "transient";
  readonly kind: Delivery["kind"];
  readonly operation: "send" | "edit" | "delete";
  readonly retryAfterMs?: number;
}
export interface DeliveryHealthStats {
  readonly activePending: number;
  readonly criticalPending: number;
  readonly criticalOldestId: number | null;
  readonly streamPending: number;
  readonly inactivePending: number;
  readonly pauseRemainingMs: number;
  readonly lastFailure: DeliveryFailure | null;
  readonly lastSuccessAt: number | null;
}

export interface EditableVkRequest {
  readonly messageId: number;
  readonly senderId: number;
  readonly operationId: string;
  readonly turnId: string | null;
  readonly mode: "start" | "steer" | "fallback" | "unconfirmed";
  readonly text: string;
  readonly author?: { readonly id: number; readonly name: string };
  readonly inputFiles?: readonly LocalInputFile[];
  readonly outboxDir?: string;
}

interface AcceptedTaskTurn {
  readonly turnId: string;
  readonly operationId: string;
}
interface QueuedTaskInput {
  readonly operationId: string;
  readonly queuedId: string;
  readonly acceptedAt: number;
}

export interface DesktopHandoffState {
  readonly taskKey: string;
  readonly status: "launching" | "launched" | "live";
  readonly updatedAt: number;
}
export interface SavedInputBatch {
  readonly id: string;
  readonly peerId: number;
  readonly parts: readonly BridgeInput[];
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly state: "collecting" | "dispatching";
}
function binding(row: BindingRow): Binding {
  return { id: row.id, hostId: row.host_id, threadId: row.thread_id, title: row.title, peerId: row.peer_id, chatId: row.chat_id, chatState: row.chat_state, attached: row.attached === 1, paused: row.paused === 1,
    ...(row.source_id ? { sourceId: row.source_id } : {}), ...(row.source_label ? { sourceLabel: row.source_label } : {}), ...(row.rollout_path ? { rolloutPath: row.rollout_path } : {}) };
}

const managedOwnerStates = new Set<ManagedOwnerBindingState>(["registering", "ready", "unavailable", "handoff_pending", "retired"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const endpointRef = uuid;

function managedText(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error(`Invalid managed owner ${name}`);
  return value;
}
function managedCanonicalHome(value: unknown): string {
  const home = managedText(value, "canonical home", 4096);
  if (!(path.isAbsolute(home) || path.win32.isAbsolute(home))) throw new Error("Invalid managed owner canonical home");
  return comparablePath(home);
}
function managedIdentity(value: unknown, name: string): ManagedOwnerProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid managed owner ${name}`);
  const item = value as Record<string, unknown>;
  const pid = item.pid, birthTicks = item.birthTicks;
  if (Object.keys(item).length !== 2 || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
    typeof birthTicks !== "string" || !/^[1-9]\d{0,23}$/u.test(birthTicks))
    throw new Error(`Invalid managed owner ${name}`);
  return Object.freeze({ pid, birthTicks });
}
function optionalManagedIdentity(value: number | null, birth: string | null): ManagedOwnerProcessIdentity | null {
  if (value === null && birth === null) return null;
  return managedIdentity({ pid: value, birthTicks: birth }, "stored identity");
}
function managedEvidence(value: unknown): ManagedOwnerBindingEvidence {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid managed owner evidence");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["backendGeneration", "registryRevision", "endpointRef", "host", "backend"].includes(key)))
    throw new Error("Invalid managed owner evidence");
  const result: { backendGeneration?: number; registryRevision?: number; endpointRef?: string;
    host?: ManagedOwnerProcessIdentity; backend?: ManagedOwnerProcessIdentity } = {};
  if (Object.hasOwn(item, "backendGeneration")) {
    const backendGeneration = item.backendGeneration;
    if (typeof backendGeneration !== "number" || !Number.isSafeInteger(backendGeneration) || backendGeneration <= 0) throw new Error("Invalid managed owner backend generation");
    result.backendGeneration = backendGeneration;
  }
  if (Object.hasOwn(item, "registryRevision")) {
    const registryRevision = item.registryRevision;
    if (typeof registryRevision !== "number" || !Number.isSafeInteger(registryRevision) || registryRevision < 0) throw new Error("Invalid managed owner registry revision");
    result.registryRevision = registryRevision;
  }
  if (Object.hasOwn(item, "endpointRef")) {
    if (typeof item.endpointRef !== "string" || !endpointRef.test(item.endpointRef)) throw new Error("Invalid managed owner endpoint reference");
    result.endpointRef = item.endpointRef;
  }
  if (Object.hasOwn(item, "host")) result.host = managedIdentity(item.host, "host identity");
  if (Object.hasOwn(item, "backend")) result.backend = managedIdentity(item.backend, "backend identity");
  return Object.freeze(result);
}
function sameManagedIdentity(left: ManagedOwnerProcessIdentity | null, right: ManagedOwnerProcessIdentity | undefined): boolean {
  return left === null || right === undefined || left.pid === right.pid && left.birthTicks === right.birthTicks;
}
function sameClaimEvidence(stored: ManagedOwnerBinding["evidence"], claimed: ManagedOwnerBindingEvidence): boolean {
  return (claimed.backendGeneration === undefined || stored.backendGeneration === claimed.backendGeneration) &&
    (claimed.registryRevision === undefined || stored.registryRevision === claimed.registryRevision) &&
    (claimed.endpointRef === undefined || stored.endpointRef === claimed.endpointRef) &&
    (claimed.host === undefined || stored.host !== null && stored.host.pid === claimed.host.pid && stored.host.birthTicks === claimed.host.birthTicks) &&
    (claimed.backend === undefined || stored.backend !== null && stored.backend.pid === claimed.backend.pid && stored.backend.birthTicks === claimed.backend.birthTicks);
}
function managedBinding(row: ManagedOwnerBindingRow): ManagedOwnerBinding {
  return Object.freeze({ id: row.id, bindingId: row.binding_id, hostId: row.host_id, threadId: row.thread_id,
    sourceId: row.source_id, ownerEpoch: row.owner_epoch, canonicalHome: row.canonical_home, familyRoot: row.family_root,
    state: row.state, revision: row.revision, evidence: Object.freeze({ backendGeneration: row.backend_generation,
      registryRevision: row.registry_revision, endpointRef: row.endpoint_ref,
      host: optionalManagedIdentity(row.host_pid, row.host_birth), backend: optionalManagedIdentity(row.backend_pid, row.backend_birth) }),
    createdAt: row.created_at, updatedAt: row.updated_at });
}

export class BridgeStore {
  private readonly db: Database;

  constructor(filename = ":memory:") {
    this.db = new DatabaseConstructor(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_bindings (${bindingColumns});
      CREATE TABLE IF NOT EXISTS bridge_inbox (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT, received_at INTEGER, replay_after INTEGER
      );
      CREATE TABLE IF NOT EXISTS bridge_input_batches (
        peer_id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, parts TEXT NOT NULL, started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_actions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_operations (id TEXT PRIMARY KEY, task_key TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_operation_inputs (
        operation_id TEXT PRIMARY KEY REFERENCES bridge_operations(id),
        binding_id TEXT NOT NULL REFERENCES bridge_bindings(id), inbox_key TEXT NOT NULL, inbox_keys TEXT,
        created_at INTEGER NOT NULL, last_checked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS bridge_events (binding_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(binding_id, event_id));
      CREATE TABLE IF NOT EXISTS bridge_task_senders (
        binding_id TEXT NOT NULL REFERENCES bridge_bindings(id), sender_id INTEGER NOT NULL,
        PRIMARY KEY(binding_id, sender_id)
      );
      CREATE TABLE IF NOT EXISTS bridge_delivery (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, binding_id TEXT REFERENCES bridge_bindings(id),
        peer_id INTEGER NOT NULL, kind TEXT NOT NULL, view TEXT NOT NULL, first_view TEXT, handle TEXT,
        revision INTEGER NOT NULL DEFAULT 1, delivered_revision INTEGER NOT NULL DEFAULT 0,
        priority_revision INTEGER NOT NULL DEFAULT 0, turn_id TEXT
      );
      CREATE TABLE IF NOT EXISTS managed_owner_bindings (
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bridge_bindings(id),
        host_id TEXT NOT NULL, thread_id TEXT NOT NULL, source_id TEXT NOT NULL,
        owner_epoch TEXT NOT NULL, canonical_home TEXT NOT NULL, family_root TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL,
        backend_generation INTEGER, registry_revision INTEGER, endpoint_ref TEXT,
        host_pid INTEGER, host_birth TEXT, backend_pid INTEGER, backend_birth TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS managed_owner_active_task
        ON managed_owner_bindings(host_id, thread_id, source_id) WHERE state <> 'retired';
      CREATE INDEX IF NOT EXISTS managed_owner_by_binding ON managed_owner_bindings(binding_id, created_at DESC);
    `);
    migrateBindingSources(this.db);
    migrateInboxJournal(this.db);
    const operationInputColumns = new Set((this.db.prepare("PRAGMA table_info(bridge_operation_inputs)").all() as { name: string }[]).map(column => column.name));
    if (!operationInputColumns.has("inbox_keys")) this.db.exec("ALTER TABLE bridge_operation_inputs ADD COLUMN inbox_keys TEXT");
    const actionColumns = new Set((this.db.prepare("PRAGMA table_info(bridge_actions)").all() as { name: string }[]).map(column => column.name));
    if (!actionColumns.has("peer_id")) this.db.exec("ALTER TABLE bridge_actions ADD COLUMN peer_id INTEGER");
    if (!actionColumns.has("consumed")) this.db.exec("ALTER TABLE bridge_actions ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0");
    const deliveryColumns = new Set((this.db.prepare("PRAGMA table_info(bridge_delivery)").all() as { name: string }[]).map(column => column.name));
    if (!deliveryColumns.has("priority_revision")) this.db.exec("ALTER TABLE bridge_delivery ADD COLUMN priority_revision INTEGER NOT NULL DEFAULT 0");
    if (!deliveryColumns.has("turn_id")) this.db.exec("ALTER TABLE bridge_delivery ADD COLUMN turn_id TEXT");
  }

  close(): void { this.db.close(); }
  // Reserve the writer before reading a revision. A deferred read transaction
  // cannot upgrade after another process commits, even with busy_timeout set.
  atomic<T>(operation: () => T): T { return this.db.transaction(operation).immediate(); }

  assertOwner(ownerId: number, groupId: number): void {
    const fingerprint = createHash("sha256").update(JSON.stringify([ownerId, groupId])).digest("hex");
    this.atomic(() => {
      const saved = this.getValue<string>("identity");
      if (saved !== null && saved !== fingerprint) throw new Error("This bridge database belongs to another configured account");
      this.setValue("identity", fingerprint);
    });
  }

  assertPrimaryHome(home: string): void {
    const fingerprint = createHash("sha256").update(comparablePath(home)).digest("hex");
    const saved = this.getValue<string>("primary-codex-home");
    if (saved !== null && saved !== fingerprint) throw new Error("Changing the primary CODEX_HOME requires a separate BOT_DATA_DIR; add other directories through CODEX_EXTRA_HOMES");
    this.setValue("primary-codex-home", fingerprint);
  }

  recover(): void {
    this.atomic(() => {
      // Do not replay the former command/file summaries after an upgrade.
      this.db.prepare("UPDATE bridge_delivery SET delivered_revision = revision WHERE kind = 'technical'").run();
      // Menus are requested snapshots. Do not resurrect queued panels on restart.
      this.db.prepare("UPDATE bridge_delivery SET delivered_revision = revision WHERE kind = 'panel'").run();
      // Navigation now lives in replies; retire unsent standalone welcome cards.
      this.db.prepare("UPDATE bridge_delivery SET delivered_revision = revision WHERE key = 'welcome:manager' OR key LIKE 'welcome:task:%'").run();
      // Resume indicators only after a fresh, source-verified desktop snapshot.
      this.db.prepare("UPDATE bridge_delivery SET delivered_revision = revision WHERE kind = 'activity'").run();
      for (const binding of this.bindings()) {
        const indicator = this.getValue<{ key: string; kind?: string }>(`activity:${binding.id}`);
        const base = indicator?.kind === "commentary" ? this.getValue<View>(`commentary-base:${indicator.key}`) : null;
        if (base && indicator && binding.attached && binding.peerId !== null) this.enqueue(indicator.key, binding.peerId, base, binding.id, true);
      }
      // Older middle pages exceeded VK's button limit and can never be sent.
      // Retire them without changing frozen payloads, message IDs or task output.
      this.db.prepare(`UPDATE bridge_delivery SET delivered_revision = revision
        WHERE kind = 'send' AND binding_id IS NULL AND handle IS NULL AND revision > delivered_revision
          AND json_array_length(view, '$.buttons') > ?
          AND (first_view IS NULL OR json_array_length(first_view, '$.buttons') > ?)`).run(VK_MAX_INLINE_BUTTONS, VK_MAX_INLINE_BUTTONS);
      this.db.prepare("UPDATE bridge_bindings SET chat_state = 'uncertain' WHERE chat_state = 'creating'").run();
      // Only a task prompt still preparing local attachments is known not to
      // have reached Codex. All other in-flight handlers may have mutated state.
      this.db.prepare("UPDATE bridge_inbox SET state = 'retryable' WHERE state = 'preparing'").run();
      this.db.prepare("UPDATE bridge_inbox SET state = 'uncertain', payload = NULL WHERE state IN ('processing', 'sending')").run();
      this.db.prepare("UPDATE bridge_inbox SET replay_after = 0 WHERE state IN ('received', 'retryable')").run();
      this.db.prepare("UPDATE bridge_operations SET state = 'uncertain' WHERE state = 'sending'").run();
      const draft = this.getDraft();
      if (draft?.stage === "creating") this.saveDraft({ ...draft, stage: "uncertain" });
    });
  }

  ensureBinding(task: DesktopTask): Binding {
    this.db.prepare(`INSERT INTO bridge_bindings(id, host_id, thread_id, title, source_id, source_label, rollout_path) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, thread_id, source_id) DO UPDATE SET title = excluded.title, source_label = excluded.source_label,
        rollout_path = COALESCE(excluded.rollout_path, bridge_bindings.rollout_path)`).run(randomUUID(), task.hostId, task.threadId, task.title, task.sourceId ?? "", task.sourceLabel ?? null, task.rolloutPath ?? null);
    return binding(this.db.prepare("SELECT * FROM bridge_bindings WHERE host_id = ? AND thread_id = ? AND source_id = ?").get(task.hostId, task.threadId, task.sourceId ?? "") as BindingRow);
  }

  /** Persist an explicit, task-scoped managed route claim. This method does not
   * start a worker or make the route available to a router. */
  claimManagedOwner(bindingId: string, claim: ManagedOwnerBindingClaim, now = Date.now()): ManagedOwnerBinding {
    const id = managedText(bindingId, "binding ID");
    if (!claim || typeof claim !== "object" || Array.isArray(claim) ||
      Object.keys(claim).some(key => !["ownerEpoch", "canonicalHome", "familyRoot", "evidence"].includes(key)) ||
      !uuid.test(claim.ownerEpoch)) throw new Error("Invalid managed owner claim");
    const ownerEpoch = claim.ownerEpoch.toLowerCase();
    const canonicalHome = managedCanonicalHome(claim.canonicalHome);
    const familyRoot = managedText(claim.familyRoot, "family root");
    const evidence = managedEvidence(claim.evidence);
    return this.atomic(() => {
      const bindingRow = this.db.prepare("SELECT * FROM bridge_bindings WHERE id = ?").get(id) as BindingRow | undefined;
      if (!bindingRow) throw new Error("Managed owner binding does not exist");
      const existing = this.db.prepare(`SELECT * FROM managed_owner_bindings
        WHERE host_id = ? AND thread_id = ? AND source_id = ? AND state <> 'retired'`).get(
          bindingRow.host_id, bindingRow.thread_id, bindingRow.source_id) as ManagedOwnerBindingRow | undefined;
      if (existing) {
        if (existing.binding_id === id && existing.owner_epoch === ownerEpoch &&
          existing.canonical_home === canonicalHome && existing.family_root === familyRoot &&
          sameClaimEvidence(managedBinding(existing).evidence, evidence))
          return managedBinding(existing);
        throw new Error("Exact task already has an active managed owner claim");
      }
      const claimId = randomUUID();
      this.db.prepare(`INSERT INTO managed_owner_bindings(
        id, binding_id, host_id, thread_id, source_id, owner_epoch, canonical_home, family_root,
        state, revision, backend_generation, registry_revision, endpoint_ref, host_pid, host_birth,
        backend_pid, backend_birth, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registering', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        claimId, id, bindingRow.host_id, bindingRow.thread_id, bindingRow.source_id, ownerEpoch, canonicalHome, familyRoot,
        evidence.backendGeneration ?? null, evidence.registryRevision ?? null, evidence.endpointRef ?? null,
        evidence.host?.pid ?? null, evidence.host?.birthTicks ?? null,
        evidence.backend?.pid ?? null, evidence.backend?.birthTicks ?? null, now, now);
      return managedBinding(this.db.prepare("SELECT * FROM managed_owner_bindings WHERE id = ?").get(claimId) as ManagedOwnerBindingRow);
    });
  }

  managedOwner(task: TaskRef): ManagedOwnerBinding | null {
    if (!task || typeof task.hostId !== "string" || typeof task.threadId !== "string") return null;
    const row = this.db.prepare(`SELECT * FROM managed_owner_bindings
      WHERE host_id = ? AND thread_id = ? AND source_id = ? AND state <> 'retired'`).get(
      task.hostId, task.threadId, task.sourceId ?? "") as ManagedOwnerBindingRow | undefined;
    return row ? managedBinding(row) : null;
  }

  /** Revision-CAS transition. Existing process/endpoint identity can only be
   * filled in, never replaced; endpoint loss therefore retains the claim. */
  transitionManagedOwner(expected: ManagedOwnerBinding, state: Exclude<ManagedOwnerBindingState, "retired">,
    evidenceInput: ManagedOwnerBindingEvidence = {}, now = Date.now()): ManagedOwnerBinding {
    if (!expected || !managedOwnerStates.has(state)) throw new Error("Invalid managed owner transition");
    const evidence = managedEvidence(evidenceInput);
    return this.atomic(() => {
      const row = this.db.prepare("SELECT * FROM managed_owner_bindings WHERE id = ?").get(expected.id) as ManagedOwnerBindingRow | undefined;
      if (!row || row.revision !== expected.revision || row.state !== expected.state || row.state === "retired")
        throw new Error("Stale managed owner claim");
      const allowed: Readonly<Record<Exclude<ManagedOwnerBindingState, "retired">, readonly ManagedOwnerBindingState[]>> = {
        registering: ["ready", "unavailable", "handoff_pending"],
        ready: ["ready", "unavailable", "handoff_pending"],
        unavailable: ["ready", "unavailable", "handoff_pending"],
        handoff_pending: ["handoff_pending"],
      };
      if (!allowed[row.state].includes(state)) throw new Error("Invalid managed owner state transition");
      const prior = managedBinding(row).evidence;
      if (prior.backendGeneration !== null && evidence.backendGeneration !== undefined && prior.backendGeneration !== evidence.backendGeneration ||
        prior.endpointRef !== null && evidence.endpointRef !== undefined && prior.endpointRef !== evidence.endpointRef ||
        !sameManagedIdentity(prior.host, evidence.host) || !sameManagedIdentity(prior.backend, evidence.backend) ||
        prior.registryRevision !== null && evidence.registryRevision !== undefined && evidence.registryRevision < prior.registryRevision)
        throw new Error("Managed owner proof mismatch");
      const next = {
        backendGeneration: evidence.backendGeneration ?? prior.backendGeneration,
        registryRevision: evidence.registryRevision ?? prior.registryRevision,
        endpointRef: evidence.endpointRef ?? prior.endpointRef,
        host: evidence.host ?? prior.host,
        backend: evidence.backend ?? prior.backend,
      };
      if (state === "ready" && (next.backendGeneration === null || next.registryRevision === null || next.endpointRef === null ||
        next.host === null || next.backend === null)) throw new Error("Managed owner ready proof is incomplete");
      const result = this.db.prepare(`UPDATE managed_owner_bindings SET state = ?, revision = revision + 1,
        backend_generation = ?, registry_revision = ?, endpoint_ref = ?, host_pid = ?, host_birth = ?,
        backend_pid = ?, backend_birth = ?, updated_at = ? WHERE id = ? AND revision = ? AND state = ?`).run(
        state, next.backendGeneration, next.registryRevision, next.endpointRef, next.host?.pid ?? null,
        next.host?.birthTicks ?? null, next.backend?.pid ?? null, next.backend?.birthTicks ?? null,
        now, row.id, row.revision, row.state);
      if (result.changes !== 1) throw new Error("Stale managed owner claim");
      return managedBinding(this.db.prepare("SELECT * FROM managed_owner_bindings WHERE id = ?").get(row.id) as ManagedOwnerBindingRow);
    });
  }

  retireManagedOwner(expected: ManagedOwnerBinding, now = Date.now()): ManagedOwnerBinding {
    // Retirement changes routing authority. It may only follow an explicit
    // handoff fence; the caller must separately verify the worker family and
    // pending operations are quiescent before using this transition.
    if (!expected || expected.state !== "handoff_pending")
      throw new Error("Managed owner retirement requires handoff");
    return this.atomic(() => {
      const row = this.db.prepare("SELECT * FROM managed_owner_bindings WHERE id = ?").get(expected.id) as ManagedOwnerBindingRow | undefined;
      if (!row || row.revision !== expected.revision || row.state !== expected.state || row.state === "retired")
        throw new Error("Stale managed owner claim");
      const result = this.db.prepare(`UPDATE managed_owner_bindings SET state = 'retired', revision = revision + 1,
        updated_at = ? WHERE id = ? AND revision = ? AND state = ?`).run(now, row.id, row.revision, row.state);
      if (result.changes !== 1) throw new Error("Stale managed owner claim");
      return managedBinding(this.db.prepare("SELECT * FROM managed_owner_bindings WHERE id = ?").get(row.id) as ManagedOwnerBindingRow);
    });
  }

  getBinding(id: string): Binding | null {
    const row = this.db.prepare("SELECT * FROM bridge_bindings WHERE id = ?").get(id) as BindingRow | undefined;
    return row ? binding(row) : null;
  }

  byPeer(peerId: number): Binding | null {
    const row = this.db.prepare("SELECT * FROM bridge_bindings WHERE peer_id = ?").get(peerId) as BindingRow | undefined;
    return row ? binding(row) : null;
  }

  bindings(): Binding[] { return (this.db.prepare("SELECT * FROM bridge_bindings ORDER BY id").all() as BindingRow[]).map(binding); }
  setChatState(id: string, state: Binding["chatState"]): void { this.db.prepare("UPDATE bridge_bindings SET chat_state = ? WHERE id = ?").run(state, id); }
  claimChat(id: string): boolean { return this.db.prepare("UPDATE bridge_bindings SET chat_state = 'creating' WHERE id = ? AND chat_state = 'planned'").run(id).changes === 1; }
  setChat(id: string, peerId: number, chatId: number): void {
    this.db.prepare("UPDATE bridge_bindings SET peer_id = ?, chat_id = ?, chat_state = 'ready' WHERE id = ?").run(peerId, chatId, id);
  }
  setAttached(id: string, attached: boolean): void { this.db.prepare("UPDATE bridge_bindings SET attached = ? WHERE id = ?").run(Number(attached), id); }
  setPaused(id: string, paused: boolean): void { this.db.prepare("UPDATE bridge_bindings SET paused = ? WHERE id = ?").run(Number(paused), id); }

  observeTaskSender(bindingId: string, senderId: number): number {
    if (!Number.isSafeInteger(senderId) || senderId === 0) throw new Error("Invalid VK sender ID");
    return this.atomic(() => {
      this.db.prepare("INSERT OR IGNORE INTO bridge_task_senders(binding_id, sender_id) VALUES (?, ?)").run(bindingId, senderId);
      const row = this.db.prepare("SELECT COUNT(*) AS count FROM bridge_task_senders WHERE binding_id = ?").get(bindingId) as { count: number };
      return row.count;
    });
  }

  streamGeneration(id: string): number { return this.getValue<number>(`stream-generation:${id}`) ?? 0; }

  deferredMirrors(options: Readonly<{ includeLegacy?: boolean }> = {}):
    readonly { bindingId: string; turnId: string; firstSeenAt: number | null; count: number }[] {
    const prefix = "deferred-mirror:";
    const rows = this.db.prepare("SELECT key, value FROM bridge_values WHERE key GLOB 'deferred-mirror:*' AND value <> 'null'")
      .all() as { key: string; value: string }[];
    return rows.flatMap(row => {
      const separator = row.key.indexOf(":", prefix.length);
      const value = JSON.parse(row.value) as { firstSeenAt?: number; events?: unknown[] } | unknown[];
      // Legacy arrays need fresh active-turn evidence before adoption. They
      // remain available to the mirror but are not a current delivery delay.
      if (Array.isArray(value) && options.includeLegacy === false) return [];
      const events = Array.isArray(value) ? value : value.events;
      if (separator < 0 || !events?.length) return [];
      return [{ bindingId: row.key.slice(prefix.length, separator), turnId: row.key.slice(separator + 1),
        firstSeenAt: !Array.isArray(value) && typeof value.firstSeenAt === "number" ? value.firstSeenAt : null, count: events.length }];
    });
  }

  stopStreaming(id: string): void {
    this.atomic(() => {
      const binding = this.getBinding(id);
      if (!binding) return;
      this.db.prepare("UPDATE bridge_bindings SET attached = 0, paused = 0 WHERE id = ?").run(id);
      // Retain delivery IDs and handles, but never retry a cancelled send or edit.
      this.db.prepare("UPDATE bridge_delivery SET delivered_revision = revision WHERE binding_id = ? OR peer_id = ?").run(id, binding.peerId);
      this.setValue(`projection:${id}`, null);
      this.setValue(`task-stream-mode:${id}`, null);
      this.setValue(`task-lease:${id}`, null);
      this.setValue(`stream-generation:${id}`, this.streamGeneration(id) + 1);
    });
  }

  transfer(id: string): TaskTransferRecord | null { return this.getValue<TaskTransferRecord>(`transfer:${id}`); }

  transfers(): readonly TaskTransferRecord[] {
    return (this.db.prepare("SELECT value FROM bridge_values WHERE key LIKE 'transfer:%'").all() as { value: string }[])
      .map(row => JSON.parse(row.value) as TaskTransferRecord).filter(Boolean);
  }

  transferBlocksInput(id: string): boolean {
    const record = this.transfer(id);
    return record?.version === 2 && !["complete", "cancelled", "switched"].includes(record.phase);
  }

  beginTransfer(record: TaskTransferRecord): void {
    this.atomic(() => {
      const current = this.transfer(record.bindingId);
      if (current && !["complete", "cancelled"].includes(current.phase) && current.id !== record.id) throw new Error("A task transfer is already active");
      if (current?.id === record.id) return;
      const binding = this.getBinding(record.bindingId);
      if (!binding || taskKey(binding) !== taskKey(record.source)) throw new Error("Transfer source binding changed");
      // Invalidate input already preparing attachments before this transfer began.
      this.setValue(`stream-generation:${record.bindingId}`, this.streamGeneration(record.bindingId) + 1);
      this.markTransfer(record);
    });
  }

  markTransfer(record: TaskTransferRecord): void {
    this.setValue(`transfer:${record.bindingId}`, record);
    this.setValue(`transfer-operation:${record.id}`, record);
  }

  /** Compare-and-set prevents delayed callbacks from overwriting newer progress. */
  updateTransfer(previous: TaskTransferRecord, changes: Partial<TaskTransferRecord>, now = Date.now()): TaskTransferRecord {
    return this.atomic(() => {
      const current = this.transfer(previous.bindingId);
      if (!current || current.id !== previous.id || (current.revision ?? 0) !== (previous.revision ?? 0)) {
        throw new Error("Stale transfer update");
      }
      const next = { ...current, ...changes, revision: (current.revision ?? 0) + 1, updatedAt: now };
      this.markTransfer(next);
      // Keep operational history without duplicating private goal text or prompts.
      this.setValue(`transfer-journal:${next.id}:${next.revision}`, {
        at: now, phase: next.phase, step: next.step, attempt: next.attempt, blocked: next.blocked, retryAt: next.retryAt,
      });
      return next;
    });
  }

  claimTransfer(previous: TaskTransferRecord, owner: string, pid: number, isAlive: (pid: number) => boolean, now = Date.now()): TaskTransferRecord | null {
    return this.atomic(() => {
      const current = this.transfer(previous.bindingId);
      if (!current || current.id !== previous.id || (current.revision ?? 0) !== (previous.revision ?? 0)) return null;
      // A watchdog timeout cannot revoke a live process's writer lease. Only a
      // confirmed dead process permits takeover after a crash.
      if (current.lease && current.lease.owner !== owner && isAlive(current.lease.pid)) return null;
      const sources = [current.source.sourceId ?? "", current.targetSourceId];
      if (this.transfers().some(other => other.id !== current.id && other.lease && isAlive(other.lease.pid)
        && [other.source.sourceId ?? "", other.targetSourceId].some(source => sources.includes(source)))) return null;
      return this.updateTransfer(current, { lease: { owner, pid } }, now);
    });
  }

  releaseTransfer(bindingId: string, id: string, owner: string, now = Date.now()): void {
    this.atomic(() => {
      const current = this.transfer(bindingId);
      if (current?.id === id && current.lease?.owner === owner) this.updateTransfer(current, { lease: null }, now);
    });
  }

  completeTransfer(record: TaskTransferRecord, now = Date.now()): TaskTransferRecord {
    return this.atomic(() => {
      const binding = this.getBinding(record.bindingId);
      if (record.phase !== "switched" || !record.target || !binding || taskKey(binding) !== taskKey(record.target)) throw new Error("Transfer target binding changed");
      return this.updateTransfer(record, { phase: "complete", detail: "", blocked: false, blockedReason: null, retryAt: 0,
        ...(!record.checkpoint ? { legacyReconciled: true } : {}) }, now);
    });
  }

  switchTransfer(record: TaskTransferRecord, target: DesktopTask, now = Date.now()): Binding {
    return this.atomic(() => {
      const current = this.getBinding(record.bindingId);
      if (!current || taskKey(current) !== taskKey(record.source)) throw new Error("Transfer source binding changed");
      const conflict = this.db.prepare("SELECT id FROM bridge_bindings WHERE host_id = ? AND thread_id = ? AND source_id = ? AND id <> ?")
        .get(target.hostId, target.threadId, target.sourceId ?? "", record.bindingId) as { id: string } | undefined;
      if (conflict) throw new Error("Transfer target is already linked to another conversation");
      const activity = this.getValue<{ key?: string }>(`activity:${record.bindingId}`);
      if (activity?.key) this.db.prepare(`UPDATE bridge_delivery SET kind = 'delete', revision = revision + 1
        WHERE key = ? AND handle IS NOT NULL AND kind = 'activity'`).run(activity.key);
      this.db.prepare(`UPDATE bridge_bindings SET host_id = ?, thread_id = ?, title = ?, source_id = ?, source_label = ?, rollout_path = ?, attached = 1, paused = 0
        WHERE id = ?`).run(target.hostId, target.threadId, target.title, target.sourceId ?? "", target.sourceLabel ?? null, target.rolloutPath ?? null, record.bindingId);
      this.db.prepare("DELETE FROM bridge_events WHERE binding_id = ?").run(record.bindingId);
      // The target rollout rewrites copied history with fresh file timestamps.
      // Its observation boundary must start after the verified fork, otherwise
      // the tailer treats every inherited answer as a new VK message.
      this.setValue(`projection:${record.bindingId}`, {
        since: now, lastObservedAt: now, activeAtAttach: [], active: [], seen: {}, semanticByIdentity: {},
        ...(target.rolloutPath ? { rolloutPath: comparablePath(target.rolloutPath) } : {}),
      } satisfies TaskObservationCheckpoint);
      this.setValue(`activity:${record.bindingId}`, null);
      this.setValue(`task-details:${record.bindingId}`, null);
      this.setValue(`task-stream-mode:${record.bindingId}`, null);
      this.setValue(`task-lease:${record.bindingId}`, null);
      // Delivery recovery belongs to the source task identity. Carrying its
      // accepted turn IDs into the fork makes an idle target look unfinished
      // and may recover a source answer through the target conversation.
      this.setValue(`accepted-turns:${record.bindingId}`, []);
      this.setValue(`queued-inputs:${record.bindingId}`, []);
      this.setValue(`health:legacy-accepted:${record.bindingId}`, null);
      this.setValue(`editable-request:${record.bindingId}`, null);
      this.setValue(`expected-edited-user:${record.bindingId}`, null);
      this.setValue(`rename:${record.bindingId}`, null);
      // A transferred task belongs to another configured Codex client. It gets
      // exactly one new initial handoff; the previous task's marker must not be
      // inherited by the target.
      this.setValue(`desktop-handoff:${record.bindingId}`, null);
      this.setValue(`stream-generation:${record.bindingId}`, this.streamGeneration(record.bindingId) + 1);
      this.updateTransfer(record, { phase: "switched", target });
      return this.getBinding(record.bindingId)!;
    });
  }

  receiveInput(input: BridgeInput, now = Date.now()): boolean {
    const id = JSON.stringify([input.peerId, input.eventId]);
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > 256 * 1024) throw new Error("VK input exceeds the durable journal limit");
    if (this.db.prepare(`INSERT OR IGNORE INTO bridge_inbox(id, state, payload, received_at, replay_after)
      VALUES (?, 'received', ?, ?, ?)`).run(id, payload, now, now + 10_000).changes === 1) return true;
    const state = this.inputState(id);
    // A duplicate event can still join a pending long-message batch. Preserve
    // the originally journaled payload; a changed VK message has its own event.
    if (state !== "received" && state !== "retryable") return false;
    this.db.prepare(`UPDATE bridge_inbox SET payload = COALESCE(payload, ?),
      received_at = COALESCE(received_at, ?), replay_after = COALESCE(replay_after, ?)
      WHERE id = ? AND state IN ('received', 'retryable')`).run(payload, now, now + 10_000, id);
    return true;
  }
  reserveReplayableInputs(now = Date.now(), limit = 100): readonly BridgeInput[] {
    // Most ticks have no backlog. Avoid taking an SQLite writer lock just to
    // observe an empty journal while another process updates Codex metadata.
    const due = this.db.prepare(`SELECT 1 FROM bridge_inbox
      WHERE state IN ('received', 'retryable') AND payload IS NOT NULL AND COALESCE(replay_after, 0) <= ? LIMIT 1`).get(now);
    if (!due) return [];
    return this.atomic(() => {
      const rows = this.db.prepare(`SELECT id, payload FROM bridge_inbox
        WHERE state IN ('received', 'retryable') AND payload IS NOT NULL AND COALESCE(replay_after, 0) <= ?
        ORDER BY received_at, rowid LIMIT ?`).all(now, limit) as { id: string; payload: string }[];
      const inputs = rows.map(row => {
        const input: unknown = JSON.parse(row.payload);
        if (!input || typeof input !== "object" || Array.isArray(input)
          || typeof (input as BridgeInput).eventId !== "string" || typeof (input as BridgeInput).text !== "string"
          || !Number.isSafeInteger((input as BridgeInput).peerId) || !Number.isSafeInteger((input as BridgeInput).senderId)
          || JSON.stringify([(input as BridgeInput).peerId, (input as BridgeInput).eventId]) !== row.id)
          throw new Error("Invalid durable VK input");
        return input as BridgeInput;
      });
      for (const row of rows) this.db.prepare("UPDATE bridge_inbox SET replay_after = ? WHERE id = ?").run(now + 30_000, row.id);
      return inputs;
    });
  }
  replayableInputStats(): { count: number; oldestAt: number | null } {
    return this.db.prepare(`SELECT COUNT(*) AS count, MIN(received_at) AS oldestAt FROM bridge_inbox
      WHERE state IN ('received', 'retryable')`).get() as { count: number; oldestAt: number | null };
  }
  claimInput(id: string): boolean {
    if (this.db.prepare("INSERT OR IGNORE INTO bridge_inbox(id, state) VALUES (?, 'processing')").run(id).changes === 1) return true;
    return this.db.prepare("UPDATE bridge_inbox SET state = 'processing' WHERE id = ? AND state IN ('received', 'retryable')").run(id).changes === 1;
  }
  inputState(id: string): "received" | "processing" | "preparing" | "sending" | "retryable" | "uncertain" | "done" | null {
    const row = this.db.prepare("SELECT state FROM bridge_inbox WHERE id = ?").get(id) as { state: string } | undefined;
    const state = row?.state;
    return state === "received" || state === "processing" || state === "preparing" || state === "sending" || state === "retryable"
      || state === "uncertain" || state === "done" ? state : null;
  }
  hasInput(id: string): boolean { const state = this.inputState(id); return state !== null && state !== "received" && state !== "retryable"; }
  inputSettled(id: string): boolean { return ["done", "uncertain"].includes(this.inputState(id) ?? ""); }
  saveInputBatch(batch: SavedInputBatch): void {
    this.db.prepare(`INSERT INTO bridge_input_batches(peer_id, batch_id, parts, started_at, updated_at, state)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET
      batch_id = excluded.batch_id, parts = excluded.parts, started_at = excluded.started_at,
      updated_at = excluded.updated_at, state = excluded.state`)
      .run(batch.peerId, batch.id, JSON.stringify(batch.parts), batch.startedAt, batch.updatedAt, batch.state);
  }
  inputBatches(): readonly SavedInputBatch[] {
    return (this.db.prepare("SELECT peer_id, batch_id, parts, started_at, updated_at, state FROM bridge_input_batches ORDER BY peer_id").all() as
      { peer_id: number; batch_id: string; parts: string; started_at: number; updated_at: number; state: string }[]).map(row => {
        const parts: unknown = JSON.parse(row.parts);
        if (!Array.isArray(parts) || !parts.length || !parts.every(part => part && typeof part === "object"
          && typeof part.eventId === "string" && typeof part.text === "string" && part.peerId === row.peer_id)
          || !["collecting", "dispatching"].includes(row.state)) throw new Error("Invalid saved VK input batch");
        return { id: row.batch_id, peerId: row.peer_id, parts: parts as BridgeInput[], startedAt: row.started_at,
          updatedAt: row.updated_at, state: row.state as SavedInputBatch["state"] };
      });
  }
  inputBatchStats(): { count: number; oldestAt: number | null; dispatching: number } {
    return this.db.prepare(`SELECT COUNT(*) AS count, MIN(updated_at) AS oldestAt,
      SUM(CASE WHEN state = 'dispatching' THEN 1 ELSE 0 END) AS dispatching
      FROM bridge_input_batches`).get() as { count: number; oldestAt: number | null; dispatching: number };
  }
  removeInputBatch(peerId: number, batchId: string): void {
    this.db.prepare("DELETE FROM bridge_input_batches WHERE peer_id = ? AND batch_id = ?").run(peerId, batchId);
  }
  oldestRetryableMessage(peerId: number): number | null {
    let oldest: number | null = null;
    const rows = this.db.prepare("SELECT id FROM bridge_inbox WHERE state = 'retryable'").all() as { id: string }[];
    for (const row of rows) {
      try {
        const key: unknown = JSON.parse(row.id);
        if (!Array.isArray(key) || key[0] !== peerId || typeof key[1] !== "string") continue;
        const match = /^message:(\d+)$/u.exec(key[1]);
        const id = match ? Number(match[1]) : 0;
        if (Number.isSafeInteger(id) && id > 0 && (oldest === null || id < oldest)) oldest = id;
      } catch { /* An unrelated legacy inbox key must not block reconciliation. */ }
    }
    return oldest;
  }
  markInputPreparing(ids: readonly string[]): void {
    this.atomic(() => { for (const id of ids) this.db.prepare("UPDATE bridge_inbox SET state = 'preparing' WHERE id = ? AND state = 'processing'").run(id); });
  }
  markInputSending(ids: readonly string[]): void {
    this.atomic(() => { for (const id of ids) this.db.prepare("UPDATE bridge_inbox SET state = 'sending' WHERE id = ? AND state = 'preparing'").run(id); });
  }
  finishInput(id: string, uncertain = false): void {
    this.db.prepare("UPDATE bridge_inbox SET state = ?, payload = NULL WHERE id = ?").run(uncertain ? "uncertain" : "done", id);
  }
  finishInputs(ids: readonly string[], uncertain = false): void {
    this.atomic(() => { for (const id of ids) this.finishInput(id, uncertain); });
  }

  action(value: ManagerAction, now = Date.now(), peerId: number | null = null): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO bridge_actions(id, payload, expires_at, peer_id) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(value), now + 30 * 60_000, peerId);
    return id;
  }
  getAction(id: string, now = Date.now()): ManagerAction | null {
    const row = this.db.prepare("SELECT payload FROM bridge_actions WHERE id = ? AND expires_at > ? AND consumed = 0").get(id, now) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ManagerAction : null;
  }
  scopedAction(id: string, peerId: number, managerPeer: boolean, now = Date.now()): ManagerAction | null {
    const row = this.db.prepare(`SELECT payload FROM bridge_actions WHERE id = ? AND expires_at > ? AND consumed = 0
      AND (peer_id = ? OR (peer_id IS NULL AND ? = 1))`).get(id, now, peerId, Number(managerPeer)) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ManagerAction : null;
  }
  consumeAction(id: string, peerId: number, now = Date.now()): boolean {
    return this.db.prepare("UPDATE bridge_actions SET consumed = 1 WHERE id = ? AND peer_id = ? AND expires_at > ? AND consumed = 0").run(id, peerId, now).changes === 1;
  }
  pendingCount(): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM bridge_delivery WHERE revision > delivered_revision AND kind IN ('send', 'commentary')").get() as { count: number }).count; }
  quickCheck(): boolean { return this.db.pragma("quick_check", { simple: true }) === "ok"; }
  deliveryHealth(now = Date.now()): DeliveryHealthStats {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN d.binding_id IS NULL OR (b.attached = 1 AND b.peer_id = d.peer_id) THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN (d.binding_id IS NULL OR (b.attached = 1 AND b.peer_id = d.peer_id)) AND d.kind IN ('send', 'panel') THEN 1 ELSE 0 END) AS critical,
      MIN(CASE WHEN (d.binding_id IS NULL OR (b.attached = 1 AND b.peer_id = d.peer_id)) AND d.kind IN ('send', 'panel') THEN d.id END) AS critical_oldest_id,
      SUM(CASE WHEN (d.binding_id IS NULL OR (b.attached = 1 AND b.peer_id = d.peer_id)) AND d.kind IN ('commentary', 'activity', 'delete') THEN 1 ELSE 0 END) AS stream,
      SUM(CASE WHEN d.binding_id IS NOT NULL AND (b.id IS NULL OR b.attached <> 1 OR b.peer_id <> d.peer_id) THEN 1 ELSE 0 END) AS inactive
      FROM bridge_delivery d LEFT JOIN bridge_bindings b ON b.id = d.binding_id
      WHERE d.revision > d.delivered_revision AND d.kind IN ('send', 'commentary', 'panel', 'activity', 'delete')`).get() as {
        active: number | null; critical: number | null; critical_oldest_id: number | null; stream: number | null; inactive: number | null;
      };
    return {
      activePending: row.active ?? 0,
      criticalPending: row.critical ?? 0,
      criticalOldestId: row.critical_oldest_id,
      streamPending: row.stream ?? 0,
      inactivePending: row.inactive ?? 0,
      pauseRemainingMs: Math.max(0, (this.getValue<number>("vk-delivery-paused-until") ?? 0) - now),
      lastFailure: this.getValue<DeliveryFailure>("vk-delivery-last-failure"),
      lastSuccessAt: this.getValue<number>("vk-delivery-last-success-at"),
    };
  }
  recordDeliveryFailure(delivery: Delivery, type: DeliveryFailure["type"], retryAfterMs?: number, now = Date.now()): void {
    this.setValue("vk-delivery-last-failure", { at: now, type, kind: delivery.kind, operation: delivery.kind === "delete" ? "delete" : delivery.handle ? "edit" : "send", ...(retryAfterMs ? { retryAfterMs } : {}) } satisfies DeliveryFailure);
  }
  recordDeliverySuccess(now = Date.now()): void { this.setValue("vk-delivery-last-success-at", now); }
  getDraft(): NewTaskDraft | null { return this.getValue<NewTaskDraft>("draft"); }
  saveDraft(value: NewTaskDraft | null): void { this.setValue("draft", value); }
  claimDraft(id: string): NewTaskDraft | null {
    return this.atomic(() => {
      const draft = this.getDraft();
      if (draft?.id !== id || draft.stage !== "confirm") return null;
      const next: NewTaskDraft = { ...draft, stage: "creating" };
      this.saveDraft(next);
      return next;
    });
  }
  getValue<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM bridge_values WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T | null : null;
  }
  setValue(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO bridge_values(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  claimInitialHandoff(bindingId: string, task: TaskRef, now = Date.now()): boolean {
    return this.atomic(() => {
      const key = `desktop-handoff:${bindingId}`;
      const expected = taskKey(task);
      const current = this.getValue<DesktopHandoffState>(key);
      if (current?.taskKey === expected) return false;
      this.setValue(key, { taskKey: expected, status: "launching", updatedAt: now } satisfies DesktopHandoffState);
      return true;
    });
  }

  markDesktopHandoff(bindingId: string, task: TaskRef, status: DesktopHandoffState["status"], now = Date.now()): void {
    const key = `desktop-handoff:${bindingId}`;
    const expected = taskKey(task);
    const current = this.getValue<DesktopHandoffState>(key);
    const order: Record<DesktopHandoffState["status"], number> = { launching: 0, launched: 1, live: 2 };
    if (current?.taskKey === expected && order[current.status] >= order[status]) return;
    this.setValue(key, { taskKey: expected, status, updatedAt: now } satisfies DesktopHandoffState);
  }

  clearDesktopHandoff(bindingId: string, task: TaskRef): void {
    const key = `desktop-handoff:${bindingId}`;
    if (this.getValue<DesktopHandoffState>(key)?.taskKey === taskKey(task)) this.setValue(key, null);
  }

  pendingCreation(task: TaskRef): readonly TaskCreationUpdate[] {
    const value = this.getValue<unknown>(`pending-creation:${taskKey(task)}`);
    return Array.isArray(value) ? value as TaskCreationUpdate[] : [];
  }

  appendPendingCreation(update: TaskCreationUpdate): void {
    this.atomic(() => {
      const key = `pending-creation:${taskKey(update.task)}`;
      this.setValue(key, [...this.pendingCreation(update.task), update].slice(-100));
    });
  }

  clearPendingCreation(task: TaskRef): void { this.setValue(`pending-creation:${taskKey(task)}`, null); }

  recordOperation(id: string, task: TaskRef, inboxKey?: string, bindingId?: string, now = Date.now()): void {
    this.atomic(() => {
      this.db.prepare("INSERT INTO bridge_operations(id, task_key, state) VALUES (?, ?, 'sending')").run(id, taskKey(task));
      if (inboxKey && bindingId) this.db.prepare("INSERT INTO bridge_operation_inputs(operation_id, binding_id, inbox_key, inbox_keys, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, bindingId, inboxKey, JSON.stringify([inboxKey]), now);
    });
  }
  beginPromptDispatch(id: string, task: TaskRef, inboxKeys: readonly string[], bindingId: string, now = Date.now()): void {
    if (!inboxKeys.length) throw new Error("Prompt dispatch requires an inbox key");
    this.atomic(() => {
      for (const key of inboxKeys) {
        if (this.inputState(key) !== "preparing") throw new Error("VK input is not prepared for Codex dispatch");
      }
      this.db.prepare("INSERT INTO bridge_operations(id, task_key, state) VALUES (?, ?, 'sending')").run(id, taskKey(task));
      this.db.prepare("INSERT INTO bridge_operation_inputs(operation_id, binding_id, inbox_key, inbox_keys, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, bindingId, inboxKeys[0], JSON.stringify(inboxKeys), now);
      for (const key of inboxKeys) this.db.prepare("UPDATE bridge_inbox SET state = 'sending' WHERE id = ?").run(key);
    });
  }
  uncertainPromptOperations(now = Date.now(), limit = 10): readonly { id: string; taskKey: string; bindingId: string; inboxKey: string }[] {
    return this.db.prepare(`SELECT op.id AS id, op.task_key AS taskKey, input.binding_id AS bindingId, input.inbox_key AS inboxKey
      FROM bridge_operations AS op JOIN bridge_operation_inputs AS input ON input.operation_id = op.id
      WHERE op.state = 'uncertain' AND (input.last_checked_at IS NULL OR input.last_checked_at <= ?)
      ORDER BY op.rowid DESC LIMIT ?`).all(now - 5 * 60_000, limit) as { id: string; taskKey: string; bindingId: string; inboxKey: string }[];
  }
  uncertainPromptStats(): { count: number; oldestAt: number | null } {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, MIN(input.created_at) AS oldestAt
      FROM bridge_operations AS op JOIN bridge_operation_inputs AS input ON input.operation_id = op.id
      WHERE op.state = 'uncertain'`).get() as { count: number; oldestAt: number | null };
    return row;
  }
  unresolvedPromptOperations(bindingId: string): readonly { id: string; state: "sending" | "uncertain"; createdAt: number }[] {
    const current = this.getBinding(bindingId);
    if (!current) return [];
    return this.db.prepare(`SELECT op.id AS id, op.state AS state, input.created_at AS createdAt
      FROM bridge_operations AS op JOIN bridge_operation_inputs AS input ON input.operation_id = op.id
      WHERE input.binding_id = ? AND op.task_key = ? AND op.state IN ('sending', 'uncertain')
      ORDER BY input.created_at`).all(bindingId, taskKey(current)) as { id: string; state: "sending" | "uncertain"; createdAt: number }[];
  }
  markOperationChecked(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE bridge_operation_inputs SET last_checked_at = ? WHERE operation_id = ?").run(now, id);
  }
  finishOperation(id: string, state: "accepted" | "rejected" | "uncertain"): void {
    this.db.prepare("UPDATE bridge_operations SET state = ? WHERE id = ?").run(state, id);
  }
  /** Commit a prompt result together with every VK fragment that formed it.
   * This closes the crash window where Codex had accepted the request but the
   * durable inbox still looked in-flight after restart. */
  settlePromptDispatch(id: string, state: "accepted" | "rejected" | "uncertain"): void {
    this.atomic(() => {
      this.finishOperation(id, state);
      const row = this.db.prepare("SELECT inbox_key, inbox_keys FROM bridge_operation_inputs WHERE operation_id = ?")
        .get(id) as { inbox_key: string; inbox_keys: string | null } | undefined;
      if (!row) return;
      let keys: readonly string[] = [row.inbox_key];
      if (row.inbox_keys) {
        try {
          const saved: unknown = JSON.parse(row.inbox_keys);
          if (Array.isArray(saved) && saved.length && saved.every(key => typeof key === "string")) keys = saved;
        } catch { /* A legacy or damaged list still retains its primary key. */ }
      }
      this.finishInputs(keys, state === "uncertain");
    });
  }
  operationState(id: string): "sending" | "accepted" | "rejected" | "uncertain" | null {
    const row = this.db.prepare("SELECT state FROM bridge_operations WHERE id = ?").get(id) as { state: string } | undefined;
    const state = row?.state;
    return state === "sending" || state === "accepted" || state === "rejected" || state === "uncertain" ? state : null;
  }
  isOwnOperation(id: string, task: TaskRef): boolean { return Boolean(this.db.prepare("SELECT 1 FROM bridge_operations WHERE id = ? AND task_key = ?").get(id, taskKey(task))); }
  rememberAcceptedTurn(bindingId: string, turnId: string, operationId: string): void {
    const turns = this.acceptedTurns(bindingId).filter(turn => turn.turnId !== turnId);
    this.setValue(`accepted-turns:${bindingId}`, [...turns, { turnId, operationId }].slice(-16));
  }
  acceptedTurns(bindingId: string): readonly AcceptedTaskTurn[] {
    const value = this.getValue<unknown>(`accepted-turns:${bindingId}`);
    if (!Array.isArray(value)) return [];
    const current = this.getBinding(bindingId);
    return value.filter((item): item is AcceptedTaskTurn => !!item && typeof item === "object"
      && typeof (item as AcceptedTaskTurn).turnId === "string" && typeof (item as AcceptedTaskTurn).operationId === "string"
      && !!current && this.isOwnOperation((item as AcceptedTaskTurn).operationId, current));
  }
  oldestAcceptedTurnAt(bindingId: string): number | null {
    let oldest: number | null = null;
    const statement = this.db.prepare("SELECT created_at AS createdAt FROM bridge_operation_inputs WHERE operation_id = ? AND binding_id = ?");
    for (const turn of this.acceptedTurns(bindingId)) {
      const row = statement.get(turn.operationId, bindingId) as { createdAt: number } | undefined;
      if (row && Number.isSafeInteger(row.createdAt) && row.createdAt > 0) oldest = Math.min(oldest ?? row.createdAt, row.createdAt);
    }
    return oldest;
  }
  settleAcceptedTurn(bindingId: string, turnId: string): void {
    this.setValue(`accepted-turns:${bindingId}`, this.acceptedTurns(bindingId).filter(turn => turn.turnId !== turnId));
  }
  rememberQueuedInput(bindingId: string, operationId: string, queuedId: string, now = Date.now()): void {
    const queued = this.queuedInputs(bindingId).filter(item => item.operationId !== operationId);
    this.setValue(`queued-inputs:${bindingId}`, [...queued, { operationId, queuedId, acceptedAt: now }]);
  }
  queuedInputs(bindingId: string): readonly QueuedTaskInput[] {
    const value = this.getValue<unknown>(`queued-inputs:${bindingId}`);
    if (!Array.isArray(value)) return [];
    const current = this.getBinding(bindingId);
    return value.filter((item): item is QueuedTaskInput => !!item && typeof item === "object"
      && typeof (item as QueuedTaskInput).operationId === "string" && typeof (item as QueuedTaskInput).queuedId === "string"
      && Number.isSafeInteger((item as QueuedTaskInput).acceptedAt) && (item as QueuedTaskInput).acceptedAt > 0
      && !!current && this.isOwnOperation((item as QueuedTaskInput).operationId, current));
  }
  settleQueuedInput(bindingId: string, operationId: string): void {
    this.setValue(`queued-inputs:${bindingId}`, this.queuedInputs(bindingId).filter(item => item.operationId !== operationId));
  }
  saveEditableRequest(bindingId: string, request: EditableVkRequest): void { this.setValue(`editable-request:${bindingId}`, request); }
  clearEditableRequest(bindingId: string): void { this.setValue(`editable-request:${bindingId}`, null); }
  editableRequest(bindingId: string): EditableVkRequest | null { return this.getValue<EditableVkRequest>(`editable-request:${bindingId}`); }
  expectEditedUser(bindingId: string, text: string, now = Date.now()): void {
    this.setValue(`expected-edited-user:${bindingId}`, { digest: createHash("sha256").update(text).digest("hex"), expiresAt: now + 60_000 });
  }
  clearExpectedEditedUser(bindingId: string): void { this.setValue(`expected-edited-user:${bindingId}`, null); }
  consumeExpectedEditedUser(bindingId: string, text: string, now = Date.now()): boolean {
    const expected = this.getValue<{ digest: string; expiresAt: number }>(`expected-edited-user:${bindingId}`);
    if (!expected || expected.expiresAt < now || expected.digest !== createHash("sha256").update(text).digest("hex")) return false;
    this.clearExpectedEditedUser(bindingId); return true;
  }
  rememberEvent(bindingId: string, eventId: string): boolean { return this.db.prepare("INSERT OR IGNORE INTO bridge_events(binding_id, event_id) VALUES (?, ?)").run(bindingId, eventId).changes === 1; }
  /** Read older final deliveries when a client rewrites the same Codex answer
   * with a different item ID. This also covers finals sent before semantic
   * markers were introduced, without scanning unrelated chats. */
  finalDeliveries(bindingId: string, turnId: string): readonly { text: string; menu: boolean }[] {
    const prefix = `event:${bindingId}:`;
    const rows = this.db.prepare(`SELECT key, view FROM bridge_delivery
      WHERE key GLOB ? AND turn_id = ? AND kind = 'send' ORDER BY id`).all(`${prefix}*`, turnId) as { key: string; view: string }[];
    const parts = new Map<string, Map<number, View>>();
    for (const row of rows) {
      const suffix = row.key.slice(prefix.length);
      const split = suffix.lastIndexOf(":");
      if (split < 0 || !/^\d+$/u.test(suffix.slice(split + 1))) continue;
      const view = JSON.parse(row.view) as View;
      if (view.silent || typeof view.text !== "string") continue; // User echoes are silent.
      const itemId = suffix.slice(0, split);
      const chunks = parts.get(itemId) ?? new Map<number, View>();
      chunks.set(Number(suffix.slice(split + 1)), view);
      parts.set(itemId, chunks);
    }
    return [...parts.values()].map(chunks => {
      const ordered = [...chunks].sort(([a], [b]) => a - b).map(([, view]) => view);
      return { text: ordered.map(view => view.text).join(""), menu: !!ordered.at(-1)?.buttons?.length };
    });
  }
  hasEvent(bindingId: string, eventId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM bridge_events WHERE binding_id = ? AND event_id = ?").get(bindingId, eventId));
  }
  deliveryOrder(key: string): number { return (this.db.prepare("SELECT id FROM bridge_delivery WHERE key = ?").get(key) as { id: number } | undefined)?.id ?? 0; }
  latestPeerDeliveryOrder(peerId: number): number {
    return (this.db.prepare("SELECT MAX(id) AS id FROM bridge_delivery WHERE peer_id = ? AND kind IN ('send', 'commentary', 'panel', 'activity')").get(peerId) as { id: number | null }).id ?? 0;
  }
  deliveryMessageId(key: string): number | null {
    return (this.db.prepare("SELECT json_extract(handle, '$.conversationMessageId') AS id FROM bridge_delivery WHERE key = ?").get(key) as { id: number | null } | undefined)?.id ?? null;
  }
  observePeerMessage(peerId: number, messageId: number): void {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    const key = `peer-message:${peerId}`;
    if (messageId > (this.getValue<number>(key) ?? 0)) this.setValue(key, messageId);
  }
  latestPeerMessage(peerId: number): number {
    const sent = (this.db.prepare("SELECT MAX(json_extract(handle, '$.conversationMessageId')) AS id FROM bridge_delivery WHERE peer_id = ?").get(peerId) as { id: number | null }).id ?? 0;
    return Math.max(sent, this.getValue<number>(`peer-message:${peerId}`) ?? 0);
  }

  enqueue(key: string, peerId: number, view: View, bindingId: string | null = null, commentary: boolean | "panel" | "activity" = false, turnId: string | null = null): void {
    const serialized = JSON.stringify(view);
    if (commentary) {
      this.db.prepare(`INSERT INTO bridge_delivery(key, binding_id, peer_id, kind, view, turn_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET view = excluded.view, turn_id = COALESCE(bridge_delivery.turn_id, excluded.turn_id), revision = bridge_delivery.revision + 1
        WHERE bridge_delivery.view <> excluded.view`).run(key, bindingId, peerId, commentary === true ? "commentary" : commentary, serialized, turnId);
    } else this.db.prepare("INSERT OR IGNORE INTO bridge_delivery(key, binding_id, peer_id, kind, view, turn_id) VALUES (?, ?, ?, 'send', ?, ?)").run(key, bindingId, peerId, serialized, turnId);
  }

  deleteTurnDeliveries(bindingId: string, turnId: string): void {
    this.db.prepare(`UPDATE bridge_delivery SET kind = 'delete', revision = revision + 1,
      delivered_revision = CASE WHEN first_view IS NULL AND handle IS NULL THEN revision + 1 ELSE delivered_revision END
      WHERE binding_id = ? AND turn_id = ? AND kind IN ('send', 'commentary', 'activity')`).run(bindingId, turnId);
  }

  withdrawCommentary(key: string): void {
    // Cancel unattempted fragments. Recover ambiguous sends with the original
    // random_id before editing away text that was removed from the comment.
    const replacement = JSON.stringify({ text: "(Этот фрагмент комментария удалён в Codex.)", silent: true } satisfies View);
    this.db.prepare(`UPDATE bridge_delivery SET view = ?, revision = revision + 1,
      delivered_revision = CASE WHEN first_view IS NULL AND handle IS NULL THEN revision + 1 ELSE delivered_revision END
      WHERE key = ? AND kind = 'commentary' AND view <> ?`).run(replacement, key, replacement);
  }

  retireTurnCommentary(bindingId: string, turnId: string): void {
    const prefix = `commentary:${bindingId}:${turnId}:`;
    this.db.prepare(`UPDATE bridge_delivery SET delivered_revision = revision
      WHERE binding_id = ? AND kind = 'commentary' AND delivered_revision < revision
        AND substr(key, 1, ?) = ?`).run(bindingId, prefix.length, prefix);
  }

  settleActivity(key: string, text: string, refresh = false): void {
    const view = JSON.stringify({ text, silent: true } satisfies View);
    this.db.prepare(`UPDATE bridge_delivery SET view = ?, revision = revision + 1,
      delivered_revision = CASE WHEN first_view IS NULL AND handle IS NULL THEN revision + 1 ELSE delivered_revision END
      WHERE key = ? AND kind = 'activity' AND (view <> ? OR ? = 1)`).run(view, key, view, Number(refresh));
  }

  deleteActivity(key: string): void {
    this.db.prepare(`UPDATE bridge_delivery SET kind = 'delete', revision = revision + 1,
      delivered_revision = CASE WHEN first_view IS NULL AND handle IS NULL THEN revision + 1 ELSE delivered_revision END
      WHERE key = ? AND kind = 'activity'`).run(key);
  }

  activateActivity(key: string): void {
    this.db.prepare("UPDATE bridge_delivery SET revision = revision + 1 WHERE key = ? AND kind = 'activity' AND delivered_revision = revision").run(key);
  }

  prioritizeDelivery(key: string): void {
    this.db.prepare("UPDATE bridge_delivery SET priority_revision = revision WHERE key = ?").run(key);
  }

  isPriorityDelivery(delivery: Delivery): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM bridge_delivery WHERE id = ? AND priority_revision >= ?").get(delivery.id, delivery.revision));
  }

  retireActivity(key: string): void {
    this.db.prepare("UPDATE bridge_delivery SET delivered_revision = revision WHERE key = ? AND kind = 'activity'").run(key);
  }

  pendingDeliveries(): Delivery[] {
    const rows = this.db.prepare(`SELECT * FROM bridge_delivery WHERE revision > delivered_revision
      AND kind IN ('send', 'commentary', 'panel', 'activity', 'delete')
      ORDER BY CASE kind WHEN 'send' THEN 0 WHEN 'panel' THEN 1 WHEN 'commentary' THEN 2 WHEN 'activity' THEN 3 ELSE 4 END, id`).all() as {
      id: number; key: string; binding_id: string | null; peer_id: number; kind: Delivery["kind"]; view: string; first_view: string | null; handle: string | null; revision: number; delivered_revision: number;
    }[];
    return rows.map(row => ({ id: row.id, key: row.key, bindingId: row.binding_id, peerId: row.peer_id, kind: row.kind, view: JSON.parse(row.view) as View, firstView: row.first_view ? JSON.parse(row.first_view) as View : null, handle: row.handle ? JSON.parse(row.handle) as MessageHandle : null, revision: row.revision, deliveredRevision: row.delivered_revision }));
  }

  /** Outgoing attachments previously registered by this bridge, including
   * messages delivered before the cleanup registry was introduced. */
  deliveryAttachmentHistory(): readonly { attachment: string; order: number }[] {
    const rows = this.db.prepare("SELECT id, view FROM bridge_delivery WHERE kind <> 'delete' ORDER BY id").all() as { id: number; view: string }[];
    const result: { attachment: string; order: number }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      let view: View;
      try { view = JSON.parse(row.view) as View; } catch { continue; }
      for (const attachment of view.attachments ?? []) {
        if (!/^doc-?\d+_\d+(?:_|$)/u.test(attachment) || seen.has(attachment)) continue;
        seen.add(attachment); result.push({ attachment, order: row.id });
      }
    }
    return result;
  }

  sending(delivery: Delivery): void {
    this.db.prepare("UPDATE bridge_delivery SET first_view = COALESCE(first_view, ?) WHERE id = ?").run(JSON.stringify(delivery.view), delivery.id);
  }
  isPending(delivery: Delivery): boolean {
    if (delivery.kind === "activity" || delivery.kind === "delete") return Boolean(this.db.prepare("SELECT 1 FROM bridge_delivery WHERE id = ? AND revision = ? AND delivered_revision < ?").get(delivery.id, delivery.revision, delivery.revision));
    return Boolean(this.db.prepare("SELECT 1 FROM bridge_delivery WHERE id = ? AND delivered_revision < ?").get(delivery.id, delivery.revision));
  }
  saveHandle(id: number, handle: MessageHandle): void {
    this.db.prepare("UPDATE bridge_delivery SET handle = ? WHERE id = ?").run(JSON.stringify(handle), id);
  }

  deliveryHandle(key: string): MessageHandle | null {
    const row = this.db.prepare("SELECT handle FROM bridge_delivery WHERE key = ?").get(key) as { handle: string | null } | undefined;
    return row?.handle ? JSON.parse(row.handle) as MessageHandle : null;
  }

  delivered(delivery: Delivery, handle: MessageHandle): void {
    this.db.prepare("UPDATE bridge_delivery SET handle = ?, delivered_revision = MAX(delivered_revision, ?) WHERE id = ?").run(JSON.stringify(handle), delivery.revision, delivery.id);
  }
  completed(delivery: Delivery): void {
    this.db.prepare("UPDATE bridge_delivery SET delivered_revision = MAX(delivered_revision, ?) WHERE id = ?").run(delivery.revision, delivery.id);
  }
}
