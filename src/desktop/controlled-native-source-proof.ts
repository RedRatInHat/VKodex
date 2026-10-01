import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  realpathSync, statSync } from 'node:fs';
import { lstat, open, realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { comparablePath } from '../core/paths.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_ROLLOUT_FILES = 128;
const MAX_SOURCE_ENTRIES = 1024;
const MAX_SOURCE_DEPTH = 16;
const MAX_RECEIPT_BYTES = 16 * 1024;
const AUTHENTICATED_PROFILE_RECEIPT_SCHEMA_VERSION = 3;
const LEGACY_AUTHENTICATED_PROFILE_RECEIPT_SCHEMA_VERSION = 2;
const AUTHENTICATED_PROFILE_BIRTHTIME_TOLERANCE_MS = 5_000;
/** This proof is deliberately single-candidate, never an inventory claim. */
const MAX_AUTHENTICATED_PROFILE_CLAIMS = 1;
const brand = new WeakSet<object>();
interface AuthenticatedProfileClaim {
  readonly path: string;
  readonly threadId: string;
  readonly identity: FileSystemIdentity;
  readonly header: RolloutHeader;
  readonly headerSha256: string;
}
const authenticatedProfileClaims = new WeakMap<object, AuthenticatedProfileClaim>();

interface RolloutHeader {
  readonly id: string;
  readonly cwd: string;
}

export interface ControlledSourcePreflight {
  readonly identity: ControlledNativeSourceIdentity;
  readonly sourceHome: string;
  readonly workspace: string;
  readonly capturedAtMs: number;
  readonly rollouts: readonly Readonly<{ path: string; threadId: string }> [];
}

export interface ControlledNativeSourceIdentity {
  readonly operationId: string;
  readonly sourceId: string;
  /** Producer nonce, not a native monotonic source revision. */
  readonly sourceGeneration: string;
}

export interface ControlledSourceProof {
  readonly rolloutPath: string;
  readonly threadId: string;
}

interface FileSystemIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeMs: bigint;
}

/**
 * An opt-in proof for a populated authenticated native profile. Unlike the
 * empty-source preflight, it makes no assertion about any other rollout.
 */
export interface AuthenticatedProfileSourcePreflight {
  readonly identity: ControlledNativeSourceIdentity;
  readonly sourceHome: string;
  readonly workspace: string;
  readonly capturedAtMs: number;
  readonly sourceHomeIdentity: FileSystemIdentity;
  /** Missing only on a v2 receipt loaded for read-only reconciliation. */
  readonly workspaceIdentity?: FileSystemIdentity;
}

export interface AuthenticatedProfileSourceProof {
  readonly rolloutPath: string;
  readonly threadId: string;
}

export class ControlledNativeSourceUnqualifiedError extends Error {
  constructor() {
    super('Controlled native source is unqualified');
    this.name = 'ControlledNativeSourceUnqualifiedError';
  }
}

const refuse = (): never => { throw new ControlledNativeSourceUnqualifiedError(); };

function absolute(value: string): boolean {
  return path.win32.isAbsolute(value) || path.isAbsolute(value);
}

function equalPath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function inside(root: string, candidate: string): boolean {
  const windowsPath = path.win32.isAbsolute(root) || path.win32.isAbsolute(candidate);
  const api = windowsPath ? path.win32 : path;
  const comparableRoot = windowsPath ? comparablePath(root) : path.resolve(root);
  const comparableCandidate = windowsPath ? comparablePath(candidate) : path.resolve(candidate);
  const relative = api.relative(comparableRoot, comparableCandidate);
  const separator = windowsPath ? path.win32.sep : path.sep;
  return !!relative && !relative.startsWith(`..${separator}`) && relative !== '..' && !api.isAbsolute(relative);
}

function inRolloutTree(root: string, candidate: string): boolean {
  const sessions = path.join(root, 'sessions');
  const archived = path.join(root, 'archived_sessions');
  return inside(sessions, candidate) || inside(archived, candidate);
}

