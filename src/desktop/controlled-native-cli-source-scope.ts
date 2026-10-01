import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { comparablePath } from '../core/paths.js';
import type { ApprovedTaskPolicy } from '../codex/managed-task-policy.js';
import { ControlledNativeCreationJournal, type ControlledCreationJournalRecord } from
  './controlled-native-creation-journal.js';
import { assertAuthenticatedProfileSourcePreflightForWrite, loadAuthenticatedProfileSourcePreflightReceipt, loadControlledNativeSourcePreflightReceipt,
  proveAuthenticatedProfileSource, proveControlledNativeSource } from
  './controlled-native-source-proof.js';

const internal = new WeakMap<object, Readonly<{
  journal: ControlledNativeCreationJournal; operationId: string; record: ControlledCreationJournalRecord;
  preflightReceiptPath: string; sourceHome: string; workspace: string;
  allowAuthenticatedProfile: boolean;
  writePin: Readonly<{ receipt: string; receiptIdentity: string;
    home: string; workspace: string; rollout: string; rolloutSnapshot: string }>;
}>>();
const refuse = (category = 'invalid'): never => {
  throw new Error(`Controlled native CLI source scope unqualified (${category})`);
};

/** An in-process proof handle. It cannot be assembled from a manifest or an idle native read. */
export interface ControlledNativeCliSourceScope {
  readonly taskId: string;
  readonly sourceGeneration: string;
  readonly sourceHome: string;
  readonly workspace: string;
  readonly policy: ApprovedTaskPolicy;
}

export function assertControlledNativeCliSourceScope(value: unknown): asserts value is ControlledNativeCliSourceScope {
  if (!value || typeof value !== 'object' || !internal.has(value)) refuse();
}

function physicalPin(file: string): string {
  const resolved = realpathSync.native(file);
  const stat = statSync(resolved, { bigint: true });
  if (stat.dev <= 0n || stat.ino <= 0n || stat.birthtimeMs <= 0n) refuse('weak-file-identity');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function boundedReceipt(file: string): string {
  if (lstatSync(file).isSymbolicLink()) refuse('receipt-link');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 16_384n) refuse('receipt-size');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) refuse('receipt-read');
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.birthtimeMs !== after.birthtimeMs || before.size !== after.size)
      refuse('receipt-changed');
    return bytes.toString('utf8');
  } finally { closeSync(fd); }
}

function rolloutSnapshot(file: string): string {
  if (lstatSync(file).isSymbolicLink()) refuse('rollout-link');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    // A first-turn pilot should never need a huge pre-existing history. Keep
    // memory bounded and refuse oversized files instead of hashing a partial
    // body whose unseen bytes could change in place.
    if (!before.isFile() || before.size < 1n || before.size > 16_777_216n)
      refuse('rollout-file');
    const bytes = Buffer.alloc(65_536);
    const digest = createHash('sha256');
    let offset = 0, headerComplete = false;
    while (BigInt(offset) < before.size) {
      const count = readSync(fd, bytes, 0,
        Math.min(bytes.length, Number(before.size) - offset), offset);
      if (count <= 0) refuse('rollout-read');
      if (!headerComplete) {
        headerComplete = bytes.subarray(0, count).includes(10);
        if (!headerComplete && offset + count >= 1_048_576) refuse('rollout-header');
      }
      digest.update(bytes.subarray(0, count));
      offset += count;
    }
    if (!headerComplete) refuse('rollout-header');
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.birthtimeMs !== after.birthtimeMs || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs) refuse('rollout-changed');
    // The full bounded candidate digest catches same-size in-place body edits;
    // this is still a same-principal path snapshot, not an OS writer lock.
    return `${before.dev}:${before.ino}:${before.birthtimeMs}:${before.size}:${before.mtimeMs}:${digest.digest('hex')}`;
  } finally { closeSync(fd); }
}

function onlyControlledRollout(home: string, expected: string): boolean {
  const pending = [{ directory: path.join(home, 'sessions'), depth: 0 },
    { directory: path.join(home, 'archived_sessions'), depth: 0 }];
  let entriesSeen = 0, found: string | null = null;
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    if (depth > 16) return false;
    let entries: import('node:fs').Dirent<string>[];
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
    for (const entry of entries) {
      if (++entriesSeen > 1024 || entry.isSymbolicLink()) return false;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push({ directory: candidate, depth: depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (found !== null) return false;
        found = candidate;
      } else if (!entry.isFile()) return false;
    }
  }
  return found !== null && physicalPin(found) === physicalPin(expected);
}

