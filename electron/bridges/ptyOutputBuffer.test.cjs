const test = require("node:test");
const assert = require("node:assert/strict");

const { createPtyOutputBuffer } = require("./ptyOutputBuffer.cjs");

/** Resolve after one event-loop turn (immediates have run). */
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("coalesces data buffered within the same turn into a single send", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("a");
  buffer.bufferData("b");
  buffer.bufferData("c");

  // Nothing is sent synchronously while still in the same turn.
  assert.equal(sends.length, 0);

  await tick();

  assert.deepEqual(sends, ["abc"]);
});

test("flushes within a single event-loop turn (not on a fixed delay)", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("x");

  // A fixed-interval (e.g. 8ms) buffer would NOT have flushed after one
  // immediate turn. Turn-based flushing must have delivered it by now.
  await tick();

  assert.deepEqual(sends, ["x"]);
});

test("paces size-cap flushes with a short flood delay", () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, ms) => {
    const timer = { callback, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  const sends = [];
  try {
    const buffer = createPtyOutputBuffer((data) => sends.push(data), {
      maxBufferSize: 4,
      floodFlushDelayMs: 5,
    });

    buffer.bufferData("ab");
    assert.equal(sends.length, 0); // under cap, still pending

    buffer.bufferData("cd"); // now "abcd" hits the 4-byte cap

    // Flood-sized output is paced instead of synchronously spamming IPC.
    assert.deepEqual(sends, []);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 5);

    timers[0].callback();
    assert.deepEqual(sends, ["abcd"]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("hard cap still flushes synchronously when paced flood output keeps growing", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    floodFlushDelayMs: 50,
  });

  buffer.bufferData("abcd");
  assert.deepEqual(sends, []);

  buffer.bufferData("efgh");
  assert.deepEqual(sends, ["abcdefgh"]);

  await sleep(60);
  assert.deepEqual(sends, ["abcdefgh"]);
});

test("default hard cap keeps flood-sized renderer sends bounded", () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    floodFlushDelayMs: 50,
  });

  buffer.bufferData("abcd");
  buffer.bufferData("efgh");
  buffer.bufferData("ijkl");
  buffer.bufferData("mnop");

  assert.deepEqual(sends, ["abcdefghijklmnop"]);
});

test("flush() forces a synchronous send and cancels the pending turn", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("hello");
  buffer.flush();

  assert.deepEqual(sends, ["hello"]);

  await tick();
  assert.deepEqual(sends, ["hello"]); // not sent twice
});

test("flush() with an empty buffer does not send", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.flush();

  assert.equal(sends.length, 0);
});

test("discard() drops pending data and cancels the pending turn", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("tail");
  buffer.discard();

  assert.deepEqual(sends, []);
  await tick();
  assert.deepEqual(sends, []);
});

test("takePending() returns pending data without sending it", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("tail");

  assert.equal(buffer.takePending(), "tail");
  assert.deepEqual(sends, []);
  await tick();
  assert.deepEqual(sends, []);
});

test("buffers incoming data while shouldAcceptOutput returns false", async () => {
  const sends = [];
  let accept = true;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("before");
  accept = false;
  buffer.bufferData("buffered");
  await tick();

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flush();

  assert.deepEqual(sends, ["beforebuffered"]);
});

test("flushes data buffered while output is not accepted in bounded chunks", async () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("1234");
  buffer.bufferData("5678");
  buffer.bufferData("90ab");
  await tick();

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flush();

  assert.deepEqual(sends, ["12345678", "90ab"]);
});

test("keeps a single paused append bounded before output is accepted", async () => {
  const sends = [];
  let accept = false;
  const buffer = createPtyOutputBuffer((data) => sends.push(data), {
    maxBufferSize: 4,
    maxFloodBufferSize: 8,
    shouldAcceptOutput: () => accept,
  });

  buffer.bufferData("1234567890abcdefgh");
  await tick();

  assert.deepEqual(sends, []);
  accept = true;
  buffer.flush();

  assert.deepEqual(sends, ["12345678", "90abcdef", "gh"]);
});

test("keeps batching after a flush", async () => {
  const sends = [];
  const buffer = createPtyOutputBuffer((data) => sends.push(data));

  buffer.bufferData("first");
  await tick();

  buffer.bufferData("second");
  await tick();

  assert.deepEqual(sends, ["first", "second"]);
});
