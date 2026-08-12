import type { ToolOutputStore, ToolOutputHandle } from './toolOutputStore';

export function storeCompactionArchive(
  store: ToolOutputStore,
  chatSessionId: string,
  formattedHistory: string,
): ToolOutputHandle {
  return store.store({
    chatSessionId,
    capabilityId: 'conversation.archive',
    content: formattedHistory,
  });
}

export function storeCompactionArtifact(
  store: ToolOutputStore,
  chatSessionId: string,
  input: {
    trigger: string;
    modelId?: string | null;
    archiveHandleId?: string;
    formattedHistory: string;
    summary: string;
  },
): ToolOutputHandle {
  return store.store({
    chatSessionId,
    capabilityId: 'compaction.artifact',
    content: [
      `trigger: ${input.trigger}`,
      `model: ${input.modelId ?? 'unknown'}`,
      `archiveHandleId: ${input.archiveHandleId ?? 'unavailable'}`,
      `\n[compaction input]\n${input.formattedHistory}`,
      `\n[compaction output]\n${input.summary}`,
    ].join('\n'),
  });
}
