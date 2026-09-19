import assert from "node:assert/strict";
import test from "node:test";
import { isAutomationHeartbeatInput, visibleAutomationHeartbeatOutput } from "../src/core/automation-heartbeat.js";

const input = `<heartbeat>
  <automation_id>monitor</automation_id>
  <current_time_iso>2026-09-19T17:00:00Z</current_time_iso>
  <instructions>Check the state.</instructions>
</heartbeat>`;

test("recognizes only strict scheduler heartbeat inputs", () => {
  assert.equal(isAutomationHeartbeatInput(input), true);
  assert.equal(isAutomationHeartbeatInput(`User quoted this:\n${input}`), false);
  assert.equal(isAutomationHeartbeatInput("<heartbeat><automation_id>x</automation_id></heartbeat>"), false);
});

test("suppresses quiet heartbeat results and unwraps notifications", () => {
  assert.equal(visibleAutomationHeartbeatOutput(`<heartbeat>
    <automation_id>monitor</automation_id>
    <decision>DONT_NOTIFY</decision>
    <message>No action is needed.</message>
  </heartbeat>`), null);
  assert.equal(visibleAutomationHeartbeatOutput(`<heartbeat>
    <automation_id>monitor</automation_id>
    <decision>NOTIFY</decision>
    <message>Action is required.</message>
  </heartbeat>`), "Action is required.");
  assert.equal(visibleAutomationHeartbeatOutput(`Detailed result.\n\n<heartbeat>
    <automation_id>monitor</automation_id>
    <decision>NOTIFY</decision>
    <message>Short duplicate.</message>
  </heartbeat>`), "Detailed result.");
});

test("preserves malformed or user-authored XML instead of losing content", () => {
  const malformed = "<heartbeat><decision>DONT_NOTIFY</decision><message>Missing id</message></heartbeat>";
  assert.equal(visibleAutomationHeartbeatOutput(malformed), malformed);
  assert.equal(visibleAutomationHeartbeatOutput("Ordinary response"), "Ordinary response");
});
