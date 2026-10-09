import Database from "better-sqlite3";
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

export class RuntimeAlreadyRunningError extends Error {
  constructor() {
    super("Another VKodex runtime already holds this data directory.");
    this.name = "RuntimeAlreadyRunningError";
  }
}

export interface RuntimeLease { close(): void }

/** Keep the OS-backed SQLite write lock for the entire process lifetime.
 * This database is separate from bridge state; a crash releases the lock without
 * trusting a PID file or expiring a lease underneath a healthy runtime. */
export function acquireRuntimeLease(dataDirectory: string): RuntimeLease {
  if (!path.isAbsolute(dataDirectory)) throw new TypeError("Runtime data directory must be absolute");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDirectory, "runtime-lease.sqlite");
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Runtime lease must be a regular file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const db = new Database(filename, { timeout: 0 });
  try { db.exec("BEGIN IMMEDIATE"); }
  catch (error) {
    db.close();
    if (error instanceof Error && "code" in error && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(error.code))) {
      throw new RuntimeAlreadyRunningError();
    }
    throw error;
  }
  let closed = false;
  return { close() {
    if (closed) return;
    db.close(); // Closing rolls back and releases the file lock.
    closed = true;
  } };
}