async function checkedRealDirectory(value: string): Promise<string> {
  if (typeof value !== 'string' || !absolute(value)) refuse();
  const metadata = await lstat(value).catch(() => refuse());
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) refuse();
  return realpath(value).catch(() => refuse());
}

function identityOf(metadata: { dev: bigint; ino: bigint; birthtimeMs: bigint }): FileSystemIdentity {
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino, birthtimeMs: metadata.birthtimeMs });
}

function sameFileSystemIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function checkedRealDirectorySync(value: string): string {
  if (typeof value !== 'string' || !absolute(value)) refuse();
  let metadata: ReturnType<typeof lstatSync>, resolved: string;
  try {
    metadata = lstatSync(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) refuse();
    resolved = realpathSync(value);
  } catch { return refuse(); }
  return resolved;
}

function checkedDirectoryIdentitySync(value: string): Readonly<{ path: string; identity: FileSystemIdentity }> {
  const resolved = checkedRealDirectorySync(value);
  let metadata: ReturnType<typeof statSync>;
  try { metadata = statSync(resolved, { bigint: true }); }
  catch { return refuse(); }
  if (!metadata.isDirectory()) refuse();
  return Object.freeze({ path: resolved, identity: identityOf(metadata) });
}

async function checkedDirectoryIdentity(value: string): Promise<Readonly<{ path: string; identity: FileSystemIdentity }>> {
  const resolved = await checkedRealDirectory(value);
  const metadata = await stat(resolved, { bigint: true }).catch(() => refuse());
  if (!metadata.isDirectory()) refuse();
  return Object.freeze({ path: resolved, identity: identityOf(metadata) });
}

async function checkedProfileCandidate(root: string, value: string): Promise<Readonly<{
  path: string; identity: FileSystemIdentity; header: RolloutHeader; headerSha256: string;
}>> {
  if (typeof value !== 'string' || !absolute(value)) refuse();
  const lexical = path.resolve(value);
  const lexicalMetadata = await lstat(lexical).catch(() => refuse());
  if (!lexicalMetadata.isFile() || lexicalMetadata.isSymbolicLink()) refuse();
  const resolved = await realpath(lexical).catch(() => refuse());
  if (!inRolloutTree(root, resolved)) refuse();
  // A Windows workspace or temp root may have a junction ancestor. Pin the
  // canonical target under the profile; only a link at the file itself is refused.
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(resolved, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n) refuse();
    const headerBytes = Buffer.allocUnsafe(MAX_HEADER_BYTES);
    let used = 0, newline = -1;
    while (used < headerBytes.length && newline < 0) {
      const { bytesRead } = await handle.read(headerBytes, used,
        Math.min(64 * 1024, headerBytes.length - used), used);
      if (bytesRead === 0) break;
      const withinChunk = headerBytes.subarray(used, used + bytesRead).indexOf(0x0a);
      if (withinChunk >= 0) newline = used + withinChunk;
      used += bytesRead;
    }
    if (newline < 0) refuse();
    const firstLine = headerBytes.subarray(0, newline + 1);
    const header = headerOf(firstLine.toString('utf8'));
    const headerSha256 = createHash('sha256').update(firstLine).digest('hex');
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(resolved, { bigint: true });
    const beforeIdentity = identityOf(before), afterIdentity = identityOf(afterHandle), pathIdentity = identityOf(afterPath);
    const reResolved = await realpath(lexical);
    if (!afterHandle.isFile() || !afterPath.isFile() || afterPath.isSymbolicLink() || !equalPath(reResolved, resolved) ||
      !sameFileSystemIdentity(beforeIdentity, afterIdentity) || !sameFileSystemIdentity(beforeIdentity, pathIdentity)) refuse();
    return Object.freeze({ path: resolved, identity: afterIdentity, header, headerSha256 });
  } catch { return refuse(); }
  finally { await handle?.close(); }
}

