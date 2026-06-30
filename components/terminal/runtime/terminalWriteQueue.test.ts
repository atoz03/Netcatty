import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_WRITE_QUEUE_ITEMS,
  abortTerminalWriteQueue,
  enqueueTerminalWrite,
  getTerminalWriteQueueDepth,
  isTerminalWriteQueueInFloodMode,
  setTerminalWriteQueueDropHandler,
} from "./terminalWriteQueue.ts";

const createFakeTerm = () => ({}) as XTerm;

test("enqueueTerminalWrite serializes writes in order", () => {
  const term = createFakeTerm();
  const order: number[] = [];

  enqueueTerminalWrite(term, 1, (done) => {
    order.push(1);
    done();
  });
  enqueueTerminalWrite(term, 1, (done) => {
    order.push(2);
    done();
  });

  assert.deepEqual(order, [1, 2]);
});

test("marks flood mode and coalesces queued writes when item cap is exceeded", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { onDropped: (bytes) => dropped.push(bytes) },
    );
  }

  assert.deepEqual(dropped, []);
  assert.equal(isTerminalWriteQueueInFloodMode(term), true);
  assert.equal(getTerminalWriteQueueDepth(term), 1);
  releaseFirst?.();
  assert.deepEqual(order, Array.from({ length: MAX_WRITE_QUEUE_ITEMS + 1 }, (_, index) => index));
});

test("setTerminalWriteQueueDropHandler only reports explicit queue aborts", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  let completed = 0;
  let releaseFirst: (() => void) | null = null;

  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));
  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(term, 10, (done) => {
      completed += 1;
      done();
    });
  }

  assert.deepEqual(dropped, []);
  assert.equal(isTerminalWriteQueueInFloodMode(term), true);
  abortTerminalWriteQueue(term);
  assert.deepEqual(dropped, [MAX_WRITE_QUEUE_ITEMS * 10 + 10]);
  releaseFirst?.();
  assert.equal(completed, 0);
});

test("abortTerminalWriteQueue cancels remaining merged writes while one is in flight", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        if (index === 0) {
          abortTerminalWriteQueue(term, (bytes) => dropped.push(bytes));
        }
        done();
      },
    );
  }

  releaseFirst?.();

  assert.deepEqual(order, [0]);
  assert.deepEqual(dropped, [MAX_WRITE_QUEUE_ITEMS * 10]);
});

test("merges passive flood backlog items without dropping output", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 10; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { onDropped: (bytes) => dropped.push(bytes) },
    );
  }

  assert.equal(getTerminalWriteQueueDepth(term) < MAX_WRITE_QUEUE_ITEMS + 10, true);
  assert.deepEqual(dropped, []);
  releaseFirst?.();
  assert.deepEqual(order, Array.from({ length: MAX_WRITE_QUEUE_ITEMS + 10 }, (_, index) => index));
});

test("abortTerminalWriteQueue drops pending bytes and reports dropped count", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  let started = false;

  enqueueTerminalWrite(term, 40, () => {
    started = true;
  });
  enqueueTerminalWrite(term, 60, () => {}, { onDropped: (bytes) => dropped.push(bytes) });
  abortTerminalWriteQueue(term, (bytes) => dropped.push(bytes));

  assert.equal(started, true);
  assert.deepEqual(dropped, [60]);
});
