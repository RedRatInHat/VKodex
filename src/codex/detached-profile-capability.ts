import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { comparablePath } from "../core/paths.js";
import { readWindowsProcessIdentity } from "../desktop/windows-process-identity.js";
import { assertWindowsPrivateDirectory } from "../desktop/windows-private-directory.js";
import { AppServerUnavailableError, type AppServerEnvelope, type AppServerRequestOptions,
  type AppServerRpc, type AppServerServerRequestHandler } from "./app-server-connection.js";
import { createAppServerWebSocketConnection } from "./app-server-websocket-connection.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^[A-Za-z0-9_-]{16,512}$/u;
const BIRTH = /^[1-9]\d{0,23}$/u;
const MAX_DESCRIPTOR_BYTES = 4096;

/** Published only after an independent native server has answered initialize.
 * A ready record is a locator, never evidence of a Codex writer lease. */
export interface DetachedProfileDescriptor {
  readonly schemaVersion: 1;
  readonly epoch: string;
  readonly profileKey: string;
  readonly home: string;
  readonly url: string;
  readonly backend: Readonly<{ pid: number; birthTicks: string }>;
}

export interface DetachedProfileCapabilityDependencies {
  readonly readFile?: (file: string, limit: number) => string;
  readonly identity?: (pid: number) => Readonly<{ pid: number; birthTicks: string }> | null;
  readonly assertPrivateDirectory?: (directory: string) => void;
}

/** Stable private locator; never use a VK-supplied name as a path segment. */
export function detachedProfileDirectory(dataDirectory: string, home: string): string {
  if (!path.isAbsolute(dataDirectory) || !path.isAbsolute(home)) throw new TypeError("Invalid detached profile directory");
  return path.join(dataDirectory, "profile-servers", detachedProfileKey(home));
}

/** Stable across primary/secondary source ordering in CODEX_SOURCES. */
export function detachedProfileKey(home: string): string {
  const canonical = canonicalDetachedProfileHome(home);
  return createHash("sha256").update(comparablePath(canonical)).digest("hex").slice(0, 32);
}

/** One physical CODEX_HOME must map to exactly one reservation directory,
 * even when reached via a Windows junction or another lexical alias. */
export function canonicalDetachedProfileHome(home: string): string {
  if (!path.isAbsolute(home)) throw new TypeError("Invalid detached profile home");
  const canonical = realpathSync.native(home);
  if (!statSync(canonical).isDirectory()) throw new TypeError("Invalid detached profile home");
  return canonical;
}

const unavailable = (): never => { throw new AppServerUnavailableError("Отдельный Codex App Server недоступен."); };

function boundedRead(file: string, limit: number): string {
  const directory = path.dirname(file);
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const segment of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const parent = lstatSync(current);
    if (!parent.isDirectory() || parent.isSymbolicLink()) unavailable();
  }
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const entry = fstatSync(handle);
    if (!entry.isFile() || entry.size < 1 || entry.size > limit) unavailable();
    const bytes = Buffer.alloc(entry.size);
    let offset = 0;
    while (offset < bytes.length) {
      const received = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (received <= 0) unavailable();
      offset += received;
    }
    const after = fstatSync(handle);
    if (after.size !== entry.size || after.ino !== entry.ino || after.dev !== entry.dev) unavailable();
    return bytes.toString("utf8");
  } finally { closeSync(handle); }
}

function exactDescriptor(value: unknown, home: string): DetachedProfileDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const item = value as Record<string, unknown>;
  const keys = ["schemaVersion", "epoch", "profileKey", "home", "url", "backend"];
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key)) ||
    item.schemaVersion !== 1 || typeof item.epoch !== "string" || !UUID.test(item.epoch) ||
    item.profileKey !== detachedProfileKey(home) || typeof item.home !== "string" ||
    comparablePath(item.home) !== comparablePath(home) ||
    !path.isAbsolute(item.home) || typeof item.url !== "string" ||
    !item.backend || typeof item.backend !== "object" || Array.isArray(item.backend)) unavailable();
  const backend = item.backend as Record<string, unknown>;
  if (Object.keys(backend).length !== 2 || !Object.hasOwn(backend, "pid") ||
    !Object.hasOwn(backend, "birthTicks") || !Number.isSafeInteger(backend.pid) ||
    (backend.pid as number) <= 0 || (backend.pid as number) > 2_147_483_647 ||
    typeof backend.birthTicks !== "string" || !BIRTH.test(backend.birthTicks)) unavailable();
  try {
    if (comparablePath(canonicalDetachedProfileHome(item.home as string)) !== comparablePath(item.home as string)) unavailable();
  } catch { unavailable(); }
  // Keep this parser independent of a socket attempt. The WebSocket adapter
  // applies the complete loopback URL and bearer validation before connecting.
  if ((item.url as string).length > 128) unavailable();
  return Object.freeze({ schemaVersion: 1, epoch: item.epoch as string, profileKey: item.profileKey as string, home: item.home as string,
    url: item.url as string, backend: Object.freeze({ pid: backend.pid as number, birthTicks: backend.birthTicks as string }) });
}

