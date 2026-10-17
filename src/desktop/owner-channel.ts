import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { comparablePath } from "./paths.js";
import { OwnerTransportError, type OwnerGoalResumeExpectation, type OwnerTransport } from "./owner-transport.js";
import { parseTaskGoal } from "../core/task-goals.js";
import type { TaskGoal } from "../core/codex-tasks.js";

export type { OwnerGoalResumeExpectation } from "./owner-transport.js";

interface Descriptor {
  version: 1;
  home: string;
  endpoint: string;
  token: string;
  pid: number;
}
interface VerifiedOwner extends Descriptor { readonly capabilities: readonly ("inspect" | "archive" | "resumeExistingGoal")[] }
const OWNER_PROTOCOL = 2;

function registry(home: string, root?: string): string {
  const base = root ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "VKodex", "owner-transports");
  return path.join(base, createHash("sha256").update(comparablePath(home)).digest("hex"));
}

const taskId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Private local endpoint. No arbitrary RPC or ordinary turn submission.
 * Goal resume is opt-in and runs only through the verified native owner. */
export async function serveOwnerChannel(
  home: string,
  owner: Pick<OwnerTransport, "ownsTask" | "archiveIdle"> & Partial<Pick<OwnerTransport, "inspectTask" | "resumeExistingGoal">>,
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
          || !["probe", "inspect", "archive", "resumeExistingGoal"].includes(String(request.operation))) { socket.destroy(); return; }
        try {
          if (request.operation === "probe") socket.end(JSON.stringify({ ok: true, owned: await owner.ownsTask(request.threadId),
            protocol: OWNER_PROTOCOL, capabilities: ["archive", ...(owner.inspectTask ? ["inspect"] : []), ...(owner.resumeExistingGoal && request.goalResumeCapability === true ? ["resumeExistingGoal"] : [])] }) + "\n");
          else if (request.operation === "inspect") {
            if (!owner.inspectTask) throw new OwnerTransportError("unavailable", "Owner inspection is unavailable.");
            socket.end(JSON.stringify({ ok: true, status: await owner.inspectTask(request.threadId) }) + "\n");
          }
          else if (request.operation === "archive") { await owner.archiveIdle(request.threadId); socket.end('{"ok":true}\n'); }
          else {
            if (!owner.resumeExistingGoal || !object(request.expected)) throw new OwnerTransportError("rejected", "Goal resume is unavailable.");
            const goal = await owner.resumeExistingGoal(request.threadId, request.expected as unknown as OwnerGoalResumeExpectation);
            socket.end(JSON.stringify({ ok: true, goal }) + "\n");
          }
        } catch (error) {
          const outcome = error instanceof OwnerTransportError ? error.outcome : (request.operation === "archive" || request.operation === "resumeExistingGoal") ? "unknown" : "unavailable";
          // Forward only a known pre-dispatch resume refusal, never raw native errors.
          const reason = request.operation === "resumeExistingGoal" && outcome === "rejected"
            && error instanceof OwnerTransportError && error.reason === "nativeTaskActive" ? error.reason : undefined;
          socket.end(JSON.stringify({ ok: false, outcome, ...(reason ? { reason } : {}) }) + "\n");
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

function callOwner(descriptor: Descriptor, operation: "probe" | "inspect" | "archive" | "resumeExistingGoal", threadId: string, timeoutMs: number, expected?: OwnerGoalResumeExpectation, goalResumeCapability = false): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.endpoint); let sent = false; let done = false; let buffer = "";
    const finish = (error?: OwnerTransportError, result?: Record<string, unknown>) => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const failed = (cause?: NodeJS.ErrnoException) => finish(new OwnerTransportError(
      sent && (operation === "archive" || operation === "resumeExistingGoal") ? "unknown" : "unavailable",
      "Owner channel unavailable; no automatic retry.",
      !sent && (cause?.code === "ENOENT" || cause?.code === "ECONNREFUSED") ? "endpointMissing" : undefined,
    ));
    const timer = setTimeout(failed, timeoutMs);
    socket.on("error", failed); socket.on("end", () => failed()); socket.on("close", () => failed());
    socket.on("connect", () => { sent = true; socket.write(JSON.stringify({ token: descriptor.token, operation, threadId, ...(expected ? { expected } : {}), ...(goalResumeCapability ? { goalResumeCapability: true } : {}) }) + "\n"); });
    socket.setEncoding("utf8"); socket.on("data", (chunk: string) => {
      buffer += chunk; if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) { failed(); return; }
      if (!buffer.includes("\n")) return;
      try {
        const result: unknown = JSON.parse(buffer.trim());
        if (!object(result) || typeof result.ok !== "boolean") { failed(); return; }
        if (result.ok) finish(undefined, result);
        else finish(new OwnerTransportError(result.outcome === "rejected" ? "rejected" : result.outcome === "unknown" || operation === "archive" || operation === "resumeExistingGoal" ? "unknown" : "unavailable", "Owner could not confirm the operation.",
          operation === "resumeExistingGoal" && result.outcome === "rejected" && result.reason === "nativeTaskActive" ? "nativeTaskActive" : undefined));
      } catch { failed(); }
    });
  });
}

