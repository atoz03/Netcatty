import type { AISession } from '../../infrastructure/ai/types';
import { getSessionScopeMatchRank } from './sessionScopeMatch';

type HistoryCacheKey = string;
const MAX_HISTORY_CACHE_ENTRIES_PER_SESSION_LIST = 64;
const historyCache = new WeakMap<AISession[], Map<HistoryCacheKey, AISession[]>>();

function buildHistoryCacheKey(
  scopeType: 'terminal' | 'workspace',
  scopeTargetId: string | undefined,
  scopeHostIds: string[] | undefined,
  activeTerminalSessionIds: Set<string>,
  workspaceMemberTerminalIds: Set<string> | undefined,
  workspaceMemberActiveSessionIds: Set<string>,
): HistoryCacheKey {
  const hostKey = scopeHostIds ? [...scopeHostIds].sort().join(',') : '';
  const terminalKey = scopeType === 'terminal'
    ? [...activeTerminalSessionIds].sort().join(',')
    : '';
  const memberKey = scopeType === 'workspace' && workspaceMemberTerminalIds
    ? [...workspaceMemberTerminalIds].sort().join(',')
    : '';
  const memberActiveKey = [...workspaceMemberActiveSessionIds].sort().join(',');
  return `${scopeType}:${scopeTargetId ?? ''}:${hostKey}:${terminalKey}:${memberKey}:${memberActiveKey}`;
}

export function getScopedHistorySessions(
  sessions: AISession[],
  scopeType: 'terminal' | 'workspace',
  scopeTargetId: string | undefined,
  scopeHostIds: string[] | undefined,
  activeTerminalSessionIds: Set<string>,
  workspaceMemberTerminalIds?: Set<string>,
  activeSessionIdMap?: Readonly<Record<string, string | null | undefined>>,
): AISession[] {
  // A member can be continuing history created on an older terminal. Its
  // selected chat belongs in workspace history even though scope.targetId
  // still identifies that older terminal. Do not include nonmember selections.
  const workspaceMemberActiveSessionIds = new Set<string>();
  if (scopeType === 'workspace' && workspaceMemberTerminalIds && activeSessionIdMap) {
    for (const terminalId of workspaceMemberTerminalIds) {
      const sessionId = activeSessionIdMap[`terminal:${terminalId}`];
      if (sessionId) workspaceMemberActiveSessionIds.add(sessionId);
    }
  }
  let scopeCache = historyCache.get(sessions);
  if (!scopeCache) {
    scopeCache = new Map();
    historyCache.set(sessions, scopeCache);
  }

  const cacheKey = buildHistoryCacheKey(
    scopeType,
    scopeTargetId,
    scopeHostIds,
    activeTerminalSessionIds,
    workspaceMemberTerminalIds,
    workspaceMemberActiveSessionIds,
  );
  const cached = scopeCache.get(cacheKey);
  if (cached) {
    scopeCache.delete(cacheKey);
    scopeCache.set(cacheKey, cached);
    return cached;
  }

  const result = sessions
    .map((session) => ({
      session,
      matchRank: getSessionScopeMatchRank(
        session,
        scopeType,
        scopeTargetId,
        scopeHostIds,
        activeTerminalSessionIds,
        workspaceMemberTerminalIds,
        workspaceMemberActiveSessionIds,
      ),
    }))
    .filter(({ matchRank }) => matchRank > 0)
    .sort((a, b) => b.matchRank - a.matchRank || b.session.updatedAt - a.session.updatedAt)
    .map(({ session }) => session);

  scopeCache.set(cacheKey, result);
  while (scopeCache.size > MAX_HISTORY_CACHE_ENTRIES_PER_SESSION_LIST) {
    const oldestKey = scopeCache.keys().next().value;
    if (oldestKey == null) break;
    scopeCache.delete(oldestKey);
  }
  return result;
}

export function _getScopedHistoryCacheSizeForTests(sessions: AISession[]): number {
  return historyCache.get(sessions)?.size ?? 0;
}

/**
 * Pick the session a panel shows without an explicit selection.
 *
 * Rank >= 3 (exact scope, workspace member terminals, chats inherited from a
 * merged scope) always qualifies. Rank 2 — a chat belonging to a *different*
 * scope on the same saved host — also qualifies, but only when that scope is
 * gone (`liveScopeTargetIds`): that is what makes a reconnect, a new tab for
 * the same host, or an app restart bring that host's conversation back, which
 * is the whole point of binding history to the saved host id instead of the
 * terminal/workspace id.
 *
 * A chat another live panel is currently displaying is skipped, so two panels
 * never show the same conversation at once. A chat whose owning tab is still
 * open but showing something else is fair game — the per-host conversation
 * follows the host, not the tab. `liveScopeTargetIds` keeps stale pointers of
 * closed tabs from counting as "displayed".
 */
export function getPreferredAutoResumeSessionId(
  historySessions: readonly AISession[],
  scopeType: 'terminal' | 'workspace',
  scopeTargetId: string | undefined,
  scopeHostIds: string[] | undefined,
  activeTerminalSessionIds: Set<string>,
  workspaceMemberTerminalIds?: Set<string>,
  activeSessionIdMap?: Readonly<Record<string, string | null | undefined>>,
  options?: { liveScopeTargetIds?: ReadonlySet<string> },
): string | null {
  const workspaceMemberActiveSessionIds = new Set<string>();
  if (scopeType === 'workspace' && workspaceMemberTerminalIds && activeSessionIdMap) {
    for (const terminalId of workspaceMemberTerminalIds) {
      const sessionId = activeSessionIdMap[`terminal:${terminalId}`];
      if (sessionId) workspaceMemberActiveSessionIds.add(sessionId);
    }
  }
  const liveScopeTargetIds = options?.liveScopeTargetIds;
  const pointers = activeSessionIdMap ?? {};
  // Chats another live scope is showing right now. Stale pointers of closed
  // terminals/workspaces stay in the map on purpose (they keep the chat
  // recoverable via /chats), so a pointer only counts while its target lives.
  const displayedElsewhere = new Set<string>();
  for (const [key, value] of Object.entries(pointers)) {
    if (!value) continue;
    const separator = key.indexOf(':');
    const targetId = separator >= 0 ? key.slice(separator + 1) : '';
    if (!targetId || targetId === scopeTargetId) continue;
    if (liveScopeTargetIds && !liveScopeTargetIds.has(targetId)) continue;
    displayedElsewhere.add(value);
  }
  for (const session of historySessions) {
    const rank = getSessionScopeMatchRank(
      session,
      scopeType,
      scopeTargetId,
      scopeHostIds,
      activeTerminalSessionIds,
      workspaceMemberTerminalIds,
      workspaceMemberActiveSessionIds,
    );
    if (rank >= 3) {
      return session.id;
    }
    // Rank 2 is a chat from another scope on the same saved host: follow the
    // host, unless another live panel is already showing that conversation.
    if (rank === 2 && !displayedElsewhere.has(session.id)) {
      return session.id;
    }
  }
  return null;
}
