import { ActionRejectedError, ArchiveOwnerRequiredError, DesktopUnavailableError, UncertainActionError, TransferConflictError, sameTask, taskKey,
  type DesktopTasks, type TransferTaskRequest } from "../desktop/contracts.js";
import { MENU_BUTTON, type TaskTransferRecord } from "./contracts.js";
import { BridgeStore } from "./store.js";
import { randomUUID } from "node:crypto";

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

const stages: Record<NonNullable<TaskTransferRecord["step"]>, string> = {
  snapshot: "Проверка исходной истории и цели", fork: "Копирование истории", metadata: "Сохранение названия и проекта",
  open: "Подключение клиента назначения", goal: "Восстановление цели", verify: "Проверка перед переключением", archive: "Архивация исходной задачи",
};

export function transferStatus(record: TaskTransferRecord): string {
  if (record.phase === "cancelled") return "Перенос отменён. VK-беседа осталась в исходном каталоге. Если копия уже создана, она сохранена для проверки и не удалена. Цель не запускается автоматически; /goal — проверить её состояние.";
  if (record.phase === "complete" && record.legacyReconciled) return "Старая запись переноса закрыта: исходная задача уже архивирована, VK-привязка указывает на сохранённую копию. Граница старой истории не была записана; повторный перенос и изменение задач не выполнялись.";
  if (record.phase === "complete") return "Перенос завершён. VK-беседа подключена к проверенной копии; исходная задача архивирована."
    + (record.goal?.status === "active" ? "\nЦель сохранена на паузе. /goal — проверить и возобновить её в новом аккаунте." : "");
  return [
    record.phase === "switched" ? "VK-беседа уже переключена. Не завершена архивация источника." : "Перенос ещё не завершён; VK-беседа пока не переключена.",
    `Этап: ${stages[record.step ?? "snapshot"]}. Попытка: ${record.attempt ?? 0}.`,
    record.detail,
    record.goal?.status === "active" && record.checkpoint ? "Исходная цель приостановлена на время переноса; автоматический запуск второй копии запрещён." : "",
    record.blockedReason === "archiveUnknown" ? "Результат архивации неизвестен. Раз в минуту проверяю архив исходной задачи; повторная команда записи запрещена."
      : record.blockedReason === "archiveOwner" ? "Ожидаю безопасной архивации источника. Раз в минуту проверяю архив и готовность владельца либо незагруженной задачи; попытка записи проходит только после повторной проверки истории и цели."
      : record.blockedReason === "sourceChanged" ? "После копирования изменилась история или цель источника. Автоматическая архивация остановлена, чтобы не потерять новый ход; нужна сверка обеих копий."
      : record.blocked || record.version !== 2 ? "Нужна проверка. /menu → «Продолжить перенос» проверит ту же операцию; новая копия не создаётся."
      : record.retryAt ? `Автоматическая проверка: ${new Date(record.retryAt).toLocaleTimeString("ru-RU")}.` : "Операция выполняется в фоне. Остальные беседы доступны.",
  ].filter(Boolean).join("\n");
}

export interface TransferredGoalUsage {
  readonly objective: string;
  readonly targetCreatedAt: number;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
}

/** Durable saga. A VK handler only enqueues it; its timeout never releases this lock. */
export class TaskTransfers {
  private readonly owner = randomUUID();
  private readonly running = new Map<string, Promise<void>>();
  private readonly busySources = new Set<string>();
  private readonly archiveChecks = new Map<string, number>();
  private stopped = false;

  constructor(private readonly store: BridgeStore, private readonly desktop: DesktopTasks, private readonly now: () => number = Date.now) {}

  start(record: TaskTransferRecord): void {
    this.store.beginTransfer({ ...record, version: 2, step: "snapshot", revision: 0, updatedAt: this.now(), attempt: 0 });
    this.publish(this.store.transfer(record.bindingId)!);
    this.tick();
  }

