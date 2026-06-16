import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./TerminalLayerTabBridge.tsx', import.meta.url), 'utf8');

test('terminal layer bridge does not dock the shared host tree', () => {
  assert.doesNotMatch(source, /hostTreeDockedInLayer/);
});

test('terminal layer is visible only for terminal sessions or workspaces', () => {
  assert.match(source, /const isVisible = Boolean\(activeSession \|\| activeWorkspace \|\| s\.draggingSessionId\)/);
});

test('managed terminal opener is included in memoized view deps', () => {
  assert.match(source, /onOpenManagedTerminal: s\.onOpenManagedTerminal/);
  const depsIndex = source.indexOf('  }), [');
  assert.notEqual(depsIndex, -1);
  assert.notEqual(source.indexOf('s.onOpenManagedTerminal', depsIndex), -1);
});
