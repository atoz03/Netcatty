export const MAX_SFTP_SIDE_PANEL_REMEMBERED_PATHS = 32;

export function pruneSftpSidePanelTabConnectionKeys(
  connectionKeys: Map<string, string>,
  activeTabIds: Iterable<string>,
): void {
  const activeIds = new Set(activeTabIds);
  for (const tabId of connectionKeys.keys()) {
    if (!activeIds.has(tabId)) {
      connectionKeys.delete(tabId);
    }
  }
}

export function rememberSftpSidePanelPath(
  paths: Map<string, string>,
  connectionKey: string,
  remotePath: string,
  limit = MAX_SFTP_SIDE_PANEL_REMEMBERED_PATHS,
): void {
  paths.delete(connectionKey);
  paths.set(connectionKey, remotePath);
  while (paths.size > limit) {
    const oldestKey = paths.keys().next().value;
    if (oldestKey === undefined) break;
    paths.delete(oldestKey);
  }
}

export function recallSftpSidePanelPath(
  paths: Map<string, string>,
  connectionKey: string,
): string | undefined {
  const remotePath = paths.get(connectionKey);
  if (remotePath === undefined) return undefined;
  paths.delete(connectionKey);
  paths.set(connectionKey, remotePath);
  return remotePath;
}
