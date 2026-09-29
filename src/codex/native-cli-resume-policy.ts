import type { HomogeneousQueueSettings } from './homogeneous-queue-policy.js';

type JsonObject = Record<string, unknown>;
export type NativeCliResumePolicy = Pick<HomogeneousQueueSettings,
  'cwd' | 'runtimeWorkspaceRoots' | 'approvalPolicy' | 'approvalsReviewer' |
  'permissions' | 'sandboxPolicy' | 'model' | 'serviceTier' | 'effort'>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: JsonObject, expected: readonly string[]) =>
  Object.keys(value).sort().join('|') === [...expected].sort().join('|');
const fail = (): never => { throw new Error('Native CLI resume policy unavailable'); };

/** Extract only fields that the actual native ID-only resume response proves.
 * Composer summary/personality/collaboration defaults are deliberately absent;
 * a later owner projection must independently qualify them. */
export function qualifyNativeCliResumePolicy(result: unknown, taskId: string): NativeCliResumePolicy {
  if (!object(result) || !object(result.thread) ||
      typeof taskId !== 'string' || !taskId || result.thread.id !== taskId ||
      !object(result.thread.status) || result.thread.status.type !== 'idle' ||
      !Array.isArray(result.thread.turns) ||
      typeof result.model !== 'string' || !result.model ||
      result.thread.model !== result.model ||
      typeof result.reasoningEffort !== 'string' || !result.reasoningEffort ||
      result.thread.reasoningEffort !== result.reasoningEffort ||
      typeof result.cwd !== 'string' || !result.cwd || result.thread.cwd !== result.cwd ||
      !Array.isArray(result.runtimeWorkspaceRoots) ||
      result.runtimeWorkspaceRoots.length !== 1 ||
      result.runtimeWorkspaceRoots[0] !== result.cwd ||
      result.approvalPolicy !== 'never' || result.approvalsReviewer !== 'user' ||
      result.serviceTier !== 'default' && result.serviceTier !== null ||
      !object(result.sandbox) || !keys(result.sandbox, ['type', 'networkAccess']) ||
      result.sandbox.type !== 'readOnly' || result.sandbox.networkAccess !== false ||
      !object(result.activePermissionProfile) ||
      !keys(result.activePermissionProfile, ['id', 'extends']) ||
      result.activePermissionProfile.id !== ':read-only' ||
      result.activePermissionProfile.extends !== null ||
      !Array.isArray(result.thread.environments) ||
      result.thread.environments.length !== 1) return fail();
  const env: unknown = result.thread.environments[0];
  if (!object(env) || !keys(env, ['environmentId', 'cwd', 'runtimeWorkspaceRoots']) ||
      env.environmentId !== 'local' || env.cwd !== result.cwd ||
      !Array.isArray(env.runtimeWorkspaceRoots) ||
      env.runtimeWorkspaceRoots.length !== 1 ||
      env.runtimeWorkspaceRoots[0] !== result.cwd) return fail();
  return Object.freeze({ cwd: result.cwd as string,
    runtimeWorkspaceRoots: Object.freeze([result.cwd as string]),
    approvalPolicy: 'never', approvalsReviewer: 'user',
    permissions: ':read-only',
    sandboxPolicy: Object.freeze({ type: 'readOnly', networkAccess: false }),
    model: result.model as string, serviceTier: result.serviceTier as 'default' | null,
    effort: result.reasoningEffort as string });
}