async function checkedFile(root: string, value: string): Promise<string> {
  if (typeof value !== 'string' || !absolute(value)) refuse();
  const lexical = path.resolve(value);
  const metadata = await lstat(lexical).catch(() => refuse());
  if (!metadata.isFile() || metadata.isSymbolicLink()) refuse();
  const resolved = await realpath(lexical).catch(() => refuse());
  if (!inRolloutTree(root, resolved)) refuse();
  const finalMetadata = await stat(resolved).catch(() => refuse());
  if (!finalMetadata.isFile() || finalMetadata.size < 1 || finalMetadata.size > MAX_HEADER_BYTES) refuse();
  return resolved;
}

function headerOf(contents: string): RolloutHeader {
  const end = contents.indexOf('\n');
  if (end < 0) refuse();
  let value: unknown;
  try { value = JSON.parse(contents.slice(0, end).trimEnd()); }
  catch { refuse(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse();
  const record = value as Record<string, unknown>;
  const payload = record.payload;
  if (record.type !== 'session_meta' || payload === null || typeof payload !== 'object' || Array.isArray(payload)) refuse();
  const data = payload as Record<string, unknown>;
  const id = data.id, sessionId = data.session_id, cwd = data.cwd;
  if (typeof id !== 'string' || typeof sessionId !== 'string' || typeof cwd !== 'string') refuse();
  const safeId = id as string, safeSessionId = sessionId as string, safeCwd = cwd as string;
  if (safeId !== safeSessionId || !UUID.test(safeId) || !absolute(safeCwd)) refuse();
  return { id: safeId, cwd: safeCwd };
}

async function checkedHeader(root: string, file: string): Promise<Readonly<{ path: string; header: RolloutHeader }>> {
  const resolved = await checkedFile(root, file);
  const contents = await readFile(resolved, 'utf8').catch(() => refuse());
  if (Buffer.byteLength(contents, 'utf8') > MAX_HEADER_BYTES) refuse();
  return Object.freeze({ path: resolved, header: headerOf(contents) });
}

async function rolloutFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [{ directory: path.join(root, 'sessions'), depth: 0 }, { directory: path.join(root, 'archived_sessions'), depth: 0 }];
  let entriesSeen = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    if (depth > MAX_SOURCE_DEPTH) refuse();
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return refuse();
    });
    for (const entry of entries) {
      if (++entriesSeen > MAX_SOURCE_ENTRIES) refuse();
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) refuse();
      if (entry.isDirectory()) pending.push({ directory: candidate, depth: depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (result.length >= MAX_ROLLOUT_FILES) refuse();
        result.push(candidate);
      }
      else if (!entry.isFile()) refuse();
    }
  }
  return result;
}

/**
 * Captures a bounded, read-only before-start inventory for an exclusive empty
 * source home. It is not a native source revision or stock-write authority.
 */
export async function captureControlledNativeSourcePreflight(identity: ControlledNativeSourceIdentity,
  sourceHome: string, workspace: string): Promise<ControlledSourcePreflight> {
  if (!validIdentity(identity)) refuse();
  const root = await checkedRealDirectory(sourceHome);
  const work = await checkedRealDirectory(workspace);
  const seen = new Set<string>();
  const rollouts = await Promise.all((await rolloutFiles(root)).map(async file => {
    const observed = await checkedHeader(root, file);
    if (seen.has(observed.header.id)) refuse();
    seen.add(observed.header.id);
    return Object.freeze({ path: observed.path, threadId: observed.header.id });
  }));
  if (rollouts.length !== 0) refuse();
  const preflight = Object.freeze({ identity: Object.freeze({ ...identity }), sourceHome: root, workspace: work,
    capturedAtMs: Date.now(), rollouts: Object.freeze(rollouts) });
  brand.add(preflight);
  return preflight;
}

function validIdentity(value: unknown): value is ControlledNativeSourceIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Reflect.ownKeys(item).length === 3 && typeof item.operationId === 'string' && UUID.test(item.operationId) &&
    typeof item.sourceGeneration === 'string' && UUID.test(item.sourceGeneration) && typeof item.sourceId === 'string' &&
    item.sourceId.length > 0 && item.sourceId.length <= 256 && !/[\x00-\x1f\x7f]/u.test(item.sourceId);
}

function sameIdentity(left: ControlledNativeSourceIdentity, right: ControlledNativeSourceIdentity): boolean {
  return left.operationId === right.operationId && left.sourceId === right.sourceId && left.sourceGeneration === right.sourceGeneration;
}

