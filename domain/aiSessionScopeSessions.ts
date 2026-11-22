import type { AISessionScopeMode } from "../infrastructure/ai/types";

type SessionLike = { sessionId?: string };

/**
 * Terminal sessions an AI turn may address with terminal/SFTP tools.
 *
 * The AI panel pushes this list to the main process as the chat's tool scope,
 * so the choice here decides what `get_environment` returns and what
 * `terminal_execute` / SFTP tools accept.
 *
 * - `current`: the chat's own scope (that terminal, or that workspace's member
 *   terminals). Least privilege, and what history binding is based on.
 * - `all-open`: every live terminal in the app, merged after the scoped ones so
 *   one chat can drive tabs the user opened in other workspaces. Scoped entries
 *   win on duplicate `sessionId` (they carry the scope's fresher metadata), and
 *   an empty app-wide list falls back to the scoped list — widening must never
 *   clear the scope and lock the agent out of its own tab.
 */
export function resolveAgentScopeSessions<T extends SessionLike>(input: {
  mode: AISessionScopeMode;
  scopedSessions: T[];
  allOpenSessions?: T[];
}): T[] {
  const { mode, scopedSessions, allOpenSessions } = input;
  if (mode !== "all-open") return scopedSessions;
  if (!allOpenSessions || allOpenSessions.length === 0) return scopedSessions;

  const seen = new Set<string>();
  const merged: T[] = [];
  for (const session of scopedSessions) {
    if (session.sessionId) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
    }
    merged.push(session);
  }
  for (const session of allOpenSessions) {
    if (session.sessionId) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
    }
    merged.push(session);
  }
  return merged;
}
