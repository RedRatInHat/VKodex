import type { TaskRef } from "./contracts.js";
import { DesktopIpcClient, type IpcObject } from "./ipc-client.js";
import { TaskSubscription } from "./subscription.js";

/** A task-scoped state stream owned by one Codex client. */
export interface TaskStateStream {
  readonly task: TaskRef;
  start(timeoutMs?: number): Promise<void>;
  verifyOwner(timeoutMs?: number): Promise<void>;
  close(): void;
}

/**
 * Transport boundary used by the bridge core. Implementations own connection,
 * owner discovery and stream protocol details; the core only consumes states.
 */
export interface TaskStateTransport {
  subscribe(task: TaskRef, onState: (state: IpcObject, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream;
  close(): void;
}

export class DesktopTaskStateTransport implements TaskStateTransport {
  constructor(private readonly client = new DesktopIpcClient()) {}

  subscribe(task: TaskRef, onState: (state: IpcObject, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream {
    return new TaskSubscription(this.client, task, onState, onError);
  }

  close(): void { this.client.close(); }
}
