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
    "^session\\s+'[^']*'\\s+not found",
    "^the following sessions are active",
    "^please specify the session name",
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
 *
 * The age itself is deliberately discarded: on 0.43.1 it is stuck at "0s" for
 * the whole life of a session, so surfacing it would show a permanent lie.
 */
const ZELLIJ_SESSION_LINE = /^(.*?)\s*\[Created\s[^\]]*\]\s*(?:\(([^)]*)\))?\s*$/;

const ZELLIJ_CURRENT_STATUS = /\b(?:current|attached)\b/i;
const ZELLIJ_EXITED_STATUS = /\b(?:exited|dead)\b/i;

/** Header emitted by `zellij action list-clients` before any client rows. */
const ZELLIJ_CLIENTS_HEADER = /^CLIENT_ID\s+ZELLIJ_PANE_ID\s+RUNNING_COMMAND/i;

/** Separates the two halves of the combined details command. */
const ZELLIJ_DETAILS_SPLIT = "__NC_ZELLIJ_SPLIT__";

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

/**
 * `zellij action query-tab-names` prints one tab name per line, in tab order.
 * Zellij exposes no index in that output, so position is the index — which is
 * also the only thing `go-to-tab` accepts.
 */
function parseZellijTabNames(stdout) {
  const tabs = [];
  for (const rawLine of stripAnsi(stdout).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (ZELLIJ_DIAGNOSTIC_LINE.test(line)) continue;
    tabs.push({ index: tabs.length + 1, name: line });
  }
  return tabs;
}

/**
 * `zellij action list-clients` prints a padded three-column table. The command
 * column is the remainder of the row, because it can itself contain spaces.
 */
function parseZellijClients(stdout) {
  const clients = [];
  for (const rawLine of stripAnsi(stdout).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (ZELLIJ_CLIENTS_HEADER.test(line)) continue;
    if (ZELLIJ_DIAGNOSTIC_LINE.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    clients.push({
      clientId: parts[0],
      paneId: parts[1],
      command: parts.slice(2).join(" ").trim(),
    });
  }
  return clients;
}

function isNoZellijSessionsMessage(text, code) {
  if (code !== 0 && code !== 1) return false;
  return ZELLIJ_NO_SESSIONS.test(String(text || ""));
}

/**
 * Zellij reports command failures on stdout and still exits 0 — verified on
 * 0.43.1 for "Session already exists", an empty session name, renaming or
 * adding a tab to a session that is not running, and running an action with no
 * `--session`. Reading only the exit status made every one of those look like a
 * success: the create modal closed on a session that was never created, and
 * renaming a dead session reported success.
 */
const ZELLIJ_FAILURE_MESSAGE = new RegExp(
  [
    "session already exists",
    "session by this name already exists",
    "session name cannot be empty",
    "cannot use this name",
    "please specify the session name",
    "exists and is active, use --force",
  ].join("|"),
  "i",
);

/**
 * Failures that mean the target is gone, so retrying other spellings is
 * pointless. Zellij spells this three different ways depending on which
 * subcommand answered: `kill-session` uses double quotes, `delete-session`
 * prefixes with `Session:`, and `action` uses single quotes.
 */
const ZELLIJ_MISSING_TARGET_MESSAGE = new RegExp(
  [
    "no session named",
    "^session:\\s*\"[^\"]*\"\\s*not found",
    "^session\\s+'[^']*'\\s+not found",
  ].join("|"),
  "im",
);

function findZellijFailureMessage(text) {
  const value = String(text || "");
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (ZELLIJ_FAILURE_MESSAGE.test(line) || ZELLIJ_MISSING_TARGET_MESSAGE.test(line)) {
      // Zellij appends "The following sessions are active:" and then prints the
      // list on the lines below. Only this line reaches the panel, so keeping
      // the clause would leave a colon dangling in front of nothing.
      return line.replace(/\s*The following sessions are active:\s*$/i, "").trim() || line;
    }
  }
  return null;
}

function isZellijMissingTargetMessage(text) {
  return ZELLIJ_MISSING_TARGET_MESSAGE.test(String(text || ""));
}

/**
 * Picks the first candidate with content and trims it. Zellij's messages arrive
 * with a trailing newline, which reaches the panel's inline error verbatim.
 */
function firstZellijError(...candidates) {
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }
  return "";
}

function buildZellijCommand(args) {
  return `zellij ${String(args || "").trim()}`.trim();
}

/**
 * `zellij action ...` needs the session as a *global* flag before the
 * subcommand; `zellij action rename-session -s name` is not accepted.
 */