/** Writes one immutable, fail-closed pre-start receipt. The caller's intent journal remains the trust root. */
export async function persistControlledNativeSourcePreflightReceipt(filePath: string,
  preflight: ControlledSourcePreflight): Promise<void> {
  if (!brand.has(preflight) || preflight.rollouts.length !== 0 || !validIdentity(preflight.identity) ||
    !Number.isSafeInteger(preflight.capturedAtMs) || preflight.capturedAtMs < 0 || !absolute(filePath)) refuse();
  const root = await checkedRealDirectory(preflight.sourceHome);
  const workspace = await checkedRealDirectory(preflight.workspace);
  if (!equalPath(root, preflight.sourceHome) || !equalPath(workspace, preflight.workspace) ||
    (await rolloutFiles(root)).length !== 0) refuse();
  const lexical = path.resolve(filePath);
  const parent = await checkedRealDirectory(path.dirname(lexical));
  const name = path.basename(lexical);
  if (!name || name === '.' || name === '..') refuse();
  const candidate = path.join(parent, name);
  const data = JSON.stringify({ schemaVersion: 1, operationId: preflight.identity.operationId,
    sourceId: preflight.identity.sourceId, sourceGeneration: preflight.identity.sourceGeneration,
    sourceHome: root, workspace, capturedAtMs: preflight.capturedAtMs });
  if (Buffer.byteLength(data, 'utf8') > MAX_RECEIPT_BYTES) refuse();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } catch { refuse(); }
  finally { await handle?.close(); }
}

/** Loads a receipt after restart and binds it to the independently loaded durable intent. */
export async function loadControlledNativeSourcePreflightReceipt(filePath: string,
  expectedIdentity: ControlledNativeSourceIdentity, expectedSourceHome: string,
  expectedWorkspace: string): Promise<ControlledSourcePreflight> {
  if (!validIdentity(expectedIdentity) || !absolute(filePath) || !absolute(expectedSourceHome) || !absolute(expectedWorkspace)) refuse();
  const metadata = await lstat(filePath).catch(() => refuse());
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_RECEIPT_BYTES) refuse();
  const text = await readFile(filePath, 'utf8').catch(() => refuse());
  let value: unknown;
  try { value = JSON.parse(text); } catch { refuse(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse();
  const item = value as Record<string, unknown>;
  const captured = item.capturedAtMs;
  const keys = ['schemaVersion', 'operationId', 'sourceId', 'sourceGeneration', 'sourceHome', 'workspace', 'capturedAtMs'];
  if (Reflect.ownKeys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key)) || item.schemaVersion !== 1 ||
    !validIdentity({ operationId: item.operationId, sourceId: item.sourceId, sourceGeneration: item.sourceGeneration }) ||
    !sameIdentity({ operationId: item.operationId as string, sourceId: item.sourceId as string,
      sourceGeneration: item.sourceGeneration as string }, expectedIdentity) ||
    typeof item.sourceHome !== 'string' || typeof item.workspace !== 'string' ||
    typeof captured !== 'number' || !Number.isSafeInteger(captured) || captured < 0) refuse();
  const sourceHome = item.sourceHome as string, workspacePath = item.workspace as string,
    capturedAtMs = captured as number;
  const [root, workspace, expectedRoot, expectedWork] = await Promise.all([
    checkedRealDirectory(sourceHome), checkedRealDirectory(workspacePath),
    checkedRealDirectory(expectedSourceHome), checkedRealDirectory(expectedWorkspace),
  ]);
  if (!equalPath(root, expectedRoot) || !equalPath(workspace, expectedWork)) refuse();
  const preflight = Object.freeze({ identity: Object.freeze({ ...expectedIdentity }), sourceHome: root, workspace,
    capturedAtMs, rollouts: Object.freeze([]) });
  brand.add(preflight);
  return preflight;
}

/**
 * Checks the post-start native path against a pre-start inventory. This accepts
 * a header-only zero-turn rollout and deliberately does not inspect state_5.
 */
