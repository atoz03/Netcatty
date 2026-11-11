import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
  STORAGE_KEY_AI_SESSIONS,
  STORAGE_KEY_AI_SESSION_MESSAGE_CAP,
  STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS,
} from '../../infrastructure/config/storageKeys';
import {
  DEFAULT_AI_SESSION_MESSAGE_CAP,
  normalizeAiSessionMessageCap,
} from '../../domain/aiSessionMessageCap';
import type {
  AIDraft,
  AIPanelView,
  AISession,
  AIPermissionMode,
  AIToolIntegrationMode,
} from '../../infrastructure/ai/types';
import { findSafeChatMessageCompactionSplitIndex } from '../../infrastructure/ai/contextCompaction';
import {
  bumpDraftMutationVersionState,
  bumpDraftUploadGenerationState,
  getDraftUploadGenerationState,
} from './aiDraftState';
import {
  pruneInactiveScopedSessions,
  pruneInactiveScopedState,
} from './aiScopeCleanup';
import { emitAIStateChanged } from './aiStateEvents';
import { peekAgentRuntimeCleanup } from '../../infrastructure/ai/harness/agentRuntimeHandle';
import { setReversibleModelPrivacy } from '../../infrastructure/ai/harness/modelSecretRedaction';
import {
  DebouncedBackupMirror,
  readLiveSessionsArray,
  writeSessionsBackupGeneration,
  type AiSessionsBackupBridge,
} from './aiSessionsBackup';
import {
  idbDeleteSessionIds,
  idbPutMeta,
  idbPutSessions,
  isIndexedDbAvailable,
  openAiSessionsIdb,
  publishAiSessionsIdbChange,
  resetAiSessionsIdbForTests,
} from './aiSessionIdbStorage';

/** Typed accessor for the Electron IPC bridge exposed on `window.netcatty`. */
export interface AIBridge extends AiSessionsBackupBridge {
  aiSdkAgentCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }>;
  aiPrivacyClearSession?: (chatSessionId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteChatToolOutputsTemp?: (chatSessionId: string) => Promise<{ deletedCount: number }>;
  deleteTerminalToolOutputsEverywhereTemp?: (terminalSessionId: string) => Promise<{ deletedCount: number }>;
  aiMcpSetPermissionMode?: (mode: AIPermissionMode) => Promise<unknown> | unknown;
  aiMcpSetToolIntegrationMode?: (mode: AIToolIntegrationMode) => Promise<unknown> | unknown;
  aiMcpSetCommandBlocklist?: (blocklist: string[]) => Promise<unknown> | unknown;
  aiMcpSetCommandTimeout?: (timeout: number) => Promise<unknown> | unknown;
  aiMcpSetMaxIterations?: (maxIterations: number) => Promise<unknown> | unknown;
  // Durability mirror (aiSessionsBackup*): see AiSessionsBackupBridge.
}

export function getAIBridge() {
  return (window as unknown as { netcatty?: AIBridge }).netcatty;
}


export const AI_STATE_CHANGED_DRAFTS_BY_SCOPE = 'netcatty:ai-drafts-by-scope';
export const AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE = 'netcatty:ai-panel-view-by-scope';

export type DraftsByScope = Partial<Record<string, AIDraft>>;
export type PanelViewByScope = Partial<Record<string, AIPanelView>>;

export async function cleanupSdkAgentSessions(sessionIds: string[]): Promise<void> {
  const bridge = getAIBridge();
  if (sessionIds.length === 0) return;
  await Promise.all(sessionIds.map((sessionId) => bridge?.aiSdkAgentCleanup?.(sessionId).catch(() => {})));
}

/**
 * Session ids explicitly deleted by the user (or by an authoritative cloud
 * merge). Their disappearance from the persisted set must not trigger the
 * pre-eviction backup generation — only cap-driven drops should.
 */
const intentionallyDeletedSessionIds = new Set<string>();

