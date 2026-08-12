"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const terminalBridge = require("./terminalBridge.cjs");

test("renderer terminal input reports activity for the matching session", () => {
  const writes = [];
  const activity = [];
  const sessions = new Map([
    ["session-1", {
      proc: { write: (data) => writes.push(data) },
      webContentsId: 1,
    }],
  ]);
  terminalBridge.init({
    sessions,
    electronModule: { webContents: { fromId: () => null } },
    reportOpenedSessionActivity: (event) => activity.push(event),
  });

  terminalBridge.writeToSession({ sender: {} }, {
    sessionId: "session-1",
    data: "pwd\r",
  });

  assert.deepEqual(writes, ["pwd\r"]);
  assert.deepEqual(activity, [
    { sessionId: "session-1", phase: "touch" },
  ]);
});

test("only a submitted non-sensitive user command arms cwd recovery", () => {
  const stream = { write() { return true; } };
  const session = { stream, webContentsId: 1, blockUntargetedCwdProbe: true };
  const sessions = new Map([["session-1", session]]);
  terminalBridge.init({ sessions, electronModule: { webContents: { fromId: () => null } } });

  terminalBridge.writeToSession({ sender: {} }, {
    sessionId: "session-1", data: "pwd", automated: false,
  });
  assert.notEqual(session.pendingCwdRecoveryAfterUserCommand, true);

  terminalBridge.writeToSession({ sender: {} }, {
    sessionId: "session-1", data: "secret\r", sensitive: true,
  });
  assert.notEqual(session.pendingCwdRecoveryAfterUserCommand, true);

  terminalBridge.writeToSession({ sender: {} }, {
    sessionId: "session-1", data: "pwd\r", automated: false,
  });
  assert.equal(session.pendingCwdRecoveryAfterUserCommand, true);
});

test("blocked transfer input and failed writes do not arm cwd recovery", () => {
  const blocked = {
    stream: { write() { throw new Error("must not write during transfer"); } },
    webContentsId: 1,
    blockUntargetedCwdProbe: true,
    zmodemSentry: { isActive: () => true, cancel() {} },
  };
  const failed = {
    stream: { write() { throw Object.assign(new Error("closed"), { code: "EPIPE" }); } },
    webContentsId: 1,
    blockUntargetedCwdProbe: true,
  };
  const sessions = new Map([["blocked", blocked], ["failed", failed]]);
  terminalBridge.init({ sessions, electronModule: { webContents: { fromId: () => null } } });

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "blocked", data: "pwd\r" });
  terminalBridge.writeToSession({ sender: {} }, { sessionId: "failed", data: "pwd\r" });

  assert.notEqual(blocked.pendingCwdRecoveryAfterUserCommand, true);
  assert.notEqual(failed.pendingCwdRecoveryAfterUserCommand, true);
});