export async function proveControlledNativeSource(preflight: ControlledSourcePreflight,
  observedNativePath: string, threadId: string): Promise<ControlledSourceProof> {
  if (!brand.has(preflight) || !validIdentity(preflight.identity) || typeof threadId !== 'string' || !UUID.test(threadId)) refuse();
  const root = await checkedRealDirectory(preflight.sourceHome);
  const work = await checkedRealDirectory(preflight.workspace);
  if (!equalPath(root, preflight.sourceHome) || !equalPath(work, preflight.workspace)) refuse();
  if (preflight.rollouts.length !== 0) refuse();
  const observed = await checkedHeader(root, observedNativePath);
  const observedWorkspace = await checkedRealDirectory(observed.header.cwd);
  if (observed.header.id !== threadId || !equalPath(observedWorkspace, work)) refuse();
  const current = await Promise.all((await rolloutFiles(root)).map(file => checkedHeader(root, file)));
  const sameId = current.filter(item => item.header.id === threadId);
  if (sameId.length !== 1 || !equalPath(sameId[0]!.path, observed.path)) refuse();
  if (current.length !== 1) refuse();
  return Object.freeze({ rolloutPath: observed.path, threadId });
}

/** Captures an opt-in, candidate-only preflight for a nonempty authenticated profile. */
export async function captureAuthenticatedProfileSourcePreflight(identity: ControlledNativeSourceIdentity,
  sourceHome: string, workspace: string): Promise<AuthenticatedProfileSourcePreflight> {
  if (!validIdentity(identity)) refuse();
  const [home, work] = await Promise.all([checkedDirectoryIdentity(sourceHome), checkedDirectoryIdentity(workspace)]);
  const preflight = Object.freeze({ identity: Object.freeze({ ...identity }), sourceHome: home.path, workspace: work.path,
    capturedAtMs: Date.now(), sourceHomeIdentity: home.identity, workspaceIdentity: work.identity });
  brand.add(preflight);
  return preflight;
}

function validProfilePreflight(preflight: AuthenticatedProfileSourcePreflight): boolean {
  if (!preflight || typeof preflight !== 'object') return false;
  const pin = preflight.sourceHomeIdentity, workspacePin = preflight.workspaceIdentity;
  return brand.has(preflight) && validIdentity(preflight.identity) && typeof preflight.sourceHome === 'string' &&
    typeof preflight.workspace === 'string' && Number.isSafeInteger(preflight.capturedAtMs) && preflight.capturedAtMs >= 0 &&
    pin !== null && typeof pin === 'object' && typeof pin.dev === 'bigint' && typeof pin.ino === 'bigint' &&
    typeof pin.birthtimeMs === 'bigint' && pin.birthtimeMs >= 0n && (workspacePin === undefined ||
      workspacePin !== null && typeof workspacePin === 'object' && typeof workspacePin.dev === 'bigint' &&
      typeof workspacePin.ino === 'bigint' && typeof workspacePin.birthtimeMs === 'bigint' && workspacePin.birthtimeMs >= 0n);
}

/**
 * Performs the final synchronous, read-only gate immediately before a caller
 * writes through an authenticated-profile source. It intentionally does not
 * replace the asynchronous candidate proof.
 */
export function assertAuthenticatedProfileSourcePreflightForWrite(preflight: AuthenticatedProfileSourcePreflight,
  expectedIdentity: ControlledNativeSourceIdentity, expectedSourceHome: string, expectedWorkspace: string): void {
  if (!validProfilePreflight(preflight) || !validIdentity(expectedIdentity) ||
    typeof expectedSourceHome !== 'string' || typeof expectedWorkspace !== 'string') refuse();
  const workspacePin = preflight.workspaceIdentity ?? refuse();
  const home = checkedDirectoryIdentitySync(preflight.sourceHome);
  const workspace = checkedDirectoryIdentitySync(preflight.workspace);
  const expectedHome = checkedDirectoryIdentitySync(expectedSourceHome);
  const expectedWork = checkedDirectoryIdentitySync(expectedWorkspace);
  // Windows may return an 8.3 spelling from realpathSync where the async
  // capture returned a long spelling. Directory identity, not text, pins the
  // same physical source and catches a replacement at the original path.
  if (!sameIdentity(preflight.identity, expectedIdentity) ||
    !sameFileSystemIdentity(home.identity, preflight.sourceHomeIdentity) ||
    !sameFileSystemIdentity(home.identity, expectedHome.identity) ||
    !sameFileSystemIdentity(workspace.identity, workspacePin) ||
    !sameFileSystemIdentity(workspace.identity, expectedWork.identity)) refuse();
}