export function cleanupDeletedAIChatSessions(sessionIds: string[]) {
  const bridge = getAIBridge();
  if (sessionIds.length === 0) return;
  // Only the startup-light handle is imported here; the runtime registers it
  // when created. Without a runtime there is no in-memory runtime state, but
  // the reversible-privacy flag (set outside the runtime) and the
  // main-process privacy mapping may still exist, so always clear those.
  const runtime = peekAgentRuntimeCleanup();
  for (const sessionId of sessionIds) {
    intentionallyDeletedSessionIds.add(sessionId);
    if (runtime) {
      runtime.clearChatSession(sessionId);
    } else {
      setReversibleModelPrivacy(sessionId, false);
      void bridge?.aiPrivacyClearSession?.(sessionId).catch(() => {});
    }
    void bridge?.aiSdkAgentCleanup?.(sessionId).catch(() => {});
    void bridge?.deleteChatToolOutputsTemp?.(sessionId).catch(() => {});
  }
}

export function cleanupClosedTerminalSessions(terminalSessionIds: string[]) {
  const bridge = getAIBridge();
  const runtime = peekAgentRuntimeCleanup();
  for (const terminalSessionId of new Set(terminalSessionIds)) {
    runtime?.clearTerminalSession(terminalSessionId);
    void bridge?.deleteTerminalToolOutputsEverywhereTemp?.(terminalSessionId).catch(() => {});
  }
}

function isScopeKeyActive(scopeKey: string, activeTargetIds: Set<string>) {
  const separatorIndex = scopeKey.indexOf(':');
  if (separatorIndex === -1) return true;

  const targetId = scopeKey.slice(separatorIndex + 1);
  if (!targetId) return true;

  return activeTargetIds.has(targetId);
}

/** Last live terminal/workspace target ids observed by orphan cleanup. */
export let latestAIActiveTargetIdsSnapshot: Set<string> = new Set();
/** 每个存活终端/工作区目标对应的已保存主机 id（已知时）。 */
export let latestAITargetHostIdsSnapshot: ReadonlyMap<string, readonly string[]> | undefined;

/** 测试钩子：清除最近一次观测到的目标 -> 主机 id 映射。 */
export function __resetAITargetHostIdsSnapshotForTests() {
  latestAITargetHostIdsSnapshot = undefined;
}

/**
 * 在终端/工作区仍存活时，为旧会话（记录主机 id 之前保存的，或在主机尚未解析的
 * 作用域上创建的）补上稳定的主机身份，使其在目标关闭后仍跟随该已保存主机。
 * 被存活作用域选中的会话继承该作用域的主机。已有主机 id 的会话永不改写，
 * 避免会话被悄悄迁移到其他服务器。
 */
export function backfillSessionHostIds(
  sessions: AISession[],
  targetHostIds: ReadonlyMap<string, readonly string[]>,
  activeSessionIdMap: Readonly<Record<string, string | null | undefined>> = {},
): AISession[] {
  const hostIdsBySelectedSession = new Map<string, readonly string[]>();
  for (const [scopeKey, sessionId] of Object.entries(activeSessionIdMap)) {
    if (!sessionId) continue;
    const separatorIndex = scopeKey.indexOf(':');
    if (separatorIndex === -1) continue;
    const hostIds = targetHostIds.get(scopeKey.slice(separatorIndex + 1));
    if (hostIds?.length && !hostIdsBySelectedSession.has(sessionId)) {
      hostIdsBySelectedSession.set(sessionId, hostIds);
    }
  }
  let changed = false;
  const next = sessions.map((session) => {
    if (session.scope.type === 'global') return session;
    if (session.scope.hostIds && session.scope.hostIds.length > 0) return session;
    const hostIds = (session.scope.targetId ? targetHostIds.get(session.scope.targetId) : undefined)
      ?? hostIdsBySelectedSession.get(session.id);
    if (!hostIds || hostIds.length === 0) return session;
    changed = true;
    return { ...session, scope: { ...session.scope, hostIds: [...new Set(hostIds)] } };
  });
  return changed ? next : sessions;
}

