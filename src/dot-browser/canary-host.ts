import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { Readable, Writable } from "node:stream";
import { BridgeStore } from "../bridge/store.js";
import { withDiagnosticSink, diagnosticEvent } from "../bridge/diagnostics.js";
import { prepareDiagnosticDirectory } from "../desktop/diagnostic-private-directory.js";
import { createDiagnosticLog } from "../desktop/diagnostic-log.js";
import { parseDotCanaryConfig } from "./canary-config.js";
import { DotCanaryCoordinator } from "./canary-coordinator.js";
import { DotBrowserConnectionGate, type DotBrowserLease } from "./connection-gate.js";
import { DotNativeControlPeer } from "./native-control-peer.js";
import { DotRoomInputJournal } from "./input-journal.js";
import { parseDotNativeHostInvocation } from "./native-host-invocation.js";

/** No command service on this pipe: an OS-lifetime singleton only. */
export async function acquireDotCanaryHostSingleton(databasePath: string): Promise<() => Promise<void>> {
  if (process.platform !== "win32") throw new Error("Windows native host required");
  const parent = await realpath(path.dirname(databasePath));
  const key = createHash("sha256").update(path.join(parent, path.basename(databasePath)).toLowerCase()).digest("hex");
  const server = createServer(socket => socket.destroy()); server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(`\\\\.\\pipe\\vkodex-dot-canary-${key}`, () => { server.off("error", reject); resolve(); });
  });
  server.on("error", () => {});
  return () => new Promise(resolve => server.close(() => resolve()));
}

/** Explicit diagnostic runtime only. Browser installation/host registration is
 * external and separately approved. stdout is reserved for framed protocol.
 */
export async function runDotCanaryNativeHost(args: readonly string[], input: Readable, output: Writable,
  acquire: (databasePath: string) => Promise<() => Promise<void>> = acquireDotCanaryHostSingleton): Promise<void> {
  const invocation = parseDotNativeHostInvocation(args);
  const bytes = await readFile(invocation.configPath);
  if (bytes.length > 16_384) throw new Error("Diagnostic config too large");
  const config = parseDotCanaryConfig(JSON.parse(bytes.toString("utf8")));
  const release = await acquire(config.databasePath);
  let store: BridgeStore | undefined, peer: DotNativeControlPeer | undefined;
  try {
    const directory = path.join(path.dirname(config.databasePath), "diagnostics");
    if (!await prepareDiagnosticDirectory(directory)) throw new Error("Private diagnostics unavailable");
    const log = await createDiagnosticLog(directory);
    if (log.status().state !== "ready") throw new Error("Diagnostic log unavailable");
    try {
      store = new BridgeStore(config.databasePath);
      if (store.bindings().length !== 0) throw new Error("Diagnostic database contains production bindings");
      store.requireDurableWrites();
      const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex");
      store.atomic(() => {
        const previous = store!.getValue<string>("dot-canary-config");
        if (previous !== null && previous !== fingerprint) throw new Error("Diagnostic configuration changed");
        store!.setValue("dot-canary-config", fingerprint);
      });
      const journal = new DotRoomInputJournal(store, config);
      // Exclusive host ownership was acquired before startup recovery.
      store.recover(); journal.recoverInterrupted();
      const gate = new DotBrowserConnectionGate(config); gate.setEnabled(true);
      let stopped = false, lease: DotBrowserLease | null = null;
      peer = new DotNativeControlPeer(input, output, () => { stopped = true; if (lease) gate.disconnect(lease); });
      const coordinator = new DotCanaryCoordinator(config, store, gate, peer);
      await withDiagnosticSink(log.write, async () => {
        diagnosticEvent("connection.result", { route: "dot-browser", outcome: "success", stage: "connect" });
        while (!stopped && log.status().state === "ready") {
          // No page polling or command is necessary while the diagnostic queue is empty.
          if (store!.replayableInputStats().count > 0) {
            if (lease === null) lease = gate.connect(Date.now());
            if (lease === null || gate.availability(Date.now()) === "disconnected") break;
            const result = await coordinator.tick(lease);
            store!.setValue("dot-canary-host-status", { at: Date.now(), phase: result.phase,
              ...("operationId" in result ? { operationId: result.operationId } : {}) });
            if (["observed", "uncertain", "unknown", "rejected", "blocked"].includes(result.phase)) break;
          }
          if (!stopped) await new Promise(resolve => setTimeout(resolve, 250));
        }
        diagnosticEvent("connection.lifecycle", { route: "dot-browser", stage: "disconnect", outcome: "finished" });
      });
    } finally { await log.flush(); }
  } finally {
    peer?.close(); store?.close(); await release();
  }
}
