import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { BridgeStore } from '../bridge/store.js';
import { boundedArtifactBytes, deploymentValidationIO } from './deployment-artifact.js';
import { validateDeploymentBinding } from './deployment-binding.js';
import { validatePredecessorMaintenance, type PredecessorMaintenanceAdmission } from './predecessor-maintenance.js';
import { captureSelectedWindowsProcesses, isCurrentWindowsProcessCaptureTicket, isVerifiedSelectedProcessExit,
  ProcessAcquisitionBudget, type SelectedProcessIdentity, type WindowsProcessCaptureSession } from './windows-process-exit-witness.js';

const LEASE = 'predecessor-exit-observation-lease';
const PREFIX = 'predecessor-exit-observation:';
const HASH = /^[a-f0-9]{64}$/u;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = isDeepStrictEqual;
const samePath = (first: string, second: string): boolean => process.platform === 'win32'
  ? first.toLowerCase() === second.toLowerCase() : first === second;

export interface PredecessorExitObservationRequest {
  readonly dataDirectory: string;
  readonly legacySourceIds: readonly string[];
  readonly snapshotSha256: string;
  readonly selected: readonly SelectedProcessIdentity[];
  readonly launchBindingPath: string;
  readonly launchBindingSha256: string;
  /** Independent pin; configuration bytes are never recorded or returned. */
  readonly configurationSha256: string;
  readonly deadlineMs?: number;
}
interface Scope {
  readonly storeIdentity: Readonly<{ path: string; dev: string; ino: string }>;
  readonly maintenance: PredecessorMaintenanceAdmission;
  readonly sources: readonly string[];
  readonly bindings: readonly ReturnType<typeof vector>[number][];
  readonly selected: readonly SelectedProcessIdentity[];
  readonly deployment: Readonly<Record<string, string>>;
}
interface Row {
  readonly version: 1;
  readonly operationId: string;
  readonly scopeSha256: string;
  readonly scope: Scope;
  readonly state: 'capturing' | 'captured' | 'observation-unavailable' | 'original-exit-observed' | 'selected-exit-scoped';
  readonly startedAt: number;
  readonly observedAt?: number;
  /** Durable dispatch reservation; a crash cannot prove callback entry. */
  readonly controllerStarted: boolean;
  readonly controllerOutcome?: 'completed' | 'unknown';
  readonly physical?: Readonly<{ identitySha256: string; exits: readonly Readonly<{ pid: number; birthTicks: string; exitTicks: string }>[] }>;
}
function vector(store: BridgeStore, sources: readonly string[]) {
  return store.bindings().filter(binding => sources.includes(binding.sourceId ?? '')).map(binding => ({
    bindingId: binding.id, hostId: binding.hostId, threadId: binding.threadId, sourceId: binding.sourceId ?? '',
    generation: store.streamGeneration(binding.id),
  })).sort((a, b) => a.bindingId.localeCompare(b.bindingId));
}
function scopeCurrent(store: BridgeStore, scope: Scope): boolean {
  return store.databasePath === scope.storeIdentity.path
    && equal(store.databaseFileIdentity, { dev: scope.storeIdentity.dev, ino: scope.storeIdentity.ino })
    && equal(store.getValue('startup-predecessor-fence'), scope.maintenance)
    && equal(vector(store, scope.sources), scope.bindings);
}
function refuse(): never { throw new Error('Predecessor exit observation refused; legacy ingress remains fenced.'); }

export interface PredecessorCaptureGuard {
  readonly ticket: WindowsProcessCaptureSession['ticket'];
  readonly operationId: string;
  readonly selected: readonly SelectedProcessIdentity[];
  /** Sequencing/scope check, NOT permission or an exact-handle controller. */
  assertCurrent(): void;
  /** Bounded pin/file recheck after an asynchronous controller preparation.
   * Call immediately before acting on the controller's own retained handles. */
  revalidateBeforeAction(): Promise<void>;
}

/** Explicit, one-shot observation entry. No signal, task mutation, native RPC,
 * queue replay or automatic invocation at boot/health. The optional callback
 * belongs to a separately authorized trusted controller, which must retain and
 * revalidate its own exact OS handles. A ticket is never human authorization.
 * A persisted captured row cannot recreate this invocation's in-memory ticket.
 */
