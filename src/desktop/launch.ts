import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchArguments, prepareRuntime, RuntimeSetupError } from "./runtime.js";

async function main(): Promise<void> {
  const [mode, ...extra] = process.argv.slice(2);
  const args = mode === "prepare" && extra.length === 0 ? null : launchArguments(mode ?? "", extra);
  const executable = await prepareRuntime();
  if (args === null) { process.stdout.write(`${executable}\n`); return; }
  const root = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../" : "../../../", import.meta.url));
  const child = spawn(executable, args, { cwd: root, stdio: "inherit", windowsHide: true });
  const onInterrupt = (): void => {
    // Windows delivers console Ctrl+C to both processes; let the bridge finish its shutdown.
    if (process.platform !== "win32") child.kill("SIGINT");
  };
  const onTerminate = (): void => { child.kill("SIGTERM"); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new RuntimeSetupError("Could not start the VKodex runtime.")));
      child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

await main().catch(error => {
  process.stderr.write(`${error instanceof RuntimeSetupError ? error.message : "VKodex launcher failed. Check the runtime and project installation."}\n`);
  process.exitCode = 1;
});