/** A failed probe cannot prove that no client owns the task. */
async function findOwner(home: string, threadId: string, root?: string, timeoutMs = 35_000): Promise<VerifiedOwner | null> {
  const directory = registry(home, root);
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new OwnerTransportError("unavailable", "Owner registry is unreadable."); }
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
    const response = await callOwner(d, "probe", threadId, Math.min(timeoutMs, 3000), undefined, true);
    if (typeof response.owned !== "boolean") throw new OwnerTransportError("unavailable", "Invalid owner probe response.");
    if (!response.owned) return null;
    if (response.protocol !== OWNER_PROTOCOL) throw new OwnerTransportError("outdated", "Owner adapter protocol is outdated; restart the selected Codex client with the current VKodex adapter.");
    if (!Array.isArray(response.capabilities) || response.capabilities.some(value => value !== "inspect" && value !== "archive" && value !== "resumeExistingGoal"))
      throw new OwnerTransportError("unavailable", "Owner adapter reported invalid capabilities.");
    return { ...d, capabilities: response.capabilities as ("inspect" | "archive" | "resumeExistingGoal")[] };
  }));
  // A failed probe cannot prove absence or uniqueness of an owner. In particular,
  // do not switch to an external writer while a registered IDE is initializing.
  const outdated = probes.find((probe): probe is PromiseRejectedResult => probe.status === "rejected"
    && probe.reason instanceof OwnerTransportError && probe.reason.outcome === "outdated");
  if (outdated) throw outdated.reason;
  // A descriptor is written only after its unique private endpoint starts
  // listening. A missing endpoint is therefore a stale descriptor even if
  // Windows has reused its PID for an unrelated process. Other probe errors
  // remain fail-closed.
  if (probes.some(p => p.status === "rejected"
    && !(p.reason instanceof OwnerTransportError && p.reason.reason === "endpointMissing"))) {
    throw new OwnerTransportError("unavailable", "Could not confirm all registered native owners.");
  }
  const owners = probes.flatMap(p => p.status === "fulfilled" && p.value ? [p.value] : []);
  if (!owners.length) return null;
  if (owners.length !== 1) throw new OwnerTransportError("rejected", "Multiple native owners reported the same task.");
  return owners[0]!;
}

/** Read the selected live owner, without launching or resuming a task. */
export async function inspectThroughOwner(home: string, threadId: string, root?: string, timeoutMs = 35_000): Promise<"idle" | "active" | "systemError" | null> {
  const owner = await findOwner(home, threadId, root, timeoutMs);
  if (!owner) return null;
  if (!owner.capabilities.includes("inspect")) throw new OwnerTransportError("outdated", "Owner adapter cannot inspect tasks; restart the selected Codex client with the current VKodex adapter.");
  const response = await callOwner(owner, "inspect", threadId, timeoutMs);
  if (!["idle", "active", "systemError"].includes(String(response.status))) throw new OwnerTransportError("unavailable", "Owner returned an invalid task state.");
  return response.status as "idle" | "active" | "systemError";
}

/** No endpoint/owner is a discovery miss. A submitted archive is NEVER retried elsewhere. */
export async function archiveThroughOwner(home: string, threadId: string, root?: string, timeoutMs = 35_000): Promise<boolean> {
  const owner = await findOwner(home, threadId, root, timeoutMs);
  if (!owner) return false;
  if (!owner.capabilities.includes("archive")) throw new OwnerTransportError("outdated", "Owner adapter cannot archive tasks; restart the selected Codex client with the current VKodex adapter.");
  await callOwner(owner, "archive", threadId, timeoutMs);
  return true;
}

export async function resumeGoalThroughOwner(home: string, threadId: string, expected: OwnerGoalResumeExpectation,
  root?: string, timeoutMs = 35_000): Promise<TaskGoal | null> {
  const owner = await findOwner(home, threadId, root, timeoutMs);
  if (!owner) return null;
  if (!owner.capabilities.includes("resumeExistingGoal")) throw new OwnerTransportError("outdated", "Owner adapter cannot resume existing goals; restart the selected Codex client with the current VKodex adapter.");
  const response = await callOwner(owner, "resumeExistingGoal", threadId, timeoutMs, expected);
  let goal: TaskGoal | null;
  try { goal = parseTaskGoal(response.goal, threadId); }
  catch { throw new OwnerTransportError("unknown", "Owner could not verify the resumed goal; no automatic retry."); }
  if (!goal) throw new OwnerTransportError("unknown", "Owner returned no resumed goal after dispatch.");
  return goal;
}
