import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./useAIChatStreaming.ts", import.meta.url), "utf8");

test("useAIChatStreaming imports streaming support from infrastructure", () => {
  assert.match(source, /from ['"]\.\.\/\.\.\/infrastructure\/ai\/aiChatStreamingSupport['"]/);
  assert.doesNotMatch(source, /from ['"].*components\//);
});
