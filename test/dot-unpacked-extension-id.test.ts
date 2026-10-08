import test from "node:test";
import assert from "node:assert/strict";
import { windowsUnpackedExtensionId } from "../src/dot-browser/unpacked-extension-id.js";
test("keyless Windows candidate ID normalizes only drive letter", () => {
  const id = windowsUnpackedExtensionId("C:\\Users\\fixture\\Extension");
  assert.match(id, /^[a-p]{32}$/u);
  assert.equal(windowsUnpackedExtensionId("c:\\Users\\fixture\\Extension"), id);
  assert.notEqual(windowsUnpackedExtensionId("C:\\Users\\fixture\\extension"), id);
  assert.notEqual(windowsUnpackedExtensionId("C:\\Users\\fixture\\Other"), id);
});
test("ambiguous, relative, normalized-different or non-Windows paths refuse", () => {
  for (const value of ["relative", "/tmp/extension", "C:/Users/fixture/Extension", "C:\\Users\\..\\Extension", "C:\\", "C:\\Extension\\", "C:\\bad\npath"])
    assert.throws(() => windowsUnpackedExtensionId(value));
});
