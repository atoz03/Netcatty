import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPromptContextSnapshot } from './promptContextSnapshot';

test('buildPromptContextSnapshot records inspectable prompt inputs without credentials', () => {
  const snapshot = buildPromptContextSnapshot({
    providerId: 'openai',
    modelId: 'gpt-test',
    permissionMode: 'confirm',
    scopeType: 'terminal',
    scopeLabel: 'production',
    toolNames: ['terminal_execute', 'terminal_poll'],
    selectedSkillSlugs: ['diagnosing-bugs'],
    systemPrompt: 'secret-free rendered prompt',
    webSearchEnabled: false,
    hostSessionIds: ['session-1'],
    builtAt: 123,
  });

  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.toolNames, ['terminal_execute', 'terminal_poll']);
  assert.equal(snapshot.systemPromptChars, 27);
  assert.match(snapshot.systemPromptHash, /^fnv1a-/);
  assert.deepEqual(snapshot.injections.map(item => item.source), [
    'system-prompt', 'capability-catalog', 'user-skills', 'terminal-scope', 'web-search',
  ]);
  assert.equal(JSON.stringify(snapshot).includes('secret-free rendered prompt'), false);
});
