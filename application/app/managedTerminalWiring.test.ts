/**
 * The zellij panel's Attach / Attach-in-split buttons reach the terminal layer
 * through `onOpenManagedTerminal`, which is threaded App → handlers bridge →
 * TerminalHost bag → TerminalLayer → side panel. Every hop declares the prop
 * optional and the handlers bridge is typed `Record<string, unknown>`, so a
 * missing hop is invisible to the compiler: Attach just did nothing. These
 * tests pin the chain end to end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openManagedTerminalWithCurrentShellImpl } from "./AppHandlers";

const here = import.meta.dirname;

type CloneOpts = { localShellType?: string; startupCommand?: string; customName?: string };

function ctxFactory(overrides: Record<string, unknown> = {}) {
  const calls: {
    copy?: { id: string; opts: CloneOpts };
    split?: { id: string; dir: string; opts: CloneOpts };
  } = {};
  const base = {
    classifyLocalShellType: () => "posix",
    discoveredShells: [],
    resolveShellSetting: () => ({ command: "/bin/bash", args: [] }),
    terminalSettings: { localShell: "bash" },
    sessions: [{ id: "src", protocol: "ssh", status: "connected" }],
    copySession: (id: string, opts: CloneOpts) => { calls.copy = { id, opts }; },
    splitSession: (id: string, dir: string, opts: CloneOpts) => { calls.split = { id, dir, opts }; },
    ...overrides,
  };
  return { getCtx: () => base, calls };
}

test("openManagedTerminalWithCurrentShell copies the source tab with the attach command", () => {
  const { getCtx, calls } = ctxFactory();
  const opened = openManagedTerminalWithCurrentShellImpl(
    getCtx,
    "src",
    "zellij: dev",
    "exec zellij attach 'dev'",
  );
  assert.equal(opened, true);
  assert.equal(calls.copy?.id, "src");
  assert.equal(calls.copy?.opts.startupCommand, "exec zellij attach 'dev'");
  assert.equal(calls.copy?.opts.customName, "zellij: dev");
  assert.equal(calls.split, undefined);
});

test("openManagedTerminalWithCurrentShell splits vertically in verticalSplit mode", () => {
  const { getCtx, calls } = ctxFactory();
  const opened = openManagedTerminalWithCurrentShellImpl(
    getCtx,
    "src",
    "zellij: dev",
    "exec zellij attach 'dev'",
    { mode: "verticalSplit" },
  );
  assert.equal(opened, true);
  assert.equal(calls.split?.id, "src");
  assert.equal(calls.split?.dir, "vertical");
  assert.equal(calls.split?.opts.startupCommand, "exec zellij attach 'dev'");
  assert.equal(calls.copy, undefined);
});

test("openManagedTerminalWithCurrentShell reports failure when the source tab is gone", () => {
  const { getCtx, calls } = ctxFactory({ sessions: [] });
  const opened = openManagedTerminalWithCurrentShellImpl(
    getCtx,
    "src",
    "zellij: dev",
    "exec zellij attach 'dev'",
  );
  // copySession/splitSession no-op on a missing source, so a `true` here would
  // be a success the user never sees.
  assert.equal(opened, false);
  assert.equal(calls.copy, undefined);
  assert.equal(calls.split, undefined);
});

test("AppSideEffects registers openManagedTerminalWithCurrentShell on the handlers bridge", () => {
  const source = readFileSync(join(here, "AppSideEffects.tsx"), "utf8");
  assert.match(source, /openManagedTerminalWithCurrentShellImpl/);
  assert.match(
    source,
    /const openManagedTerminalWithCurrentShell = useCallback\(/,
    "AppSideEffects must build the handler",
  );
  const registerBlock = source.slice(source.indexOf("registerAppHandlers({"));
  assert.match(
    registerBlock.slice(0, registerBlock.indexOf("});")),
    /^\s*openManagedTerminalWithCurrentShell,\s*$/m,
    "the handler must be registered, not just defined",
  );
});

test("TerminalHost forwards openManagedTerminalWithCurrentShell into the terminal bag", () => {
  const source = readFileSync(join(here, "hosts", "TerminalHost.tsx"), "utf8");
  assert.match(
    source,
    /openManagedTerminalWithCurrentShell:\s*handlers\.openManagedTerminalWithCurrentShell/,
  );
});

test("AppView passes the handler to the terminal layer", () => {
  const source = readFileSync(join(here, "AppView.tsx"), "utf8");
  assert.match(source, /onOpenManagedTerminal=\{openManagedTerminalWithCurrentShell\}/);
});

test("the zellij card has no silent fallback for a missing handler", () => {
  const source = readFileSync(
    join(here, "..", "..", "components", "systemManager", "ZellijSessionCard.tsx"),
    "utf8",
  );
  assert.doesNotMatch(source, /requestManagedTerminalOpen/);
  assert.match(source, /onOpenManagedTerminal\?\.\([\s\S]*?\) \?\? false/);
});
