"use strict";

const { invalidateSshTransport } = require("./sshTransportInvalidation.cjs");

const DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

function closeSftpChannel(channel) {
  if (!channel) return;
  try { channel.once?.("error", () => {}); } catch { /* ignore */ }
  try { channel.end?.(); } catch { /* ignore */ }
  try { channel.close?.(); } catch { /* ignore */ }
  try { channel.destroy?.(); } catch { /* ignore */ }
}

function createSftpOpenAbortError(signal) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error("SFTP channel open was aborted");
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

function openBoundedSftpChannel(sshClient, options = {}) {
  if (!sshClient || typeof sshClient.sftp !== "function") {
    return Promise.resolve(null);
  }
  const signal = options.signal || null;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs) || DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeoutFn(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, channel = null, { invalidateTransport = false } = {}) => {
      if (settled) {
        closeSftpChannel(channel);
        return false;
      }
      settled = true;
      cleanup();
      if (error && channel) closeSftpChannel(channel);
      if (invalidateTransport) invalidateSshTransport(sshClient);
      if (error) reject(error);
      else resolve(channel);
      return true;
    };
    const onAbort = () => finish(createSftpOpenAbortError(signal), null, {
      invalidateTransport: true,
    });

    if (signal?.aborted) {
      finish(createSftpOpenAbortError(signal));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // Keep the correctness deadline referenced until the open settles. An
    // unreferenced timer can let Node exit with this promise still pending.
    timer = setTimeoutFn(() => {
      const error = new Error(`SFTP channel open timed out after ${timeoutMs}ms`);
      error.code = "SFTP_CHANNEL_OPEN_TIMEOUT";
      finish(error, null, { invalidateTransport: true });
    }, timeoutMs);

    try {
      sshClient.sftp((error, channel) => {
        if (error) finish(error, channel || null);
        else finish(null, channel || null);
      });
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = {
  DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS,
  closeSftpChannel,
  openBoundedSftpChannel,
};
