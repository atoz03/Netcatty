export type WindowCommandCloseIntent =
  | { kind: 'closeTab' }
  | { kind: 'closeLogView'; tabId: string }
  | { kind: 'closeWindow' };

interface ResolveWindowCommandCloseIntentInput {
  activeTabId: string | null;
  editorTabIds: string[];
  sessionIds: string[];
  workspaceIds: string[];
  logViewIds: string[];
}

export function resolveWindowCommandCloseIntent({
  activeTabId,
  editorTabIds,
  sessionIds,
  workspaceIds,
  logViewIds,
}: ResolveWindowCommandCloseIntentInput): WindowCommandCloseIntent {
  if (!activeTabId) {
    return { kind: 'closeWindow' };
  }

  if (editorTabIds.includes(activeTabId)) {
    return { kind: 'closeTab' };
  }

  if (sessionIds.includes(activeTabId) || workspaceIds.includes(activeTabId)) {
    return { kind: 'closeTab' };
  }

  if (logViewIds.includes(activeTabId)) {
    return { kind: 'closeLogView', tabId: activeTabId };
  }

  if (activeTabId === 'vault' || activeTabId === 'sftp') {
    return { kind: 'closeWindow' };
  }

  return { kind: 'closeWindow' };
}
