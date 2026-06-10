import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeGlobalHistoryOnAppend,
  shouldRecordGlobalHistoryCommand,
  toGlobalHistoryDisplayEntries,
} from './globalHistory.ts';
import { NETCATTY_AI_HISTORY_MARKER } from './remoteHistory.ts';
import type { ShellHistoryEntry } from './models';

const baseEntry = (
  overrides: Partial<ShellHistoryEntry> & Pick<ShellHistoryEntry, 'command'>,
): ShellHistoryEntry => ({
  id: overrides.id ?? 'id-1',
  command: overrides.command,
  hostId: overrides.hostId ?? 'host-1',
  hostLabel: overrides.hostLabel ?? 'srv',
  sessionId: overrides.sessionId ?? 'sess-1',
  timestamp: overrides.timestamp ?? 1000,
});

test('shouldRecordGlobalHistoryCommand: rejects empty and AI marker commands', () => {
  assert.equal(shouldRecordGlobalHistoryCommand(''), false);
  assert.equal(shouldRecordGlobalHistoryCommand('   '), false);
  assert.equal(
    shouldRecordGlobalHistoryCommand(`echo ${NETCATTY_AI_HISTORY_MARKER}foo`),
    false,
  );
  assert.equal(shouldRecordGlobalHistoryCommand('ls -la'), true);
});

test('mergeGlobalHistoryOnAppend: trims and prepends a new command', () => {
  const next = mergeGlobalHistoryOnAppend([], {
    command: '  pwd  ',
    hostId: 'h1',
    hostLabel: 'Host',
    sessionId: 's1',
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].command, 'pwd');
});

test('mergeGlobalHistoryOnAppend: bumps timestamp for consecutive duplicate', () => {
  const prev = [baseEntry({ id: 'a', command: 'ls', timestamp: 1000 })];
  const next = mergeGlobalHistoryOnAppend(prev, {
    command: 'ls',
    hostId: 'h2',
    hostLabel: 'Other',
    sessionId: 's2',
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'a');
  assert.equal(next[0].hostLabel, 'Other');
  assert.ok(next[0].timestamp > 1000);
});

test('toGlobalHistoryDisplayEntries: maps host labels', () => {
  const out = toGlobalHistoryDisplayEntries([
    baseEntry({ command: 'htop', hostLabel: 'prod' }),
  ]);
  assert.deepEqual(out, [
    { id: 'id-1', command: 'htop', timestamp: 1000, hostLabel: 'prod' },
  ]);
});
