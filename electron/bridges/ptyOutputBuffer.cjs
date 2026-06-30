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
 * buffered sends stay bounded even if a source emits while renderer flow is
 * paused.
 *
 * @param {(data: string) => void} sendFn delivers an accumulated batch
 * @param {{
 *   maxBufferSize?: number,
 *   shouldAcceptOutput?: () => boolean,
 *   floodFlushDelayMs?: number,
 *   maxFloodBufferSize?: number,
 *   maxPausedBufferSize?: number,
 *   onDropPausedData?: (bytes: number) => void,
 * }} [options]
 * @returns {{ bufferData: (data: string) => void, flush: () => void, takePending: () => string, discard: () => number }}
 */
function createPtyOutputBuffer(sendFn, options = {}) {
  const maxBufferSize = options.maxBufferSize ?? 16384; // 16KB
  const maxFloodBufferSize = options.maxFloodBufferSize ?? Math.max(maxBufferSize * 4, maxBufferSize);
  const maxPausedBufferSize = options.maxPausedBufferSize ?? (4 * 1024 * 1024);
  const floodFlushDelayMs = options.floodFlushDelayMs ?? 8;
  const shouldAcceptOutput = options.shouldAcceptOutput ?? (() => true);
  const onDropPausedData = options.onDropPausedData;

  let dataBuffer = "";
  const queuedBuffers = [];
  let queuedBytes = 0;
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
    if (!shouldAcceptOutput()) {
      return;
    }
    while (queuedBuffers.length > 0) {
      const queued = queuedBuffers.shift();
      queuedBytes -= queued.length;
      if (queuedBytes < 0) queuedBytes = 0;
      sendFn(queued);
    }
    if (dataBuffer.length > 0) {
      while (dataBuffer.length > maxFloodBufferSize) {
        const chunk = dataBuffer.slice(0, maxFloodBufferSize);
        dataBuffer = dataBuffer.slice(maxFloodBufferSize);
        sendFn(chunk);
      }
      if (dataBuffer.length > 0) {
        const pending = dataBuffer;
        dataBuffer = "";
        sendFn(pending);
      }
    }
  };

  const queueBuffer = (data) => {
    queuedBuffers.push(data);
    queuedBytes += data.length;
  };

  const trimPausedBuffer = () => {
    if (!Number.isFinite(maxPausedBufferSize) || maxPausedBufferSize <= 0) return;
    let pendingBytes = queuedBytes + dataBuffer.length;
    if (pendingBytes <= maxPausedBufferSize) return;

    let bytesToDrop = pendingBytes - maxPausedBufferSize;
    let dropped = 0;

    while (bytesToDrop > 0 && queuedBuffers.length > 0) {
      const head = queuedBuffers[0];
      if (head.length <= bytesToDrop) {
        queuedBuffers.shift();
        queuedBytes -= head.length;
        bytesToDrop -= head.length;
        dropped += head.length;
        continue;
      }
      queuedBuffers[0] = head.slice(bytesToDrop);
      queuedBytes -= bytesToDrop;
      dropped += bytesToDrop;
      bytesToDrop = 0;
    }

    if (bytesToDrop > 0 && dataBuffer.length > 0) {
      const dropFromDataBuffer = Math.min(bytesToDrop, dataBuffer.length);
      dataBuffer = dataBuffer.slice(dropFromDataBuffer);
      dropped += dropFromDataBuffer;
    }

    if (queuedBytes < 0) queuedBytes = 0;
    if (dropped > 0) {
      onDropPausedData?.(dropped);
    }
  };

  const appendBoundedData = (data) => {
    let remaining = data;
    while (remaining.length > 0) {
      const available = maxFloodBufferSize - dataBuffer.length;
      if (available <= 0) {
        queueBuffer(dataBuffer);
        dataBuffer = "";
        continue;
      }
      dataBuffer += remaining.slice(0, available);
      remaining = remaining.slice(available);
      if (dataBuffer.length >= maxFloodBufferSize && remaining.length > 0) {
        queueBuffer(dataBuffer);
        dataBuffer = "";
      }
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
    appendBoundedData(data);
    if (!shouldAcceptOutput()) {
      trimPausedBuffer();
      if (shouldAcceptOutput()) {
        flushNow();
      }
      return;
    }
    if (queuedBuffers.length > 0 || dataBuffer.length >= maxFloodBufferSize) {
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
    const pending = `${queuedBuffers.join("")}${dataBuffer}`;
    queuedBuffers.length = 0;
    queuedBytes = 0;
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
