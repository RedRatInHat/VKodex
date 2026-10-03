import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { boundedArtifactBytes, uniqueJson } from "./deployment-artifact.js";
import type { BridgeStore } from "../bridge/store.js";

const FILE = "predecessor-maintenance.json";
const KEY = "startup-predecessor-fence";
const STORE_SCOPE_KEY = "startup-predecessor-store-scope";
const RESTORATION_DIAGNOSTIC_KEY = "startup-predecessor-restoration-diagnostic";
const HASH = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 1024 * 1024;
const MAX_SOURCES = 64;
const MAX_BINDINGS = 4096;
export interface PredecessorMaintenanceAdmission {
  readonly kind: "predecessor-maintenance";
  readonly fenceId: string;
  readonly snapshotSha256: string;
}
export type PredecessorMaintenanceRestorationState = "bindingScopeChanged" | "unchanged" | "unavailable";
export type PredecessorMaintenanceRestorationSummaryState = "binding-scope-changed" | "unchanged" | "unavailable";

interface PredecessorMaintenanceStoreScope {
  readonly kind: "predecessor-maintenance-store-scope";
  readonly version: 1;
  readonly storePath: string;
  readonly dev: string;
  readonly ino: string;
  readonly dataDirectory: string;
  readonly legacySourceIds: readonly string[];
  readonly fenceId: string;
  readonly snapshotSha256: string;
}

interface ParsedPredecessorMaintenance {
  readonly admission: PredecessorMaintenanceAdmission;
  readonly bindingScopeChanged: boolean;
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

function canonicalSources(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCES) refuse();
  const sources = value.map(source => text(source, 500, true)).sort();
  if (new Set(sources).size !== sources.length) refuse();
  return Object.freeze(sources);
}

function currentBindings(store: BridgeStore, sources: readonly string[]) {
  return store.bindings().filter(binding => sources.includes(binding.sourceId ?? ""))
    .map(binding => ({ bindingId: binding.id, hostId: binding.hostId, threadId: binding.threadId,
      sourceId: binding.sourceId ?? "", generation: store.streamGeneration(binding.id) }))
    .sort((a, b) => a.bindingId.localeCompare(b.bindingId));
}

function parsePredecessorMaintenance(value: unknown, store: BridgeStore | null, dataDirectory: string,
  legacySourceIds: readonly string[], digest: string, allowBindingDrift: boolean): ParsedPredecessorMaintenance {
  if (!HASH.test(digest)) refuse();
  const row = object(value, ["version", "fenceId", "createdAt", "dataDirectory", "legacySourceIds", "bindings", "processes", "recoveryPolicy"]);
  if (row.version !== 1 || row.recoveryPolicy !== "reconcile-only") refuse();
  const fenceId = text(row.fenceId, 100);
  if (!/^[a-zA-Z0-9-]+$/u.test(fenceId)) refuse();
  integer(row.createdAt, 1);
  if (!samePath(absolute(row.dataDirectory), path.resolve(dataDirectory))) refuse();
  const configuredSources = canonicalSources(legacySourceIds);
  if (!Array.isArray(row.legacySourceIds) || row.legacySourceIds.length > MAX_SOURCES) refuse();
  const sources = canonicalSources(row.legacySourceIds.map(source => text(source, 500, true)));
  if (JSON.stringify(sources) !== JSON.stringify(configuredSources)) refuse();
  if (!Array.isArray(row.bindings) || row.bindings.length > MAX_BINDINGS) refuse();
  const bindings = row.bindings.map(value => {
    const binding = object(value, ["bindingId", "hostId", "threadId", "sourceId", "generation"]);
    const normalized = { bindingId: text(binding.bindingId, 100), hostId: text(binding.hostId), threadId: text(binding.threadId),
      sourceId: text(binding.sourceId, 500, true), generation: integer(binding.generation, 0) };
    if (!sources.includes(normalized.sourceId)) refuse();
    return normalized;
  }).sort((a, b) => a.bindingId.localeCompare(b.bindingId));
  if (new Set(bindings.map(binding => binding.bindingId)).size !== bindings.length) refuse();
  // Include detached and idle bindings, not only restart-intent's running set.
  // The source-wide owner guard also covers deleted/unlisted debt scopes.
  const expected = store === null ? bindings : currentBindings(store, sources);
  const bindingScopeChanged = JSON.stringify(bindings) !== JSON.stringify(expected);
  if (bindingScopeChanged && !allowBindingDrift) refuse();
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
  return Object.freeze({ admission: Object.freeze({ kind: "predecessor-maintenance", fenceId, snapshotSha256: digest }),
    bindingScopeChanged });
}

