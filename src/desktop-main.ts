import { mkdir } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { loadDesktopBridgeConfig, type DesktopBridgeConfig } from "./bridge/config.js";
import { BridgeRuntime } from "./bridge/runtime.js";
import { BridgeStore } from "./bridge/store.js";
import { MultiDesktopCatalog } from "./desktop/multi-catalog.js";
import { LocalDesktopCatalog } from "./desktop/catalog.js";
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
import { createAppServerProfileOwner, createDetachedAppServerProfileOwner } from "./codex/app-server-profile-owner.js";
import { observeAppServerTaskState } from "./codex/app-server-task-state.js";
import { inspectThroughOwner } from "./desktop/owner-channel.js";
import { ManagedOwnerRouteResolver } from "./bridge/managed-owner-route-resolver.js";
import { inspectManagedRestartTurn } from "./bridge/managed-owner-observed-task-state-transport.js";
import { createDesktopRouting } from "./desktop/desktop-routing.js";
import { sameTask } from "./core/codex-tasks.js";
import type { AppServerStreamDiagnostic } from "./codex/app-server-task-state.js";

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
const catalog = new MultiDesktopCatalog(config.codexHomes,
  home => new LocalDesktopCatalog(home, config.projectCatalogMode));
const metadata = new ProfileDesktopMetadata(task => catalog.sourceHome(task), undefined, undefined, config.projectCatalogMode);
const launcher = new SourceTaskLauncher(config.codexSources, task => catalog.sourceHome(task));
const creator = new AppServerTaskCreator(catalog, metadata);
const transfer = new AppServerTaskTransfer(catalog, metadata);
const desktop = new ConnectedDesktopTasks(catalog, undefined, metadata,
  new ProfileAccountUsage(config.codexHomes, task => catalog.sourceHome(task), undefined, () => catalog.listSources()), new ProfileDesktopGoals(task => catalog.sourceHome(task)),
  { launcher, creator, transfer });
const sourceIds = catalog.listSources();
const recordAppServerDiagnostic = (task: import("./core/codex-tasks.js").TaskRef, event: AppServerStreamDiagnostic): void => {
  // The transport has a task, not a VK binding. Record only for exact attached matches.
  const binding = store.bindings().find(candidate => candidate.attached && sameTask(candidate, task));
  if (!binding) return;
  try { store.recordConnectionDiagnostic(binding.id, { at: Date.now(), ...event }, task); }
  catch { /* A diagnostic write must never affect a live Codex turn. */ }
};
const detachedProfileBase = process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA)
  ? path.join(process.env.LOCALAPPDATA, "VKodex", "owner-private") : null;
const appServerOwners = config.codexSources.flatMap((source, index) => {
  const resolveProject = async (projectId: string) => {
    const resolved = await catalog.resolveProject(projectId);
    return { rawProjectId: resolved.rawProjectId, ...(resolved.sourceId ? { sourceId: resolved.sourceId } : {}) };
  };
  if (source.owner === "app-server")
    return [createAppServerProfileOwner(sourceIds[index]!.id, source.home, resolveProject, recordAppServerDiagnostic)];
  if (source.owner === "detached-app-server") {
    if (!detachedProfileBase) throw new Error("Independent profile owner requires Windows user-local storage");
    return [createDetachedAppServerProfileOwner(sourceIds[index]!.id, source.home,
      detachedProfileBase, source.detachedThreadIds!, resolveProject, recordAppServerDiagnostic)];
  }
  return [];
});
const desktopStates = new DesktopTaskStateTransport();
// The private base is reserved for managed workers; an absent endpoint or
// unqualified claim stays exclusive but unavailable. No worker is launched here.
const managedResolver = new ManagedOwnerRouteResolver({ store,
  privateBaseDirectory: path.resolve(config.dataDir, "managed-workers") });
const { tasks, states, passiveStates } = createDesktopRouting(desktop, desktopStates, appServerOwners, store,
  managedResolver, async task => (await inspectThroughOwner(catalog.sourceHome(task), task.threadId)) !== null);
const observe = (state: import("./core/task-state.js").TaskState,
  previous: import("./core/task-observation.js").TaskObservationCheckpoint | null, now?: number,
  options?: import("./core/task-observation.js").TaskObservationOptions) => state.kind === "app-server"
    ? observeAppServerTaskState(state, previous, now, options) : observeTaskState(state, previous, now, options);
const runtime = new BridgeRuntime(config.access, tasks, gateway, store,
  { states, ...(passiveStates ? { passiveStates } : {}), observe, history: new RolloutTaskHistoryRecovery(),
    inspectExternalOwner: task => inspectThroughOwner(catalog.sourceHome(task), task.threadId),
    inspectManagedRestartTurn: (task, snapshot) => managedResolver.owns(task)
      ? inspectManagedRestartTurn(managedResolver, task, snapshot)
      : Promise.resolve("unclaimed" as const) }, undefined,
  path.join(config.dataDir, "files"), path.join(config.dataDir, "health.json"), config.healthIntervalMs, undefined, config.projectlessRoot, config.inboundFileLimits,
  config.stagedFilePilot);
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
  // A controlled bridge restart leaves a one-shot intent next to the private
  // database. Recover it only after VK and the task streams are live; the
  // durable inbox event ID makes a second startup idempotent.
  await runtime.recoverRestartIntent(config.dataDir).catch(error => {
    logger.warn({ error: formatFatalDetail(error) }, "VKodex restart recovery is waiting for a task owner");
    const retry = setTimeout(() => {
      void runtime.recoverRestartIntent(config.dataDir).catch(retryError =>
        logger.warn({ error: formatFatalDetail(retryError) }, "VKodex restart recovery retry is still waiting"));
    }, 30_000);
    retry.unref();
  });
  logger.info("VKodex desktop bridge and VK Long Poll are ready");
} catch (error) {
  exitReason = "startup_error";
  logger.fatal({ error: formatFatalDetail(error) }, "VKodex desktop bridge could not start");
  await shutdown();
  process.exitCode = 1;
}
