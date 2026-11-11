/**
 * AI Sessions Backup Bridge - durable disk mirror of the renderer's AI chat
 * session store (`netcatty_ai_sessions_v1` in localStorage).
 *
 * localStorage lives inside the Electron profile directory, so reinstalling,
 * moving or recreating the app takes the chat history with it, and in-app
 * cleanup sweeps / cap eviction can also shrink the live store. This bridge
 * keeps timestamped JSON generations under
 * `{userData}/ai-sessions-backup/` so the newest store can be restored on
 * boot when the live store is missing or empty (never on top of a non-empty
 * store — see useAIState).
 *
 * Generations are capped (default 5) and each write is atomic
 * (temp file + rename). All handlers never throw: a backup failure must not
 * break chat persistence.
 *
 * 大型归档通过 writeBegin / writeChunk / writeCommit 分块写入同一代文件，
 * 单条 IPC 不超过 64 MB；旧的单次 write 接口保留作兼容。
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const gzipAsync = promisify(zlib.gzip);

let backupDir = null;
let electronDialog = null;

const BACKUP_DIR_NAME = "ai-sessions-backup";
const FILE_PREFIX = "ai-sessions-";
const EXPORT_PREFIX = "export-";
const FILE_SUFFIX = ".json";
/**
 * 分块写入的代以 gzip 压缩保存（每块一个 gzip 成员，拼接后仍是合法 gzip 流）。
 * 备份最多保留 MAX_GENERATIONS 份完整副本，压缩可显著降低大型归档的磁盘占用；
 * 压缩在 libuv 线程池中进行，不阻塞主进程事件循环。导入/导出文件仍是明文 JSON。
 */
const GZIP_SUFFIX = ".json.gz";
/** Keep at most this many rolling generations (plus dated export files). */
const MAX_GENERATIONS = 5;
/**
 * Hard cap for a mirrored payload. localStorage itself targets ~2 MB, but when
 * cloud AI-session sync is enabled the renderer persists the full unpruned
 * history for the disk mirror — that can exceed 4 MB. Keep a generous disk
 * ceiling so synced histories still get rolling backups, while still rejecting
 * runaway payloads.
 */
const MAX_BACKUP_JSON_BYTES = 64 * 1024 * 1024;
/**
 * 分块写入的单代总上限。绑定已保存主机的会话是不淘汰的完整归档，整库可能超过
 * 单条 IPC 的 64 MB 上限，因此渲染进程按块发送、主进程追加到临时文件后原子改名。
 * 读取时整代需要作为一个字符串解析（V8 字符串上限约 512 MiB），所以总上限留在
 * 其下方；超过时放弃本代并保留旧代，不会写出无法恢复的文件。
 */
const MAX_BACKUP_GENERATION_BYTES = 500 * 1024 * 1024;
/** 渲染进程崩溃等原因遗留的未提交分块代，超过该时长后在下一次开始时清理。 */
const STALE_CHUNKED_GENERATION_MS = 10 * 60 * 1000;
const CHUNKED_GENERATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The automatic mirror recovers from in-profile localStorage loss or corruption
 * (quota, empty or corrupt JSON, or accidental clear). Profile deletion or
 * recreation is out of scope; use the manual export/import buttons for that.
 */
function ensureBackupDir() {
  if (backupDir) return backupDir;
  try {
    let userDataPath = null;
    try {
      const { app } = require("electron");
      userDataPath = app?.getPath?.("userData") ?? null;
    } catch {
      userDataPath = null;
    }
    if (!userDataPath) return null;
    backupDir = path.join(userDataPath, BACKUP_DIR_NAME);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
  } catch {
    return null;
  }
}

function isGenerationFileName(file) {
  return file.endsWith(FILE_SUFFIX) || file.endsWith(GZIP_SUFFIX);
}

function readGenerationJson(filePath) {
  const raw = fs.readFileSync(filePath);
  return (filePath.endsWith(GZIP_SUFFIX) ? zlib.gunzipSync(raw) : raw).toString("utf-8");
}

function listGenerationFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.startsWith(FILE_PREFIX) && isGenerationFileName(file))
      .sort()
      .reverse(); // timestamped names sort lexicographically newest-first
  } catch {
    return [];
  }
}

function listExportFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.startsWith(EXPORT_PREFIX) && file.endsWith(FILE_SUFFIX))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function timestampToken(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(".", "-")}`;
}

let writeQueue = Promise.resolve();

/**
 * Write one generation atomically (temp + rename) and prune older ones.
 * Resolves { ok, file } and never rejects. Writes are serialized and use
 * fs.promises: the history can be several MB and is written on every
 * debounced chat change, which used to block the main thread (all windows).
 */
function writeGeneration(json) {
  return queueBackupOperation(() => writeGenerationNow(json));
}

async function writeGenerationNow(json) {
  const dir = ensureBackupDir();
  if (!dir) return { ok: false, error: "no-backup-dir" };
  if (typeof json !== "string" || json.length === 0) {
    return { ok: false, error: "invalid-json" };
  }
  if (Buffer.byteLength(json, "utf-8") > MAX_BACKUP_JSON_BYTES) {
    return { ok: false, error: "payload-too-large" };
  }

  const file = `${FILE_PREFIX}${timestampToken()}${FILE_SUFFIX}`;
  const filePath = path.join(dir, file);
  const tmpPath = `${filePath}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    return { ok: false, error: String(error) };
  }

  await pruneGenerations(dir);
  return { ok: true, file };
}

