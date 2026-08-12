"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  createAgentCliHelpers,
  CODEX_AUTH_VALIDATION_TIMEOUT_MS,
  DEFAULT_CODEX_CLI_TIMEOUT_MS,
  MAX_AGENT_CLI_BUFFER_CHARS,
} = require("./agentCliHelpers.cjs");

function createHungChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

test("runCodexCli applies a default timeout to short status commands", async () => {
  const child = createHungChild();
  const scheduled = [];
  const helpers = createAgentCliHelpers({
    prepareCommandForSpawn: (command, args) => ({ command, args, shell: false }),
    spawn: () => child,
    stripAnsi: (value) => value,
    getShellEnv: async () => ({}),
    normalizeCliPathForPlatform: (value) => value,
    resolveCliFromPathAsync: async () => "/fake/codex",
    setTimeout: (callback, delay) => {
      scheduled.push(delay);
      queueMicrotask(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  const safetyTimer = globalThis.setTimeout(() => child.emit("close", 0), 25);

  try {
    await assert.rejects(
      helpers.runCodexCli(["login", "status"], {}),
      (error) => error?.code === "ETIMEDOUT",
    );
  } finally {
    globalThis.clearTimeout(safetyTimer);
  }
  assert.equal(scheduled[0], DEFAULT_CODEX_CLI_TIMEOUT_MS);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("runCodexCli slices a single oversized output chunk to the hard limit", async () => {
  const child = createHungChild();
  const helpers = createAgentCliHelpers({
    prepareCommandForSpawn: (command, args) => ({ command, args, shell: false }),
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("x".repeat(MAX_AGENT_CLI_BUFFER_CHARS + 257)));
        child.emit("close", 0);
      });
      return child;
    },
    stripAnsi: (value) => value,
    getShellEnv: async () => ({}),
    normalizeCliPathForPlatform: (value) => value,
    resolveCliFromPathAsync: async () => "/fake/codex",
  });

  const result = await helpers.runCodexCli(["--version"], {});
  assert.equal(result.stdout.length, MAX_AGENT_CLI_BUFFER_CHARS);
});

test("runCodexCli preserves split UTF-8 independently on stdout and stderr", async () => {
  const child = createHungChild();
  const helpers = createAgentCliHelpers({
    prepareCommandForSpawn: (command, args) => ({ command, args, shell: false }),
    spawn: () => {
      queueMicrotask(() => {
        const stdout = Buffer.from("中文", "utf8");
        const stderr = Buffer.from("错误", "utf8");
        child.stdout.emit("data", stdout.subarray(0, 2));
        child.stderr.emit("data", stderr.subarray(0, 1));
        child.stdout.emit("data", stdout.subarray(2));
        child.stderr.emit("data", stderr.subarray(1));
        child.emit("close", 0);
      });
      return child;
    },
    stripAnsi: (value) => value,
    getShellEnv: async () => ({}),
    normalizeCliPathForPlatform: (value) => value,
    resolveCliFromPathAsync: async () => "/fake/codex",
  });

  const result = await helpers.runCodexCli(["--version"], {});
  assert.deepEqual(result, { stdout: "中文", stderr: "错误", exitCode: 0 });
});

test("runCodexCli omits an incomplete UTF-8 suffix at its byte limit", async () => {
  const child = createHungChild();
  const helpers = createAgentCliHelpers({
    prepareCommandForSpawn: (command, args) => ({ command, args, shell: false }),
    spawn: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("x".repeat(MAX_AGENT_CLI_BUFFER_CHARS - 1)));
        child.stdout.emit("data", Buffer.from("中", "utf8"));
        child.emit("close", 0);
      });
      return child;
    },
    stripAnsi: (value) => value,
    getShellEnv: async () => ({}),
    normalizeCliPathForPlatform: (value) => value,
    resolveCliFromPathAsync: async () => "/fake/codex",
  });

  const result = await helpers.runCodexCli(["--version"], {});
  assert.equal(result.stdout.length, MAX_AGENT_CLI_BUFFER_CHARS - 1);
  assert.doesNotMatch(result.stdout, /�/u);
});

function createValidationHelpers({ loadCodexSdk, setTimeout, clearTimeout }) {
  return createAgentCliHelpers({
    getCodexValidationCache: () => null,
    setCodexValidationCache() {},
    normalizeCliPathForPlatform: (value) => value,
    getShellEnv: async () => ({}),
    resolveSdkBinPathAsync: async () => "/fake/codex",
    resolveCodexExecutableForSdk: (value) => value,
    addCodexExecutableEnvForSdk: (env) => env,
    extractCodexError: (error) => ({ message: error?.message || String(error) }),
    loadCodexSdk,
    ...(setTimeout ? { setTimeout } : {}),
    ...(clearTimeout ? { clearTimeout } : {}),
  });
}

test("ChatGPT auth validation coalesces concurrent probes and cleans the stream", async () => {
  let runCount = 0;
  let returnCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const helpers = createValidationHelpers({
    loadCodexSdk: async () => ({
      Codex: class {
        startThread() {
          return {
            async runStreamed(_prompt, options) {
              runCount += 1;
              assert.equal(options.signal.aborted, false);
              const iterator = {
                async next() {
                  await gate;
                  return { done: false, value: { type: "item.completed" } };
                },
                async return() {
                  returnCount += 1;
                  return { done: true };
                },
              };
              return { events: { [Symbol.asyncIterator]: () => iterator } };
            },
          };
        }
      },
    }),
  });

  const first = helpers.validateCodexChatGptAuth({ codexPath: "/fake/codex" });
  const second = helpers.validateCodexChatGptAuth({ codexPath: "/fake/codex" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runCount, 1);
  release();

  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true, checkedAt: (await first).checkedAt, codexPath: "/fake/codex", error: null },
    { ok: true, checkedAt: (await second).checkedAt, codexPath: "/fake/codex", error: null },
  ]);
  assert.equal(returnCount, 1);
});

test("ChatGPT auth validation aborts and settles when the SDK stream hangs", async () => {
  let observedSignal;
  let returnCount = 0;
  const scheduled = [];
  let releaseSafety;
  const safetyGate = new Promise((resolve) => { releaseSafety = resolve; });
  const helpers = createValidationHelpers({
    loadCodexSdk: async () => ({
      Codex: class {
        startThread() {
          return {
            async runStreamed(_prompt, options) {
              observedSignal = options.signal;
              const iterator = {
                async next() {
                  await safetyGate;
                  return { done: false, value: { type: "item.completed" } };
                },
                async return() {
                  returnCount += 1;
                  return { done: true };
                },
              };
              return { events: { [Symbol.asyncIterator]: () => iterator } };
            },
          };
        }
      },
    }),
    setTimeout: (callback, delay) => {
      scheduled.push(delay);
      queueMicrotask(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  const safetyTimer = globalThis.setTimeout(releaseSafety, 25);

  try {
    const result = await helpers.validateCodexChatGptAuth({ codexPath: "/fake/codex" });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/i);
  } finally {
    globalThis.clearTimeout(safetyTimer);
    releaseSafety();
  }
  assert.equal(scheduled[0], CODEX_AUTH_VALIDATION_TIMEOUT_MS);
  assert.equal(observedSignal.aborted, true);
  assert.equal(returnCount, 1);
});
