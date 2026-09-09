import { DesktopRequestRejectedError, DesktopUnavailableError, TaskConnectionLostError, TaskNotOpenError, type TaskRef } from "./contracts.js";
import { DesktopIpcClient, isObject, type IpcObject } from "./ipc-client.js";
import { RevisionedState } from "./state.js";
import { sameRolloutSource } from "./paths.js";

class SourceRefreshRequired extends Error {}

export class TaskSubscription {
  private readonly state = new RevisionedState();
  private ownerId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private disconnect: (() => void) | null = null;
  private closed = true;
  private recovering = false;
  private lastFailure: Error | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private sourceVerified = false;
  private sourceRefreshRequested = false;
  private sourceProblem: "missing" | "mismatch" | null = null;
  private sourceTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private cancelStart: ((error: Error) => void) | null = null;

  constructor(
    private readonly client: DesktopIpcClient,
    readonly task: TaskRef,
    private readonly onState: (state: IpcObject, initial: boolean) => void,
    private readonly onError: (error: Error) => void,
    private readonly notifyOwnerOnClose = true,
  ) {}

  get current(): IpcObject | null { return this.recovering || this.sourceRefreshRequested ? null : this.state.current; }
  get owner(): string | null { return this.ownerId; }
  get failure(): Error | null { return this.lastFailure; }

  private async discoverOwner(timeoutMs: number): Promise<string> {
    let reply: IpcObject;
    try {
      reply = await this.client.request("thread-owner-discovery", 1, {
        hostId: this.task.hostId, conversationId: this.task.threadId,
      }, { timeoutMs });
    } catch (error) {
      if (error instanceof DesktopRequestRejectedError && error.reason === "no-client-found") throw new TaskNotOpenError();
      throw error;
    }
    if (typeof reply.handledByClientId !== "string") throw new TaskNotOpenError();
    return reply.handledByClientId;
  }

  /** The IPC broker can survive a renderer/app restart. Its open socket alone
   * does not prove that the owner of this particular task still exists. */
  async verifyOwner(timeoutMs = 5_000): Promise<void> {
    const generation = this.generation;
    const owner = this.ownerId;
    if (this.closed || !owner) throw new DesktopUnavailableError();
    const currentOwner = await this.discoverOwner(timeoutMs);
    if (this.closed || this.generation !== generation || this.ownerId !== owner) throw new DesktopUnavailableError();
    if (currentOwner !== owner) throw new DesktopUnavailableError("Обработчик задачи в Codex сменился. Восстанавливаю подписку.");
  }

