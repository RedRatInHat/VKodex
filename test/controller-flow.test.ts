import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "pino";
import type { AppConfig } from "../src/config.js";
import { BotController } from "../src/core/bot-controller.js";
import type { ChatGateway, CreatedConversation, IncomingMessageHandler } from "../src/core/ports/chat-gateway.js";
import type { AgentRunRequest, AgentRunResult, CodingAgent } from "../src/core/ports/coding-agent.js";
import type { SessionStore } from "../src/core/ports/session-store.js";
import type { IncomingMessage, NewSession, OutboundFile, Session, SessionStatus } from "../src/domain/models.js";

const OWNER_ID = 101;

class FakeGateway implements ChatGateway {
  readonly sentText: Array<{ peerId: number; text: string }> = [];
  readonly sentFiles: Array<{ peerId: number; files: readonly OutboundFile[] }> = [];
  private nextChatId = 1;

  onMessage(_handler: IncomingMessageHandler): void {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(peerId: number, text: string): Promise<void> {
    this.sentText.push({ peerId, text });
  }

  async sendFiles(peerId: number, files: readonly OutboundFile[]): Promise<void> {
    this.sentFiles.push({ peerId, files });
  }

  async createConversation(_title: string, _userIds: readonly number[]): Promise<CreatedConversation> {
    const chatId = this.nextChatId;
    this.nextChatId += 1;
    return { chatId, peerId: 2_000_000_000 + chatId };
  }
}

class FakeAgent implements CodingAgent {
  readonly kind = "fake";
  lastRequest: AgentRunRequest | null = null;

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.lastRequest = request;
    const artifactPath = path.join(request.outboxDir, "result.png");
    await writeFile(artifactPath, "fake-image");
    return {
      threadId: request.threadId ?? "thread-1",
      finalText: "Готово.",
      artifacts: [{
        path: artifactPath,
        name: "result.png",
        kind: "image",
        sizeBytes: 10,
      }],
    };
  }
}

class MemorySessionStore implements SessionStore {
  private readonly settings = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  private readonly active = new Map<string, string>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async createSession(input: NewSession): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      ...input,
      agentThreadId: null,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(idOrPrefix: string): Promise<Session | null> {
    const matches = [...this.sessions.values()].filter(
      (session) => session.id === idOrPrefix || session.shortId === idOrPrefix || session.id.startsWith(idOrPrefix),
    );
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  async findByDedicatedPeer(peerId: number): Promise<Session | null> {
    return [...this.sessions.values()].find(
      (session) => session.dedicatedPeerId === peerId && session.status !== "archived",
    ) ?? null;
  }

  async listSessions(includeArchived = false): Promise<readonly Session[]> {
    return [...this.sessions.values()].filter((session) => includeArchived || session.status !== "archived");
  }

  async updateThreadId(sessionId: string, threadId: string): Promise<void> {
    this.update(sessionId, { agentThreadId: threadId });
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    this.update(sessionId, { status });
  }

  async archiveSession(sessionId: string): Promise<void> {
    this.update(sessionId, { status: "archived" });
  }

  async setActiveSession(peerId: number, userId: number, sessionId: string): Promise<void> {
    this.active.set(`${peerId}:${userId}`, sessionId);
  }

  async getActiveSession(peerId: number, userId: number): Promise<Session | null> {
    const sessionId = this.active.get(`${peerId}:${userId}`);
    return sessionId ? this.sessions.get(sessionId) ?? null : null;
  }

  private update(sessionId: string, patch: Partial<Session>): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) throw new Error(`Unknown session ${sessionId}`);
    this.sessions.set(sessionId, {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function message(peerId: number, text: string, isChat: boolean): IncomingMessage {
  return { peerId, senderId: OWNER_ID, isChat, text, attachments: [] };
}

test("owner bootstraps main chat, creates a dedicated session, then runs an agent turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vk-codex-root-"));
  const workspace = path.join(root, "repo");
  await mkdir(workspace);

  const config: AppConfig = {
    vk: {
      token: "vk-test",
      groupId: 999,
      ownerIds: new Set([OWNER_ID]),
      allowedUserIds: new Set([OWNER_ID]),
      mainUserIds: [OWNER_ID],
      conversationMode: "managed",
      sessionMemberMode: "requester",
      messageChunkSize: 3_500,
    },
    codex: {
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: false,
      environmentAllowlist: [],
    },
    files: {
      maxInboundFiles: 10,
      maxInboundFileBytes: 1_000_000,
      maxInboundTotalBytes: 2_000_000,
      maxOutboundFiles: 10,
      maxOutboundFileBytes: 1_000_000,
      maxOutboundTotalBytes: 2_000_000,
      downloadTimeoutMs: 1_000,
    },
    workspaceRoots: [root],
    dataDir: path.join(root, "data"),
    logLevel: "silent",
  };

  const gateway = new FakeGateway();
  const store = new MemorySessionStore();
  const agent = new FakeAgent();
  const controller = new BotController(config, gateway, store, agent, logger);

  await controller.handleMessage(message(OWNER_ID, "/bootstrap", false));
  const mainPeerId = Number(await store.getSetting("main_peer_id"));
  assert.equal(mainPeerId, 2_000_000_001);

  await controller.handleMessage(message(mainPeerId, "/new repo | Image export", true));
  const [session] = await store.listSessions();
  assert.ok(session);
  assert.equal(session.dedicatedPeerId, 2_000_000_002);
  assert.equal(session.workspace, workspace);

  await controller.handleMessage(message(session.dedicatedPeerId, "Собери изображение", true));

  assert.equal(agent.lastRequest?.workspace, workspace);
  assert.equal(agent.lastRequest?.prompt, "Собери изображение");
  assert.equal((await store.getSession(session.id))?.agentThreadId, "thread-1");
  assert.ok(gateway.sentText.some((entry) => entry.peerId === session.dedicatedPeerId && entry.text === "Готово."));
  assert.equal(gateway.sentFiles.at(-1)?.files[0]?.name, "result.png");
});
