import { mkdir } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { loadDesktopBridgeConfig, type DesktopBridgeConfig } from "./bridge/config.js";
import { DesktopBridgeRuntime } from "./bridge/runtime.js";
import { BridgeStore } from "./bridge/store.js";
import { MultiDesktopCatalog } from "./desktop/multi-catalog.js";
import { ConnectedDesktopTasks } from "./desktop/desktop-tasks.js";
import { ProfileAccountUsage, ProfileDesktopGoals, ProfileDesktopMetadata } from "./desktop/metadata.js";
import { createDesktopLogger } from "./desktop/logging.js";
import { writeRuntimeProcessState } from "./desktop/process-state.js";
import { SdkTaskExecutor } from "./desktop/sdk-executor.js";
import { DesktopVkGateway } from "./platforms/vk/desktop-gateway.js";

const formatFatalDetail = (value: unknown): string => {
  const detail = value instanceof Error ? (value.stack ?? value.message) : inspect(value, { depth: 4, breakLength: 120 });
  return detail.slice(0, 32_768);
};
const bootstrapDataDir = path.resolve(process.env.BOT_DATA_DIR || "./data/desktop");
await mkdir(bootstrapDataDir, { recursive: true, mode: 0o700 });
const logger = createDesktopLogger(bootstrapDataDir);
let config: DesktopBridgeConfig;
try { config = loadDesktopBridgeConfig(); }
catch (error) {
  logger.fatal({ error: formatFatalDetail(error) }, "VKodex desktop bridge configuration is invalid");
  process.exit(1);
}
const store = new BridgeStore(path.join(config.dataDir, "vkodex.sqlite"));
store.assertPrimaryHome(config.codexHome);
const gateway = new DesktopVkGateway(config, undefined, undefined, logger);
const catalog = new MultiDesktopCatalog(config.codexHomes);
const metadata = new ProfileDesktopMetadata(task => catalog.sourceHome(task));
const desktop = new ConnectedDesktopTasks(catalog, undefined, metadata, new SdkTaskExecutor(catalog, metadata),
  new ProfileAccountUsage(config.codexHomes, task => catalog.sourceHome(task)), new ProfileDesktopGoals(task => catalog.sourceHome(task)));
const runtime = new DesktopBridgeRuntime(config.access, desktop, gateway, store, undefined, undefined,
  path.join(config.dataDir, "files"), path.join(config.dataDir, "health.json"), config.healthIntervalMs);
const startedAt = Date.now();
let exitReason = "process_exit";
let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ reason: exitReason }, "VKodex desktop bridge is stopping");
  await gateway.stop().catch(() => {});
  await runtime.stop().catch(() => {});
  try { store.close(); } catch { /* Process is already stopping. */ }
};
writeRuntimeProcessState(config.dataDir, { status: "running", pid: process.pid, at: startedAt, startedAt });
process.once("exit", code => {
  writeRuntimeProcessState(config.dataDir, { status: "stopped", pid: process.pid, at: Date.now(), startedAt, exitCode: code, reason: exitReason });
});
process.once("SIGINT", () => { exitReason = "SIGINT"; void shutdown(); });
process.once("SIGTERM", () => { exitReason = "SIGTERM"; void shutdown(); });

let fatal = false;
const fatalShutdown = (reason: "uncaught_exception" | "unhandled_rejection", detail: unknown): void => {
  if (fatal) return;
  fatal = true; exitReason = reason;
  logger.fatal({ reason, error: formatFatalDetail(detail) }, "VKodex desktop bridge stopped unexpectedly");
  const hardStop = setTimeout(() => process.exit(1), 5_000);
  void shutdown().finally(() => { clearTimeout(hardStop); process.exit(1); });
};
process.once("uncaughtException", error => fatalShutdown("uncaught_exception", error));
process.once("unhandledRejection", reason => fatalShutdown("unhandled_rejection", reason));
try {
  logger.info("VKodex desktop bridge is starting");
  await gateway.start(input => runtime.handle(input));
  runtime.start();
  logger.info("VKodex desktop bridge and VK Long Poll are ready");
} catch (error) {
  exitReason = "startup_error";
  logger.fatal({ error: formatFatalDetail(error) }, "VKodex desktop bridge could not start");
  await shutdown();
  process.exitCode = 1;
}
