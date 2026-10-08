import { runDotCanaryCli } from "./dot-browser/canary-cli.js";

try { process.stdout.write(JSON.stringify(runDotCanaryCli(process.argv.slice(2))) + "\n"); }
catch { process.stderr.write("Diagnostic canary command refused\n"); process.exitCode = 1; }
