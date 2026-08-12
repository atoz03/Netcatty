import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { repairToolMessageIntegrity } from './toolMessageIntegrity';

test('repairToolMessageIntegrity drops orphan and duplicate tool results', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'terminal_poll', input: {} }],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call-1', toolName: 'terminal_poll', output: { type: 'text', value: 'first' } },
        { type: 'tool-result', toolCallId: 'orphan', toolName: 'terminal_poll', output: { type: 'text', value: 'orphan' } },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'terminal_poll', output: { type: 'text', value: 'duplicate' } }],
    },
  ];

  const result = repairToolMessageIntegrity(messages);
  const serialized = JSON.stringify(result.messages);
  assert.equal(result.didAdjust, true);
  assert.match(serialized, /first/);
  assert.doesNotMatch(serialized, /orphan|duplicate/);
});

test('repairToolMessageIntegrity completes interrupted tool calls with a synthetic result', () => {
  const messages: ModelMessage[] = [{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'terminal_execute', input: { command: 'deploy' } }],
  }];

  const result = repairToolMessageIntegrity(messages);
  assert.equal(result.messages.length, 2);
  assert.match(JSON.stringify(result.messages[1]), /interrupted before a result was recorded/);
});

test('repairToolMessageIntegrity pairs reused tool call ids by occurrence order', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'reused', toolName: 'terminal_poll', input: { jobId: 'first' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'reused', toolName: 'terminal_poll', output: { type: 'text', value: 'first result' } }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'reused', toolName: 'terminal_poll', input: { jobId: 'second' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'reused', toolName: 'terminal_poll', output: { type: 'text', value: 'second result' } }],
    },
  ];

  const result = repairToolMessageIntegrity(messages);
  assert.equal(result.didAdjust, false);
  assert.equal(result.messages, messages);
  assert.match(JSON.stringify(result.messages), /first result/);
  assert.match(JSON.stringify(result.messages), /second result/);
});

test('repairToolMessageIntegrity pairs a reused id with the nearest preceding call', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'reused', toolName: 'terminal_execute', input: { command: 'old' } }],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'reused', toolName: 'terminal_execute', input: { command: 'new' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'reused', toolName: 'terminal_execute', output: { type: 'text', value: 'new result' } }],
    },
  ];

  const result = repairToolMessageIntegrity(messages);
  assert.equal(result.didAdjust, true);
  assert.deepEqual(result.messages.map(message => message.role), ['assistant', 'tool', 'assistant', 'tool']);
  assert.match(JSON.stringify(result.messages[1]), /interrupted before a result was recorded/);
  assert.match(JSON.stringify(result.messages[3]), /new result/);
});