function descriptorEquals(a: DetachedProfileDescriptor, b: DetachedProfileDescriptor): boolean {
  return a.epoch === b.epoch && a.profileKey === b.profileKey &&
    comparablePath(a.home) === comparablePath(b.home) && a.url === b.url &&
    a.backend.pid === b.backend.pid && a.backend.birthTicks === b.backend.birthTicks;
}

/** Read-only recovery evidence. `dead-exact` is deliberately diagnostic only:
 * it never authorizes descriptor replacement or another server launch. */
export type DetachedProfileBackendDiagnostic = Readonly<{ state:
  "live" | "dead-exact" | "pid-reused-or-changed" | "unknown" | "changed" | "invalid" }>;

/** Inspect one protected ready record without connecting, launching, or
 * changing it. The second descriptor read fences a concurrent epoch change
 * across the bounded Windows PID/birth probe. */
export function inspectDetachedProfileBackend(privateDirectory: string,
  home: string, dependencies: DetachedProfileCapabilityDependencies = {}): DetachedProfileBackendDiagnostic {
  if (!path.isAbsolute(privateDirectory) || !path.isAbsolute(home) ||
    /[\x00-\x1f]/u.test(home)) throw new TypeError("Invalid detached profile scope");
  const read = dependencies.readFile ?? boundedRead;
  const identity = dependencies.identity ?? ((pid: number) => readWindowsProcessIdentity(pid, 2_000));
  const assertPrivate = dependencies.assertPrivateDirectory ??
    (dependencies.readFile ? () => {} : assertWindowsPrivateDirectory);
  const protectedDirectories = [path.dirname(path.dirname(privateDirectory)),
    path.dirname(privateDirectory), privateDirectory];
  const assertBase = (): void => { for (const directory of protectedDirectories) assertPrivate(directory); };
  const load = (): DetachedProfileDescriptor | null => {
    try {
      const raw = read(path.join(privateDirectory, "ready.json"), MAX_DESCRIPTOR_BYTES);
      if (Buffer.byteLength(raw, "utf8") > MAX_DESCRIPTOR_BYTES) return null;
      return exactDescriptor(JSON.parse(raw) as unknown, home);
    } catch { return null; }
  };
  let original: DetachedProfileDescriptor | null;
  try { assertBase(); original = load(); } catch { return { state: "invalid" }; }
  if (!original) return { state: "invalid" };
  const tokenFile = path.join(privateDirectory, original.epoch, "token");
  const loadToken = (): string | null => {
    try {
      const token = read(tokenFile, 512);
      return Buffer.byteLength(token, "utf8") <= 512 && TOKEN.test(token) ? token : null;
    } catch { return null; }
  };
  let token: string | null;
  try { assertPrivate(path.dirname(tokenFile)); token = loadToken(); } catch { return { state: "invalid" }; }
  if (!token) return { state: "invalid" };
  let result: DetachedProfileBackendDiagnostic["state"];
  try {
    const observed = identity(original.backend.pid);
    result = !observed ? "dead-exact" : observed.pid === original.backend.pid &&
      observed.birthTicks === original.backend.birthTicks ? "live" : "pid-reused-or-changed";
  } catch { result = "unknown"; }
  let after: DetachedProfileDescriptor | null;
  let afterToken: string | null;
  try { assertBase(); assertPrivate(path.dirname(tokenFile)); after = load(); afterToken = loadToken(); }
  catch { return { state: "invalid" }; }
  if (!after) return { state: "invalid" };
  if (!afterToken) return { state: "invalid" };
  if (!descriptorEquals(original, after) || token !== afterToken) return { state: "changed" };
  return { state: result };
}

/** The caller supplies a trusted private directory, never a path from VK. The
 * epoch-specific token is deliberately absent from the public ready record. */
