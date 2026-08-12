/**
 * Always-mounted host for External MCP approval cards.
 * Confirm-mode write tools from Codex/Claude/Cursor/Grok must be approvable
 * even when the Catty AI side panel has never been opened.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ToolCall } from '../ai-elements/tool-call';
import {
  onApprovalCleared,
  onApprovalRequest,
  replayPendingApprovals,
  resolveApproval,
  type ApprovalRequest,
} from '../../infrastructure/ai/shared/approvalGate';
import {
  buildGrantsFromApproval,
  resolveCapabilityId,
} from '../../infrastructure/ai/harness/permissionGrants';
import { useI18n } from '../../application/i18n/I18nProvider';

const EXTERNAL_MCP_CHAT_SESSION_ID = '__external_mcp__';

function isExternalMcpApproval(request: ApprovalRequest): boolean {
  return request.toolCallId.startsWith('mcp_approval_')
    && request.chatSessionId === EXTERNAL_MCP_CHAT_SESSION_ID;
}

export const ExternalMcpApprovalsHost: React.FC = () => {
  const { t } = useI18n();
  const [pendingApprovals, setPendingApprovals] = useState<Map<string, ApprovalRequest>>(new Map());

  useEffect(() => {
    const handler = (request: ApprovalRequest) => {
      if (!isExternalMcpApproval(request)) return;
      setPendingApprovals((prev) => new Map(prev).set(request.toolCallId, request));
    };
    const unsub = onApprovalRequest(handler);
    replayPendingApprovals(handler);
    return unsub;
  }, []);

  useEffect(() => {
    return onApprovalCleared((clearedIds) => {
      setPendingApprovals((prev) => {
        const next = new Map(prev);
        for (const id of clearedIds) next.delete(id);
        return next;
      });
    });
  }, []);

  const handleApproveOnce = useCallback((toolCallId: string) => {
    resolveApproval(toolCallId, true);
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const handleAlwaysAllow = useCallback((toolCallId: string, request: ApprovalRequest) => {
    const capabilityId = request.capabilityId ?? resolveCapabilityId(request.toolName);
    const persistGrants = buildGrantsFromApproval(capabilityId, request.args, request.chatSessionId);
    resolveApproval(toolCallId, { approved: true, persistGrants });
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const handleReject = useCallback((toolCallId: string) => {
    resolveApproval(toolCallId, false);
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(toolCallId);
      return next;
    });
  }, []);

  const entries = Array.from(pendingApprovals.entries());
  if (entries.length === 0) return null;

  return (
    <div
      className="pointer-events-auto fixed bottom-4 right-4 z-[80] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2"
      data-testid="external-mcp-approvals-host"
    >
      <div className="rounded-lg border border-border/60 bg-background/95 p-3 shadow-lg backdrop-blur-sm">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          {t('ai.externalMcp.title')}
        </div>
        <div className="space-y-2">
          {entries.map(([id, req]) => (
            <ToolCall
              key={id}
              name={req.toolName}
              args={req.args}
              isLoading={false}
              isInterrupted={false}
              approvalStatus="pending"
              approvalId={id}
              onApproveOnce={() => handleApproveOnce(id)}
              onAlwaysAllow={() => handleAlwaysAllow(id, req)}
              onReject={() => handleReject(id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
