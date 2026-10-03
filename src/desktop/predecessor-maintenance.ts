import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { boundedArtifactBytes, uniqueJson } from "./deployment-artifact.js";
import type { BridgeStore } from "../bridge/store.js";

const FILE = "predecessor-maintenance.json";
const KEY = "startup-predecessor-fence";
const HASH = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 1024 * 1024;
export interface PredecessorMaintenanceAdmission {
  readonly kind: "predecessor-maintenance";
  readonly fenceId: string;
  readonly snapshotSha256: string;
}

function refuse(): never { throw new Error("Predecessor maintenance snapshot refused; startup ingress remains disabled."); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) refuse();
  return row;
}
function text(value: unknown, max = 256, empty = false): string {
  if (typeof value !== "string" || value.length > max || !empty && !value.length || /[\x00-\x1f\x7f]/u.test(value)) refuse();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) refuse();
  return Number(value);
}
function absolute(value: unknown): string {
  const result = text(value, 1024);
  if (!path.isAbsolute(result) && !path.win32.isAbsolute(result)
    || result.split(/[\\/]/u).some(segment => segment === "." || segment === "..")) refuse();
  return result;
}
function samePath(first: string, second: string): boolean {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

/** Strict pending fence, NOT a process-exit or native writer-release receipt.
 * The trusted local operator must supply the complete process inventory. No
 * parser result here authorizes a signal, an unlock or operation settlement. */
export function validatePredecessorMaintenance(value: unknown, store: BridgeStore, dataDirectory: string,
  legacySourceIds: readonly string[], digest: string): PredecessorMaintenanceAdmission {
  if (!HASH.test(digest)) refuse();
  const row = object(value, ["version", "fenceId", "createdAt", "dataDirectory", "legacySourceIds", "bindings", "processes", "recoveryPolicy"]);
  if (row.version !== 1 || row.recoveryPolicy !== "reconcile-only") refuse();
  const fenceId = text(row.fenceId, 100);
  if (!/^[a-zA-Z0-9-]+$/u.test(fenceId)) refuse();
  integer(row.createdAt, 1);
  if (!samePath(absolute(row.dataDirectory), path.resolve(dataDirectory))) refuse();
  if (!Array.isArray(row.legacySourceIds) || !row.legacySourceIds.length || row.legacySourceIds.length > 64) refuse();
  const sources = row.legacySourceIds.map(source => text(source, 500, true)).sort();
  if (new Set(sources).size !== sources.length
    || JSON.stringify(sources) !== JSON.stringify([...legacySourceIds].sort())) refuse();
  if (!Array.isArray(row.bindings) || row.bindings.length > 4096) refuse();
  const bindings = row.bindings.map(value => {
    const binding = object(value, ["bindingId", "hostId", "threadId", "sourceId", "generation"]);
    return { bindingId: text(binding.bindingId, 100), hostId: text(binding.hostId), threadId: text(binding.threadId),
      sourceId: text(binding.sourceId, 500, true), generation: integer(binding.generation, 0) };
  }).sort((a, b) => a.bindingId.localeCompare(b.bindingId));
  // Include detached and idle bindings, not only restart-intent's running set.
  // The source-wide owner guard also covers deleted/unlisted debt scopes.
  const expected = store.bindings().filter(binding => sources.includes(binding.sourceId ?? ""))
    .map(binding => ({ bindingId: binding.id, hostId: binding.hostId, threadId: binding.threadId,
      sourceId: binding.sourceId ?? "", generation: store.streamGeneration(binding.id) }))
    .sort((a, b) => a.bindingId.localeCompare(b.bindingId));
  if (JSON.stringify(bindings) !== JSON.stringify(expected)) refuse();
  if (!Array.isArray(row.processes) || !row.processes.length || row.processes.length > 128) refuse();
  const pids = new Set<number>(); const backends = new Set<string>(); let bridges = 0;
  for (const value of row.processes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
    const role = (value as Record<string, unknown>).role;
    if (typeof role !== "string" || !["bridge", "legacy-backend", "restart-loop"].includes(role)) refuse();
    const process = object(value, ["role", "pid", "birthTicks", "imagePath", ...(role === "legacy-backend" ? ["sourceId"] : [])]);
    const pid = integer(process.pid, 1);
    if (pids.has(pid) || !/^[1-9]\d{0,23}$/u.test(text(process.birthTicks, 24))) refuse();
    pids.add(pid); absolute(process.imagePath);
    if (role === "bridge") bridges++;
    if (role === "legacy-backend") {
      const source = text(process.sourceId, 500, true);
      if (!sources.includes(source)) refuse();
      backends.add(source);
    }
  }
  if (bridges !== 1 || sources.some(source => !backends.has(source))) refuse();
  return Object.freeze({ kind: "predecessor-maintenance", fenceId, snapshotSha256: digest });
}

/** Opt-in with an independent SHA pin. Once installed, its durable pin is
 * mandatory on every boot; removing the environment variable/file cannot
 * silently restore profile execution. No automatic unlock exists here. */
export async function loadPredecessorMaintenance(store: BridgeStore, dataDirectory: string,
  legacySourceIds: readonly string[], requestedPin?: string): Promise<PredecessorMaintenanceAdmission | undefined> {
  const saved = store.getValue<unknown>(KEY);
  const persisted = saved === null ? null : object(saved, ["kind", "fenceId", "snapshotSha256"]);
  if (persisted && (persisted.kind !== "predecessor-maintenance" || !HASH.test(String(persisted.snapshotSha256)))) refuse();
  const pin = requestedPin ?? (persisted?.snapshotSha256 as string | undefined);
  const file = path.join(path.resolve(dataDirectory), FILE);
  if (pin === undefined) {
    try { await stat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; refuse(); }
    refuse(); // An unpinned file is never silently ignored.
  }
  if (!HASH.test(pin) || persisted && persisted.snapshotSha256 !== pin) refuse();
  let admission: PredecessorMaintenanceAdmission;
  try {
    if (!samePath(await realpath(file), file)) refuse();
    const handle = await open(file, "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES)) refuse();
      const chunks: Buffer[] = [];
      for await (const chunk of boundedArtifactBytes(handle.createReadStream({ autoClose: false }), MAX_BYTES)) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== pin) refuse();
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const after = await handle.stat({ bigint: true });
      const current = await stat(file, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || current.dev !== after.dev || current.ino !== after.ino || current.nlink !== 1n || !samePath(await realpath(file), file)) refuse();
      const value = uniqueJson(decoded);
      admission = store.atomic(() => {
        const validated = validatePredecessorMaintenance(value, store, dataDirectory, legacySourceIds, pin);
        const previous = store.getValue<unknown>(KEY);
        if (JSON.stringify(previous) !== JSON.stringify(saved) || persisted && persisted.fenceId !== validated.fenceId) refuse();
        store.setValue(KEY, validated);
        return validated;
      });
    } finally { await handle.close(); }
  } catch { refuse(); }
  return admission;
}
