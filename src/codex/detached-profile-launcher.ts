import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, open, rename } from "node:fs/promises";
import path from "node:path";
import { buildCodexEnvironment } from "../agents/codex/codex-environment.js";
import { ensureProtectedLocalDirectory } from "../desktop/managed-worker-private-state.js";
import { readWindowsProcessIdentityAsync } from "../desktop/windows-process-identity.js";
import { createAppServerWebSocketConnection } from "./app-server-websocket-connection.js";
import { canonicalDetachedProfileHome, detachedProfileDirectory, detachedProfileKey,
  type DetachedProfileDescriptor } from "./detached-profile-capability.js";
import { nativeCodexPath } from "./native-cli.js";

export interface DetachedProfileLaunchOptions {
  readonly dataDirectory: string;
  readonly home: string;
  readonly port: number;
}

/** Never retry this error by spawning again: a server may already exist even
 * when publication or its acknowledgement failed. Inspect the reservation. */
export class DetachedProfileLaunchError extends Error {
  constructor(readonly phase: "reservation" | "spawn" | "identity" | "handshake" | "publication") {
    super("Independent Codex App Server launch is unresolved; reservation retained.");
    this.name = "DetachedProfileLaunchError";
  }
}

async function writeExclusive(file: string, value: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(value, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

async function absent(file: string): Promise<boolean> {
  try { await lstat(file); return false; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

/** First-launch primitive for an independently supervised profile. It never
 * replaces a ready backend or guesses whether an incomplete launch dispatched.
 * The calling service must retain the profile server independently of VKodex. */
export async function launchDetachedProfileServer(input: DetachedProfileLaunchOptions): Promise<DetachedProfileDescriptor> {
  if (process.platform !== "win32" || !path.isAbsolute(input.dataDirectory) || !path.isAbsolute(input.home) ||
    !Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65535)
    throw new TypeError("Invalid independent profile launch scope");
  const home = canonicalDetachedProfileHome(input.home);
  const privateDirectory = detachedProfileDirectory(input.dataDirectory, home);
  await ensureProtectedLocalDirectory(input.dataDirectory);
  await ensureProtectedLocalDirectory(path.dirname(privateDirectory));
  await ensureProtectedLocalDirectory(privateDirectory);
  const readyFile = path.join(privateDirectory, "ready.json");
  const reservationFile = path.join(privateDirectory, "launching.json");
  // A stale descriptor or an uncertain prior launch is never an invitation to
  // create another writer. Reconciliation must prove exact process absence.
  if (!await absent(readyFile)) throw new DetachedProfileLaunchError("reservation");
  const epoch = randomUUID();
  const url = `ws://127.0.0.1:${input.port}`;
  try {
    await writeExclusive(reservationFile, JSON.stringify({ schemaVersion: 1, epoch,
      profileKey: detachedProfileKey(home), home, url }));
  } catch { throw new DetachedProfileLaunchError("reservation"); }
  const epochDirectory = path.join(privateDirectory, epoch);
  const tokenFile = path.join(epochDirectory, "token");
  const token = randomBytes(32).toString("base64url");
  try {
    await ensureProtectedLocalDirectory(epochDirectory);
    await writeExclusive(tokenFile, token);
  } catch { throw new DetachedProfileLaunchError("reservation"); }
  let pid: number;
  try {
    const cli = nativeCodexPath();
    const entry = await lstat(cli);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe CLI");
    const child = spawn(cli, ["app-server", "--listen", url, "--ws-auth", "capability-token",
      "--ws-token-file", tokenFile], {
      cwd: home, env: { ...buildCodexEnvironment(process.env), CODEX_HOME: home },
      detached: true, windowsHide: true, stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve); child.once("error", reject);
    });
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) throw new Error("Missing PID");
    pid = child.pid!;
    child.unref();
  } catch { throw new DetachedProfileLaunchError("spawn"); }
  let identity: Readonly<{ pid: number; birthTicks: string }> | null;
  try { identity = await readWindowsProcessIdentityAsync(pid); }
  catch { throw new DetachedProfileLaunchError("identity"); }
  if (!identity || identity.pid !== pid) throw new DetachedProfileLaunchError("identity");
  const rpc = createAppServerWebSocketConnection(url, token, 2_000);
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      try { await rpc.start(); break; }
      catch {
        if (Date.now() >= deadline) throw new DetachedProfileLaunchError("handshake");
        const still = await readWindowsProcessIdentityAsync(pid);
        if (!still || still.birthTicks !== identity.birthTicks) throw new DetachedProfileLaunchError("handshake");
        await new Promise<void>(resolve => setTimeout(resolve, 250));
      }
    }
  } catch { throw new DetachedProfileLaunchError("handshake"); }
  finally { await rpc.close(); }
  let after: Readonly<{ pid: number; birthTicks: string }> | null;
  try { after = await readWindowsProcessIdentityAsync(pid); }
  catch { throw new DetachedProfileLaunchError("identity"); }
  if (!after || after.birthTicks !== identity.birthTicks) throw new DetachedProfileLaunchError("identity");
  const descriptor: DetachedProfileDescriptor = { schemaVersion: 1, epoch,
    profileKey: detachedProfileKey(home), home, url, backend: identity };
  try {
    await writeExclusive(readyFile, JSON.stringify(descriptor));
    await rename(reservationFile, path.join(privateDirectory, `launched-${epoch}.json`));
  } catch { throw new DetachedProfileLaunchError("publication"); }
  return descriptor;
}
