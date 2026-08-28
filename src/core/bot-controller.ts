import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { IncomingMessage, Session } from "../domain/models.js";
import type { CodingAgent } from "./ports/coding-agent.js";
import type { ChatGateway } from "./ports/chat-gateway.js";
import type { SessionStore } from "./ports/session-store.js";
import { UserFacingError } from "./errors.js";
import { TurnCoordinator } from "./turn-coordinator.js";
import { commandArgument, commandName, parseNewCommand } from "../lib/commands.js";
import { materializeAttachments, prepareBridgeTurnDirectories, resolveWorkspace } from "../lib/files.js";
import { chunkText } from "../lib/text.js";

const MAIN_PEER_SETTING = "main_peer_id";

export class BotController {
  private readonly turns = new TurnCoordinator();

  constructor(
    private readonly config: AppConfig,
    private readonly gateway: ChatGateway,
    private readonly store: SessionStore,
    private readonly agent: CodingAgent,
    private readonly logger: Logger,
  ) {}

  async handleMessage(message: IncomingMessage): Promise<void> {
    if (!this.config.vk.allowedUserIds.has(message.senderId)) {
      this.logger.warn({ peerId: message.peerId, senderId: message.senderId }, "Denied VK user");
      return;
    }

    try {
      const dedicatedSession = await this.store.findByDedicatedPeer(message.peerId);
      if (dedicatedSession) {
        await this.handleSessionMessage(message, dedicatedSession);
        return;
      }

      if (await this.isControlPeer(message)) {
        await this.handleControlMessage(message);
      }
    } catch (error) {
      const incidentId = randomUUID().slice(0, 8);
      this.logger.error(
        { err: error, incidentId, peerId: message.peerId, senderId: message.senderId },
        "Message handling failed",
      );
      const visible = error instanceof UserFacingError
        ? error.message
        : `Внутренняя ошибка (${incidentId}). Подробности записаны в журнале бота.`;
      await this.safeSend(message.peerId, visible);
    }
  }

  private async isControlPeer(message: IncomingMessage): Promise<boolean> {
    const stored = await this.store.getSetting(MAIN_PEER_SETTING);
    const mainPeerId = this.config.vk.configuredMainPeerId ?? (stored ? Number(stored) : undefined);
    if (mainPeerId !== undefined && message.peerId === mainPeerId) return true;
    return !message.isChat && this.config.vk.ownerIds.has(message.senderId);
  }

  private async handleControlMessage(message: IncomingMessage): Promise<void> {
    const command = commandName(message.text);

    if (command === "help" || command === "start") {
      await this.sendChunks(message.peerId, MAIN_HELP);
      return;
    }

    if (command === "bootstrap") {
      this.assertOwner(message.senderId);
      const conversation = await this.gateway.createConversation("[Codex] Main", this.config.vk.mainUserIds);
      await this.store.setSetting(MAIN_PEER_SETTING, String(conversation.peerId));
      await this.sendChunks(
        message.peerId,
        `Главный чат создан: peer_id=${conversation.peerId}. Дальше используйте /new в нём.`,
      );
      await this.sendChunks(conversation.peerId, "Это главный чат VK Codex Hub. Используйте /help.");
      return;
    }

    if (command === "new") {
      this.assertOwner(message.senderId);
      const parsed = parseNewCommand(message.text);
      if (!parsed?.workspace) {
        throw new UserFacingError("Формат: /new <workspace> | <название>");
      }
      const session = await this.createSession(message, parsed.workspace, parsed.title);
      const destination = session.dedicatedPeerId
        ? `Отдельная VK-беседа создана: «${session.title}».`
        : "VK-беседа не создана; сессия выбрана в текущем главном чате.";
      await this.sendChunks(
        message.peerId,
        `Сессия ${session.shortId} создана.\nWorkspace: ${session.workspace}\n${destination}`,
      );
      if (session.dedicatedPeerId) {
        await this.sendChunks(
          session.dedicatedPeerId,
          `Codex-сессия ${session.shortId}\n${session.title}\nWorkspace: ${session.workspace}\n\nПишите задачу или приложите фото/документ.`,
        );
      }
      return;
    }

    if (command === "list") {
      const sessions = await this.store.listSessions();
      const text = sessions.length
        ? sessions.map((session) => this.formatSessionLine(session)).join("\n")
        : "Активных сессий нет.";
      await this.sendChunks(message.peerId, text);
      return;
    }

    if (command === "use") {
      const id = commandArgument(message.text);
      const session = await this.requireSession(id);
      await this.store.setActiveSession(message.peerId, message.senderId, session.id);
      await this.sendChunks(message.peerId, `Выбрана сессия ${session.shortId}: ${session.title}`);
      return;
    }

    if (command === "status") {
      const active = await this.store.getActiveSession(message.peerId, message.senderId);
      const stored = await this.store.getSetting(MAIN_PEER_SETTING);
      await this.sendChunks(
        message.peerId,
        [
          `Режим бесед: ${this.config.vk.conversationMode}`,
          `Главный peer_id: ${this.config.vk.configuredMainPeerId ?? stored ?? "не задан"}`,
          `Активная сессия здесь: ${active ? `${active.shortId} — ${active.title}` : "нет"}`,
        ].join("\n"),
      );
      return;
    }

    if (command) {
      throw new UserFacingError("Неизвестная команда главного чата. Используйте /help.");
    }

    const active = await this.store.getActiveSession(message.peerId, message.senderId);
    if (!active) {
      throw new UserFacingError("Это главный чат. Создайте /new или выберите /use <id>.");
    }
    await this.runTurn(message, active);
  }

