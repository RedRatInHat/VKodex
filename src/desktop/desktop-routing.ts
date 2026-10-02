import type { CodexTasks, TaskRef } from '../core/codex-tasks.js';
import { RoutedCodexTasks, type CodexTaskOwner } from '../core/codex-task-router.js';
import { PassiveTaskStateTransport, RoutedTaskStateTransport, type TaskStateOwnerRoute, type TaskStateTransport } from '../core/task-state.js';
import { ManagedOwnerExclusiveRouteGuard } from '../bridge/managed-owner-exclusive-guard.js';
import type { ManagedOwnerRouteObserver } from '../bridge/managed-owner-observed-task-state-transport.js';
import type { BridgeStore } from '../bridge/store.js';

type NativeRoute = CodexTaskOwner & TaskStateOwnerRoute;

/** Install the durable managed-claim fence in both command and state routing.
 * A claim without a qualified worker is unavailable, never a Desktop fallback. */
export function createDesktopRouting(baseTasks: CodexTasks, baseStates: TaskStateTransport,
  nativeOwners: readonly NativeRoute[], managedStore: Pick<BridgeStore, 'managedOwner'>,
  observer?: ManagedOwnerRouteObserver, preferNativeFallback?: (task: TaskRef) => Promise<boolean>):
  Readonly<{ tasks: CodexTasks; states: TaskStateTransport; passiveStates?: TaskStateTransport }> {
  const managed = new ManagedOwnerExclusiveRouteGuard(managedStore, observer);
  const owners = [managed, ...nativeOwners];
  return {
    tasks: new RoutedCodexTasks(baseTasks, owners),
    states: new RoutedTaskStateTransport(baseStates, owners, preferNativeFallback),
    ...(baseStates.readOnly === true ? { passiveStates: new PassiveTaskStateTransport(baseStates, owners) } : {}),
  };
}
