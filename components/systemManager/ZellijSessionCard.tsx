import { MonitorPlay, Trash2 } from 'lucide-react';
import React, { memo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { useSystemManagerBackend } from '../../application/state/useSystemManagerBackend';
import { requestManagedTerminalOpen } from '../../application/app/managedTerminalOpenEvent';
import { buildZellijAttachCommand } from '../../domain/systemManager/tmuxShell';
import type { ZellijManageAction, ZellijSessionInfo } from '../../domain/systemManager/types';
import type { TerminalSession } from '../../types';
import {
  SystemPanelInlineError,
  SystemPanelRoundButton,
  SystemPanelRow,
  SystemPanelStatusBadge,
} from './SystemPanelUi';
import { showSystemManagerError } from './systemManagerToast';

type Backend = ReturnType<typeof useSystemManagerBackend>;

interface ZellijSessionCardProps {
  session: ZellijSessionInfo;
  sessionId: string;
  parentSession: TerminalSession;
  backend: Backend;
  onSessionsChanged: () => Promise<void>;
  onOpenManagedTerminal?: (
    sessionId: string,
    title: string,
    startupCommand: string,
    options?: { mode?: 'tab' | 'verticalSplit' },
  ) => boolean | void;
}

export const ZellijSessionCard = memo(function ZellijSessionCard({
  session,
  sessionId,
  parentSession,
  backend,
  onSessionsChanged,
  onOpenManagedTerminal,
}: ZellijSessionCardProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (action: ZellijManageAction) => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await backend.zellijAction({ sessionId, ...action });
      if (!result.success) throw new Error(result.error || t('systemManager.errors.actionFailed'));
      await onSessionsChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('systemManager.errors.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleAttach = () => {
    const title = `zellij: ${session.name}`;
    const startupCommand = buildZellijAttachCommand(session.name);
    const opened = onOpenManagedTerminal
      ? onOpenManagedTerminal(parentSession.id, title, startupCommand, { mode: 'tab' })
      : requestManagedTerminalOpen({
        sessionId: parentSession.id,
        title,
        startupCommand,
        options: { mode: 'tab' },
      });
    if (opened === false) {
      const message = t('systemManager.errors.openManagedTerminalUnavailable');
      setActionError(message);
      showSystemManagerError(message, t('common.error'));
    }
  };

  return (
    <>
      <SystemPanelRow
        title={session.name}
        subtitle={t('systemManager.zellij.session')}
        trailing={(
          <div className="flex shrink-0 items-center gap-1">
            {session.current && (
              <SystemPanelStatusBadge tone="success">
                {t('systemManager.zellij.current')}
              </SystemPanelStatusBadge>
            )}
            {session.exited && (
              <SystemPanelStatusBadge tone="muted">
                {t('systemManager.zellij.exited')}
              </SystemPanelStatusBadge>
            )}
            <SystemPanelRoundButton title={t('systemManager.zellij.attach')} onClick={handleAttach}>
              <MonitorPlay size={12} />
            </SystemPanelRoundButton>
            <SystemPanelRoundButton
              title={t('systemManager.zellij.killSession')}
              destructive
              disabled={busy}
              loading={busy}
              onClick={() => {
                if (globalThis.confirm(t('systemManager.zellij.confirmKillSession', { name: session.name }))) {
                  void runAction({ action: 'killSession', sessionName: session.name });
                }
              }}
            >
              <Trash2 size={12} />
            </SystemPanelRoundButton>
          </div>
        )}
      />
      {actionError && <SystemPanelInlineError message={actionError} />}
    </>
  );
});
