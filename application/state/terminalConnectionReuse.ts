import type { TerminalSession } from "../../domain/models";

/** SSH (non-mosh/et) sessions that can back SFTP once the transport is up. */
export function isTerminalSessionEligibleForSftpReuse(session: TerminalSession): boolean {
  return (
    (session.protocol === "ssh" || session.protocol === undefined)
    && !session.moshEnabled
    && !session.etEnabled
  );
}

export function canReuseTerminalConnection(session: TerminalSession): boolean {
  return isTerminalSessionEligibleForSftpReuse(session) && session.status === "connected";
}

type CloneSessionOptions = {
  id: string;
  localShellType?: TerminalSession["shellType"];
  workspaceId?: string;
  startupCommand?: string;
  customName?: string;
  inheritedCwd?: string;
};

function getClonedShellType(
  session: TerminalSession,
  localShellType?: TerminalSession["shellType"],
): TerminalSession["shellType"] {
  return session.protocol === "local" ? localShellType : session.shellType;
}

function createTerminalSessionClone(
  session: TerminalSession,
  options: CloneSessionOptions,
): TerminalSession {
  const isLocal = session.protocol === "local";
  // Only ssh/undefined (non-mosh/et) sessions inject an inherited `cd`; setting
  // pendingInitialCwd for telnet/serial/mosh/et would be dead, never-cleared
  // state (those protocols don't track cwd, so it's never consumed or cleared).
  const injectsInheritedCwd =
    (session.protocol === "ssh" || session.protocol === undefined)
    && !session.moshEnabled
    && !session.etEnabled;
  const clonedSession: TerminalSession = {
    id: options.id,
    hostId: session.hostId,
    hostLabel: session.hostLabel,
    hostname: session.hostname,
    username: session.username,
    status: "connecting",
    protocol: session.protocol,
    pluginConnection: session.pluginConnection == null
      ? undefined
      : structuredClone(session.pluginConnection),
    port: session.port,
    moshEnabled: session.moshEnabled,
    etEnabled: session.etEnabled,
    shellType: getClonedShellType(session, options.localShellType),
    charset: session.charset,
    localShell: session.localShell,
    localShellArgs: session.localShellArgs,
    localShellName: session.localShellName,
    localShellIcon: session.localShellIcon,
    localStartDir: isLocal && options.inheritedCwd ? options.inheritedCwd : session.localStartDir,
    fontSize: session.fontSize,
    fontSizeOverride: session.fontSizeOverride,
    startupCommand: options.startupCommand,
    customName: options.customName,
    ...(session.ephemeralHost ? { ephemeralHost: true } : {}),
    ...(injectsInheritedCwd && options.inheritedCwd ? { pendingInitialCwd: options.inheritedCwd } : {}),
    reuseConnectionFromSessionId: canReuseTerminalConnection(session) ? session.id : undefined,
  };

  if (options.workspaceId) {
    clonedSession.workspaceId = options.workspaceId;
  }

  return clonedSession;
}

export function createSplitTerminalSessionClone(
  session: TerminalSession,
  options: CloneSessionOptions,
): TerminalSession {
  return createTerminalSessionClone(session, options);
}

export function createCopiedTerminalSessionClone(
  session: TerminalSession,
  options: CloneSessionOptions,
): TerminalSession {
  return {
    ...createTerminalSessionClone(session, options),
    serialConfig: session.serialConfig,
  };
}
