import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldSubmitPromptInput } from './prompt-input';

test('requires text by default', () => {
  assert.equal(shouldSubmitPromptInput(''), false);
  assert.equal(shouldSubmitPromptInput('   '), false);
  assert.equal(shouldSubmitPromptInput('continue'), true);
});

test('allows an empty textarea when attachment context is submittable', () => {
  assert.equal(shouldSubmitPromptInput('', true), true);
  assert.equal(shouldSubmitPromptInput('   ', true), true);
});
