import type { Terminal as XTerm } from "@xterm/xterm";

export const MAX_WRITE_QUEUE_ITEMS = 32;
export const MAX_WRITE_QUEUE_BYTES = 512 * 1024;

type QueuedWrite = {
  bytes: number;
  steps: QueuedWriteStep[];
  nextIndex: number;
  cancelled: boolean;
};

type QueuedWriteStep = {
  bytes: number;
  write: (done: () => void) => void;
};

type TerminalWriteQueue = {
  writing: boolean;
  active?: QueuedWrite;
  pending: QueuedWrite[];
  pendingBytes: number;
  floodMode: boolean;
  onDropped?: (bytes: number) => void;
};

const terminalWriteQueues = new WeakMap<XTerm, TerminalWriteQueue>();
const terminalWriteQueueDropHandlers = new WeakMap<XTerm, (bytes: number) => void>();

const getOrCreateQueue = (term: XTerm): TerminalWriteQueue => {
  let queue = terminalWriteQueues.get(term);
  if (!queue) {
    queue = {
      writing: false,
      pending: [],
      pendingBytes: 0,
      floodMode: false,
      onDropped: terminalWriteQueueDropHandlers.get(term),
    };
    terminalWriteQueues.set(term, queue);
  }
  return queue;
};

const scheduleNextTerminalWrite = (term: XTerm, queue: TerminalWriteQueue) => {
  const next = queue.pending.shift();
  if (!next) {
    queue.writing = false;
    queue.floodMode = false;
    terminalWriteQueues.delete(term);
    return;
  }

  queue.pendingBytes -= next.bytes;
  if (queue.pendingBytes < 0) queue.pendingBytes = 0;
  queue.writing = true;
  queue.active = next;
  runQueuedWrite(next, () => {
    if (queue.active === next) {
      queue.active = undefined;
    }
    scheduleNextTerminalWrite(term, queue);
  });
};

const runQueuedWrite = (item: QueuedWrite, done: () => void): void => {
  let index = 0;
  let inCallback = false;
  let continueRequested = false;

  const runNext = (): void => {
    if (inCallback) {
      continueRequested = true;
      return;
    }

    do {
      continueRequested = false;
      if (item.cancelled) {
        done();
        return;
      }
      const step = item.steps[index];
      index += 1;
      item.nextIndex = index;
      if (!step) {
        done();
        return;
      }
      inCallback = true;
      step.write(runNext);
      inCallback = false;
    } while (continueRequested);
  };

  runNext();
};

const mergePendingWrites = (queue: TerminalWriteQueue): void => {
  if (queue.pending.length <= 1) return;

  const steps: QueuedWriteStep[] = [];
  let bytes = 0;
  for (const item of queue.pending) {
    bytes += item.bytes;
    steps.push(...item.steps.slice(item.nextIndex));
  }
  queue.pending = [{
    bytes,
    steps,
    nextIndex: 0,
    cancelled: false,
  }];
  queue.pendingBytes = bytes;
  queue.floodMode = true;
};

const updateFloodMode = (
  queue: TerminalWriteQueue,
  nextBytes: number,
): void => {
  if (
    queue.floodMode
    || queue.pending.length >= MAX_WRITE_QUEUE_ITEMS
    || queue.pendingBytes + nextBytes > MAX_WRITE_QUEUE_BYTES
  ) {
    queue.floodMode = true;
  }
};

export const setTerminalWriteQueueDropHandler = (
  term: XTerm,
  onDropped?: (bytes: number) => void,
): void => {
  if (onDropped) {
    terminalWriteQueueDropHandlers.set(term, onDropped);
  } else {
    terminalWriteQueueDropHandlers.delete(term);
  }
  const queue = terminalWriteQueues.get(term);
  if (queue && onDropped) {
    queue.onDropped = onDropped;
  }
};

export const getTerminalWriteQueueDepth = (term: XTerm): number =>
  terminalWriteQueues.get(term)?.pending.length ?? 0;

export const isTerminalWriteQueueInFloodMode = (term: XTerm): boolean =>
  terminalWriteQueues.get(term)?.floodMode ?? false;

export const enqueueTerminalWrite = (
  term: XTerm,
  bytes: number,
  write: (done: () => void) => void,
  options: { onDropped?: (bytes: number) => void } = {},
): void => {
  const queue = getOrCreateQueue(term);
  if (options.onDropped) {
    queue.onDropped = options.onDropped;
  } else if (!queue.onDropped) {
    queue.onDropped = terminalWriteQueueDropHandlers.get(term);
  }

  updateFloodMode(queue, bytes);

  queue.pending.push({
    bytes,
    steps: [{ bytes, write }],
    nextIndex: 0,
    cancelled: false,
  });
  queue.pendingBytes += bytes;
  if (
    queue.floodMode
    || queue.pending.length >= MAX_WRITE_QUEUE_ITEMS
    || queue.pendingBytes > MAX_WRITE_QUEUE_BYTES
  ) {
    mergePendingWrites(queue);
  }

  if (!queue.writing) {
    scheduleNextTerminalWrite(term, queue);
  }
};

/** Drop queued output frames without writing them to xterm. */
export const abortTerminalWriteQueue = (
  term: XTerm,
  onDropped?: (bytes: number) => void,
): void => {
  const queue = terminalWriteQueues.get(term);
  if (!queue) return;

  let droppedBytes = queue.pendingBytes;
  if (queue.active) {
    queue.active.cancelled = true;
    droppedBytes += queue.active.steps
      .slice(queue.active.nextIndex)
      .reduce((sum, step) => sum + step.bytes, 0);
  }

  queue.pending = [];
  queue.pendingBytes = 0;
  queue.writing = false;
  queue.floodMode = false;
  queue.active = undefined;
  terminalWriteQueues.delete(term);

  if (droppedBytes > 0) {
    (onDropped ?? queue.onDropped)?.(droppedBytes);
  }
};
