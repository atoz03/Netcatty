import type { SftpPane } from "../../application/state/sftp/types";

export type SftpSidePanelTabHealth = Pick<SftpPane, "connection" | "loading" | "reconnecting">;

/** Whether a remote SFTP tab is safe to reuse without reconnecting. */
export function isRemoteSftpTabHealthy(
  tab: SftpSidePanelTabHealth,
  hasBackendSession: boolean,
): boolean {
  const conn = tab.connection;
  if (!conn || conn.isLocal) return true;
  if (conn.status !== "connected") return false;
  if (tab.loading || tab.reconnecting) return false;
  if (!hasBackendSession) return false;
  return true;
}

/**
 * Skip auto-connect only when the active tab is already bound to this endpoint
 * and healthy. `activeTabConnectionKey` must match so a manually selected tab
 * for a different host cannot be kept just because `connectedKey` is stale.
 */
export function shouldSkipSftpSidePanelAutoConnect(
  connectionKey: string,
  connectedKey: string | null,
  activeTab: SftpSidePanelTabHealth | null | undefined,
  hasBackendSession: boolean,
  activeTabConnectionKey?: string | null,
): boolean {
  if (connectedKey !== connectionKey) return false;
  if (!activeTab) return false;
  if (activeTabConnectionKey !== connectionKey) return false;
  return isRemoteSftpTabHealthy(activeTab, hasBackendSession);
}

/** Whether a stored endpoint key still belongs to the live connection's host. */
export function connectionKeyMatchesHost(
  connectionKey: string | null | undefined,
  hostId: string,
): boolean {
  if (!connectionKey) return false;
  return connectionKey === hostId || connectionKey.startsWith(`${hostId}:`);
}

/**
 * Accept a terminal-drop pending upload only when the active pane is already
 * connected to the exact endpoint the drop requested. Matching hostId alone is
 * unsafe: session overrides can share hostId while hostname/port/user differ,
 * and auto-connect may still be deferred via rAF while the previous endpoint
 * looks connected.
 */
export function shouldAcceptPendingSftpUpload(params: {
  pendingHostId: string;
  pendingConnectionKey: string;
  activeHostId: string | null | undefined;
  connection: {
    hostId?: string | null;
    isLocal?: boolean;
    status?: string;
  } | null | undefined;
  paneConnectionKey: string | null | undefined;
}): boolean {
  const {
    pendingHostId,
    pendingConnectionKey,
    activeHostId,
    connection,
    paneConnectionKey,
  } = params;
  if (!activeHostId || pendingHostId !== activeHostId) return false;
  if (!connection || connection.isLocal || connection.hostId !== activeHostId) return false;
  if (connection.status !== "connected") return false;
  if (!paneConnectionKey || paneConnectionKey !== pendingConnectionKey) return false;
  return true;
}

export function findReusableSftpSidePanelTab(
  tabs: SftpPane[],
  hostId: string,
  connectionKey: string,
  tabConnectionKeyMap: ReadonlyMap<string, string>,
  hasBackendSession: (connectionId: string) => boolean,
  getConnectionKey?: (connectionId: string) => string | null,
): SftpPane | null {
  const candidate = tabs.find((tab) => {
    if (!tab.connection || tab.connection.hostId !== hostId) return false;
    if (tab.connection.status === "error" || tab.connection.status === "disconnected") return false;
    const liveKey = getConnectionKey?.(tab.connection.id) ?? null;
    const tabKey = liveKey ?? tabConnectionKeyMap.get(tab.id) ?? null;
    return tabKey === connectionKey;
  });
  if (!candidate?.connection) return null;
  if (!isRemoteSftpTabHealthy(candidate, hasBackendSession(candidate.connection.id))) {
    return null;
  }
  return candidate;
}

/** True when the linked terminal SSH session id changed. */
export function shouldResetSftpSidePanelSourceSession(
  previousSessionId: string | null | undefined,
  nextSessionId: string | null | undefined,
): boolean {
  if (!nextSessionId) return false;
  if (!previousSessionId) return false;
  return nextSessionId !== previousSessionId;
}
