import test from "node:test";
import assert from "node:assert/strict";
import { DotBrowserConnectionGate } from "../src/dot-browser/connection-gate.js";

const binding = { roomId: "a".repeat(32), pageUrl: "https://chatgpt.com/dots/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", generation: 1 };
const observation = { ...binding, qualified: true };
function ready() {
  const gate = new DotBrowserConnectionGate(binding, 100);
  gate.setEnabled(true);
  const lease = gate.connect(0)!;
  assert.equal(gate.qualify(lease, observation, 1), true);
  return { gate, lease };
}
test("disabled and unqualified connections cannot dispatch", () => {
  const gate = new DotBrowserConnectionGate(binding);
  assert.equal(gate.connect(0), null);
  assert.equal(gate.availability(0), "disabled");
  gate.setEnabled(true);
  const lease = gate.connect(1)!;
  assert.equal(gate.availability(1), "qualifying");
  assert.equal(gate.canDispatch(lease, 1), false);
  assert.equal(gate.qualify(lease, observation, 2), true);
  assert.equal(gate.canDispatch(lease, 2), true);
});
test("duplicate connection cannot replace the current writer", () => {
  const { gate, lease } = ready();
  assert.equal(gate.connect(2), null);
  assert.equal(gate.canDispatch(lease, 2), true);
});
test("disconnect invalidates old receipts; stale disconnect cannot close new connection", () => {
  const { gate, lease } = ready(); gate.disconnect(lease);
  assert.equal(gate.availability(2), "disconnected");
  const next = gate.connect(3)!;
  assert.notEqual(next.epoch, lease.epoch);
  assert.equal(gate.qualify(lease, observation, 4), false);
  gate.disconnect(lease);
  assert.equal(gate.qualify(next, observation, 4), true);
  assert.equal(gate.canDispatch(next, 4), true);
});
test("expiry forbids dispatch but fresh matching readiness requalifies the same port", () => {
  const { gate, lease } = ready();
  assert.equal(gate.canDispatch(lease, 100), true);
  assert.equal(gate.canDispatch(lease, 101), false);
  assert.equal(gate.availability(101), "qualifying");
  assert.equal(gate.connect(101), null);
  assert.equal(gate.canDispatch(lease, 200), false);
  assert.equal(gate.qualify(lease, observation, 201), true);
  assert.equal(gate.canDispatch(lease, 201), true);
});

test("an unqualified port remains unqualified beyond freshness without a new epoch", () => {
  const gate = new DotBrowserConnectionGate(binding, 100);
  gate.setEnabled(true); const lease = gate.connect(0)!;
  assert.equal(gate.availability(1000), "qualifying");
  assert.equal(gate.canDispatch(lease, 1000), false);
  assert.equal(gate.connect(1000), null);
  assert.equal(gate.qualify(lease, observation, 1001), true);
});

test("expired qualification cannot revive an epoch that was explicitly disconnected", () => {
  const { gate, lease } = ready();
  assert.equal(gate.canDispatch(lease, 101), false);
  gate.disconnect(lease); const next = gate.connect(102)!;
  assert.equal(gate.qualify(lease, observation, 103), false);
  assert.equal(gate.canDispatch(lease, 103), false);
  assert.equal(gate.qualify(next, observation, 103), true);
});
test("disable/re-enable needs a new qualified lease", () => {
  const { gate, lease } = ready(); gate.setEnabled(false); gate.setEnabled(true);
  assert.equal(gate.canDispatch(lease, 2), false);
  assert.equal(gate.availability(2), "disconnected");
});
test("navigation, login or wrong-room observations invalidate the connection", () => {
  for (const patch of [{ qualified: false }, { roomId: "b".repeat(32) }, { pageUrl: "https://chatgpt.com/auth/login" }]) {
    const { gate, lease } = ready();
    assert.equal(gate.qualify(lease, { ...observation, ...patch }, 2), false);
    assert.equal(gate.canDispatch(lease, 3), false);
  }
});
test("foreign generations cannot dispatch or invalidate the current lease", () => {
  const { gate, lease } = ready(), wrong = { ...lease, generation: 2 };
  assert.equal(gate.qualify(wrong, observation, 2), false);
  gate.disconnect(wrong);
  assert.equal(gate.canDispatch(wrong, 2), false);
  assert.equal(gate.canDispatch(lease, 2), true);
});
test("clock rollback and invalid clocks invalidate readiness", () => {
  for (const now of [0, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const { gate, lease } = ready();
    assert.throws(() => gate.canDispatch(lease, now));
    assert.equal(gate.canDispatch(lease, 2), false);
  }
});
test("caller mutation cannot silently rebind room or generation", () => {
  const mutable = { ...binding }, gate = new DotBrowserConnectionGate(mutable);
  mutable.roomId = "b".repeat(32); mutable.generation = 2;
  gate.setEnabled(true); const lease = gate.connect(0)!;
  assert.equal(lease.generation, 1);
  assert.equal(gate.qualify(lease, observation, 1), true);
});
test("unsafe page bindings and freshness bounds are rejected", () => {
  for (const pageUrl of ["http://chatgpt.com/dots/a", "https://evil.example/dots/a", binding.pageUrl + "?x=1", binding.pageUrl + "#x"])
    assert.throws(() => new DotBrowserConnectionGate({ ...binding, pageUrl }));
  for (const freshness of [0, -1, 60_001, NaN]) assert.throws(() => new DotBrowserConnectionGate(binding, freshness));
});
test("fresh qualified observations renew freshness without replacing the lease", () => {
  const { gate, lease } = ready();
  assert.equal(gate.qualify(lease, observation, 90), true);
  assert.equal(gate.canDispatch(lease, 101), true);
  assert.equal(gate.canDispatch(lease, 190), false);
});
test("restarting the host never restores an old connection from a lease", () => {
  const { lease } = ready(), replacement = new DotBrowserConnectionGate(binding);
  replacement.setEnabled(true);
  assert.equal(replacement.qualify(lease, observation, 2), false);
  assert.equal(replacement.canDispatch(lease, 2), false);
  assert.equal(replacement.availability(2), "disconnected");
});
test("disconnect during async preparation invalidates the second dispatch check", async () => {
  const { gate, lease } = ready();
  assert.equal(gate.canDispatch(lease, 2), true);
  await Promise.resolve();
  gate.disconnect(lease);
  assert.equal(gate.canDispatch(lease, 3), false);
});
