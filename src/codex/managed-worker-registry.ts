import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import DatabaseConstructor, { type Database } from "better-sqlite3";

export interface ProcessIdentity { readonly pid: number; readonly birthTicks: string }
export interface BackendIdentity extends ProcessIdentity { readonly generation: number }
export type WorkerState = "reserved" | "host_registered" | "backend_registered" | "ready" | "lost" | "retired";
export interface CleanupEvidence {
  readonly host: ProcessIdentity & { readonly observation: "absent" | "reused" };
  readonly backend: BackendIdentity & { readonly observation: "absent" | "reused" };
}
export interface WorkerAttempt {
  readonly epoch: string;
  readonly revision: number;
  readonly canonicalHome: string;
  readonly familyRoot: string;
  readonly state: WorkerState;
  readonly host: ProcessIdentity | null;
  readonly backend: BackendIdentity | null;
  readonly endpointRef: string | null;
  readonly lostReason: "backend_unavailable" | null;
  readonly cleanupEvidence: CleanupEvidence | null;
}

interface Row {
  epoch: string; revision: number; canonical_home: string; family_root: string; state: WorkerState;
  host_pid: number | null; host_birth: string | null;
  backend_pid: number | null; backend_birth: string | null; backend_generation: number | null;
  endpoint_ref: string | null; lost_reason: WorkerAttempt["lostReason"]; cleanup_evidence: string | null;
}

function bounded(value: string, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || value.trim() !== value) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function canonicalHome(home: string): string {
  if (!path.isAbsolute(home)) throw new Error("Home must be absolute");
  const real = realpathSync.native(home);
  if (!statSync(real).isDirectory()) throw new Error("Home must be a directory");
  const normalized = process.platform === "win32" ? path.win32.normalize(real).toLowerCase() : path.normalize(real);
  return normalized.length > 3 ? normalized.replace(/[\\/]$/u, "") : normalized;
}

function processIdentity(identity: ProcessIdentity, name: string): void {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new Error(`Invalid ${name} pid`);
  if (typeof identity.birthTicks !== "string" || !/^[1-9]\d{0,23}$/u.test(identity.birthTicks)) throw new Error(`Invalid ${name} birth ticks`);
}

function backendIdentity(identity: BackendIdentity): void {
  processIdentity(identity, "backend");
  if (!Number.isSafeInteger(identity.generation) || identity.generation <= 0) throw new Error("Invalid backend generation");
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.birthTicks === b.birthTicks;
}

function sameBackend(a: BackendIdentity, b: BackendIdentity): boolean {
  return sameProcess(a, b) && a.generation === b.generation;
}

function attempt(row: Row): WorkerAttempt {
  return {
    epoch: row.epoch, revision: row.revision, canonicalHome: row.canonical_home, familyRoot: row.family_root, state: row.state,
    host: row.host_pid === null || row.host_birth === null ? null : { pid: row.host_pid, birthTicks: row.host_birth },
    backend: row.backend_pid === null || row.backend_birth === null || row.backend_generation === null ? null :
      { pid: row.backend_pid, birthTicks: row.backend_birth, generation: row.backend_generation },
    endpointRef: row.endpoint_ref, lostReason: row.lost_reason,
    cleanupEvidence: row.cleanup_evidence === null ? null : JSON.parse(row.cleanup_evidence) as CleanupEvidence,
  };
}

/**
 * A durable reservation ledger. familyRoot is routing scope, not proof of native
 * worker ownership or a native writer lease. Process identities and cleanup
 * observations must come from a trusted observer on the same machine; this
 * module does not inspect processes or independently verify that evidence.
 */
export class ManagedWorkerRegistry {
  private readonly db: Database;

