import type { AISession } from '../../infrastructure/ai/types';

/**
 * Renderer-side logic for the AI session durability layer (issue #4015 R2
 * follow-up): a disk mirror of the localStorage session store plus a
 * restore-on-empty-store boot path. The IPC plumbing lives in
 * `electron/bridges/aiSessionsBackupBridge.cjs`; this module keeps the
 * decisions pure so they can be tested without Electron.
 */

/** Debounce window: at most one backup write per mutation burst (~2s). */
export const AI_SESSIONS_BACKUP_DEBOUNCE_MS = 2000;

/**
 * 分块备份时每条 IPC 的目标字符数。远小于主进程单条 64 MB 上限，渲染进程不再
 * 需要为整库生成一个巨大的字符串；单个会话超过该值时独占一块。
 */
export const AI_SESSIONS_BACKUP_CHUNK_CHARS = 4 * 1024 * 1024;

export interface AiSessionsBackupBridge {
  aiSessionsBackupWrite?: (payload: { json: string }) => Promise<{ ok: boolean }>;
  aiSessionsBackupWriteBegin?: (payload: { id: string }) => Promise<{ ok: boolean; error?: string }>;
  aiSessionsBackupWriteChunk?: (payload: { id: string; chunk: string }) => Promise<{ ok: boolean; error?: string }>;
  aiSessionsBackupWriteCommit?: (payload: { id: string }) => Promise<{ ok: boolean; error?: string; file?: string }>;
  aiSessionsBackupWriteAbort?: (payload: { id: string }) => Promise<{ ok: boolean }>;
  aiSessionsBackupReadLatest?: () => Promise<{ ok: boolean; json?: string }>;
  aiSessionsBackupExport?: (payload: { json: string }) => Promise<{ success: boolean; filePath?: string }>;
  aiSessionsBackupImport?: () => Promise<{ success: boolean; json?: string }>;
}

/**
 * Parse the live sessions store once, returning both whether it is usable and
 * its sessions. The history is often several MB; the helpers below used to
 * parse it twice per call, and mount ran them back to back (five parses).
 */
export function parseSessionsStore(raw: string | null | undefined): { valid: boolean; sessions: AISession[] } {
  if (raw == null || raw === '') return { valid: false, sessions: [] };
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? { valid: true, sessions: parsed as AISession[] }
      : { valid: false, sessions: [] };
  } catch {
    return { valid: false, sessions: [] };
  }
}

/** Restore only when the live store is missing or malformed. A valid empty
 * array represents an intentional deletion and must remain authoritative. */
export function isMissingOrCorruptSessionsStore(raw: string | null | undefined): boolean {
  return !parseSessionsStore(raw).valid;
}

/** Read the live sessions array from a raw localStorage string. Returns [] when
 * missing/corrupt (including parseable non-arrays such as `{}`), so callers never
 * treat a non-array as AISession[]. */
export function readLiveSessionsArray(raw: string | null | undefined): AISession[] {
  return parseSessionsStore(raw).sessions;
}

/**
 * Parse a backup payload into sessions. Returns null when the payload is
 * corrupt or malformed (ignored gracefully); also drops entries without a
 * usable required fields. Backup generations are written by the same serializer as the
 * live store, so entries are expected to be full AISession objects.
 */

