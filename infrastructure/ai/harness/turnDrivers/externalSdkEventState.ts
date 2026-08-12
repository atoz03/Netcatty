import type { AgentActivity, AgentUsage } from '../../types';

export function upsertAgentActivity(
  activities: AgentActivity[] | undefined,
  nextActivity: AgentActivity,
): AgentActivity[] {
  const current = activities ?? [];
  const existingIndex = current.findIndex((activity) => activity.id === nextActivity.id);
  if (existingIndex < 0) return [...current, nextActivity];
  return current.map((activity, index) => index === existingIndex ? nextActivity : activity);
}

export function resolveEstimatedUsageFallback(
  prompt: string,
  actualUsageReported: boolean,
): AgentUsage | null {
  if (actualUsageReported) return null;
  const estimatedTokens = Math.ceil(prompt.length / 4);
  return {
    inputTokens: estimatedTokens,
    outputTokens: 0,
    totalTokens: estimatedTokens,
    estimated: true,
  };
}
