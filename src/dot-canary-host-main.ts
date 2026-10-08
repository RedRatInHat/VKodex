import { runDotCanaryNativeHost } from "./dot-browser/canary-host.js";
try { await runDotCanaryNativeHost(process.argv.slice(2), process.stdin, process.stdout); }
catch { process.stderr.write("Diagnostic native host refused\n"); process.exitCode = 1; }
