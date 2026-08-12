"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, getEventListeners } = require("node:events");
const { openBoundedSftpChannel } = require("./boundedSftpOpen.cjs");

function trackedTimerApi() {
  const active = new Set();
  return {
    active,
    setTimeoutFn(callback, delay) {
      let timer;
      timer = setTimeout(() => {
        active.delete(timer);
        callback();
      }, delay);
      active.add(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      clearTimeout(timer);
      active.delete(timer);
    },
  };
}

function createChannel() {
  const channel = new EventEmitter();
  channel.endCalls = 0;
  channel.closeCalls = 0;
  channel.end = () => { channel.endCalls += 1; };
  channel.close = () => { channel.closeCalls += 1; };
  return channel;
}

test("bounded SFTP open times out and closes a late channel", async () => {
  let callback;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const sshClient = {
    sftp(next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const result = openBoundedSftpChannel(sshClient, { timeoutMs: 5, ...timers });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  await assert.rejects(result, (error) => error.code === "SFTP_CHANNEL_OPEN_TIMEOUT");
  assert.equal(invalidations, 1);
  assert.equal(timers.active.size, 0);

  const channel = createChannel();
  callback(null, channel);
  assert.ok(channel.endCalls > 0 || channel.closeCalls > 0);
  assert.equal(timers.active.size, 0);
});

test("bounded SFTP open cancellation settles immediately and closes a late channel", async () => {
  let callback;
  let invalidations = 0;
  const timers = trackedTimerApi();
  const controller = new AbortController();
  const sshClient = {
    sftp(next) { callback = next; },
    destroy() { invalidations += 1; },
  };
  const result = openBoundedSftpChannel(sshClient, {
    signal: controller.signal,
    ...timers,
  });
  assert.equal(timers.active.size, 1);
  assert.equal([...timers.active][0].hasRef(), true);
  controller.abort(new Error("cancelled"));
  await assert.rejects(result, /cancelled/);
  assert.equal(invalidations, 1);
  assert.equal(timers.active.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  const channel = createChannel();
  callback(new Error("late open failure"), channel);
  assert.ok(channel.endCalls > 0 || channel.closeCalls > 0);
  assert.equal(timers.active.size, 0);
});

test("repeated unresponsive SFTP opens cannot retain channel callbacks", async () => {
  const sshClient = {
    destroyed: false,
    pendingChannelCallbacks: [],
    sftp(callback) {
      if (this.destroyed) throw new Error("Not connected");
      this.pendingChannelCallbacks.push(callback);
    },
    end() {},
    destroy() {
      this.destroyed = true;
      this.pendingChannelCallbacks.length = 0;
    },
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      openBoundedSftpChannel(sshClient, { timeoutMs: 2 }),
      /timed out|Not connected/,
    );
  }
  assert.equal(sshClient.pendingChannelCallbacks.length, 0);
});

test("bounded SFTP open removes cancellation listeners after success and failure", async () => {
  for (const outcome of ["success", "error"]) {
    const controller = new AbortController();
    const timers = trackedTimerApi();
    let callback;
    const sshClient = { sftp(next) { callback = next; } };
    const result = openBoundedSftpChannel(sshClient, {
      signal: controller.signal,
      ...timers,
    });
    assert.equal(timers.active.size, 1);
    assert.equal([...timers.active][0].hasRef(), true);
    if (outcome === "success") callback(null, createChannel());
    else callback(new Error("open failed"));
    if (outcome === "success") assert.ok(await result);
    else await assert.rejects(result, /open failed/);
    assert.equal(timers.active.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("bounded SFTP open converts synchronous setup errors into rejections", async () => {
  const sshClient = { sftp() { throw new Error("sync failure"); } };
  await assert.rejects(openBoundedSftpChannel(sshClient), /sync failure/);
});
