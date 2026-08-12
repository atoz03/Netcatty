import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  FileDiff,
  Loader2,
  Search,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import type { AgentActivity, AgentUsage } from '../../domain/agentActivity';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

interface AgentActivityGroupProps {
  activities?: AgentActivity[];
  usage?: AgentUsage;
  isStreaming?: boolean;
  t: (key: string) => string;
}

function statusLabel(status: 'running' | 'completed' | 'failed', t: AgentActivityGroupProps['t']): string {
  return t(`ai.chat.activity.status.${status}`);
}

function formatTokens(value: number | undefined): string {
  return new Intl.NumberFormat().format(Math.max(0, value ?? 0));
}

const AgentActivityGroup: React.FC<AgentActivityGroupProps> = ({
  activities = [],
  usage,
  isStreaming = false,
  t,
}) => {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    setOpen(isStreaming);
  }, [isStreaming]);

  const visibleActivities = useMemo(
    () => activities.filter((activity) => activity.type !== 'web_search' || activity.query),
    [activities],
  );

  return (
    <div className="my-1.5 space-y-1.5 text-xs">
      {visibleActivities.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Activity size={13} />
            <span>{t('ai.chat.activity.title')}</span>
            <span className="ml-auto tabular-nums text-muted-foreground/70">{visibleActivities.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 space-y-1 rounded-md border border-border/30 bg-muted/10 p-2">
            {visibleActivities.map((activity) => {
              if (activity.type === 'plan_update') {
                return (
                  <div key={activity.id} className="space-y-1.5">
                    <div className="flex items-center gap-1.5 font-medium text-foreground/80">
                      {activity.status === 'running'
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Check size={12} />}
                      <span>{t('ai.chat.activity.plan')}</span>
                      <span className="font-normal text-muted-foreground">
                        · {statusLabel(activity.status, t)}
                      </span>
                    </div>
                    <div className="space-y-1 pl-0.5">
                      {activity.items.map((item, index) => (
                        <div key={`${activity.id}-${index}`} className="flex items-start gap-1.5 text-muted-foreground">
                          {item.completed
                            ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                            : <Circle size={12} className="mt-0.5 shrink-0" />}
                          <span className={item.completed ? 'line-through opacity-70' : ''}>{item.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              if (activity.type === 'web_search') {
                return (
                  <div key={activity.id} className="flex items-start gap-1.5 text-muted-foreground">
                    {activity.status === 'running'
                      ? <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />
                      : <Search size={12} className="mt-0.5 shrink-0" />}
                    <div className="min-w-0">
                      <span className="font-medium text-foreground/80">{t('ai.chat.activity.webSearch')}: </span>
                      <span className="break-words">{activity.query}</span>
                      <span className="ml-1 text-muted-foreground/70">
                        · {statusLabel(activity.status, t)}
                      </span>
                    </div>
                  </div>
                );
              }

              if (activity.type === 'file_change') {
                return (
                  <div key={activity.id} className="space-y-1.5">
                    <div className="flex items-center gap-1.5 font-medium text-foreground/80">
                      <FileDiff size={12} />
                      <span>{t('ai.chat.activity.fileChanges')}</span>
                      <span className={activity.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                        · {statusLabel(activity.status, t)}
                      </span>
                    </div>
                    <div className="space-y-1 pl-0.5">
                      {activity.changes.map((change, index) => (
                        <div key={`${activity.id}-${change.path}-${index}`} className="flex min-w-0 items-start gap-1.5">
                          <span className="w-12 shrink-0 uppercase text-[10px] text-muted-foreground">
                            {t(`ai.chat.activity.file.${change.kind}`)}
                          </span>
                          <code className="break-all text-[11px] text-foreground/75">{change.path}</code>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }

              return (
                <div key={activity.id} className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span className="break-words">{activity.message}</span>
                </div>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      )}

      {usage && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 text-[10px] text-muted-foreground/70 tabular-nums">
          <span>{usage.estimated ? `${t('ai.chat.activity.usage')} ~` : `${t('ai.chat.activity.usage')} `}{formatTokens(usage.totalTokens)}</span>
          <span>{t('ai.chat.activity.usage.input')} {formatTokens(usage.inputTokens)}</span>
          <span>{t('ai.chat.activity.usage.output')} {formatTokens(usage.outputTokens)}</span>
          {!!usage.cachedInputTokens && <span>{t('ai.chat.activity.usage.cached')} {formatTokens(usage.cachedInputTokens)}</span>}
          {!!usage.reasoningTokens && <span>{t('ai.chat.activity.usage.reasoning')} {formatTokens(usage.reasoningTokens)}</span>}
        </div>
      )}
    </div>
  );
};

export default AgentActivityGroup;
