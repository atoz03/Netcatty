import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

type ManualChoosePathPayload = {
  sessionId: string;
  sessionName?: string;
  preferredDirectory?: string;
  format?: "txt" | "raw" | "html";
};

type ManualStartPayload = {
  sessionId: string;
  sessionName?: string;
  preferredDirectory?: string;
  /**
   * Opaque token from chooseManualSessionLogPath. Required for the post-dialog
   * second phase; raw file paths from the renderer are rejected.
   */
  selectionToken?: string;
  format?: "txt" | "raw" | "html";
  timestampsEnabled?: boolean;
  initialLine?: string;
  alternateScreenActive?: boolean;
};

type ManualStopPayload = {
  sessionId: string;
};

type ManualStatusPayload = {
  sessionId: string;
};

/**
 * Declared explicitly so the bridge result and the unavailable-bridge fallback
 * collapse into one shape. Left to inference they form a union whose fallback
 * member has no `selectionToken`/`filePath`, and callers cannot read those
 * without narrowing the compiler cannot do here.
 */
type ManualChooseResult = {
  success: boolean;
  canceled?: boolean;
  error?: string;
  selectionToken?: string;
  filePath?: string;
  format?: 'txt' | 'raw' | 'html';
};

type ManualStartResult = {
  success: boolean;
  started: boolean;
  canceled?: boolean;
  error?: string;
  filePath?: string;
};

export const useSessionLogBackend = () => {
  const chooseManualSessionLogPath = useCallback(
    async (payload: ManualChoosePathPayload): Promise<ManualChooseResult> => {
      const bridge = netcattyBridge.get();
      return bridge?.chooseManualSessionLogPath?.(payload)
        ?? { success: false, canceled: false, error: "Session log bridge unavailable" };
    },
    [],
  );

  const startManualSessionLog = useCallback(
    async (payload: ManualStartPayload): Promise<ManualStartResult> => {
      const bridge = netcattyBridge.get();
      return bridge?.startManualSessionLog?.(payload) ?? { success: false, started: false, error: "Session log bridge unavailable" };
    },
    [],
  );

  const stopManualSessionLog = useCallback(async (payload: ManualStopPayload) => {
    const bridge = netcattyBridge.get();
    return bridge?.stopManualSessionLog?.(payload) ?? { success: false, stopped: false, error: "Session log bridge unavailable" };
  }, []);

  const getManualSessionLogStatus = useCallback(async (payload: ManualStatusPayload) => {
    const bridge = netcattyBridge.get();
    return bridge?.getManualSessionLogStatus?.(payload) ?? { success: false, isLogging: false, error: "Session log bridge unavailable" };
  }, []);

  return {
    chooseManualSessionLogPath,
    startManualSessionLog,
    stopManualSessionLog,
    getManualSessionLogStatus,
  };
};
