"use strict";

const { StringDecoder } = require("node:string_decoder");

const DEFAULT_EXTERNAL_MCP_CLI_TIMEOUT_MS = 30_000;
const DEFAULT_EXTERNAL_MCP_CLI_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_EXTERNAL_MCP_CLI_KILL_GRACE_MS = 750;

function runBoundedCliCommand(deps, command, args = [], options = {}) {
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs) || DEFAULT_EXTERNAL_MCP_CLI_TIMEOUT_MS,
  );
  const maxOutputBytes = Math.max(
    1,
    Number(options.maxOutputBytes) || DEFAULT_EXTERNAL_MCP_CLI_MAX_OUTPUT_BYTES,
  );
  const killGraceMs = Math.max(
    1,
    Number(options.killGraceMs) || DEFAULT_EXTERNAL_MCP_CLI_KILL_GRACE_MS,
  );
  const signal = options.signal || null;

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let closed = false;
    let timeoutTimer = null;
    let forceKillTimer = null;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let decodersEnded = false;

    const clearTimeoutTimer = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;
    };
    const clearForceKillTimer = () => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
    };
    const removeDataListeners = () => {
      child?.stdout?.removeListener?.("data", onStdout);
      child?.stderr?.removeListener?.("data", onStderr);
    };
    const detachAbort = () => signal?.removeEventListener?.("abort", onAbort);
    const armForcedKill = () => {
      if (!child || closed || forceKillTimer) return;
      try { child.kill?.("SIGTERM"); } catch { /* ignore */ }
      forceKillTimer = setTimeout(() => {
        if (closed) return;
        try { child.kill?.("SIGKILL"); } catch { /* ignore */ }
      }, killGraceMs);
      forceKillTimer.unref?.();
    };
    const rejectAndTerminate = (error) => {
      if (settled) return;
      settled = true;
      clearTimeoutTimer();
      detachAbort();
      removeDataListeners();
      armForcedKill();
      reject(error);
    };
    const append = (target, chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
        if (target === "stdout") stdout += stdoutDecoder.write(accepted);
        else stderr += stderrDecoder.write(accepted);
        outputBytes += accepted.length;
      }
      if (buffer.length > remaining) {
        const error = new Error(`CLI output exceeded ${maxOutputBytes} bytes`);
        error.code = "CLI_OUTPUT_LIMIT";
        rejectAndTerminate(error);
      }
    };
    const onStdout = (chunk) => append("stdout", chunk);
    const onStderr = (chunk) => append("stderr", chunk);
    const onAbort = () => {
      const reason = signal?.reason;
      const error = reason instanceof Error ? reason : new Error("CLI command was cancelled");
      if (!error.code) error.code = "ABORT_ERR";
      rejectAndTerminate(error);
    };
    const onError = (error) => {
      closed = true;
      clearTimeoutTimer();
      clearForceKillTimer();
      detachAbort();
      removeDataListeners();
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onClose = (exitCode) => {
      closed = true;
      clearTimeoutTimer();
      clearForceKillTimer();
      detachAbort();
      removeDataListeners();
      if (settled) return;
      settled = true;
      if (!decodersEnded) {
        decodersEnded = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      resolve({
        exitCode,
        stdout: deps.stripAnsi(stdout),
        stderr: deps.stripAnsi(stderr),
      });
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      const spawnSpec = deps.prepareCommandForSpawn(command, args);
      child = deps.spawn(spawnSpec.command, spawnSpec.args || [], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options.cwd || undefined,
        env: options.env || process.env,
        shell: spawnSpec.shell,
        windowsHide: true,
      });
    } catch (error) {
      settled = true;
      reject(error);
      return;
    }

    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    child.once?.("error", onError);
    child.once?.("close", onClose);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      const error = new Error(`CLI command timed out after ${timeoutMs} ms`);
      error.code = "CLI_TIMEOUT";
      rejectAndTerminate(error);
    }, timeoutMs);
    if (signal?.aborted) onAbort();
  });
}

module.exports = {
  DEFAULT_EXTERNAL_MCP_CLI_TIMEOUT_MS,
  DEFAULT_EXTERNAL_MCP_CLI_MAX_OUTPUT_BYTES,
  DEFAULT_EXTERNAL_MCP_CLI_KILL_GRACE_MS,
  runBoundedCliCommand,
};
