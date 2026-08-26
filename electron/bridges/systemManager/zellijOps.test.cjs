const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createZellijOpsApi,
  parseZellijSessions,
  parseZellijVersionString,
  sanitizeNewSessionName,
  isNoZellijSessionsMessage,
  findZellijFailureMessage,
  isZellijMissingTargetMessage,
  buildZellijCommand,
} = require("./zellijOps.cjs");

/**
 * Captured from zellij 0.43.1 rather than written from memory. Every fixture
 * below is verbatim output, including the ANSI colouring `list-sessions` emits
 * when it is not given `--no-formatting`.
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
};

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

test("zellijAction prefers delete-session with force so exited sessions are removed", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, sessionId, command) => {
      commands.push({ sessionId, command });
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
  assert.match(commands[0].command, /zellij delete-session --force 'VKC'/);
});

test("zellijAction falls back across zellij delete command variants", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, sessionId, command) => {
      commands.push({ sessionId, command });
      return commands.length < 3
        ? { success: false, stdout: "unknown option", stderr: "", code: 1 }
        : { success: true, stdout: "", stderr: "", code: 0 };
    },
  });

  const result = await api.zellijAction(null, {
    sessionId: "terminal-1",
    action: "killSession",
    sessionName: "VKC",
  });

  assert.deepEqual(result, { success: true });
  assert.equal(commands.length, 3);
  assert.match(commands[0].command, /zellij delete-session --force 'VKC'/);
  assert.match(commands[1].command, /zellij delete-session -f 'VKC'/);
  assert.match(commands[2].command, /zellij delete-session 'VKC'/);
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
  // It mentions an existing active session, which must not trip the matcher.
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

test("killSession stops retrying once zellij says the target is missing", async () => {
  const commands = [];
  const api = createZellijOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      commands.push(command);
      return { success: true, code: 0, stdout: REAL.deleteMissing, stderr: "" };
    },
  });
  const result = await api.zellijAction({}, {
    sessionId: "s1",
    action: "killSession",
    sessionName: "does-not-exist",
  });
  assert.equal(result.success, false);
  assert.equal(result.error, REAL.deleteMissing);
  assert.equal(commands.length, 1, "must not try the other spellings for a missing session");
  assert.equal(isZellijMissingTargetMessage(REAL.killMissing), true);
});