  constructor(databasePath: string) {
    if (!path.isAbsolute(databasePath)) throw new Error("Database path must be absolute");
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseConstructor(databasePath);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS managed_worker_attempts (
      epoch TEXT PRIMARY KEY, revision INTEGER NOT NULL, canonical_home TEXT NOT NULL, family_root TEXT NOT NULL,
      state TEXT NOT NULL, host_pid INTEGER, host_birth TEXT, backend_pid INTEGER, backend_birth TEXT,
      backend_generation INTEGER, endpoint_ref TEXT, lost_reason TEXT, cleanup_evidence TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS managed_worker_active_family
      ON managed_worker_attempts(canonical_home, family_root) WHERE state <> 'retired';`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }
  journalMode(): string { return this.db.pragma("journal_mode", { simple: true }) as string; }
  synchronousMode(): number { return this.db.pragma("synchronous", { simple: true }) as number; }

  reserve(home: string, familyRoot: string): WorkerAttempt {
    const canonical = canonicalHome(home);
    const family = bounded(familyRoot, "family root", 256);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT epoch FROM managed_worker_attempts WHERE canonical_home = ? AND family_root = ? AND state <> 'retired'").get(canonical, family);
      if (existing) throw new Error("Active worker family already reserved");
      const epoch = randomUUID();
      const now = Date.now();
      this.db.prepare("INSERT INTO managed_worker_attempts(epoch,revision,canonical_home,family_root,state,created_at,updated_at) VALUES (?,0,?,?,'reserved',?,?)")
        .run(epoch, canonical, family, now, now);
      return this.byEpoch(epoch);
    }).immediate();
  }

  get(home: string, familyRoot: string): WorkerAttempt | null {
    const row = this.db.prepare("SELECT * FROM managed_worker_attempts WHERE canonical_home = ? AND family_root = ? ORDER BY (state <> 'retired') DESC, created_at DESC, rowid DESC LIMIT 1")
      .get(canonicalHome(home), bounded(familyRoot, "family root", 256)) as Row | undefined;
    return row ? attempt(row) : null;
  }

  history(home: string, familyRoot: string): readonly WorkerAttempt[] {
    return (this.db.prepare("SELECT * FROM managed_worker_attempts WHERE canonical_home = ? AND family_root = ? ORDER BY created_at, rowid")
      .all(canonicalHome(home), bounded(familyRoot, "family root", 256)) as Row[]).map(attempt);
  }

  registerHost(expected: WorkerAttempt, host: ProcessIdentity): WorkerAttempt {
    processIdentity(host, "host");
    return this.transition(expected, ["reserved"], "host_registered", { host_pid: host.pid, host_birth: host.birthTicks });
  }

  registerBackend(expected: WorkerAttempt, host: ProcessIdentity, backend: BackendIdentity): WorkerAttempt {
    processIdentity(host, "host"); backendIdentity(backend);
    return this.transition(expected, ["host_registered"], "backend_registered", {
      backend_pid: backend.pid, backend_birth: backend.birthTicks, backend_generation: backend.generation,
    }, row => this.requireIdentities(row, host));
  }

  markReady(expected: WorkerAttempt, host: ProcessIdentity, backend: BackendIdentity, endpointRef: string): WorkerAttempt {
    processIdentity(host, "host"); backendIdentity(backend);
    const ref = bounded(endpointRef, "endpoint reference", 128);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(ref)) {
      throw new Error("Endpoint reference must be an opaque UUID");
    }
    return this.transition(expected, ["backend_registered"], "ready", { endpoint_ref: ref },
      row => this.requireIdentities(row, host, backend));
  }

  markLost(expected: WorkerAttempt, host: ProcessIdentity, backend: BackendIdentity,
    reason: "backend_unavailable"): WorkerAttempt {
    processIdentity(host, "host"); backendIdentity(backend);
    if (reason !== "backend_unavailable") throw new Error("Invalid loss reason");
    return this.transition(expected, ["backend_registered", "ready"], "lost", { lost_reason: reason },
      row => this.requireIdentities(row, host, backend));
  }

  retire(expected: WorkerAttempt, host: ProcessIdentity, backend: BackendIdentity, evidence: CleanupEvidence): WorkerAttempt {
    processIdentity(host, "host"); backendIdentity(backend);
    if (!evidence || !evidence.host || !evidence.backend ||
      !["absent", "reused"].includes(evidence.host.observation) ||
      !["absent", "reused"].includes(evidence.backend.observation)) throw new Error("Invalid cleanup evidence observation");
    processIdentity(evidence.host, "evidence host"); backendIdentity(evidence.backend);
    if (!sameProcess(host, evidence.host) || !sameBackend(backend, evidence.backend)) throw new Error("Cleanup evidence identity mismatch");
    const storedEvidence: CleanupEvidence = {
      host: { pid: host.pid, birthTicks: host.birthTicks, observation: evidence.host.observation },
      backend: { pid: backend.pid, birthTicks: backend.birthTicks, generation: backend.generation, observation: evidence.backend.observation },
    };
    return this.transition(expected, ["backend_registered", "ready", "lost"], "retired",
      { cleanup_evidence: JSON.stringify(storedEvidence) }, row => this.requireIdentities(row, host, backend));
  }

  private byEpoch(epoch: string): WorkerAttempt {
    const row = this.db.prepare("SELECT * FROM managed_worker_attempts WHERE epoch = ?").get(epoch) as Row | undefined;
    if (!row) throw new Error("Stale worker epoch");
    return attempt(row);
  }

  private requireIdentities(row: Row, host: ProcessIdentity, backend?: BackendIdentity): void {
    if (row.host_pid !== host.pid || row.host_birth !== host.birthTicks) throw new Error("Host identity mismatch");
    if (backend && (row.backend_pid !== backend.pid || row.backend_birth !== backend.birthTicks || row.backend_generation !== backend.generation)) {
      throw new Error("Backend identity or generation mismatch");
    }
  }

  private transition(expected: WorkerAttempt, states: readonly WorkerState[], next: WorkerState,
    fields: Readonly<Record<string, string | number>>, check?: (row: Row) => void): WorkerAttempt {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM managed_worker_attempts WHERE epoch = ?").get(expected.epoch) as Row | undefined;
      if (!row || row.revision !== expected.revision || row.canonical_home !== expected.canonicalHome || row.family_root !== expected.familyRoot) {
        throw new Error("Stale worker epoch or revision");
      }
      if (!states.includes(row.state)) throw new Error("Invalid worker state transition");
      check?.(row);
      const names = Object.keys(fields);
      const sql = `UPDATE managed_worker_attempts SET state = ?, revision = revision + 1, updated_at = ?, ${names.map(name => `${name} = ?`).join(", ")}
        WHERE epoch = ? AND revision = ? AND state = ?`;
      const result = this.db.prepare(sql).run(next, Date.now(), ...names.map(name => fields[name]), row.epoch, row.revision, row.state);
      if (result.changes !== 1) throw new Error("Stale worker epoch or revision");
      return this.byEpoch(row.epoch);
    }).immediate();
  }
}