function profileReceipt(preflight: AuthenticatedProfileSourcePreflight): string {
  const workspacePin = preflight.workspaceIdentity ?? refuse();
  return JSON.stringify({ schemaVersion: AUTHENTICATED_PROFILE_RECEIPT_SCHEMA_VERSION,
    operationId: preflight.identity.operationId, sourceId: preflight.identity.sourceId,
    sourceGeneration: preflight.identity.sourceGeneration, sourceHome: preflight.sourceHome,
    workspace: preflight.workspace, capturedAtMs: preflight.capturedAtMs,
    sourceHomeDev: preflight.sourceHomeIdentity.dev.toString(), sourceHomeIno: preflight.sourceHomeIdentity.ino.toString(),
    sourceHomeBirthtimeMs: preflight.sourceHomeIdentity.birthtimeMs.toString(),
    workspaceDev: workspacePin.dev.toString(), workspaceIno: workspacePin.ino.toString(),
    workspaceBirthtimeMs: workspacePin.birthtimeMs.toString() });
}

/** Synchronous final fence for the v3 pre-write source receipt. A valid
 * in-memory preflight alone is not enough to reconcile a lost thread/start
 * after process death; its exact durable receipt must survive the write. */
export function assertAuthenticatedProfileSourceReceiptForWrite(filePath: string,
  preflight: AuthenticatedProfileSourcePreflight): void {
  try {
    if (!absolute(filePath) || !validProfilePreflight(preflight) ||
        lstatSync(filePath).isSymbolicLink()) refuse();
    const expected = Buffer.from(profileReceipt(preflight), 'utf8');
    if (expected.byteLength < 1 || expected.byteLength > MAX_RECEIPT_BYTES) refuse();
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size !== BigInt(expected.byteLength)) refuse();
      const actual = Buffer.alloc(expected.byteLength);
      let offset = 0;
      while (offset < actual.byteLength) {
        const received = readSync(fd, actual, offset, actual.byteLength - offset, offset);
        if (received <= 0) refuse();
        offset += received;
      }
      const after = fstatSync(fd, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino ||
          after.birthtimeMs !== before.birthtimeMs || after.size !== before.size ||
          !actual.equals(expected)) refuse();
    } finally { closeSync(fd); }
  } catch { refuse(); }
}

/** Persists a versioned receipt for the candidate-only authenticated-profile variant. */
export async function persistAuthenticatedProfileSourcePreflightReceipt(filePath: string,
  preflight: AuthenticatedProfileSourcePreflight): Promise<void> {
  if (!validProfilePreflight(preflight) || !absolute(filePath)) refuse();
  const workspacePin = preflight.workspaceIdentity ?? refuse();
  const [home, workspace] = await Promise.all([checkedDirectoryIdentity(preflight.sourceHome), checkedDirectoryIdentity(preflight.workspace)]);
  if (!equalPath(home.path, preflight.sourceHome) || !equalPath(workspace.path, preflight.workspace) ||
    !sameFileSystemIdentity(home.identity, preflight.sourceHomeIdentity) ||
    !sameFileSystemIdentity(workspace.identity, workspacePin)) refuse();
  const lexical = path.resolve(filePath), parent = await checkedRealDirectory(path.dirname(lexical));
  const name = path.basename(lexical);
  if (!name || name === '.' || name === '..') refuse();
  const data = profileReceipt(preflight);
  if (Buffer.byteLength(data, 'utf8') > MAX_RECEIPT_BYTES) refuse();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path.join(parent, name), 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } catch { refuse(); }
  finally { await handle?.close(); }
}

