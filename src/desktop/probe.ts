import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { configuredCodexHomes } from "../bridge/config.js";
import { MultiDesktopCatalog } from "./multi-catalog.js";
import { DesktopIpcClient } from "./ipc-client.js";
import { TaskSubscription } from "./subscription.js";
import { projectSnapshot } from "./projector.js";

// Read-only by construction: this entry point never sends task input or starts a turn.
let local: NodeJS.ProcessEnv = {};
try { local = parseEnv(await readFile(".env", "utf8")); }
catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
const homes = configuredCodexHomes({
  CODEX_HOME: process.env.CODEX_HOME ?? local.CODEX_HOME ?? "",
  CODEX_EXTRA_HOMES: process.env.CODEX_EXTRA_HOMES ?? local.CODEX_EXTRA_HOMES ?? "",
});
const threadId = process.argv[2];
const catalog = new MultiDesktopCatalog(homes);
const tasks = await catalog.listTasks();
const projects = await catalog.listProjects();
process.stdout.write(`${JSON.stringify({ sourceCount: homes.length, taskCount: tasks.length, projectCount: projects.length, unreadableSources: catalog.catalogWarnings().length, readOnly: true })}\n`);
if (threadId) {
  const matches = tasks.filter(task => task.threadId === threadId);
  if (matches.length !== 1) throw new Error("Task is missing or its ID occurs in several configured directories; select one source through CODEX_HOME and CODEX_EXTRA_HOMES");
  const client = new DesktopIpcClient();
  let updates = 0;
  const subscription = new TaskSubscription(client, matches[0]!, () => { updates++; }, () => {});
  try {
    await subscription.start();
    const state = subscription.current;
    const projected = state ? projectSnapshot(state, null).events : [];
    const eventCounts = Object.fromEntries([...new Set(projected.map(event => event.type))].map(type => [type, projected.filter(event => event.type === type).length]));
    process.stdout.write(`${JSON.stringify({ subscribed: true, taskMatched: state?.id === threadId, updates, eventCounts, readOnly: true })}\n`);
  } finally {
    subscription.close();
    client.close();
  }
}