function parseStoreScope(value: unknown): PredecessorMaintenanceStoreScope {
  const row = object(value, ["kind", "version", "storePath", "dev", "ino", "dataDirectory", "legacySourceIds", "fenceId", "snapshotSha256"]);
  if (row.kind !== "predecessor-maintenance-store-scope" || row.version !== 1) refuse();
  if (!Array.isArray(row.legacySourceIds) || row.legacySourceIds.length > MAX_SOURCES) refuse();
  const sources = canonicalSources(row.legacySourceIds.map(source => text(source, 500, true)));
  const snapshotSha256 = text(row.snapshotSha256, 64);
  if (!HASH.test(snapshotSha256)) refuse();
  const fenceId = text(row.fenceId, 100);
  if (!/^[a-zA-Z0-9-]+$/u.test(fenceId)) refuse();
  return Object.freeze({ kind: "predecessor-maintenance-store-scope", version: 1,
    storePath: absolute(row.storePath), dev: text(row.dev, 64), ino: text(row.ino, 64),
    dataDirectory: absolute(row.dataDirectory), legacySourceIds: sources, fenceId, snapshotSha256 });
}

async function currentStoreScope(store: BridgeStore, dataDirectory: string, legacySourceIds: readonly string[],
  admission: PredecessorMaintenanceAdmission): Promise<PredecessorMaintenanceStoreScope | undefined> {
  if (store.databasePath === null) return undefined;
  if (!store.databaseFileIdentity) refuse();
  const storePath = path.resolve(store.databasePath);
  if (!samePath(await realpath(storePath), storePath)) refuse();
  const physical = await stat(storePath, { bigint: true });
  if (!physical.isFile() || physical.nlink !== 1n || String(physical.dev) !== store.databaseFileIdentity.dev
    || String(physical.ino) !== store.databaseFileIdentity.ino) refuse();
  return Object.freeze({ kind: "predecessor-maintenance-store-scope", version: 1,
    storePath, dev: String(physical.dev), ino: String(physical.ino), dataDirectory: path.resolve(dataDirectory),
    legacySourceIds: canonicalSources(legacySourceIds), fenceId: admission.fenceId, snapshotSha256: admission.snapshotSha256 });
}

function sameStoreScope(first: PredecessorMaintenanceStoreScope, second: PredecessorMaintenanceStoreScope): boolean {
  return samePath(first.storePath, second.storePath) && first.dev === second.dev && first.ino === second.ino
    && samePath(first.dataDirectory, second.dataDirectory)
    && JSON.stringify(first.legacySourceIds) === JSON.stringify(second.legacySourceIds)
    && first.fenceId === second.fenceId && first.snapshotSha256 === second.snapshotSha256;
}

function restorationDiagnostic(state: Exclude<PredecessorMaintenanceRestorationState, "unavailable">,
  admission: PredecessorMaintenanceAdmission) {
  return Object.freeze({ kind: "predecessor-maintenance-restoration-diagnostic", version: 1, state,
    fenceId: admission.fenceId, snapshotSha256: admission.snapshotSha256 });
}

/** Strict pending fence, NOT a process-exit or native writer-release receipt.
 * The trusted local operator must supply the complete process inventory. No
 * parser result here authorizes a signal, an unlock or operation settlement. */
export function validatePredecessorMaintenance(value: unknown, store: BridgeStore, dataDirectory: string,
  legacySourceIds: readonly string[], digest: string): PredecessorMaintenanceAdmission {
  return parsePredecessorMaintenance(value, store, dataDirectory, legacySourceIds, digest, false).admission;
}

/** PURE historical schema validation, with no current-store comparison, return
 * admission, action capability, generation rebase, fence installation or I/O.
 * Used before a separately approved controller stops an old writer which may
 * legitimately commit newer generations before final data capture. */
export function assertHistoricalPredecessorMaintenanceShape(value: unknown, dataDirectory: string,
  legacySourceIds: readonly string[], digest: string): void {
  parsePredecessorMaintenance(value, null, dataDirectory, legacySourceIds, digest, false);
}

/** Opt-in with an independent SHA pin. Once installed, its durable pin is
 * mandatory on every boot; removing the environment variable/file cannot
 * silently restore profile execution. No automatic unlock exists here. */
