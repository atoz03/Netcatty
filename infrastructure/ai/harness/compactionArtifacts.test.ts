import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { ToolOutputStore } from './toolOutputStore';
import { storeCompactionArchive, storeCompactionArtifact } from './compactionArtifacts';
import { buildCompactionFailureArchiveNotice, compactCattyMessages } from './cattyRuntime';

test('compaction artifacts retain exact searchable history and summary output', () => {
  const store = new ToolOutputStore();
  const archive = storeCompactionArchive(store, 'chat-1', 'exact E_CONN_RESET_7319 evidence');
  const artifact = storeCompactionArtifact(store, 'chat-1', {
    trigger: '413-retry',
    modelId: 'model-1',
    archiveHandleId: archive.id,
    formattedHistory: 'exact E_CONN_RESET_7319 evidence',
    summary: 'network failure found',
  });

  assert.match(store.read({ handleId: archive.id, mode: 'search', query: 'E_CONN_RESET_7319' }, 'chat-1') ?? '', /E_CONN_RESET_7319/);
  assert.match(store.read({ handleId: artifact.id, mode: 'full' }, 'chat-1') ?? '', /network failure found/);
});

test('compaction failure notice keeps the newly created archive discoverable', () => {
  assert.match(
    buildCompactionFailureArchiveNotice('tool-output-archive', false) ?? '',
    /tool-output-archive/,
  );
  assert.equal(buildCompactionFailureArchiveNotice(undefined, false), undefined);
});

test('compaction archive preserves tool evidence from before stale-result pruning', async () => {
  const evidence = 'UNIQUE_OLD_TOOL_EVIDENCE_7319';
  const messages: ModelMessage[] = [
    { role: 'user', content: 'inspect the old failure' },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'old-call',
        toolName: 'terminal_execute',
        input: { sessionId: 'session-1', command: 'inspect failure' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'old-call',
        toolName: 'terminal_execute',
        output: { type: 'text', value: evidence },
      }],
    },
    ...Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `later message ${index}`,
    } as ModelMessage)),
  ];
  const store = new ToolOutputStore();
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'summary' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
      warnings: [],
    }),
  });

  const result = await compactCattyMessages({
    messages,
    sessionId: 'chat-archive',
    chatSessionId: 'chat-archive',
    model,
    abortSignal: new AbortController().signal,
    force: true,
    trigger: 'force',
    toolOutputStore: store,
  });
  const handleId = result.trace?.archiveHandleId;
  assert.ok(handleId);
  assert.match(
    store.read({ handleId, mode: 'search', query: evidence }, 'chat-archive') ?? '',
    new RegExp(evidence),
  );
});
