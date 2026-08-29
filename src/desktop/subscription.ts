import { DesktopUnavailableError, TaskNotOpenError, type TaskRef } from "./contracts.js";
import { DesktopIpcClient, isObject, type IpcObject } from "./ipc-client.js";
import { RevisionedState } from "./state.js";
import { comparablePath } from "./paths.js";

export class TaskSubscription {
  private readonly state = new RevisionedState();
  private ownerId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private disconnect: (() => void) | null = null;
  private closed = true;
  private recovering = false;
  private generation = 0;
  private cancelStart: ((error: Error) => void) | null = null;

  constructor(
    private readonly client: DesktopIpcClient,
    readonly task: TaskRef,
    private readonly onState: (state: IpcObject, initial: boolean) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  get current(): IpcObject | null { return this.state.current; }
  get owner(): string | null { return this.ownerId; }

  async start(timeoutMs = 5_000): Promise<void> {
    if (!this.closed) throw new Error("Subscription is already active");
    this.closed = false;
    const generation = ++this.generation;
    const checkActive = (): void => {
      if (this.closed || this.generation !== generation) throw new DesktopUnavailableError("Подписка на задачу отменена.");
    };
    try {
      await this.client.connect();
      checkActive();
      const reply = await this.client.request("thread-owner-discovery", 1, {
        hostId: this.task.hostId, conversationId: this.task.threadId,
      }, { timeoutMs });
      checkActive();
      if (typeof reply.handledByClientId !== "string") throw new TaskNotOpenError();
      this.ownerId = reply.handledByClientId;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.close(new DesktopUnavailableError("Не получено состояние задачи.")); }, timeoutMs);
        let ready = false;
        this.cancelStart = error => { clearTimeout(timer); reject(error); };
        this.disconnect = this.client.onDisconnect(error => {
          clearTimeout(timer);
          this.close(error);
          if (ready) this.onError(error); else reject(error);
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
          try {
            const initial = this.state.current === null;
            const state = this.state.accept(params.change);
            if (state.id !== this.task.threadId || state.hostId !== this.task.hostId) throw new Error("Unexpected task state");
            if ((this.task.sourceId && !this.task.rolloutPath) || (this.task.rolloutPath && (typeof state.rolloutPath !== "string" || comparablePath(state.rolloutPath) !== comparablePath(this.task.rolloutPath)))) {
              throw new DesktopUnavailableError("Десктоп подключён к другой копии задачи или не сообщил путь её истории. Открой задачу из выбранного каталога в Codex; команда не отправлена.");
            }
            this.recovering = false;
            this.onState(state, initial);
            if (!ready) { ready = true; clearTimeout(timer); this.cancelStart = null; resolve(); }
          } catch (error) {
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

  close(error = new DesktopUnavailableError("Подписка на задачу отменена.")): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelStart?.(error); this.cancelStart = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.disconnect?.(); this.disconnect = null;
    try { this.follow(false); } catch { /* The socket may already be closed. */ }
    this.ownerId = null;
    this.state.reset();
  }
}
