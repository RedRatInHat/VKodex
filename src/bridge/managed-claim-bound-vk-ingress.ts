import { isDeepStrictEqual } from 'node:util';
import { ActionRejectedError, UncertainActionError, type SubmitTaskReceipt, type SubmitTaskRequest,
  taskKey, type TaskRef, type QueuedSubmissionOutcome, type QueuedInputHistoryCursor, type QueuedInputHistoryScan } from '../core/codex-tasks.js';
import { ManagedStockVkOwner } from '../desktop/managed-stock-vk-owner.js';
import { ManagedWorkerControlRefusedError, ManagedWorkerControlUnknownError } from '../desktop/managed-worker-control-client.js';
import type { BridgeStore, ManagedOwnerBinding } from './store.js';
import type { ManagedOwnerIngress } from './managed-owner-exclusive-guard.js';
import type { ManagedOwnerIngressResolver } from './managed-owner-route-resolver.js';

const refuse = (): never => { throw new ActionRejectedError('Управляемый исполнитель не подтвердил маршрут отправки.'); };

/** The sole guard delegates here; this object never participates in owner selection.
 * Durable operation authority is reserved after local preparation and before opening a submit socket. */
export class ManagedClaimBoundVkIngress implements ManagedOwnerIngress {
  private readonly qualified = new Map<string, ManagedOwnerBinding>();
  constructor(private readonly store: BridgeStore, private readonly resolver: ManagedOwnerIngressResolver) {}

  isReady(task: TaskRef): boolean {
    const claim = this.qualified.get(taskKey(task));
    try { return !!claim && this.resolver.isCurrent(claim); } catch { return false; }
  }
  ownsOperation(task: TaskRef, operationId: string): boolean { return this.store.hasManagedOperationAuthority(task, operationId); }

  private async owner(task: TaskRef): Promise<ManagedStockVkOwner> {
    try {
      return await this.qualifyOwner(task);
    } catch {
      // Only read-only qualification ran here: no operation authority or submit
      // socket exists yet. A legacy capability refusal/timeout is not an unknown write.
      return refuse();
    }
  }
  private async qualifyOwner(task: TaskRef): Promise<ManagedStockVkOwner> {
    const initialClaim = this.store.managedOwner(task);
    if (!initialClaim) return refuse();
    const expectedGeneration = this.store.streamGeneration(initialClaim.bindingId);
    const resolved = await this.resolver.resolveIngress(task);
    if (resolved.kind !== 'statically-qualified' || !isDeepStrictEqual(resolved.claim, initialClaim) ||
      taskKey(resolved.claim) !== taskKey(task) || !this.resolver.isCurrent(resolved.claim)) return refuse();
    const admission = await resolved.client.ingressStatusClaimed(resolved.scope);
    const { capability: _capability, admissionOpen, ...observedScope } = admission;
    if (admissionOpen !== true || !isDeepStrictEqual(observedScope, resolved.scope) ||
      !this.resolver.isCurrent(resolved.claim)) return refuse();
    if (this.qualified.size >= 4096) this.qualified.clear();
    this.qualified.set(taskKey(task), resolved.claim);
    const { claimId: _claimId, claimRevision: _revision, ...workerScope } = resolved.scope;
    return new ManagedStockVkOwner({ binding: { hostId: 'local', threadId: task.threadId,
      sourceId: task.sourceId ?? '', ownerEpoch: resolved.scope.ownerEpoch },
    isReady: () => this.resolver.isCurrent(resolved.claim), isCurrent: () => this.resolver.isCurrent(resolved.claim),
    client: {
      submitVk: async request => {
        if (this.ownsOperation(task, request.operationId)) throw new ManagedWorkerControlUnknownError();
        try { this.store.captureManagedOperationAuthority(request.operationId, task, resolved.claim, expectedGeneration); }
        catch {
          if (this.ownsOperation(task, request.operationId)) throw new ManagedWorkerControlUnknownError();
          // Use the owner's known-refusal mapping: the CAS failed before any submit socket.
          throw new ManagedWorkerControlRefusedError();
        }
        const receipt = await resolved.client.submitVkClaimed(resolved.scope, request);
        this.store.rememberManagedQueueReceipt(task, request.operationId, receipt.submissionId);
        return receipt;
      },
      vkSubmissionStatusByOperationId: id => resolved.client.vkSubmissionStatusByOperationIdV2(workerScope, id),
    } });
  }
  async ensureOpen(task: TaskRef): Promise<void> { await (await this.owner(task)).ensureOpen(task); }
  async submitWithReceipt(request: SubmitTaskRequest): Promise<SubmitTaskReceipt> {
    if (this.ownsOperation(request.task, request.operationId)) throw new UncertainActionError();
    return (await this.owner(request.task)).submitWithReceipt(request);
  }
  private async original(task: TaskRef, operationId: string) {
    const authority = this.store.managedOperationAuthority(task, operationId);
    if (!authority) throw new UncertainActionError();
    const resolved = await this.resolver.resolveOutcome(authority);
    if (resolved.kind !== 'statically-qualified' || !isDeepStrictEqual(resolved.claim, authority.claim))
      throw new UncertainActionError();
    return resolved;
  }
  async findQueuedSubmissionOutcome(task: TaskRef, operationId: string): Promise<QueuedSubmissionOutcome | null> {
    const authority = this.store.managedOperationAuthority(task, operationId);
    if (!authority) throw new UncertainActionError();
    const receipt = this.store.managedQueueReceipt(operationId);
    if (receipt) return { state: 'accepted', submissionId: receipt.submissionId };
    const original = await this.original(task, operationId);
    const status = await original.client.vkSubmissionStatusByOperationIdV2(original.scope, operationId);
    if (status === null) return null;
    if (status.state === 'accepted' && status.submissionId) {
      this.store.rememberManagedQueueReceipt(task, operationId, status.submissionId);
      return { state: 'accepted', submissionId: status.submissionId };
    }
    return { state: status.state === 'rejected' ? 'rejected' : 'unknown' };
  }
  async scanTerminalQueuedInput(task: TaskRef, operationId: string, cursor: QueuedInputHistoryCursor | null): Promise<QueuedInputHistoryScan> {
    const original = await this.original(task, operationId);
    return original.client.scanTerminalQueuedInputV2(original.scope, operationId, cursor);
  }
}
