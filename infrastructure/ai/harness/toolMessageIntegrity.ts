import type { ModelMessage } from 'ai';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function repairToolMessageIntegrity(messages: ModelMessage[]): {
  messages: ModelMessage[];
  didAdjust: boolean;
} {
  const pendingCalls = new Map<string, Array<Record<string, unknown>>>();
  const matchedCalls = new Set<Record<string, unknown>>();
  let didAdjust = false;
  const sanitized: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as unknown[]) {
        if (!isRecord(part) || part.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue;
        const pending = pendingCalls.get(part.toolCallId) ?? [];
        pending.push(part);
        pendingCalls.set(part.toolCallId, pending);
      }
      sanitized.push(message);
      continue;
    }
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      sanitized.push(message);
      continue;
    }
    const content = (message.content as unknown[]).filter(part => {
      if (!isRecord(part) || part.type !== 'tool-result' || typeof part.toolCallId !== 'string') {
        return true;
      }
      const pending = pendingCalls.get(part.toolCallId);
      // Reused provider IDs are paired with the nearest preceding unresolved
      // call. This also handles an older interrupted call followed by a new
      // call that reused the same ID.
      const matchingCall = pending?.pop();
      if (!matchingCall) {
        didAdjust = true;
        return false;
      }
      matchedCalls.add(matchingCall);
      return true;
    });
    if (content.length === 0) {
      didAdjust = true;
      continue;
    }
    sanitized.push(content.length === message.content.length ? message : {
      ...message,
      content,
    } as ModelMessage);
  }

  const repaired: ModelMessage[] = [];
  for (const message of sanitized) {
    repaired.push(message);
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const missing = (message.content as unknown[]).filter(part => (
      isRecord(part)
      && part.type === 'tool-call'
      && typeof part.toolCallId === 'string'
      && !matchedCalls.has(part)
    )) as Array<Record<string, unknown>>;
    if (missing.length === 0) continue;
    repaired.push({
      role: 'tool',
      content: missing.map(part => ({
        type: 'tool-result' as const,
        toolCallId: String(part.toolCallId),
        toolName: typeof part.toolName === 'string' ? part.toolName : 'unknown',
        output: {
          type: 'text' as const,
          value: '[Tool call interrupted before a result was recorded. Do not assume it succeeded or repeat a write automatically; verify current state first.]',
        },
        isError: true,
      })),
    });
    didAdjust = true;
  }

  return { messages: didAdjust ? repaired : messages, didAdjust };
}
