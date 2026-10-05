/** An intentionally small allowlist for a dot's public ChatGPT text calls.
 * Never render an arbitrary item, argument, output, or reasoning field.
 * A completed tool call is not a substitute for the room's delivery receipt.
 */
export interface DotPublicReply {
  readonly sourceThreadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly text: string;
  readonly attachmentCount: number;
  readonly evidence: "completed-user-message-call";
}

export class DotSnapshotRejected extends Error {
  constructor(reason: string) { super(reason); this.name = "DotSnapshotRejected"; }
}

type Obj = Record<string, unknown>;
function object(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/u.test(value);
}

/** Accept only the native read_thread v1 snapshot for the configured dot.
 * Input turns are newest-first; emitted replies are oldest-first. Completed
 * calls in interrupted/in-progress turns remain eligible: the dot may sleep
 * or be steered after publishing a reply.
 */
export function extractDotPublicReplies(snapshot: unknown, expectedThreadId: string): DotPublicReply[] {
  if (!identifier(expectedThreadId) || !object(snapshot) || snapshot.schemaVersion !== 1 ||
      !object(snapshot.thread) || snapshot.thread.id !== expectedThreadId ||
      snapshot.thread.kind !== "codex" || snapshot.thread.hostId !== "durable" ||
      !object(snapshot.page) || snapshot.page.order !== "newest_first" ||
      !Array.isArray(snapshot.turns) || snapshot.turns.length > 10) {
    throw new DotSnapshotRejected("Unqualified dot snapshot or target binding");
  }
  const replies = new Map<string, DotPublicReply>();
  let itemCount = 0;
  for (const turn of [...snapshot.turns].reverse()) {
    if (!object(turn) || !identifier(turn.id) || !Array.isArray(turn.items)) {
      throw new DotSnapshotRejected("Invalid native turn shape");
    }
    itemCount += turn.items.length;
    if (itemCount > 20_000) throw new DotSnapshotRejected("Native snapshot item limit exceeded");
    for (const item of turn.items) {
      if (!object(item) || item.type !== "mcpToolCall" || item.server !== "codex_apps" ||
          item.tool !== "user_message.send_message" || item.status !== "completed" ||
          !identifier(item.id) || item.error != null || item.isError === true ||
          object(item.result) && item.result.isError === true || !object(item.arguments)) continue;
      const args = item.arguments;
      if (args.channel !== "chatgpt" || typeof args.text !== "string" ||
          !args.text.trim() || args.text.length > 100_000 || args.text.includes("\0")) continue;
      if (args.destination != null && (!object(args.destination) ||
          Object.keys(args.destination).some(key => key !== "message_id") ||
          !identifier(args.destination.message_id))) continue;
      if (args.metadata != null && !object(args.metadata)) continue;
      const metadata = args.metadata as Obj | null | undefined;
      // Widgets, secure handoffs, and action-time confirmations cannot be
      // faithfully represented by a text-only VK relay. Fail closed for them.
      if (args.elicitation_request_id != null || metadata?.include_widget === true ||
          object(metadata?.message_metadata) && metadata.message_metadata.cloud_browser_handoff != null) continue;
      const attachments = args.library_file_ids;
      if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 10 ||
          !attachments.every(identifier))) continue;
      const reply: DotPublicReply = {
        sourceThreadId: expectedThreadId, turnId: turn.id, itemId: item.id,
        text: args.text, attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
        evidence: "completed-user-message-call",
      };
      const existing = replies.get(item.id);
      if (existing && (existing.text !== reply.text || existing.attachmentCount !== reply.attachmentCount)) {
        throw new DotSnapshotRejected("Conflicting public reply identity");
      }
      if (!existing) replies.set(item.id, reply);
    }
  }
  return [...replies.values()];
}
