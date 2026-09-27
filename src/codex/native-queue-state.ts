export interface QueueEntryIdentity {
  readonly id: string;
  readonly fingerprint: string;
}

export interface NativeQueueState {
  readonly currentPending: readonly QueueEntryIdentity[];
  readonly consumed: readonly QueueEntryIdentity[];
  readonly incoming: readonly QueueEntryIdentity[];
}

export type NativeQueueStateClassification = {
  readonly kind: "replay";
  readonly canonicalPendingIds: readonly string[];
  readonly strippedConsumedIds: readonly string[];
} | {
  readonly kind: "append";
  readonly canonicalPendingIds: readonly string[];
  readonly strippedConsumedIds: readonly string[];
  readonly newId: string;
};

const fingerprintPattern = /^[a-f0-9]{64}$/u;

function requireIdentity(row: unknown, kind: string): QueueEntryIdentity {
  if (row === null || typeof row !== "object" || Array.isArray(row) || Object.getPrototypeOf(row) !== Object.prototype) {
    throw new Error(`invalid ${kind} identity`);
  }
  const record = row as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== "fingerprint|id" ||
      typeof record.id !== "string" || !record.id ||
      typeof record.fingerprint !== "string" || !fingerprintPattern.test(record.fingerprint)) {
    throw new Error(`invalid ${kind} identity`);
  }
  return { id: record.id, fingerprint: record.fingerprint };
}

/**
 * Classifies a complete native queued-follow-up state using prevalidated,
 * canonical entry identities. It does not dispatch, persist, or acknowledge.
 */
export function classifyNativeQueueState(state: NativeQueueState): NativeQueueStateClassification {
  const { currentPending, consumed, incoming } = state as { currentPending?: unknown; consumed?: unknown; incoming?: unknown };
  if (!Array.isArray(currentPending) || !Array.isArray(consumed) || !Array.isArray(incoming)) {
    throw new Error("ordered identities required");
  }
  const pending = currentPending.map(row => requireIdentity(row, "pending"));
  const tombstones = consumed.map(row => requireIdentity(row, "consumed"));
  const offered = incoming.map(row => requireIdentity(row, "incoming"));
  const known = new Map<string, QueueEntryIdentity>();
  for (const row of [...pending, ...tombstones]) {
    if (known.has(row.id)) throw new Error("duplicate durable ID");
    known.set(row.id, row);
  }
  if (new Set(offered.map(row => row.id)).size !== offered.length) {
    throw new Error("duplicate incoming ID");
  }

  const consumedOrder = new Map(tombstones.map((row, index) => [row.id, index]));
  let offset = 0;
  let lastConsumedIndex = -1;
  const strippedConsumedIds: string[] = [];
  while (offset < offered.length) {
    const row = offered[offset]!;
    if (!consumedOrder.has(row.id)) break;
    const index = consumedOrder.get(row.id);
    if (index === undefined) throw new Error("consumed tombstone lookup failed");
    if (index <= lastConsumedIndex) throw new Error("consumed tombstone reorder");
    if (known.get(row.id)!.fingerprint !== row.fingerprint) {
      throw new Error("same-ID changed-body conflict");
    }
    strippedConsumedIds.push(row.id);
    lastConsumedIndex = index;
    offset++;
  }

  const remaining = offered.slice(offset);
  if (remaining.length < pending.length) throw new Error("pending omission or reorder");
  for (let index = 0; index < pending.length; index++) {
    const expected = pending[index]!;
    const actual = remaining[index]!;
    if (actual.id !== expected.id) {
      if (known.has(actual.id) && known.get(actual.id)!.fingerprint !== actual.fingerprint) {
        throw new Error("same-ID changed-body conflict");
      }
      throw new Error("pending omission or reorder");
    }
    if (actual.fingerprint !== expected.fingerprint) throw new Error("same-ID changed-body conflict");
  }

  const tail = remaining.slice(pending.length);
  if (tail.length > 1) throw new Error("multiple new entries unsupported");
  const next = tail[0];
  if (next !== undefined && known.has(next.id)) {
    if (known.get(next.id)!.fingerprint !== next.fingerprint) {
      throw new Error("same-ID changed-body conflict");
    }
    throw new Error("reused or out-of-order known ID");
  }

  const canonicalPendingIds = pending.map(row => row.id);
  if (next === undefined) return { kind: "replay", canonicalPendingIds, strippedConsumedIds };
  return { kind: "append", canonicalPendingIds: [...canonicalPendingIds, next.id], strippedConsumedIds, newId: next.id };
}