function openDetachedProfileConnection(privateDirectory: string,
  home: string, dependencies: DetachedProfileCapabilityDependencies): AppServerRpc {
  if (!path.isAbsolute(privateDirectory) || !path.isAbsolute(home) ||
    /[\x00-\x1f]/u.test(home)) throw new TypeError("Invalid detached profile scope");
  const read = dependencies.readFile ?? boundedRead;
  const identity = dependencies.identity ?? ((pid: number) => readWindowsProcessIdentity(pid, 2_000));
  const assertPrivate = dependencies.assertPrivateDirectory ??
    (dependencies.readFile ? () => {} : assertWindowsPrivateDirectory);
  const protectedDirectories = [path.dirname(path.dirname(privateDirectory)),
    path.dirname(privateDirectory), privateDirectory];
  const assertBase = (): void => { for (const directory of protectedDirectories) assertPrivate(directory); };
  const descriptorFile = path.join(privateDirectory, "ready.json");
  const loadDescriptor = (): DetachedProfileDescriptor => {
    try {
      const raw = read(descriptorFile, MAX_DESCRIPTOR_BYTES);
      if (Buffer.byteLength(raw, "utf8") > MAX_DESCRIPTOR_BYTES) unavailable();
      return exactDescriptor(JSON.parse(raw) as unknown, home);
    } catch { return unavailable(); }
  };
  try { assertBase(); } catch { unavailable(); }
  const original = loadDescriptor();
  const tokenFile = path.join(privateDirectory, original.epoch, "token");
  const loadToken = (): string => {
    try {
      const token = read(tokenFile, 512);
      if (!TOKEN.test(token)) unavailable();
      return token;
    } catch { return unavailable(); }
  };
  try { assertPrivate(path.dirname(tokenFile)); } catch { unavailable(); }
  const token = loadToken();
  const assertRecord = (): void => {
    if (!descriptorEquals(original, loadDescriptor()) || loadToken() !== token) unavailable();
  };
  const assertCurrent = (): void => {
    try { assertBase(); assertPrivate(path.dirname(tokenFile)); }
    catch { unavailable(); }
    assertRecord();
    let observed: Readonly<{ pid: number; birthTicks: string }> | null;
    try { observed = identity(original.backend.pid); } catch { return unavailable(); }
    if (!observed || observed.pid !== original.backend.pid ||
      observed.birthTicks !== original.backend.birthTicks) unavailable();
  };
  const rpc = createAppServerWebSocketConnection(original.url, token, 30_000, assertCurrent);
  return {
    start: () => rpc.start(),
    request(method: string, params?: Record<string, unknown>, options: AppServerRequestOptions = {}) {
      return rpc.request(method, params, { ...options,
        // An established WebSocket cannot be rebound to a different process.
        // PID/birth checks occur before each new connection, including reconnect;
        // the final per-request fence only needs the immutable capability record.
        assertBeforeWrite: () => { assertRecord(); options.assertBeforeWrite?.(); } });
    },
    onNotification(listener: (notification: AppServerEnvelope) => void) { return rpc.onNotification(listener); },
    onDisconnect(listener: (error: Error) => void) { return rpc.onDisconnect(listener); },
    onServerRequest(handler: AppServerServerRequestHandler | null) { rpc.onServerRequest(handler); },
    close: () => rpc.close(),
  };
}

/** A missing or stale ready record disables only this profile. A later first
 * request may attach after its independent server publishes a valid record;
 * once attached, it never silently adopts a different epoch. */
export function createDetachedProfileConnection(privateDirectory: string,
  home: string, dependencies: DetachedProfileCapabilityDependencies = {}): AppServerRpc {
  if (!path.isAbsolute(privateDirectory) || !path.isAbsolute(home) ||
    /[\x00-\x1f]/u.test(home)) throw new TypeError("Invalid detached profile scope");
  let rpc: AppServerRpc | null = null;
  let closed = false;
  let serverRequest: AppServerServerRequestHandler | null = null;
  const notifications = new Set<(notification: AppServerEnvelope) => void>();
  const disconnections = new Set<(error: Error) => void>();
  const current = (): AppServerRpc => {
    if (closed) unavailable();
    if (!rpc) {
      const created = openDetachedProfileConnection(privateDirectory, home, dependencies);
      created.onNotification(notification => { for (const listener of notifications) listener(notification); });
      created.onDisconnect?.(error => { for (const listener of disconnections) listener(error); });
      created.onServerRequest(serverRequest);
      rpc = created;
    }
    return rpc;
  };
  return {
    start: async () => current().start(),
    request: async (method, params, options) => current().request(method, params, options),
    onNotification(listener) { notifications.add(listener); return () => { notifications.delete(listener); }; },
    onDisconnect(listener) { disconnections.add(listener); return () => { disconnections.delete(listener); }; },
    onServerRequest(handler) { serverRequest = handler; rpc?.onServerRequest(handler); },
    async close() {
      closed = true; notifications.clear(); disconnections.clear(); serverRequest = null;
      await rpc?.close();
    },
  };
}