function decimalBigInt(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

/** Loads an authenticated-profile receipt and rejects any home replacement or path drift. */
export async function loadAuthenticatedProfileSourcePreflightReceipt(filePath: string,
  expectedIdentity: ControlledNativeSourceIdentity, expectedSourceHome: string,
  expectedWorkspace: string): Promise<AuthenticatedProfileSourcePreflight> {
  if (!validIdentity(expectedIdentity) || !absolute(filePath) || !absolute(expectedSourceHome) || !absolute(expectedWorkspace)) refuse();
  const metadata = await lstat(filePath).catch(() => refuse());
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_RECEIPT_BYTES) refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch { refuse(); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refuse();
  const item = parsed as Record<string, unknown>;
  const legacy = item.schemaVersion === LEGACY_AUTHENTICATED_PROFILE_RECEIPT_SCHEMA_VERSION;
  const keys = legacy
    ? ['schemaVersion', 'operationId', 'sourceId', 'sourceGeneration', 'sourceHome', 'workspace', 'capturedAtMs',
      'sourceHomeDev', 'sourceHomeIno', 'sourceHomeBirthtimeMs']
    : ['schemaVersion', 'operationId', 'sourceId', 'sourceGeneration', 'sourceHome', 'workspace', 'capturedAtMs',
      'sourceHomeDev', 'sourceHomeIno', 'sourceHomeBirthtimeMs', 'workspaceDev', 'workspaceIno', 'workspaceBirthtimeMs'];
  const pin = { dev: decimalBigInt(item.sourceHomeDev), ino: decimalBigInt(item.sourceHomeIno),
    birthtimeMs: decimalBigInt(item.sourceHomeBirthtimeMs) };
  const workspacePin = { dev: decimalBigInt(item.workspaceDev), ino: decimalBigInt(item.workspaceIno),
    birthtimeMs: decimalBigInt(item.workspaceBirthtimeMs) };
  if (Reflect.ownKeys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key)) ||
    (!legacy && item.schemaVersion !== AUTHENTICATED_PROFILE_RECEIPT_SCHEMA_VERSION) || typeof item.sourceHome !== 'string' ||
    typeof item.workspace !== 'string' || typeof item.capturedAtMs !== 'number' || !Number.isSafeInteger(item.capturedAtMs) ||
    item.capturedAtMs < 0 || pin.dev === undefined || pin.ino === undefined || pin.birthtimeMs === undefined || pin.birthtimeMs < 0n ||
    (!legacy && (workspacePin.dev === undefined || workspacePin.ino === undefined || workspacePin.birthtimeMs === undefined ||
      workspacePin.birthtimeMs < 0n)) ||
    !validIdentity({ operationId: item.operationId, sourceId: item.sourceId, sourceGeneration: item.sourceGeneration }) ||
    !sameIdentity({ operationId: item.operationId as string, sourceId: item.sourceId as string,
      sourceGeneration: item.sourceGeneration as string }, expectedIdentity)) refuse();
  const receiptHome = item.sourceHome as string, receiptWorkspace = item.workspace as string,
    receiptCapturedAtMs = item.capturedAtMs as number,
    receiptPin = { dev: pin.dev as bigint, ino: pin.ino as bigint, birthtimeMs: pin.birthtimeMs as bigint };
  const [home, work, expectedHome, expectedWork] = await Promise.all([checkedDirectoryIdentity(receiptHome),
    checkedDirectoryIdentity(receiptWorkspace), checkedDirectoryIdentity(expectedSourceHome), checkedDirectoryIdentity(expectedWorkspace)]);
  if (!equalPath(home.path, expectedHome.path) || !equalPath(work.path, expectedWork.path) ||
    !sameFileSystemIdentity(home.identity, expectedHome.identity) ||
    !sameFileSystemIdentity(home.identity, receiptPin) || (!legacy &&
      !sameFileSystemIdentity(work.identity, { dev: workspacePin.dev as bigint, ino: workspacePin.ino as bigint,
        birthtimeMs: workspacePin.birthtimeMs as bigint }))) refuse();
  const preflight = Object.freeze({ identity: Object.freeze({ ...expectedIdentity }), sourceHome: home.path, workspace: work.path,
    capturedAtMs: receiptCapturedAtMs, sourceHomeIdentity: Object.freeze(receiptPin),
    ...(!legacy ? { workspaceIdentity: Object.freeze({ dev: workspacePin.dev as bigint, ino: workspacePin.ino as bigint,
      birthtimeMs: workspacePin.birthtimeMs as bigint }) } : {}) });
  brand.add(preflight);
  return preflight;
}

