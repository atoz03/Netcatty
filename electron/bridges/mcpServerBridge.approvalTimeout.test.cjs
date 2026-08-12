"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

const mcpServerBridge = require("./mcpServerBridge.cjs");

function createFakeWindow() {
  const contents = new EventEmitter();
  contents.id = Math.floor(Math.random() * 1e6);
  contents.send = (channel, payload) => {
    contents.emit("send", channel, payload);
  };
  contents.isDestroyed = () => false;
  return {
    isDestroyed: () => false,
    webContents: contents,
  };
}

function stubNow(t, startMs) {
  const realNow = Date.now;
  let now = startMs;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  return {
    advance: (deltaMs) => {
      now += deltaMs;
    },
  };
}

test("cancelApprovalTimeoutFromRenderer keeps the absolute MCP deadline armed", async (t) => {
  const win = createFakeWindow();
  mcpServerBridge.setMainWindowGetter(() => win);
  t.after(() => {
    mcpServerBridge.clearPendingApprovals();
    mcpServerBridge.setMainWindowGetter(() => null);
  });

  const requests = [];
  const cleared = [];
  win.webContents.on("send", (channel, payload) => {
    if (channel === "netcatty:ai:mcp:approval-request") requests.push(payload);
    if (channel === "netcatty:ai:mcp:approval-cleared") {
      cleared.push(...(payload?.approvalIds || []));
    }
  });

  const clock = stubNow(t, 1_000_000);
  const approvalPromise = mcpServerBridge.requestApprovalFromRenderer(
    "terminal_execute",
    { command: "echo hi" },
    "chat-mcp-absolute",
  );

  assert.equal(requests.length, 1);
  const approvalId = requests[0].approvalId;

  // Jump close to the 110s absolute ceiling, then cancel idle. Remaining absolute ~40ms.
  clock.advance(109_960);
  assert.equal(mcpServerBridge.cancelApprovalTimeoutFromRenderer(approvalId), true);
  assert.equal(mcpServerBridge.cancelApprovalTimeoutFromRenderer(approvalId), false);

  await delay(20);
  assert.equal(cleared.includes(approvalId), false, "must stay pending before absolute expiry");

  const outcome = await Promise.race([
    approvalPromise.then((approved) => ({ approved })),
    delay(120).then(() => ({ approved: "timeout-wait" })),
  ]);
  assert.deepEqual(outcome, { approved: false });
  assert.ok(cleared.includes(approvalId));
});

test("cancelApprovalTimeoutFromRenderer still allows explicit approve before absolute expiry", async (t) => {
  const win = createFakeWindow();
  mcpServerBridge.setMainWindowGetter(() => win);
  t.after(() => {
    mcpServerBridge.clearPendingApprovals();
    mcpServerBridge.setMainWindowGetter(() => null);
  });

  const requests = [];
  win.webContents.on("send", (channel, payload) => {
    if (channel === "netcatty:ai:mcp:approval-request") requests.push(payload);
  });

  stubNow(t, 2_000_000);
  const approvalPromise = mcpServerBridge.requestApprovalFromRenderer(
    "sftp_write",
    { path: "/tmp/x" },
    "chat-mcp-approve",
  );
  const approvalId = requests[0].approvalId;

  assert.equal(mcpServerBridge.cancelApprovalTimeoutFromRenderer(approvalId), true);
  mcpServerBridge.resolveApprovalFromRenderer(approvalId, true);
  assert.equal(await approvalPromise, true);
});
