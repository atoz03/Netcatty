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

export function isPendingSameEndpointSshSession(
  session: {
    hostId?: string | null;
    status?: string;
    hostname?: string | null;
    port?: number | null;
    username?: string | null;
    protocol?: string | null;
    moshEnabled?: boolean;
    etEnabled?: boolean;
  },
  host: {
    id: string;
    hostname: string;
    port?: number | null;
    username: string;
  },
): boolean {
  return Boolean(
    session.hostId === host.id
    && session.status === "connecting"
    && session.hostname === host.hostname
    && (session.port ?? 22) === (host.port ?? 22)
    && session.username === host.username
    && (session.protocol === "ssh" || session.protocol === undefined)
    && !session.moshEnabled
    && !session.etEnabled,
  );
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

/**
 * True when the SFTP side panel must rebind onto a fresh SSH transport.
 * Covers focus switches (session id change) and same-tab reconnect /
 * Start over, where the id is stable but the underlying channel was replaced.
 */
export function shouldRebindSftpSidePanelSourceSession(params: {
  previousSessionId: string | null | undefined;
  nextSessionId: string | null | undefined;
  previousStatus?: string | null;
  nextStatus?: string | null;
}): boolean {
  if (shouldResetSftpSidePanelSourceSession(params.previousSessionId, params.nextSessionId)) {
    return true;
  }
  if (!params.nextSessionId) return false;
  if (params.previousSessionId !== params.nextSessionId) return false;
  if (params.nextStatus !== "connected") return false;
  if (params.previousStatus == null) return false;
  return params.previousStatus !== "connected";
}

/**
 * While the linked terminal is actively connecting, wait for its transport so
 * SFTP can reuse it. A terminal left disconnected must not block standalone
 * SFTP fallback.
 */
export function shouldDeferSftpSidePanelAutoConnectForSession(params: {
  activeSessionId?: string | null;
  sessionStatus?: string | null;
}): boolean {
  if (!params.activeSessionId) return false;
  return params.sessionStatus === "connecting";
}

/**
 * While the last linked SSH session is not the active reusable source,
 * remember its non-connected status so a background reconnect still rebinds
 * when that session becomes active again.
 */
export function resolveSftpSidePanelTrackedSourceStatusUpdate(params: {
  trackedSessionId?: string | null;
  sessionStatus?: string | null;
}): { sessionId: string; status: string } | null {
  if (!params.trackedSessionId) return null;
  if (!params.sessionStatus || params.sessionStatus === "connected") return null;
  return {
    sessionId: params.trackedSessionId,
    status: params.sessionStatus,
  };
}

/** Keep the tracked source status when focus temporarily has no reusable SSH. */
export function rememberSftpSidePanelSourceStatus(params: {
  previousStatus?: string | null;
  activeSessionId?: string | null;
  activeSessionStatus?: string | null;
}): string | null {
  if (params.activeSessionId && params.activeSessionStatus) {
    return params.activeSessionStatus;
  }
  return params.previousStatus ?? null;
}