export function cleanupOrphanedAISessions(
  activeTargetIds: Set<string>,
  targetHostIds?: ReadonlyMap<string, readonly string[]>,
) {
  latestAIActiveTargetIdsSnapshot = activeTargetIds;
  if (targetHostIds) latestAITargetHostIdsSnapshot = targetHostIds;
  // Child maintenance effects run before the provider's boot effects. Keep
  // the live targets for post-hydration cleanup without adopting stale legacy
  // history as authoritative state while IndexedDB is still loading.
  if (!isAiSessionsHydrationComplete()) return;
  const storedSessions = latestAISessionsSnapshot ?? getPersistedAiSessionsSnapshot();

  // Sessions shown by a still-live scope must be protected from cleanup
  // even when their own `scope.targetId` points at a closed terminal —
  // history can be resumed into a different terminal and we must not
  // delete it outright while it's actively being used.
  const preCleanupActiveSessionMap = latestAIActiveSessionMapSnapshot
    ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
    ?? {};
  const activeSessionIds = new Set<string>();
  for (const [scopeKey, sessionId] of Object.entries(preCleanupActiveSessionMap)) {
    if (!sessionId) continue;
    if (!isScopeKeyActive(scopeKey, activeTargetIds)) continue;
    activeSessionIds.add(sessionId);
  }

  const hostTargets = targetHostIds ?? latestAITargetHostIdsSnapshot;
  const currentSessions = hostTargets
    ? backfillSessionHostIds(storedSessions, hostTargets, preCleanupActiveSessionMap)
    : storedSessions;
  let sessionsMarked = currentSessions !== storedSessions;

  const nextSessionCleanup = pruneInactiveScopedSessions(
    currentSessions,
    activeTargetIds,
    activeSessionIds,
  );

  if (nextSessionCleanup.orphanedSessionIds.length > 0) {
    cleanupSdkAgentSessions(nextSessionCleanup.orphanedSessionIds);
  }

  // Issue #4015 R2: a dropped chat is recoverable now, so mark it dangling
  // instead of stripping its record or pointer. `/chats` lists dangling chats
  // with a rebind affordance; the flag clears when the chat is rebound or its
  // scope target becomes live again.
  const orphanedIds = new Set(nextSessionCleanup.orphanedSessionIds);
  const markedSessions = currentSessions.map((session) => {
    if (orphanedIds.has(session.id)) {
      if (session.scopeDangling) return session;
      sessionsMarked = true;
      return { ...session, scopeDangling: true };
    }
    if (
      session.scopeDangling
      && (!session.scope.targetId || activeTargetIds.has(session.scope.targetId))
    ) {
      sessionsMarked = true;
      const { scopeDangling: _cleared, ...rest } = session;
      return rest as AISession;
    }
    return session;
  });

  if (sessionsMarked) {
    setLatestAISessionsSnapshot(markedSessions);
    writeSessionsForStorage(markedSessions);
    emitAIStateChanged(STORAGE_KEY_AI_SESSIONS);
  }

  // Issue #4015 R2: keep active-pointer entries for scopes whose target
  // closed. Clearing them used to make dangling chats invisible (rank 0) and
  // unrecoverable from the UI; the pointer is rewritten on rebind instead.
  const currentDraftsByScope = latestAIDraftsByScopeSnapshot ?? {};
  const currentPanelViewByScope = latestAIPanelViewByScopeSnapshot ?? {};
  const prunedScopedState = pruneInactiveScopedState(
    currentDraftsByScope,
    currentPanelViewByScope,
    activeTargetIds,
  );

  if (prunedScopedState.draftsByScope !== currentDraftsByScope) {
    for (const scopeKey of Object.keys(currentDraftsByScope)) {
      if (scopeKey in prunedScopedState.draftsByScope) continue;
      bumpDraftMutationVersion(scopeKey);
      bumpDraftUploadGeneration(scopeKey);
    }
    setLatestAIDraftsByScopeSnapshot(prunedScopedState.draftsByScope);
    emitAIStateChanged(AI_STATE_CHANGED_DRAFTS_BY_SCOPE);
  }

  if (prunedScopedState.panelViewByScope !== currentPanelViewByScope) {
    for (const scopeKey of Object.keys(currentPanelViewByScope)) {
      if (scopeKey in prunedScopedState.panelViewByScope) continue;
      bumpDraftMutationVersion(scopeKey);
    }
    setLatestAIPanelViewByScopeSnapshot(prunedScopedState.panelViewByScope);
    emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
  }
}


