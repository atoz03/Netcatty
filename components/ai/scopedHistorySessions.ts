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
): HistoryCacheKey {
  const hostKey = scopeHostIds ? [...scopeHostIds].sort().join(',') : '';
  const terminalKey = scopeType === 'terminal'
    ? [...activeTerminalSessionIds].sort().join(',')
    : '';
  const memberKey = scopeType === 'workspace' && workspaceMemberTerminalIds
    ? [...workspaceMemberTerminalIds].sort().join(',')
    : '';
  return `${scopeType}:${scopeTargetId ?? ''}:${hostKey}:${terminalKey}:${memberKey}`;
}

export function getScopedHistorySessions(
  sessions: AISession[],
  scopeType: 'terminal' | 'workspace',
  scopeTargetId: string | undefined,
  scopeHostIds: string[] | undefined,
  activeTerminalSessionIds: Set<string>,
  workspaceMemberTerminalIds?: Set<string>,
): AISession[] {
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
