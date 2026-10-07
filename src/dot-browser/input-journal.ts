import { createHash, randomUUID } from "node:crypto";
import { BridgeStore } from "../bridge/store.js";
import type { BridgeInput } from "../bridge/contracts.js";
import type { SubmissionObservation } from "./submission-observation.js";

export interface DotRoomInputScope {
  readonly peerId: number;
  readonly ownerId: number;
  readonly roomId: string;
  readonly generation: number;
}
export interface DotRoomInputAttempt {
  readonly operationId: string;
  readonly observerEpoch: string;
  readonly inputKey: string;
  readonly roomId: string;
}
export interface DotRoomInputResolution {
  /** Reference to a separately authenticated operator decision, never message text. */
  readonly decisionId: string;
  readonly kind: "confirmed-visible" | "release-without-retry";
  readonly messageId: string | null;
}
interface InputRecord {
  readonly version: 1;
  readonly digest: string;
  readonly phase: "received" | "attempted" | "observed" | "uncertain";
  readonly attempt: DotRoomInputAttempt | null;
  readonly messageId: string | null;
}
const opaque = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 &&
  !/[\x00-\x1f\x7f]/u.test(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Uses the existing bridge inbox, transaction boundary and restart uncertainty.
 * It creates no second input queue or DB. The caller must exclusively route the
 * configured peer here, authenticate transport inputs, and separately qualify
 * the browser. There is no network, browser command or production registration.
 */
export class DotRoomInputJournal {
  private readonly scope: DotRoomInputScope;
  private readonly prefix: string;
  constructor(private readonly store: BridgeStore, scope: DotRoomInputScope) {
    if (!Number.isSafeInteger(scope.peerId) || scope.peerId < 2_000_000_001 ||
        !Number.isSafeInteger(scope.ownerId) || scope.ownerId <= 0 ||
        !/^[a-f0-9]{32}$/u.test(scope.roomId) ||
        !Number.isSafeInteger(scope.generation) || scope.generation < 1) throw new TypeError("Invalid room input scope");
    if (store.databasePath === null || store.databaseFileIdentity === null)
      throw new Error("Room dispatch requires a regular file-backed bridge journal");
    this.scope = { ...scope };
    this.prefix = `dot-room-input:${hash(JSON.stringify([scope.peerId, scope.ownerId, scope.roomId, scope.generation]))}:`;
  }

  receive(input: BridgeInput, now = Date.now()): boolean {
    const key = this.inputKey(input), digest = this.digest(input);
    return this.store.atomic(() => {
      this.assertDedicatedPeer();
      const record = this.read(key);
      if (record) {
        if (record.digest !== digest) throw new Error("Input identity has conflicting contents");
        return false;
      }
      if (this.store.inputState(key) !== null) throw new Error("Input already belongs to another journal scope");
      this.store.setValue(`dot-room-input-scope:${this.scope.peerId}`, this.prefix);
      this.store.receiveInput(input, now);
      this.store.setValue(this.prefix + key, { version: 1, digest, phase: "received", attempt: null, messageId: null } satisfies InputRecord);
      return true;
    });
  }

  /** Commit this fence BEFORE starting a DOM watcher or touching the composer.
   * Repeated dispatch of the same input returns null; it never grants a retry.
   * The shared inbox keeps the original payload until terminal settlement.
   */
  dispatch(input: BridgeInput, observerEpoch: string): DotRoomInputAttempt | null {
    const key = this.inputKey(input), digest = this.digest(input);
    if (!opaque(observerEpoch)) throw new TypeError("Invalid observer epoch");
    this.store.requireDurableWrites();
    return this.store.atomic(() => {
      this.assertDedicatedPeer();
      const record = this.read(key);
      if (!record || record.digest !== digest) throw new Error("Input was not journaled with these contents");
      if (record.phase !== "received" || this.store.getValue(this.prefix + "active") !== null) return null;
      if (this.store.inputState(key) !== "received") throw new Error("Shared inbox state disagrees with room journal");
      if (!this.store.claimInput(key)) return null;
      this.store.markInputPreparing([key]);
      this.store.markInputSending([key]);
      if (this.store.inputState(key) !== "sending") throw new Error("Shared dispatch fence failed");
      const attempt: DotRoomInputAttempt = { operationId: randomUUID(), observerEpoch, inputKey: key, roomId: this.scope.roomId };
      this.store.setValue(this.prefix + key, { ...record, phase: "attempted", attempt } satisfies InputRecord);
      this.store.setValue(this.prefix + "active", key);
      this.store.setValue(this.prefix + "outbound-barriers", this.barriers() + 1);
      return attempt;
    });
  }

  settle(attempt: DotRoomInputAttempt, observation: SubmissionObservation): "observed" | "uncertain" {
    if (observation.phase !== "observed" && observation.phase !== "uncertain") throw new Error("Submission evidence is not terminal");
    return this.store.atomic(() => {
      this.assertDedicatedPeer();
      const record = this.read(attempt.inputKey);
      if (!record?.attempt || !this.sameAttempt(record.attempt, attempt)) throw new Error("Submission attempt does not match");
      if (record.phase === "uncertain") return "uncertain";
      if (record.phase === "observed") {
        if (observation.phase !== "observed" || record.messageId !== observation.messageId) throw new Error("Conflicting terminal receipt");
        return "observed";
      }
      if (record.phase !== "attempted" || this.store.getValue(this.prefix + "active") !== attempt.inputKey)
        throw new Error("No active fenced submission");
      const state = this.store.inputState(attempt.inputKey);
      if (state !== "sending" && state !== "uncertain") throw new Error("Shared inbox state disagrees with fenced submission");
      // The shared store marks abandoned sending operations uncertain at startup.
      // A late DOM observation cannot turn that recovered uncertainty into success.
      const observed = state === "sending" && observation.phase === "observed";
      if (observed && (!this.boundMessageId(observation.messageId) || observation.evidence !== "same-node-dom-transition"))
        throw new Error("Invalid visible-room receipt");
      const phase = observed ? "observed" : "uncertain";
      const messageId = observed ? observation.messageId : null;
      if (messageId) {
        const receiptKey = this.prefix + "message:" + messageId;
        const prior = this.store.getValue<string>(receiptKey);
        if (prior !== null && prior !== attempt.operationId) throw new Error("Message already belongs to another submission");
        this.store.setValue(receiptKey, attempt.operationId);
      }
      const barriers = this.barriers();
      if (barriers < 1) throw new Error("Missing outbound submission barrier");
      if (observed) this.store.setValue(this.prefix + "outbound-barriers", barriers - 1);
      this.store.finishInput(attempt.inputKey, !observed);
      this.store.setValue(this.prefix + attempt.inputKey, { ...record, phase, messageId } satisfies InputRecord);
      this.store.setValue(this.prefix + "active", null);
      return phase;
    });
  }

  /** Call after normal BridgeStore startup recovery, never to interrupt a live
   * dispatch. This only releases the local fence if the common inbox already
   * classified that exact operation as uncertain. No resubmission is produced.
   */
  recoverInterrupted(): boolean {
    return this.store.atomic(() => {
      const key = this.store.getValue<string>(this.prefix + "active");
      if (key === null) return false;
      const record = this.read(key);
      if (!record?.attempt || record.phase !== "attempted") throw new Error("Invalid active room input record");
      if (this.store.inputState(key) !== "uncertain") return false;
      if (this.barriers() === 0) this.store.setValue(this.prefix + "outbound-barriers", 1);
      this.store.setValue(this.prefix + key, { ...record, phase: "uncertain", messageId: null } satisfies InputRecord);
      this.store.setValue(this.prefix + "active", null);
      return true;
    });
  }

  /** Explicit operator reconciliation only. The caller authenticates and confirms
   * the decision for this exact attempt. A confirmed-visible decision additionally
   * requires independent verification of owner, room and canonical message ID.
   * This is not an automatic text-match recovery path and never permits replay.
   * The original uncertain inbox and observation remain unchanged for audit.
   */
  resolveUncertain(attempt: DotRoomInputAttempt, resolution: DotRoomInputResolution): boolean {
    if (!opaque(resolution.decisionId) ||
        !["confirmed-visible", "release-without-retry"].includes(resolution.kind) ||
        (resolution.kind === "confirmed-visible" ? !this.boundMessageId(resolution.messageId as string) : resolution.messageId !== null))
      throw new TypeError("Invalid operator resolution");
    this.store.requireDurableWrites();
    return this.store.atomic(() => {
      this.assertDedicatedPeer();
      const record = this.read(attempt.inputKey);
      if (!record?.attempt || !this.sameAttempt(record.attempt, attempt)) throw new Error("Submission attempt does not match");
      if (record.phase !== "uncertain" || this.store.inputState(attempt.inputKey) !== "uncertain")
        throw new Error("Only a settled uncertain submission can be reconciled");
      const resolutionKey = this.prefix + "resolution:" + attempt.operationId;
      const prior = this.store.getValue<DotRoomInputResolution>(resolutionKey);
      if (prior !== null) {
        if (prior.decisionId !== resolution.decisionId || prior.kind !== resolution.kind || prior.messageId !== resolution.messageId)
          throw new Error("Conflicting operator resolution");
        return false;
      }
      const decisionKey = this.prefix + "decision:" + resolution.decisionId;
      if (this.store.getValue(decisionKey) !== null) throw new Error("Operator decision already used");
      const barriers = this.barriers();
      if (barriers < 1) throw new Error("Missing outbound submission barrier");
      if (resolution.messageId !== null) {
        const receiptKey = this.prefix + "message:" + resolution.messageId;
        const previous = this.store.getValue<string>(receiptKey);
        if (previous !== null && previous !== attempt.operationId) throw new Error("Message already belongs to another submission");
        this.store.setValue(receiptKey, attempt.operationId);
      }
      this.store.setValue(resolutionKey, { decisionId: resolution.decisionId, kind: resolution.kind, messageId: resolution.messageId });
      this.store.setValue(decisionKey, attempt.operationId);
      this.store.setValue(this.prefix + "outbound-barriers", barriers - 1);
      return true;
    });
  }

  /** Reserve the same provider scope for the shared outbox. No live route starts. */
  bindProjection(store: BridgeStore): Readonly<{ peerId: number; roomId: string; scopeKey: string }> {
    if (store !== this.store) throw new Error("Projection must use the same bridge store");
    return this.store.atomic(() => {
      this.assertDedicatedPeer();
      this.store.setValue(`dot-room-input-scope:${this.scope.peerId}`, this.prefix);
      return { peerId: this.scope.peerId, roomId: this.scope.roomId, scopeKey: this.prefix };
    });
  }
  projectionAvailable(store: BridgeStore): boolean {
    if (store !== this.store) return false;
    this.assertDedicatedPeer();
    return this.store.getValue(`dot-room-input-scope:${this.scope.peerId}`) === this.prefix;
  }
  projectionBlocked(): boolean {
    this.assertDedicatedPeer();
    return this.store.getValue(this.prefix + "active") !== null || this.barriers() > 0;
  }
  private barriers(): number {
    const count = this.store.getValue<number>(this.prefix + "outbound-barriers") ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid outbound barrier count");
    return count;
  }

  /** An exact committed receipt or explicit verified operator mapping suppresses an echo. */
  isOwnVisibleMessage(messageId: string): boolean {
    this.assertDedicatedPeer();
    return this.boundMessageId(messageId) && this.store.getValue(this.prefix + "message:" + messageId) !== null;
  }
  private assertDedicatedPeer(): void {
    const registered = this.store.getValue<string>(`dot-room-input-scope:${this.scope.peerId}`);
    if (registered !== null && registered !== this.prefix) throw new Error("Room peer has a different journal scope");
    if (this.store.byPeer(this.scope.peerId)) throw new Error("Room peer is already assigned to a Codex binding");
  }
  private inputKey(input: BridgeInput): string {
    if (input.peerId !== this.scope.peerId || input.senderId !== this.scope.ownerId || !opaque(input.eventId) ||
        typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000 || input.text.includes("\0") ||
        input.action !== undefined || input.hasAttachments || input.attachments?.length || input.attachmentError !== undefined ||
        input.editOfMessageId !== undefined || input.replyToMessageId !== undefined || input.conversationTitle !== undefined || input.mergedEventIds?.length)
      throw new TypeError("Unsupported or unbound room input");
    return JSON.stringify([input.peerId, input.eventId]);
  }
  private digest(input: BridgeInput): string { return hash(JSON.stringify([input.peerId, input.eventId, input.senderId, input.text, input.replyToMessageId ?? null])); }
  private boundMessageId(id: string): boolean {
    const prefix = `${this.scope.roomId}~${this.scope.roomId}~CalpicoMessage~`;
    return typeof id === "string" && id.startsWith(prefix) && /^Sentinel_[a-f0-9]{32}$/u.test(id.slice(prefix.length));
  }
  private sameAttempt(a: DotRoomInputAttempt, b: DotRoomInputAttempt): boolean {
    return a.operationId === b.operationId && a.observerEpoch === b.observerEpoch && a.inputKey === b.inputKey && a.roomId === b.roomId;
  }
  private read(key: string): InputRecord | null {
    const record = this.store.getValue<InputRecord>(this.prefix + key);
    if (record !== null && (record.version !== 1 || !/^[a-f0-9]{64}$/u.test(record.digest) ||
      !["received", "attempted", "observed", "uncertain"].includes(record.phase))) throw new Error("Invalid room input record");
    return record;
  }
}
