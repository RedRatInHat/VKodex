import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { sameTask, type DesktopCompatibility, type CodexTasks } from "../core/codex-tasks.js";
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
  readonly failedBindings?: number;
  readonly bindings?: readonly {
    readonly id: string;
    readonly title: string;
    readonly source: string;
    readonly status: string;
    readonly connected: boolean;
    readonly lastConfirmedAt: number | null;
    readonly failure: "usageLimit" | "systemError" | null;
  }[];
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
    private readonly desktop: CodexTasks,
    private readonly chat: BridgeChat,
    private readonly store: BridgeStore,
    private readonly runtime: () => RuntimeHealthState,
    private readonly healthFile?: string,
    private readonly now: () => number = Date.now,
    private readonly compatibilityIntervalMs = 10 * 60_000,
    private readonly workspaceExists: (workspace: string) => boolean = existsSync,
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
    const failedTasks = runtime.failedBindings ?? 0;
    checks.push({ name: "codex_tasks", state: failedTasks ? "degraded" : "ok",
      detail: failedTasks ? `Задач с ошибкой Codex: ${failedTasks}. Проверь /menu и /limits в соответствующей беседе. Это состояние задач, а не обрыв VK.` : "У подключённых задач нет подтверждённых системных ошибок Codex." });
    const uncertainPrompts = this.store.uncertainPromptStats();
    const uncertainAge = uncertainPrompts.oldestAt === null ? 0 : Math.max(0, checkedAt - uncertainPrompts.oldestAt);
    checks.push({ name: "codex_uncertain_inputs", state: uncertainAge > 10 * 60_000 ? "failed" : uncertainPrompts.count ? "degraded" : "ok",
      detail: uncertainPrompts.count
        ? `Запросов без подтверждения: ${uncertainPrompts.count}; старейший ожидает ${Math.round(uncertainAge / 1_000)} с. Мост сверяет clientUserMessageId с историей Codex; промпты автоматически не дублируются.`
        : "Новых запросов с неизвестным результатом отправки нет." });
    const inputBatches = this.store.inputBatchStats();
    const batchAge = inputBatches.oldestAt === null ? 0 : Math.max(0, checkedAt - inputBatches.oldestAt);
    checks.push({ name: "vk_inbound_batches", state: batchAge > 2 * 60_000 ? "failed" : batchAge > 30_000 ? "degraded" : "ok",
      detail: inputBatches.count
        ? `Пачек длинных VK-запросов: ${inputBatches.count}; отправляются: ${inputBatches.dispatching}; старейшая ожидает ${Math.round(batchAge / 1_000)} с. Мост восстановит подготовленную пачку, но не повторит потенциально принятую Codex.`
        : "Зависших частей длинных VK-запросов нет." });
    const replayable = this.store.replayableInputStats();
    const replayAge = replayable.oldestAt === null ? 0 : Math.max(0, checkedAt - replayable.oldestAt);
    const recoveryError = this.store.getValue<{ at: number }>("inbound-recovery-error");
    checks.push({ name: "vk_inbound_journal",
      state: recoveryError || replayAge > 10 * 60_000 ? "failed" : replayable.count ? "degraded" : "ok",
      detail: recoveryError ? "Журнал входящих VK-запросов не удалось восстановить. Автоматическая отправка остановлена для повреждённых записей."
        : replayable.count ? `Сохранённых запросов до отправки: ${replayable.count}; старейший ожидает ${Math.round(replayAge / 1_000)} с. Мост повторяет только запросы без начатой отправки.`
          : "Необработанных входящих VK-запросов нет." });
    for (const binding of runtime.bindings ?? []) {
      const rolloutFailure = this.store.getValue<{ at: number; kind: "recordTooLarge" | "readFailed" | "historyRebuilt" }>(`rollout-failure:${binding.id}`);
      const failureAt = rolloutFailure && Number.isSafeInteger(rolloutFailure.at) && Math.abs(rolloutFailure.at) <= 8.64e15
        ? new Date(rolloutFailure.at).toISOString() : "неизвестно";
      if (rolloutFailure) checks.push({ name: `rollout_recovery:${binding.id}`,
        state: rolloutFailure.kind === "readFailed" ? "degraded" : "failed",
        detail: `«${binding.title.slice(0, 120)}» (${binding.source}): резервное чтение истории ${rolloutFailure.kind === "recordTooLarge"
          ? "остановлено на записи больше безопасного предела" : rolloutFailure.kind === "historyRebuilt"
            ? "обнаружило пересобранную ветку; без снимка владельца доставляются только подтверждённые VK-ходы, чтобы не повторить старые ответы"
            : "не удалось завершить"}; последний сбой ${failureAt}. Живое подключение повторяется; сообщения не следует дублировать вручную.` });
      const acceptedTurns = this.store.acceptedTurns(binding.id);
      const acceptedAt = this.store.oldestAcceptedTurnAt(binding.id);
      const legacyKey = `health:legacy-accepted:${binding.id}`;
      let legacySince: number | null = null;
      if (acceptedTurns.length && acceptedAt === null) {
        // Older accepted operations have no input timestamp. Persist the first
        // observation so a bridge restart cannot reset their alert grace period.
        const signature = JSON.stringify(acceptedTurns.map(turn => turn.turnId).sort());
        const previous = this.store.getValue<{ signature: string; firstSeenAt: number }>(legacyKey);
        if (previous?.signature === signature) legacySince = previous.firstSeenAt;
        else { legacySince = checkedAt; this.store.setValue(legacyKey, { signature, firstSeenAt: checkedAt }); }
      } else if (this.store.getValue(legacyKey) !== null) this.store.setValue(legacyKey, null);
      const acceptedAge = Math.max(0, checkedAt - (acceptedAt ?? legacySince ?? checkedAt));
      const threshold = acceptedAt === null ? 5 * 60_000 : 2 * 60_000;
      if (acceptedTurns.length && acceptedAge > threshold && ["idle", "failed", "interrupted", "unavailable"].includes(binding.status)) {
        const state: HealthState = binding.status === "unavailable" ? "degraded" : "failed";
        checks.push({ name: `codex_pending_final:${binding.id}`, state,
          detail: `«${binding.title.slice(0, 120)}» (${binding.source}): принятый VK-запрос остаётся без подтверждения завершения ${Math.round(acceptedAge / 1_000)} с при состоянии Codex «${binding.status}». Мост сверяет историю и не повторяет запрос автоматически.` });
      }
      const queued = this.store.queuedInputs(binding.id);
      const queuedAge = queued.length ? Math.max(0, checkedAt - Math.min(...queued.map(item => item.acceptedAt))) : 0;
      if (queued.length && queuedAge > 2 * 60_000 && ["idle", "failed", "interrupted", "unavailable"].includes(binding.status)) {
        checks.push({ name: `codex_native_queue:${binding.id}`, state: binding.status === "unavailable" ? "degraded" : "failed",
          detail: `«${binding.title.slice(0, 120)}» (${binding.source}): ${queued.length} VK-запрос(а) остаются в штатной очереди Codex ${Math.round(queuedAge / 1_000)} с при состоянии «${binding.status}». VKodex не запускает и не повторяет их самостоятельно.` });
      }
      if (!binding.failure && (binding.connected || !["running", "approval"].includes(binding.status))) continue;
      const problem = binding.failure === "usageLimit" ? "исчерпан лимит аккаунта"
        : binding.failure === "systemError" ? "Codex сообщил системную ошибку"
          : "нет подтверждённой связи с владельцем выполняющейся задачи";
      const lastSeen = binding.lastConfirmedAt === null ? "подтверждения ещё не было"
        : `последнее подтверждение ${new Date(binding.lastConfirmedAt).toISOString()}`;
      checks.push({ name: `codex_task:${binding.id}`, state: binding.failure === "systemError" ? "failed" : "degraded",
        detail: `«${binding.title.slice(0, 120)}» (${binding.source}): ${problem}; ${lastSeen}. Мост повторяет подключение; проверь /menu задачи.` });
    }

    const transfers = this.store.transfers().filter(record => !["complete", "cancelled"].includes(record.phase));
    const blockedTransfers = transfers.filter(record => record.blocked || record.version !== 2);
    const staleTransfers = transfers.filter(record => checkedAt - (record.updatedAt ?? record.startedAt) > 15 * 60_000);
    const failedTransfers = transfers.some(record => record.version === 2 && (record.blocked || staleTransfers.includes(record)));
    checks.push({ name: "task_transfers", state: failedTransfers ? "failed" : transfers.length ? "degraded" : "ok",
      detail: transfers.length ? `Незавершённых переносов: ${transfers.length}; требуют проверки: ${blockedTransfers.length}; без прогресса более 15 мин: ${staleTransfers.length}. Этапы и причины доступны через /menu соответствующей задачи.` : "Незавершённых переносов нет." });
    for (const record of transfers.filter(record => record.blocked || staleTransfers.includes(record))) {
      const reason = record.blockedReason === "sourceChanged" ? "После копирования изменились история или цель источника; автоматическая архивация запрещена."
        : record.blockedReason === "archiveUnknown" ? "Результат архивации неизвестен; выполняется только проверка чтением."
          : record.blockedReason === "archiveOwner" ? "Ожидается безопасная готовность клиента-владельца для архивации."
            : record.blocked ? "Операция требует проверки; автоматический повтор остановлен."
              : "Этап не продвинулся более 15 минут.";
      checks.push({ name: `transfer:${record.id}`, state: record.blocked ? "failed" : "degraded",
        detail: `«${record.source.title.slice(0, 120)}»: этап ${record.step ?? record.phase}, последнее изменение ${new Date(record.updatedAt ?? record.startedAt).toISOString()}. ${reason} /menu задачи — подробности.` });
    }

    const [vkResult, catalogResult, goalsResult, compatibilityResult, ownerAdapters] = await Promise.all([
      this.checkVk(), this.checkCatalog(), this.checkGoals(), this.checkCompatibility(force, checkedAt), this.checkOwnerAdapters(runtime),
    ]);
    checks.push(...vkResult, ...catalogResult, goalsResult, compatibilityResult, ...ownerAdapters);

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

  private async checkOwnerAdapters(runtime: RuntimeHealthState): Promise<readonly HealthCheckResult[]> {
    if (!this.desktop.ownerAdapterStatus) return [];
    const profiles = new Map<string, { tasks: NonNullable<ReturnType<BridgeStore["getBinding"]>>[]; label: string }>();
    for (const item of runtime.bindings ?? []) {
      if (!item.connected) continue;
      const task = this.store.getBinding(item.id);
      if (!task?.attached || task.peerId === null) continue;
      const source = task.sourceId || "primary";
      const profile = profiles.get(source);
      if (profile) profile.tasks.push(task);
      else profiles.set(source, { tasks: [task], label: item.source });
    }
    return Promise.all([...profiles].map(async ([source, { tasks, label }]) => {
      const results = await Promise.all(tasks.map(async task => {
        try { return await withTimeout(this.desktop.ownerAdapterStatus!(task), 5_000); }
        catch { return "unknown" as const; }
      }));
      const missing = results.filter(status => status === "missing").length;
      const unknown = results.filter(status => status === "unknown").length;
      const affected = tasks.filter((_, index) => results[index] !== "ready").slice(0, 3).map(task => `«${task.title.slice(0, 80)}»`).join(", ");
      return { name: `codex_owner_adapter:${source}`, state: missing || unknown ? "degraded" : "ok",
        detail: missing || unknown
          ? `${label}: адаптер владельца не подтверждён для ${missing + unknown} из ${tasks.length} подключённых задач (отсутствует: ${missing}, проверка не удалась: ${unknown}). ${affected}. Архивация источника при переносе может быть недоступна.`
          : `${label}: адаптер владельца отвечает для ${tasks.length} подключённых задач.` } satisfies HealthCheckResult;
    }));
  }

  private async checkCatalog(): Promise<readonly HealthCheckResult[]> {
    try {
      const tasks = await withTimeout(this.desktop.listTasks(), 15_000);
      const warnings = this.desktop.catalogWarnings?.() ?? [];
      const missingWorkspaces = this.store.bindings().filter(binding => binding.attached).filter(binding => {
        const task = tasks.find(candidate => sameTask(candidate, binding));
        return !!task && !this.workspaceExists(task.workspace);
      }).length;
      const problems = [
        ...(missingWorkspaces ? [`У ${missingWorkspaces} подключённых задач рабочая папка недоступна.`] : []),
        ...warnings,
      ];
      const catalog: HealthCheckResult = problems.length
        ? { name: "codex_catalog", state: "degraded", detail: `Найдено задач: ${tasks.length}. ${problems.join(" ").slice(0, 500)}` }
        : { name: "codex_catalog", state: "ok", detail: `Все настроенные каталоги прочитаны; найдено задач: ${tasks.length}.` };
      if (!this.desktop.isTaskArchived) return [catalog];
      const missing = this.store.bindings().filter(binding => binding.attached && binding.peerId !== null
        && !tasks.some(task => sameTask(task, binding)));
      const checks = await Promise.all(missing.map(async binding => {
        try {
          if (!await withTimeout(this.desktop.isTaskArchived!(binding), 5_000)) return null;
          return { name: `archived_binding:${binding.id}`, state: "failed", detail:
            `VK-беседа «${binding.title.slice(0, 120)}» привязана к архивной задаче (${binding.sourceLabel || binding.sourceId || ".codex"}). Выбери актуальную копию в менеджере либо отправь /detach в старой беседе; /open архив не восстановит.` } satisfies HealthCheckResult;
        } catch {
          return { name: `archive_lookup:${binding.id}`, state: "degraded", detail:
            `Не удалось проверить архивный статус отсутствующей в каталоге задачи «${binding.title.slice(0, 120)}».` } satisfies HealthCheckResult;
        }
      }));
      const found: HealthCheckResult[] = [];
      for (const check of checks) if (check) found.push(check);
      return [catalog, ...found];
    } catch { return [{ name: "codex_catalog", state: "failed", detail: "Каталог задач Codex не прочитан за 15 секунд." }]; }
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
    const issueStates = this.store.getValue<Record<string, HealthState>>("health:last-notified-issues") ?? {};
    const previousRuns = this.store.getValue<Record<string, number>>("health:issue-runs") ?? {};
    const issues = snapshot.checks.filter(check => check.state !== "ok");
    const issueRuns: Record<string, number> = {};
    const activeIssues: Record<string, HealthState> = {};
    for (const issue of issues) {
      const key = `${issue.name}:${issue.state}`;
      issueRuns[key] = (previousRuns[key] ?? 0) + 1;
      if (issueStates[issue.name]) activeIssues[issue.name] = severity[issue.state] < severity[issueStates[issue.name]!]
        ? issue.state : issueStates[issue.name]!;
    }
    this.store.setValue("health:issue-runs", issueRuns);
    this.store.setValue("health:last-notified-issues", activeIssues);
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
    const newIssues = issues.filter(issue => severity[activeIssues[issue.name] ?? "ok"] < severity[issue.state]
      && issueRuns[`${issue.name}:${issue.state}`]! >= (issue.state === "failed" ? 2 : 10));
    const aggregateChanged = streak >= threshold && notified !== snapshot.state
      && (!notified || notified === "ok" || severity[notified] <= severity[snapshot.state]);
    if (!aggregateChanged && !newIssues.length) return;
    const failures = [...newIssues, ...issues.filter(issue => !newIssues.includes(issue))]
      .slice(0, 5).map(check => `${check.name}: ${check.detail}`);
    this.store.enqueue(`health-alert:${snapshot.checkedAt}:${snapshot.state}`, this.access.ownerId, {
      text: `VKodex: health check ${labels[snapshot.state]}.\n${failures.join("\n")}\n\n/menu или /health — актуальное состояние.`,
    });
    this.store.setValue("health:last-notified-state", snapshot.state);
    this.store.setValue("health:last-notified-issues", Object.fromEntries(issues.map(issue => [issue.name, issue.state])));
  }
}
