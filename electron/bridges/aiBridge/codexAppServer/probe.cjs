"use strict";

const { execFile } = require("node:child_process");
const { buildCodexAppServerLaunch } = require("./connection.cjs");

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function probeCodexAppServer({ binPath, env, execFileImpl = execFileText }) {
  try {
    const launch = buildCodexAppServerLaunch(binPath, ["app-server", "--help"]);
    const result = await execFileImpl(launch.command, launch.args, {
      env: { ...(env || {}), ...(launch.env || {}) },
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const available = /Run the app server|--listen|--stdio/i.test(output);
    return available
      ? { available: true }
      : { available: false, error: "This Codex CLI does not advertise App Server support." };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error || "").trim();
    return {
      available: false,
      error: detail || "Failed to probe Codex App Server support.",
    };
  }
}

module.exports = { execFileText, probeCodexAppServer };
