import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiagnosticLog } from "../src/desktop/diagnostic-log.js";
import { diagnosticId, type DiagnosticRecord } from "../src/bridge/diagnostics.js";
import { diagnosticReport } from "../src/desktop/diagnostic-report.js";

const record = (seq: number, extra: Partial<DiagnosticRecord> = {}): DiagnosticRecord => ({
  schema: "vkodex.diagnostic.v1",
  runId: "12345678-1234-1234-1234-123456789abc",
  pid: process.pid,
  seq,
  at: new Date(0).toISOString(),
  event: "input.received",
  ...extra,
});

test("diagnostic log writes parseable JSONL and flushes all accepted records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-diagnostic-jsonl-"));
  const log = await createDiagnosticLog(directory);
  await Promise.all([log.write(record(1)), log.write(record(2, { attemptId: "abc" }))]);
  await log.flush();

  const contents = await readFile(path.join(directory, "trace-000.jsonl"), "utf8");
  const lines = contents.trimEnd().split("\n").map((line) => JSON.parse(line) as DiagnosticRecord);
  assert.deepEqual(lines.map((line) => line.seq), [1, 2]);
  assert.equal(log.status().state, "ready");
  assert.equal(log.status().written, 2);
});

test("concurrent diagnostic logs reserve distinct segments and never append to old runs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-diagnostic-concurrent-"));
  const oldSegment = path.join(directory, "trace-000.jsonl");
  await writeFile(oldSegment, "older run\n");
  const [first, second] = await Promise.all([
    createDiagnosticLog(directory),
    createDiagnosticLog(directory),
  ]);
  await Promise.all([first.write(record(1)), second.write(record(2))]);
  await Promise.all([first.flush(), second.flush()]);

  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  assert.deepEqual(names, ["trace-000.jsonl", "trace-001.jsonl", "trace-002.jsonl"]);
  assert.equal(await readFile(oldSegment, "utf8"), "older run\n");
  const rows = await Promise.all(names.slice(1).map(async (name) =>
    (await readFile(path.join(directory, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as DiagnosticRecord)));
  assert.deepEqual(rows.flat().map((item) => item.seq).sort(), [1, 2]);
});

test("diagnostic report filters bounded segments and re-sanitizes edited records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-diagnostic-report-"));
  const threadId = "10000000-0000-0000-0000-000000000001";
  const rows = [1, 2, 3].map(seq => record(seq, { runId: "10000000-0000-0000-0000-000000000002", threadId,
    ...({ text: "secret must not leave report", params: { secret: "also private" } } as object) }));
  await writeFile(path.join(directory, "trace-000.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n{partial\n");
  const report = await diagnosticReport(directory, { threadId, limit: 2 });
  assert.equal(report.readOnly, true);
  assert.equal(report.matched, 3);
  assert.equal(report.truncated, true);
  assert.equal(report.invalidRecords, 1);
  assert.deepEqual(report.records.map(row => row.seq), [2, 3]);
  assert.equal(JSON.stringify(report).includes("secret must not leave report"), false);
  assert.equal(JSON.stringify(report).includes("also private"), false);
  assert.deepEqual((await diagnosticReport(directory, { attemptId: "nonexistent" })).records, []);
  await assert.rejects(diagnosticReport(directory, { limit: 2001 }), TypeError);
  const hashed = record(4, { runId: rows[0]!.runId, threadId: diagnosticId("non-UUID thread"),
    eventId: diagnosticId("batched event") });
  await writeFile(path.join(directory, "trace-001.jsonl"), JSON.stringify(hashed) + "\n");
  const roundtrip = await diagnosticReport(directory, { threadId: "non-UUID thread", eventId: "batched event" });
  assert.equal(roundtrip.records[0]?.threadId, hashed.threadId);
  assert.equal(roundtrip.records[0]?.eventId, hashed.eventId);
});

test("diagnostic log rotates only into a newly reserved segment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-diagnostic-rotate-"));
  const log = await createDiagnosticLog(directory);
  const payload = "x".repeat(3_800);
  for (let seq = 0; seq < 300; seq += 1) await log.write(record(seq, { event: payload }));
  await log.flush();

  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  assert.deepEqual(names, ["trace-000.jsonl", "trace-001.jsonl"]);
  const files = await Promise.all(names.map(async (name) => readFile(path.join(directory, name), "utf8")));
  assert.ok(files.every((contents) => Buffer.byteLength(contents, "utf8") <= 1024 * 1024));
  assert.equal(files.flatMap((contents) => contents.trimEnd().split("\n")).length, 300);
  assert.equal(log.status().written, 300);
});

test("diagnostic log bounds the async queue and drops oversized records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-diagnostic-queue-"));
  let releaseAppend!: () => void;
  let signalAppendStarted!: () => void;
  const appendStarted = new Promise<void>((resolve) => { signalAppendStarted = resolve; });
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const log = await createDiagnosticLog(directory, {
    appendFile: async (filePath, data, options) => {
      signalAppendStarted();
      await appendGate;
      await appendFile(filePath, data, options);
    },
  });

  const writes: Promise<void>[] = [Promise.resolve(log.write(record(0)))];
  await appendStarted;
  for (let seq = 1; seq < 600; seq += 1) writes.push(Promise.resolve(log.write(record(seq))));
  writes.push(Promise.resolve(log.write(record(600, { event: "x".repeat(5_000) }))));
  assert.equal(log.status().dropped, 89);
  releaseAppend();
  await Promise.all(writes);
  await log.flush();
  assert.equal(log.status().written, 512);
  assert.equal(log.status().dropped, 89);
});

test("diagnostic log reports full without changing existing segment bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vkodex-diagnostic-full-"));
  const segment = Buffer.alloc(1024 * 1024, 0x78);
  const hashes: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    const filePath = path.join(directory, `trace-${String(index).padStart(3, "0")}.jsonl`);
    await writeFile(filePath, segment);
    hashes.push(createHash("sha256").update(segment).digest("hex"));
  }

  const log = await createDiagnosticLog(directory);
  await log.write(record(1));
  await log.flush();
  assert.equal(log.status().state, "full");
  assert.equal(log.status().written, 0);
  assert.equal(log.status().dropped, 1);
  for (let index = 0; index < 16; index += 1) {
    const bytes = await readFile(path.join(directory, `trace-${String(index).padStart(3, "0")}.jsonl`));
    assert.equal(bytes.byteLength, 1024 * 1024);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hashes[index]);
  }
});

test("diagnostic log disables cleanly on initialization and append faults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vkodex-diagnostic-errors-"));
  const file = path.join(root, "not-a-directory");
  await writeFile(file, "occupied");
  const unavailable = await createDiagnosticLog(path.join(file, "nested"));
  await assert.doesNotReject(Promise.resolve(unavailable.write(record(1))));
  await unavailable.flush();
  assert.equal(unavailable.status().state, "disabled");

  const appendDirectory = path.join(root, "append-fault");
  await mkdir(appendDirectory);
  const broken = await createDiagnosticLog(appendDirectory, {
    appendFile: async () => { throw new Error("injected append fault"); },
  });
  await assert.doesNotReject(Promise.resolve(broken.write(record(1))));
  await broken.flush();
  assert.deepEqual(broken.status(), { state: "disabled", written: 0, dropped: 0, failed: 1 });
  assert.equal((await stat(path.join(appendDirectory, "trace-000.jsonl"))).size, 0);
});
