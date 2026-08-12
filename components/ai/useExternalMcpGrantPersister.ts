import { useEffect } from 'react';

import { useAIPermissionGrantsState } from '../../application/state/useAIPermissionGrantsState';
import { registerGrantPersister } from '../../infrastructure/ai/shared/approvalGate';

/**
 * Keep Always Allow grants writable even when Catty AI panel is not mounted
 * (External MCP approvals in main/settings windows).
 */
export function useExternalMcpGrantPersister(): void {
  const { addGrant } = useAIPermissionGrantsState();

  useEffect(() => {
    return registerGrantPersister((rule) => {
      addGrant(rule);
    });
  }, [addGrant]);
}