  resume(bindingId: string): void {
    const current = this.store.transfer(bindingId);
    if (!current || ["complete", "cancelled"].includes(current.phase)) throw new ActionRejectedError("Незавершённого переноса нет.");
    if (this.running.has(current.id)) { this.publish(current); return; }
    if (current.lease && processAlive(current.lease.pid)) throw new ActionRejectedError("Операция уже выполняется другим процессом VKodex. Повторный запуск запрещён.");
    if (current.blockedReason === "archiveUnknown") throw new ActionRejectedError("Результат архивации неизвестен. VKodex проверяет состояние источника и не повторит команду записи вслепую.");
    if (current.blockedReason === "sourceChanged") throw new ActionRejectedError("После копирования изменились история или цель источника. Сначала сверяй обе копии; автоматическая архивация запрещена.");
    // Legacy operations have no saved boundary. Never invent one and archive a
    // source that might have advanced since that historical transfer.
    const next = this.store.updateTransfer(current, { version: 2, blocked: false, retryAt: 0, attempt: 0,
      blockedReason: null, launchAttempted: false }, this.now());
    this.publish(next); this.tick();
  }

  cancel(bindingId: string): void {
    const record = this.store.transfer(bindingId);
    if (!record || ["complete", "cancelled", "switched"].includes(record.phase)) throw new ActionRejectedError("После переключения отмена недоступна; используй отдельный обратный перенос.");
    if (this.running.has(record.id)) throw new ActionRejectedError("Этап ещё выполняется в Codex. Дождись его ответа или таймаута, затем повтори отмену. Текущий запрос не будет оборван вслепую.");
    if (record.lease && processAlive(record.lease.pid)) throw new ActionRejectedError("Операция ещё выполняется другим процессом VKodex; отмена пока недоступна.");
    const binding = this.store.getBinding(bindingId);
    if (!binding || !sameTask(binding, record.source)) throw new TransferConflictError("Привязка беседы изменилась. Отмена старой операции не выполнена.");
    const next = this.store.updateTransfer(record, { phase: "cancelled", blocked: false, retryAt: 0 }, this.now());
    this.publish(next);
  }

  tick(): void {
    if (this.stopped) return;
    for (const record of this.store.transfers()) {
      if (this.running.size >= 2) break;
      // Every blocked switched transfer gets read-only reconciliation. This
      // also repairs older records which did not persist a typed block reason.
      // Only an explicit known owner rejection may authorize another write.
      const archiveCheck = record.phase === "switched" && !!record.blocked && !!record.target && !!record.checkpoint;
      if (record.version !== 2 || ["complete", "cancelled"].includes(record.phase) || (record.blocked && !archiveCheck)
        || (record.retryAt ?? 0) > this.now() || this.running.has(record.id)
        || (archiveCheck && this.now() - (this.archiveChecks.get(record.id) ?? -Infinity) < 60_000)) continue;
      const sources = [...new Set([record.source.sourceId ?? "", record.targetSourceId])];
      if (sources.some(source => this.busySources.has(source))) continue;
      const claimed = this.store.claimTransfer(record, this.owner, process.pid, processAlive, this.now());
      if (!claimed) continue;
      sources.forEach(source => this.busySources.add(source));
      if (archiveCheck) this.archiveChecks.set(record.id, this.now());
      const work = (archiveCheck ? this.checkArchivedSource(claimed) : this.run(claimed)).finally(() => {
        try { this.store.releaseTransfer(record.bindingId, record.id, this.owner, this.now()); }
        catch { /* A failed DB is reported by health; do not reject an unobserved worker promise. */ }
        this.running.delete(record.id); sources.forEach(source => this.busySources.delete(source));
      });
      this.running.set(record.id, work);
    }
  }

  async idle(): Promise<void> { await Promise.all([...this.running.values()]); }
  async stop(): Promise<void> { this.stopped = true; await this.idle(); }

