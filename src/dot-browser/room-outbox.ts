import { createHash } from "node:crypto";
import type { Delivery } from "../bridge/contracts.js";
import type { DeliveryAccess } from "../bridge/delivery.js";
import { BridgeStore } from "../bridge/store.js";
import { chunkText } from "../lib/text.js";
import { DotRoomInputJournal } from "./input-journal.js";
import type { DotRoomObservation, DotRoomTextObservation } from "./room-observation.js";

const PREFIX = "dot-room-outbox:";
interface MessageProjection { readonly origin: "baseline" | "vk" | "projected"; readonly role: "owner" | "dot" | null; readonly chunks: number; }

/** Shared-outbox projection only. No VK polling, transport or browser activation.
 * Initial history is baselined explicitly, never replayed. Missing window anchors
 * are gaps, not permission to reset history or guess message order.
 */
export class DotRoomOutbox {
  readonly peerId: number;
  private readonly roomId: string;
  private readonly prefix: string;
  constructor(private readonly store: BridgeStore, private readonly ingress: DotRoomInputJournal, private readonly chunkSize = 3_500) {
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 128 || chunkSize > 3_500) throw new TypeError("Invalid room mirror chunk size");
    store.requireDurableWrites();
    const binding = ingress.bindProjection(store);
    this.peerId = binding.peerId; this.roomId = binding.roomId;
    this.prefix = `${PREFIX}${createHash("sha256").update(binding.scopeKey).digest("hex")}:`;
  }
  setEnabled(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid projection state");
    this.ingress.bindProjection(this.store);
    this.store.setValue(this.prefix + "enabled", enabled);
  }
  active(): boolean {
    try { if (!this.ingress.projectionAvailable(this.store)) return false; }
    catch { return false; }
    return this.store.getValue(this.prefix + "enabled") === true;
  }
  accepts(delivery: Delivery): boolean {
    return delivery.peerId === this.peerId && delivery.bindingId === null && delivery.key.startsWith(this.prefix + "message:") &&
      this.store.getValue(this.prefix + "delivery:" + delivery.key) === true && this.active();
  }
  baseline(observation: DotRoomObservation): void {
    const ids = this.validate(observation);
    this.store.atomic(() => {
      this.ingress.bindProjection(this.store);
      if (this.ingress.projectionBlocked()) throw new Error("Submission outcome must settle before baselining");
      if (this.store.getValue(this.prefix + "anchor") !== null) throw new Error("Room baseline is already fixed");
      for (const id of ids) this.store.setValue(this.prefix + "seen:" + id,
        { origin: "baseline", role: null, chunks: 0 } satisfies MessageProjection);
      this.store.setValue(this.prefix + "anchor", ids.at(-1)!);
    });
  }
  project(observation: DotRoomObservation): "disabled" | "submission-blocked" | "projected" {
    const ids = this.validate(observation);
    return this.store.atomic(() => {
      if (!this.active()) return "disabled";
      if (this.ingress.projectionBlocked()) return "submission-blocked";
      const anchor = this.store.getValue<string>(this.prefix + "anchor");
      const index = anchor === null ? -1 : ids.indexOf(anchor);
      if (index < 0) throw new Error("Room observation has a history gap");
      const messages = new Map(observation.messages.map(message => [message.messageId, message]));
      for (const [position, id] of ids.entries()) {
        const saved = this.readProjection(id);
        if (position <= index && !saved) throw new Error("Unknown insertion before the room anchor");
        if (saved?.origin === "baseline" || saved?.origin === "vk") continue;
        const message = messages.get(id);
        if (message?.displayRole === "owner" && this.ingress.isOwnVisibleMessage(id)) {
          if (saved) throw new Error("Own-message receipt arrived after projection");
          this.store.setValue(this.prefix + "seen:" + id, { origin: "vk", role: "owner", chunks: 0 } satisfies MessageProjection);
          continue;
        }
        if (saved?.role !== null && saved?.role !== undefined && message && saved.role !== message.displayRole)
          throw new Error("Room display author changed");
        const label = message?.displayRole === "owner" ? "Вы (из приложения):\n" : "";
        const text = message ? label + message.text : "[Сообщение содержит неподдерживаемое содержимое. Откройте приложение.]";
        const chunks = chunkText(text, this.chunkSize);
        for (const [part, text] of chunks.entries()) {
          const key = `${this.prefix}message:${id}:${part}`;
          this.store.enqueue(key, this.peerId, { text, silent: true }, null, true);
          if (this.store.getValue(this.prefix + "delivery:" + key) !== true) this.store.setValue(this.prefix + "delivery:" + key, true);
        }
        for (let part = chunks.length; part < (saved?.chunks ?? 0); part++)
          this.store.withdrawCommentary(`${this.prefix}message:${id}:${part}`, "(Этот фрагмент сообщения удалён в приложении.)");
        const next = { origin: "projected", role: message?.displayRole ?? saved?.role ?? null, chunks: chunks.length } satisfies MessageProjection;
        if (JSON.stringify(saved) !== JSON.stringify(next)) this.store.setValue(this.prefix + "seen:" + id, next);
      }
      if (anchor !== ids.at(-1)) this.store.setValue(this.prefix + "anchor", ids.at(-1)!);
      return "projected";
    });
  }
  private readProjection(id: string): MessageProjection | null {
    const value = this.store.getValue<MessageProjection>(this.prefix + "seen:" + id);
    if (value !== null && (!value || !["baseline", "vk", "projected"].includes(value.origin) ||
        !["owner", "dot", null].includes(value.role) || !Number.isSafeInteger(value.chunks) || value.chunks < 0 || value.chunks > 1_000))
      throw new Error("Invalid saved room projection");
    return value;
  }
  private validate(observation: DotRoomObservation): readonly string[] {
    if (observation.kind !== "partial-room-observation" || observation.completeHistory !== false || observation.authoritativeAuthors !== false ||
        !Array.isArray(observation.orderedMessageIds) || !Array.isArray(observation.messages) || !Array.isArray(observation.unsupportedMessageIds) ||
        observation.orderedMessageIds.length === 0 || observation.orderedMessageIds.length > 500)
      throw new Error("Invalid room observation");
    const ids = observation.orderedMessageIds;
    const prefix = `${this.roomId}~${this.roomId}~CalpicoMessage~`;
    if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id.startsWith(prefix) ||
      !/^Sentinel_[a-f0-9]{32}$/u.test(id.slice(prefix.length)))) throw new Error("Invalid room message identities");
    const seen = new Set<string>(); let size = 0;
    for (const message of observation.messages as readonly DotRoomTextObservation[]) {
      if (!message || !ids.includes(message.messageId) || seen.has(message.messageId) ||
          !["owner", "dot"].includes(message.displayRole) || message.evidence !== "rendered-room" ||
          typeof message.text !== "string" || !message.text.trim() || message.text.length > 100_000 || message.text.includes("\0"))
        throw new Error("Invalid rendered message");
      seen.add(message.messageId); size += message.text.length;
    }
    for (const id of observation.unsupportedMessageIds) {
      if (!ids.includes(id) || seen.has(id)) throw new Error("Invalid unsupported message identity");
      seen.add(id);
    }
    if (seen.size !== ids.length || size > 2_000_000) throw new Error("Incomplete or oversized room observation");
    return ids;
  }
}

/** Composite recipient gate for the existing DeliveryWorker. Unknown room keys
 * never fall through to ordinary Codex access; other Codex peers keep their gate.
 */
export class DotRoomDeliveryAccess implements DeliveryAccess {
  private readonly routes: ReadonlyMap<number, DotRoomOutbox>;
  constructor(private readonly ordinary: DeliveryAccess, routes: readonly DotRoomOutbox[]) {
    this.routes = new Map(routes.map(route => [route.peerId, route]));
    if (this.routes.size !== routes.length) throw new Error("Duplicate room recipient route");
  }
  async check(peerId: number, fresh = false): Promise<boolean> {
    const route = this.routes.get(peerId);
    return route ? route.active() : this.ordinary.check(peerId, fresh);
  }
  accepts(delivery: Delivery): boolean {
    const route = this.routes.get(delivery.peerId);
    if (delivery.key.startsWith(PREFIX)) return route?.accepts(delivery) ?? false;
    return !route && (this.ordinary.accepts?.(delivery) ?? true);
  }
}
