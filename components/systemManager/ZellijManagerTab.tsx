import { Plus, TerminalSquare } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { Snippet, TerminalSession } from '../../types';
import type { ZellijSessionInfo } from '../../domain/systemManager/types';
import { zellijSessionInfoEqual } from '../../domain/systemManager/pollEquals';
import {
  SystemPanelEmpty,
  SystemPanelError,
  SystemPanelIconButton,
  SystemPanelList,
  SystemPanelLoading,
  SystemPanelMetaBar,
  SystemPanelRefreshButton,
  SystemPanelSearch,
  SystemPanelShell,
  SystemPanelToolbar,
} from './SystemPanelUi';
import { usePolling, useStableTranslate } from './hooks/useSystemManager';
import { TmuxNewSessionModal } from './TmuxNewSessionModal';
import { ZellijSessionCard } from './ZellijSessionCard';
import { mergePollListByKey, useStableListOrder } from './listStable';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface ZellijManagerTabProps {
  sessionId: string;
  parentSession: TerminalSession;
  isVisible: boolean;
  warmupEnabled?: boolean;
  backend: Backend;
  refreshIntervalSec: number;
  snippets: Snippet[];
  onOpenManagedTerminal?: (
    sessionId: string,
    title: string,
    startupCommand: string,
    options?: { mode?: 'tab' | 'verticalSplit' },
  ) => boolean | void;
}

export const ZellijManagerTab = memo(function ZellijManagerTab({
  sessionId,
  parentSession,
  isVisible,
  warmupEnabled = false,
  backend,
  refreshIntervalSec,
  snippets,
  onOpenManagedTerminal,
}: ZellijManagerTabProps) {
  const { t } = useI18n();
  const stableT = useStableTranslate();
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [zellijVersion, setZellijVersion] = useState<string | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

  useEffect(() => {
    setZellijVersion(null);
  }, [sessionId]);

  const fetcher = useCallback(async () => {
    const fetchSessionId = sessionId;
    const result = await backend.listZellijSessions(sessionId);
    const version = result.zellijVersion ?? null;
    if (currentSessionIdRef.current === fetchSessionId) {
      setZellijVersion((prev) => (prev === version ? prev : version));
    }
    if (!result.success) {
      throw new Error(result.error || stableT('systemManager.errors.loadZellij'));
    }
    return result.sessions ?? [];
  }, [backend, sessionId, stableT]);

  const intervalMs = Math.max(2, refreshIntervalSec) * 1000;
  const { data: sessions, error, loading, refresh } = usePolling<ZellijSessionInfo[]>(
    fetcher,
    intervalMs,
    isVisible || warmupEnabled,
    (prev, next) => mergePollListByKey(prev, next, (s) => s.name, zellijSessionInfoEqual),
    { poll: isVisible, resetKey: sessionId },
  );

  const filtered = useMemo<ZellijSessionInfo[]>(() => {
    const q = query.trim().toLowerCase();
    const list = sessions ?? [];
    if (!q) return list;
    return list.filter((session) => session.name.toLowerCase().includes(q));
  }, [query, sessions]);

  const compareSessions = useCallback(
    (a: ZellijSessionInfo, b: ZellijSessionInfo) => a.name.localeCompare(b.name),
    [],
  );
  const displaySessions = useStableListOrder<ZellijSessionInfo, string>(
    filtered,
    (s) => s.name,
    query,
    compareSessions,
  );

  const handleCreate = useCallback(async (name: string) => {
    setCreating(true);
    setModalError(null);
    try {
      const result = await backend.createZellijSession({ sessionId, name });
      if (!result.success) throw new Error(result.error);
      setModalOpen(false);
      await refresh();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t('systemManager.errors.actionFailed'));
    } finally {
      setCreating(false);
    }
  }, [backend, refresh, sessionId, t]);

  return (
    <SystemPanelShell section="system-manager-zellij">
      <SystemPanelToolbar
        trailing={(
          <>
            <SystemPanelIconButton
              title={t('systemManager.zellij.new')}
              onClick={() => {
                setModalError(null);
                setModalOpen(true);
              }}
            >
              <Plus size={14} />
            </SystemPanelIconButton>
            <SystemPanelRefreshButton
              title={t('history.action.refresh')}
              loading={loading}
              onClick={() => void refresh()}
            />
          </>
        )}
      >
        <SystemPanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t('systemManager.zellij.search')}
        />
      </SystemPanelToolbar>

      <SystemPanelMetaBar trailing={zellijVersion ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{zellijVersion}</span>
      ) : undefined}>
        {t('systemManager.zellij.meta', { count: displaySessions.length })}
      </SystemPanelMetaBar>

      <SystemPanelList>
        {!error && displaySessions.length === 0 && loading && (
          <SystemPanelLoading message={t('systemManager.common.loading')} />
        )}
        {!error && displaySessions.length === 0 && !loading && (
          <SystemPanelEmpty icon={TerminalSquare} message={t('systemManager.zellij.empty')} />
        )}
        {error && (
          <SystemPanelError message={error} onRetry={() => void refresh()} retryLabel={t('history.action.retry')} loading={loading} />
        )}
        {displaySessions.map((session) => (
          <ZellijSessionCard
            key={session.name}
            session={session}
            sessionId={sessionId}
            parentSession={parentSession}
                backend={backend}
                onSessionsChanged={refresh}
                onOpenManagedTerminal={onOpenManagedTerminal}
              />
        ))}
      </SystemPanelList>

      <TmuxNewSessionModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreate={handleCreate}
        snippets={snippets}
        creating={creating}
        error={modalError}
        kind="zellij"
        commandEnabled={false}
      />
    </SystemPanelShell>
  );
});
