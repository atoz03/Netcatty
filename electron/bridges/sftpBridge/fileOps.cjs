/* eslint-disable no-undef */
const { executeBoundedSshCommand } = require("../boundedSshExec.cjs");
const MAX_IN_MEMORY_SFTP_READ_BYTES = 10 * 1024 * 1024;
const DEFAULT_IN_MEMORY_SFTP_READ_TIMEOUT_MS = 30_000;

function createSftpReadLimitError(size) {
  const error = new Error(
    `Remote file is too large to read into memory (${size} bytes; maximum 10 MB). `
    + "Use SFTP download for large files, or open it with an external app.",
  );
  error.code = "SFTP_READ_TOO_LARGE";
  error.maxBytes = MAX_IN_MEMORY_SFTP_READ_BYTES;
  error.actualBytes = size;
  return error;
}

function assertSftpReadSize(size) {
  const value = Number(size);
  if (Number.isFinite(value) && value > MAX_IN_MEMORY_SFTP_READ_BYTES) {
    throw createSftpReadLimitError(value);
  }
}

function createSftpReadTimeoutError(timeoutMs) {
  const error = new Error(`SFTP in-memory read timed out after ${timeoutMs} ms`);
  error.code = "SFTP_READ_TIMEOUT";
  return error;
}

async function runBoundedSftpMemoryRead(payload, operation) {
  const requestedTimeout = Number(payload?.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : DEFAULT_IN_MEMORY_SFTP_READ_TIMEOUT_MS;
  const controller = new AbortController();
  const parentSignal = payload?.abortSignal || null;
  const abortFromParent = () => {
    const reason = parentSignal?.reason instanceof Error
      ? parentSignal.reason
      : new Error("SFTP read cancelled");
    controller.abort(reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener?.("abort", abortFromParent, { once: true });

  let rejectOnAbort;
  const aborted = new Promise((_, reject) => { rejectOnAbort = reject; });
  const onAbort = () => rejectOnAbort(controller.signal.reason || new Error("SFTP read cancelled"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(createSftpReadTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
  }
}

function readSftpStreamIntoBuffer(stream, signal = null) {
  if (!stream || typeof stream.on !== "function") {
    throw new Error("SFTP streaming read is unavailable. Use SFTP download instead.");
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const stopStream = () => {
      try { stream.destroy?.(); } catch { /* ignore */ }
      try { stream.close?.(); } catch { /* ignore */ }
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextTotal = totalBytes + buffer.length;
      if (nextTotal > MAX_IN_MEMORY_SFTP_READ_BYTES) {
        finish(createSftpReadLimitError(nextTotal));
        stopStream();
        return;
      }
      chunks.push(buffer);
      totalBytes = nextTotal;
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, totalBytes));
    const onError = (error) => finish(error);
    const onClose = () => {
      if (!settled) finish(new Error("SFTP read stream closed before the file was complete"));
    };
    const onAbort = () => {
      const reason = signal?.reason instanceof Error ? signal.reason : new Error("SFTP read cancelled");
      finish(reason);
      stopStream();
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function createFileOpsApi(ctx) {
  with (ctx) {
    const {
      getScpBackendForClient,
      isScpModeClient,
      abortScpClientStreams,
    } = require("./scpBackend.cjs");

    async function listSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");

      if (isScpModeClient(client)) {
        const backend = getScpBackendForClient(client);
        const basePath = payload.path || ".";
        const requestedEncoding = normalizeEncoding(payload.encoding);
        let encoding = resolveEncodingForRequest(payload.sftpId, requestedEncoding);
        if (requestedEncoding === "auto") {
          // Detect from raw basename bytes (base64 field) before final decode.
          // Only upgrade to gb18030 on positive non-UTF-8 evidence; never demote
          // a previously resolved gb18030 session when a dir is ASCII-only.
          try {
            // Use tracked backend exec path (getScpBackendForClient wraps exec) so
            // closeSftp can abort a hung auto-detect probe on shared sessions.
            const tracked = getScpBackendForClient(client);
            const { buildListCommand, parseListRecords } = require("./scpShell.cjs");
            // Access list via a private-ish path: run list with utf-8 first internally
            // by exec through backend's run path — use list then re-detect from raw is heavy;
            // call shell builders via client-tracked adapter stored on backend deps.
            const adapters = client.__netcattyScpTrackedExec
              ? { exec: client.__netcattyScpTrackedExec }
              : require("./scpBackend.cjs").createSshExecAdapters(client.client);
            const raw = await adapters.exec(buildListCommand(basePath, "utf-8"), {
              signal: payload?.abortSignal || null,
            });
            if (raw.code === 0 && raw.stdout) {
              let needsGb = false;
              let parsedAny = false;
              for (const line of String(raw.stdout).split(/\r?\n/)) {
                if (!line) continue;
                const parts = line.split("|");
                if (parts.length < 5) continue;
                if (parts[4]) parsedAny = true;
                try {
                  // eslint-disable-next-line no-new
                  new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[4], "base64"));
                } catch {
                  needsGb = true;
                  break;
                }
              }
              // Empty basenames (no base64/openssl on remote) → fall through to backend.list
              // which can use the ls -la fallback path.
              if (!parsedAny && String(raw.stdout).trim()) {
                throw new Error("list probe produced no parseable basenames");
              }
              if (needsGb) {
                encoding = updateResolvedEncoding(payload.sftpId, "auto", "gb18030");
              } else if (encoding !== "gb18030") {
                encoding = updateResolvedEncoding(payload.sftpId, "auto", "utf-8");
              }
              // Reuse the probe listing instead of listing the directory twice.
              const listEnc = needsGb ? "gb18030" : (encoding === "gb18030" ? "gb18030" : "utf-8");
              const records = parseListRecords(raw.stdout, listEnc);
              const entries = [];
              for (const rec of records) {
                const entry = {
                  name: rec.name,
                  type: rec.type,
                  linkTarget: rec.type === "symlink" ? "file" : null,
                  size: `${rec.size || 0} bytes`,
                  lastModified: new Date(rec.modifyTime || Date.now()).toISOString(),
                  permissions: rec.permissions,
                };
                if (rec.type === "symlink") {
                  try {
                    const full = `${String(basePath).replace(/\/+$/, "")}/${rec.name}`.replace(/\/+/g, "/") || rec.name;
                    const trackedExec = client.__netcattyScpTrackedExec
                      || require("./scpBackend.cjs").createSshExecAdapters(client.client).exec;
                    const { shellQuotePath } = require("./scpShell.cjs");
                    const probe = await trackedExec(
                      `p=${shellQuotePath(full, listEnc)}; if [ -d "$p" ]; then echo directory; else echo file; fi`,
                      { signal: payload?.abortSignal || null },
                    );
                    entry.linkTarget = (probe.stdout || "").includes("directory") ? "directory" : "file";
                  } catch {
                    entry.linkTarget = null;
                  }
                }
                entries.push(entry);
              }
              return entries;
            }
          } catch {
            // Keep previously resolved encoding (e.g. gb18030); do not demote on probe failure.
            if (encoding === "auto") {
              encoding = "utf-8";
            }
          }
        }
        return await backend.list(basePath, {
          encoding: encoding === "auto" ? "utf-8" : encoding,
          signal: payload?.abortSignal || null,
        });
      }
    
      const requestedEncoding = normalizeEncoding(payload.encoding);
      const basePath = payload.path || ".";
      const pathEncoding = resolveEncodingForRequest(payload.sftpId, requestedEncoding);
      const encodedPath = encodePath(basePath, pathEncoding);
    
      const sftp = await requireSftpChannel(client);
    
      let list;
      try {
        list = await new Promise((resolve, reject) => {
          sftp.readdir(encodedPath, (err, items) => {
            if (err) return reject(err);
            resolve(items || []);
          });
        });
      } catch (err) {
        // Retry with string path when ASCII-only and a Buffer path caused issues
        if (Buffer.isBuffer(encodedPath) && isAsciiString(basePath)) {
          console.warn("[SFTP] Retrying readdir with string path after Buffer failure", {
            basePath,
            error: err?.message || String(err),
          });
          list = await new Promise((resolve, reject) => {
            sftp.readdir(basePath, (retryErr, items) => {
              if (retryErr) return reject(retryErr);
              resolve(items || []);
            });
          });
        } else {
          throw err;
        }
      }
    
      // When auto mode, try to detect encoding from list
      // If detection returns null (empty list or can't prove non-UTF-8), preserve the previous encoding
      let detectedEncoding;
      if (requestedEncoding === "auto") {
        const detected = detectEncodingFromList(list);
        if (detected) {
          // Definitive detection (e.g., found GB18030 bytes)
          detectedEncoding = detected;
        } else {
          // Can't detect - preserve existing session encoding
          const existing = sftpEncodingState.get(payload.sftpId);
          detectedEncoding = existing?.resolved || "utf-8";
        }
      } else {
        detectedEncoding = requestedEncoding;
      }
      const resolvedEncoding = updateResolvedEncoding(payload.sftpId, requestedEncoding, detectedEncoding);
    
      // Process items and resolve symlinks
      const results = await Promise.all(list.map(async (item) => {
        const filenameRaw = item.filenameRaw || (item.filename ? Buffer.from(item.filename, "utf8") : null);
        const longnameRaw = item.longnameRaw || (item.longname ? Buffer.from(item.longname, "utf8") : null);
        const name = decodeName(filenameRaw, resolvedEncoding) || item.filename || "";
        const longname = decodeName(longnameRaw, resolvedEncoding) || item.longname || "";
    
        let type;
        let linkTarget = null;
    
        if (item.attrs?.isDirectory?.()) {
          type = "directory";
        } else if (item.attrs?.isSymbolicLink?.()) {
          // This is a symlink - try to resolve its target type
          type = "symlink";
          try {
            // Use path.posix.join to properly construct the path and avoid double slashes
            const fullPath = path.posix.join(basePath === "." ? "/" : basePath, name);
            const encodedFullPath = encodePath(fullPath, resolvedEncoding);
            const stat = await client.stat(encodedFullPath);
            // stat follows symlinks, so we get the target's type
            if (stat.isDirectory) {
              linkTarget = "directory";
            } else {
              linkTarget = "file";
            }
          } catch (err) {
            // If we can't stat the symlink target (broken link), keep it as symlink
            console.warn(`Could not resolve symlink target for ${item.name}:`, err.message);
          }
        } else {
          type = "file";
        }
    
        const modeToPermissions = (mode) => {
          if (typeof mode !== "number") return undefined;
          const toTriplet = (bits) =>
            `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
          return `${toTriplet((mode >> 6) & 7)}${toTriplet((mode >> 3) & 7)}${toTriplet(mode & 7)}`;
        };
    
        // Extract permissions from longname or attrs.mode
        let permissions = undefined;
        if (longname) {
          // Fallback: parse from longname (e.g., "-rwxr-xr-x 1 root root ...")
          const match = longname.match(/^[dlsbc-]([rwxsStT-]{9})/);
          if (match) {
            permissions = match[1];
          }
        }
        if (!permissions && item.attrs?.mode) {
          permissions = modeToPermissions(item.attrs.mode);
        }
    
        const modifyTime = item.attrs?.mtime ? item.attrs.mtime * 1000 : Date.now();
        return {
          name,
          type,
          linkTarget,
          size: `${item.attrs?.size || 0} bytes`,
          lastModified: new Date(modifyTime).toISOString(),
          permissions,
        };
      }));
    
      return results;
    }

    async function realpathSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");
      const signal = payload?.abortSignal || null;
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      if (isScpModeClient(client)) {
        return getScpBackendForClient(client).realpath(payload.path || ".", { encoding, signal });
      }
      const sftp = await requireSftpChannel(client, { signal, timeoutMs: payload?.timeoutMs });
      const encodedPath = encodePath(payload.path || ".", encoding);
      return realpathAsync(sftp, encodedPath);
    }
    
    /**
     * Read file content
     */
    async function readSftp(event, payload) {
      return runBoundedSftpMemoryRead(payload, async (signal) => {
        const client = sftpClients.get(payload.sftpId);
        if (!client) throw new Error("SFTP session not found");

        if (isScpModeClient(client)) {
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        const backend = getScpBackendForClient(client);
        try {
          const attrs = await backend.stat(payload.path, {
            encoding,
            signal,
          });
          assertSftpReadSize(attrs?.size);
        } catch (error) {
          if (signal.aborted || error?.code === "SFTP_READ_TOO_LARGE") throw error;
          // Some restricted shells cannot stat even though scp -f is allowed.
          // The SCP protocol header below still enforces the limit before data.
        }
        const buffer = await backend.readFile(payload.path, {
          encoding,
          signal,
          maxBytes: MAX_IN_MEMORY_SFTP_READ_BYTES,
        });
        assertSftpReadSize(buffer?.length);
        return buffer.toString();
        }
    
      const sftp = await requireSftpChannel(client, { signal, timeoutMs: payload?.timeoutMs });
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      const encodedPath = encodePath(payload.path, encoding);
      const attrs = await statAsync(sftp, encodedPath);
      if (signal.aborted) throw signal.reason;
      assertSftpReadSize(attrs?.size);
      const stream = sftp.createReadStream?.(encodedPath);
      const buffer = await readSftpStreamIntoBuffer(stream, signal);
      return buffer.toString();
      });
    }
    
    /**
     * Read file as binary (returns ArrayBuffer for binary files like images)
     */
    async function readSftpBinary(event, payload) {
      return runBoundedSftpMemoryRead(payload, async (signal) => {
        const client = sftpClients.get(payload.sftpId);
        if (!client) throw new Error("SFTP session not found");

        if (isScpModeClient(client)) {
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        const backend = getScpBackendForClient(client);
        try {
          const attrs = await backend.stat(payload.path, {
            encoding,
            signal,
          });
          assertSftpReadSize(attrs?.size);
        } catch (error) {
          if (signal.aborted || error?.code === "SFTP_READ_TOO_LARGE") throw error;
          // See the text-read path: protocol-header enforcement is the fallback.
        }
        const buffer = await backend.readFile(payload.path, {
          encoding,
          signal,
          maxBytes: MAX_IN_MEMORY_SFTP_READ_BYTES,
        });
        assertSftpReadSize(buffer?.length);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        }
    
      const sftp = await requireSftpChannel(client, { signal, timeoutMs: payload?.timeoutMs });
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      const encodedPath = encodePath(payload.path, encoding);
      const attrs = await statAsync(sftp, encodedPath);
      if (signal.aborted) throw signal.reason;
      assertSftpReadSize(attrs?.size);
      const stream = sftp.createReadStream?.(encodedPath);
      const buffer = await readSftpStreamIntoBuffer(stream, signal);
      // Convert Node.js Buffer to ArrayBuffer
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      });
    }
    
    /**
     * Write file content.
     *
     * If the target file already exists, its mode is preserved — ssh2-sftp-client's
     * `put()` otherwise overwrites existing files with the server's default mode
     * (typically 0o666 after umask), which would silently change permissions on
     * files edited through the built-in text editor.
     */
    async function writeSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");

      // Normalize CRLF → LF so scripts edited on Windows don't break when
      // saved to a Linux/macOS host. LF is universally supported (Windows
      // 10+ notepad handles it), while CRLF in shell scripts causes
      // "command not found" and syntax errors on Linux.
      const normalized = payload.content.replace(/\r\n/g, '\n');

      if (isScpModeClient(client)) {
        const backend = getScpBackendForClient(client);
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        const scpOpts = { encoding, signal: payload?.abortSignal || null };
        let existingMode = null;
        try {
          const st = await backend.stat(payload.path, scpOpts);
          if (typeof st.mode === "number" && st.mode > 0) {
            existingMode = st.mode & 0o7777;
          }
        } catch (_err) {
          // new file
        }
        await backend.writeFile(payload.path, Buffer.from(normalized, "utf-8"), {
          mode: existingMode != null ? existingMode : 0o0644,
          ...scpOpts,
        });
        if (existingMode != null) {
          try { await backend.chmod(payload.path, existingMode, scpOpts); } catch (err) {
            console.warn(`[scp] Failed to restore permissions on ${payload.path}:`, err?.message || err);
          }
        }
        return true;
      }
    
      await requireSftpChannel(client);
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      const encodedPath = encodePath(payload.path, encoding);
    
      let existingMode = null;
      try {
        const stat = await client.stat(encodedPath);
        if (typeof stat.mode === "number") {
          // Mask with 0o7777 so special bits (setuid/setgid/sticky) are preserved too.
          existingMode = stat.mode & 0o7777;
        }
      } catch (_err) {
        // File does not exist — treat as a new file and let the server apply defaults.
      }
    
      await client.put(Buffer.from(normalized, "utf-8"), encodedPath);
    
      if (existingMode !== null) {
        try {
          await client.chmod(encodedPath, existingMode);
        } catch (err) {
          console.warn(
            `[sftp] Failed to restore permissions on ${payload.path}:`,
            err && err.message ? err.message : err,
          );
        }
      }
    
      return true;
    }
    
    /**
     * Write binary data
     */
    async function writeSftpBinary(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");

      if (isScpModeClient(client)) {
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        await getScpBackendForClient(client).writeFile(payload.path, Buffer.from(payload.content), {
          encoding,
          signal: payload?.abortSignal || null,
        });
        return true;
      }
    
      await requireSftpChannel(client);
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      const encodedPath = encodePath(payload.path, encoding);
      await client.put(Buffer.from(payload.content), encodedPath);
      return true;
    }
    
    /**
     * Close an SFTP connection.
     * Also cleans up any jump host connections and file watchers if present.
     *
     * When transfers still hold a lease on this sftpId (active or paused), the
     * close is deferred: browse-side resources are dropped but the client stays
     * in sftpClients until the last transfer releases. Pass force:true to tear
     * down immediately (used by the lease finalizer).
     */
    async function closeSftp(event, payload) {
      const sftpId = payload?.sftpId;
      const client = sftpClients.get(sftpId);
      if (!client) {
        try {
          const { sftpTransferSessionLeaseStore } = require("../sftpTransferSessionLease.cjs");
          sftpTransferSessionLeaseStore.clear(sftpId);
        } catch { /* optional in tests */ }
        return { success: true, deferred: false };
      }

      // Soft-close: panel disconnect while transfers still use this session.
      // Do NOT abort SCP streams or end the client — that would kill transfers.
      if (!payload?.force) {
        try {
          const { sftpTransferSessionLeaseStore } = require("../sftpTransferSessionLease.cjs");
          if (sftpTransferSessionLeaseStore.markSoftClosed(sftpId)) {
            try {
              fileWatcherBridge.stopWatchersForSession(sftpId, true);
            } catch (err) {
              console.warn("[SFTP] Error stopping file watchers during soft-close:", err.message);
            }
            console.log(
              `[SFTP] Soft-closed ${sftpId}; ${sftpTransferSessionLeaseStore.getLeaseCount(sftpId)} transfer lease(s) still hold it`,
            );
            return {
              success: true,
              deferred: true,
              leaseCount: sftpTransferSessionLeaseStore.getLeaseCount(sftpId),
            };
          }
          // No transfer currently holds the client. Commit the close before
          // the first async teardown step so a new transfer cannot borrow a
          // client whose end() is already in progress.
          const closeToken = sftpTransferSessionLeaseStore.beginHardClose(sftpId);
          if (!sftpTransferSessionLeaseStore.commitHardClose(sftpId, closeToken)) {
            if (sftpTransferSessionLeaseStore.isHeld(sftpId)) {
              sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
              return {
                success: true,
                deferred: true,
                leaseCount: sftpTransferSessionLeaseStore.getLeaseCount(sftpId),
              };
            }
          }
        } catch {
          // Lease module unavailable — fall through to hard close.
        }
      } else {
        // Force close is for lease finalizers. If a new transfer re-acquired
        // between shouldHardClose and now, defer instead of killing live work.
        try {
          const { sftpTransferSessionLeaseStore } = require("../sftpTransferSessionLease.cjs");
          if (sftpTransferSessionLeaseStore.isHeld(sftpId)) {
            sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
            return {
              success: true,
              deferred: true,
              leaseCount: sftpTransferSessionLeaseStore.getLeaseCount(sftpId),
            };
          }
        } catch {
          // Lease module unavailable — fall through to hard close.
        }
      }
    
      // Stop file watchers and clean up temp files for this SFTP session
      try {
        fileWatcherBridge.stopWatchersForSession(sftpId, true);
      } catch (err) {
        console.warn("[SFTP] Error stopping file watchers:", err.message);
      }
    
      try {
        if (isScpModeClient(client)) {
          // Abort in-flight scp/exec channels first so agent Stop/timeout via
          // closeSftp actually stops transfers without needing a serialized AbortSignal.
          try { abortScpClientStreams(client); } catch { /* ignore */ }
          // Only tear down SSH sockets we own (fresh dials not registered in the
          // transport registry). Session-backed and transport-managed clients
          // return a lease instead of ending the shared/parkable connection.
          const ownsSocket = !client.__netcattySessionBacked
            && !client.__netcattySourceSessionId
            && !client.__netcattyTransportManaged
            && !client.__netcattyRefHolder;
          if (ownsSocket) {
            try { client.client?.end?.(); } catch { /* ignore */ }
            try { client.client?.destroy?.(); } catch { /* ignore */ }
          }
        }
        // Re-check after any async yield before destroying the map entry.
        try {
          const { sftpTransferSessionLeaseStore } = require("../sftpTransferSessionLease.cjs");
          if (payload?.force && sftpTransferSessionLeaseStore.isHeld(sftpId)) {
            sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
            return {
              success: true,
              deferred: true,
              leaseCount: sftpTransferSessionLeaseStore.getLeaseCount(sftpId),
            };
          }
        } catch { /* optional */ }
        // Transport-managed / session-backed: close channel + return lease only.
        if (client.__netcattyRefHolder || client.__netcattyTransportManaged || client.__netcattySessionBacked) {
          try {
            if (client.sftp && typeof client.sftp.end === "function") client.sftp.end();
            else if (client.sftp && typeof client.sftp.close === "function") client.sftp.close();
          } catch { /* ignore */ }
          client.sftp = null;
          try {
            const { releaseConnectionRef } = require("../sshConnectionPool.cjs");
            if (client.__netcattyRefHolder) releaseConnectionRef(client.__netcattyRefHolder);
          } catch { /* ignore */ }
          // Session-backed end() also releases; dedicated managed clients must
          // not call ssh2-sftp-client end() (that would kill the parked transport).
          if (typeof client.end === "function" && client.__netcattySessionBacked) {
            try { await client.end(); } catch { /* ignore */ }
          }
        } else {
          await client.end();
        }
      } catch (err) {
        console.warn("SFTP close failed", err);
      }
      // Final TOCTOU guard: do not clear leases/map if someone re-acquired
      // during client.end().
      try {
        const { sftpTransferSessionLeaseStore } = require("../sftpTransferSessionLease.cjs");
        if (payload?.force && sftpTransferSessionLeaseStore.isHeld(sftpId)) {
          sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
          return {
            success: true,
            deferred: true,
            leaseCount: sftpTransferSessionLeaseStore.getLeaseCount(sftpId),
          };
        }
      } catch { /* optional */ }
      copySftpEncodingState(sftpId, payload?.encodingStateKey);
      sftpClients.delete(sftpId);
      clearSftpEncodingState(sftpId);
      try {
        const { sftpTransferSessionLeaseStore } = require("../sftpTransferSessionLease.cjs");
        sftpTransferSessionLeaseStore.clear(sftpId);
      } catch { /* optional */ }
    
      // Clean up jump connections if any
      const jumpData = jumpConnectionsMap.get(sftpId);
      if (jumpData) {
        for (const conn of jumpData.connections) {
          try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP] Cleanup error on close:', cleanupErr.message); }
        }
        jumpConnectionsMap.delete(sftpId);
        console.log(`[SFTP] Cleaned up ${jumpData.connections.length} jump connection(s) for ${sftpId}`);
      }
      return { success: true, deferred: false };
    }
    
    /**
     * Create a directory
     */
    async function mkdirSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (client && isScpModeClient(client)) {
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        await getScpBackendForClient(client).mkdir(payload.path, {
          recursive: true,
          encoding,
          signal: payload?.abortSignal || null,
        });
        return true;
      }
      await ensureRemoteDirForSession(payload.sftpId, payload.path, payload.encoding);
      return true;
    }
    
    /**
     * Delete a file or directory
     */
    async function deleteSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");

      if (isScpModeClient(client)) {
        throwIfAborted(payload?.abortSignal || null);
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        await getScpBackendForClient(client).remove(payload.path, {
          recursive: true,
          encoding,
          signal: payload?.abortSignal || null,
        });
        return true;
      }
    
      const signal = payload?.abortSignal || null;
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      if (encoding === "utf-8") {
        throwIfAborted(signal);
        const sftp = await requireSftpChannel(client, { signal, timeoutMs: payload?.timeoutMs });
        const encodedPath = encodePath(payload.path, encoding);
        const stat = statResultFromAttrs(await lstatAsync(sftp, encodedPath));
        throwIfAborted(signal);
        if (stat.isSymbolicLink) {
          await unlinkAsync(sftp, encodedPath);
        } else if (stat.isDirectory) {
          // Prefer verified shell `rm -rf` (session + dedicated SSH clients),
          // then fall back to protocol recursive walk when shell is missing or
          // when SFTP still sees the path after a shell "success".
          if (typeof removeRemoteDirectory === "function") {
            await removeRemoteDirectory(client, payload.path, encoding, signal);
          } else if (client.__netcattySessionBacked) {
            await client.rmdir(encodedPath, true, { signal });
          } else {
            const normalizedPath = await normalizeRemotePathString(client, payload.path);
            throwIfAborted(signal);
            await removeRemotePathInternal(sftp, normalizedPath, encoding, signal);
            throwIfAborted(signal);
          }
        } else {
          if (client.__netcattySessionBacked) {
            await client.delete(encodedPath, { signal });
          } else {
            throwIfAborted(signal);
            await unlinkAsync(sftp, encodedPath);
            throwIfAborted(signal);
          }
        }
        return true;
      }
    
      throwIfAborted(signal);
      // Non-UTF-8: keep protocol walk (shell path encoding is unsafe).
      const sftp = await requireSftpChannel(client, { signal, timeoutMs: payload?.timeoutMs });
      const normalizedPath = await normalizeRemotePathString(client, payload.path);
      throwIfAborted(signal);
      await removeRemotePathInternal(sftp, normalizedPath, encoding, signal);
      return true;
    }
    
    /**
     * Rename a file or directory
     */
    async function renameSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");

      if (isScpModeClient(client)) {
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        await getScpBackendForClient(client).rename(payload.oldPath, payload.newPath, {
          encoding,
          signal: payload?.abortSignal || null,
        });
        return true;
      }
    
      await requireSftpChannel(client);
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      const encodedOldPath = encodePath(payload.oldPath, encoding);
      const encodedNewPath = encodePath(payload.newPath, encoding);
      await client.rename(encodedOldPath, encodedNewPath);
      return true;
    }
    
    /**
     * Get file statistics
     */
    async function statSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");

      if (isScpModeClient(client)) {
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        const st = await getScpBackendForClient(client).stat(payload.path, {
          encoding,
          signal: payload?.abortSignal || null,
        });
        return {
          name: path.basename(payload.path),
          type: st.isDirectory ? "directory" : st.isSymbolicLink ? "symlink" : "file",
          size: st.size,
          lastModified: st.modifyTime,
          permissions: st.mode ? (st.mode & 0o777).toString(8) : st.permissions,
        };
      }
    
      await requireSftpChannel(client);
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      const encodedPath = encodePath(payload.path, encoding);
      const stat = await client.stat(encodedPath);
      return {
        name: path.basename(payload.path),
        type: stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file",
        size: stat.size,
        lastModified: stat.modifyTime,
        permissions: stat.mode ? (stat.mode & 0o777).toString(8) : undefined,
      };
    }
    
    /**
     * Change file permissions
     */
    async function chmodSftp(event, payload) {
      const client = sftpClients.get(payload.sftpId);
      if (!client) throw new Error("SFTP session not found");

      if (isScpModeClient(client)) {
        const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
        await getScpBackendForClient(client).chmod(payload.path, payload.mode, {
          encoding,
          signal: payload?.abortSignal || null,
        });
        return true;
      }
    
      await requireSftpChannel(client);
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      const encodedPath = encodePath(payload.path, encoding);
      await client.chmod(encodedPath, parseInt(payload.mode, 8));
      return true;
    }
    
    /**
     * Resolve the remote user's home directory.
     * Strategy: exec `echo ~` via SSH, fallback to SFTP realpath('.').
     */
    async function getSftpHomeDir(_event, payload) {
      const { sftpId } = payload;
      const client = sftpClients.get(sftpId);
      if (!client) return { success: false, error: "SFTP session not found" };
      const signal = payload?.abortSignal || null;
      throwIfAborted(signal);

      if (isScpModeClient(client)) {
        try {
          // Prefer payload encoding; otherwise session-resolved state from prior lists.
          const requestedEncoding = normalizeEncoding(
            payload?.encoding || sftpEncodingState.get(sftpId)?.requested || "auto",
          );
          const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
          const home = await getScpBackendForClient(client).homeDir({
            signal: payload?.abortSignal || null,
            encoding: encoding === "auto" ? "utf-8" : encoding,
            // When $HOME has GB18030 bytes and we still thought utf-8, promote session
            // encoding so subsequent list/path quotes use the right charset.
            onDetectedEncoding: (detected) => {
              if (requestedEncoding === "auto" && detected === "gb18030") {
                updateResolvedEncoding(sftpId, "auto", "gb18030");
              }
            },
          });
          return { success: true, homeDir: home };
        } catch (err) {
          return { success: false, error: err?.message || String(err) };
        }
      }
    
      // Method 1: SSH exec `echo ~` (with 5s timeout to avoid hanging on
      // hosts with blocking shell init scripts or forced commands)
      const sshClient = client.client;
      if (sshClient && typeof sshClient.exec === "function") {
        let execStream = null;
        try {
          const result = await executeBoundedSshCommand(sshClient, "echo ~", {
            signal,
            openingTimeoutMs: 5000,
            runTimeoutMs: 5000,
            maxOutputBytes: 16 * 1024,
            onStream(stream) { execStream = stream; },
          });
          throwIfAborted(signal);
          const home = result.stdout?.trim();
          if (home && home.startsWith("/")) {
            return { success: true, homeDir: home };
          }
        } catch (err) {
          // Timeout or error — kill the exec channel if still open
          try { execStream?.close?.(); } catch {}
          try { execStream?.destroy?.(); } catch {}
          if (signal?.aborted) {
            throw err;
          }
          // Fall through to SFTP realpath
        }
      }
    
      // Method 2: SFTP realpath('.') — skip if result is '/' for non-root users
      // because some SFTP servers start in '/' rather than the user's home
      try {
        const sftp = await requireSftpChannel(client, {
          signal,
          timeoutMs: payload?.timeoutMs,
        });
        throwIfAborted(signal);
        const absPath = await realpathAsync(sftp, ".");
        throwIfAborted(signal);
        if (absPath && absPath !== "/") {
          return { success: true, homeDir: absPath };
        }
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        // ignore
      }
    
      return { success: false, error: "Could not determine home directory" };
    }

    return {
      listSftp,
      realpathSftp,
      readSftp,
      readSftpBinary,
      writeSftp,
      writeSftpBinary,
      closeSftp,
      mkdirSftp,
      deleteSftp,
      renameSftp,
      statSftp,
      chmodSftp,
      getSftpHomeDir,
    };
  }
}

module.exports = { createFileOpsApi };
