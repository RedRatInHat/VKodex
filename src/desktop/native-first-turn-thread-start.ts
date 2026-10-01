import { createHmac } from 'node:crypto';
import path from 'node:path';
import { pinnedDetachedProfileBackendHome, pinnedDetachedProfileBackendIdentity,
  type PinnedDetachedProfileRpc } from '../codex/detached-profile-capability.js';
import { compileControlledNativeStartParams,
  type PolicyTemplate } from './controlled-native-task-creator.js';
import { NativeFirstTurnBootstrapJournal, type NativeFirstTurnBootstrapIdentity } from
  './native-first-turn-bootstrap-journal.js';
import { loadNativeFirstTurnPrivateKey } from './native-first-turn-private-key.js';
import { assertAuthenticatedProfileSourcePreflightForWrite,
  assertAuthenticatedProfileSourceReceiptForWrite,
  persistAuthenticatedProfileSourcePreflightReceipt,
  type AuthenticatedProfileSourcePreflight } from './controlled-native-source-proof.js';

type StartIdentity = Omit<NativeFirstTurnBootstrapIdentity, 'threadStartFingerprint'>;
type StartParams = ReturnType<typeof compileControlledNativeStartParams>;
const issued = new WeakSet<object>();
const production = new WeakMap<object, NativeFirstThreadProductionAuthority>();
const fail = (): never => { throw new Error('Native first thread/start unqualified'); };
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
function fingerprint(scope: StartIdentity, params: StartParams,
  policy: PolicyTemplate, key: Uint8Array): string {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32 ||
      !/^[a-f0-9]{64}$/u.test(scope.backendIdentity)) fail();
  const encoded = JSON.stringify([scope.operationId, scope.sourceId,
    scope.sourceGeneration, scope.ownerEpoch, scope.backendIdentity, params, policy]);
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) fail();
  return createHmac('sha256', key).update('vkodex-native-first-thread-start-v1\0')
    .update(encoded).digest('hex');
}

export interface NativeFirstThreadStartPrepared {
  readonly identity: NativeFirstTurnBootstrapIdentity;
  readonly params: StartParams;
  readonly requestedPolicy: PolicyTemplate;
}
export interface NativeFirstThreadProductionAuthority {
  readonly journal: NativeFirstTurnBootstrapJournal;
  readonly rpc: PinnedDetachedProfileRpc;
  readonly preflight: AuthenticatedProfileSourcePreflight;
  readonly backendGeneration: number;
  readonly sourceHome: string;
  readonly workspace: string;
  readonly preflightReceiptPath: string;
}
/** Consuming a preparation only retires its in-process token. No native RPC. */
export function consumePreparedNativeFirstThreadStart(prepared: NativeFirstThreadStartPrepared): boolean {
  return !!prepared && issued.delete(prepared);
}

/** Production-only canary claim. An offline key or injected RPC cannot mint it. */
export function consumeProductionPreparedNativeFirstThreadStart(
  prepared: NativeFirstThreadStartPrepared): NativeFirstThreadProductionAuthority | null {
  const authority = production.get(prepared);
  if (!authority || !consumePreparedNativeFirstThreadStart(prepared)) return null;
  production.delete(prepared);
  return authority;
}

/** A separate durable intent precedes the only possible native thread/start.
 * The caller must have captured source preflight and established a private
 * directory before opening this journal; this phase does no native RPC. */
export function prepareNativeFirstThreadStartWithKey(journal: NativeFirstTurnBootstrapJournal,
  identity: StartIdentity, requestedPolicy: PolicyTemplate,
  key: Uint8Array): NativeFirstThreadStartPrepared {
  const params = compileControlledNativeStartParams(requestedPolicy);
  const policy = freezeTree(structuredClone(requestedPolicy));
  if (policy.activePermissionProfile.id !== ':read-only' ||
      policy.sandbox.type !== 'readOnly' || policy.sandbox.networkAccess !== false ||
      policy.approvalPolicy !== 'never') return fail();
  const complete = Object.freeze({ ...identity,
    threadStartFingerprint: fingerprint(identity, params, policy, key) });
  journal.persistThreadStartIntent(complete);
  const prepared = Object.freeze({ identity: complete, params, requestedPolicy: policy });
  issued.add(prepared);
  return prepared;
}

/** Production preparation accepts no caller-provided backend digest. It
 * derives one from a live, dependency-free production-pinned connector,
 * verifies the v3 physical source, then loads the existing DPAPI key and
 * persists the exact source receipt. It makes no native mutation and does
 * not confer authority over an existing task or a model turn. */
export async function prepareNativeFirstThreadStart(journal: NativeFirstTurnBootstrapJournal,
  scope: Omit<StartIdentity, 'backendIdentity'>, requestedPolicy: PolicyTemplate,
  rpc: PinnedDetachedProfileRpc,
  preflight: AuthenticatedProfileSourcePreflight): Promise<NativeFirstThreadStartPrepared> {
  const session = await rpc.initializedSession();
  const backendIdentity = pinnedDetachedProfileBackendIdentity(rpc, session.generation);
  const sourceHome = pinnedDetachedProfileBackendHome(rpc, session.generation);
  const sourceIdentity = { operationId: scope.operationId, sourceId: scope.sourceId,
    sourceGeneration: scope.sourceGeneration };
  assertAuthenticatedProfileSourcePreflightForWrite(preflight, sourceIdentity,
    sourceHome, requestedPolicy.cwd);
  const key = await loadNativeFirstTurnPrivateKey(journal.directory());
  try {
    const preflightReceiptPath = path.join(journal.directory(), 'source-preflight.json');
    await persistAuthenticatedProfileSourcePreflightReceipt(preflightReceiptPath, preflight);
    // DPAPI loading is asynchronous. A disconnect during it must not strand a
    // freshly persisted one-shot intent for a session that no longer exists.
    if (pinnedDetachedProfileBackendIdentity(rpc, session.generation) !== backendIdentity) fail();
    assertAuthenticatedProfileSourcePreflightForWrite(preflight, sourceIdentity,
      sourceHome, requestedPolicy.cwd);
    assertAuthenticatedProfileSourceReceiptForWrite(preflightReceiptPath, preflight);
    const prepared = prepareNativeFirstThreadStartWithKey(journal,
      { ...scope, backendIdentity }, requestedPolicy, key);
    production.set(prepared, Object.freeze({ journal, rpc, preflight,
      backendGeneration: session.generation, sourceHome, workspace: requestedPolicy.cwd,
      preflightReceiptPath }));
    return prepared;
  }
  finally { key.fill(0); }
}
