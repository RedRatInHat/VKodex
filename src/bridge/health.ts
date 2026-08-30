import { writeFile } from "node:fs/promises";
import type { DesktopCompatibility, DesktopTasks } from "../desktop/contracts.js";
import type { BridgeChat, BridgeHealthSnapshot, HealthCheckResult, HealthState, OwnerAccess } from "./contracts.js";
import { BridgeStore } from "./store.js";

export interface RuntimeHealthState {
  readonly startedAt: number;
  readonly lastTickAt: number;
  readonly updateStartedAt: number | null;
  readonly stopped: boolean;
  readonly activeBindings: number;
  readonly connectedBindings: number;
  readonly requiredBindings: number;
  readonly connectedRequiredBindings: number;
}

const severity: Record<HealthState, number> = { ok: 0, degraded: 1, failed: 2 };
const labels: Record<HealthState, string> = { ok: "OK", degraded: "DEGRADED", failed: "FAILED" };

function aggregate(checks: readonly HealthCheckResult[]): HealthState {
  return checks.reduce<HealthState>((state, check) => severity[check.state] > severity[state] ? check.state : state, "ok");
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("health check timeout")), timeoutMs);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function compatibilityCheck(value: DesktopCompatibility): HealthCheckResult {
  const state: HealthState = value.state === "ok" ? "ok" : value.state === "failed" ? "failed" : "degraded";
  return { name: "codex_live_api", state, detail: value.message };
}

export function formatHealthSummary(snapshot: BridgeHealthSnapshot): string {
  const lines = [
    `Health: ${labels[snapshot.state]}`,
    `Проверено: ${new Date(snapshot.checkedAt).toLocaleString("ru-RU")}`,
    `PID: ${snapshot.pid} · uptime: ${Math.round(snapshot.uptimeSeconds / 60).toLocaleString("ru-RU")} мин`,
    "",
    ...snapshot.checks.map(check => `[${labels[check.state]}] ${check.name}: ${check.detail}`),
  ];
  return lines.join("\n");
}

export class BridgeHealthMonitor {
  private checking: Promise<BridgeHealthSnapshot> | null = null;
  private lastCompatibilityAt = 0;
  private criticalPendingId: number | null = null;
  private criticalPendingSince: number | null = null;

  constructor(
    private readonly access: OwnerAccess,
    private readonly desktop: DesktopTasks,
    private readonly chat: BridgeChat,
    private readonly store: BridgeStore,
    private readonly runtime: () => RuntimeHealthState,
    private readonly healthFile?: string,
    private readonly now: () => number = Date.now,
    private readonly compatibilityIntervalMs = 10 * 60_000,
  ) {}

  check(force = false): Promise<BridgeHealthSnapshot> {
    if (this.checking) return this.checking;
    this.checking = this.run(force).finally(() => { this.checking = null; });
    return this.checking;
  }