/**
 * Maximum number of sessions kept in the persisted store. IndexedDB has no
 * shared byte quota, so retention is a plain count cap; the cap only exists
 * to keep history from growing without bound.
 *
 * 该上限只作用于未绑定已保存主机的会话（全局会话、旧版无 hostIds 的会话）。
 * 绑定到已保存主机的会话是该主机的长期归档：不按数量淘汰，也不截断消息，
 * 只能由用户显式删除。
 */
export const MAX_STORED_SESSIONS = 1000;

/**
 * 会话是否绑定到已保存主机（`scope.hostIds` 非空的终端/工作区会话）。
 * 绑定主机的会话完整保留，存储层不对其做任何自动淘汰或截断。
 */
export function isHostBoundAISession(session: AISession): boolean {
  if (session.scope?.type === 'global') return false;
  return !!session.scope?.hostIds && session.scope.hostIds.length > 0;
}

/**
 * Per-session message cap, read from user settings (clamped to 50–2000,
 * default 200). Read on every write so a lowered cap trims the oldest
 * messages on the next write; a raised cap stops further trimming.
 * Best-effort: an unavailable storage layer keeps the default cap.
 */
export function readAiSessionMessageCap(): number {
  try {
    return normalizeAiSessionMessageCap(
      localStorageAdapter.readNumber(STORAGE_KEY_AI_SESSION_MESSAGE_CAP)
        ?? DEFAULT_AI_SESSION_MESSAGE_CAP,
    );
  } catch {
    return DEFAULT_AI_SESSION_MESSAGE_CAP;
  }
}

/**
 * Prune sessions before writing to the persisted store to bound retention.
 * Only affects what is persisted — the in-memory state retains all messages
 * until the session is reloaded.
 *
 * 绑定已保存主机的会话（见 `isHostBoundAISession`）原样保留：不计入数量上限，
 * 也不按 `messageCap` 截断。模型上下文长度由上下文压缩单独处理，与归档历史无关。
 * 以下两条只作用于未绑定主机的会话：
 * - Keeps only the MAX_STORED_SESSIONS most-recently-updated sessions.
 * - Trims each session's messages to the last `messageCap` messages.
 */
/**
 * 截断后的会话副本按源会话对象缓存。会话对象是不可变的（每次更新都会生成新对象），
 * 因此同一源对象 + 同一上限得到的副本可以复用：逐条比对引用的 IndexedDB 差量写入
 * 不会再把每个被截断的会话在每次保存时都当作“已变更”重写一遍。
 */
const trimmedSessionCache = new WeakMap<AISession, { messageCap: number; trimmed: AISession }>();

export function pruneSessionsForStorage(
  sessions: AISession[],
  messageCap: number = readAiSessionMessageCap(),
  maxUnboundSessions: number = MAX_STORED_SESSIONS,
): AISession[] {
  // Sort by updatedAt descending so we keep the newest
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  let keptUnbound = 0;
  const limited = sorted.filter((session) => {
    if (isHostBoundAISession(session)) return true;
    keptUnbound += 1;
    return keptUnbound <= maxUnboundSessions;
  });
  return limited.map(s => {
    if (!isHostBoundAISession(s) && s.messages.length > messageCap) {
      const cached = trimmedSessionCache.get(s);
      if (cached && cached.messageCap === messageCap) return cached.trimmed;
      // Do not start the retained tail with a tool result whose assistant call
      // was just trimmed. Reuse the same tool-safe boundary logic as context
      // compaction, even if that retains a few more than the nominal cap.
      const removedMessageCount = findSafeChatMessageCompactionSplitIndex(
        s.messages,
        messageCap,
      );
      const contextCompaction = s.contextCompaction
        ? {
            ...s.contextCompaction,
            compactedMessageCount: Math.max(
              0,
              s.contextCompaction.compactedMessageCount - removedMessageCount,
            ),
          }
        : undefined;
      const trimmed: AISession = {
        ...s,
        messages: s.messages.slice(removedMessageCount),
        ...(contextCompaction ? { contextCompaction } : {}),
      };
      trimmedSessionCache.set(s, { messageCap, trimmed });
      return trimmed;
    }
    return s;
  });
}

