import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStepHandleNoticeMessage,
  mapCattyStreamChunkToAgentEvents,
  mapSdkStreamEventToAgentEvents,
} from './agentEventAdapter';

describe('agentEventAdapter', () => {
  it('maps tool-output-denied chunks to approval_resolved denied and tool_result', () => {
    const events = mapCattyStreamChunkToAgentEvents(
      {
        type: 'tool-output-denied',
        toolCallId: 'call-1',
        toolName: 'sftp_write_file',
      },
      { sessionId: 'chat-1', turnId: 'turn-1' },
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'approval_resolved');
    assert.equal((events[0] as { outcome?: string }).outcome, 'denied');
    assert.equal(events[1]?.type, 'tool_result');
    assert.equal((events[1] as { isError?: boolean }).isError, true);
  });

  it('maps tool-error chunks to tool_result with isError', () => {
    const events = mapCattyStreamChunkToAgentEvents(
      {
        type: 'tool-error',
        toolCallId: 'call-2',
        toolName: 'terminal_execute',
        error: new Error('timeout'),
      },
      { sessionId: 'chat-1', turnId: 'turn-1' },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'tool_result');
    assert.equal((events[0] as { isError?: boolean }).isError, true);
    assert.match(String((events[0] as { result?: string }).result), /timeout/);
  });

  it('maps denied tool-approval-response with nested toolCall to tool_result', () => {
    const events = mapCattyStreamChunkToAgentEvents(
      {
        type: 'tool-approval-response',
        approvalId: 'approval-1',
        approved: false,
        reason: 'Observer mode blocks write operations.',
        toolCall: {
          toolCallId: 'call-3',
          toolName: 'sftp_write_file',
          input: { path: '/tmp/x' },
        },
      },
      { sessionId: 'chat-1', turnId: 'turn-1' },
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'approval_resolved');
    assert.equal((events[0] as { outcome?: string }).outcome, 'denied');
    assert.equal(events[1]?.type, 'tool_result');
    assert.match(String((events[1] as { result?: string }).result), /Observer mode/);
  });

  it('detects step handle notice messages for prepareStep dedup', () => {
    assert.equal(
      isStepHandleNoticeMessage('[step 2] Tool output handles available: tool-output-abc'),
      true,
    );
    assert.equal(isStepHandleNoticeMessage('regular user message'), false);
  });

  it('maps SDK activity events into the unified trace protocol', () => {
    const context = { sessionId: 'chat-1', turnId: 'turn-1' };
    const fileChange = mapSdkStreamEventToAgentEvents({
      type: 'file-change',
      itemId: 'patch-1',
      status: 'completed',
      changes: [{ path: 'src/app.ts', kind: 'update' }],
    }, context);
    const webSearch = mapSdkStreamEventToAgentEvents({
      type: 'web-search', itemId: 'search-1', query: 'Codex events', status: 'running',
    }, context);
    const plan = mapSdkStreamEventToAgentEvents({
      type: 'plan-update', itemId: 'plan-1', status: 'completed',
      items: [{ text: 'Map events', completed: true }],
    }, context);
    const warning = mapSdkStreamEventToAgentEvents({
      type: 'warning', itemId: 'warning-1', message: 'recoverable',
    }, context);

    assert.equal(fileChange[0]?.type, 'file_change');
    assert.equal(webSearch[0]?.type, 'web_search');
    assert.equal(plan[0]?.type, 'plan_update');
    assert.equal(warning[0]?.type, 'error');
    assert.equal((warning[0] as { recoverable?: boolean }).recoverable, true);
  });

  it('maps actual SDK usage including cached and reasoning tokens', () => {
    const events = mapSdkStreamEventToAgentEvents({
      type: 'usage',
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 10,
      totalTokens: 125,
    }, { sessionId: 'chat-1', turnId: 'turn-1' });
    assert.deepEqual(events[0] && {
      type: events[0].type,
      promptTokens: 'promptTokens' in events[0] ? events[0].promptTokens : undefined,
      cachedPromptTokens: 'cachedPromptTokens' in events[0] ? events[0].cachedPromptTokens : undefined,
      completionTokens: 'completionTokens' in events[0] ? events[0].completionTokens : undefined,
      reasoningTokens: 'reasoningTokens' in events[0] ? events[0].reasoningTokens : undefined,
      totalTokens: 'totalTokens' in events[0] ? events[0].totalTokens : undefined,
      estimated: 'estimated' in events[0] ? events[0].estimated : undefined,
    }, {
      type: 'usage',
      promptTokens: 100,
      cachedPromptTokens: 40,
      completionTokens: 25,
      reasoningTokens: 10,
      totalTokens: 125,
      estimated: false,
    });
  });
});
