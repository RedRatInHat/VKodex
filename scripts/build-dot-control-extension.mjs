import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateCanaryConfig } from "./build-dot-observer-canary.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
export function validateControlConfig(value) {
  const keys = ["pageUrl", "roomId", "ownerAnchorId", "dotAnchorId", "generation", "nativeHost", "enabled"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      Object.keys(value).some(key => !keys.includes(key)) || typeof value.enabled !== "boolean" ||
      value.nativeHost !== "com.vkodex.dot_control" || !Number.isSafeInteger(value.generation) || value.generation < 1)
    throw new Error("Invalid dot control extension configuration");
  const binding = validateCanaryConfig({ pageUrl: value.pageUrl, roomId: value.roomId, ownerAnchorId: value.ownerAnchorId,
    dotAnchorId: value.dotAnchorId, expectedText: "[VKODEX-CONFIG-VALIDATION] Not a submission.",
    operationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  return { pageUrl: binding.pageUrl, roomId: binding.roomId, ownerAnchorId: binding.ownerAnchorId,
    dotAnchorId: binding.dotAnchorId, generation: value.generation, nativeHost: value.nativeHost, enabled: value.enabled };
}
export async function buildDotControlExtension(value, output) {
  const config = validateControlConfig(value);
  if (!path.isAbsolute(output)) throw new Error("Output must be an absolute new directory");
  const files = new Map();
  const manifest = { manifest_version: 3, name: "VKodex dot control", version: "0.1.0",
    description: "Scoped dot conversation control through a local VKodex Native Messaging host.",
    permissions: ["nativeMessaging", "scripting", "alarms"], host_permissions: ["https://chatgpt.com/*"],
    background: { service_worker: "background.bundle.js" } };
  files.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  for (const entry of ["background", "content"]) {
    const result = await build({ entryPoints: [path.join(root, "extensions/dot-control", entry + ".ts")],
      bundle: true, write: false, platform: "browser", format: "iife", target: "chrome120", sourcemap: false,
      define: { VKODEX_CONTROL_CONFIG: JSON.stringify(config) }, logLevel: "silent" });
    if (result.outputFiles.length !== 1) throw new Error("Unexpected extension bundle inventory");
    files.set(entry + ".bundle.js", result.outputFiles[0].text);
  }
  await mkdir(output);
  const inventory = {};
  for (const [name, content] of files) {
    await writeFile(path.join(output, name), content, { flag: "wx" });
    inventory[name] = { bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
  }
  const receipt = { version: 1, kind: "dot-native-control-extension", installed: false, enabled: config.enabled,
    permissions: manifest.permissions, hostPermissions: manifest.host_permissions, files: inventory };
  await writeFile(path.join(output, "package-receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--output") throw new Error("Use --config FILE --output NEW_DIRECTORY");
    const bytes = await readFile(args[1]);
    if (bytes.length > 16_384) throw new Error("Configuration too large");
    const result = await buildDotControlExtension(JSON.parse(bytes.toString("utf8")), args[3]);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch { process.stderr.write("Dot control extension preparation failed\n"); process.exitCode = 1; }
}
