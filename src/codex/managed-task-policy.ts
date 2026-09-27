import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

type Row = Record<string, unknown>;
export interface ApprovedTaskPolicy {
  readonly threadId: string;
  readonly model: string;
  readonly modelProvider: string;
  readonly effort: string | null;
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly environments: readonly Readonly<{ environmentId: 'local'; cwd: string;
    runtimeWorkspaceRoots: readonly string[] }>[];
  readonly approvalPolicy: 'never' | 'on-request' | 'untrusted';
  readonly approvalsReviewer: 'user' | 'auto_review' | 'guardian_subagent';
  readonly activePermissionProfile: Readonly<{ id: string; extends: string | null }>;
  readonly sandbox: Readonly<{ type: 'readOnly'; networkAccess: boolean } |
    { type: 'workspaceWrite'; writableRoots: readonly string[]; networkAccess: boolean;
      excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }>;
  readonly serviceTier: string | null;
}

const invalid = (): never => { throw new TypeError('Approved task policy is invalid'); };
const mismatch = (): never => { throw new TypeError('Native effective resume differs from approved task policy'); };
function row(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Row, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every(key => Object.hasOwn(value, key));
}
function atom(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}
function profileId(value: unknown): value is string {
  return atom(value) || typeof value === 'string' && value.length > 1 &&
    value.length <= 128 && /^:[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}
function absolute(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 &&
    path.win32.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}
function samePath(a: unknown, b: unknown): boolean {
  return absolute(a) && absolute(b) &&
    path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}
function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(absolute) &&
    new Set(value.map(item => path.win32.normalize(item).toLowerCase())).size === value.length;
}
function samePaths(a: unknown, b: readonly string[]): boolean {
  return paths(a) && a.length === b.length && a.every((item, index) => samePath(item, b[index]));
}
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
function environments(value: unknown, cwd: string, roots: readonly string[]): boolean {
  return Array.isArray(value) && value.length <= 1 && value.every(item =>
    row(item) && keys(item, ['environmentId', 'cwd', 'runtimeWorkspaceRoots']) &&
    item.environmentId === 'local' && samePath(item.cwd, cwd) &&
    samePaths(item.runtimeWorkspaceRoots, roots));
}
function sandbox(value: unknown, cwd: string): boolean {
  if (!row(value)) return false;
  if (value.type === 'readOnly') return keys(value, ['type', 'networkAccess']) &&
    typeof value.networkAccess === 'boolean';
  if (value.type === 'workspaceWrite') return keys(value, ['type', 'writableRoots',
    'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp']) &&
    paths(value.writableRoots) && value.writableRoots.length === 1 &&
    samePath(value.writableRoots[0], cwd) && typeof value.networkAccess === 'boolean' &&
    typeof value.excludeTmpdirEnvVar === 'boolean' && typeof value.excludeSlashTmp === 'boolean';
  return false;
}
function sameSandbox(value: unknown, approved: ApprovedTaskPolicy['sandbox']): boolean {
  if (!row(value) || value.type !== approved.type) return false;
  if (approved.type === 'readOnly') return keys(value, ['type', 'networkAccess']) &&
    value.networkAccess === approved.networkAccess;
  return keys(value, ['type', 'writableRoots', 'networkAccess',
    'excludeTmpdirEnvVar', 'excludeSlashTmp']) &&
    samePaths(value.writableRoots, approved.writableRoots) &&
    value.networkAccess === approved.networkAccess &&
    value.excludeTmpdirEnvVar === approved.excludeTmpdirEnvVar &&
    value.excludeSlashTmp === approved.excludeSlashTmp;
}

/** Snapshots an explicit owner intention. It is not a writer capability or ownership proof. */
export function approveTaskPolicy(input: unknown): ApprovedTaskPolicy {
  if (!row(input) || !keys(input, ['threadId', 'model', 'modelProvider', 'effort', 'cwd',
    'runtimeWorkspaceRoots', 'environments', 'approvalPolicy', 'approvalsReviewer',
    'activePermissionProfile', 'sandbox', 'serviceTier']) ||
    typeof input.threadId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.threadId) ||
    !atom(input.model) || !atom(input.modelProvider) ||
    input.effort !== null && !atom(input.effort, 64) || !absolute(input.cwd) ||
    !paths(input.runtimeWorkspaceRoots) || input.runtimeWorkspaceRoots.length !== 1 ||
    !samePath(input.runtimeWorkspaceRoots[0], input.cwd) ||
    !environments(input.environments, input.cwd, input.runtimeWorkspaceRoots) ||
    typeof input.approvalPolicy !== 'string' ||
    !['never', 'on-request', 'untrusted'].includes(input.approvalPolicy) ||
    typeof input.approvalsReviewer !== 'string' ||
    !['user', 'auto_review', 'guardian_subagent'].includes(input.approvalsReviewer) ||
    !row(input.activePermissionProfile) ||
    !keys(input.activePermissionProfile, ['id', 'extends']) ||
    !profileId(input.activePermissionProfile.id) ||
    input.activePermissionProfile.extends !== null && !profileId(input.activePermissionProfile.extends) ||
    !sandbox(input.sandbox, input.cwd) ||
    input.serviceTier !== null && !atom(input.serviceTier, 64)) invalid();
  const cloned: unknown = structuredClone(input);
  if (!row(cloned) || !isDeepStrictEqual(input, cloned)) invalid();
  return freezeTree(cloned) as unknown as ApprovedTaskPolicy;
}

/** Compares a native v2 thread/resume effective result; it never admits a command.
 * `policy` must be the immutable value returned by `approveTaskPolicy`, not an
 * arbitrary frontend or historical-turn object. Physical ownership is separate. */
export function assertEffectiveResume(policy: ApprovedTaskPolicy, effective: unknown): void {
  if (!row(effective) || !row(effective.thread) ||
    effective.thread.id !== policy.threadId ||
    !row(effective.thread.status) || effective.thread.status.type !== 'idle' ||
    effective.model !== policy.model || effective.modelProvider !== policy.modelProvider ||
    effective.reasoningEffort !== policy.effort ||
    !samePath(effective.cwd, policy.cwd) ||
    !samePaths(effective.runtimeWorkspaceRoots, policy.runtimeWorkspaceRoots) ||
    effective.approvalPolicy !== policy.approvalPolicy ||
    effective.approvalsReviewer !== policy.approvalsReviewer ||
    !isDeepStrictEqual(effective.activePermissionProfile, policy.activePermissionProfile) ||
    !sameSandbox(effective.sandbox, policy.sandbox) ||
    effective.serviceTier !== policy.serviceTier ||
    effective.thread.model !== policy.model ||
    effective.thread.modelProvider !== policy.modelProvider ||
    effective.thread.reasoningEffort !== policy.effort ||
    !samePath(effective.thread.cwd, policy.cwd) ||
    !environments(effective.thread.environments, policy.cwd, policy.runtimeWorkspaceRoots) ||
    (effective.thread.environments as unknown[]).length !== policy.environments.length) mismatch();
}
