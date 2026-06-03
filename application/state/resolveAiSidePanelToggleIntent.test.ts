import test from "node:test";
import assert from "node:assert/strict";

import { resolveAiSidePanelToggleIntent } from "./resolveAiSidePanelToggleIntent.ts";

test("close: AI panel already open → close the side panel", () => {
  const r = resolveAiSidePanelToggleIntent("ai");
  assert.deepEqual(r, { kind: "closeTerminalSidePanel" });
});

test("open: no panel open → open AI", () => {
  const r = resolveAiSidePanelToggleIntent(null);
  assert.deepEqual(r, { kind: "openAi" });
});

test("open: a different sub-panel is open → switch to AI", () => {
  assert.deepEqual(resolveAiSidePanelToggleIntent("sftp"), { kind: "openAi" });
  assert.deepEqual(resolveAiSidePanelToggleIntent("scripts"), { kind: "openAi" });
  assert.deepEqual(resolveAiSidePanelToggleIntent("theme"), { kind: "openAi" });
});