  private async handleSessionMessage(message: IncomingMessage, session: Session): Promise<void> {
    const command = commandName(message.text);
    if (command === "help") {
      await this.sendChunks(message.peerId, SESSION_HELP);
      return;
    }
    if (command === "status") {
      await this.sendChunks(
        message.peerId,
        [
          `${session.shortId} — ${session.title}`,
          `Workspace: ${session.workspace}`,
          `Codex thread: ${session.agentThreadId ?? "будет создан на первом ходе"}`,
          `Статус: ${this.turns.isBusy(session.id) ? "busy" : session.status}`,
        ].join("\n"),
      );
      return;
    }
    if (command === "stop") {
      const stopped = this.turns.stop(session.id);
      await this.sendChunks(message.peerId, stopped ? "Останавливаю текущий ход." : "Активного хода нет.");
      return;
    }
    if (command === "close") {
      if (message.senderId !== session.createdByVkUserId && !this.config.vk.ownerIds.has(message.senderId)) {
        throw new UserFacingError("Закрыть сессию может её создатель или владелец бота.");
      }
      if (this.turns.isBusy(session.id)) throw new UserFacingError("Сначала остановите активный ход через /stop.");
      await this.store.archiveSession(session.id);
      await this.sendChunks(message.peerId, `Сессия ${session.shortId} архивирована.`);
      return;
    }
    if (command) throw new UserFacingError("Неизвестная команда сессии. Используйте /help.");
    await this.runTurn(message, session);
  }

  private async createSession(message: IncomingMessage, workspaceInput: string, requestedTitle?: string): Promise<Session> {
    const workspace = await resolveWorkspace(workspaceInput, this.config.workspaceRoots);
    const title = (requestedTitle?.trim() || path.basename(workspace)).slice(0, 120);
    let dedicatedPeerId: number | null = null;
    let dedicatedChatId: number | null = null;

    if (this.config.vk.conversationMode !== "single") {
      const members = this.config.vk.sessionMemberMode === "main-users"
        ? this.config.vk.mainUserIds
        : [message.senderId];
      try {
        const conversation = await this.gateway.createConversation(`[Codex] ${title}`, members);
        dedicatedPeerId = conversation.peerId;
        dedicatedChatId = conversation.chatId;
      } catch (error) {
        this.logger.warn({ err: error, title, members }, "Could not create dedicated VK conversation");
        if (this.config.vk.conversationMode === "managed") {
          throw new UserFacingError(
            "VK не разрешил создать отдельную беседу. Проверьте права токена, настройки сообщества и доступность пользователей для приглашения.",
          );
        }
      }
    }

    const id = randomUUID();
    const session = await this.store.createSession({
      id,
      shortId: id.slice(0, 8),
      title,
      workspace,
      agentKind: this.agent.kind,
      dedicatedPeerId,
      dedicatedChatId,
      createdByVkUserId: message.senderId,
    });
    await this.store.setActiveSession(message.peerId, message.senderId, session.id);
    return session;
  }