/** Final synchronous fence for the already-qualified source. It is called by
 * the managed worker at its native command write boundary; no async source
 * check can close that last race. It does not establish owner or queue state. */
export function assertControlledNativeCliSourceScopeCurrent(scope: ControlledNativeCliSourceScope): void {
  assertControlledNativeCliSourceScope(scope);
  const state = internal.get(scope)!;
  let current: ControlledCreationJournalRecord | null;
  try { current = state.journal.get(state.operationId); } catch { return refuse('journal-read'); }
  const qualified = current?.qualified;
  if (!current || current.state !== 'qualified' || !qualified ||
      !isDeepStrictEqual(current, state.record))
    return refuse('journal-drift');
  const rolloutPath = qualified.rolloutPath;
  try {
    if (boundedReceipt(state.preflightReceiptPath) !== state.writePin.receipt ||
        physicalPin(state.preflightReceiptPath) !== state.writePin.receiptIdentity ||
        physicalPin(state.sourceHome) !== state.writePin.home ||
        physicalPin(state.workspace) !== state.writePin.workspace ||
        physicalPin(rolloutPath) !== state.writePin.rollout ||
        rolloutSnapshot(rolloutPath) !== state.writePin.rolloutSnapshot ||
        current.intent.sourceProofMode !== 'authenticated-profile-new-task' &&
          !onlyControlledRollout(state.sourceHome, rolloutPath))
      refuse('physical-source-drift');
  } catch { refuse('physical-source-drift'); }
}

/** Re-read the durable journal and immutable preflight receipt, then prove the
 * exact native candidate under the explicitly selected mode. The journal remains the trust root. */
export async function verifyControlledNativeCliSourceScope(scope: ControlledNativeCliSourceScope,
  manifest?: Readonly<{ taskId: string; home: string; cwd: string;
    approvedTaskPolicy?: ApprovedTaskPolicy }>): Promise<void> {
  assertControlledNativeCliSourceScope(scope);
  const state = internal.get(scope)!;
  let current: ControlledCreationJournalRecord | null;
  try { current = state.journal.get(state.operationId); } catch { return refuse('journal-read'); }
  if (!current) return refuse('journal-missing');
  if (!isDeepStrictEqual(current, state.record) || current.state !== 'qualified' ||
      current.intent.sourceProofRequired !== true || current.started?.sourceProofRequired !== true ||
      current.qualified?.sourceProofRequired !== true) refuse('journal-drift');
  const qualified = current.qualified;
  if (!qualified) return refuse('journal-incomplete');
  if (qualified.threadId !== scope.taskId ||
      qualified.sourceGeneration !== scope.sourceGeneration ||
      !isDeepStrictEqual(qualified.effectivePolicy, scope.policy)) refuse('identity-drift');
  const identity = { operationId: current.intent.operationId, sourceId: current.intent.sourceId,
    sourceGeneration: current.intent.sourceGeneration };
  const mode = current.intent.sourceProofMode;
  if (mode === 'authenticated-profile-new-task' && !state.allowAuthenticatedProfile) refuse('profile-opt-in');
  const { preflight, proof } = await (async () => {
    if (mode === 'authenticated-profile-new-task') {
      const preflight = await loadAuthenticatedProfileSourcePreflightReceipt(state.preflightReceiptPath,
        identity, state.sourceHome, state.workspace).catch(() => refuse('preflight'));
      // A scope is write-capable. Legacy v2 receipts are retained only for
      // read-only candidate reconciliation and cannot establish this handle.
      try { assertAuthenticatedProfileSourcePreflightForWrite(preflight, identity, state.sourceHome, state.workspace); }
      catch { return refuse('preflight-write'); }
      const proof = await proveAuthenticatedProfileSource(preflight, qualified.rolloutPath, qualified.threadId)
        .catch(() => refuse('rollout'));
      return { preflight, proof };
    }
    const preflight = await loadControlledNativeSourcePreflightReceipt(state.preflightReceiptPath,
      identity, state.sourceHome, state.workspace).catch(() => refuse('preflight'));
    const proof = await proveControlledNativeSource(preflight, qualified.rolloutPath, qualified.threadId)
      .catch(() => refuse('rollout'));
    return { preflight, proof };
  })();
  // The qualified path may traverse a Windows junction (notably on CI).
  // The selected proof checked the actual file; compare its canonical target,
  // not the lexical spelling in the journal.
  const qualifiedRollout = await realpath(qualified.rolloutPath).catch(() => refuse('rollout-path'));
  const policyWorkspace = await realpath(qualified.effectivePolicy.cwd).catch(() => refuse('policy-cwd'));
  if (comparablePath(proof.rolloutPath) !== comparablePath(qualifiedRollout)) refuse('rollout-path');
  if (comparablePath(preflight.sourceHome) !== comparablePath(scope.sourceHome)) refuse('source-home');
  if (comparablePath(preflight.workspace) !== comparablePath(scope.workspace)) refuse('workspace');
  if (comparablePath(policyWorkspace) !== comparablePath(scope.workspace)) refuse('policy-cwd');
  if (manifest) {
    let home: string, cwd: string;
    try { [home, cwd] = await Promise.all([realpath(manifest.home), realpath(manifest.cwd)]); }
    catch { return refuse('manifest-path'); }
    if (manifest.taskId !== scope.taskId ||
        comparablePath(home) !== comparablePath(scope.sourceHome) ||
        comparablePath(cwd) !== comparablePath(scope.workspace) ||
        !isDeepStrictEqual(manifest.approvedTaskPolicy, scope.policy)) refuse('manifest-drift');
  }
}

