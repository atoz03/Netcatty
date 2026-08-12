import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSidePanelLiveSnapshot,
  getSidePanelLiveSnapshotForTab,
  sidePanelLiveStore,
  SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
} from './sidePanelLiveStore.ts';
import type { Host } from '../../types.ts';

test('sidePanelLiveStore skips notify when snapshot is unchanged', () => {
  let notifications = 0;
  const unsubscribe = sidePanelLiveStore.subscribe(() => {
    notifications += 1;
  });

  const snapshot = {
    ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    activeTerminalCwd: '/tmp',
  };
  sidePanelLiveStore.update(snapshot);
  sidePanelLiveStore.update({ ...snapshot });
  unsubscribe();

  assert.equal(notifications, 1);
});

test('getSidePanelLiveSnapshot returns inactive snapshot when disabled', () => {
  sidePanelLiveStore.update({
    ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    activeTerminalCwd: '/var/log',
  });

  assert.equal(getSidePanelLiveSnapshot(false), SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT);
  assert.equal(getSidePanelLiveSnapshot(true).activeTerminalCwd, '/var/log');
});

test('getSidePanelLiveSnapshotForTab withholds another tab live values', () => {
  const tabOneHost = { id: 'host-1', label: 'one' } as Host;
  sidePanelLiveStore.update({
    ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    tabId: 'tab-1',
    sftpActiveHost: tabOneHost,
    activeTerminalSessionIdForSftp: 'session-1',
  });

  // tab-2 became active but the store still describes tab-1: it must not see
  // tab-1's host or session, or its SFTP panel would rebind onto them.
  assert.equal(
    getSidePanelLiveSnapshotForTab(true, 'tab-2'),
    SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
  );

  const owned = getSidePanelLiveSnapshotForTab(true, 'tab-1');
  assert.equal(owned.sftpActiveHost, tabOneHost);
  assert.equal(owned.activeTerminalSessionIdForSftp, 'session-1');
});

test('getSidePanelLiveSnapshotForTab returns a stable reference for repeat reads', () => {
  sidePanelLiveStore.update({
    ...SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
    tabId: 'tab-1',
    activeTerminalCwd: '/srv',
  });

  // useSyncExternalStore loops forever on a getSnapshot that allocates.
  assert.equal(
    getSidePanelLiveSnapshotForTab(true, 'tab-1'),
    getSidePanelLiveSnapshotForTab(true, 'tab-1'),
  );
  assert.equal(
    getSidePanelLiveSnapshotForTab(true, 'tab-9'),
    getSidePanelLiveSnapshotForTab(true, 'tab-9'),
  );
  assert.equal(
    getSidePanelLiveSnapshotForTab(false, 'tab-1'),
    SIDE_PANEL_INACTIVE_LIVE_SNAPSHOT,
  );
});
