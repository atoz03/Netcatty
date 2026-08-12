"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { runBoundedCliCommand } = require("./boundedCliCommand.cjs");

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function depsFor(child) {
  return {
    prepareCommandForSpawn: (command, args) => ({ command, args, shell: false }),
    spawn: () => child,
    stripAnsi: (value) => value,
  };
}

test("bounded external MCP CLI times out and escalates termination", async () => {
  const child = createChild();
  await assert.rejects(
    runBoundedCliCommand(depsFor(child), "codex", [], { timeoutMs: 5, killGraceMs: 5 }),
    (error) => error.code === "CLI_TIMEOUT",
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null);
});

test("bounded external MCP CLI caps combined output and removes data listeners", async () => {
  const child = createChild();
  const result = runBoundedCliCommand(depsFor(child), "claude", [], {
    timeoutMs: 100,
    maxOutputBytes: 8,
  });
  child.stdout.emit("data", Buffer.from("12345"));
  child.stderr.emit("data", Buffer.from("67890"));
  await assert.rejects(result, (error) => error.code === "CLI_OUTPUT_LIMIT");
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("close", null);
});

test("bounded external MCP CLI propagates spawn errors and clears timers", async () => {
  const child = createChild();
  const result = runBoundedCliCommand(depsFor(child), "grok", [], { timeoutMs: 5 });
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(result, /spawn failed/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(child.kills, []);
});

test("bounded external MCP CLI cancels and force-closes a stuck child", async () => {
  const child = createChild();
  const controller = new AbortController();
  const result = runBoundedCliCommand(depsFor(child), "codex", [], {
    signal: controller.signal,
    timeoutMs: 100,
    killGraceMs: 5,
  });
  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null);
});

test("bounded external MCP CLI resolves output and leaves no listeners", async () => {
  const child = createChild();
  const result = runBoundedCliCommand(depsFor(child), "codex", [], { timeoutMs: 100 });
  child.stdout.emit("data", Buffer.from("ok"));
  child.stderr.emit("data", Buffer.from("warn"));
  child.emit("close", 0);
  assert.deepEqual(await result, { exitCode: 0, stdout: "ok", stderr: "warn" });
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("bounded external MCP CLI preserves UTF-8 split across stdout chunks", async () => {
  const child = createChild();
  const result = runBoundedCliCommand(depsFor(child), "codex", [], { timeoutMs: 100 });
  const bytes = Buffer.from("中文", "utf8");
  child.stdout.emit("data", bytes.subarray(0, 2));
  child.stdout.emit("data", bytes.subarray(2, 4));
  child.stdout.emit("data", bytes.subarray(4));
  child.emit("close", 0);

  assert.deepEqual(await result, { exitCode: 0, stdout: "中文", stderr: "" });
});

test("bounded external MCP CLI completes a UTF-8 code point at the byte limit", async () => {
  const child = createChild();
  const bytes = Buffer.from("中", "utf8");
  const result = runBoundedCliCommand(depsFor(child), "codex", [], {
    timeoutMs: 100,
    maxOutputBytes: bytes.length,
  });
  child.stdout.emit("data", bytes.subarray(0, 2));
  child.stdout.emit("data", bytes.subarray(2));
  child.emit("close", 0);

  assert.deepEqual(await result, { exitCode: 0, stdout: "中", stderr: "" });
});

test("bounded external MCP CLI decodes stdout and stderr independently", async () => {
  const child = createChild();
  const stdoutBytes = Buffer.from("中", "utf8");
  const stderrBytes = Buffer.from("文", "utf8");
  const result = runBoundedCliCommand(depsFor(child), "codex", [], { timeoutMs: 100 });
  child.stdout.emit("data", stdoutBytes.subarray(0, 2));
  child.stderr.emit("data", stderrBytes.subarray(0, 1));
  child.stdout.emit("data", stdoutBytes.subarray(2));
  child.stderr.emit("data", stderrBytes.subarray(1));
  child.emit("close", 0);

  assert.deepEqual(await result, { exitCode: 0, stdout: "中", stderr: "文" });
});
