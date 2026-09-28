import { DesktopIpcClient, isObject, type DesktopIpcConnectionIdentity } from './ipc-client.js';

export interface ManagedNativeOwnerConfirmationOptions {
  /** The connected client registered by the managed NativeOwner. It is never closed here. */
  readonly ownedClient: DesktopIpcClient;
  /** Creates an independent, read-only probe connection. */
  readonly createProbeClient: () => DesktopIpcClient;
  readonly taskId: string;
  /** Synchronous daemon/registry authority fence, rechecked after each await. */
  readonly assertOwnerCurrent: () => void;
}

function unavailable(): never { throw new Error('Managed native owner confirmation unavailable'); }
function sameIdentity(left: Readonly<DesktopIpcConnectionIdentity> | null,
  right: Readonly<DesktopIpcConnectionIdentity>): boolean {
  return left !== null && left.clientId === right.clientId && left.connectionEpoch === right.connectionEpoch;
}

/** Confirms that the broker presently selects this already-registered managed
 * owner for one exact local task. It has no follower, broadcast, or write path. */
export async function confirmManagedNativeOwner(options: ManagedNativeOwnerConfirmationOptions):
  Promise<Readonly<DesktopIpcConnectionIdentity>> {
  if (!options || !(options.ownedClient instanceof DesktopIpcClient) ||
      typeof options.createProbeClient !== 'function' || typeof options.taskId !== 'string' ||
      !options.taskId || typeof options.assertOwnerCurrent !== 'function') unavailable();
  const owned = options.ownedClient;
  const createProbeClient = options.createProbeClient;
  const taskId = options.taskId;
  const assertOwnerCurrent = options.assertOwnerCurrent;
  const initial = owned.connectionIdentity;
  if (initial === null) unavailable();
  const captured: Readonly<DesktopIpcConnectionIdentity> = initial;
  const assertCurrent = (): void => {
    try { assertOwnerCurrent(); } catch { unavailable(); }
    if (!sameIdentity(owned.connectionIdentity, captured)) unavailable();
  };
  assertCurrent();
  let probe: DesktopIpcClient | null = null;
  try {
    const candidate = createProbeClient();
    if (!(candidate instanceof DesktopIpcClient) || candidate === owned) unavailable();
    probe = candidate;
    await probe.connect();
    assertCurrent();
    const probeIdentity = probe.connectionIdentity;
    if (probeIdentity === null) unavailable();
    const reply = await probe.request('thread-owner-discovery', 1,
      { hostId: 'local', conversationId: taskId });
    assertCurrent();
    if (!sameIdentity(probe.connectionIdentity, probeIdentity) || !isObject(reply) || reply.resultType !== 'success' ||
        typeof reply.handledByClientId !== 'string' || reply.handledByClientId !== captured.clientId) unavailable();
    return captured;
  } catch {
    unavailable();
  } finally {
    if (probe !== null) {
      try { probe.close(); } catch { /* The probe is disposable and never owns the worker. */ }
    }
  }
  return unavailable();
}
