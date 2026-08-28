import { SessionBusyError } from "./errors.js";

interface ActiveTurn {
  readonly controller: AbortController;
}

export class TurnCoordinator {
  private readonly active = new Map<string, ActiveTurn>();

  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  async run<T>(sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active.has(sessionId)) throw new SessionBusyError();
    const controller = new AbortController();
    this.active.set(sessionId, { controller });
    try {
      return await task(controller.signal);
    } finally {
      this.active.delete(sessionId);
    }
  }

  stop(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }
}
