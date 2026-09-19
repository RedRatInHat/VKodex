import type { TaskRef } from "../core/codex-tasks.js";
import type { TaskStateStream, TaskStateTransport } from "../core/task-state.js";
import { DesktopIpcClient } from "./ipc-client.js";
import { TaskSubscription } from "./subscription.js";

export type { TaskStateConnectionFailure, TaskStateStream, TaskStateTransport } from "../core/task-state.js";
export { TaskStateConnections } from "../core/task-state.js";

export class DesktopTaskStateTransport implements TaskStateTransport {
  constructor(private readonly client = new DesktopIpcClient()) {}

  subscribe(task: TaskRef, onState: (state: Record<string, unknown>, initial: boolean) => void, onError: (error: Error) => void): TaskStateStream {
    return new TaskSubscription(this.client, task, onState, onError);
  }

  close(): void { this.client.close(); }
}
