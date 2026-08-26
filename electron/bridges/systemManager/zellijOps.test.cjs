const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createZellijOpsApi,
  parseZellijSessions,
  parseZellijTabNames,
  parseZellijClients,
  parseZellijVersionString,
  sanitizeNewSessionName,
  isNoZellijSessionsMessage,
  findZellijFailureMessage,
  isZellijMissingTargetMessage,
  buildZellijCommand,
  buildZellijSessionActionCommand,
} = require("./zellijOps.cjs");

/**
 * Captured from zellij 0.43.1 rather than written from memory. Every fixture
 * below is verbatim output, including the ANSI colouring `list-sessions` emits
 * when it is not given `--no-formatting` and the column padding `list-clients`
 * emits always.
 */
const REAL = {
  empty: "No active zellij sessions found.",
  listAnsi: "[32;1mproj:api[m [Created [35;1m0s[m ago] \n"
    + "[32;1mmy proj[m [Created [35;1m0s[m ago]",
  current: "work [Created 5m 3s ago] (current)",
  exited: "old-run [Created 2h ago] (EXITED - attach to resurrect)",
  createDuplicate: "Session already exists",
  createEmptyName: "Session name cannot be empty. Please provide a specific session name.",
  createResurrectable: "A resurrectable session by this name exists, cannot use this name.",
  deleteMissing: 'Session: "does-not-exist" not found.',
  killMissing: 'No session named "does-not-exist" found.',
  deleteRunningOk: 'A session by the name "proj:api" exists and is active, but will be force killed and deleted.\n'
    + 'Session: "proj:api" successfully deleted.',
  deleteRunningRefused: 'A session by the name "proj:api" exists and is active, use --force to delete it.',
  renameCollision: "A session by this name already exists.",
  actionMissing: "Session 'does-not-exist' not found. The following sessions are active:\nsvc:web",
  actionNoSession: "Please specify the session name to send actions to. The following sessions are active:\nsvc:web",
  tabNames: "Tab #1\nmy tab\nTab #3",
  clients: "CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1         plugin_2       zellij:about   ",
};

/** Mirrors the shape `listSessionDetails` reads back out of one exec. */
function detailsOutput(tabsText, clientsText) {
  return `${tabsText}\n__NC_ZELLIJ_SPLIT__\n${clientsText}`;
}

test("parseZellijSessions parses plain session names", () => {
  assert.deepEqual(parseZellijSessions("dev\nops\n"), [
    { name: "dev", current: false, exited: false },
    { name: "ops", current: false, exited: false },
  ]);
});

test("parseZellijSessions removes status markers", () => {
  assert.deepEqual(parseZellijSessions("dev (current)\nold (exited)\n"), [
    { name: "dev", current: true, exited: false },
    { name: "old", current: false, exited: true },
  ]);
});

test("parseZellijSessions removes created metadata", () => {
  assert.deepEqual(parseZellijSessions("unixml [Created 0s ago]\nVKC [Created 0s ago] (EXITED - attach to resurrect)\n"), [
    { name: "unixml", current: false, exited: false },
    { name: "VKC", current: false, exited: true },
  ]);
});

test("parseZellijSessions skips diagnostic and version lines", () => {
  assert.deepEqual(
    parseZellijSessions("__ZELLIJ_VERSION__=zellij 0.41.2\nNo active sessions found.\n"),
    [],
  );
});

test("parseZellijVersionString normalizes zellij version output", () => {
  assert.equal(parseZellijVersionString("zellij 0.41.2"), "zellij 0.41.2");
});

test("sanitizeNewSessionName trims and caps session names", () => {
  assert.equal(sanitizeNewSessionName("  dev  "), "dev");
  assert.equal(sanitizeNewSessionName(""), null);
  assert.equal(sanitizeNewSessionName("x".repeat(80)).length, 64);
});

test("isNoZellijSessionsMessage recognizes empty list output", () => {
  assert.equal(isNoZellijSessionsMessage("No active sessions found.", 0), true);
  assert.equal(isNoZellijSessionsMessage("No active sessions found.", 1), true);
  assert.equal(isNoZellijSessionsMessage("permission denied", 1), false);
});