export async function deriveControlledNativeCliSourceScope(options: Readonly<{
  journal: ControlledNativeCreationJournal; operationId: string;
  preflightReceiptPath: string; sourceHome: string; workspace: string;
  /** Required to accept a candidate-only authenticated profile proof. */
  allowAuthenticatedProfile?: true;
}>): Promise<ControlledNativeCliSourceScope> {
  if (!options || !(options.journal instanceof ControlledNativeCreationJournal)) refuse();
  let record: ControlledCreationJournalRecord | null;
  try { record = options.journal.get(options.operationId); } catch { return refuse(); }
  if (!record) return refuse();
  if (record.state !== 'qualified' || !record.qualified ||
      record.intent.sourceProofRequired !== true || record.started?.sourceProofRequired !== true ||
      record.qualified.sourceProofRequired !== true) refuse();
  if (record.intent.sourceProofMode === 'authenticated-profile-new-task' &&
    options.allowAuthenticatedProfile !== true) refuse('profile-opt-in');
  const qualified = record.qualified;
  if (!qualified) return refuse();
  let sourceHome: string, workspace: string;
  try { [sourceHome, workspace] = await Promise.all([
    realpath(options.sourceHome), realpath(options.workspace)]); }
  catch { return refuse(); }
  const scope: ControlledNativeCliSourceScope = Object.freeze({ taskId: qualified.threadId,
    sourceGeneration: qualified.sourceGeneration, sourceHome,
    workspace, policy: qualified.effectivePolicy });
  const writePin = Object.freeze({ receipt: boundedReceipt(options.preflightReceiptPath),
    receiptIdentity: physicalPin(options.preflightReceiptPath),
    home: physicalPin(options.sourceHome), workspace: physicalPin(options.workspace),
    rollout: physicalPin(qualified.rolloutPath),
    rolloutSnapshot: rolloutSnapshot(qualified.rolloutPath) });
  internal.set(scope, Object.freeze({ journal: options.journal, operationId: options.operationId,
    record, preflightReceiptPath: options.preflightReceiptPath,
    sourceHome: options.sourceHome, workspace: options.workspace,
    allowAuthenticatedProfile: options.allowAuthenticatedProfile === true, writePin }));
  try { await verifyControlledNativeCliSourceScope(scope); }
  catch (error) {
    internal.delete(scope);
    if (error instanceof Error && error.message.startsWith('Controlled native CLI source scope unqualified'))
      throw error;
    return refuse('verification');
  }
  return scope;
}
