import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAIScopeHostIdsByTargetId } from './aiScopeHostIds';
import type { WorkspaceNode } from './models';

test('maps live terminals to their saved host and workspaces to member hosts', () => {
  const root: WorkspaceNode = {
    id: 'split',
    type: 'split',
    direction: 'horizontal',
    children: [
      { id: 'p1', type: 'pane', sessionId: 's-a' },
      { id: 'p2', type: 'pane', sessionId: 's-b' },
      { id: 'p3', type: 'pane', sessionId: 's-a2' },
    ],
  } as WorkspaceNode;
  const map = buildAIScopeHostIdsByTargetId(
    [
      { id: 's-a', hostId: 'host-a' },
      { id: 's-b', hostId: 'host-b' },
      { id: 's-a2', hostId: 'host-a' },
      { id: 's-none' },
    ],
    [{ id: 'ws-1', root }],
  );
  assert.deepEqual(map.get('s-a'), ['host-a']);
  assert.deepEqual(map.get('s-b'), ['host-b']);
  assert.equal(map.has('s-none'), false);
  assert.deepEqual(map.get('ws-1'), ['host-a', 'host-b']);
});