export function prepareRestoredSessions(sessions: AISession[], syncEnabled: boolean): AISession[] {
  return syncEnabled ? sessions : pruneSessionsForStorage(sessions);
}

// ── IndexedDB persistence (issue #4123) ──
//
// Sessions are persisted one record per session. There is no global byte
// budget and no re-serialization ladder: the 2 MB localStorage budget existed
// to defend a shared quota against the cost of serializing the whole store on
// every write, and both are gone with per-record writes. Only a count cap
// (MAX_STORED_SESSIONS) and the per-session message cap remain.
// 两者都只作用于未绑定已保存主机的会话。

/** Last set of sessions known to be persisted, for per-record diffing. */
let lastPersistedSessionsById: Map<string, AISession> = new Map();
/** Serialized write queue: IDB operations never interleave. */
let idbWriteQueue: Promise<void> = Promise.resolve();

/** Test hook: reset diff state between tests. */
export function __resetIdbPersistenceForTests() {
  lastPersistedSessionsById = new Map();
  idbWriteQueue = Promise.resolve();
  // Tests swap the fake indexedDB factory between cases; the cached open
  // handle must not survive the swap.
  resetAiSessionsIdbForTests();
  // Tests simulate the post-boot state by default; the boot-gating cases
  // call __resetAiSessionsHydrationForTests() to go back to pending.
  markAiSessionsHydrationComplete();
}

/** Test hook: resolve once every queued IndexedDB sync has settled. */
export function __flushIdbWritesForTests(): Promise<void> {
  return idbWriteQueue.then(() => undefined, () => undefined);
}

// ── Boot hydration signal (issue #4125 review) ──
//
// Settles once useAIState's boot load has finished (IndexedDB read, legacy
// migration, disk-backup restore). Sync collection and the active-pointer
// validation must not run before it: a pre-hydration collect reads the
// stale legacy localStorage store and would overwrite newer IndexedDB
// records, and pointer validation against the initially-empty in-memory
// array would null every pointer before the real sessions arrive.

let aiSessionsHydrationComplete = false;

export function isAiSessionsHydrationComplete(): boolean {
  return aiSessionsHydrationComplete;
}

/** Called by useAIState's boot effect when the boot load settles. */
export function markAiSessionsHydrationComplete(): void {
  aiSessionsHydrationComplete = true;
}

/** Test hook: return the hydration signal to the pre-boot (pending) state. */
export function __resetAiSessionsHydrationForTests(): void {
  aiSessionsHydrationComplete = false;
}

/** Seed the diff baseline after a boot load or migration. */
export function seedLastPersistedSessions(sessions: AISession[]) {
  lastPersistedSessionsById = new Map(sessions.map(session => [session.id, session]));
}

/**
 * Read the persisted session set synchronously. Source of truth is the
 * in-memory snapshot held by useAIState; this accessor returns the last set
 * handed to `writeSessionsForStorage`, falling back to the read-only legacy
 * localStorage store (kept untouched for one release).
 */
export function getPersistedAiSessionsSnapshot(): AISession[] {
  if (lastPersistedSessionsById.size > 0) {
    return Array.from(lastPersistedSessionsById.values())
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  return readLiveSessionsArray(localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS));
}

function queueIdbSessionSync(
  changed: AISession[],
  removedIds: string[],
  prevById: Map<string, AISession>,
  persisted: AISession[],
) {
  if (changed.length === 0 && removedIds.length === 0) return;
  idbWriteQueue = idbWriteQueue
    .then(async () => {
      if (!isIndexedDbAvailable()) return;
      const db = await openAiSessionsIdb();
      // Per-record write: only the changed sessions are put, only removed
      // ids are deleted.
      if (changed.length > 0) await idbPutSessions(db, changed);
      if (removedIds.length > 0) await idbDeleteSessionIds(db, removedIds);
      await idbPutMeta(db, 'schemaVersion', 1);
      await idbPutMeta(db, 'lastWriteAt', Date.now());
      publishAiSessionsIdbChange();
    })
    .catch((error) => {
      // IndexedDB failures must never break the in-memory session state.
      // Reset the diff baseline so the next write retries every record, and
      // fall back to the legacy localStorage key so a corrupt/unavailable
      // IndexedDB still leaves a restorable trace (via the disk mirror).
      console.warn('[AIState] IndexedDB session sync failed:', error);
      lastPersistedSessionsById = new Map(prevById);
      try {
        localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, JSON.stringify(persisted));
      } catch {
        // Legacy fallback is best-effort too.
      }
    });
}

