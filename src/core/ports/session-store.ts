import type { NewSession, Session, SessionStatus } from "../../domain/models.js";

export interface SessionStore {
  initialize(): Promise<void>;
  close(): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  createSession(input: NewSession): Promise<Session>;
  getSession(idOrPrefix: string): Promise<Session | null>;
  findByDedicatedPeer(peerId: number): Promise<Session | null>;
  listSessions(includeArchived?: boolean): Promise<readonly Session[]>;
  updateThreadId(sessionId: string, threadId: string): Promise<void>;
  updateStatus(sessionId: string, status: SessionStatus): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;

  setActiveSession(peerId: number, userId: number, sessionId: string): Promise<void>;
  getActiveSession(peerId: number, userId: number): Promise<Session | null>;
}