async function pruneGenerations(dir) {
  // Keep only the newest MAX_GENERATIONS generations.
  const generations = listGenerationFiles(dir);
  for (const stale of generations.slice(MAX_GENERATIONS)) {
    await fs.promises.unlink(path.join(dir, stale)).catch(() => {});
  }
}

// ── 分块写入一代备份 ──
//
// begin / chunk / commit / abort 共用 writeQueue，按 IPC 到达顺序执行；渲染进程
// 无需等待每一步的结果即可连续发送（beforeunload 时也能完整送达）。任何一步失败
// 都会把该代标记为失败，commit 时删除临时文件并返回错误，已有的旧代保持不变。

/** id -> { tmpPath, filePath, handle, bytes, failed, startedAt } */
const chunkedGenerations = new Map();

function queueBackupOperation(operation) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}

async function discardChunkedGeneration(id) {
  const entry = chunkedGenerations.get(id);
  if (!entry) return;
  chunkedGenerations.delete(id);
  await entry.handle?.close().catch(() => {});
  await fs.promises.unlink(entry.tmpPath).catch(() => {});
}

function isValidGenerationId(id) {
  return typeof id === "string" && CHUNKED_GENERATION_ID_RE.test(id);
}

function beginChunkedGeneration(id, now = Date.now()) {
  return queueBackupOperation(async () => {
    if (!isValidGenerationId(id)) return { ok: false, error: "invalid-id" };
    const dir = ensureBackupDir();
    if (!dir) return { ok: false, error: "no-backup-dir" };
    for (const [pendingId, entry] of chunkedGenerations) {
      if (pendingId === id || now - entry.startedAt > STALE_CHUNKED_GENERATION_MS) {
        await discardChunkedGeneration(pendingId);
      }
    }
    const file = `${FILE_PREFIX}${timestampToken(new Date(now))}${GZIP_SUFFIX}`;
    const filePath = path.join(dir, file);
    const tmpPath = `${filePath}.${id}.tmp`;
    try {
      const handle = await fs.promises.open(tmpPath, "w");
      chunkedGenerations.set(id, { tmpPath, filePath, file, handle, bytes: 0, failed: null, startedAt: now });
      return { ok: true };
    } catch (error) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      return { ok: false, error: String(error) };
    }
  });
}

function appendChunkedGeneration(id, chunk) {
  return queueBackupOperation(async () => {
    const entry = isValidGenerationId(id) ? chunkedGenerations.get(id) : undefined;
    if (!entry) return { ok: false, error: "unknown-generation" };
    if (entry.failed) return { ok: false, error: entry.failed };
    if (typeof chunk !== "string" || chunk.length === 0) {
      entry.failed = "invalid-chunk";
      return { ok: false, error: entry.failed };
    }
    const bytes = Buffer.byteLength(chunk, "utf-8");
    if (bytes > MAX_BACKUP_JSON_BYTES || entry.bytes + bytes > MAX_BACKUP_GENERATION_BYTES) {
      entry.failed = "payload-too-large";
      return { ok: false, error: entry.failed };
    }
    try {
      // 上限按未压缩字节计算：恢复时需要把整代解压成一个字符串。
      // writeFile 会循环写完整个缓冲区（从当前位置追加），不会出现部分写入。
      await entry.handle.writeFile(await gzipAsync(chunk));
      entry.bytes += bytes;
      return { ok: true };
    } catch (error) {
      entry.failed = String(error);
      return { ok: false, error: entry.failed };
    }
  });
}

function commitChunkedGeneration(id) {
  return queueBackupOperation(async () => {
    const entry = isValidGenerationId(id) ? chunkedGenerations.get(id) : undefined;
    if (!entry) return { ok: false, error: "unknown-generation" };
    if (entry.failed || entry.bytes === 0) {
      const error = entry.failed ?? "invalid-json";
      await discardChunkedGeneration(id);
      return { ok: false, error };
    }
    chunkedGenerations.delete(id);
    try {
      await entry.handle.close();
      await fs.promises.rename(entry.tmpPath, entry.filePath);
    } catch (error) {
      await fs.promises.unlink(entry.tmpPath).catch(() => {});
      return { ok: false, error: String(error) };
    }
    const dir = ensureBackupDir();
    if (dir) await pruneGenerations(dir);
    return { ok: true, file: entry.file };
  });
}

function abortChunkedGeneration(id) {
  return queueBackupOperation(async () => {
    if (isValidGenerationId(id)) await discardChunkedGeneration(id);
    return { ok: true };
  });
}

