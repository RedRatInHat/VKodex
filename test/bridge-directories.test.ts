import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareBridgeTurnDirectories } from "../src/lib/files.js";
import { downloadVkFile, FILE_LIMITS, readOutputFiles, validateVkFileUrl } from "../src/bridge/files.js";

test("bridge turn directories are created inside the workspace and ignored by Git", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vkodex-workspace-"));
  const directories = await prepareBridgeTurnDirectories(workspace, "turn-1");

  assert.equal(path.dirname(path.dirname(directories.inboxDir)), directories.baseDir);
  assert.equal(path.dirname(path.dirname(directories.outboxDir)), directories.baseDir);
  assert.equal(await readFile(path.join(directories.baseDir, ".gitignore"), "utf8"), "*\n");
});

test("bridge rejects a symlinked service directory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vkodex-workspace-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "vkodex-outside-"));
  await symlink(outside, path.join(workspace, ".vkcodex"));

  await assert.rejects(
    prepareBridgeTurnDirectories(workspace, "turn-1"),
    /Небезопасный служебный каталог/u,
  );
});

test("VK attachment downloads allow only HTTPS VK hosts and validate every redirect", async t => {
  assert.equal(validateVkFileUrl("https://sun1.userapi.com/file").hostname, "sun1.userapi.com");
  for (const url of ["http://sun1.userapi.com/file", "https://userapi.com.example.com/file", "https://127.0.0.1/file", "https://name:secret@vk.com/file", "https://vk.com:8080/file"]) assert.throws(() => validateVkFileUrl(url));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); });
  await assert.rejects(downloadVkFile("https://sun1.userapi.com/file", 100), /сервер/u); assert.equal(calls, 1);
});

test("VK file download bounds streamed bytes and hides raw network exceptions", async t => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("payload"));
  assert.equal((await downloadVkFile("https://sun1.userapi.com/file", 7)).toString(), "payload");
  await assert.rejects(downloadVkFile("https://sun1.userapi.com/file", 6), /лимит/u);
  mock.mock.mockImplementation(async () => { throw new Error("PRIVATE_SIGNED_URL"); });
  await assert.rejects(downloadVkFile("https://sun1.userapi.com/file", 100), error => error instanceof Error && !error.message.includes("PRIVATE_SIGNED_URL"));
});

test("output file snapshots preserve bytes and reject oversized files, symlinks and hard links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-"));
  await mkdir(path.join(root, "nested")); await writeFile(path.join(root, "nested", "answer.txt"), "answer"); await writeFile(path.join(root, ".secret"), "not an artifact");
  const files = await readOutputFiles(root);
  assert.deepEqual(files.map(file => [file.name, file.contents.toString()]), [["nested_answer.txt", "answer"]]);
  await assert.rejects(readOutputFiles(root, { ...FILE_LIMITS, maxFileBytes: 3 }), /лимит/u);
  const outside = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-")); await writeFile(path.join(outside, "source.txt"), "private");
  await link(path.join(outside, "source.txt"), path.join(root, "linked.txt"));
  await assert.rejects(readOutputFiles(root), /Ссылки/u);
  const other = await mkdtemp(path.join(os.tmpdir(), "vkodex-file-test-")); await symlink(outside, path.join(other, "linked"));
  await assert.rejects(readOutputFiles(other), /Ссылки/u);
});