  /** Read-only native reconciliation: never fake a notification or release the
   * owner's writer. Completion still requires the exact source checkpoint. */
  private async checkArchivedSource(record: TaskTransferRecord): Promise<void> {
    try {
      if (!this.desktop.isTaskArchived || !record.target || !record.checkpoint) return;
      if (!await this.confirmArchivedSource(record)) {
        if (record.blockedReason === null && this.desktop.verifyTransferSource) {
          // Older blocked records did not preserve a typed failure. Read the
          // immutable boundary before even considering an operator retry.
          await this.desktop.verifyTransferSource(record.source, record.checkpoint);
          await this.verifySourceGoal(record);
        }
        // The previous external archive was explicitly rejected by a writer.
        // A newly connected idle native owner can now accept it. Re-enter the
        // saved archive stage, which rechecks the source boundary and goal
        // before writing; never infer ownership from a timeout alone.
        if (record.blockedReason === "archiveOwner" && this.desktop.archiveRetryReady
          && await this.desktop.archiveRetryReady(record.source)) await this.run(record);
        return;
      }
      await this.verifySourceGoal(record);
      const next = this.store.completeTransfer(record, this.now());
      this.publish(next);
    } catch (error) {
      if (error instanceof TransferConflictError) {
        try {
          const next = this.store.updateTransfer(record, { blockedReason: "sourceChanged", detail: error.message }, this.now());
          this.publish(next);
        } catch { /* Another worker or a changed binding wins over this read. */ }
      }
      // An unavailable read leaves the original failure visible to health.
    }
  }

  private async confirmArchivedSource(record: TaskTransferRecord): Promise<boolean> {
    if (!this.desktop.isTaskArchived) return false;
    try { return await this.desktop.isTaskArchived(record.source, record.checkpoint); }
    catch (error) {
      // Old transfers stored file size/mtime but not a semantic digest. Once
      // archived, Codex may relocate or rewrite that file. Reconcile only a
      // genuinely archived source against the target's exact copied prefix.
      if (!record.checkpoint || record.checkpoint.semanticDigest || !record.target
        || !this.desktop.verifyLegacyArchivedPair) throw error;
      await this.desktop.verifyLegacyArchivedPair(record.source, record.target, record.checkpoint);
      return true;
    }
  }

  private publish(record: TaskTransferRecord): void {
    const binding = this.store.getBinding(record.bindingId);
    if (!binding?.attached || binding.peerId === null) return;
    this.store.enqueue(`transfer-status:${record.id}`, binding.peerId,
      { text: transferStatus(record), buttons: [MENU_BUTTON], silent: record.phase !== "complete" }, binding.id, "panel");
  }