// Durability mirror (issue #4015 follow-up): every write also schedules a
// debounced disk backup so a wiped/recreated profile does not take the chat
// history with it. The persisted JSON is mirrored; when the count cap evicts
// sessions, a PRE-eviction generation is written first so evicted chats stay
// recoverable from disk (the blind spot found in issue #4123).
/** 镜像载荷：会话数组按引用保存、写出时才序列化；字符串为已序列化的旧格式。 */
type BackupMirrorPayload = readonly AISession[] | string;

const backupMirror = new DebouncedBackupMirror<BackupMirrorPayload>((payload) => {
  try {
    const bridge = getAIBridge();
    if (typeof payload === 'string') {
      void bridge?.aiSessionsBackupWrite?.({ json: payload })?.catch(() => {});
      return;
    }
    writeSessionsBackupGeneration(bridge, payload);
  } catch (error) {
    // Backup failures must never break chat persistence.
    console.warn('[AIState] Failed to write the AI session backup generation:', error);
  }
});

let aiSessionsBackupRecoveryPending = false;

/** Partial migration must not rotate away generations holding disk-only chats. */
export function setAiSessionsBackupRecoveryPending(pending: boolean) {
  aiSessionsBackupRecoveryPending = pending;
  if (pending) backupMirror.reset();
}

export function flushBackupMirror() {
  try {
    backupMirror.flushNow();
  } catch {
    // Unload and persistence must remain fail-safe.
  }
}

export function __resetBackupMirrorForTests() {
  backupMirror.reset();
  aiSessionsBackupRecoveryPending = false;
}

export function scheduleBackupMirror(payload: BackupMirrorPayload) {
  if (aiSessionsBackupRecoveryPending) return;
  try {
    backupMirror.schedule(payload);
  } catch {
    // ignore
  }
}

/** Write one immediate backup generation (bypasses the debounce window). */
function writeImmediateBackupGeneration(sessions: readonly AISession[]) {
  if (aiSessionsBackupRecoveryPending) return;
  try {
    backupMirror.schedule(sessions);
    backupMirror.flushNow();
  } catch {
    // Backup failures must never break chat persistence.
  }
}


/**
 * Persist sessions. Writes go to IndexedDB, one record per session, through a
 * serialized queue; errors are logged, never thrown. Returns true when the
 * persisted set was computed (in-memory state remains authoritative either
 * way).
 */
export function writeSessionsForStorage(
  sessions: AISession[],
  options?: { deletedSessionIds?: readonly string[] },
): boolean {
  try {
    // Explicitly deleted ids never count as cap eviction (they also must not
    // trigger a pre-eviction backup generation).
    for (const id of options?.deletedSessionIds ?? []) intentionallyDeletedSessionIds.add(id);
    // Synced records are authoritative after restart: never prune them, or
    // local retention would turn into cloud deletion on the next sync.
    const syncEnabled = !!localStorageAdapter.read<{ enabled?: boolean }>(
      STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS,
    )?.enabled;
    const persisted = syncEnabled ? sessions : pruneSessionsForStorage(sessions);

    const prevById = lastPersistedSessionsById;
    const persistedIds = new Set(persisted.map(session => session.id));

    // Count-cap eviction: sessions that drop out of the persisted set without
    // being explicitly deleted get a pre-eviction disk generation containing
    // the full pre-eviction store, so they remain recoverable.
    const evicted = Array.from(prevById.entries())
      .filter(([id]) => !persistedIds.has(id) && !intentionallyDeletedSessionIds.has(id))
      .map(([, session]) => session);
    intentionallyDeletedSessionIds.clear();
    if (evicted.length > 0) {
      writeImmediateBackupGeneration(sessions);
      console.warn(
        `[AIState] Retention cap evicted ${evicted.length} session(s); a pre-eviction backup generation was written to disk.`,
      );
    }

    // Per-record diff (synchronous: the baseline must advance even when
    // IndexedDB is unavailable, and callers read the snapshot right after).
    const changed = persisted.filter(session => prevById.get(session.id) !== session);
    const removedIds = Array.from(prevById.keys()).filter(id => !persistedIds.has(id));
    lastPersistedSessionsById = new Map(persisted.map(session => [session.id, session]));

    // Perf (#4121)：同一不可变数组被防抖保存和云同步收集重复写入时，差量为空，
    // 不再调度备份。调度只保存数组引用，整库序列化推迟到防抖窗口结束时进行一次。
    if (changed.length > 0 || removedIds.length > 0) {
      scheduleBackupMirror(persisted);
    }
    queueIdbSessionSync(changed, removedIds, prevById, persisted);
    return true;
  } catch (error) {
    console.warn('[AIState] Failed to persist AI sessions:', error);
    return false;
  }
}