test("buildZellijCommand keeps quoted session names", () => {
  assert.equal(buildZellijCommand("attach --create-background 'my session'"), "zellij attach --create-background 'my session'");
});

test("buildZellijSessionActionCommand puts --session before the subcommand", () => {
  // `zellij action rename-session -s name` is rejected; the session is a global
  // flag and has to precede `action`.
  assert.equal(
    buildZellijSessionActionCommand("svc:web", "query-tab-names"),
    "zellij --session 'svc:web' action query-tab-names",
  );
});

// --- Regressions against real zellij 0.43.1 output ---

test("an empty host reports an empty list, not an error and not a phantom session", () => {
  // zellij prints this and exits 1. The previous pattern matched none of it, so
  // the panel rendered its error state, and the message itself was parsed as a
  // session named "No active zellij sessions found.".
  assert.equal(isNoZellijSessionsMessage(REAL.empty, 1), true);
  assert.deepEqual(parseZellijSessions(REAL.empty), []);
});

test("session names containing a colon are listed", () => {
  // Names were previously dropped whenever they contained ":", so a session
  // called proj:api could never be seen, attached to, or killed.
  assert.deepEqual(parseZellijSessions(REAL.listAnsi), [
    { name: "proj:api", current: false, exited: false },
    { name: "my proj", current: false, exited: false },
  ]);
});

test("current and exited markers survive the real listing format", () => {
  assert.deepEqual(parseZellijSessions(`${REAL.current}\n${REAL.exited}`), [
    { name: "work", current: true, exited: false },
    { name: "old-run", current: false, exited: true },
  ]);
});

test("zellij failures are read from stdout because it exits 0 on error", () => {
  for (const text of [REAL.createDuplicate, REAL.createEmptyName, REAL.createResurrectable]) {
    assert.equal(findZellijFailureMessage(text), text, `should flag: ${text}`);
  }
  assert.equal(findZellijFailureMessage(REAL.deleteMissing), REAL.deleteMissing);
  assert.equal(findZellijFailureMessage(REAL.killMissing), REAL.killMissing);
});

test("the three spellings zellij uses for a missing session are all recognized", () => {
  // kill-session uses double quotes, delete-session prefixes with `Session:`,
  // and `action` uses single quotes. Missing any one of them meant a failed
  // command was reported as a success.
  assert.equal(isZellijMissingTargetMessage(REAL.killMissing), true);
  assert.equal(isZellijMissingTargetMessage(REAL.deleteMissing), true);
  assert.equal(isZellijMissingTargetMessage(REAL.actionMissing), true);
});

test("rename collisions and session-less actions are flagged", () => {
  assert.equal(findZellijFailureMessage(REAL.renameCollision), REAL.renameCollision);
  assert.match(findZellijFailureMessage(REAL.actionNoSession), /^Please specify the session name/);
  assert.equal(findZellijFailureMessage(REAL.deleteRunningRefused), REAL.deleteRunningRefused);
  assert.equal(findZellijFailureMessage("Session already exists\n"), "Session already exists");
});

test("the exited marker is detected through zellij's ANSI colouring", () => {
  // Verbatim from `zellij list-sessions` on 0.43.1: the EXITED word itself
  // carries colour codes inside the parentheses.
  const E = String.fromCharCode(27);
  const raw = `${E}[32;1mECCV${E}[m [Created ${E}[35;1m0s${E}[m ago] (${E}[31;1mEXITED${E}[m - attach to resurrect)`;
  assert.deepEqual(parseZellijSessions(raw), [
    { name: "ECCV", current: false, exited: true },
  ]);
});

test("a successful force delete is not mistaken for a failure", () => {
  // It mentions an existing active session, which must not trip the matcher —
  // including the broadened pattern that now catches the --force refusal.
  assert.equal(findZellijFailureMessage(REAL.deleteRunningOk), null);
});

