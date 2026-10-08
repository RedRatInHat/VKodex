import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseDotNativeHostInvocation } from "../src/dot-browser/native-host-invocation.js";
const config = path.resolve("fixture-native-host.json"), id = "a".repeat(32);
const args = ["--config", config, "--extension-id", id, `chrome-extension://${id}/`];
test("native host accepts only its independently configured extension origin", () => {
  assert.equal(parseDotNativeHostInvocation(args).extensionId, id);
  assert.equal(parseDotNativeHostInvocation([...args, "--parent-window=0"]).configPath, config);
  assert.throws(() => parseDotNativeHostInvocation([...args.slice(0, 4), `chrome-extension://${"b".repeat(32)}/`]));
});
test("arbitrary arguments, relative configs and malformed origins are refused", () => {
  for (const altered of [[...args, "--eval=script"], [...args, "--parent-window=-1"], [...args, "--parent-window=0", "extra"],
    ["--config", "relative.json", ...args.slice(2)], [...args.slice(0, 4), "https://chatgpt.com"],
    [...args.slice(0, 4), args[4] + "?x=1"], ["--config", config, "--extension-id", "z".repeat(32), args[4]!]])
    assert.throws(() => parseDotNativeHostInvocation(altered));
});
