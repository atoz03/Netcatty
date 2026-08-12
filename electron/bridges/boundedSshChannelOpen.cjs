"use strict";

const { invalidateSshTransport } = require("./sshTransportInvalidation.cjs");

const DEFAULT_SSH_CHANNEL_OPEN_TIMEOUT_MS = 30_000;
const DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_RETRIES = 3;
const DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_BACKOFF_MS = 150;

function closeLateChannel(channel) {
  if (!channel || typeof channel === "number") return;
  try { channel.once?.("error", () => {}); } catch { /* ignore */ }
  try { channel.close?.(); } catch { /* ignore */ }
  try { channel.end?.(); } catch { /* ignore */ }
  try { channel.destroy?.(); } catch { /* ignore */ }
}

function channelAbortError(signal, label) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error(`${label} was cancelled`);
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

/**
 * Bastion / jump hosts sometimes reject rapid session channel opens with a
 * distinctive rate-limit message. The common Chinese bastion typo "offen"
 * (for "often") is part of the real wire text we see in the field.
 */
function isSshChannelOpenRateLimitedError(error) {
  const message = String(error?.message || error || "");
  return /channelOpen\s+too\s+offen\b/i.test(message)
    || /channelOpen\s+too\s+often\b/i.test(message);
}

function sleep(ms, sleepFn = null) {
  if (typeof sleepFn === "function") return Promise.resolve(sleepFn(ms));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBoundedSshChannel(sshClient, invoke, options = {}) {
  const label = String(options.label || "SSH channel open");
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs) || DEFAULT_SSH_CHANNEL_OPEN_TIMEOUT_MS,
  );
  const signal = options.signal || null;
  const closeLateResult = options.closeLateResult || closeLateChannel;
  const timeoutCode = options.timeoutCode || "SSH_CHANNEL_OPEN_TIMEOUT";
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeoutFn(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, result, { invalidate = false } = {}) => {
      if (settled) {
        if (result) closeLateResult(result);
        return false;
      }
      settled = true;
      cleanup();
      if (error && result) closeLateResult(result);
      if (invalidate) invalidateSshTransport(sshClient);
      if (error) reject(error);
      else resolve(result);
      return true;
    };
    const onAbort = () => finish(channelAbortError(signal, label), null, { invalidate: true });

    if (signal?.aborted) {
      finish(channelAbortError(signal, label));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // This is a correctness deadline, not background housekeeping. It must
    // remain referenced until the channel open settles; cleanup clears it on
    // every success, error, abort, and synchronous-throw path.
    timer = setTimeoutFn(() => {
      const error = new Error(`${label} timed out after ${timeoutMs} ms`);
      error.code = timeoutCode;
      finish(error, null, { invalidate: true });
    }, timeoutMs);

    try {
      invoke((error, result) => finish(error, result));
    } catch (error) {
      finish(error);
    }
  });
}

async function openBoundedSshShell(sshClient, windowOptions, shellOptions, options = {}) {
  const rateLimitRetries = Math.max(
    0,
    Number.isFinite(options.rateLimitRetries)
      ? Number(options.rateLimitRetries)
      : DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_RETRIES,
  );
  const rateLimitBackoffMs = Math.max(
    1,
    Number(options.rateLimitBackoffMs) || DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_BACKOFF_MS,
  );
  const sleepFn = options.sleepFn || null;
  let attempt = 0;

  for (;;) {
    try {
      return await openBoundedSshChannel(
        sshClient,
        (callback) => sshClient.shell(windowOptions, shellOptions, callback),
        {
          ...options,
          label: options.label || "SSH shell channel open",
          timeoutCode: "SSH_SHELL_OPEN_TIMEOUT",
        },
      );
    } catch (error) {
      if (
        attempt >= rateLimitRetries
        || !isSshChannelOpenRateLimitedError(error)
        || options.signal?.aborted
      ) {
        throw error;
      }
      attempt += 1;
      await sleep(rateLimitBackoffMs * attempt, sleepFn);
    }
  }
}

function openBoundedForwardOut(
  sshClient,
  sourceAddress,
  sourcePort,
  targetAddress,
  targetPort,
  options = {},
) {
  return openBoundedSshChannel(
    sshClient,
    (callback) => sshClient.forwardOut(
      sourceAddress,
      sourcePort,
      targetAddress,
      targetPort,
      callback,
    ),
    {
      ...options,
      label: options.label || "SSH forwardOut channel open",
      timeoutCode: "SSH_FORWARD_OUT_TIMEOUT",
    },
  );
}

function openBoundedForwardIn(sshClient, bindAddress, bindPort, options = {}) {
  return openBoundedSshChannel(
    sshClient,
    (callback) => sshClient.forwardIn(bindAddress, bindPort, callback),
    {
      ...options,
      label: options.label || "SSH forwardIn request",
      timeoutCode: "SSH_FORWARD_IN_TIMEOUT",
      closeLateResult: () => {},
    },
  );
}

function deliverChannelOpenCallback(promise, callback) {
  void promise.then(
    (result) => callback(null, result),
    (error) => callback(error),
  );
}

function openBoundedSshShellCallback(
  sshClient,
  windowOptions,
  shellOptions,
  callback,
  options = {},
) {
  deliverChannelOpenCallback(
    openBoundedSshShell(sshClient, windowOptions, shellOptions, options),
    callback,
  );
}

function openBoundedForwardOutCallback(
  sshClient,
  sourceAddress,
  sourcePort,
  targetAddress,
  targetPort,
  callback,
  options = {},
) {
  deliverChannelOpenCallback(
    openBoundedForwardOut(
      sshClient,
      sourceAddress,
      sourcePort,
      targetAddress,
      targetPort,
      options,
    ),
    callback,
  );
}

function openBoundedForwardInCallback(
  sshClient,
  bindAddress,
  bindPort,
  callback,
  options = {},
) {
  deliverChannelOpenCallback(
    openBoundedForwardIn(sshClient, bindAddress, bindPort, options),
    callback,
  );
}

module.exports = {
  DEFAULT_SSH_CHANNEL_OPEN_TIMEOUT_MS,
  DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_RETRIES,
  DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_BACKOFF_MS,
  closeLateChannel,
  isSshChannelOpenRateLimitedError,
  openBoundedSshChannel,
  openBoundedSshShell,
  openBoundedSshShellCallback,
  openBoundedForwardOut,
  openBoundedForwardOutCallback,
  openBoundedForwardIn,
  openBoundedForwardInCallback,
};
