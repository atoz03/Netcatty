"use strict";

/**
 * Coalescing output buffer for terminal/PTY data on its way to the renderer.
 *
 * Incoming shell data is accumulated and delivered to `sendFn` in batches to
 * keep IPC traffic down, but the batch is flushed on the *next event-loop turn*
 * (`setImmediate`) rather than after a fixed time interval. A fixed interval
 * adds that whole interval as latency to interactive echo — every keystroke
 * round-trips through the buffer and waits out the timer before it can paint.
 * Turn-based flushing coalesces only the data that has already arrived in the
 * current turn, so a single echoed keystroke is forwarded almost immediately
 * while bursts of output still collapse into one send.
 *
 * Once a burst reaches the soft cap, switch to a very short timer. That gives
 * urgent control input (Ctrl+C/close) room to run instead of letting a flood
 * repeatedly send synchronously. A larger hard cap still flushes immediately so
 * the process cannot grow the buffer without bound.
 *
 * @param {(data: string) => void} sendFn delivers an accumulated batch
 * @param {{
 *   maxBufferSize?: number,
 *   shouldAcceptOutput?: () => boolean,
 *   floodFlushDelayMs?: number,
 *   maxFloodBufferSize?: number,
 * }} [options]
 * @returns {{ bufferData: (data: string) => void, flush: () => void, takePending: () => string, discard: () => number }}
 */
function createPtyOutputBuffer(sendFn, options = {}) {
  const maxBufferSize = options.maxBufferSize ?? 16384; // 16KB
  const maxFloodBufferSize = options.maxFloodBufferSize ?? Math.max(maxBufferSize * 16, maxBufferSize);
  const floodFlushDelayMs = options.floodFlushDelayMs ?? 8;
  const shouldAcceptOutput = options.shouldAcceptOutput ?? (() => true);

  let dataBuffer = "";
  let scheduled = null;
  let scheduledType = null;

  const cancelScheduled = () => {
    if (scheduled) {
      if (scheduledType === "timeout") {
        clearTimeout(scheduled);
      } else {
        clearImmediate(scheduled);
      }
      scheduled = null;
      scheduledType = null;
    }
  };

  const flushNow = () => {
    scheduled = null;
    scheduledType = null;
    if (dataBuffer.length > 0) {
      const pending = dataBuffer;
      dataBuffer = "";
      sendFn(pending);
    }
  };

  const scheduleTurnFlush = () => {
    if (scheduled) return;
    scheduledType = "immediate";
    scheduled = setImmediate(flushNow);
  };

  const scheduleFloodFlush = () => {
    if (scheduledType === "timeout") return;
    cancelScheduled();
    scheduledType = "timeout";
    scheduled = setTimeout(flushNow, floodFlushDelayMs);
  };

  const bufferData = (data) => {
    if (!shouldAcceptOutput()) {
      return;
    }
    dataBuffer += data;
    if (dataBuffer.length >= maxFloodBufferSize) {
      cancelScheduled();
      flushNow();
    } else if (dataBuffer.length >= maxBufferSize) {
      scheduleFloodFlush();
    } else if (!scheduled) {
      scheduleTurnFlush();
    }
  };

  const flush = () => {
    cancelScheduled();
    flushNow();
  };

  const takePending = () => {
    cancelScheduled();
    const pending = dataBuffer;
    dataBuffer = "";
    return pending;
  };

  const discard = () => {
    const pending = takePending();
    return pending.length;
  };

  return { bufferData, flush, takePending, discard };
}

module.exports = { createPtyOutputBuffer };
