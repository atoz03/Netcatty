import { collectSessionIds } from './workspace';
import type { WorkspaceNode } from './models';

/**
 * 每个存活 AI 作用域目标（终端会话 id 或工作区 id）对应的已保存主机 id。
 * 与 AI 面板为新会话记录的 `scopeHostIds`（`useTerminalAiContexts`）保持一致：
 * 终端映射到自身主机，工作区映射到其成员终端的主机。
 */
export function buildAIScopeHostIdsByTargetId(
  sessions: ReadonlyArray<{ id: string; hostId?: string }>,
  workspaces: ReadonlyArray<{ id: string; root: WorkspaceNode }>,
): Map<string, string[]> {
  const hostIdBySessionId = new Map<string, string>();
  const result = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.hostId) continue;
    hostIdBySessionId.set(session.id, session.hostId);
    result.set(session.id, [session.hostId]);
  }
  for (const workspace of workspaces) {
    const hostIds = [...new Set(
      collectSessionIds(workspace.root)
        .map((sessionId) => hostIdBySessionId.get(sessionId))
        .filter((hostId): hostId is string => !!hostId),
    )];
    if (hostIds.length > 0) result.set(workspace.id, hostIds);
  }
  return result;
}
