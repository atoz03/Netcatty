import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { TwoPassCompactionCache, fingerprintMessages } from './twoPassCompaction';

test('fingerprintMessages includes complete tool arguments canonically', () => {
  const a: ModelMessage[] = [{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: '1', toolName: 'terminal_execute', input: { b: 2, a: 1 } }],
  }];
  const reordered: ModelMessage[] = [{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: '1', toolName: 'terminal_execute', input: { a: 1, b: 2 } }],
  }];
  const changed: ModelMessage[] = [{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: '1', toolName: 'terminal_execute', input: { a: 9, b: 2 } }],
  }];

  assert.equal(fingerprintMessages(a), fingerprintMessages(reordered));
  assert.notEqual(fingerprintMessages(a), fingerprintMessages(changed));
});

test('TwoPassCompactionCache reuses only an unchanged model and prefix', async () => {
  const cache = new TwoPassCompactionCache();
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`,
  })) as ModelMessage[];
  cache.start('chat-1', 'model-a', messages, async () => 'NOTE1');

  const hit = await cache.consume('chat-1', 'model-a', messages);
  assert.equal(hit?.note, 'NOTE1');
  assert.ok((hit?.prefixLength ?? 0) < messages.length);
  assert.equal(await cache.consume('chat-1', 'model-b', messages), undefined);
});
