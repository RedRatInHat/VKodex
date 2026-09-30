import path from "node:path";
import { canonicalDetachedProfileHome, createDetachedProfileConnection,
  detachedProfileDirectory } from "./codex/detached-profile-capability.js";
import { DetachedProfileLaunchError, launchDetachedProfileServer } from "./codex/detached-profile-launcher.js";

/** Separate operator-started publisher. It must never run inside the bridge's
 * restart loop; a bridge stop only closes its own WebSocket client. */
function argumentsFromCommandLine(argv: readonly string[]): Readonly<{ home: string; port: number }> {
  if (argv.length !== 4 || argv[0] !== "--home" || argv[2] !== "--port")
    throw new TypeError("Expected --home PATH --port PORT");
  const home = argv[1]!;
  const port = Number(argv[3]);
  if (!path.isAbsolute(home) || /[\x00-\x1f]/u.test(home) ||
    !Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new TypeError("Invalid independent profile server arguments");
  return { home: canonicalDetachedProfileHome(home), port };
}

try {
  const input = argumentsFromCommandLine(process.argv.slice(2));
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) throw new TypeError("Windows user-local storage is unavailable");
  const dataDirectory = path.join(localAppData, "VKodex", "owner-private");
  let status: "started" | "attached";
  try {
    await launchDetachedProfileServer({ ...input, dataDirectory });
    status = "started";
  } catch (error) {
    if (!(error instanceof DetachedProfileLaunchError) || error.phase !== "reservation") throw error;
    // A reservation might identify an existing ready backend. It must prove
    // itself through the protected descriptor, exact PID birth and handshake.
    // An incomplete/ambiguous launch remains unavailable; never spawn twice.
    const rpc = createDetachedProfileConnection(detachedProfileDirectory(dataDirectory, input.home), input.home);
    try { await rpc.start(); status = "attached"; }
    finally { await rpc.close(); }
  }
  process.stdout.write(`Independent profile server ${status}.\n`);
} catch (error) {
  const phase = error instanceof DetachedProfileLaunchError ? error.phase : "validation";
  process.stderr.write(`Independent profile server unavailable (${phase}); no automatic retry.\n`);
  process.exitCode = 1;
}
