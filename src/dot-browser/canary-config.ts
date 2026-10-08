import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BridgeInput } from "../bridge/contracts.js";

export const CANARY_DATABASE = "dot-control-canary.sqlite";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const schema = z.object({ version: z.literal(1), mode: z.literal("diagnostic-canary"),
  databasePath: z.string().min(1), peerId: z.number().int().min(2_000_000_001).max(Number.MAX_SAFE_INTEGER),
  ownerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), roomId: z.string().regex(/^[a-f0-9]{32}$/u),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pageUrl: z.string().regex(/^https:\/\/chatgpt\.com\/dots\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
}).strict();
export type DotCanaryConfig = z.infer<typeof schema>;

export function assertCanaryDatabase(filename: string): void {
  if (!path.isAbsolute(filename) || path.basename(filename) !== CANARY_DATABASE)
    throw new Error("Diagnostic canary database required");
  // A renamed hard link or a symlink to a production DB is not isolation.
  realpathSync(path.dirname(filename));
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
        path.basename(realpathSync(filename)) !== CANARY_DATABASE) throw new Error("Diagnostic database is not isolated");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Diagnostic database is not isolated");
  }
}

export function parseDotCanaryConfig(value: unknown): Readonly<DotCanaryConfig> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Invalid diagnostic canary config");
  assertCanaryDatabase(result.data.databasePath);
  return Object.freeze(result.data);
}

export function canaryEventId(requestId: string): string {
  if (!uuid.test(requestId)) throw new Error("Invalid canary request ID");
  return `canary:${requestId}`;
}
export function canaryMarker(requestId: string): string {
  canaryEventId(requestId);
  return `[VKODEX-DOT-CONTROL-CANARY:${requestId}]`;
}
export function canaryInput(config: DotCanaryConfig, requestId: string, text: string): BridgeInput {
  const eventId = canaryEventId(requestId), marker = canaryMarker(requestId);
  if (typeof text !== "string" || text.length > 2000 || !text.startsWith(marker + "\n") ||
      !text.slice(marker.length).trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text))
    throw new Error("Marked canary text required");
  return { eventId, peerId: config.peerId, senderId: config.ownerId, text };
}
export function isCanaryInput(config: DotCanaryConfig, input: BridgeInput): boolean {
  try {
    if (!input.eventId.startsWith("canary:")) return false;
    const expected = canaryInput(config, input.eventId.slice(7), input.text);
    return Object.keys(input).every(key => ["eventId", "peerId", "senderId", "text"].includes(key)) &&
      input.peerId === expected.peerId && input.senderId === expected.senderId;
  } catch { return false; }
}
