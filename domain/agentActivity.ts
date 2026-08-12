export type AgentActivityStatus = 'running' | 'completed' | 'failed';
export type AgentFileChangeKind = 'add' | 'delete' | 'update';

export type AgentActivity =
  | {
      id: string;
      type: 'file_change';
      status: Exclude<AgentActivityStatus, 'running'>;
      changes: Array<{ path: string; kind: AgentFileChangeKind }>;
    }
  | {
      id: string;
      type: 'web_search';
      status: Exclude<AgentActivityStatus, 'failed'>;
      query: string;
    }
  | {
      id: string;
      type: 'plan_update';
      status: Exclude<AgentActivityStatus, 'failed'>;
      items: Array<{ text: string; completed: boolean }>;
    }
  | {
      id: string;
      type: 'warning';
      status: 'completed';
      message: string;
    };

export interface AgentUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  estimated?: boolean;
}
