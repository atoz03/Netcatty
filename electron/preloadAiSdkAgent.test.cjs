"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreloadApi } = require("./preload/api.cjs");

test("aiSdkAgentStream whitelists CodeBuddy options without overriding core fields", async () => {
  let invocation;
  const api = createPreloadApi({
    ipcRenderer: {
      invoke: async (channel, payload) => {
        invocation = { channel, payload };
        return { ok: true };
      },
    },
    dataListeners: new Map(),
  });

  await api.aiSdkAgentStream(
    "request-1",
    "chat-1",
    "codebuddy",
    "hello",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "skills",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "observer",
    {
      effort: "high",
      maxTurns: 10,
      requestId: "overridden",
      chatSessionId: "overridden",
      permissionMode: "auto",
    },
  );

  assert.equal(invocation.channel, "netcatty:ai:sdk-agent:stream");
  assert.equal(invocation.payload.requestId, "request-1");
  assert.equal(invocation.payload.chatSessionId, "chat-1");
  assert.equal(invocation.payload.permissionMode, "observer");
  assert.equal(invocation.payload.effort, "high");
  assert.equal(invocation.payload.maxTurns, 10);
});
