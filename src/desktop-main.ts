import { mkdir } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { loadDesktopBridgeConfig, type DesktopBridgeConfig } from "./bridge/config.js";
import { BridgeRuntime } from "./bridge/runtime.js";
import { BridgeStore } from "./bridge/store.js";
import { MultiDesktopCatalog } from "./desktop/multi-catalog.js";
import { ConnectedDesktopTasks } from "./desktop/desktop-tasks.js";
import { AppServerTaskCreator } from "./desktop/app-server-creator.js";
import { AppServerTaskTransfer } from "./desktop/app-server-transfer.js";
import { SourceTaskLauncher } from "./desktop/launcher.js";
import { ProfileAccountUsage, ProfileDesktopGoals, ProfileDesktopMetadata } from "./desktop/metadata.js";
import { createDesktopLogger } from "./desktop/logging.js";
import { writeRuntimeProcessState } from "./desktop/process-state.js";
import { DesktopVkGateway } from "./platforms/vk/desktop-gateway.js";
import { DesktopTaskStateTransport } from "./desktop/state-transport.js";
import { observeTaskState } from "./desktop/task-observation.js";
import { RolloutTaskHistoryRecovery } from "./desktop/history-recovery.js";
import { createAppServerProfileOwner } from "./codex/app-server-profile-owner.js";
import { observeAppServerTaskState } from "./codex/app-server-task-state.js";
import { RoutedCodexTasks } from "./core/codex-task-router.js";
import { RoutedTaskStateTransport } from "./core/task-state.js";

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
const launcher = new SourceTaskLauncher(config.codexSources, task => catalog.sourceHome(task));
const creator = new AppServerTaskCreator(catalog, metadata);
const transfer = new AppServerTaskTransfer(catalog, metadata);
const desktop = new ConnectedDesktopTasks(catalog, undefined, metadata,
  new ProfileAccountUsage(config.codexHomes, task => catalog.sourceHome(task), undefined, () => catalog.listSources()), new ProfileDesktopGoals(task => catalog.sourceHome(task)),
  { launcher, creator, transfer });
const sourceIds = catalog.listSources();
const appServerOwners = config.codexSources.flatMap((source, index) => source.owner === "app-server"
  ? [createAppServerProfileOwner(sourceIds[index]!.id, source.home, async projectId => {
    const resolved = await catalog.resolveProject(projectId);
    return { rawProjectId: resolved.rawProjectId, ...(resolved.sourceId ? { sourceId: resolved.sourceId } : {}) };
  })] : []);
const tasks = appServerOwners.length ? new RoutedCodexTasks(desktop, appServerOwners) : desktop;
const desktopStates = new DesktopTaskStateTransport();
const states = appServerOwners.length ? new RoutedTaskStateTransport(desktopStates, appServerOwners) : desktopStates;
const observe = appServerOwners.length ? ((state: import("./core/task-state.js").TaskState,
  previous: import("./core/task-observation.js").TaskObservationCheckpoint | null, now?: number,
  options?: import("./core/task-observation.js").TaskObservationOptions) => state.kind === "app-server"
    ? observeAppServerTaskState(state, previous, now, options) : observeTaskState(state, previous, now, options)) : observeTaskState;
const runtime = new BridgeRuntime(config.access, tasks, gateway, store,
  { states, observe, history: new RolloutTaskHistoryRecovery() }, undefined,
  path.join(config.dataDir, "files"), path.join(config.dataDir, "health.json"), config.healthIntervalMs, undefined, config.projectlessRoot, config.inboundFileLimits);
const startedAt = Date.now();
let exitReason = "process_exit";
let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ reason: exitReason }, "VKodex desktop bridge is stopping");
  await gateway.stop().catch(() => {});
  await runtime.stop().catch(() => {});
  await Promise.allSettled(appServerOwners.map(owner => owner.close()));
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
  gateway.startReconciliation(store);
  runtime.start();
  logger.info("VKodex desktop bridge and VK Long Poll are ready");
} catch (error) {
  exitReason = "startup_error";
  logger.fatal({ error: formatFatalDetail(error) }, "VKodex desktop bridge could not start");
  await shutdown();
  process.exitCode = 1;
}
