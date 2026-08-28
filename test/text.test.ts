import assert from "node:assert/strict";
import test from "node:test";
import { chunkText } from "../src/lib/text.js";
import { parseNewCommand } from "../src/lib/commands.js";

test("chunkText preserves content in bounded chunks", () => {
  const chunks = chunkText("alpha beta gamma delta epsilon", 12);
  assert.ok(chunks.every((chunk) => chunk.length <= 12));
  assert.equal(chunks.join(" ").replace(/\s+/gu, " "), "alpha beta gamma delta epsilon");
});

test("parseNewCommand supports workspace and title", () => {
  assert.deepEqual(parseNewCommand("/new repo | Fix export"), {
    workspace: "repo",
    title: "Fix export",
  });
});
