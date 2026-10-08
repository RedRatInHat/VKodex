import { readFileSync } from "node:fs";
import { BridgeStore } from "../bridge/store.js";
import { DotRoomInputJournal } from "./input-journal.js";
import { canaryEventId, canaryInput, parseDotCanaryConfig } from "./canary-config.js";

/** Fixed enqueue/status surface; never connects to a browser or recovers a DB. */
export function runDotCanaryCli(args: readonly string[]): unknown {
  const [method, configPath, requestId, text] = args;
  if (!configPath || !requestId || !(method === "status" && args.length === 3 || method === "enqueue" && args.length === 4))
    throw new Error("Expected enqueue CONFIG UUID TEXT or status CONFIG UUID");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configPath, "utf8")); } catch { throw new Error("Invalid diagnostic canary config"); }
  const config = parseDotCanaryConfig(raw), eventId = canaryEventId(requestId);
  const input = method === "enqueue" ? canaryInput(config, requestId, text!) : null;
  const store = new BridgeStore(config.databasePath, { readOnly: method === "status" });
  try {
    const journal = new DotRoomInputJournal(store, config);
    if (input) {
      const enqueued = journal.receive(input);
      return { enqueued, ...journal.eventStatus(eventId) };
    }
    return journal.eventStatus(eventId) ?? { state: "unknown", operationId: null, messageId: null };
  } finally { store.close(); }
}
