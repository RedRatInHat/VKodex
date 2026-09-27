import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ManagedWorkerRegistry } from "../src/codex/managed-worker-registry.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "vkodex-worker-registry-"));
  const home = path.join(root, "home");
  mkdirSync(home);
  return { db: path.join(root, "registry.sqlite"), home };
}

const host = { pid: 1201, birthTicks: "134035643900000000" } as const;
const backend = { pid: 1202, birthTicks: "134035643900000001", generation: 7 } as const;
const evidence = {
  host: { ...host, observation: "absent" },
  backend: { ...backend, observation: "reused" },
} as const;

test("reservation is durable, canonical, and exclusive across database handles", () => {
  const { db, home } = fixture();
  const a = new ManagedWorkerRegistry(db);
  const b = new ManagedWorkerRegistry(db);
  try {
    const reserved = a.reserve(home, "family-a");
    assert.equal(reserved.state, "reserved");
    assert.equal(reserved.revision, 0);
    assert.throws(() => b.reserve(path.join(home, "."), "family-a"), /active/i);
    if (process.platform === "win32") assert.throws(() => b.reserve(home.toUpperCase(), "family-a"), /active/i);
    assert.equal(b.get(home, "family-a")?.epoch, reserved.epoch);
    assert.equal(b.get(home, "family-a")?.revision, 0);
    assert.equal(a.journalMode(), "wal");
    assert.equal(a.synchronousMode(), 2);
    assert.equal(a.reserve(home, "family-b").state, "reserved");
  } finally { a.close(); b.close(); }
  const reopened = new ManagedWorkerRegistry(db);
  try { assert.equal(reopened.get(home, "family-a")?.state, "reserved"); }
  finally { reopened.close(); }
});

test("identity and revision fence every state transition", () => {
  const { db, home } = fixture();
  const registry = new ManagedWorkerRegistry(db);
  try {
    const reserved = registry.reserve(home, "family-a");
    const registeredHost = registry.registerHost(reserved, host);
    assert.throws(() => registry.registerHost(reserved, host), /stale/i);
    assert.throws(() => registry.registerBackend(registeredHost, { ...host, birthTicks: "9" }, backend), /identity|birth/i);
    const registeredBackend = registry.registerBackend(registeredHost, host, backend);
    assert.equal(registeredBackend.state, "backend_registered");
    const endpointRef = randomUUID();
    assert.throws(() => registry.markReady(registeredHost, host, backend, endpointRef), /stale/i);
    assert.throws(() => registry.markReady(registeredBackend, { ...host, birthTicks: "8" }, backend, endpointRef), /identity|birth/i);
    assert.throws(() => registry.markReady(registeredBackend, host, backend, "token-or-path"), /endpoint/i);
    const ready = registry.markReady(registeredBackend, host, backend, endpointRef);
    assert.equal(ready.endpointRef, endpointRef);
    assert.equal(ready.revision, 3);
    assert.throws(() => registry.markLost(ready, host, { ...backend, generation: 8 }, "backend_unavailable"), /identity|generation/i);
    assert.throws(() => registry.markLost(ready, host, backend, "frontend_unavailable" as "backend_unavailable"), /reason/i);
    const lost = registry.markLost(ready, host, backend, "backend_unavailable");
    assert.equal(lost.state, "lost");
    assert.throws(() => registry.reserve(home, "family-a"), /active/i);
    assert.throws(() => registry.retire(ready, host, backend, evidence), /stale/i);
    assert.equal(registry.retire(lost, host, backend, evidence).state, "retired");
    const fresh = registry.reserve(home, "family-a");
    assert.notEqual(fresh.epoch, reserved.epoch);
    assert.throws(() => registry.registerHost(reserved, host), /stale/i);
    assert.equal(registry.get(home, "family-a")?.epoch, fresh.epoch);
    assert.equal(registry.history(home, "family-a").length, 2);
  } finally { registry.close(); }
});

test("retirement requires both registered identities and explicit matching cleanup evidence", () => {
  const { db, home } = fixture();
  const registry = new ManagedWorkerRegistry(db);
  try {
    const reserved = registry.reserve(home, "family-a");
    assert.throws(() => registry.retire(reserved, host, backend, evidence), /state|registered/i);
    const registeredHost = registry.registerHost(reserved, host);
    assert.throws(() => registry.retire(registeredHost, host, backend, evidence), /state|registered/i);
    const registeredBackend = registry.registerBackend(registeredHost, host, backend);
    assert.throws(() => registry.retire(registeredBackend, host, backend, { ...evidence, backend: { ...evidence.backend, birthTicks: "1" } }), /evidence|identity/i);
    assert.throws(() => registry.retire(registeredBackend, host, backend, { ...evidence, host: { ...evidence.host, observation: "unknown" as "absent" } }), /evidence|observation/i);
    assert.equal(registry.get(home, "family-a")?.state, "backend_registered");
    const retired = registry.retire(registeredBackend, host, backend, evidence);
    assert.equal(retired.state, "retired");
    assert.equal(registry.history(home, "family-a")[0]?.cleanupEvidence?.backend.observation, "reused");
  } finally { registry.close(); }
});

test("invalid paths and identities cannot create spawn permission", () => {
  const { db, home } = fixture();
  assert.throws(() => new ManagedWorkerRegistry("relative.sqlite"), /absolute/i);
  const registry = new ManagedWorkerRegistry(db);
  try {
    assert.throws(() => registry.reserve(path.join(home, "missing"), "family-a"));
    assert.throws(() => registry.reserve(home, "\nsecret"), /family/i);
    const reserved = registry.reserve(home, "family-a");
    assert.throws(() => registry.registerHost(reserved, { ...host, birthTicks: "not-ticks" }), /birth/i);
    assert.throws(() => registry.registerHost(reserved, { ...host, birthTicks: "0" }), /birth/i);
    assert.throws(() => registry.registerHost(reserved, { ...host, birthTicks: "01" }), /birth/i);
    assert.equal(registry.get(home, "family-a")?.state, "reserved");
  } finally { registry.close(); }
});
