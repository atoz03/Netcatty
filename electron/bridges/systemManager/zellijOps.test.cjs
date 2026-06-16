const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createZellijOpsApi,
  parseZellijSessions,
  parseZellijVersionString,
  sanitizeNewSessionName,
  isNoZellijSessionsMessage,
  buildZellijCommand,
} = require("./zellijOps.cjs");

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
