type Row = Record<string, unknown>;
export type NativeNextTurnSettingsCompilation =
  | Readonly<{ kind: 'condition-not-applied' }>
  | Readonly<{ kind: 'ready'; params: Readonly<{ threadId: string; model: string;
      effort: string | null; multiAgentMode?: 'explicitRequestOnly' }> }>;
/** Caller-qualified, same-generation idle evidence. The compiler cannot obtain
 * this from the streamed projection or authenticate its provenance. */
export interface NativeNextTurnIdleEvidence {
  readonly threadId: string;
  readonly terminalTurnIds: readonly string[];
  readonly pendingRequests: 0;
  readonly queuedFollowUps: 0;
  readonly backendQueueEmpty: true;
}

function unsupported(): never { throw new TypeError('Unsupported native next-turn settings update'); }
function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: Row, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function atom(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

/** Pure candidate compiler, not authorization or a durable mutation receipt.
 * Caller must separately prove owner/follower identity, generation, and the
 * effective policy before writing through a journaled single-writer path. */
export function compileNativeNextTurnSettings(
  incoming: unknown, projection: unknown, idleEvidence: unknown,
): NativeNextTurnSettingsCompilation {
  if (!object(incoming) || !object(projection) || !object(idleEvidence)) unsupported();
  const terminalTurnIds = idleEvidence.terminalTurnIds;
  if (!Array.isArray(terminalTurnIds)) unsupported();
  if (!only(incoming, ['type', 'requestId', 'sourceClientId',
      'hostId', 'method', 'version', 'params']) ||
    incoming.type !== undefined && incoming.type !== 'request' ||
    !atom(incoming.requestId) || !atom(incoming.sourceClientId) ||
    incoming.method !== 'thread-follower-update-thread-settings' || incoming.version !== 2 ||
    incoming.hostId !== undefined && incoming.hostId !== 'local' ||
    !object(incoming.params) || !only(incoming.params,
      ['conversationId', 'threadSettings', 'activeTurnId', 'condition', 'hostId']) ||
    incoming.params.hostId !== undefined && incoming.params.hostId !== 'local' ||
    incoming.params.conversationId !== projection.id || projection.hostId !== 'local' ||
    idleEvidence.threadId !== projection.id ||
    idleEvidence.pendingRequests !== 0 || idleEvidence.queuedFollowUps !== 0 ||
    idleEvidence.backendQueueEmpty !== true ||
    !atom(projection.id) ||
    incoming.params.activeTurnId !== undefined && incoming.params.activeTurnId !== null ||
    !object(projection.threadRuntimeStatus) || projection.threadRuntimeStatus.type !== 'idle' ||
    !object(projection.turnsPagination) || projection.turnsPagination.hasLoadedOldest !== true ||
    projection.turnsPagination.olderCursor !== null ||
    !Array.isArray(projection.requests) || projection.requests.length !== 0 ||
    Object.hasOwn(projection, 'nativeQueue') &&
      (!Array.isArray(projection.nativeQueue) || projection.nativeQueue.length !== 0) ||
    Object.hasOwn(projection, 'queuedFollowUps') &&
      (!Array.isArray(projection.queuedFollowUps) || projection.queuedFollowUps.length !== 0) ||
    !Array.isArray(projection.turns) ||
    projection.turns.length !== terminalTurnIds.length ||
    new Set(terminalTurnIds).size !== terminalTurnIds.length ||
    projection.turns.some((turn, index) => !object(turn) || !atom(turn.turnId) ||
      !['completed', 'failed', 'interrupted'].includes(turn.status as string) ||
      turn.turnId !== terminalTurnIds[index]) ||
    !atom(projection.latestModel) ||
    projection.latestReasoningEffort !== null && !atom(projection.latestReasoningEffort) ||
    !object(incoming.params.threadSettings) ||
    !only(incoming.params.threadSettings, ['model', 'effort', 'multiAgentMode']) ||
    !Object.hasOwn(incoming.params.threadSettings, 'model') ||
    !Object.hasOwn(incoming.params.threadSettings, 'effort') ||
    !atom(incoming.params.threadSettings.model) ||
    incoming.params.threadSettings.effort !== null && !atom(incoming.params.threadSettings.effort) ||
    Object.hasOwn(incoming.params.threadSettings, 'multiAgentMode') &&
      incoming.params.threadSettings.multiAgentMode !== 'explicitRequestOnly') unsupported();

  const condition = incoming.params.condition;
  if (condition !== undefined && condition !== null) {
    if (!object(condition) || !only(condition, ['ifModelEquals', 'ifEffortEquals']) ||
      Object.keys(condition).length === 0 ||
      Object.hasOwn(condition, 'ifModelEquals') && !atom(condition.ifModelEquals) ||
      Object.hasOwn(condition, 'ifEffortEquals') && condition.ifEffortEquals !== null &&
        !atom(condition.ifEffortEquals)) unsupported();
    if (condition.ifModelEquals !== undefined && condition.ifModelEquals !== projection.latestModel ||
        condition.ifEffortEquals !== undefined &&
          condition.ifEffortEquals !== projection.latestReasoningEffort)
      return Object.freeze({ kind: 'condition-not-applied' });
  }
  const settings = incoming.params.threadSettings;
  return Object.freeze({ kind: 'ready', params: Object.freeze({
    threadId: projection.id as string, model: settings.model as string,
    effort: settings.effort as string | null,
    ...(settings.multiAgentMode === undefined ? {} :
      { multiAgentMode: 'explicitRequestOnly' as const }),
  }) });
}
