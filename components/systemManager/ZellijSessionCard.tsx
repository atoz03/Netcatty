import {
  Columns2, MonitorPlay, Pencil, Plus, Power, RotateCcw, Trash2,
} from 'lucide-react';
import React, { memo, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import type { AsyncRecordState } from '../../application/state/systemManager/useAsyncRecordCache';
import { buildZellijAttachCommand } from '../../domain/systemManager/tmuxShell';
import type { ZellijManageAction, ZellijSessionInfo } from '../../domain/systemManager/types';
import type { TerminalSession } from '../../types';
import type { ZellijSessionDetails } from './ZellijManagerTab';
import {
  SystemPanelCollapsible,
  SystemPanelDetailStrip,
  SystemPanelInlineError,
  SystemPanelRow,
  SystemPanelSectionHeader,
} from './SystemPanelUi';
import {
  ZellijActionMenu,
  ZellijPrimaryAction,
  ZellijSessionTile,
  ZellijStateDot,
  ZellijTabChip,
  type ZellijMenuAction,
  type ZellijTileTone,
} from './ZellijPanelUi';
import { SystemPanelConfirmDialog } from './SystemPanelConfirmDialog';
import { SystemPanelPromptDialog } from './SystemPanelPromptDialog';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;
type OpenMode = 'tab' | 'verticalSplit';

interface ZellijSessionCardProps {
  session: ZellijSessionInfo;
  sessionId: string;
  parentSession: TerminalSession;
  backend: Backend;
  detailsRecord?: AsyncRecordState<ZellijSessionDetails>;
  onLoadDetails: (session: ZellijSessionInfo, options?: { force?: boolean; urgent?: boolean }) => Promise<void>;
  onRefreshDetails: (session: ZellijSessionInfo) => Promise<void>;
  onSessionsChanged: () => Promise<void>;
  onOpenManagedTerminal?: (
    sessionId: string,
    title: string,
    startupCommand: string,
    options?: { mode?: OpenMode },
  ) => boolean;
}

export const ZellijSessionCard = memo(function ZellijSessionCard({
  session,
  sessionId,
  parentSession,
  backend,
  detailsRecord,
  onLoadDetails,
  onRefreshDetails,
  onSessionsChanged,
  onOpenManagedTerminal,
}: ZellijSessionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ZellijManageAction['action'] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Zellij only reaches a *running* session: `zellij --session <name> action`
  // answers "Session '<name>' not found" for an exited one, so there is nothing
  // to expand and nothing to rename or add a tab to.
  const isExited = session.exited;
  const tabs = detailsRecord?.data?.tabs ?? [];
  const clients = detailsRecord?.data?.clients ?? [];
  const loadingDetails = detailsRecord?.loading ?? false;
  const detailsError = detailsRecord?.error ?? null;

  const lastExpandedStatusRef = useRef<string | null>(null);
  const statusKey = `${session.name}|${session.current}|${session.exited}`;

  useEffect(() => {
    if (!expanded) {
      lastExpandedStatusRef.current = null;
      return;
    }
    if (lastExpandedStatusRef.current === null) {
      lastExpandedStatusRef.current = statusKey;
      return;
    }
    if (lastExpandedStatusRef.current === statusKey) return;
    lastExpandedStatusRef.current = statusKey;
    void onRefreshDetails(session);
  }, [expanded, onRefreshDetails, session, statusKey]);

  useEffect(() => {
    if (isExited && expanded) setExpanded(false);
  }, [expanded, isExited]);

  const runAction = async (action: ZellijManageAction) => {
    setBusy(true);
    setPending(action.action);
    setActionError(null);
    try {
      const result = await backend.zellijAction({ sessionId, ...action });
      if (!result.success) throw new Error(result.error || t('systemManager.errors.actionFailed'));
      // A rename or a removal replaces this card entirely, so only a tab change
      // is worth re-reading the open detail panel for.
      if (action.action === 'createTab' && expanded) {
        await onRefreshDetails(session);
      }
      await onSessionsChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('systemManager.errors.actionFailed'));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const handleAttach = (mode: OpenMode) => {
    const title = `zellij: ${session.name}`;
    const startupCommand = buildZellijAttachCommand(session.name);
    // There is deliberately no fallback here. This panel only ever renders
    // inside the terminal layer, which supplies the handler; anything else is a
    // wiring bug, and a silent no-op is exactly what hid one before.
    const opened = onOpenManagedTerminal?.(parentSession.id, title, startupCommand, { mode }) ?? false;
    if (!opened) {
      const message = t('systemManager.errors.openManagedTerminalUnavailable');
      setActionError(message);
      showSystemManagerError(message, t('common.error'));
      return;
    }
    setActionError(null);
  };

  const tone: ZellijTileTone = isExited ? 'exited' : (session.current ? 'attached' : 'idle');
  const stateLabel = isExited
    ? t('systemManager.zellij.exited')
    : (session.current ? t('systemManager.zellij.current') : t('systemManager.zellij.running'));

  // Facts first: how many tabs and clients this session actually has, with the
  // state as the last segment. `session` alone is the fallback while the
  // details fetch is still in flight.
  const subtitle = (
    <span className="inline-flex items-center gap-1.5">
      {!isExited && detailsRecord?.data ? (
        <>
          <span>{t('systemManager.zellij.tabs', { count: tabs.length })}</span>
          {clients.length > 0 && (
            <>
              <span className="opacity-40">·</span>
              <span>{t('systemManager.zellij.clientCount', { count: clients.length })}</span>
            </>
          )}
        </>
      ) : (
        <span>{t('systemManager.zellij.session')}</span>
      )}
      <span className="opacity-40">·</span>
      <ZellijStateDot tone={tone} label={stateLabel} />
    </span>
  );

  const menuActions: ZellijMenuAction[] = [
    {
      id: 'attachSplit',
      label: t('systemManager.zellij.attachSplit'),
      icon: <Columns2 size={12} />,
      onSelect: () => handleAttach('verticalSplit'),
    },
    ...(isExited ? [] : [
      {
        id: 'newTab',
        label: t('systemManager.zellij.newTab'),
        icon: <Plus size={12} />,
        busy,
        onSelect: () => setNewTabOpen(true),
      },
      {
        id: 'rename',
        label: t('systemManager.zellij.rename'),
        icon: <Pencil size={12} />,
        busy,
        onSelect: () => setRenameOpen(true),
      },
      {
        id: 'killSession',
        label: t('systemManager.zellij.killSession'),
        icon: <Power size={12} />,
        busy: busy || pending === 'killSession',
        onSelect: () => setKillConfirmOpen(true),
      },
    ]),
    {
      id: 'deleteSession',
      label: t('systemManager.zellij.deleteSession'),
      icon: <Trash2 size={12} />,
      destructive: true,
      busy: busy || pending === 'deleteSession',
      onSelect: () => setDeleteConfirmOpen(true),
    },
  ];

  return (
    <>
      <SystemPanelRow
        selected={expanded}
        onClick={isExited ? undefined : () => {
          const nextExpanded = !expanded;
          setExpanded(nextExpanded);
          if (nextExpanded) {
            void onLoadDetails(session, { force: true, urgent: true });
          }
        }}
        leading={<ZellijSessionTile tone={tone} />}
        title={<span className="font-mono">{session.name}</span>}
        subtitle={subtitle}
        actions={(
          <div className="flex shrink-0 items-center gap-1">
            <ZellijPrimaryAction
              label={isExited ? t('systemManager.zellij.resurrect') : t('systemManager.zellij.attach')}
              icon={isExited ? <RotateCcw size={11} /> : <MonitorPlay size={11} />}
              onClick={() => handleAttach('tab')}
            />
            <ZellijActionMenu
              label={t('systemManager.zellij.moreActions')}
              actions={menuActions}
              busy={busy}
            />
          </div>
        )}
      />

      {actionError && <SystemPanelInlineError message={actionError} />}

      <SystemPanelCollapsible open={expanded}>
        {loadingDetails && tabs.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-muted-foreground border-b border-border/30">
            {t('systemManager.zellij.loadingDetails')}
          </div>
        )}

        {clients.length > 0 && (
          <SystemPanelDetailStrip>
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {t('systemManager.zellij.clients')}
            </div>
            <div className="flex flex-wrap gap-1">
              {clients.map((client) => (
                <span
                  key={client.clientId}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/50"
                >
                  <span className="font-medium tabular-nums text-foreground/70">#{client.clientId}</span>
                  {client.command && <span className="truncate font-mono">{client.command}</span>}
                </span>
              ))}
            </div>
          </SystemPanelDetailStrip>
        )}

        <SystemPanelSectionHeader
          trailing={(
            <button
              type="button"
              disabled={busy}
              onClick={() => setNewTabOpen(true)}
              className="shrink-0 h-5 px-1.5 rounded-full text-[10px] text-muted-foreground ring-1 ring-border/50 hover:text-foreground hover:bg-muted/60 inline-flex items-center gap-1 transition-colors disabled:opacity-40"
            >
              <Plus size={10} />
              {t('systemManager.zellij.newTab')}
            </button>
          )}
        >
          {t('systemManager.zellij.tabList')}{tabs.length > 0 ? ` · ${tabs.length}` : ''}
        </SystemPanelSectionHeader>

        {tabs.map((tab) => (
          <SystemPanelRow
            key={`${tab.index}:${tab.name}`}
            depth={1}
            leading={<ZellijTabChip index={tab.index} />}
            title={<span className="font-mono">{tab.name}</span>}
          />
        ))}

        {!loadingDetails && tabs.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-muted-foreground border-b border-border/30 break-all">
            {detailsError || t('systemManager.zellij.noTabs')}
          </div>
        )}
      </SystemPanelCollapsible>

      <SystemPanelConfirmDialog
        open={killConfirmOpen}
        title={t('systemManager.zellij.killSession')}
        message={t('systemManager.zellij.confirmKillSession', { name: session.name })}
        confirmLabel={t('systemManager.zellij.killSession')}
        destructive
        busy={busy}
        onOpenChange={setKillConfirmOpen}
        onConfirm={() => {
          setKillConfirmOpen(false);
          void runAction({ action: 'killSession', sessionName: session.name });
        }}
      />

      <SystemPanelConfirmDialog
        open={deleteConfirmOpen}
        title={t('systemManager.zellij.deleteSession')}
        message={t('systemManager.zellij.confirmDeleteSession', { name: session.name })}
        confirmLabel={t('systemManager.zellij.deleteSession')}
        destructive
        busy={busy}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          void runAction({ action: 'deleteSession', sessionName: session.name });
        }}
      />

      <SystemPanelPromptDialog
        open={renameOpen}
        title={t('systemManager.zellij.renameSessionPrompt')}
        fields={[{
          id: 'name',
          label: t('systemManager.zellij.newSessionName'),
          initialValue: session.name,
        }]}
        confirmLabel={t('common.rename')}
        busy={busy}
        onOpenChange={setRenameOpen}
        onSubmit={(values) => {
          setRenameOpen(false);
          if (values.name === session.name) return;
          void runAction({ action: 'renameSession', sessionName: session.name, newName: values.name });
        }}
      />

      <SystemPanelPromptDialog
        open={newTabOpen}
        title={t('systemManager.zellij.newTab')}
        fields={[{
          id: 'name',
          label: t('systemManager.zellij.tabName'),
          placeholder: t('systemManager.zellij.newTabPlaceholder'),
          required: false,
        }]}
        confirmLabel={t('common.create')}
        busy={busy}
        onOpenChange={setNewTabOpen}
        onSubmit={(values) => {
          setNewTabOpen(false);
          void runAction({
            action: 'createTab',
            sessionName: session.name,
            tabName: values.name || undefined,
          });
        }}
      />
    </>
  );
});
