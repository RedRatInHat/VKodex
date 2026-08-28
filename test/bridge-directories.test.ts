import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareBridgeTurnDirectories } from "../src/lib/files.js";

test("bridge turn directories are created inside the workspace and ignored by Git", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vk-codex-workspace-"));
  const directories = await prepareBridgeTurnDirectories(workspace, "turn-1");

  assert.equal(path.dirname(path.dirname(directories.inboxDir)), directories.baseDir);
  assert.equal(path.dirname(path.dirname(directories.outboxDir)), directories.baseDir);
  assert.equal(await readFile(path.join(directories.baseDir, ".gitignore"), "utf8"), "*\n");
});

test("bridge rejects a symlinked service directory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vk-codex-workspace-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "vk-codex-outside-"));
  await symlink(outside, path.join(workspace, ".vkcodex"));

  await assert.rejects(
    prepareBridgeTurnDirectories(workspace, "turn-1"),
    /Небезопасный служебный каталог/u,
  );
});