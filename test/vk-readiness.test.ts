import assert from "node:assert/strict";
import test from "node:test";
import { checkVkReadiness, type VkReadinessApi } from "../src/platforms/vk/readiness.js";

function fixture(): VkReadinessApi {
  return {
    tokenPermissions: async () => ({ permissions: [{ name: "messages", setting: 1 }] }),
    longPollSettings: async () => ({ is_enabled: true, api_version: "5.199", events: { message_new: true, message_event: true } }),
    longPollServer: async () => ({ key: "secret-poll-key-fixture", server: "https://example.invalid/private-endpoint", ts: "1" }),
  };
}

test("VK readiness verifies messages and both Long Poll event types without exposing server credentials", async () => {
  const checks = await checkVkReadiness(fixture());
  assert.equal(checks.length, 6); assert.ok(checks.every(check => check.ok));
  assert.doesNotMatch(JSON.stringify(checks), /secret-poll-key-fixture|private-endpoint/u);
});

test("disabled callback events and mismatched event versions are reported", async () => {
  const checks = await checkVkReadiness({ ...fixture(), longPollSettings: async () => ({ is_enabled: 1, api_version: "different", events: { message_new: 1, message_event: 0 } }) });
  assert.equal(checks.find(check => check.name === "message_new")!.ok, true);
  assert.equal(checks.find(check => check.name === "message_event")!.ok, false);
  assert.equal(checks.find(check => check.name === "event_version")!.ok, false);
});

test("API exceptions expose only numeric codes, never tokens, owner IDs, or raw errors", async () => {
  const secret = "private-credential-fixture";
  const error = Object.assign(new Error(secret), { code: 5, request_params: { access_token: secret, owner_id: "private-owner-fixture" } });
  const checks = await checkVkReadiness({ ...fixture(), tokenPermissions: async () => { throw error; }, longPollServer: async () => { throw error; } });
  assert.match(JSON.stringify(checks), /код 5/u);
  assert.doesNotMatch(JSON.stringify(checks), /private-credential-fixture|private-owner-fixture|request_params/u);
});

test("malformed VK responses cannot produce a successful readiness report", async () => {
  const checks = await checkVkReadiness({ tokenPermissions: async () => null, longPollSettings: async () => [], longPollServer: async () => ({ server: "url" }) });
  assert.ok(checks.every(check => !check.ok));
});
