/**
 * Exact-scope AI session helpers for multi-panel memo isolation.
 *
 * History still needs the full sessions list for fuzzy host-match ranking
 * (`getScopedHistorySessions`). Stream thrash is blocked by comparing only
 * exact-scope session object refs in panel are equal — not by pre-filtering
 * the history universe away.
 */

export type AISessionScopeLike = {
  type: string;
  targetId?: string;
};

export type AISessionLike = {
  id: string;
  scope: AISessionScopeLike;
  /** Optional chrome for history list equality (title renames without message thrash). */
  title?: string | null;
  /** Optional chrome for history sort / relative-time display (`getScopedHistorySessions`). */
  updatedAt?: number;
};

export function buildAIScopeKey(scopeType: string, scopeTargetId?: string): string {
  return `${scopeType}:${scopeTargetId ?? ''}`;
}

export function sessionMatchesAIScope(
  session: AISessionLike,
  scopeType: string,
  scopeTargetId?: string,
): boolean {
  return session.scope.type === scopeType
    && (session.scope.targetId ?? '') === (scopeTargetId ?? '');
}

export function filterAISessionsForScope<T extends AISessionLike>(
  sessions: readonly T[],
  scopeType: string,
  scopeTargetId?: string,
): T[] {
  return sessions.filter((session) => sessionMatchesAIScope(session, scopeType, scopeTargetId));
}

/**
 * True when the given session id's object identity is unchanged across arrays
 * (or both sides lack that session).
 */
export function aiSessionByIdEqual<T extends AISessionLike>(
  prev: readonly T[] | null | undefined,
  next: readonly T[] | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return true;
  if (prev === next) return true;
  if (!prev || !next) return false;
  const prevSession = prev.find((session) => session.id === sessionId);
  const nextSession = next.find((session) => session.id === sessionId);
  return prevSession === nextSession;
}

/**
 * True when both arrays contain the same session ids (order-insensitive) and
 * matching history chrome (title + updatedAt). Detects create/delete/rename and
 * timestamp/order changes without treating message-body object replacement alone
 * as a reason to re-render when chrome is unchanged.
 */
export function aiSessionIdSetEqual<T extends AISessionLike>(
  prev: readonly T[] | null | undefined,
  next: readonly T[] | null | undefined,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  if (prev.length === 0) return true;
  const prevById = new Map(prev.map((session) => [session.id, session]));
  for (const session of next) {
    const prevSession = prevById.get(session.id);
    if (!prevSession) return false;
    if ((prevSession.title ?? '') !== (session.title ?? '')) return false;
    if ((prevSession.updatedAt ?? 0) !== (session.updatedAt ?? 0)) return false;
  }
  return true;
}

/**
 * True when exact-scope session object identities match (order-insensitive by id).
 * Sibling stream updates replace only their own session objects, so other panels
 * see the same exact-scope refs and can skip re-render.
 *
 * When `selectedSessionId` is set (e.g. a history chat resumed under a newer
 * terminal whose stored scope still points at an older target), that session is
 * also compared by identity so stream updates still re-render the visible panel.
 */
export function exactScopeAISessionsEqual<T extends AISessionLike>(
  prev: readonly T[] | null | undefined,
  next: readonly T[] | null | undefined,
  scopeType: string,
  scopeTargetId?: string,
  selectedSessionId?: string | null,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (!aiSessionByIdEqual(prev, next, selectedSessionId)) return false;
  const prevExact = filterAISessionsForScope(prev, scopeType, scopeTargetId);
  const nextExact = filterAISessionsForScope(next, scopeType, scopeTargetId);
  if (prevExact.length !== nextExact.length) return false;
  if (prevExact.length === 0) return true;
  const prevById = new Map(prevExact.map((session) => [session.id, session]));
  for (const session of nextExact) {
    if (prevById.get(session.id) !== session) return false;
  }
  return true;
}

/**
 * Keep previous filtered array identity when every matching session ref is the same.
 */
export function retainStableAISessionsForScope<T extends AISessionLike>(
  previous: readonly T[] | null | undefined,
  next: readonly T[],
): readonly T[] {
  if (
    previous
    && previous.length === next.length
    && previous.every((session, index) => session === next[index])
  ) {
    return previous;
  }
  return next;
}
