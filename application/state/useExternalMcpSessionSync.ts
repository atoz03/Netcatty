import { useEffect, useMemo, useRef, useState } from 'react';

import { buildAITerminalSessionInfo } from '../../domain/buildAITerminalSessionInfo';
import { detectLocalOs } from '../../lib/localShell';
import type { Host, PortForwardingRule, TerminalSession } from '../../types';
import { STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED } from '../../infrastructure/config/storageKeys';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { AI_STATE_CHANGED_EVENT } from './aiStateEvents';
import { readExternalMcpStoredEnabled } from './useExternalMcpToggleState';

const EXTERNAL_MCP_CHAT_SESSION_ID = '__external_mcp__';

type UseExternalMcpSessionSyncOptions = {
  sessions: TerminalSession[];
  sessionHostsMap?: Map<string, Host>;
  hosts: Host[];
  portForwardingRules: PortForwardingRule[];
};

function isMainAppWindow(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash || '';
  // Peer session windows and settings-only windows must not own the
  // app-wide External MCP scope — they only see a partial session set.
  if (hash.startsWith('#/session-window')) return false;
  if (hash.startsWith('#/settings')) return false;
  return true;
}

/**
 * Keep the reserved External MCP scope aligned with every live terminal
 * session, independent of whether the Catty AI side panel / TerminalLayer
 * has mounted yet.
 */
export function useExternalMcpSessionSync({
  sessions,
  sessionHostsMap,
  hosts,
  portForwardingRules,
}: UseExternalMcpSessionSyncOptions) {
  const [enabledTick, setEnabledTick] = useState(0);
  const enabled = useMemo(() => {
    void enabledTick;
    return readExternalMcpStoredEnabled();
  }, [enabledTick]);
  const syncGenerationRef = useRef(0);

  useEffect(() => {
    const bump = () => setEnabledTick((value) => value + 1);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED) return;
      bump();
    };
    const handleLocalStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      if (detail?.key && detail.key !== STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED) return;
      bump();
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged as EventListener);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, handleLocalStateChanged as EventListener);
    };
  }, []);

  const payload = useMemo(() => {
    const localOs = detectLocalOs(navigator.userAgent || navigator.platform);
    const hostById = new Map(hosts.map((host) => [host.id, host]));
    return sessions.map((session) => {
      const host = sessionHostsMap?.get(session.id)
        || (session.hostId ? hostById.get(session.hostId) : undefined);
      return buildAITerminalSessionInfo(session, host, localOs, {
        allHosts: hosts,
        portForwardingRules,
      });
    });
  }, [sessions, sessionHostsMap, hosts, portForwardingRules]);

  const lastSentSerializedRef = useRef('');

  useEffect(() => {
    if (!isMainAppWindow()) return;
    if (!enabled) {
      syncGenerationRef.current += 1;
      lastSentSerializedRef.current = '';
      return;
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.aiMcpUpdateSessions) return;

    const serialized = JSON.stringify(payload);
    if (serialized === lastSentSerializedRef.current) return;

    const generation = ++syncGenerationRef.current;
    const timeoutId = window.setTimeout(() => {
      void Promise.resolve(bridge.aiMcpUpdateSessions?.(payload, EXTERNAL_MCP_CHAT_SESSION_ID))
        .then((result) => {
          if (generation !== syncGenerationRef.current) return;
          if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: boolean }).ok === false) {
            return;
          }
          lastSentSerializedRef.current = serialized;
        })
        .catch(() => {
          // Leave the ref unset so the next effect can retry.
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [enabled, payload]);
}
