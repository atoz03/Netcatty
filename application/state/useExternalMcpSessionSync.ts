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

export function createLatestPayloadSync<T>(
  send: (payload: T) => Promise<unknown>,
) {
  let desired: { serialized: string; payload: T } | null = null;
  let acknowledged = '';
  let inFlight: Promise<void> | null = null;
  let cancelled = false;

  const pump = async () => {
    while (!cancelled && desired && desired.serialized !== acknowledged) {
      const target = desired;
      try {
        const result = await send(target.payload);
        if (cancelled) break;
        if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: boolean }).ok === false) {
          if (desired === target) break;
          continue;
        }
        acknowledged = target.serialized;
      } catch {
        if (desired === target) break;
      }
    }
  };

  return {
    push(payload: T, serialized = JSON.stringify(payload)): Promise<void> {
      if (cancelled) return Promise.resolve();
      desired = { payload, serialized };
      if (!inFlight) {
        inFlight = pump().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    cancel(): void {
      cancelled = true;
      desired = null;
    },
  };
}

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

  const liveSyncRef = useRef<ReturnType<typeof createLatestPayloadSync<typeof payload>> | null>(null);
  const externalSyncRef = useRef<ReturnType<typeof createLatestPayloadSync<typeof payload>> | null>(null);

  useEffect(() => {
    if (!isMainAppWindow()) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.aiMcpUpdateLiveSessions) return;
    const serialized = JSON.stringify(payload);
    liveSyncRef.current ??= createLatestPayloadSync((nextPayload) => (
      Promise.resolve(bridge.aiMcpUpdateLiveSessions?.(nextPayload))
    ));
    void liveSyncRef.current.push(payload, serialized);
  }, [payload]);

  useEffect(() => {
    if (!isMainAppWindow()) return;
    if (!enabled) {
      // Recreate the synchronizer after re-enabling because disabling can
      // clear the main-process scope even when the renderer payload is equal.
      externalSyncRef.current?.cancel();
      externalSyncRef.current = null;
      return;
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.aiMcpUpdateSessions) return;

    const serialized = JSON.stringify(payload);
    const timeoutId = window.setTimeout(() => {
      externalSyncRef.current ??= createLatestPayloadSync((nextPayload) => (
        Promise.resolve(bridge.aiMcpUpdateSessions?.(
          nextPayload,
          EXTERNAL_MCP_CHAT_SESSION_ID,
        ))
      ));
      void externalSyncRef.current.push(payload, serialized);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [enabled, payload]);
}