export async function observeMaintenancePredecessorExits(store: BridgeStore, provided: PredecessorExitObservationRequest,
  onCaptured?: (guard: PredecessorCaptureGuard) => void | Promise<void>): Promise<Readonly<{ operationId: string; state: Row['state'] }>> {
  const request = Object.freeze({ ...provided });
  if (!request || !HASH.test(request.snapshotSha256) || !HASH.test(request.launchBindingSha256)
    || !HASH.test(request.configurationSha256) || !Array.isArray(request.legacySourceIds)
    || !Array.isArray(request.selected) || request.selected.length < 1 || request.selected.length > 16
    || !path.isAbsolute(request.dataDirectory) || !path.isAbsolute(request.launchBindingPath)
    || !Number.isSafeInteger(request.deadlineMs ?? 1_000) || (request.deadlineMs ?? 1_000) < 0
    || (request.deadlineMs ?? 1_000) > 60_000 || onCaptured !== undefined && typeof onCaptured !== 'function') refuse();
  const directory = path.resolve(request.dataDirectory);
  if (!store.databasePath || !samePath(store.databasePath, path.join(directory, 'vkodex.sqlite'))) refuse();
  const sources = Object.freeze([...request.legacySourceIds].sort());
  const selected = Object.freeze(request.selected.map(value => Object.freeze({ ...value })));
  const acquisition = new ProcessAcquisitionBudget(15_000);
  await acquisition.read(() => deploymentValidationIO.canonical(store.databasePath!, 'file'));
  const databaseIdentity = await acquisition.read(() => stat(store.databasePath!, { bigint: true }));
  if (!databaseIdentity.isFile() || databaseIdentity.nlink !== 1n
    || !equal(store.databaseFileIdentity, { dev: String(databaseIdentity.dev), ino: String(databaseIdentity.ino) })) refuse();
  const savedMaintenance = store.getValue<PredecessorMaintenanceAdmission>('startup-predecessor-fence');
  if (!savedMaintenance || savedMaintenance.kind !== 'predecessor-maintenance'
    || savedMaintenance.snapshotSha256 !== request.snapshotSha256) refuse();
  const snapshot = await acquisition.read(() => deploymentValidationIO.metadataFile(path.join(directory, 'predecessor-maintenance.json'),
    1024 * 1024, request.snapshotSha256)) as { processes: readonly { pid: number; birthTicks: string; imagePath: string }[];
      bindings: ReturnType<typeof vector> };
  const maintenance = validatePredecessorMaintenance(snapshot, store, directory, sources, request.snapshotSha256);
  if (!equal(savedMaintenance, maintenance)) refuse();
  // Never adopt a new current generation after asynchronous pin validation:
  // authority stays with the exact independently pinned original snapshot.
  const originalBindings = Object.freeze(snapshot.bindings.map(value => Object.freeze({ bindingId: value.bindingId,
    hostId: value.hostId, threadId: value.threadId, sourceId: value.sourceId, generation: value.generation }))
    .sort((a, b) => a.bindingId.localeCompare(b.bindingId)));
  if (snapshot.processes.length !== selected.length || snapshot.processes.some(original =>
    !selected.some(candidate => candidate.pid === original.pid && candidate.birthTicks === original.birthTicks
      && samePath(candidate.imagePath, original.imagePath)))) refuse();
  const plan = await acquisition.read(() => validateDeploymentBinding(request.launchBindingPath, request.launchBindingSha256));
  if (!samePath(plan.dataDirectory, directory)) refuse();
  const configurationHash = async (): Promise<string> => {
    await deploymentValidationIO.canonical(plan.environmentFile, 'file');
    const hash = createHash('sha256');
    for await (const chunk of boundedArtifactBytes(createReadStream(plan.environmentFile), 256 * 1024)) hash.update(chunk);
    return hash.digest('hex');
  };
  if (await acquisition.read(configurationHash) !== request.configurationSha256) refuse();
  const deployment = Object.freeze({ bindingPath: request.launchBindingPath, bindingSha256: request.launchBindingSha256,
    configurationSha256: request.configurationSha256, environmentFile: plan.environmentFile, dataDirectory: directory,
    runtimePath: plan.executable, runtimeSha256: plan.runtimeSha256, entryPoint: plan.entryPoint,
    launcherSha256: plan.launcherSha256, bootstrapSha256: plan.bootstrapManifestSha256 });
  const scope: Scope = Object.freeze({ storeIdentity: Object.freeze({ path: store.databasePath,
    dev: String(databaseIdentity.dev), ino: String(databaseIdentity.ino) }),
    maintenance, sources, bindings: originalBindings, selected, deployment });
  const operationId = randomUUID();
  const scopeSha256 = digest(scope);
  let row: Row = Object.freeze({ version: 1, operationId, scopeSha256, scope, state: 'capturing', startedAt: Date.now(), controllerStarted: false });
  store.atomic(() => {
    if (!scopeCurrent(store, scope) || store.getValue(LEASE) !== null) refuse();
    store.setValue(PREFIX + operationId, row);
    store.setValue(LEASE, { operationId, scopeSha256 });
  });
  const owns = (): boolean => equal(store.getValue(LEASE), { operationId, scopeSha256 })
    && equal(store.getValue(PREFIX + operationId), row);
  const change = (next: Row): void => store.atomic(() => {
    if (!owns()) refuse();
    store.setValue(PREFIX + operationId, next); row = next;
  });
  let session: WindowsProcessCaptureSession | null = null;
  let controllerCompleted = false;
  const pinsCurrent = async (): Promise<boolean> => {
    try {
      const recheck = new ProcessAcquisitionBudget(15_000);
      const latest = await recheck.read(() => validateDeploymentBinding(request.launchBindingPath, request.launchBindingSha256));
      await recheck.read(() => deploymentValidationIO.metadataFile(path.join(directory, 'predecessor-maintenance.json'),
        1024 * 1024, request.snapshotSha256));
      await recheck.read(() => deploymentValidationIO.canonical(store.databasePath!, 'file'));
      const currentDatabase = await recheck.read(() => stat(store.databasePath!, { bigint: true }));
      return currentDatabase.dev === databaseIdentity.dev && currentDatabase.ino === databaseIdentity.ino
        && currentDatabase.nlink === 1n && equal(latest, plan) && await recheck.read(configurationHash) === request.configurationSha256;
    } catch { return false; }
  };
  try {
    session = await captureSelectedWindowsProcesses(selected, request.deadlineMs ?? 1_000);
    if (!session) throw new Error('Capture unavailable');
    const guard: PredecessorCaptureGuard = Object.freeze({ ticket: session.ticket, operationId, selected, assertCurrent: () => {
      if (!isCurrentWindowsProcessCaptureTicket(session!.ticket) || !owns() || !scopeCurrent(store, scope)) refuse();
    }, revalidateBeforeAction: async () => {
      guard.assertCurrent();
      if (!await pinsCurrent()) refuse();
      guard.assertCurrent();
    } });
    // Capture alone is insufficient: file/config pins may have changed while
    // waiting for the helper. A failed pre-action check suppresses the callback
    // but still permits preserving the original physical observation below.
    if (isCurrentWindowsProcessCaptureTicket(session.ticket) && owns() && scopeCurrent(store, scope) && await pinsCurrent()) {
      try {
        guard.assertCurrent();
        change(Object.freeze({ ...row, state: 'captured', controllerStarted: !!onCaptured }));
        guard.assertCurrent();
        // Do not wait indefinitely for a controller callback. Once the bounded
        // witness ends, this ticket is revoked; an unsettled callback is unknown.
        if (onCaptured) void Promise.resolve().then(() => { guard.assertCurrent(); return onCaptured(guard); })
          .then(() => { controllerCompleted = true; }, () => {});
      } catch { /* No controller on a known changed/expired capture scope. */ }
    }
    const physical = await session.completion;
    if (!isVerifiedSelectedProcessExit(physical) || physical.kind !== 'selected-original-processes-gone'
      || physical.identitySha256 !== session.ticket.identitySha256) throw new Error('Original exit unproved');
    const observed = Object.freeze({ ...row, state: 'original-exit-observed' as const, observedAt: Date.now(),
      ...(onCaptured ? { controllerOutcome: controllerCompleted ? 'completed' as const : 'unknown' as const } : {}),
      physical: Object.freeze({ identitySha256: physical.identitySha256, exits: physical.exits }) });
    // Record the original physical fact first; CAS/config failure cannot erase
    // it or cause the controller to be called again. No old receipt is settled.
    store.atomic(() => {
      const factKey = 'predecessor-exit-original-fact:' + operationId;
      const previous = store.getValue(factKey);
      if (previous !== null && !equal(previous, observed)) refuse();
      if (previous === null) store.setValue(factKey, observed);
      if (owns()) store.setValue(PREFIX + operationId, observed);
      // Even if the coordinator lease changed, the immutable original fact is
      // retained separately; do not overwrite the replacement lease/operation.
      row = observed;
    });
    const pinsStillCurrent = await pinsCurrent();
    store.atomic(() => {
      if (!owns()) refuse();
      if (pinsStillCurrent && scopeCurrent(store, scope)) {
        row = Object.freeze({ ...row, state: 'selected-exit-scoped' });
        store.setValue(PREFIX + operationId, row);
      }
      // This closes observation only. It never enables ingress or authorizes
      // another control attempt. A new invocation must freshly capture alive originals.
      store.setValue(LEASE, null);
      store.setValue('predecessor-exit-observation-last', { operationId, scopeSha256 });
    });
  } catch {
    session?.cancelObservation();
    // If action started, the retained lease is deliberate: no automatic
    // retry/restoration may recreate action authority after an unknown result.
    store.atomic(() => {
      if (!owns()) return;
      if (row.state !== 'original-exit-observed' && row.state !== 'selected-exit-scoped') {
        row = Object.freeze({ ...row, state: 'observation-unavailable', ...(row.controllerStarted ? { controllerOutcome: 'unknown' as const } : {}) });
        store.setValue(PREFIX + operationId, row);
      }
      if (!row.controllerStarted) store.setValue(LEASE, null);
      store.setValue('predecessor-exit-observation-last', { operationId, scopeSha256 });
    });
  }
  return Object.freeze({ operationId, state: row.state });
}

