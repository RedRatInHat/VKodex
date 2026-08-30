import { createHash, randomUUID } from "node:crypto";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { taskKey, type DesktopTask, type TaskRef } from "../desktop/contracts.js";
import type { Binding, Delivery, ManagerAction, MessageHandle, NewTaskDraft, View } from "./contracts.js";
import { VK_MAX_INLINE_BUTTONS } from "./contracts.js";
import { comparablePath } from "../desktop/paths.js";

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

interface BindingRow { id: string; host_id: string; thread_id: string; title: string; peer_id: number | null; chat_id: number | null; chat_state: Binding["chatState"]; attached: number; paused: number; source_id: string; source_label: string | null; rollout_path: string | null }
export interface DeliveryFailure {
  readonly at: number;
  readonly type: "rate_limit" | "transient";
  readonly kind: Delivery["kind"];
  readonly operation: "send" | "edit";
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
function binding(row: BindingRow): Binding {
  return { id: row.id, hostId: row.host_id, threadId: row.thread_id, title: row.title, peerId: row.peer_id, chatId: row.chat_id, chatState: row.chat_state, attached: row.attached === 1, paused: row.paused === 1,
    ...(row.source_id ? { sourceId: row.source_id } : {}), ...(row.source_label ? { sourceLabel: row.source_label } : {}), ...(row.rollout_path ? { rolloutPath: row.rollout_path } : {}) };
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
      CREATE TABLE IF NOT EXISTS bridge_inbox (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_actions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_operations (id TEXT PRIMARY KEY, task_key TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_events (binding_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(binding_id, event_id));
      CREATE TABLE IF NOT EXISTS bridge_delivery (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, binding_id TEXT REFERENCES bridge_bindings(id),
        peer_id INTEGER NOT NULL, kind TEXT NOT NULL, view TEXT NOT NULL, first_view TEXT, handle TEXT,
        revision INTEGER NOT NULL DEFAULT 1, delivered_revision INTEGER NOT NULL DEFAULT 0,
        priority_revision INTEGER NOT NULL DEFAULT 0
      );
    `);
    migrateBindingSources(this.db);
    const actionColumns = new Set((this.db.prepare("PRAGMA table_info(bridge_actions)").all() as { name: string }[]).map(column => column.name));
    if (!actionColumns.has("peer_id")) this.db.exec("ALTER TABLE bridge_actions ADD COLUMN peer_id INTEGER");
    if (!actionColumns.has("consumed")) this.db.exec("ALTER TABLE bridge_actions ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0");
    const deliveryColumns = new Set((this.db.prepare("PRAGMA table_info(bridge_delivery)").all() as { name: string }[]).map(column => column.name));
    if (!deliveryColumns.has("priority_revision")) this.db.exec("ALTER TABLE bridge_delivery ADD COLUMN priority_revision INTEGER NOT NULL DEFAULT 0");
  }

  close(): void { this.db.close(); }
  atomic<T>(operation: () => T): T { return this.db.transaction(operation)(); }

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
      this.db.prepare("UPDATE bridge_inbox SET state = 'uncertain' WHERE state = 'processing'").run();
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

  streamGeneration(id: string): number { return this.getValue<number>(`stream-generation:${id}`) ?? 0; }

  stopStreaming(id: string): void {
    this.atomic(() => {
      const binding = this.getBinding(id);
      if (!binding) return;
      this.db.prepare("UPDATE bridge_bindings SET attached = 0, paused = 0 WHERE id = ?").run(id);
      // Retain delivery IDs and handles, but never retry a cancelled send or edit.
      this.db.prepare("UPDATE bridge_delivery SET delivered_revision = revision WHERE binding_id = ? OR peer_id = ?").run(id, binding.peerId);
      this.setValue(`projection:${id}`, null);
      this.setValue(`stream-generation:${id}`, this.streamGeneration(id) + 1);
    });
  }

  claimInput(id: string): boolean { return this.db.prepare("INSERT OR IGNORE INTO bridge_inbox(id, state) VALUES (?, 'processing')").run(id).changes === 1; }
  finishInput(id: string, uncertain = false): void { this.db.prepare("UPDATE bridge_inbox SET state = ? WHERE id = ?").run(uncertain ? "uncertain" : "done", id); }

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
      SUM(CASE WHEN (d.binding_id IS NULL OR (b.attached = 1 AND b.peer_id = d.peer_id)) AND d.kind IN ('commentary', 'activity') THEN 1 ELSE 0 END) AS stream,
      SUM(CASE WHEN d.binding_id IS NOT NULL AND (b.id IS NULL OR b.attached <> 1 OR b.peer_id <> d.peer_id) THEN 1 ELSE 0 END) AS inactive
      FROM bridge_delivery d LEFT JOIN bridge_bindings b ON b.id = d.binding_id
      WHERE d.revision > d.delivered_revision AND d.kind IN ('send', 'commentary', 'panel', 'activity')`).get() as {
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
    this.setValue("vk-delivery-last-failure", { at: now, type, kind: delivery.kind, operation: delivery.handle ? "edit" : "send", ...(retryAfterMs ? { retryAfterMs } : {}) } satisfies DeliveryFailure);
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

  recordOperation(id: string, task: TaskRef): void { this.db.prepare("INSERT INTO bridge_operations(id, task_key, state) VALUES (?, ?, 'sending')").run(id, taskKey(task)); }
  finishOperation(id: string, uncertain: boolean): void { this.db.prepare("UPDATE bridge_operations SET state = ? WHERE id = ?").run(uncertain ? "uncertain" : "accepted", id); }
  isOwnOperation(id: string, task: TaskRef): boolean { return Boolean(this.db.prepare("SELECT 1 FROM bridge_operations WHERE id = ? AND task_key = ?").get(id, taskKey(task))); }
  rememberEvent(bindingId: string, eventId: string): boolean { return this.db.prepare("INSERT OR IGNORE INTO bridge_events(binding_id, event_id) VALUES (?, ?)").run(bindingId, eventId).changes === 1; }
  deliveryOrder(key: string): number { return (this.db.prepare("SELECT id FROM bridge_delivery WHERE key = ?").get(key) as { id: number } | undefined)?.id ?? 0; }
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

  enqueue(key: string, peerId: number, view: View, bindingId: string | null = null, commentary: boolean | "panel" | "activity" = false): void {
    const serialized = JSON.stringify(view);
    if (commentary) {
      this.db.prepare(`INSERT INTO bridge_delivery(key, binding_id, peer_id, kind, view) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET view = excluded.view, revision = bridge_delivery.revision + 1
        WHERE bridge_delivery.view <> excluded.view`).run(key, bindingId, peerId, commentary === true ? "commentary" : commentary, serialized);
    } else this.db.prepare("INSERT OR IGNORE INTO bridge_delivery(key, binding_id, peer_id, kind, view) VALUES (?, ?, ?, 'send', ?)").run(key, bindingId, peerId, serialized);
  }

  withdrawCommentary(key: string): void {
    // Cancel unattempted fragments. Recover ambiguous sends with the original
    // random_id before editing away text that was removed from the comment.
    const replacement = JSON.stringify({ text: "(Этот фрагмент комментария удалён в Codex.)", silent: true } satisfies View);
    this.db.prepare(`UPDATE bridge_delivery SET view = ?, revision = revision + 1,
      delivered_revision = CASE WHEN first_view IS NULL AND handle IS NULL THEN revision + 1 ELSE delivered_revision END
      WHERE key = ? AND kind = 'commentary' AND view <> ?`).run(replacement, key, replacement);
  }

  settleActivity(key: string, text: string, refresh = false): void {
    const view = JSON.stringify({ text, silent: true } satisfies View);
    this.db.prepare(`UPDATE bridge_delivery SET view = ?, revision = revision + 1,
      delivered_revision = CASE WHEN first_view IS NULL AND handle IS NULL THEN revision + 1 ELSE delivered_revision END
      WHERE key = ? AND kind = 'activity' AND (view <> ? OR ? = 1)`).run(view, key, view, Number(refresh));
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
      AND kind IN ('send', 'commentary', 'panel', 'activity')
      ORDER BY CASE kind WHEN 'send' THEN 0 WHEN 'panel' THEN 1 WHEN 'commentary' THEN 2 ELSE 3 END, id`).all() as {
      id: number; key: string; binding_id: string | null; peer_id: number; kind: Delivery["kind"]; view: string; first_view: string | null; handle: string | null; revision: number; delivered_revision: number;
    }[];
    return rows.map(row => ({ id: row.id, key: row.key, bindingId: row.binding_id, peerId: row.peer_id, kind: row.kind, view: JSON.parse(row.view) as View, firstView: row.first_view ? JSON.parse(row.first_view) as View : null, handle: row.handle ? JSON.parse(row.handle) as MessageHandle : null, revision: row.revision, deliveredRevision: row.delivered_revision }));
  }

  sending(delivery: Delivery): void {
    this.db.prepare("UPDATE bridge_delivery SET first_view = COALESCE(first_view, ?) WHERE id = ?").run(JSON.stringify(delivery.view), delivery.id);
  }
  isPending(delivery: Delivery): boolean {
    if (delivery.kind === "activity") return Boolean(this.db.prepare("SELECT 1 FROM bridge_delivery WHERE id = ? AND revision = ? AND delivered_revision < ?").get(delivery.id, delivery.revision, delivery.revision));
    return Boolean(this.db.prepare("SELECT 1 FROM bridge_delivery WHERE id = ? AND delivered_revision < ?").get(delivery.id, delivery.revision));
  }
  saveHandle(id: number, handle: MessageHandle): void {
    this.db.prepare("UPDATE bridge_delivery SET handle = ? WHERE id = ?").run(JSON.stringify(handle), id);
  }

  delivered(delivery: Delivery, handle: MessageHandle): void {
    this.db.prepare("UPDATE bridge_delivery SET handle = ?, delivered_revision = MAX(delivered_revision, ?) WHERE id = ?").run(JSON.stringify(handle), delivery.revision, delivery.id);
  }
}
