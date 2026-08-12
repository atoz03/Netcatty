type TerminalReconnectHandler = () => void;

export const createTerminalReconnectRegistry = () => {
  const handlers = new Map<string, TerminalReconnectHandler>();
  const pendingRequests = new Set<string>();

  const register = (sessionId: string, handler: TerminalReconnectHandler): (() => void) => {
    handlers.set(sessionId, handler);
    if (pendingRequests.delete(sessionId)) {
      handler();
    }
    return () => {
      if (handlers.get(sessionId) === handler) {
        handlers.delete(sessionId);
      }
    };
  };

  const request = (sessionId: string): boolean => {
    const handler = handlers.get(sessionId);
    if (!handler) {
      pendingRequests.add(sessionId);
      return true;
    }
    handler();
    return true;
  };

  return { register, request };
};

export const terminalReconnectRegistry = createTerminalReconnectRegistry();
