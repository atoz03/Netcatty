import test from "node:test";
import assert from "node:assert/strict";

import { resolveWindowCommandCloseIntent } from "./windowCommandClose.ts";

test("Cmd+W closes the active closable tab first", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "s1",
      editorTabIds: [],
      sessionIds: ["s1", "s2"],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W on a log view closes the log view", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "log-1",
      editorTabIds: [],
      sessionIds: ["s1", "s2"],
      workspaceIds: [],
      logViewIds: ["log-1"],
    }),
    { kind: "closeLogView", tabId: "log-1" },
  );
});

test("Cmd+W closes an editor tab through the existing close flow", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "editor:1",
      editorTabIds: ["editor:1"],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W closes a native plugin view tab before the window", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "plugin-view:com.example.view:com.example.view.panel",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
      pluginViewTabIds: ["plugin-view:com.example.view:com.example.view.panel"],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W closes the window from the Vault page", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "vault",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeWindow" },
  );
});

test("Cmd+W closes the window when nothing else is active", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: null,
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeWindow" },
  );
});
