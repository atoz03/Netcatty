import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useTerminalAiContexts.ts", import.meta.url), "utf8");

test("useTerminalAiContexts imports AI context primitives from domain", () => {
  assert.match(source, /from ['"]\.\.\/\.\.\/domain\/buildAITerminalSessionInfo['"]/);
  assert.doesNotMatch(source, /from ['"].*components\//);
});
