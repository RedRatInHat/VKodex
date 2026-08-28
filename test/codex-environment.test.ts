import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexEnvironment } from "../src/agents/codex/codex-environment.js";

test("Codex environment excludes bridge secrets and allows explicit variables", () => {
  const environment = buildCodexEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/home/bot",
      VK_GROUP_TOKEN: "vk-secret",
      OPENAI_API_KEY: "openai-secret",
      CODEX_API_KEY: "codex-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GITHUB_TOKEN: "explicit-secret",
    },
    ["SSH_AUTH_SOCK", "GITHUB_TOKEN", "VK_GROUP_TOKEN"],
  );

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/home/bot",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GITHUB_TOKEN: "explicit-secret",
  });
});