export interface PredecessorExitObservationSummary {
  readonly state: 'pending' | 'capturing' | 'captured' | 'observation-unavailable' | 'original-exit-observed' | 'selected-exit-scoped' | 'scope-changed';
  readonly observedAt?: number;
  readonly selectedCount?: number;
}
/** Historical diagnostic only; a stored JSON row is never a live ticket,
 * complete restart exclusion, writer-release or native-readiness capability. */
export function predecessorExitObservationSummary(store: BridgeStore, maintenance: PredecessorMaintenanceAdmission): PredecessorExitObservationSummary {
  try {
    const reference = store.getValue<{ operationId: string; scopeSha256: string }>(LEASE)
      ?? store.getValue<{ operationId: string; scopeSha256: string }>('predecessor-exit-observation-last');
    if (!reference || typeof reference.operationId !== 'string' || !HASH.test(reference.scopeSha256)) return { state: 'pending' };
    const row = store.getValue<Row>(PREFIX + reference.operationId);
    if (!row || row.version !== 1 || row.operationId !== reference.operationId || row.scopeSha256 !== reference.scopeSha256
      || digest(row.scope) !== row.scopeSha256 || !equal(row.scope.maintenance, maintenance)
      || !['capturing', 'captured', 'observation-unavailable', 'original-exit-observed', 'selected-exit-scoped'].includes(row.state)) return { state: 'pending' };
    if (['original-exit-observed', 'selected-exit-scoped'].includes(row.state)) {
      const pids = new Set<number>();
      if (!row.physical || typeof row.physical !== 'object' || Array.isArray(row.physical) || Object.keys(row.physical).length !== 2
        || typeof row.physical.identitySha256 !== 'string' || !HASH.test(row.physical.identitySha256) || !Number.isSafeInteger(row.observedAt)
        || row.observedAt! <= 0 || !Array.isArray(row.scope.selected) || row.scope.selected.length < 1 || row.scope.selected.length > 16
        || row.scope.selected.some(original => {
          if (!original || typeof original !== 'object' || Array.isArray(original) || Object.keys(original).length !== 4
            || !Number.isSafeInteger(original.pid) || original.pid <= 0 || original.pid > 2_147_483_647 || pids.has(original.pid)
            || typeof original.birthTicks !== 'string' || !/^[1-9]\d{16,18}$/u.test(original.birthTicks)
            || typeof original.imagePath !== 'string' || !path.isAbsolute(original.imagePath)
            || typeof original.imageSha256 !== 'string' || !HASH.test(original.imageSha256)) return true;
          pids.add(original.pid); return false;
        })
        || !Array.isArray(row.physical.exits) || row.physical.exits.length !== row.scope.selected.length
        || row.physical.exits.some((exit, index) => {
          const original = row.scope.selected[index]!;
          return !exit || Object.keys(exit).length !== 3 || exit.pid !== original.pid || exit.birthTicks !== original.birthTicks
            || typeof exit.exitTicks !== 'string' || !/^[1-9]\d{16,18}$/u.test(exit.exitTicks)
            || BigInt(exit.exitTicks) <= BigInt(original.birthTicks);
        })) return { state: 'pending' };
    } else if (row.physical !== undefined) return { state: 'pending' };
    if (!scopeCurrent(store, row.scope)) return { state: 'scope-changed' };
    return Object.freeze({ state: row.state, ...(Number.isSafeInteger(row.observedAt) ? { observedAt: row.observedAt } : {}),
      selectedCount: row.scope.selected.length });
  } catch { return { state: 'pending' }; }
}