  async start(timeoutMs = 5_000): Promise<void> {
    if (!this.closed) throw new Error("Subscription is already active");
    this.closed = false;
    this.recovering = false;
    this.lastFailure = null;
    this.sourceVerified = false;
    this.sourceRefreshRequested = false;
    this.sourceProblem = null;
    const generation = ++this.generation;
    const checkActive = (): void => {
      if (this.closed || this.generation !== generation) throw new DesktopUnavailableError("Подписка на задачу отменена.");
    };
    try {
      await this.client.connect();
      checkActive();
      const owner = await this.discoverOwner(timeoutMs);
      checkActive();
      this.ownerId = owner;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.close(this.sourceProblem ? this.sourceError() : new DesktopUnavailableError("Не получено состояние задачи."));
        }, timeoutMs);
        let ready = false;
        this.cancelStart = error => { clearTimeout(timer); reject(error); };
        this.disconnect = this.client.onDisconnect(error => {
          clearTimeout(timer);
          const failure = new TaskConnectionLostError(error.message);
          this.close(failure);
          if (ready) this.onError(failure); else reject(failure);
        });
        this.unsubscribe = this.client.onBroadcast((message) => {
          if (this.closed || message.sourceClientId !== this.ownerId || message.method !== "thread-stream-state-changed") return;
          const params = message.params;
          if (!isObject(params) || params.hostId !== this.task.hostId || params.conversationId !== this.task.threadId) return;
          if (message.version !== 11) {
            clearTimeout(timer);
            const error = new DesktopUnavailableError("Версия событий десктопа не поддерживается.");
            this.close(error);
            if (ready) this.onError(error); else reject(error);
            return;
          }
          // Patches already in flight cannot repair a missing base revision.
          // Wait for the requested snapshot instead of treating each patch as
          // a second recovery failure or accepting an unverified source.
          if ((this.recovering || this.sourceRefreshRequested) && isObject(params.change) && params.change.type === "patches") return;
          try {
            const initial = this.state.current === null;
            const state = this.state.accept(params.change, candidate => {
              if (candidate.id !== this.task.threadId || candidate.hostId !== this.task.hostId) throw new Error("Unexpected task state");
              this.validateSource(candidate);
            });
            this.recovering = false;
            if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
            this.onState(state, initial);
            if (!ready) { ready = true; clearTimeout(timer); this.cancelStart = null; resolve(); }
          } catch (error) {
            if (error instanceof SourceRefreshRequired) {
              if (ready && !this.sourceTimer) {
                this.sourceTimer = setTimeout(() => {
                  this.sourceTimer = null;
                  const failure = this.sourceError();
                  this.close(failure); this.onError(failure);
                }, timeoutMs);
              }
              this.follow(false); this.follow(true);
              return;
            }
            if (error instanceof DesktopUnavailableError) {
              clearTimeout(timer); this.close(error);
              if (ready) this.onError(error); else reject(error);
              return;
            }
            if (this.recovering) {
              const error = new DesktopUnavailableError("Не удалось восстановить состояние задачи.");
              clearTimeout(timer);
              this.close(error);
              if (ready) this.onError(error); else reject(error);
              return;
            }
            this.recovering = true;
            this.state.reset();
            if (ready && !this.recoveryTimer) {
              this.recoveryTimer = setTimeout(() => {
                this.recoveryTimer = null;
                const failure = new TaskConnectionLostError("Codex не прислал новый снимок состояния задачи после разрыва последовательности событий.");
                this.close(failure); this.onError(failure);
              }, timeoutMs);
            }
            this.follow(false);
            this.follow(true);
          }
        });
        this.follow(true);
      });
    } catch (error) {
      if (this.generation === generation) this.close();
      throw error;
    }
  }

  private follow(following: boolean): void {
    if (!this.ownerId) return;
    this.client.broadcast("thread-stream-following-changed", 1, {
      hostId: this.task.hostId, conversationId: this.task.threadId, following,
    }, this.ownerId);
  }

  private validateSource(state: IpcObject): void {
    if (this.task.sourceId && !this.task.rolloutPath) throw new DesktopUnavailableError("Выбранный каталог не сообщил путь её истории. Обнови список задач и повтори команду.");
    if (!this.task.rolloutPath) return;
    const actual = typeof state.rolloutPath === "string" ? state.rolloutPath : null;
    if (actual && sameRolloutSource(this.task.rolloutPath, actual)) {
      this.sourceVerified = true;
      this.sourceRefreshRequested = false;
      this.sourceProblem = null;
      if (this.sourceTimer) { clearTimeout(this.sourceTimer); this.sourceTimer = null; }
      return;
    }
    // Once this owner and rollout were verified, reduced snapshots remain part
    // of the same stream. A conflicting path still requires a fresh snapshot.
    if (!actual && this.sourceVerified && !this.sourceRefreshRequested) return;
    this.sourceProblem = actual ? "mismatch" : "missing";
    if (this.sourceRefreshRequested) throw this.sourceError();
    this.sourceRefreshRequested = true;
    throw new SourceRefreshRequired();
  }

  private sourceError(): DesktopUnavailableError {
    return new DesktopUnavailableError(this.sourceProblem === "mismatch"
      ? "Десктоп подтвердил подключение к другой копии задачи. Открой задачу из выбранного каталога Codex; команда не отправлена."
      : "Десктоп не сообщил путь истории задачи. Открой выбранную копию задачи в Codex и повтори команду.");
  }

  close(error = new DesktopUnavailableError("Подписка на задачу отменена.")): void {
    if (this.closed) return;
    this.closed = true;
    this.lastFailure = error;
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    if (this.sourceTimer) { clearTimeout(this.sourceTimer); this.sourceTimer = null; }
    this.cancelStart?.(error); this.cancelStart = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.disconnect?.(); this.disconnect = null;
    // The desktop owner currently treats following as task-wide rather than
    // follower-scoped. A short-lived command subscription must therefore leave
    // following enabled, otherwise closing it also silences the durable mirror.
    if (this.notifyOwnerOnClose) {
      try { this.follow(false); } catch { /* The socket may already be closed. */ }
    }
    this.ownerId = null;
    this.state.reset();
  }
}
