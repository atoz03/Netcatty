import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';

export type SidePanelLiveSnapshot = {
  /**
   * Terminal tab this snapshot describes.
   *
   * One store serves every mounted side-panel slot, but the values inside are
   * only meaningful for the tab that was active when they were published. The
   * store is written from a layout effect, so during a tab switch a slot that
   * has already flipped to visible can read the previous tab's host/session for
   * one commit. Slots compare this id before trusting the rest.
   */
  tabId: string | null;
  sftpActiveHost: Host | null;
  activeTerminalSessionIdForSftp: string | null;
  activeTerminalCwd: string | null;
  activeWorkspace: Workspace | undefined;
  activeTerminalSessionForSystem: TerminalSession | null;
  activeSystemSessionHost: Host | null;
  focusedHost: Host | null;
  focusedSessionId: string | null;
  historySessionId: string | null;
  resolvedPreviewTheme: TerminalTheme | null;
  previewedOrVisibleThemeId: string | undefined;
  focusedFontFamilyId: string | undefined;
  focusedFontFamilyOverridden: boolean;
  focusedFontSize: number | undefined;
  focusedFontSizeOverridden: boolean;
  focusedFontWeight: number | undefined;
  focusedFontWeightOverridden: boolean;
  focusedThemeOverridden: boolean;
};

const EMPTY_SNAPSHOT: SidePanelLiveSnapshot = {
  tabId: null,
  sftpActiveHost: null,
  activeTerminalSessionIdForSftp: null,
  activeTerminalCwd: null,
  activeWorkspace: undefined,
  activeTerminalSessionForSystem: null,
  activeSystemSessionHost: null,
  focusedHost: null,
  focusedSessionId: null,
  historySessionId: null,
  resolvedPreviewTheme: null,
  previewedOrVisibleThemeId: undefined,
  focusedFontFamilyId: undefined,
  focusedFontFamilyOverridden: false,
  focusedFontSize: undefined,
  focusedFontSizeOverridden: false,
  focusedFontWeight: undefined,
  focusedFontWeightOverridden: false,
  focusedThemeOverridden: false,
};

export const SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT = EMPTY_SNAPSHOT;

type Listener = () => void;

function liveSnapshotEqual(a: SidePanelLiveSnapshot, b: SidePanelLiveSnapshot): boolean {
  return a.tabId === b.tabId
    && a.sftpActiveHost === b.sftpActiveHost
    && a.activeTerminalSessionIdForSftp === b.activeTerminalSessionIdForSftp
    && a.activeTerminalCwd === b.activeTerminalCwd
    && a.activeWorkspace === b.activeWorkspace
    && a.activeTerminalSessionForSystem === b.activeTerminalSessionForSystem
    && a.activeSystemSessionHost === b.activeSystemSessionHost
    && a.focusedHost === b.focusedHost
    && a.focusedSessionId === b.focusedSessionId
    && a.historySessionId === b.historySessionId
    && a.resolvedPreviewTheme === b.resolvedPreviewTheme
    && a.previewedOrVisibleThemeId === b.previewedOrVisibleThemeId
    && a.focusedFontFamilyId === b.focusedFontFamilyId
    && a.focusedFontFamilyOverridden === b.focusedFontFamilyOverridden
    && a.focusedFontSize === b.focusedFontSize
    && a.focusedFontSizeOverridden === b.focusedFontSizeOverridden
    && a.focusedFontWeight === b.focusedFontWeight
    && a.focusedFontWeightOverridden === b.focusedFontWeightOverridden
    && a.focusedThemeOverridden === b.focusedThemeOverridden;
}

class SidePanelLiveStore {
  private snapshot: SidePanelLiveSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<Listener>();

  getSnapshot = (): SidePanelLiveSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(next: SidePanelLiveSnapshot): void {
    if (liveSnapshotEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const sidePanelLiveStore = new SidePanelLiveStore();

const noopSubscribe = () => () => {};

export function subscribeSidePanelLiveSnapshot(enabled: boolean, listener: Listener): () => void {
  if (!enabled) return noopSubscribe();
  return sidePanelLiveStore.subscribe(listener);
}

export function getSidePanelLiveSnapshot(enabled: boolean): SidePanelLiveSnapshot {
  return enabled ? sidePanelLiveStore.getSnapshot() : SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT;
}

/**
 * Live values for one tab, or the inactive snapshot when they belong elsewhere.
 *
 * A slot that reads another tab's values — even for the single commit between
 * the active-tab change and the layout effect that republishes — hands its
 * panel a foreign host and terminal session id. For SFTP that reads as an
 * endpoint change and rebinds the browse connection.
 *
 * Both branches return a stable reference so this is safe as a
 * `useSyncExternalStore` getSnapshot.
 */
export function getSidePanelLiveSnapshotForTab(
  enabled: boolean,
  tabId: string | null,
): SidePanelLiveSnapshot {
  if (!enabled) return SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT;
  const snapshot = sidePanelLiveStore.getSnapshot();
  return snapshot.tabId === tabId ? snapshot : SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT;
}
