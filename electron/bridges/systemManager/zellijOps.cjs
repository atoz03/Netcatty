/* eslint-disable no-undef */

const {
  shQuote,
  wrapLoginShell,
  stripAnsi,
} = require("./tmuxEnv.cjs");

/**
 * Zellij's empty-list message. Verified against zellij 0.43.1, which prints
 * "No active zellij sessions found." and exits 1 — the older, narrower
 * "no active sessions" spelling matched none of it, so an empty host was
 * reported as a hard error instead of an empty list.
 */
const ZELLIJ_NO_SESSIONS = /no\s+active\s+(?:zellij\s+)?sessions/i;

/**
 * Lines that are messages rather than session entries. `Session: <name> not
 * found.` and shell "command not found" noise are matched explicitly; a blanket
 * "not found" would also swallow a missing-binary error and report it as an
 * empty session list.
 */
const ZELLIJ_DIAGNOSTIC_LINE = new RegExp(
  [
    "^error:",
    "^usage:",
    "^unknown command",
    "^failed to",
    "^no\\s+active\\s+(?:zellij\\s+)?sessions",
    "^session:\\s",
    "command not found",
    "^\\S+:\\s+zellij:\\s",
  ].join("|"),
  "i",
);

/**
 * A session entry as zellij prints it: `name [Created 5s ago]`, optionally
 * followed by `(current)` or `(EXITED - attach to resurrect)`. Anchoring on the
 * `[Created ... ago]` marker is what lets the name hold any character —
 * including the `:` and spaces that zellij accepts — without a diagnostic line
 * being mistaken for a session.
 */
const ZELLIJ_SESSION_LINE = /^(.*?)\s*\[Created\s[^\]]*\]\s*(?:\(([^)]*)\))?\s*$/;

const ZELLIJ_CURRENT_STATUS = /\b(?:current|attached)\b/i;
const ZELLIJ_EXITED_STATUS = /\b(?:exited|dead)\b/i;

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
  const lines = stripAnsi(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => (
      line
      && !line.startsWith("__ZELLIJ_VERSION__=")
      && !ZELLIJ_DIAGNOSTIC_LINE.test(line)
    ));

  const sessions = [];
  for (const line of lines) {
    const match = line.match(ZELLIJ_SESSION_LINE);
    if (!match) continue;
    const name = (match[1] || "").trim();
    if (!name) continue;
    const status = match[2] || "";
    sessions.push({
      name,
      current: ZELLIJ_CURRENT_STATUS.test(status),
      exited: ZELLIJ_EXITED_STATUS.test(status),
    });
  }
  if (sessions.length > 0) return sessions;

  // Fallback for builds that omit the `[Created ... ago]` marker: strip any
  // bracket/paren suffixes and treat what is left as the name. Diagnostics were
  // already filtered above, so this cannot invent a session out of an error.
  const lenient = [];
  for (const line of lines) {
    const name = line
      .replace(/\s*\((?:current|attached|exited|dead)[^)]*\)/ig, "")
      .replace(/\s*\[[^\]]*\]/g, "")
      .trim();
    if (!name) continue;
    lenient.push({
      name,
      current: /\((?:current|attached)\b/i.test(line),
      exited: /\((?:exited|dead)\b/i.test(line),
    });
  }
  return lenient;
}

function isNoZellijSessionsMessage(text, code) {
  if (code !== 0 && code !== 1) return false;
  return ZELLIJ_NO_SESSIONS.test(String(text || ""));
}

/**
 * Zellij reports command failures on stdout and still exits 0 — verified on
 * 0.43.1 for "Session already exists", an empty session name, and deleting or
 * killing a session that does not exist. Reading only the exit status made
 * every one of those look like a success: the create modal closed on a session
 * that was never created, and killing a stale entry reported success.
 */
const ZELLIJ_FAILURE_MESSAGE = /(session already exists|session name cannot be empty|cannot use this name)/i;

/** Failures that mean the target is gone, so retrying other spellings is pointless. */
const ZELLIJ_MISSING_TARGET_MESSAGE = /(no session named|^session:\s*"[^"]*"\s*not found)/im;

function findZellijFailureMessage(text) {
  const value = String(text || "");
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (ZELLIJ_FAILURE_MESSAGE.test(line) || ZELLIJ_MISSING_TARGET_MESSAGE.test(line)) {
      return line;
    }
  }
  return null;
}

function isZellijMissingTargetMessage(text) {
  return ZELLIJ_MISSING_TARGET_MESSAGE.test(String(text || ""));
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
    // Exit 0 is not enough — see findZellijFailureMessage.
    const failure = findZellijFailureMessage(result.stdout);
    if (failure) return { success: false, error: failure };
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
      const failure = result.success ? findZellijFailureMessage(result.stdout) : null;
      if (result.success && !failure) return { success: true };
      lastError = failure || result.error || result.stderr || result.stdout || lastError;
      // The session does not exist; the remaining spellings cannot find it either.
      if (isZellijMissingTargetMessage(lastError)) break;
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
  findZellijFailureMessage,
  isZellijMissingTargetMessage,
  buildZellijCommand,
};
