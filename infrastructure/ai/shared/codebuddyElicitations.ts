export type CodebuddyElicitationAction = 'accept' | 'decline' | 'cancel';

export interface CodebuddyElicitationRequest {
  sessionId?: string;
  toolCallId?: string;
  mode?: string;
  message?: string;
  requestedSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface CodebuddyElicitation {
  elicitationId: string;
  chatSessionId: string;
  request: CodebuddyElicitationRequest;
  requestInstanceId?: number;
}

type ElicitationListener = (elicitation: CodebuddyElicitation) => void;
type ClearedListener = (elicitationIds: string[]) => void;

const pendingElicitations = new Map<string, CodebuddyElicitation>();
const listeners = new Set<ElicitationListener>();
const clearedListeners = new Set<ClearedListener>();
let nextRequestInstanceId = 0;

function notifyCleared(elicitationIds: string[]): void {
  if (elicitationIds.length === 0) return;
  for (const listener of clearedListeners) {
    try { listener(elicitationIds); } catch { /* ignore listener failures */ }
  }
}

export function registerCodebuddyElicitation(elicitation: CodebuddyElicitation): void {
  if (!elicitation.elicitationId) return;
  const registeredElicitation = {
    ...elicitation,
    requestInstanceId: ++nextRequestInstanceId,
  };
  pendingElicitations.set(elicitation.elicitationId, registeredElicitation);
  for (const listener of listeners) {
    try { listener(registeredElicitation); } catch { /* ignore listener failures */ }
  }
}

export function completeCodebuddyElicitation(notification: Record<string, unknown>): void {
  const elicitationId = String(notification.elicitationId || '');
  if (!elicitationId || !pendingElicitations.delete(elicitationId)) return;
  notifyCleared([elicitationId]);
}

export function clearCodebuddyElicitationsForChat(chatSessionId: string): void {
  const cleared: string[] = [];
  for (const [elicitationId, elicitation] of pendingElicitations) {
    if (elicitation.chatSessionId !== chatSessionId) continue;
    pendingElicitations.delete(elicitationId);
    cleared.push(elicitationId);
  }
  notifyCleared(cleared);
}

export function onCodebuddyElicitation(listener: ElicitationListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function onCodebuddyElicitationCleared(listener: ClearedListener): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

export function replayPendingCodebuddyElicitations(listener: ElicitationListener): void {
  for (const elicitation of pendingElicitations.values()) {
    try { listener(elicitation); } catch { /* ignore listener failures */ }
  }
}

export async function respondCodebuddyElicitation(
  elicitationId: string,
  action: CodebuddyElicitationAction,
  content?: Record<string, unknown>,
): Promise<void> {
  const bridge = (window as unknown as {
    netcatty?: {
      aiSdkAgentElicitationResponse?: (
        id: string,
        responseAction: CodebuddyElicitationAction,
        responseContent?: Record<string, unknown>,
      ) => Promise<{ ok: boolean; error?: string }>;
    };
  }).netcatty;
  if (!bridge?.aiSdkAgentElicitationResponse) {
    throw new Error('CodeBuddy elicitation bridge is unavailable');
  }
  const result = await bridge.aiSdkAgentElicitationResponse(elicitationId, action, content);
  if (!result?.ok) {
    throw new Error(result?.error || 'Failed to answer CodeBuddy elicitation');
  }
  if (pendingElicitations.delete(elicitationId)) {
    notifyCleared([elicitationId]);
  }
}
