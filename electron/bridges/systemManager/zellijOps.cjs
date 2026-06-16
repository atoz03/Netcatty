/* eslint-disable no-undef */

const {
  shQuote,
  wrapLoginShell,
  stripAnsi,
} = require("./tmuxEnv.cjs");

const ZELLIJ_NO_SESSIONS = /(no active sessions|no sessions|not found|session.*not.*found)/i;
const ZELLIJ_DIAGNOSTIC_LINE = /^(error:|usage:|unknown command|failed to|no active sessions|no sessions)/i;

function sanitizeNewSessionName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 64);
}

function parseZellijVersionString(stdout) {
  const text = stripAnsi(stdout).trim();
  const match = text.match(/zellij\s+([^\s]+)/i);
  return match ? `zellij ${match[1]}` : text;
}

function parseZellijSessions(stdout) {
  const sessions = [];
  for (const rawLine of stripAnsi(stdout).split("\n")) {
    let line = rawLine.trim();
    if (!line || ZELLIJ_DIAGNOSTIC_LINE.test(line)) continue;
    if (line.startsWith("__ZELLIJ_VERSION__=")) continue;

    const current = /\((?:current|attached)\b/i.test(line);
    const exited = /\((?:exited|dead)\b/i.test(line);
    line = line
      .replace(/\s+\((?:current|attached|exited|dead)[^)]*\)/ig, "")
      .replace(/\s+\[[^\]]+\]/g, "")
      .trim();

    if (!line || line.includes(":")) continue;
    sessions.push({ name: line, current, exited });
  }
  return sessions;
}

function isNoZellijSessionsMessage(text, code) {
  if (code !== 0 && code !== 1) return false;
  return ZELLIJ_NO_SESSIONS.test(String(text || ""));
}

function buildZellijCommand(args) {
  return `zellij ${String(args || "").trim()}`.trim();
}

function createZellijOpsApi({ execOnSession }) {
  async function run(event, sessionId, command, timeout = 8000) {
    const result = await execOnSession(event, sessionId, wrapLoginShell(command), timeout);
    if (result.pending) return { pending: true, success: false };
    const stdout = stripAnsi(result.stdout || "");
    const stderr = stripAnsi(result.stderr || "");
    const combined = [stderr, stdout].filter(Boolean).join("\n").trim();
    return { ...result, stdout: combined || stdout, stderr };
  }

  async function listSessions(event, sessionId) {
    const command = [
      "echo \"__ZELLIJ_VERSION__=$(zellij --version 2>/dev/null || true)\"",
      "zellij list-sessions 2>&1",
    ].join("; ");
    const result = await run(event, sessionId, command, 8000);
    if (result.pending) return { success: false, pending: true };

    const stdout = result.stdout || "";
    const versionLine = stdout.split("\n")
      .find((line) => line.trim().startsWith("__ZELLIJ_VERSION__="));
    const zellijVersion = parseZellijVersionString(
      versionLine ? versionLine.slice("__ZELLIJ_VERSION__=".length) : "",
    );
    const sessions = parseZellijSessions(stdout);

    if (!result.success && !isNoZellijSessionsMessage(stdout || result.stderr, result.code)) {
      return { success: false, error: result.error || result.stderr || stdout || "Failed to list zellij sessions" };
    }
    return {
      success: true,
      zellijVersion: zellijVersion || undefined,
      sessions,
    };
  }

  async function createSession(event, payload) {
    const sessionId = payload?.sessionId;
    const name = sanitizeNewSessionName(payload?.name);
    if (!sessionId || !name) return { success: false, error: "Missing sessionId or name" };
    const command = buildZellijCommand(`attach --create-background ${shQuote(name)}`);
    const result = await run(event, sessionId, command, 10000);
    if (result.pending) return { success: false, pending: true };
    if (!result.success) {
      return { success: false, error: result.error || result.stderr || result.stdout || "Failed to create zellij session" };
    }
    return { success: true, name };
  }

  async function zellijAction(event, payload) {
    const { sessionId, action, sessionName } = payload || {};
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    if (action !== "killSession") return { success: false, error: "Unsupported zellij action" };
    const name = sanitizeNewSessionName(sessionName);
    if (!name) return { success: false, error: "Missing sessionName" };
    const attempts = [
      `delete-session --force ${shQuote(name)}`,
      `delete-session -f ${shQuote(name)}`,
      `delete-session ${shQuote(name)}`,
      `kill-session ${shQuote(name)}`,
    ];
    let lastError = "";
    for (const args of attempts) {
      const result = await run(event, sessionId, buildZellijCommand(args), 8000);
      if (result.pending) return { success: false, pending: true };
      if (result.success) return { success: true };
      lastError = result.error || result.stderr || result.stdout || lastError;
    }
    return { success: false, error: lastError || "zellij command failed" };
  }

  return { listSessions, createSession, zellijAction };
}

module.exports = {
  createZellijOpsApi,
  parseZellijSessions,
  parseZellijVersionString,
  sanitizeNewSessionName,
  isNoZellijSessionsMessage,
  buildZellijCommand,
};