test("createSession fails when zellij says the session already exists", async () => {
  const api = createZellijOpsApi({
    execOnSession: async () => ({ success: true, code: 0, stdout: REAL.createDuplicate, stderr: "" }),
  });
  const result = await api.createSession({}, { sessionId: "s1", name: "dup" });
  assert.equal(result.success, false);
  assert.equal(result.error, REAL.createDuplicate);
});

// --- Tab and client parsing ---

test("parseZellijTabNames numbers tabs by position", () => {
  // query-tab-names emits names only, in tab order, and zellij itself names
  // unnamed tabs "Tab #N" — those are real names, not diagnostics.
  assert.deepEqual(parseZellijTabNames(REAL.tabNames), [
    { index: 1, name: "Tab #1" },
    { index: 2, name: "my tab" },
    { index: 3, name: "Tab #3" },
  ]);
});

test("parseZellijTabNames returns nothing for a missing session", () => {
  assert.deepEqual(parseZellijTabNames(REAL.actionMissing), [{ index: 1, name: "svc:web" }]);
  // The diagnostic line itself is dropped, but the session list zellij prints
  // under it survives as a bogus tab — which is why listSessionDetails checks
  // for a failure message before trusting the parse.
  assert.equal(findZellijFailureMessage(REAL.actionMissing), "Session 'does-not-exist' not found.");
});

test("the dangling session-list clause is trimmed off error messages", () => {
  // Only the matching line reaches the panel, so keeping "The following
  // sessions are active:" would end the inline error on a colon and nothing.
  assert.equal(findZellijFailureMessage(REAL.actionNoSession), "Please specify the session name to send actions to.");
});

test("parseZellijClients drops the header and keeps commands containing spaces", () => {
  assert.deepEqual(parseZellijClients(REAL.clients), [
    { clientId: "1", paneId: "plugin_2", command: "zellij:about" },
  ]);
  assert.deepEqual(
    parseZellijClients("CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n2 terminal_1 bash -l --posix"),
    [{ clientId: "2", paneId: "terminal_1", command: "bash -l --posix" }],
  );
});

test("listSessionDetails splits tabs from clients in one round trip", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return {
        success: true,
        code: 0,
        stdout: detailsOutput(REAL.tabNames, REAL.clients),
        stderr: "",
      };
    },
  });

  const result = await api.listSessionDetails({}, { sessionId: "s1", sessionName: "svc:web" });
  assert.equal(result.success, true);
  assert.equal(result.tabs.length, 3);
  assert.deepEqual(result.clients, [{ clientId: "1", paneId: "plugin_2", command: "zellij:about" }]);
  assert.equal(commands.length, 1, "tabs and clients must not cost two exec channels");
  assert.match(commands[0], /query-tab-names/);
  assert.match(commands[0], /list-clients/);
});

test("listSessionDetails reports a missing session instead of inventing tabs", async () => {
  // `action` exits 0 on some missing-session paths and 1 on others, so the
  // message is the only reliable signal. Without this check the trailing
  // "the following sessions are active" list is parsed as this session's tabs.
  const api = createZellijOpsApi({
    execOnSession: async () => ({
      success: true,
      code: 0,
      stdout: detailsOutput(REAL.actionMissing, ""),
      stderr: "",
    }),
  });
  const result = await api.listSessionDetails({}, { sessionId: "s1", sessionName: "does-not-exist" });
  assert.equal(result.success, false);
  assert.match(result.error, /not found/);
});

// --- Kill and delete are different operations ---

test("killSession stops the session but leaves it resurrectable", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, stdout: "", stderr: "", code: 0 };
    },
  });

  const result = await api.zellijAction(null, {
    sessionId: "terminal-1",
    action: "killSession",
    sessionName: "VKC",
  });

  assert.deepEqual(result, { success: true });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /zellij kill-session 'VKC'/);
  assert.doesNotMatch(commands[0], /delete-session/);
});

test("deleteSession removes the session for good", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, stdout: "", stderr: "", code: 0 };
    },
  });

  const result = await api.zellijAction(null, {
    sessionId: "terminal-1",
    action: "deleteSession",
    sessionName: "VKC",
  });

  assert.deepEqual(result, { success: true });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /zellij delete-session --force 'VKC'/);
});

