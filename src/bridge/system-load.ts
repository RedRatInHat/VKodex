import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

interface CpuCounter { readonly idle: number; readonly total: number }

export interface SystemLoadSnapshot {
  readonly sampledAt: number;
  readonly cpuPercent: number | null;
  readonly logicalCpuCount: number;
  readonly memoryUsedBytes: number;
  readonly memoryTotalBytes: number;
  readonly disk: { readonly root: string; readonly availableBytes: number; readonly totalBytes: number } | null;
  readonly uptimeSeconds: number;
  readonly processCpuPercent: number | null;
  readonly processRssBytes: number;
  readonly processId: number;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

function cpuCounter(): CpuCounter {
  return os.cpus().reduce<CpuCounter>((sum, cpu) => ({
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((total, value) => total + value, 0),
  }), { idle: 0, total: 0 });
}

export function cpuPercent(before: CpuCounter, after: CpuCounter): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  return total > 0 && idle >= 0 ? clampPercent((1 - idle / total) * 100) : null;
}

export async function captureSystemLoad(diskPath = process.cwd(), sampleMs = 500): Promise<SystemLoadSnapshot> {
  const logicalCpuCount = Math.max(1, os.cpus().length);
  const cpuBefore = cpuCounter();
  const processBefore = process.cpuUsage();
  const started = process.hrtime.bigint();
  await wait(sampleMs);
  const elapsedMs = Math.max(1, Number(process.hrtime.bigint() - started) / 1_000_000);
  const processDelta = process.cpuUsage(processBefore);
  const processCpuPercent = clampPercent((processDelta.user + processDelta.system) / 1_000 / elapsedMs / logicalCpuCount * 100);
  const memoryTotalBytes = os.totalmem();
  let disk: SystemLoadSnapshot["disk"] = null;
  try {
    const value = await statfs(diskPath, { bigint: true });
    disk = {
      root: path.parse(path.resolve(diskPath)).root,
      availableBytes: Number(value.bavail * value.bsize),
      totalBytes: Number(value.blocks * value.bsize),
    };
  } catch { /* CPU and memory remain useful if the volume cannot be read. */ }
  return {
    sampledAt: Date.now(),
    cpuPercent: cpuPercent(cpuBefore, cpuCounter()),
    logicalCpuCount,
    memoryUsedBytes: Math.max(0, memoryTotalBytes - os.freemem()),
    memoryTotalBytes,
    disk,
    uptimeSeconds: os.uptime(),
    processCpuPercent,
    processRssBytes: process.memoryUsage().rss,
    processId: process.pid,
  };
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
const mib = (bytes: number): string => `${Math.round(bytes / 1024 ** 2).toLocaleString("ru-RU")} МБ`;
const percent = (value: number): string => `${clampPercent(value).toFixed(1)}%`;
const elapsed = (seconds: number): string => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return [days ? `${days} дн.` : "", hours ? `${hours} ч.` : "", `${minutes} мин.`].filter(Boolean).join(" ");
};

export function formatSystemLoad(snapshot: SystemLoadSnapshot): string {
  const memoryPercent = snapshot.memoryTotalBytes > 0 ? snapshot.memoryUsedBytes / snapshot.memoryTotalBytes * 100 : 0;
  const lines = [
    "Нагрузка ПК",
    `Снято: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(new Date(snapshot.sampledAt))}`,
    "",
    `CPU: ${snapshot.cpuPercent === null ? "нет данных" : percent(snapshot.cpuPercent)} · логических процессоров: ${snapshot.logicalCpuCount}`,
    `RAM: ${gib(snapshot.memoryUsedBytes)} из ${gib(snapshot.memoryTotalBytes)} · ${percent(memoryPercent)}`,
  ];
  if (snapshot.disk && snapshot.disk.totalBytes > 0) {
    const usedPercent = (1 - snapshot.disk.availableBytes / snapshot.disk.totalBytes) * 100;
    lines.push(`Диск ${snapshot.disk.root} доступно ${gib(snapshot.disk.availableBytes)} из ${gib(snapshot.disk.totalBytes)} · занято ${percent(usedPercent)}`);
  } else lines.push("Диск: данные недоступны");
  lines.push(
    `ОС работает: ${elapsed(snapshot.uptimeSeconds)}`,
    "",
    `VKodex: CPU ${snapshot.processCpuPercent === null ? "нет данных" : percent(snapshot.processCpuPercent)} · RAM ${mib(snapshot.processRssBytes)} · PID ${snapshot.processId}`,
  );
  return lines.join("\n");
}

export async function systemLoadText(diskPath?: string): Promise<string> {
  return formatSystemLoad(await captureSystemLoad(diskPath));
}