function buildZellijSessionActionCommand(sessionName, args) {
  return buildZellijCommand(`--session ${shQuote(sessionName)} action ${String(args || "").trim()}`);
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
      return {
        success: false,
        error: firstZellijError(result.error, result.stderr, stdout) || "Failed to list zellij sessions",
      };
    }
    return {
      success: true,
      zellijVersion: zellijVersion || undefined,
      sessions,
    };
  }

  /**
   * Tabs and attached clients for one session. Both come from `zellij action`,
   * which only reaches *running* sessions — against an exited one it prints
   * `Session '<name>' not found.` and changes nothing, so this is safe to call
   * speculatively, but callers should skip exited sessions anyway.
   */
  async function listSessionDetails(event, payload) {
    const sessionId = payload?.sessionId;
    const name = sanitizeNewSessionName(payload?.sessionName);
    if (!sessionId || !name) return { success: false, error: "Missing sessionId or sessionName" };

    const command = [
      `${buildZellijSessionActionCommand(name, "query-tab-names")} 2>&1`,
      `echo ${ZELLIJ_DETAILS_SPLIT}`,
      `${buildZellijSessionActionCommand(name, "list-clients")} 2>&1`,
    ].join("; ");
    const result = await run(event, sessionId, command, 8000);
    if (result.pending) return { success: false, pending: true };

    const stdout = result.stdout || "";
    const splitAt = stdout.indexOf(ZELLIJ_DETAILS_SPLIT);
    const tabsText = splitAt >= 0 ? stdout.slice(0, splitAt) : stdout;
    const clientsText = splitAt >= 0 ? stdout.slice(splitAt + ZELLIJ_DETAILS_SPLIT.length) : "";

    // Exit status is unusable here: `action` exits 0 on some missing-session
    // paths and 1 on others, so the message is the only reliable signal.
    const failure = findZellijFailureMessage(tabsText);
    if (failure) return { success: false, error: failure };
    if (!result.success && !stdout.trim()) {
      return {
        success: false,
        error: firstZellijError(result.error, result.stderr) || "Failed to load zellij session details",
      };
    }

    return {
      success: true,
      tabs: parseZellijTabNames(tabsText),
      clients: parseZellijClients(clientsText),
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
      return {
        success: false,
        error: firstZellijError(result.error, result.stderr, result.stdout) || "Failed to create zellij session",
      };
    }
    // Exit 0 is not enough — see findZellijFailureMessage.
    const failure = findZellijFailureMessage(result.stdout);
    if (failure) return { success: false, error: failure };
    return { success: true, name };
  }

  /**
   * Every zellij action funnels through here so that the exit-0-on-failure
   * behaviour is handled in exactly one place.
   */
  async function runAction(event, sessionId, attempts) {
    let lastError = "";
    for (const args of attempts) {
      const result = await run(event, sessionId, buildZellijCommand(args), 8000);
      if (result.pending) return { success: false, pending: true };
      const failure = result.success ? findZellijFailureMessage(result.stdout) : null;
      if (result.success && !failure) return { success: true };
      lastError = firstZellijError(failure, result.error, result.stderr, result.stdout, lastError);
      // The session does not exist; the remaining spellings cannot find it either.
      if (isZellijMissingTargetMessage(lastError)) break;
    }
    return { success: false, error: lastError || "zellij command failed" };
  }

  async function zellijAction(event, payload) {
    const { sessionId, action, sessionName } = payload || {};
    if (!sessionId) return { success: false, error: "Missing sessionId" };
    const name = sanitizeNewSessionName(sessionName);
    if (!name) return { success: false, error: "Missing sessionName" };

    if (action === "killSession") {
      // Stops the session but leaves it resurrectable — the counterpart of
      // deleteSession, which discards it for good.
      return runAction(event, sessionId, [`kill-session ${shQuote(name)}`]);
    }

    if (action === "deleteSession") {
      // Both spellings mean the same force delete; only the flag syntax differs
      // between zellij builds. A bare `delete-session` is deliberately not a
      // fallback: it refuses to touch a running session, and `kill-session` is
      // not one either, since that would silently downgrade a permanent delete
      // into a resurrectable kill.
      return runAction(event, sessionId, [
        `delete-session --force ${shQuote(name)}`,
        `delete-session -f ${shQuote(name)}`,
      ]);
    }

    if (action === "renameSession") {
      const newName = sanitizeNewSessionName(payload?.newName);
      if (!newName) return { success: false, error: "Missing newName" };
      // Zellij accepts an empty rename and silently does nothing; a same-name
      // rename is likewise pointless. Treat both as a no-op instead of
      // reporting a success the user cannot see.
      if (newName === name) return { success: true };
      return runAction(event, sessionId, [
        `--session ${shQuote(name)} action rename-session ${shQuote(newName)}`,
      ]);
    }

    if (action === "createTab") {
      const tabName = sanitizeNewSessionName(payload?.tabName);
      const args = tabName
        ? `new-tab --name ${shQuote(tabName)}`
        : "new-tab";
      return runAction(event, sessionId, [
        `--session ${shQuote(name)} action ${args}`,
      ]);
    }

    // Deliberately absent: `go-to-tab` / `rename-tab` / `close-tab`. They act on
    // whichever tab is focused rather than a named one, and `go-to-tab` was
    // observed to hang indefinitely on 0.43.1 when no client is attached, which
    // would pin an exec channel open for the life of the connection.
    return { success: false, error: "Unsupported zellij action" };
  }

  return { listSessions, listSessionDetails, createSession, zellijAction };
}

module.exports = {
  createZellijOpsApi,
  parseZellijSessions,
  parseZellijTabNames,
  parseZellijClients,
  parseZellijVersionString,
  sanitizeNewSessionName,
  isNoZellijSessionsMessage,
  findZellijFailureMessage,
  isZellijMissingTargetMessage,
  buildZellijCommand,
  buildZellijSessionActionCommand,
};
