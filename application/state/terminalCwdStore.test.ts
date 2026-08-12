import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalCwdStore } from './terminalCwdStore.ts';

test('terminalCwdStore bumps version only when cwd changes', () => {
  const versions: number[] = [];
  const unsubscribe = terminalCwdStore.subscribe(() => {
    versions.push(terminalCwdStore.getVersion());
  });

  const baseVersion = terminalCwdStore.getVersion();
  assert.equal(terminalCwdStore.setCwd('s1', '/tmp'), true);
  assert.equal(terminalCwdStore.getCwd('s1'), '/tmp');
  assert.equal(terminalCwdStore.getVersion(), baseVersion + 1);

  assert.equal(terminalCwdStore.setCwd('s1', '/tmp'), false);
  assert.equal(terminalCwdStore.getVersion(), baseVersion + 1);

  assert.equal(terminalCwdStore.setCwd('s1', '/var'), true);
  assert.equal(terminalCwdStore.getCwd('s1'), '/var');

  terminalCwdStore.prune(new Set());
  assert.equal(terminalCwdStore.getCwd('s1'), null);

  unsubscribe();
  assert.ok(versions.length >= 2);
});