  private async runTurn(message: IncomingMessage, session: Session): Promise<void> {
    if (!message.text.trim() && message.attachments.length === 0) {
      throw new UserFacingError("Пришлите текст, фотографию или документ.");
    }

    if (this.turns.isBusy(session.id)) {
      throw new UserFacingError("Эта Codex-сессия уже выполняет задачу. Используйте /stop, чтобы прервать её.");
    }
    await this.sendChunks(message.peerId, `⏳ ${session.shortId}: Codex выполняет задачу…`);
    await this.turns.run(session.id, async (signal) => {
      await this.store.updateStatus(session.id, "busy");
      const turnId = randomUUID();
      const { inboxDir, outboxDir } = await prepareBridgeTurnDirectories(session.workspace, turnId);

      try {
        const inputFiles = await materializeAttachments(message.attachments, inboxDir, {
          maxFiles: this.config.files.maxInboundFiles,
          maxFileBytes: this.config.files.maxInboundFileBytes,
          maxTotalBytes: this.config.files.maxInboundTotalBytes,
          timeoutMs: this.config.files.downloadTimeoutMs,
        });

        const result = await this.agent.run({
          threadId: session.agentThreadId,
          workspace: session.workspace,
          prompt: message.text,
          inputFiles,
          outboxDir,
          signal,
          onProgress: (progress) => {
            this.logger.debug({ sessionId: session.id, progress }, "Codex progress");
          },
        });

        if (result.threadId !== session.agentThreadId) {
          await this.store.updateThreadId(session.id, result.threadId);
        }
        await this.store.updateStatus(session.id, "ready");
        await this.sendChunks(message.peerId, result.finalText);
        if (result.artifacts.length > 0) await this.gateway.sendFiles(message.peerId, result.artifacts);
      } catch (error) {
        await this.store.updateStatus(session.id, signal.aborted ? "ready" : "error");
        if (signal.aborted) {
          await this.sendChunks(message.peerId, "Ход Codex остановлен.");
          return;
        }
        throw error;
      }
    });
  }

  private async requireSession(id: string): Promise<Session> {
    if (!id) throw new UserFacingError("Укажите ID сессии: /use <id>.");
    const session = await this.store.getSession(id);
    if (!session || session.status === "archived") throw new UserFacingError("Сессия не найдена.");
    return session;
  }

  private assertOwner(userId: number): void {
    if (!this.config.vk.ownerIds.has(userId)) throw new UserFacingError("Команда доступна только владельцу бота.");
  }

  private formatSessionLine(session: Session): string {
    const location = session.dedicatedPeerId ? `VK peer ${session.dedicatedPeerId}` : "main-chat mode";
    return `${session.shortId} [${session.status}] ${session.title} — ${location}`;
  }

  private async sendChunks(peerId: number, text: string): Promise<void> {
    for (const chunk of chunkText(text, this.config.vk.messageChunkSize)) {
      await this.gateway.sendText(peerId, chunk);
    }
  }

  private async safeSend(peerId: number, text: string): Promise<void> {
    try {
      await this.sendChunks(peerId, text);
    } catch (error) {
      this.logger.error({ err: error, peerId }, "Could not send VK error message");
    }
  }
}

const MAIN_HELP = [
  "VK Codex Hub — главный чат",
  "",
  "/bootstrap — создать отдельный главный VK-чат",
  "/new <workspace> | <название> — создать Codex-сессию",
  "/list — список сессий",
  "/use <id> — выбрать сессию для работы в главном чате",
  "/status — состояние",
  "/help — помощь",
  "",
  "В режиме auto бот попробует создать отдельную VK-беседу для каждой сессии и откатится к этому чату при ошибке VK.",
].join("\n");

const SESSION_HELP = [
  "VK Codex Hub — чат сессии",
  "",
  "Обычный текст — новый ход Codex",
  "Фото — structured local_image для Codex",
  "Документ — сохраняется в workspace и передаётся Codex по локальному пути",
  "/status — состояние сессии",
  "/stop — остановить активный ход",
  "/close — архивировать сессию",
  "/help — помощь",
].join("\n");
