import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = ["manifest.json", "popup.html", "popup.js", "background.js"];
const modules = ["room-observation", "submission-observation", "submission-dom-observer"];
const keys = ["pageUrl", "roomId", "ownerAnchorId", "dotAnchorId", "expectedText", "operationId"];
export function validateCanaryConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== keys.length ||
      keys.some(key => typeof config[key] !== "string") || Object.keys(config).some(key => !keys.includes(key)) ||
      !/^https:\/\/chatgpt\.com\/dots\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.pageUrl) ||
      !/^[a-f0-9]{32}$/.test(config.roomId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.operationId) ||
      !/^\[VKODEX-[A-Z0-9-]+\]/.test(config.expectedText) || config.expectedText.length > 2_000 || /\0/.test(config.expectedText))
    throw new Error("Invalid canary configuration");
  const prefix = `${config.roomId}~${config.roomId}~CalpicoMessage~`;
  for (const key of ["ownerAnchorId", "dotAnchorId"]) if (!config[key].startsWith(prefix) ||
      !/^Sentinel_[a-f0-9]{32}$/.test(config[key].slice(prefix.length))) throw new Error("Invalid canary anchor");
  if (config.ownerAnchorId === config.dotAnchorId) throw new Error("Distinct author anchors required");
  return Object.fromEntries(keys.map(key => [key, config[key]]));
}
export async function buildCanaryPackage(config, output) {
  const checked = validateCanaryConfig(config);
  if (!path.isAbsolute(output)) throw new Error("Output must be an absolute new directory");
  const files = new Map();
  for (const asset of assets) files.set(asset, await readFile(path.join(root, "extensions/dot-observer-canary", asset), "utf8"));
  let bundle = '(()=>{const factories=Object.create(null), cache=Object.create(null);\n';
  for (const name of modules) {
    const source = await readFile(path.join(root, "src/dot-browser", name + ".ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    bundle += `factories[${JSON.stringify("./" + name + ".js")}]=(module,exports,require)=>{\n${compiled}\n};\n`;
  }
  bundle += 'function vkodexLoad(id){if(!Object.hasOwn(factories,id))throw new Error("Unknown bundled module");if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;factories[id](module,module.exports,vkodexLoad);return module.exports;}\n';
  bundle += await readFile(path.join(root, "extensions/dot-observer-canary/content-entry.js"), "utf8");
  bundle += '\n})();\n';
  files.set("observer.bundle.js", bundle);
  files.set("config.js", `globalThis.VKODEX_CANARY_CONFIG=Object.freeze(${JSON.stringify(checked)});\n`);
  await mkdir(output); // Exclusive: never replace a package already inspected/installed.
  const inventory = {};
  for (const [name, content] of files) {
    await writeFile(path.join(output, name), content, { flag: "wx" });
    inventory[name] = { bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
  }
  const receipt = { version: 1, kind: "one-shot-read-only-observer", installed: false, network: false, files: inventory };
  await writeFile(path.join(output, "package-receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--output") throw new Error("Use --config FILE --output NEW_ABSOLUTE_DIRECTORY");
    const stat = await lstat(args[1]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("Invalid config file");
    const receipt = await buildCanaryPackage(JSON.parse(await readFile(args[1], "utf8")), args[3]);
    console.log(JSON.stringify(receipt));
  } catch (error) { console.error(error instanceof Error ? error.message : "Build refused"); process.exitCode = 1; }
}
