import { isDeepStrictEqual } from 'node:util';
import type { RequestFrame } from './app-server-request-inbox.js';

type Row = Record<string, unknown>;
const routes = new Map([
  ['thread-follower-command-approval-decision', 'item/commandExecution/requestApproval'],
  ['thread-follower-file-approval-decision', 'item/fileChange/requestApproval'],
  ['thread-follower-permissions-request-approval-response', 'item/permissions/requestApproval'],
  ['thread-follower-submit-user-input', 'item/tool/requestUserInput'],
]);
const simpleDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string | number =>
  typeof value === 'string' && value.length > 0 ||
  typeof value === 'number' && Number.isSafeInteger(value);
function fail(): never { throw new TypeError('Native pending request is unavailable or reply is invalid'); }
function only(value: unknown, allowed: readonly string[], required: readonly string[] = []): asserts value is Row {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail();
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail();
}
function jsonCopy<T>(value: T): T {
  try {
    const snapshot = structuredClone(value);
    const encoded = JSON.stringify(snapshot, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
          typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) fail();
      return item;
    });
    if (!encoded || Buffer.byteLength(encoded) > 1024 * 1024) fail();
    const decoded: unknown = JSON.parse(encoded);
    if (!isDeepStrictEqual(snapshot, decoded)) fail();
    return decoded as T;
  } catch { return fail(); }
}
function pathEntry(value: unknown): void {
  only(value, ['path', 'access'], ['path', 'access']);
  if (!['read', 'write', 'deny'].includes(value.access as string)) fail();
  const path = value.path;
  if (!object(path)) fail();
  if (path.type === 'path') {
    only(path, ['type', 'path'], ['type', 'path']);
    if (typeof path.path !== 'string') fail();
  } else if (path.type === 'glob_pattern') {
    only(path, ['type', 'pattern'], ['type', 'pattern']);
    if (typeof path.pattern !== 'string') fail();
  } else if (path.type === 'special') {
    only(path, ['type', 'value'], ['type', 'value']);
    const special = path.value;
    if (!object(special)) fail();
    if (['root', 'minimal', 'tmpdir', 'slash_tmp'].includes(special.kind as string))
      only(special, ['kind'], ['kind']);
    else if (special.kind === 'project_roots' || special.kind === 'unknown') {
      only(special, special.kind === 'unknown' ? ['kind', 'path', 'subpath'] : ['kind', 'subpath'],
        ['kind', 'subpath', ...(special.kind === 'unknown' ? ['path'] : [])]);
      if (!(special.subpath === null || typeof special.subpath === 'string') ||
          special.kind === 'unknown' && typeof special.path !== 'string') fail();
    } else fail();
  } else fail();
}
function fileSystem(value: unknown): asserts value is Row {
  only(value, ['read', 'write', 'globScanMaxDepth', 'entries'], ['read', 'write']);
  for (const key of ['read', 'write']) if (value[key] !== null) strings(value[key]);
  if (Object.hasOwn(value, 'globScanMaxDepth') &&
      !(typeof value.globScanMaxDepth === 'number' && Number.isSafeInteger(value.globScanMaxDepth) && value.globScanMaxDepth >= 0)) fail();
  if (Object.hasOwn(value, 'entries')) {
    if (!Array.isArray(value.entries)) fail();
    value.entries.forEach(pathEntry);
  }
}
function permissionProfile(value: unknown, granted: boolean): asserts value is Row {
  // Generated RequestPermissionProfile has both keys, but recorded pending
  // requests may be sparse; omission grants no authority to the response.
  only(value, ['network', 'fileSystem']);
  for (const key of ['network', 'fileSystem']) {
    if (!Object.hasOwn(value, key) || value[key] === null && !granted) continue;
    if (key === 'network') {
      only(value[key], ['enabled'], ['enabled']);
      if (!(value[key].enabled === null || typeof value[key].enabled === 'boolean')) fail();
    } else fileSystem(value[key]);
  }
}
function boundGrant(actual: Row, requested: Row): void {
  const network = actual.network, offeredNetwork = requested.network;
  if (object(network) && network.enabled === true &&
      (!object(offeredNetwork) || offeredNetwork.enabled !== true)) fail();
  if (object(network) && network.enabled === null &&
      (!object(offeredNetwork) || offeredNetwork.enabled !== null)) fail();
  const file = actual.fileSystem, offered = requested.fileSystem;
  if (!object(file)) return;
  if (!object(offered)) fail();
  for (const key of ['read', 'write']) {
    const current = file[key], permitted = offered[key];
    if (current === null) { if (permitted !== null) fail(); continue; }
    if (!Array.isArray(current) || !Array.isArray(permitted) ||
        current.some(path => !permitted.includes(path))) fail();
  }
  if (Object.hasOwn(file, 'globScanMaxDepth') && file.globScanMaxDepth !== offered.globScanMaxDepth) fail();
  if (Array.isArray(file.entries) && file.entries.some(entry =>
    !Array.isArray(offered.entries) || !offered.entries.some(value => isDeepStrictEqual(entry, value)))) fail();
  // Null or empty allow-lists do not prove that dropped exclusions are inert.
  if (Object.hasOwn(offered, 'globScanMaxDepth') && file.globScanMaxDepth !== offered.globScanMaxDepth) fail();
  if (Array.isArray(offered.entries) && offered.entries.some(entry => object(entry) && entry.access === 'deny' &&
    (!Array.isArray(file.entries) || !file.entries.some(value => isDeepStrictEqual(entry, value))))) fail();
}