export function parseBackupSessions(json: string | null | undefined): AISession[] | null {
  if (typeof json !== 'string' || json === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const sessions = parsed.filter(
    (entry): entry is AISession => (
      typeof entry === 'object' && entry !== null
      && typeof (entry as AISession).id === 'string'
      && typeof (entry as AISession).title === 'string'
      && typeof (entry as AISession).agentId === 'string'
      && typeof (entry as AISession).scope === 'object'
      && (entry as AISession).scope !== null
      && typeof (entry as AISession).scope.type === 'string'
      && Array.isArray((entry as AISession).messages)
      && (entry as AISession).messages.every(message => (
        typeof message === 'object' && message !== null
        && typeof message.id === 'string'
        && typeof message.role === 'string'
        && typeof message.content === 'string'
        && typeof message.timestamp === 'number'
        && Number.isFinite(message.timestamp)
      ))
      && typeof (entry as AISession).updatedAt === 'number'
      && Number.isFinite((entry as AISession).updatedAt)
    ),
  );
  return sessions.length > 0 ? sessions : null;
}

/**
 * Decide whether to restore on boot: only when the live store is missing or corrupt AND
 * the backup actually contains at least one session.
 */
export function shouldRestoreFromBackup(
  liveRaw: string | null | undefined,
  backupJson: string | null | undefined,
): boolean {
  if (!isMissingOrCorruptSessionsStore(liveRaw)) return false;
  const sessions = parseBackupSessions(backupJson);
  return sessions != null && sessions.length > 0;
}

/**
 * Merge an imported backup into the current store: entries are keyed by id
 * and the newer `updatedAt` wins. Explicit user action, so it may overwrite
 * the live store (unlike the boot restore, which is empty-only).
 */
export function mergeImportedSessions(current: AISession[], imported: AISession[]): AISession[] {
  const byId = new Map<string, AISession>();
  for (const session of current) byId.set(session.id, session);
  for (const session of imported) {
    const existing = byId.get(session.id);
    if (!existing || (session.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
      byId.set(session.id, session);
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Debounced mirror scheduler. One rolling timer per process: the last
 * mutation batch wins, and the write happens `debounceMs` after the batch
 * settles (at most once per batch, per the durability spec).
 *
 * 载荷按引用保存，序列化推迟到真正写出时（见 `writeSessionsBackupGeneration`）：
 * 流式回复期间每 500ms 一次的存储写入只替换引用，不再每次把整库转成 JSON。
 * 调用方必须传入不可变的会话数组（React 状态本身即如此）。
 */
export class DebouncedBackupMirror<T = string> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { payload: T } | null = null;

  constructor(
    private readonly write: (payload: T) => void,
    private readonly debounceMs: number = AI_SESSIONS_BACKUP_DEBOUNCE_MS,
  ) {}

  schedule(payload: T) {
    this.pending = { payload };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writePending();
    }, this.debounceMs);
  }

  flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writePending();
  }

  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private writePending() {
    const pending = this.pending;
    this.pending = null;
    if (pending) this.write(pending.payload);
  }
}

let backupGenerationCounter = 0;

function nextBackupGenerationId(): string {
  backupGenerationCounter = (backupGenerationCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${backupGenerationCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把会话数组写成一代磁盘备份，文件内容与 `JSON.stringify(sessions)` 完全一致。
 *
 * 桥支持分块接口时，逐个会话序列化并按 `chunkChars` 聚合成块发送：渲染进程峰值
 * 只有一块加一个会话的字符串，单条 IPC 也远低于主进程 64 MB 上限，因此超过
 * 64 MB 的主机归档仍能得到备份。所有 IPC 同步依次发出、不等待结果，主进程按
 * 到达顺序串行处理，beforeunload 时调用也能完整送达。旧桥（只有 `write`）退回
 * 整库一次写入。返回 false 表示没有可用的写入接口。
 */
export function writeSessionsBackupGeneration(
  bridge: AiSessionsBackupBridge | undefined,
  sessions: readonly AISession[],
  chunkChars: number = AI_SESSIONS_BACKUP_CHUNK_CHARS,
): boolean {
  if (!bridge) return false;
  const swallow = (promise: Promise<unknown> | undefined) => { void promise?.catch(() => {}); };
  if (
    bridge.aiSessionsBackupWriteBegin
    && bridge.aiSessionsBackupWriteChunk
    && bridge.aiSessionsBackupWriteCommit
  ) {
    const id = nextBackupGenerationId();
    swallow(bridge.aiSessionsBackupWriteBegin({ id }));
    try {
      let chunk = '[';
      for (let index = 0; index < sessions.length; index += 1) {
        const part = (index === 0 ? '' : ',') + JSON.stringify(sessions[index]);
        if (chunk.length > 0 && chunk.length + part.length > chunkChars) {
          swallow(bridge.aiSessionsBackupWriteChunk({ id, chunk }));
          chunk = '';
        }
        chunk += part;
      }
      chunk += ']';
      swallow(bridge.aiSessionsBackupWriteChunk({ id, chunk }));
    } catch (error) {
      swallow(bridge.aiSessionsBackupWriteAbort?.({ id }));
      throw error;
    }
    swallow(bridge.aiSessionsBackupWriteCommit({ id }));
    return true;
  }
  if (!bridge.aiSessionsBackupWrite) return false;
  swallow(bridge.aiSessionsBackupWrite({ json: JSON.stringify(sessions) }));
  return true;
}
