import path from "node:path";
import { diagnosticReport, type DiagnosticFilter } from "./desktop/diagnostic-report.js";

try {
  const filter: DiagnosticFilter = {};
  let directory = path.resolve(process.env.BOT_DATA_DIR || "./data/desktop", "diagnostics");
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!value) throw new Error();
    if (key === "--directory") directory = path.resolve(value);
    else if (key === "--thread") filter.threadId = value;
    else if (key === "--attempt") filter.attemptId = value;
    else if (key === "--operation") filter.operationId = value;
    else if (key === "--connection") filter.connectionAttemptId = value;
    else if (key === "--event") filter.eventId = value;
    else if (key === "--peer" || key === "--limit") {
      if (!/^\d+$/u.test(value)) throw new Error();
      filter[key === "--peer" ? "peerId" : "limit"] = Number(value);
    } else if (key === "--after" || key === "--before") {
      if (!Number.isFinite(Date.parse(value))) throw new Error();
      filter[key === "--after" ? "after" : "before"] = new Date(value).toISOString();
    } else throw new Error();
  }
  console.log(JSON.stringify(await diagnosticReport(directory, filter), null, 2));
} catch {
  console.error("Cannot read diagnostics. Use --directory, --thread, --attempt, --operation, --connection, --event, --peer, --after, --before or --limit (1..2000).");
  process.exitCode = 1;
}