/** Pure native follower reply validation. The caller retains settlement and generation authority. */
export function compileNativeRequestResponse(ipcMethod: string, params: Row,
  pending: RequestFrame): Row {
  const input = jsonCopy({ ipcMethod, params, pending });
  if (!object(input.params) || !object(input.pending) ||
      !validId(input.pending.id) || !validId(input.params.requestId) ||
      input.pending.id !== input.params.requestId ||
      routes.get(input.ipcMethod) !== input.pending.method ||
      !object(input.pending.params) || typeof input.pending.params.threadId !== 'string' ||
      !input.pending.params.threadId || input.params.conversationId !== input.pending.params.threadId ||
      input.params.hostId !== undefined && input.params.hostId !== 'local') fail();
  const response = input.ipcMethod === 'thread-follower-submit-user-input' ||
    input.ipcMethod === 'thread-follower-permissions-request-approval-response';
  only(input.params, response ? ['conversationId', 'hostId', 'requestId', 'response'] :
    ['conversationId', 'hostId', 'requestId', 'decision'],
  response ? ['conversationId', 'requestId', 'response'] : ['conversationId', 'requestId', 'decision']);
  if (input.pending.method === 'item/tool/requestUserInput') {
    only(input.params.response, ['answers'], ['answers']);
    if (!object(input.params.response.answers)) fail();
    if (!Array.isArray(input.pending.params.questions) ||
        input.pending.params.questions.some(question => !object(question) || typeof question.id !== 'string')) fail();
    const ids = new Set(input.pending.params.questions.map(question => (question as Row).id));
    if (ids.size !== input.pending.params.questions.length) fail();
    for (const [id, answer] of Object.entries(input.params.response.answers)) {
      if (!ids.has(id)) fail();
      only(answer, ['answers'], ['answers']); strings(answer.answers);
    }
    return jsonCopy(input.params.response);
  }
  if (input.pending.method === 'item/permissions/requestApproval') {
    only(input.params.response, ['permissions', 'scope', 'strictAutoReview'], ['permissions', 'scope']);
    if (!['turn', 'session'].includes(input.params.response.scope as string) ||
        Object.hasOwn(input.params.response, 'strictAutoReview') && typeof input.params.response.strictAutoReview !== 'boolean') fail();
    permissionProfile(input.params.response.permissions, true);
    permissionProfile(input.pending.params.permissions, false);
    boundGrant(input.params.response.permissions as Row, input.pending.params.permissions as Row);
    return jsonCopy(input.params.response);
  }
  const decision = input.params.decision;
  if (!simpleDecisions.has(decision as string)) {
    if (input.pending.method !== 'item/commandExecution/requestApproval') fail();
    only(decision, ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment']);
    if (Object.keys(decision).length !== 1) fail();
    if (Object.hasOwn(decision, 'acceptWithExecpolicyAmendment')) {
      only(decision.acceptWithExecpolicyAmendment, ['execpolicy_amendment'], ['execpolicy_amendment']);
      strings(decision.acceptWithExecpolicyAmendment.execpolicy_amendment);
    } else {
      only(decision.applyNetworkPolicyAmendment, ['network_policy_amendment'], ['network_policy_amendment']);
      only(decision.applyNetworkPolicyAmendment.network_policy_amendment, ['host', 'action'], ['host', 'action']);
      const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
      if (typeof amendment.host !== 'string' || !['allow', 'deny'].includes(amendment.action as string)) fail();
    }
  }
  const offered = input.pending.params.availableDecisions;
  if (offered !== undefined && (!Array.isArray(offered) ||
      !offered.some(value => isDeepStrictEqual(value, decision)))) fail();
  return { decision: jsonCopy(decision) };
}
