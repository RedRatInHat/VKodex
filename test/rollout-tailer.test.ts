import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RolloutTailer } from "../src/desktop/rollout-tailer.js";

const task = (rolloutPath: string) => ({ hostId: "local", threadId: "thread", rolloutPath });
const line = (timestamp: string, item: unknown) => JSON.stringify({ timestamp, type: "response_item", payload: item }) + "\n";
const message = (id: string, turnId: string, phase: string, text: string) => ({ type: "message", id, role: "assistant", phase,
  content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } });

test("rollout tailer ignores old history and incrementally reads new visible assistant messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rollout-")); const rollout = path.join(root, "rollout.jsonl");
  await writeFile(rollout, line("2026-09-01T10:00:00.000Z", message("old", "old-turn", "final_answer", "old result")));
  const tailer = new RolloutTailer(1024, 1024);
  assert.deepEqual(await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), []);
  await appendFile(rollout, line("2026-09-03T10:00:00.000Z", message("progress", "turn", "commentary", "working")));
  await appendFile(rollout, line("2026-09-03T10:01:00.000Z", message("final", "turn", "final_answer", "done")));
  assert.deepEqual(await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), [
    { type: "progress", id: "progress", turnId: "turn", text: "working" },
    { type: "final", id: "final", turnId: "turn", text: "done" },
  ]);
  assert.deepEqual(await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), []);
});

test("rollout tailer expands beyond its initial tail window to recover older missed events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rollout-")); const rollout = path.join(root, "rollout.jsonl");
  await writeFile(rollout,
    line("2026-09-01T10:00:00.000Z", message("old", "old-turn", "final_answer", "Old answer".repeat(40)))
    + line("2026-09-03T10:00:00.000Z", message("missed", "missed-turn", "final_answer", "Missed answer"))
    + line("2026-09-03T10:01:00.000Z", message("recent", "recent-turn", "final_answer", "Recent answer")));
  const tailer = new RolloutTailer(250, 4096);
  assert.deepEqual(await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), [
    { type: "final", id: "missed", turnId: "missed-turn", text: "Missed answer" },
    { type: "final", id: "recent", turnId: "recent-turn", text: "Recent answer" },
  ]);
  assert.deepEqual(await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), []);
});

test("rollout tailer begins at a complete record when its lookback starts mid-line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rollout-")); const rollout = path.join(root, "rollout.jsonl");
  const first = line("2026-09-01T10:00:00.000Z", message("first", "old-turn", "final_answer", "Old".repeat(100)));
  const second = line("2026-09-02T10:00:00.000Z", message("second", "old-turn", "final_answer", "Still old"));
  const recent = line("2026-09-03T10:00:00.000Z", message("recent", "new-turn", "final_answer", "New answer"));
  await writeFile(rollout, first + second + recent);
  const tailer = new RolloutTailer(Buffer.byteLength(second + recent) + Math.floor(Buffer.byteLength(first) / 2), 4096);
  assert.deepEqual(await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), [
    { type: "final", id: "recent", turnId: "new-turn", text: "New answer" },
  ]);
});