export async function loadPredecessorMaintenance(store: BridgeStore, dataDirectory: string,
  legacySourceIds: readonly string[], requestedPin?: string): Promise<PredecessorMaintenanceAdmission | undefined> {
  const saved = store.getValue<unknown>(KEY);
  const persisted = saved === null ? null : object(saved, ["kind", "fenceId", "snapshotSha256"]);
  if (persisted && (persisted.kind !== "predecessor-maintenance" || !HASH.test(String(persisted.snapshotSha256)))) refuse();
  const savedScope = store.getValue<unknown>(STORE_SCOPE_KEY);
  const persistedScope = savedScope === null ? null : parseStoreScope(savedScope);
  if (!persisted && persistedScope) refuse();
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
      let priorPhysicalScope: PredecessorMaintenanceStoreScope | undefined;
      if (persisted && persistedScope) {
        const priorAdmission = Object.freeze({ kind: "predecessor-maintenance" as const,
          fenceId: text(persisted.fenceId, 100), snapshotSha256: pin });
        priorPhysicalScope = await currentStoreScope(store, dataDirectory, legacySourceIds, priorAdmission);
        if (!priorPhysicalScope || !sameStoreScope(persistedScope, priorPhysicalScope)) refuse();
      }
      // A historical binding vector may be restored only when an independently
      // persisted physical store pin already proves the exact quarantine scope.
      // Older fences without that pin must still match today's bindings before
      // their first pin can be installed.
      const allowBindingDrift = persisted !== null && persistedScope !== null && priorPhysicalScope !== undefined;
      const parsed = parsePredecessorMaintenance(value, store, dataDirectory, legacySourceIds, pin, allowBindingDrift);
      const physicalScope = await currentStoreScope(store, dataDirectory, legacySourceIds, parsed.admission);
      if (persistedScope && (!physicalScope || !sameStoreScope(persistedScope, physicalScope))) refuse();
      if (store.databasePath !== null && !physicalScope) refuse();
      admission = store.atomic(() => {
        const parsed = parsePredecessorMaintenance(value, store, dataDirectory, legacySourceIds, pin, allowBindingDrift);
        const validated = parsed.admission;
        const previous = store.getValue<unknown>(KEY);
        const previousScope = store.getValue<unknown>(STORE_SCOPE_KEY);
        if (JSON.stringify(previous) !== JSON.stringify(saved) || JSON.stringify(previousScope) !== JSON.stringify(savedScope)
          || persisted && persisted.fenceId !== validated.fenceId
          || persistedScope && (!physicalScope || !sameStoreScope(persistedScope, physicalScope))) refuse();
        if (physicalScope && (physicalScope.fenceId !== validated.fenceId || physicalScope.snapshotSha256 !== validated.snapshotSha256)) refuse();
        store.setValue(KEY, validated);
        if (physicalScope) store.setValue(STORE_SCOPE_KEY, persistedScope ?? physicalScope);
        if (physicalScope) store.setValue(RESTORATION_DIAGNOSTIC_KEY,
          restorationDiagnostic(parsed.bindingScopeChanged ? "bindingScopeChanged" : "unchanged", validated));
        return validated;
      });
      if (physicalScope) {
        const afterScope = await currentStoreScope(store, dataDirectory, legacySourceIds, admission);
        if (!afterScope || !sameStoreScope(physicalScope, afterScope)) refuse();
      }
    } finally { await handle.close(); }
  } catch { refuse(); }
  return admission;
}

/** A bounded, read-only signal for degraded maintenance health. It never
 * changes the durable three-field execution fence or grants any action scope. */
export function predecessorMaintenanceRestorationSummary(store: BridgeStore,
  admission: PredecessorMaintenanceAdmission): Readonly<{ state: PredecessorMaintenanceRestorationSummaryState }> {
  try {
    if (store.databasePath === null) return Object.freeze({ state: "unavailable" });
    const fence = store.getValue<unknown>(KEY);
    const savedScope = store.getValue<unknown>(STORE_SCOPE_KEY);
    if (!fence || !savedScope) return Object.freeze({ state: "unavailable" });
    const currentFence = object(fence, ["kind", "fenceId", "snapshotSha256"]);
    const scope = parseStoreScope(savedScope);
    if (currentFence.kind !== "predecessor-maintenance" || currentFence.fenceId !== admission.fenceId
      || currentFence.snapshotSha256 !== admission.snapshotSha256 || scope.fenceId !== admission.fenceId
      || scope.snapshotSha256 !== admission.snapshotSha256 || !store.databasePath || !store.databaseFileIdentity
      || !samePath(scope.storePath, path.resolve(store.databasePath)) || scope.dev !== store.databaseFileIdentity.dev
      || scope.ino !== store.databaseFileIdentity.ino) return Object.freeze({ state: "unavailable" });
    const value = store.getValue<unknown>(RESTORATION_DIAGNOSTIC_KEY);
    if (value === null) return Object.freeze({ state: "unavailable" });
    const row = object(value, ["kind", "version", "state", "fenceId", "snapshotSha256"]);
    if (row.kind !== "predecessor-maintenance-restoration-diagnostic" || row.version !== 1
      || typeof row.state !== "string" || !["bindingScopeChanged", "unchanged"].includes(row.state)
      || row.fenceId !== admission.fenceId || row.snapshotSha256 !== admission.snapshotSha256
      || !HASH.test(text(row.snapshotSha256, 64))) return Object.freeze({ state: "unavailable" });
    return Object.freeze({ state: row.state === "bindingScopeChanged" ? "binding-scope-changed" : "unchanged" });
  } catch { return Object.freeze({ state: "unavailable" }); }
}
