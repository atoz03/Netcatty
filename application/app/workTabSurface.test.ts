import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOrderedWorkTabIds,
  isHostTreeWorkTabSurface,
  isRootPageTabId,
  isTerminalContentTabSurface,
  reorderWorkTabIds,
  resolveWorkTabActiveHostId,
} from './workTabSurface';
import type { EditorTab } from '../state/editorTabStore';
import type { TerminalSession, Workspace } from '../../types';

test('work tab order keeps custom positions and appends new tabs', () => {
  assert.deepEqual(
    buildOrderedWorkTabIds(['log-1', 'session-1'], ['session-1', 'workspace-1', 'log-1', 'editor:file-1']),
    ['log-1', 'session-1', 'workspace-1', 'editor:file-1'],
  );
});

test('work tab order removes duplicate ids before rendering', () => {
  assert.deepEqual(
    buildOrderedWorkTabIds(
      ['session-2', 'session-1', 'session-2', 'session-1'],
      ['session-1', 'session-2', 'session-3', 'session-3'],
    ),
    ['session-2', 'session-1', 'session-3'],
  );
});

test('work tab order reorders with newly materialized tabs', () => {
  assert.deepEqual(
    reorderWorkTabIds(
      ['session-1', 'session-2', 'session-3'],
      ['session-1', 'session-2', 'session-3'],
      'session-1',
      'session-3',
      'after',
    ),
    ['session-2', 'session-3', 'session-1'],
  );
});

test('root pages are not work tab surfaces', () => {
  assert.equal(isRootPageTabId('vault'), true);
  assert.equal(isRootPageTabId('sftp'), true);
  assert.equal(isRootPageTabId('session-1'), false);
});

test('shared host tree is visible for editor, log, session, and workspace tabs', () => {
  const sessionIds = new Set(['session-1']);
  const workspaceIds = new Set(['workspace-1']);
  const logViewIds = new Set(['log-1']);
  const orderedTabs = ['session-1', 'workspace-1', 'editor:file-1', 'log-1'];

  for (const activeTabId of orderedTabs) {
    assert.equal(isHostTreeWorkTabSurface({
      enabled: true,
      activeTabId,
      logViewIds,
      orderedTabs,
      sessionIds,
      workspaceIds,
    }), true);
  }
});

test('shared host tree recognizes active log view before tab ordering catches up', () => {
  assert.equal(isHostTreeWorkTabSurface({
    enabled: true,
    activeTabId: 'log-1',
    logViewIds: new Set(['log-1']),
    orderedTabs: [],
    sessionIds: new Set(),
    workspaceIds: new Set(),
  }), true);
});

test('terminal content surface is limited to sessions and workspaces', () => {
  const sessionIds = new Set(['session-1']);
  const workspaceIds = new Set(['workspace-1']);

  assert.equal(isTerminalContentTabSurface({ activeTabId: 'session-1', sessionIds, workspaceIds }), true);
  assert.equal(isTerminalContentTabSurface({ activeTabId: 'workspace-1', sessionIds, workspaceIds }), true);
  assert.equal(isTerminalContentTabSurface({ activeTabId: 'editor:file-1', sessionIds, workspaceIds }), false);
  assert.equal(isTerminalContentTabSurface({ activeTabId: 'log-1', sessionIds, workspaceIds }), false);
});

test('shared host tree resolves active host ids across work tab types', () => {
  const sessions = [
    { id: 'session-1', hostId: 'host-1' },
    { id: 'session-2', hostId: 'host-2' },
  ] as TerminalSession[];
  const workspaces = [
    { id: 'workspace-1', focusedSessionId: 'session-2' },
  ] as Workspace[];
  const editorTabs = [
    { id: 'file-1', hostId: 'host-3' },
  ] as EditorTab[];

  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'session-1', sessions, workspaces, editorTabs }), 'host-1');
  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'workspace-1', sessions, workspaces, editorTabs }), 'host-2');
  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'editor:file-1', sessions, workspaces, editorTabs }), 'host-3');
  assert.equal(resolveWorkTabActiveHostId({ activeTabId: 'log-1', sessions, workspaces, editorTabs }), null);
});
