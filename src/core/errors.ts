export class UserFacingError extends Error {
  override readonly name: string = "UserFacingError";
}

export class SessionBusyError extends UserFacingError {
  override readonly name = "SessionBusyError";
  constructor() {
    super("Эта Codex-сессия уже выполняет задачу. Используйте /stop, чтобы прервать её.");
  }
}