export let latestAISessionsSnapshot: AISession[] | null = null;
export let latestAIActiveSessionMapSnapshot: Record<string, string | null> | null = null;
export let latestAIDraftsByScopeSnapshot: DraftsByScope | null = null;
export let latestAIPanelViewByScopeSnapshot: PanelViewByScope | null = null;
let latestAIDraftMutationVersionByScopeSnapshot: Record<string, number> = {};
let latestAIDraftUploadGenerationByScopeSnapshot: Record<string, number> = {};


/**
 * Issue #4015 R2: rewrite the active-session map when rebinding a dangling
 * chat. Drops every pointer that still names `sessionId` under a different
 * scope key, then sets the new scope as active. Callers must persist and
 * publish the returned map (do not rebuild from a stale snapshot).
 */
export function rebindActiveSessionMap(
  activeSessionIdMap: Record<string, string | null>,
  sessionId: string,
  scopeKey: string,
): Record<string, string | null> {
  let next = activeSessionIdMap;
  for (const [key, id] of Object.entries(activeSessionIdMap)) {
    if (id !== sessionId || key === scopeKey) continue;
    if (next === activeSessionIdMap) next = { ...activeSessionIdMap };
    delete next[key];
  }
  if (next[scopeKey] === sessionId) return next;
  return { ...next, [scopeKey]: sessionId };
}

export function setLatestAISessionsSnapshot(sessions: AISession[]) {
  latestAISessionsSnapshot = sessions;
}

export function setLatestAIActiveSessionMapSnapshot(activeSessionIdMap: Record<string, string | null>) {
  latestAIActiveSessionMapSnapshot = activeSessionIdMap;
}

export function prewarmAIStateStorageSnapshots() {
  try {
    // Sessions are no longer prewarmed from localStorage: the primary store is
    // IndexedDB and loads asynchronously in useAIState. Prewarming the stale
    // read-only legacy key would make the boot loader skip the IndexedDB
    // contents ("never restore over non-empty live state").
    if (latestAIActiveSessionMapSnapshot === null) {
      latestAIActiveSessionMapSnapshot =
        localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP) ?? {};
    }
  } catch (error) {
    console.warn('[AIState] Failed to prewarm AI state storage snapshots:', error);
  }
}

export function setLatestAIDraftsByScopeSnapshot(draftsByScope: DraftsByScope) {
  latestAIDraftsByScopeSnapshot = draftsByScope;
}

export function setLatestAIPanelViewByScopeSnapshot(panelViewByScope: PanelViewByScope) {
  latestAIPanelViewByScopeSnapshot = panelViewByScope;
}

export function bumpDraftMutationVersion(scopeKey: string) {
  latestAIDraftMutationVersionByScopeSnapshot = bumpDraftMutationVersionState(
    latestAIDraftMutationVersionByScopeSnapshot,
    scopeKey,
  );
}

export function getDraftUploadGeneration(scopeKey: string) {
  return getDraftUploadGenerationState(
    latestAIDraftUploadGenerationByScopeSnapshot,
    scopeKey,
  );
}

export function bumpDraftUploadGeneration(scopeKey: string) {
  latestAIDraftUploadGenerationByScopeSnapshot = bumpDraftUploadGenerationState(
    latestAIDraftUploadGenerationByScopeSnapshot,
    scopeKey,
  );
}