/**
 * Read the newest usable session array. Invalid generations are skipped and
 * older ones are tried, so one bad write never blocks a restore.
 */
function readLatestGeneration() {
  const dir = ensureBackupDir();
  if (!dir) return { ok: false };
  for (const file of listGenerationFiles(dir)) {
    try {
      const json = readGenerationJson(path.join(dir, file));
      const parsed = JSON.parse(json);
      // Structurally unusable payloads can fall back to an older session array.
      if (!Array.isArray(parsed)) continue;
      // An empty array is an intentional wipe and must not resurrect older chats.
      if (parsed.length === 0) return { ok: true, json, file };
      if (!parsed.some((entry) => (
        entry !== null && typeof entry === "object"
        && typeof entry.id === "string"
        && typeof entry.title === "string"
        && typeof entry.agentId === "string"
        && entry.scope !== null && typeof entry.scope === "object"
        && typeof entry.scope.type === "string"
        && Array.isArray(entry.messages)
        && entry.messages.every((message) => (
          message !== null && typeof message === "object"
          && typeof message.id === "string"
          && typeof message.role === "string"
          && typeof message.content === "string"
          && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ))
        && typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ))) continue;
      return { ok: true, json, file };
    } catch {
      // try the next older generation
    }
  }
  return { ok: false };
}

async function exportToFile(json) {
  const dir = ensureBackupDir();
  if (!dir) return { success: false, error: "no-backup-dir" };
  if (typeof json !== "string" || json.length === 0) {
    return { success: false, error: "invalid-json" };
  }
  try {
    let result;
    if (electronDialog?.showSaveDialog) {
      result = await electronDialog.showSaveDialog({
        defaultPath: `${EXPORT_PREFIX}${timestampToken()}${FILE_SUFFIX}`,
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
    } else {
      // Fallback when no dialog is available (tests / unusual hosts): fixed
      // path next to the rolling generations.
      return await writeExportFixed(dir, json);
    }
    await fs.promises.writeFile(result.filePath, json, "utf-8");
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function writeExportFixed(dir, json) {
  const filePath = path.join(dir, `${EXPORT_PREFIX}${timestampToken()}${FILE_SUFFIX}`);
  try {
    await fs.promises.writeFile(filePath, json, "utf-8");
    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function importFromFile() {
  try {
    if (electronDialog?.showOpenDialog) {
      const result = await electronDialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      const json = await fs.promises.readFile(result.filePaths[0], "utf-8");
      return { success: true, json };
    }
    // No dialog available: import the newest fixed-path export instead of
    // failing outright.
    const dir = ensureBackupDir();
    if (!dir) return { success: false, error: "no-backup-dir" };
    const exports = listExportFiles(dir);
    if (exports.length === 0) return { success: false, error: "no-export-file" };
    const json = await fs.promises.readFile(path.join(dir, exports[0]), "utf-8");
    return { success: true, json };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:aiSessionsBackup:write", (_event, payload) =>
    writeGeneration(payload?.json));
  ipcMain.handle("netcatty:aiSessionsBackup:writeBegin", (_event, payload) =>
    beginChunkedGeneration(payload?.id));
  ipcMain.handle("netcatty:aiSessionsBackup:writeChunk", (_event, payload) =>
    appendChunkedGeneration(payload?.id, payload?.chunk));
  ipcMain.handle("netcatty:aiSessionsBackup:writeCommit", (_event, payload) =>
    commitChunkedGeneration(payload?.id));
  ipcMain.handle("netcatty:aiSessionsBackup:writeAbort", (_event, payload) =>
    abortChunkedGeneration(payload?.id));
  ipcMain.handle("netcatty:aiSessionsBackup:readLatest", () => readLatestGeneration());
  ipcMain.handle("netcatty:aiSessionsBackup:export", (_event, payload) =>
    exportToFile(payload?.json));
  ipcMain.handle("netcatty:aiSessionsBackup:import", () => importFromFile());
}

const __internals = {
  BACKUP_DIR_NAME,
  FILE_PREFIX,
  EXPORT_PREFIX,
  GZIP_SUFFIX,
  MAX_GENERATIONS,
  MAX_BACKUP_JSON_BYTES,
  MAX_BACKUP_GENERATION_BYTES,
  STALE_CHUNKED_GENERATION_MS,
  listGenerationFiles,
  readGenerationJson,
  beginChunkedGeneration,
  appendChunkedGeneration,
  commitChunkedGeneration,
  abortChunkedGeneration,
  listExportFiles,
  timestampToken,
  writeGeneration,
  readLatestGeneration,
  writeExportFixed,
  // Tests point the bridge at a temp directory without Electron.
  _setBackupDir(dir) {
    backupDir = dir;
  },
};

module.exports = {
  init(deps) {
    electronDialog = deps?.electronModule?.dialog ?? null;
    ensureBackupDir();
  },
  registerHandlers,
  __internals,
};
