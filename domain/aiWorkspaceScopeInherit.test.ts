import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInheritedAIActiveSessionId } from './aiWorkspaceScopeInherit.ts';

test('workspace scope prefers its own active session over member terminals', () => {
  assert.equal(
    resolveInheritedAIActiveSessionId({
      scopeType: 'workspace',
      scopeTargetId: 'ws-1',
      activeSessionIdMap: {
        'workspace:ws-1': 'chat-ws',
        'terminal:term-a': 'chat-a',
      },
      memberTerminalIds: ['term-a', 'term-b'],
      preferredTerminalId: 'term-a',
    }),
    'chat-ws',
  );
});

test('workspace scope inherits focused terminal active session after merge', () => {
  assert.equal(
    resolveInheritedAIActiveSessionId({
      scopeType: 'workspace',
      scopeTargetId: 'ws-1',
      activeSessionIdMap: {
        'terminal:term-a': 'chat-a',
        'terminal:term-b': 'chat-b',
      },
      memberTerminalIds: ['term-a', 'term-b'],
      preferredTerminalId: 'term-a',
    }),
    'chat-a',
  );
});

test('workspace scope falls back to other member terminals when focused has none', () => {
  assert.equal(
    resolveInheritedAIActiveSessionId({
      scopeType: 'workspace',
      scopeTargetId: 'ws-1',
      activeSessionIdMap: {
        'terminal:term-b': 'chat-b',
      },
      memberTerminalIds: ['term-a', 'term-b'],
      preferredTerminalId: 'term-a',
    }),
    'chat-b',
  );
});

test('inheritance skips member sessions missing from visible history', () => {
  assert.equal(
    resolveInheritedAIActiveSessionId({
      scopeType: 'workspace',
      scopeTargetId: 'ws-1',
      activeSessionIdMap: {
        'terminal:term-a': 'chat-a',
        'terminal:term-b': 'chat-b',
      },
      memberTerminalIds: ['term-a', 'term-b'],
      preferredTerminalId: 'term-a',
      visibleSessionIds: new Set(['chat-b']),
    }),
    'chat-b',
  );
});

test('terminal scope does not inherit from siblings', () => {
  assert.equal(
    resolveInheritedAIActiveSessionId({
      scopeType: 'terminal',
      scopeTargetId: 'term-a',
      activeSessionIdMap: {
        'terminal:term-b': 'chat-b',
      },
      memberTerminalIds: ['term-a', 'term-b'],
      preferredTerminalId: 'term-a',
    }),
    null,
  );
});
