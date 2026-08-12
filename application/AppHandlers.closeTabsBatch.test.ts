import assert from 'node:assert/strict';
import test from 'node:test';

import { closeTabsBatchImpl } from './app/AppHandlers.ts';

test('batch tab close removes standalone sessions in one state update', async () => {
  const closedSessionBatches: string[][] = [];
  const probedSessionBatches: string[][] = [];
  const closeTabsInFlightRef = { current: false };
  const sessions = [
    { id: 's1', protocol: 'ssh' },
    { id: 's2', protocol: 'ssh' },
    { id: 's3', protocol: 'ssh' },
  ];

  const result = await closeTabsBatchImpl(
    () => ({
      closeLogView: () => {},
      closeSessions: (sessionIds: string[]) => closedSessionBatches.push(sessionIds),
      closeTabsInFlightRef,
      closeWorkspace: () => {},
      confirmIfBusyLocalTerminal: async (sessionIds: string[]) => {
        probedSessionBatches.push(sessionIds);
        return true;
      },
      logViews: [],
      sessions,
      workspaces: [],
    }),
    ['s1', 's2', 's3'],
  );

  assert.deepEqual(probedSessionBatches, [['s1', 's2', 's3']]);
  assert.deepEqual(closedSessionBatches, [['s1', 's2', 's3']]);
  assert.equal(closeTabsInFlightRef.current, false);
  assert.equal(result, true);
});

test('batch tab close reports cancellation before mutating any tab', async () => {
  let mutated = false;
  const result = await closeTabsBatchImpl(
    () => ({
      closeLogView: () => { mutated = true; },
      closeSessions: () => { mutated = true; },
      closeTabsInFlightRef: { current: false },
      closeWorkspace: () => { mutated = true; },
      confirmIfBusyLocalTerminal: async () => false,
      logViews: [],
      sessions: [{ id: 's1', protocol: 'local' }],
      workspaces: [],
    }),
    ['s1'],
  );

  assert.equal(result, false);
  assert.equal(mutated, false);
});
