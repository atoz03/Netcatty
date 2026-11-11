import type { AISession, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { formatRelativeTime } from '../AIChatSessionHistoryDrawer';

/**
 * Pure builder for the `/chats` panel note. Kept separate from the component
 * so a future rebind action (issue #4015 R2) can attach per-entry actions
 * without reworking the text rendering.
 */

export interface AiChatsListingInput {
  /** Rank-sorted sessions visible to the current panel scope. */
  sessions: AISession[];
  activeSessionId: string | null;
  externalAgents: ExternalAgentConfig[];
  /** Live workspaces, used to resolve workspace scope titles. */
  workspaces: Array<{ id: string; title: string }>;
  /** Live terminal session ids visible to this panel. */
  liveTerminalIds: Iterable<string>;
  /** Fallback scope label for the panel's own scope (e.g. current workspace title). */
  currentScopeLabel?: string;
  scopeTargetId?: string;
  t: (key: string) => string;
}

export interface AiChatsListingEntry {
  sessionId: string;
  title: string;
  agentLabel: string;
  scopeLabel: string;
  /** Scope target no longer resolves to a live workspace/terminal. */
  isDangling: boolean;
  /** 1-based number among dangling entries, used by `/rebind <n>`. */
  rebindNumber?: number;
  isCurrent: boolean;
  relativeTime: string;
}

const TITLE_TRUNCATE = 42;

export function truncateChatTitle(title: string): string {
  const trimmed = title.trim() || '';
  if (trimmed.length <= TITLE_TRUNCATE) return trimmed;
  return `${trimmed.slice(0, TITLE_TRUNCATE - 1)}…`;
}

export function resolveChatAgentLabel(
  agentId: string,
  externalAgents: ExternalAgentConfig[],
): string {
  if (agentId === 'catty') return 'Catty Agent';
  return externalAgents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

export function buildAiChatsListingEntries(input: AiChatsListingInput): AiChatsListingEntry[] {
  const {
    sessions,
    activeSessionId,
    externalAgents,
    workspaces,
    liveTerminalIds,
    scopeTargetId,
    t,
  } = input;
  const workspaceTitles = new Map(workspaces.map((workspace) => [workspace.id, workspace.title]));
  const liveTerminals = new Set(liveTerminalIds);

  const entries: AiChatsListingEntry[] = sessions.map((session) => {
    const isCurrent = session.id === activeSessionId;
    let scopeLabel = '';
    let isDangling = false;
    if (session.scope.type === 'workspace') {
      const title = workspaceTitles.get(session.scope.targetId ?? '');
      if (title != null) {
        scopeLabel = `${t('ai.chat.chatsScopeWorkspace')}: ${title}`;
      } else {
        // The panel's own scope may be labelled by the parent even when the
        // workspace store has not been threaded through; treat the active
        // scope target as live.
        if (isCurrent && session.scope.targetId === scopeTargetId && input.currentScopeLabel) {
          scopeLabel = `${t('ai.chat.chatsScopeWorkspace')}: ${input.currentScopeLabel}`;
        } else {
          isDangling = true;
          scopeLabel = t('ai.chat.chatsScopeDangling');
        }
      }
    } else if (session.scope.type === 'terminal') {
      if (liveTerminals.has(session.scope.targetId ?? '')) {
        scopeLabel = t('ai.chat.chatsScopeTerminal');
      } else {
        isDangling = true;
        scopeLabel = t('ai.chat.chatsScopeDangling');
      }
    } else {
      scopeLabel = t('ai.chat.chatsScopeGlobal');
    }

    return {
      sessionId: session.id,
      title: truncateChatTitle(session.title || t('ai.chat.untitled')),
      agentLabel: resolveChatAgentLabel(session.agentId, externalAgents),
      scopeLabel,
      isDangling,
      isCurrent,
      relativeTime: formatRelativeTime(new Date(session.updatedAt), t),
    };
  });

  // Number the dangling entries so the note can advertise `/rebind <n>`.
  let danglingCounter = 0;
  for (const entry of entries) {
    if (!entry.isDangling) continue;
    danglingCounter += 1;
    entry.rebindNumber = danglingCounter;
  }

  return entries;
}

/**
 * Resolve a `/rebind <n>` argument against a `/chats` listing. Only dangling
 * entries are rebindable; a non-dangling target (or a bad index) yields null.
 */
export function resolveRebindTargetFromArg(
  arg: string,
  entries: AiChatsListingEntry[],
): AiChatsListingEntry | null {
  const trimmed = arg.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const index = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(index) || index < 1) return null;
  const dangling = entries.filter((entry) => entry.isDangling);
  return dangling[index - 1] ?? null;
}

/**
 * 不在当前作用域历史中的悬挂会话，是否可以由 `/chats` 列出供 `/rebind` 使用。
 * 已保存主机仍存在的会话属于该主机的历史，打开该主机即可看到，因此不在这里列出
 * （否则会泄露并把其他服务器的会话迁走）。没有主机身份的旧记录，或其主机已全部
 * 不存在（主机已删除、临时串口/快速连接）的会话会被列出，确保不会无处可寻。
 */
export function isChatListedForRecovery(
  session: AISession,
  knownHostIds: ReadonlySet<string>,
): boolean {
  const hostIds = session.scope.hostIds ?? [];
  if (hostIds.length === 0) return true;
  return !hostIds.some((hostId) => knownHostIds.has(hostId));
}

/** Revalidate a cached listing entry against the current session and live scopes. */
export function canRebindChat(session: AISession | undefined, liveScopeTargetIds: ReadonlySet<string>): boolean {
  if (!session) return false;
  return !!session.scopeDangling || !session.scope.targetId || !liveScopeTargetIds.has(session.scope.targetId);
}

export function formatAiChatsListingNote(
  entries: AiChatsListingEntry[],
  t: (key: string) => string,
): string {
  if (entries.length === 0) {
    return t('ai.chat.chatsEmpty');
  }
  let hasDangling = false;
  const lines = entries.map((entry) => {
    const marker = entry.isCurrent ? '•' : ' ';
    const rebindHint = entry.isDangling && entry.rebindNumber != null
      ? ` · /rebind ${entry.rebindNumber}`
      : '';
    if (entry.isDangling) hasDangling = true;
    return `${marker} ${entry.title} — ${entry.agentLabel} · ${entry.scopeLabel} · ${entry.relativeTime}${rebindHint}`;
  });
  if (hasDangling) {
    lines.push(t('ai.chat.chatsRebindHint'));
  }
  return [t('ai.chat.chatsHeader'), ...lines].join('\n');
}