/**
 * Proves exactly one returned native candidate. It does not enumerate legacy
 * rollout files and does not make a global uniqueness or exclusivity claim.
 */
export async function proveAuthenticatedProfileSource(preflight: AuthenticatedProfileSourcePreflight,
  observedNativePath: string, threadId: string): Promise<AuthenticatedProfileSourceProof> {
  if (!validProfilePreflight(preflight) || typeof observedNativePath !== 'string' || !absolute(observedNativePath) ||
    typeof threadId !== 'string' || !UUID.test(threadId)) refuse();
  const [home, workspace] = await Promise.all([checkedDirectoryIdentity(preflight.sourceHome), checkedDirectoryIdentity(preflight.workspace)]);
  if (!equalPath(home.path, preflight.sourceHome) || !equalPath(workspace.path, preflight.workspace) ||
    !sameFileSystemIdentity(home.identity, preflight.sourceHomeIdentity) ||
    (preflight.workspaceIdentity !== undefined && !sameFileSystemIdentity(workspace.identity, preflight.workspaceIdentity))) refuse();
  const candidate = await checkedProfileCandidate(home.path, observedNativePath);
  const earliestAllowedBirthtime = BigInt(Math.max(0, preflight.capturedAtMs - AUTHENTICATED_PROFILE_BIRTHTIME_TOLERANCE_MS));
  if (candidate.header.id !== threadId || candidate.identity.birthtimeMs < earliestAllowedBirthtime) refuse();
  const candidateWorkspace = await checkedRealDirectory(candidate.header.cwd);
  if (!equalPath(candidateWorkspace, workspace.path)) refuse();
  const [recheckedHome, recheckedWorkspace, recheckedCandidate] = await Promise.all([checkedDirectoryIdentity(preflight.sourceHome),
    checkedDirectoryIdentity(preflight.workspace), checkedProfileCandidate(home.path, observedNativePath)]);
  if (!sameFileSystemIdentity(recheckedHome.identity, preflight.sourceHomeIdentity) ||
    !sameFileSystemIdentity(recheckedCandidate.identity, candidate.identity) ||
    recheckedCandidate.headerSha256 !== candidate.headerSha256 || recheckedCandidate.header.id !== candidate.header.id ||
    !equalPath(recheckedWorkspace.path, workspace.path) || !equalPath(recheckedCandidate.header.cwd, candidate.header.cwd) ||
    (preflight.workspaceIdentity !== undefined && !sameFileSystemIdentity(recheckedWorkspace.identity, preflight.workspaceIdentity)) ||
    !equalPath(recheckedCandidate.path, candidate.path)) refuse();
  const claim = authenticatedProfileClaims.get(preflight);
  if (claim !== undefined && (claim.threadId !== threadId || !equalPath(claim.path, candidate.path) ||
    !sameFileSystemIdentity(claim.identity, candidate.identity) || claim.headerSha256 !== candidate.headerSha256 ||
    claim.header.id !== candidate.header.id ||
    !equalPath(claim.header.cwd, candidate.header.cwd))) refuse();
  if (claim === undefined) {
    // The explicit one-slot state limit permits only idempotent reproofs.
    if (MAX_AUTHENTICATED_PROFILE_CLAIMS !== 1) refuse();
    authenticatedProfileClaims.set(preflight, Object.freeze({ path: candidate.path, threadId, identity: candidate.identity,
      headerSha256: candidate.headerSha256,
      header: Object.freeze({ ...candidate.header }) }));
  }
  return Object.freeze({ rolloutPath: candidate.path, threadId });
}