  private async run(force: boolean): Promise<BridgeHealthSnapshot> {
    const checkedAt = this.now();
    const checks: HealthCheckResult[] = [];

    try {
      checks.push(this.store.quickCheck()
        ? { name: "sqlite", state: "ok", detail: "База состояния прошла PRAGMA quick_check." }
        : { name: "sqlite", state: "failed", detail: "SQLite не подтвердил целостность базы состояния." });
    } catch { checks.push({ name: "sqlite", state: "failed", detail: "База состояния недоступна для проверки." }); }

    const runtime = this.runtime();
    const tickAge = Math.max(0, checkedAt - runtime.lastTickAt);
    const updateAge = runtime.updateStartedAt === null ? 0 : Math.max(0, checkedAt - runtime.updateStartedAt);
    checks.push(runtime.stopped || tickAge > 10_000 || updateAge > 60_000
      ? { name: "runtime", state: "failed", detail: `Цикл моста не отвечает вовремя: tick ${Math.round(tickAge / 1_000)} с, update ${Math.round(updateAge / 1_000)} с.` }
      : updateAge > 15_000
        ? { name: "runtime", state: "degraded", detail: `Обновление выполняется уже ${Math.round(updateAge / 1_000)} с.` }
        : { name: "runtime", state: "ok", detail: `Цикл активен; последний tick ${Math.round(tickAge / 1_000)} с назад.` });

    const delivery = this.store.deliveryHealth(checkedAt);
    if (delivery.criticalPending === 0) {
      this.criticalPendingId = null; this.criticalPendingSince = null;
    } else if (this.criticalPendingId !== delivery.criticalOldestId) {
      this.criticalPendingId = delivery.criticalOldestId; this.criticalPendingSince = checkedAt;
    }
    const criticalAge = this.criticalPendingSince === null ? 0 : checkedAt - this.criticalPendingSince;
    const unresolvedFailure = delivery.lastFailure && delivery.lastFailure.at > (delivery.lastSuccessAt ?? 0) ? delivery.lastFailure : null;
    // A stuck answer or control panel is a hard delivery failure. Commentary and
    // activity edits are intentionally lossy and must never turn the whole bridge
    // FAILED, although a VK rate-limit remains visible as DEGRADED.
    const deliveryState: HealthState = criticalAge > 5 * 60_000
      ? "failed"
      : delivery.pauseRemainingMs > 0 || criticalAge > 30_000 || unresolvedFailure !== null
        ? "degraded"
        : "ok";
    const failureDetail = unresolvedFailure ? ` Последний сбой: ${unresolvedFailure.type}, ${unresolvedFailure.kind}/${unresolvedFailure.operation}.` : "";
    checks.push({
      name: "vk_delivery",
      state: deliveryState,
      detail: delivery.pauseRemainingMs > 0
        ? `VK ограничил частоту; повтор через ${Math.ceil(delivery.pauseRemainingMs / 1_000)} с. Очередь: ${delivery.criticalPending} важных, ${delivery.streamPending} фоновых.${failureDetail}`
        : `Очередь: ${delivery.criticalPending} важных, ${delivery.streamPending} фоновых; отменённых записей: ${delivery.inactivePending}${criticalAge ? `; важные ожидают ${Math.round(criticalAge / 1_000)} с` : ""}.${failureDetail}`,
    });

    const connectedState: HealthState = runtime.connectedRequiredBindings < runtime.requiredBindings ? "degraded" : "ok";
    checks.push({ name: "codex_streams", state: connectedState,
      detail: `Live-подключений: ${runtime.connectedBindings} из ${runtime.activeBindings}; выполняющиеся или ожидающие ответа: ${runtime.connectedRequiredBindings} из ${runtime.requiredBindings}. Остальные беседы подключатся при активности.` });

    const [vkResult, catalogResult, goalsResult, compatibilityResult] = await Promise.all([
      this.checkVk(), this.checkCatalog(), this.checkGoals(), this.checkCompatibility(force, checkedAt),
    ]);
    checks.push(...vkResult, catalogResult, goalsResult, compatibilityResult);

    let snapshot: BridgeHealthSnapshot = {
      state: aggregate(checks), checkedAt, pid: process.pid,
      uptimeSeconds: Math.max(0, (checkedAt - runtime.startedAt) / 1_000), checks,
    };
    this.store.setValue("health:latest", snapshot);
    if (this.healthFile) {
      try { await writeFile(this.healthFile, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
      catch {
        const next = [...checks, { name: "health_file", state: "failed", detail: "Не удалось обновить локальный health-файл." } satisfies HealthCheckResult];
        snapshot = { ...snapshot, state: aggregate(next), checks: next };
        this.store.setValue("health:latest", snapshot);
      }
    }
    this.notifyTransition(snapshot);
    return snapshot;
  }

  private async checkVk(): Promise<readonly HealthCheckResult[]> {
    if (!this.chat.health) return [{ name: "vk", state: "degraded", detail: "VK-адаптер не предоставляет активную проверку." }];
    try {
      const result = await withTimeout(this.chat.health(), 20_000);
      return result.length ? result : [{ name: "vk", state: "failed", detail: "VK-адаптер вернул пустой результат проверки." }];
    } catch { return [{ name: "vk", state: "failed", detail: "VK API не завершил безопасную проверку за 20 секунд." }]; }
  }

  private async checkCatalog(): Promise<HealthCheckResult> {
    try {
      const tasks = await withTimeout(this.desktop.listTasks(), 15_000);
      const warnings = this.desktop.catalogWarnings?.() ?? [];
      return warnings.length
        ? { name: "codex_catalog", state: "degraded", detail: `Найдено задач: ${tasks.length}. ${warnings.join(" ").slice(0, 500)}` }
        : { name: "codex_catalog", state: "ok", detail: `Все настроенные каталоги прочитаны; найдено задач: ${tasks.length}.` };
    } catch { return { name: "codex_catalog", state: "failed", detail: "Каталог задач Codex не прочитан за 15 секунд." }; }
  }

  private async checkGoals(): Promise<HealthCheckResult> {
    if (!this.desktop.capabilities.goals) return { name: "codex_goals", state: "ok", detail: "Управление целями не включено в этом адаптере." };
    if (!this.desktop.getGoal || !this.desktop.setGoal || !this.desktop.clearGoal) return { name: "codex_goals", state: "failed", detail: "Адаптер объявил цели, но не предоставил полный интерфейс управления." };
    try {
      const bound = this.store.bindings().find(binding => binding.attached);
      const task = bound ?? (await withTimeout(this.desktop.listTasks(), 15_000))[0];
      if (!task) return { name: "codex_goals", state: "ok", detail: "API целей подключён; задач для безопасного чтения пока нет." };
      const goal = await withTimeout(this.desktop.getGoal(task), 15_000);
      return { name: "codex_goals", state: "ok", detail: goal ? `API целей отвечает; прочитан статус ${goal.status}.` : "API целей отвечает; у проверенной задачи цели нет." };
    } catch { return { name: "codex_goals", state: "failed", detail: "Локальный API целей Codex не ответил за 15 секунд." }; }
  }

  private async checkCompatibility(force: boolean, checkedAt: number): Promise<HealthCheckResult> {
    if (!this.desktop.compatibility) return { name: "codex_live_api", state: "degraded", detail: "Адаптер не сообщает совместимость live API." };
    if (this.desktop.checkCompatibility && (force || checkedAt - this.lastCompatibilityAt >= this.compatibilityIntervalMs)) {
      this.lastCompatibilityAt = checkedAt;
      try { await withTimeout(this.desktop.checkCompatibility(), 20_000); }
      catch { return { name: "codex_live_api", state: "failed", detail: "Проверка named pipe и stream protocol не завершилась за 20 секунд." }; }
    }
    return compatibilityCheck(this.desktop.compatibility());
  }

  private notifyTransition(snapshot: BridgeHealthSnapshot): void {
    const notified = this.store.getValue<HealthState>("health:last-notified-state");
    if (snapshot.state === "ok") {
      this.store.setValue("health:unhealthy-runs", 0);
      this.store.setValue("health:last-observed-state", "ok");
      const healthyRuns = (this.store.getValue<number>("health:healthy-runs") ?? 0) + 1;
      this.store.setValue("health:healthy-runs", healthyRuns);
      if (!notified) this.store.setValue("health:last-notified-state", "ok");
      else if (notified !== "ok" && healthyRuns >= 3) {
        this.store.enqueue(`health-recovered:${snapshot.checkedAt}`, this.access.ownerId, { text: "VKodex: health check снова OK. VK, очередь, локальный runtime и Codex проверены." });
        this.store.setValue("health:last-notified-state", "ok");
      }
      return;
    }
    this.store.setValue("health:healthy-runs", 0);
    const observed = this.store.getValue<HealthState>("health:last-observed-state");
    const streak = observed === snapshot.state ? (this.store.getValue<number>("health:unhealthy-runs") ?? 0) + 1 : 1;
    this.store.setValue("health:last-observed-state", snapshot.state);
    this.store.setValue("health:unhealthy-runs", streak);
    const threshold = snapshot.state === "failed" ? 2 : 10;
    if (streak < threshold || notified === snapshot.state || (notified && notified !== "ok" && severity[notified] > severity[snapshot.state])) return;
    const failures = snapshot.checks.filter(check => check.state !== "ok").slice(0, 5).map(check => `${check.name}: ${check.detail}`);
    this.store.enqueue(`health-alert:${snapshot.checkedAt}:${snapshot.state}`, this.access.ownerId, {
      text: `VKodex: health check ${labels[snapshot.state]}.\n${failures.join("\n")}\n\n/menu или /health — актуальное состояние.`,
    });
    this.store.setValue("health:last-notified-state", snapshot.state);
  }
}
