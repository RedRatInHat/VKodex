import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RolloutRecordTooLargeError, RolloutTailer } from "../src/desktop/rollout-tailer.js";

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

test("rollout recovery suppresses quiet heartbeats and unwraps notifications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rollout-")); const rollout = path.join(root, "rollout.jsonl");
  const quiet = "<heartbeat><automation_id>monitor</automation_id><decision>DONT_NOTIFY</decision><message>Quiet.</message></heartbeat>";
  const notify = "<heartbeat><automation_id>monitor</automation_id><decision>NOTIFY</decision><message>Needs attention.</message></heartbeat>";
  await writeFile(rollout,
    line("2026-09-03T09:59:00.000Z", { type: "message", role: "user",
      content: [{ type: "input_text", text: "<heartbeat><automation_id>monitor</automation_id><current_time_iso>2026-09-03T09:59:00Z</current_time_iso><instructions>Check.</instructions></heartbeat>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "quiet-turn" } })
    + line("2026-09-03T09:59:30.000Z", message("quiet-progress", "quiet-turn", "commentary", "Private scheduler progress"))
    + line("2026-09-03T10:00:00.000Z", message("quiet", "quiet-turn", "final_answer", quiet))
    + line("2026-09-03T10:01:00.000Z", message("notify", "notify-turn", "final_answer", notify)));
  const tailer = new RolloutTailer(4096, 4096);
  assert.deepEqual(await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), [
    { type: "final", id: "notify", turnId: "notify-turn", text: "Needs attention.", showMenu: false },
  ]);
  assert.deepEqual(tailer.quietTurnIds(task(rollout)), ["quiet-turn"]);
  // A restarted reader can inherit explicit visibility policy when the input
  // is no longer inside its read window.
  await writeFile(rollout, line("2026-09-03T10:02:00.000Z", message("late-quiet", "quiet-turn", "commentary", "Still quiet")));
  assert.deepEqual(await new RolloutTailer().poll(task(rollout), 0, ["quiet-turn"]), []);
  // An empty read must not erase policy learned by the primary transport.
  assert.deepEqual(await tailer.poll(task(rollout), 0, ["another-quiet-turn"]), []);
  assert.deepEqual(await tailer.poll(task(rollout), 0, ["new-quiet-turn"]), []);
  assert.ok(tailer.quietTurnIds(task(rollout)).includes("new-quiet-turn"));
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

test("rollout tailer advances through one visible record larger than a read block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rollout-")); const rollout = path.join(root, "rollout.jsonl");
  const answer = "Recovered ".repeat(70);
  await writeFile(rollout, line("2026-09-03T10:00:00.000Z", message("large", "turn", "final_answer", answer)));
  const tailer = new RolloutTailer(128, 128, 2048);
  const events = [];
  for (let attempt = 0; attempt < 12; attempt++) events.push(...await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")));
  assert.deepEqual(events, [{ type: "final", id: "large", turnId: "turn", text: answer }]);
});

test("oversized rollout records fail explicitly instead of leaving the recovery cursor stuck", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rollout-")); const rollout = path.join(root, "rollout.jsonl");
  await writeFile(rollout, line("2026-09-03T10:00:00.000Z", message("too-large", "turn", "final_answer", "x".repeat(1024))));
  const tailer = new RolloutTailer(128, 128, 256);
  await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z"));
  await tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z"));
  await assert.rejects(tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), RolloutRecordTooLargeError);
  await assert.rejects(tailer.poll(task(rollout), Date.parse("2026-09-03T00:00:00.000Z")), RolloutRecordTooLargeError);
});

test("clearing a task during a pending read prevents its old cursor and quiet policy from returning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-rollout-")); const rollout = path.join(root, "rollout.jsonl");
  await writeFile(rollout,
    line("2026-09-03T09:59:00.000Z", { type: "message", role: "user",
      content: [{ type: "input_text", text: "<heartbeat><automation_id>monitor</automation_id><current_time_iso>2026-09-03T09:59:00Z</current_time_iso><instructions>Check.</instructions></heartbeat>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "quiet-turn" } })
    + line("2026-09-03T10:00:00.000Z", message("final", "visible-turn", "final_answer", "Visible answer")));
  const tailer = new RolloutTailer();
  const delayed = tailer as unknown as { initialOffset(path: string, size: number, since: number): Promise<number> };
  const original = delayed.initialOffset.bind(tailer);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  delayed.initialOffset = async (...args) => { entered(); await blocked; return original(...args); };
  const ref = task(rollout);
  const oldPoll = tailer.poll(ref, 0);
  await started;
  tailer.clear(ref);
  release();
  assert.deepEqual(await oldPoll, []);
  assert.deepEqual(tailer.quietTurnIds(ref), []);
  assert.deepEqual(await tailer.poll(ref, 0), [
    { type: "final", id: "final", turnId: "visible-turn", text: "Visible answer" },
  ]);
  assert.deepEqual(tailer.quietTurnIds(ref), ["quiet-turn"]);
});
