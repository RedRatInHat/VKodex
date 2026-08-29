import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadDesktopBridgeConfig } from "./bridge/config.js";
import { DesktopBridgeRuntime } from "./bridge/runtime.js";
import { BridgeStore } from "./bridge/store.js";
import { MultiDesktopCatalog } from "./desktop/multi-catalog.js";
import { ConnectedDesktopTasks } from "./desktop/desktop-tasks.js";
import { ProfileDesktopMetadata } from "./desktop/metadata.js";
import { SdkTaskExecutor } from "./desktop/sdk-executor.js";
import { DesktopVkGateway } from "./platforms/vk/desktop-gateway.js";

const config = loadDesktopBridgeConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const store = new BridgeStore(path.join(config.dataDir, "vkodex.sqlite"));
store.assertPrimaryHome(config.codexHome);
const gateway = new DesktopVkGateway(config);
const catalog = new MultiDesktopCatalog(config.codexHomes);
const metadata = new ProfileDesktopMetadata(task => catalog.sourceHome(task));
const desktop = new ConnectedDesktopTasks(catalog, undefined, metadata, new SdkTaskExecutor(catalog, metadata));
const runtime = new DesktopBridgeRuntime(config.access, desktop, gateway, store, undefined, undefined, path.join(config.dataDir, "files"));
let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await gateway.stop().catch(() => {});
  await runtime.stop();
  store.close();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
try {
  runtime.start();
  process.stdout.write("VKodex desktop bridge: starting (experimental).\n");
  await gateway.start(input => runtime.handle(input));
  process.stdout.write("VKodex desktop bridge: VK Long Poll started.\n");
} catch {
  process.stderr.write("VKodex desktop bridge could not start. Check the local configuration and connections.\n");
  await shutdown();
  process.exitCode = 1;
}
