import type { AISession } from "../../infrastructure/ai/types";

/**
 * 已存会话与面板作用域之间的主机身份匹配。
 *
 * 已保存主机是 AI 历史的稳定身份：终端和工作区 id 在每次重连、新开标签页或
 * 应用重启时都会变化，而 `host.id` 不变。只有能确认是同一组主机时，会话才会
 * 出现在其他作用域中：
 *
 * - 双方都有主机 id：有交集为 2，否则为 0；
 * - 双方都没有主机 id（无主机作用域上的旧数据）：为 1；
 * - 只有一方有主机 id：为 0，主机未知的会话不会泄露到具体服务器的历史中。
 *   这类会话仍可通过 `/chats` + `/rebind` 恢复（见 `isChatListedForRecovery`）。
 */
export function getHostIdentityMatchRank(
  sessionHostIds: readonly string[] | undefined,
  scopeHostIds: readonly string[] | undefined,
): number {
  const sessionHasHosts = !!sessionHostIds && sessionHostIds.length > 0;
  const scopeHasHosts = !!scopeHostIds && scopeHostIds.length > 0;
  if (sessionHasHosts && scopeHasHosts) {
    return sessionHostIds.some((hostId) => scopeHostIds.includes(hostId)) ? 2 : 0;
  }
  return !sessionHasHosts && !scopeHasHosts ? 1 : 0;
}

/**
 * 被*其他存活*终端作用域选中的会话。已关闭终端的活动指针会刻意保留在映射中
 * （issue #4015 R2），不能把它们算作“正在别处显示”，否则每个已关闭终端的
 * 最后一个会话都会从同一主机新打开的终端中消失。未提供存活集合时，所有指针
 * 都按存活处理（保守做法）。
 */
export function collectSessionIdsDisplayedByOtherTerminals(
  activeSessionIdMap: Readonly<Record<string, string | null | undefined>>,
  currentScopeKey: string,
  liveTargetIds?: ReadonlySet<string>,
): Set<string> {
  const sessionIds = new Set<string>();
  for (const [scopeKey, sessionId] of Object.entries(activeSessionIdMap)) {
    if (!sessionId || !scopeKey.startsWith("terminal:")) continue;
    if (scopeKey === currentScopeKey) continue;
    if (liveTargetIds && !liveTargetIds.has(scopeKey.slice("terminal:".length))) continue;
    sessionIds.add(sessionId);
  }
  return sessionIds;
}

export function getSessionScopeMatchRank(
  session: AISession,
  scopeType: "terminal" | "workspace",
  scopeTargetId?: string,
  scopeHostIds?: string[],
  /**
   * Session ids currently displayed by other terminal scopes. Tracked by
   * session id rather than `scope.targetId` so that a host-matched session
   * resumed from a different terminal is still recognised as in-use and
   * not offered (or cleaned) as if it were orphaned.
   */
  activeTerminalSessionIds?: Set<string>,
  /**
   * Terminal session ids currently living in this workspace. When terminals
   * merge, their AI chats stay `scope.type === "terminal"`; treating those
   * member chats as exact workspace matches keeps history/resume working.
   */
  workspaceMemberTerminalIds?: Set<string>,
  /** Chats currently selected by workspace members, including resumed history. */
  workspaceMemberActiveSessionIds?: Set<string>,
): number {
  // After a terminal merge the AI panel flips to workspace scope, but chats
  // created or resumed on member terminals remain terminal-scoped. Rank them as
  // exact matches so they stay visible and preferred over stale workspaces.
  if (
    scopeType === "workspace"
    && session.scope.type === "terminal"
    && (
      (session.scope.targetId && workspaceMemberTerminalIds?.has(session.scope.targetId))
      || workspaceMemberActiveSessionIds?.has(session.id)
    )
  ) {
    return 3;
  }

  if (session.scope.type !== scopeType) return 0;
  if (session.scope.targetId === scopeTargetId) return 3;

  if (scopeType === "terminal" && activeTerminalSessionIds?.has(session.id)) {
    return 0;
  }

  return getHostIdentityMatchRank(session.scope.hostIds, scopeHostIds);
}