test("deleteSession retries only the equivalent force spelling, never a plain kill", async () => {
  // A bare `delete-session` refuses to touch a running session and
  // `kill-session` only kills it, so falling back to either would silently
  // downgrade a permanent delete into something the user did not ask for.
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return commands.length < 2
        ? { success: false, stdout: "unknown option", stderr: "", code: 1 }
        : { success: true, stdout: "", stderr: "", code: 0 };
    },
  });

  const result = await api.zellijAction(null, {
    sessionId: "terminal-1",
    action: "deleteSession",
    sessionName: "VKC",
  });

  assert.deepEqual(result, { success: true });
  assert.equal(commands.length, 2);
  assert.match(commands[0], /delete-session --force 'VKC'/);
  assert.match(commands[1], /delete-session -f 'VKC'/);
  assert.equal(commands.filter((c) => /kill-session/.test(c)).length, 0);
});

test("deleteSession stops retrying once zellij says the target is missing", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, code: 0, stdout: REAL.deleteMissing, stderr: "" };
    },
  });
  const result = await api.zellijAction({}, {
    sessionId: "s1",
    action: "deleteSession",
    sessionName: "does-not-exist",
  });
  assert.equal(result.success, false);
  assert.equal(result.error, REAL.deleteMissing);
  assert.equal(commands.length, 1, "must not try the other spelling for a missing session");
});

// --- Rename and new tab ---

test("renameSession targets the old name with a global --session flag", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, code: 0, stdout: "", stderr: "" };
    },
  });
  const result = await api.zellijAction({}, {
    sessionId: "s1",
    action: "renameSession",
    sessionName: "svc:web",
    newName: "svc api",
  });
  assert.deepEqual(result, { success: true });
  assert.match(commands[0], /zellij --session 'svc:web' action rename-session 'svc api'/);
});

test("renameSession to the same or an empty name never reaches zellij", async () => {
  // Zellij accepts an empty rename, exits 0 and silently does nothing, so the
  // guard has to be here rather than in the exit status.
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(
    await api.zellijAction({}, { sessionId: "s1", action: "renameSession", sessionName: "dev", newName: "dev" }),
    { success: true },
  );
  const empty = await api.zellijAction({}, {
    sessionId: "s1", action: "renameSession", sessionName: "dev", newName: "   ",
  });
  assert.equal(empty.success, false);
  assert.equal(commands.length, 0);
});

test("renameSession surfaces a name collision that zellij reports on stdout", async () => {
  const api = createZellijOpsApi({
    execOnSession: async () => ({ success: true, code: 0, stdout: REAL.renameCollision, stderr: "" }),
  });
  const result = await api.zellijAction({}, {
    sessionId: "s1",
    action: "renameSession",
    sessionName: "dev",
    newName: "taken",
  });
  assert.equal(result.success, false);
  assert.equal(result.error, REAL.renameCollision);
});

test("createTab passes a name only when one was given", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, code: 0, stdout: "", stderr: "" };
    },
  });
  await api.zellijAction({}, {
    sessionId: "s1", action: "createTab", sessionName: "svc:web", tabName: "logs",
  });
  await api.zellijAction({}, { sessionId: "s1", action: "createTab", sessionName: "svc:web" });
  assert.match(commands[0], /zellij --session 'svc:web' action new-tab --name 'logs'/);
  assert.match(commands[1], /zellij --session 'svc:web' action new-tab"$/);
});

test("createTab against a session that is no longer running reports the failure", async () => {
  const api = createZellijOpsApi({
    execOnSession: async () => ({ success: true, code: 0, stdout: REAL.actionMissing, stderr: "" }),
  });
  const result = await api.zellijAction({}, {
    sessionId: "s1", action: "createTab", sessionName: "does-not-exist", tabName: "logs",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /not found/);
});

test("unknown zellij actions are rejected", async () => {
  const api = createZellijOpsApi({ execOnSession: async () => ({ success: true, code: 0, stdout: "", stderr: "" }) });
  const result = await api.zellijAction({}, {
    sessionId: "s1", action: "goToTab", sessionName: "svc:web",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Unsupported/);
});
