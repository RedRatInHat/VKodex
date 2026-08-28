import assert from "node:assert/strict";
import test from "node:test";
import { compatibleRuntime, launchArguments, windowsRuntimePath } from "../src/desktop/runtime.js";

test("Windows runtime has a stable dedicated name outside the checkout and Node version directory", () => {
  assert.equal(windowsRuntimePath("C:\\Users\\fixture\\AppData\\Local"), "C:\\Users\\fixture\\AppData\\Local\\VKodex\\runtime\\VKodex.exe");
  assert.equal(windowsRuntimePath("D:\\Local Apps"), "D:\\Local Apps\\VKodex\\runtime\\VKodex.exe");
});

test("Windows runtime requires an absolute local application data path", () => {
  for (const value of [undefined, "", "relative", "C:relative", "\\Local Apps"]) assert.throws(() => windowsRuntimePath(value));
});

test("private runtime must match the architecture and native module ABI", () => {
  const expected = { arch: "x64", modules: "fixture-abi" };
  assert.equal(compatibleRuntime({ ...expected, node: "other-patch-version" }, expected), true);
  for (const identity of [null, "node", {}, { arch: "arm64", modules: "fixture-abi" }, { arch: "x64", modules: "other-abi" }]) {
    assert.equal(compatibleRuntime(identity, expected), false);
  }
});

test("desktop and VK checks use explicit entry points and load secrets only in the child", () => {
  assert.deepEqual(launchArguments("dev"), ["--env-file=.env", "--import", "tsx", "src/desktop-main.ts"]);
  assert.deepEqual(launchArguments("start"), ["--env-file=.env", "dist/src/desktop-main.js"]);
  assert.deepEqual(launchArguments("check"), ["--env-file=.env", "--import", "tsx", "src/platforms/vk/check.ts"]);
  assert.deepEqual(launchArguments("probe", ["fixture-task"]), ["--import", "tsx", "src/desktop/probe.ts", "fixture-task"]);
});

test("launcher does not accept substitute scripts or arbitrary Node options", () => {
  assert.throws(() => launchArguments("arbitrary-script"));
  assert.throws(() => launchArguments("dev", ["--inspect"]));
  assert.throws(() => launchArguments("probe", ["one", "two"]));
});
