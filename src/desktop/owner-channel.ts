import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { comparablePath } from "./paths.js";
import { OwnerTransportError, type OwnerTransport } from "./owner-transport.js";

interface Descriptor {
  version: 1;
  home: string;
  endpoint: string;
  token: string;
  pid: number;
}

function registry(home: string, root?: string): string {
  const base = root ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "VKodex", "owner-transports");
  return path.join(base, createHash("sha256").update(comparablePath(home)).digest("hex"));
}

const taskId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Private local endpoint. It cannot execute arbitrary native methods or start turns. */
export async function serveOwnerChannel(
  home: string,
  owner: Pick<OwnerTransport, "ownsTask" | "archiveIdle">,
  root?: string,
): Promise<{ close(): Promise<void> }> {
  const id = randomUUID();
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\vkodex-owner-${id}` : path.join(os.tmpdir(), `vkodex-owner-${id}.sock`);
  const token = randomBytes(32).toString("hex");
  const directory = registry(home, root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const descriptorFile = path.join(directory, `${process.pid}-${id}.json`);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {}); socket.setTimeout(45_000, () => socket.destroy());
    socket.setEncoding("utf8"); let buffer = ""; let accepted = false;
    socket.on("data", (chunk: string) => {
      if (accepted) { socket.destroy(); return; }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4096) { socket.destroy(); return; }
      if (!buffer.includes("\n")) return;
      accepted = true;
      void (async () => {
        let request: unknown;
        try { request = JSON.parse(buffer.trim()); } catch { socket.destroy(); return; }
        if (!object(request) || typeof request.token !== "string" || request.token.length !== token.length
          || !timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) || !taskId(request.threadId)
          || !["probe", "archive"].includes(String(request.operation))) { socket.destroy(); return; }
        try {
          if (request.operation === "probe") socket.end(JSON.stringify({ ok: true, owned: await owner.ownsTask(request.threadId) }) + "\n");
          else { await owner.archiveIdle(request.threadId); socket.end('{"ok":true}\n'); }
        } catch (error) {
          const outcome = error instanceof OwnerTransportError ? error.outcome : request.operation === "archive" ? "unknown" : "unavailable";
          socket.end(JSON.stringify({ ok: false, outcome }) + "\n");
        }
      })().catch(() => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.off("error", reject); resolve(); }); });
  const descriptor: Descriptor = { version: 1, home: comparablePath(home), endpoint, token, pid: process.pid };
  try { await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" }); }
  catch (error) { server.close(); throw error; }
  server.on("error", () => { for (const socket of sockets) socket.destroy(); });
  return {
    async close() {
      // Retire, rather than delete, discovery entries; crashed processes are ignored by PID.
      await writeFile(descriptorFile, JSON.stringify({ version: 1, active: false }), { mode: 0o600 });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function callOwner(descriptor: Descriptor, operation: "probe" | "archive", threadId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.endpoint); let sent = false; let done = false; let buffer = "";
    const finish = (error?: OwnerTransportError, result?: Record<string, unknown>) => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const failed = () => finish(new OwnerTransportError(sent && operation === "archive" ? "unknown" : "unavailable", "Owner channel unavailable; no automatic retry."));
    const timer = setTimeout(failed, timeoutMs);
    socket.on("error", failed); socket.on("end", failed); socket.on("close", failed);
    socket.on("connect", () => { sent = true; socket.write(JSON.stringify({ token: descriptor.token, operation, threadId }) + "\n"); });
    socket.setEncoding("utf8"); socket.on("data", (chunk: string) => {
      buffer += chunk; if (buffer.length > 4096) { failed(); return; }
      if (!buffer.includes("\n")) return;
      try {
        const result: unknown = JSON.parse(buffer.trim());
        if (!object(result) || typeof result.ok !== "boolean") { failed(); return; }
        if (result.ok) finish(undefined, result);
        else finish(new OwnerTransportError(result.outcome === "rejected" ? "rejected" : result.outcome === "unknown" || operation === "archive" ? "unknown" : "unavailable", "Owner could not confirm the operation."));
      } catch { failed(); }
    });
  });
}

/** No endpoint/owner is a discovery miss. A submitted archive is NEVER retried elsewhere. */
export async function archiveThroughOwner(home: string, threadId: string, root?: string, timeoutMs = 35_000): Promise<boolean> {
  const directory = registry(home, root);
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new OwnerTransportError("unavailable", "Owner registry is unreadable."); }
  if (!taskId(threadId)) throw new OwnerTransportError("rejected", "Invalid task ID.");
  const descriptors: Descriptor[] = [];
  for (const file of files.filter(file => /^\d+-[0-9a-f-]+\.json$/u.test(file))) {
    let d: unknown;
    try { d = JSON.parse(await readFile(path.join(directory, file), "utf8")); } catch { continue; }
    if (!object(d) || d.version !== 1 || d.home !== comparablePath(home) || typeof d.token !== "string" || !/^[0-9a-f]{64}$/u.test(d.token)
      || typeof d.pid !== "number" || !Number.isSafeInteger(d.pid) || d.pid <= 0 || !alive(d.pid)
      || typeof d.endpoint !== "string" || (process.platform === "win32" ? !/^\\\\\.\\pipe\\vkodex-owner-[0-9a-f-]{36}$/u.test(d.endpoint) : path.dirname(d.endpoint) !== os.tmpdir() || !/^vkodex-owner-[0-9a-f-]{36}\.sock$/u.test(path.basename(d.endpoint)))) continue;
    descriptors.push(d as unknown as Descriptor);
  }
  if (descriptors.length > 32) throw new OwnerTransportError("unavailable", "Too many owner endpoints.");
  const probes = await Promise.allSettled(descriptors.map(async d => {
    const response = await callOwner(d, "probe", threadId, Math.min(timeoutMs, 3000));
    if (typeof response.owned !== "boolean") throw new OwnerTransportError("unavailable", "Invalid owner probe response.");
    return response.owned ? d : null;
  }));
  // A failed probe cannot prove absence or uniqueness of an owner. In particular,
  // do not switch to an external writer while a registered IDE is initializing.
  if (probes.some(p => p.status === "rejected")) throw new OwnerTransportError("unavailable", "Could not confirm all registered native owners.");
  const owners = probes.flatMap(p => p.status === "fulfilled" && p.value ? [p.value] : []);
  if (!owners.length) return false;
  if (owners.length !== 1) throw new OwnerTransportError("rejected", "Multiple native owners reported the same task.");
  await callOwner(owners[0]!, "archive", threadId, timeoutMs);
  return true;
}
