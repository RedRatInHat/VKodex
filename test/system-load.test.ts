import assert from "node:assert/strict";
import test from "node:test";
import { cpuPercent, formatSystemLoad } from "../src/bridge/system-load.js";

test("CPU sampling uses deltas and rejects an empty interval", () => {
  assert.equal(cpuPercent({ idle: 1_000, total: 2_000 }, { idle: 1_250, total: 3_000 }), 75);
  assert.equal(cpuPercent({ idle: 1_000, total: 2_000 }, { idle: 1_000, total: 2_000 }), null);
});

test("PC load report contains bounded operational metrics without local paths", () => {
  const gib = 1024 ** 3;
  const text = formatSystemLoad({
    sampledAt: 1_788_200_000_000,
    cpuPercent: 25,
    logicalCpuCount: 16,
    memoryUsedBytes: 8 * gib,
    memoryTotalBytes: 32 * gib,
    disk: { root: "D:\\", availableBytes: 100 * gib, totalBytes: 200 * gib },
    uptimeSeconds: 90_061,
    processCpuPercent: 0.5,
    processRssBytes: 150 * 1024 ** 2,
    processId: 42,
  });
  assert.match(text, /^Нагрузка ПК[\s\S]*CPU: 25\.0% · логических процессоров: 16/u);
  assert.match(text, /RAM: 8\.0 ГБ из 32\.0 ГБ · 25\.0%/u);
  assert.match(text, /Диск D:\\ доступно 100\.0 ГБ из 200\.0 ГБ · занято 50\.0%/u);
  assert.match(text, /ОС работает: 1 дн\. 1 ч\. 1 мин\./u);
  assert.match(text, /VKodex: CPU 0\.5% · RAM 150 МБ · PID 42$/u);
  assert.doesNotMatch(text, /GitStorage|Users|token/ui);
});
