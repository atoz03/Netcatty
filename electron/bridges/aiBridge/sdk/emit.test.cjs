const test = require("node:test");
const assert = require("node:assert/strict");
const { createStreamEmitter } = require("./emit.cjs");

function recordingSend() {
  const calls = [];
  const safeSend = (sender, channel, payload) => calls.push({ channel, payload });
  return { calls, safeSend };
}

test("emitEvent sends on netcatty:ai:sdk-agent:event with requestId+event", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "req-1" });
  e.emitEvent({ type: "text-delta", textDelta: "hi" });
  assert.deepEqual(calls[0], {
    channel: "netcatty:ai:sdk-agent:event",
    payload: { requestId: "req-1", event: { type: "text-delta", textDelta: "hi" } },
  });
});

test("emitDone sends on netcatty:ai:sdk-agent:done", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "req-2" });
  e.emitDone();
  assert.deepEqual(calls[0], { channel: "netcatty:ai:sdk-agent:done", payload: { requestId: "req-2" } });
});

test("emitError sends on netcatty:ai:sdk-agent:error with message", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "req-3" });
  e.emitError("boom");
  assert.deepEqual(calls[0], { channel: "netcatty:ai:sdk-agent:error", payload: { requestId: "req-3", error: "boom" } });
});

test("convenience helpers emit the canonical event shapes", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "r" });
  e.text("abc");
  e.toolCall("terminal_execute", { command: "ls" }, "tc-1");
  e.toolResult("tc-1", "out", "terminal_execute");
  e.fileChange("patch-1", [{ path: "src/app.ts", kind: "update" }], "completed");
  e.webSearch("search-1", "Codex events", "running");
  e.planUpdate("plan-1", [{ text: "Map events", completed: false }], "running");
  e.warning("warning-1", "Search unavailable");
  e.usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  e.status("Working...");
  e.sessionId("sess-9");
  assert.deepEqual(calls.map((c) => c.payload.event.type),
    [
      "text-delta", "tool-call", "tool-result", "file-change", "web-search",
      "plan-update", "warning", "usage", "status", "session-id",
    ]);
  assert.equal(calls[1].payload.event.toolName, "terminal_execute");
  assert.equal(calls[1].payload.event.toolCallId, "tc-1");
  assert.deepEqual(calls[1].payload.event.args, { command: "ls" });
  assert.equal(calls[2].payload.event.output, "out");
  assert.equal(calls[3].payload.event.itemId, "patch-1");
  assert.equal(calls[7].payload.event.totalTokens, 15);
  assert.equal(calls[9].payload.event.sessionId, "sess-9");
});
