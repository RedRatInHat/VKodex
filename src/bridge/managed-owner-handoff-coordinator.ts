import { isDeepStrictEqual } from 'node:util';
import type { TaskRef } from '../core/codex-tasks.js';
import { validManagedWorkerHandoffProof, type ManagedWorkerHandoffScope } from
  '../desktop/managed-worker-control.js';
import type { BridgeStore, ManagedOwnerBinding } from './store.js';
import type { ManagedOwnerRouteResolver } from './managed-owner-route-resolver.js';

type HandoffStore = Pick<BridgeStore, 'managedOwner' | 'transitionManagedOwner'>;
type HandoffResolver = Pick<ManagedOwnerRouteResolver, 'resolveHandoff'>;

const current = (store: HandoffStore, task: TaskRef, expected: ManagedOwnerBinding): boolean => {
  const claim = store.managedOwner(task);
  return claim !== null && isDeepStrictEqual(claim, expected);
};

/** Begin a worker-to-native handoff without granting a replacement writer.
 * The worker must close ingress before quiescence proof, and the exact durable
 * claim remains exclusive through every uncertain or failed outcome. A later
 * stage must separately prove release and reconcile receipts before retirement. */
export class ManagedOwnerHandoffCoordinator {
  constructor(private readonly store: HandoffStore, private readonly resolver: HandoffResolver) {}

  async beginHandoff(task: TaskRef): Promise<ManagedOwnerBinding> {
    const claim = this.store.managedOwner(task);
    if (!claim || claim.state !== 'ready' || claim.hostId !== task.hostId ||
      claim.threadId !== task.threadId || claim.sourceId !== (task.sourceId ?? ''))
      throw new Error('Managed owner handoff unavailable');
    const evidence = claim.evidence;
    if (evidence.backendGeneration === null || evidence.registryRevision === null ||
      evidence.endpointRef === null || evidence.host === null || evidence.backend === null)
      throw new Error('Managed owner handoff proof incomplete');
    const route = await this.resolver.resolveHandoff(task);
    if (route.kind !== 'statically-qualified' ||
      !isDeepStrictEqual(route.claim, claim) ||
      !current(this.store, task, claim)) throw new Error('Managed owner handoff route changed');

    const scope: ManagedWorkerHandoffScope = Object.freeze({
      backendGeneration: evidence.backendGeneration, registryRevision: evidence.registryRevision,
    });
    // The remote call may time out after the worker has closed ingress. Never
    // infer failure from that timeout or release the exclusive claim.
    const revoked = await route.revokeIngress(scope);
    if (!isDeepStrictEqual(revoked, scope) || !current(this.store, task, claim))
      throw new Error('Managed owner handoff revoke unconfirmed or claim changed');
    const proof = await route.qualify(scope);
    if (!validManagedWorkerHandoffProof(proof, claim.ownerEpoch, claim.threadId, scope) ||
      proof.endpointRef !== evidence.endpointRef ||
      !isDeepStrictEqual(proof.host, evidence.host) ||
      !isDeepStrictEqual({ pid: proof.backend.pid, birthTicks: proof.backend.birthTicks },
        evidence.backend)) throw new Error('Managed owner handoff proof mismatch');
    if (!current(this.store, task, claim)) throw new Error('Managed owner handoff claim changed');
    return this.store.transitionManagedOwner(claim, 'handoff_pending', {
      backendGeneration: proof.backendGeneration, registryRevision: proof.registryRevision,
      endpointRef: proof.endpointRef, host: proof.host,
      backend: { pid: proof.backend.pid, birthTicks: proof.backend.birthTicks },
    });
  }
}
