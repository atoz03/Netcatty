"use strict";

function createSessionOwnershipRegistry() {
  const ownedByScope = new Map();
  const scopeGenerations = new Map();

  function captureGeneration(chatSessionId) {
    if (!chatSessionId) return null;
    let generation = scopeGenerations.get(chatSessionId);
    if (!generation) {
      generation = { chatSessionId, revoked: false };
      scopeGenerations.set(chatSessionId, generation);
    }
    return generation;
  }

  function register(chatSessionId, sessionId, expectedGeneration = null) {
    if (!chatSessionId || !sessionId) return false;
    if (expectedGeneration !== null) {
      const currentGeneration = scopeGenerations.get(chatSessionId);
      if (
        expectedGeneration.revoked
        || expectedGeneration.chatSessionId !== chatSessionId
        || currentGeneration !== expectedGeneration
      ) {
        return false;
      }
    }
    const owned = ownedByScope.get(chatSessionId) || new Set();
    owned.add(sessionId);
    ownedByScope.set(chatSessionId, owned);
    return true;
  }

  function validate(chatSessionId, sessionId) {
    if (!chatSessionId) return { ok: false, error: "chatSessionId is required." };
    if (!ownedByScope.get(chatSessionId)?.has(sessionId)) {
      return {
        ok: false,
        error: `Session "${sessionId}" was not opened by the current AI scope.`,
      };
    }
    return { ok: true };
  }

  function forgetSession(sessionId) {
    for (const [scopeId, owned] of ownedByScope) {
      owned.delete(sessionId);
      if (owned.size === 0) ownedByScope.delete(scopeId);
    }
  }

  function clearScope(chatSessionId) {
    ownedByScope.delete(chatSessionId);
    const generation = scopeGenerations.get(chatSessionId);
    if (generation) generation.revoked = true;
    scopeGenerations.delete(chatSessionId);
  }

  function getTrackedGenerationCountForTests() {
    return scopeGenerations.size;
  }

  return {
    captureGeneration,
    register,
    validate,
    forgetSession,
    clearScope,
    getTrackedGenerationCountForTests,
  };
}

module.exports = { createSessionOwnershipRegistry };
