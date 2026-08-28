import { mkdir } from "node:fs/promises";
import pino from "pino";
import { loadConfig } from "./config.js";
import { CodexAgent } from "./agents/codex/codex-agent.js";
import { BotController } from "./core/bot-controller.js";
import { VkGateway } from "./platforms/vk/vk-gateway.js";
import { SqliteSessionStore } from "./storage/sqlite-session-store.js";

const config = loadConfig();
const logger = pino({ level: config.logLevel });
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });

const store = new SqliteSessionStore(config.dataDir);
await store.initialize();

if (config.vk.configuredMainPeerId !== undefined) {
  await store.setSetting("main_peer_id", String(config.vk.configuredMainPeerId));
}

const gateway = new VkGateway(config, logger);
const agent = new CodexAgent(config);
const controller = new BotController(config, gateway, store, agent, logger);
gateway.onMessage((message) => controller.handleMessage(message));

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Stopping VK Codex Hub");
  await gateway.stop().catch((error) => logger.error({ err: error }, "VK stop failed"));
  await store.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info(
  {
    groupId: config.vk.groupId,
    conversationMode: config.vk.conversationMode,
    workspaceRoots: config.workspaceRoots,
  },
  "Starting VK Codex Hub",
);

await gateway.start();