  private request(record: TaskTransferRecord): TransferTaskRequest {
    return { operationId: record.id, startedAt: record.startedAt, task: record.source,
      targetSourceId: record.targetSourceId, projectId: record.targetProjectId,
      ...(record.target ? { existingTarget: record.target } : {}),
      ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}),
      ...(record.forkSubmitted ? { forkSubmitted: true } : {}) };
  }

  private async run(saved: TaskTransferRecord): Promise<void> {
    let record = saved;
    const save = (changes: Partial<TaskTransferRecord>) => {
      record = this.store.updateTransfer(record, changes, this.now());
    };
    const step = (value: NonNullable<TaskTransferRecord["step"]>) => {
      if (this.stopped) throw new DesktopUnavailableError("VKodex завершает работу. Сохранённый этап будет продолжен после запуска.");
      save({ step: value }); this.publish(record);
    };
    try {
      save({ attempt: (record.attempt ?? 0) + 1, retryAt: 0, blocked: false, detail: "" });
      const binding = this.store.getBinding(record.bindingId);
      if (!binding?.attached || binding.peerId === null) throw new TransferConflictError("Беседа отключена. Автоматический перенос остановлен.");
      const switched = record.phase === "switched";
      if (!sameTask(binding, switched && record.target ? record.target : record.source)) {
        throw new TransferConflictError("Привязка беседы изменилась. Автоматический перенос остановлен.");
      }
      if (!this.desktop.isTaskArchived || !this.desktop.transferCheckpoint || !this.desktop.verifyTransferSource
        || !this.desktop.verifyTransferTarget || !this.desktop.ensureOpen || !this.desktop.transferTask) {
        throw new TransferConflictError("Адаптер не предоставляет полный контракт проверяемого переноса. Обнови VKodex.");
      }
      if (!switched) {
        if (!record.checkpoint) {
          if (record.target || record.forkSubmitted || record.phase !== "forking") {
            throw new TransferConflictError("У старого переноса нет сохранённой границы истории. Автоматическое переключение и архивация запрещены.");
          }
          step("snapshot");
          // First check idle, then save the goal BEFORE pausing it. A crash after
          // set(paused) must not replace the original active status in the journal.
          await this.desktop.transferCheckpoint(record.source);
          if (record.goal === undefined) {
            if (!this.desktop.getGoal) throw new TransferConflictError("Не удалось проверить наличие цели исходной задачи.");
            save({ goal: await this.desktop.getGoal(record.source) });
          }
          if (record.goal?.status === "active") {
            if (!this.desktop.setGoal || !this.desktop.getGoal) throw new TransferConflictError("Не удалось приостановить исходную цель.");
            const currentGoal = await this.desktop.getGoal(record.source);
            if (!currentGoal || currentGoal.objective !== record.goal.objective || currentGoal.createdAt !== record.goal.createdAt
              || currentGoal.tokenBudget !== record.goal.tokenBudget || currentGoal.tokensUsed !== record.goal.tokensUsed
              || !["active", "paused"].includes(currentGoal.status)) throw new TransferConflictError("Исходная цель изменилась. Перенос остановлен.");
            if (currentGoal.status === "active") await this.desktop.setGoal(record.source, { status: "paused" });
            if ((await this.desktop.getGoal(record.source))?.status !== "paused") throw new DesktopUnavailableError("Пауза исходной цели не подтверждена.");
          }
          save({ checkpoint: await this.desktop.transferCheckpoint(record.source) });
        }
        await this.desktop.verifyTransferSource(record.source, record.checkpoint!);
        if (!record.target || ["forking", "preparingTarget", "failed", "uncertain"].includes(record.phase)) {
          step("fork");
          const target = await this.desktop.transferTask({ ...this.request(record),
            onForkSubmitted: () => save({ forkSubmitted: true }),
            onForkCreated: target => save({ target, phase: "preparingTarget" }),
          });
          save({ target, phase: "targetCreated" });
        }
        const target = record.target!;
        step("open");
        // Persist the intent before opening. If that process dies between the
        // write and the launch, a different executor must probe the target and
        // retry. Within one executor, never cycle the foreground window.
        if (!record.launchAttempted) {
          save({ launchAttempted: true, launchOwner: this.owner }); await this.desktop.ensureOpen(target);
        }
        let live;
        if (record.launchOwner !== this.owner) {
          try { live = await this.desktop.inspectTask(target); }
          catch {
            // ensureOpen probes the owner before using the configured launcher.
            // Repeating it after a lost response cannot create another fork.
            save({ launchOwner: this.owner });
            await this.desktop.ensureOpen(target);
          }
        }
        live ??= await this.desktop.inspectTask(target);
        if (!["idle", "failed", "interrupted"].includes(live.status)) throw new DesktopUnavailableError("Клиент назначения пока не готов к следующему ходу.");
        step("metadata");
        await this.desktop.renameTask(target, record.source.title);
        await this.desktop.moveTask(target, record.targetProjectId);
        step("goal");
        await this.prepareGoal(record, save);
        step("verify");
        await this.desktop.verifyTransferSource(record.source, record.checkpoint!);
        await this.verifySourceGoal(record);
        await this.desktop.verifyTransferTarget(this.request(record), target);
        // The commit and stream generation change share one SQLite transaction.
        this.store.switchTransfer(record, { ...target, title: record.source.title, projectId: record.targetProjectId });
        record = this.store.transfer(record.bindingId)!;
        this.store.markDesktopHandoff(record.bindingId, record.target!, "live");
      }
      step("archive");
      if (!await this.confirmArchivedSource(record)) {
        if (!record.checkpoint) throw new TransferConflictError("Граница старого переноса неизвестна. Источник не архивирован автоматически.");
        await this.desktop.verifyTransferSource(record.source, record.checkpoint);
        await this.verifySourceGoal(record);
        if (!this.desktop.archiveTransferredSource) throw new TransferConflictError("Архивация источника недоступна.");
        await this.desktop.archiveTransferredSource(record.source);
        if (!await this.confirmArchivedSource(record)) throw new DesktopUnavailableError("Архивация не подтверждена исходным каталогом.");
      }
      // A legacy operation can only reach here if its source was ALREADY
      // archived. Do not imply that its missing checkpoint was verified.
      if (!record.checkpoint && record.target) await this.desktop.isTaskArchived(record.target);
      record = this.store.completeTransfer(record, this.now()); this.publish(record);
    } catch (error) {
      const unknownArchive = record.phase === "switched" && record.step === "archive" && error instanceof UncertainActionError;
      const blocked = error instanceof TransferConflictError || unknownArchive || (record.attempt ?? 0) >= 8;
      const detail = error instanceof ActionRejectedError || error instanceof DesktopUnavailableError || error instanceof UncertainActionError
        ? error.message : "Сбой этапа переноса. Состояние сохранено; новая копия не создаётся.";
      try {
        save({ blocked, detail, blockedReason: error instanceof ArchiveOwnerRequiredError ? "archiveOwner" : unknownArchive ? "archiveUnknown" : null,
          retryAt: blocked ? 0 : this.now() + Math.min(10 * 60_000, 10_000 * 2 ** Math.min(record.attempt ?? 1, 6)) });
        this.publish(record);
      } catch { /* A stale callback must not overwrite a different operation. */ }
    }
  }

  private async verifySourceGoal(record: TaskTransferRecord): Promise<void> {
    if (record.goal === undefined || !this.desktop.getGoal) throw new TransferConflictError("Снимок исходной цели отсутствует.");
    const current = await this.desktop.getGoal(record.source);
    const expected = record.goal;
    if (expected === null ? current !== null : !current || current.objective !== expected.objective
      || current.createdAt !== expected.createdAt || current.tokensUsed !== expected.tokensUsed || current.tokenBudget !== expected.tokenBudget
      || current.status !== (expected.status === "active" ? "paused" : expected.status)) {
      throw new TransferConflictError("Исходная цель изменилась после снимка. Источник не будет архивирован.");
    }
  }

  private async prepareGoal(record: TaskTransferRecord, save: (changes: Partial<TaskTransferRecord>) => void): Promise<void> {
    if (!this.desktop.getGoal || !this.desktop.setGoal) throw new TransferConflictError("API целей назначения недоступен.");
    const target = record.target!;
    const source = record.goal;
    let current = await this.desktop.getGoal(target);
    if (!source) {
      if (current) throw new TransferConflictError("В копии появилась другая цель; она не будет перезаписана.");
      save({ goalPrepared: true }); return;
    }
    // Goal/set cannot import usage counters. Preserve the accounting locally and
    // give the target only the REMAINING budget, never a fresh full allowance.
    const budget = source.tokenBudget === null ? null : Math.max(1, source.tokenBudget - source.tokensUsed);
    const status = source.status === "complete" ? "complete" : source.tokenBudget !== null && source.tokensUsed >= source.tokenBudget ? "budgetLimited"
      : source.status === "active" ? "paused" : source.status;
    if (current && (current.objective !== source.objective || current.status !== status || current.tokenBudget !== budget || current.tokensUsed !== 0)) {
      throw new TransferConflictError("Цель назначения изменилась. Автоматическое перезаписывание запрещено.");
    }
    if (!current) {
      if (record.goalPrepared) throw new TransferConflictError("Ранее сохранённая цель назначения исчезла. Нужна проверка.");
      await this.desktop.setGoal(target, { objective: source.objective, tokenBudget: budget, status });
      current = await this.desktop.getGoal(target);
    }
    if (!current || current.objective !== source.objective || current.status !== status || current.tokenBudget !== budget || current.tokensUsed !== 0) {
      throw new DesktopUnavailableError("Цель назначения не подтверждена чтением после записи.");
    }
    const previous = this.store.getValue<TransferredGoalUsage>(`transferred-goal:${taskKey(record.source)}`);
    const carry = previous?.objective === source.objective && previous.targetCreatedAt === source.createdAt ? previous : null;
    this.store.setValue(`transferred-goal:${taskKey(target)}`, { objective: source.objective, targetCreatedAt: current.createdAt,
      tokensUsed: source.tokensUsed + (carry?.tokensUsed ?? 0), timeUsedSeconds: source.timeUsedSeconds + (carry?.timeUsedSeconds ?? 0) } satisfies TransferredGoalUsage);
    save({ goalPrepared: true });
  }
}
