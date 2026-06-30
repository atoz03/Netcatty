"use strict";

function createTerminalDataBacklog(options = {}) {
  const maxBytesPerSession = options.maxBytesPerSession ?? 64 * 1024;
  const pendingBySession = new Map();

  function trimToLimit(value) {
    if (value.length <= maxBytesPerSession) return value;
    return value.slice(value.length - maxBytesPerSession);
  }

  function append(sessionId, data) {
    if (!sessionId || !data) return;
    const previous = pendingBySession.get(sessionId) || "";
    pendingBySession.set(sessionId, trimToLimit(previous + data));
  }

  function take(sessionId) {
    const data = pendingBySession.get(sessionId) || "";
    pendingBySession.delete(sessionId);
    return data;
  }

  function clear(sessionId) {
    pendingBySession.delete(sessionId);
  }

  function size(sessionId) {
    return pendingBySession.get(sessionId)?.length ?? 0;
  }

  return {
    append,
    take,
    clear,
    size,
  };
}

function hasSessionListeners(listenersBySession, sessionId) {
  return (listenersBySession.get(sessionId)?.size ?? 0) > 0;
}

function createTerminalDataDispatcher({
  dataListeners,
  displayDataListeners,
  terminalDataBacklog,
  onCallbackError = console.error,
  shouldDropSession = () => false,
}) {
  return function deliverToListeners(sessionId, data) {
    if (!data) return;
    if (shouldDropSession(sessionId)) return;

    if (!hasSessionListeners(displayDataListeners, sessionId)) {
      terminalDataBacklog?.append?.(sessionId, data);
    }

    const set = dataListeners.get(sessionId);
    if (!set || set.size === 0) return;

    set.forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        onCallbackError("Data callback failed", err);
      }
    });
  };
}

function clearTerminalDataSession({
  dataListeners,
  displayDataListeners,
  terminalDataBacklog,
}, sessionId) {
  dataListeners?.delete?.(sessionId);
  displayDataListeners?.delete?.(sessionId);
  terminalDataBacklog?.clear?.(sessionId);
}

function clearTerminalDataBacklog({
  terminalDataBacklog,
}, sessionId) {
  terminalDataBacklog?.clear?.(sessionId);
}

module.exports = {
  clearTerminalDataBacklog,
  createTerminalDataBacklog,
  createTerminalDataDispatcher,
  clearTerminalDataSession,
};
