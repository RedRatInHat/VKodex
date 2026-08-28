import { mkdir } from "node:fs/promises";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import type { NewSession, Session, SessionStatus } from "../domain/models.js";
import type { SessionStore } from "../core/ports/session-store.js";

interface SessionRow {
  id: string;
  short_id: string;
  title: string;
  workspace: string;
  agent_kind: string;
  agent_thread_id: string | null;
  dedicated_peer_id: number | null;
  dedicated_chat_id: number | null;
  created_by_vk_user_id: number;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    shortId: row.short_id,
    title: row.title,
    workspace: row.workspace,
    agentKind: row.agent_kind,
    agentThreadId: row.agent_thread_id,
    dedicatedPeerId: row.dedicated_peer_id,
    dedicatedChatId: row.dedicated_chat_id,
    createdByVkUserId: row.created_by_vk_user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSessionStore implements SessionStore {
  private database: Database | null = null;

  constructor(private readonly dataDir: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    // Keep the filename so existing deployments retain their sessions after the rename.
    const database = new DatabaseConstructor(path.join(this.dataDir, "vk-codex-hub.sqlite"));
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        agent_kind TEXT NOT NULL,
        agent_thread_id TEXT,
        dedicated_peer_id INTEGER,
        dedicated_chat_id INTEGER,
        created_by_vk_user_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'busy', 'archived', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_dedicated_peer
      ON sessions(dedicated_peer_id)
      WHERE dedicated_peer_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS active_sessions (
        peer_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (peer_id, user_id)
      );
    `);
    this.database = database;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  private db(): Database {
    if (!this.database) throw new Error("Session store has not been initialized");
    return this.database;
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db()
      .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  async createSession(input: NewSession): Promise<Session> {
    const now = new Date().toISOString();
    this.db()
      .prepare(`
        INSERT INTO sessions(
          id, short_id, title, workspace, agent_kind, agent_thread_id,
          dedicated_peer_id, dedicated_chat_id, created_by_vk_user_id,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ready', ?, ?)
      `)
      .run(
        input.id,
        input.shortId,
        input.title,
        input.workspace,
        input.agentKind,
        input.dedicatedPeerId,
        input.dedicatedChatId,
        input.createdByVkUserId,
        now,
        now,
      );
    const session = await this.getSession(input.id);
    if (!session) throw new Error("Created session could not be read back");
    return session;
  }

  async getSession(idOrPrefix: string): Promise<Session | null> {
    const exact = this.db()
      .prepare("SELECT * FROM sessions WHERE id = ? OR short_id = ?")
      .get(idOrPrefix, idOrPrefix) as SessionRow | undefined;
    if (exact) return toSession(exact);

    const rows = this.db()
      .prepare("SELECT * FROM sessions WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2")
      .all(`${idOrPrefix}%`) as SessionRow[];
    return rows.length === 1 && rows[0] ? toSession(rows[0]) : null;
  }

  async findByDedicatedPeer(peerId: number): Promise<Session | null> {
    const row = this.db()
      .prepare("SELECT * FROM sessions WHERE dedicated_peer_id = ? AND status <> 'archived'")
      .get(peerId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async listSessions(includeArchived = false): Promise<readonly Session[]> {
    const rows = this.db()
      .prepare(
        includeArchived
          ? "SELECT * FROM sessions ORDER BY updated_at DESC"
          : "SELECT * FROM sessions WHERE status <> 'archived' ORDER BY updated_at DESC",
      )
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  async updateThreadId(sessionId: string, threadId: string): Promise<void> {
    this.db()
      .prepare("UPDATE sessions SET agent_thread_id = ?, updated_at = ? WHERE id = ?")
      .run(threadId, new Date().toISOString(), sessionId);
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    this.db()
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), sessionId);
  }

  async archiveSession(sessionId: string): Promise<void> {
    const transaction = this.db().transaction(() => {
      this.db()
        .prepare("UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), sessionId);
      this.db().prepare("DELETE FROM active_sessions WHERE session_id = ?").run(sessionId);
    });
    transaction();
  }

  async setActiveSession(peerId: number, userId: number, sessionId: string): Promise<void> {
    this.db()
      .prepare(`
        INSERT INTO active_sessions(peer_id, user_id, session_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(peer_id, user_id)
        DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
      `)
      .run(peerId, userId, sessionId, new Date().toISOString());
  }

  async getActiveSession(peerId: number, userId: number): Promise<Session | null> {
    const row = this.db()
      .prepare(`
        SELECT sessions.*
        FROM active_sessions
        JOIN sessions ON sessions.id = active_sessions.session_id
        WHERE active_sessions.peer_id = ?
          AND active_sessions.user_id = ?
          AND sessions.status <> 'archived'
      `)
      .get(peerId, userId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }
}
